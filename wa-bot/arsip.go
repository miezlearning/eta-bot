package main

// arsip.go -- penampung sementara pesan "sekali lihat" (view once) dan pesan
// yang baru saja dihapus. Semua data hanya hidup di memori selama bot online.

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

const (
	arsipTTL         = 12 * time.Hour
	arsipMaksPerChat = 20
	arsipMaksCache   = 200
	arsipMaksVO      = 10
	arsipMaksByte    = 20 << 20
	arsipMaksTeks    = 4000
	arsipMaksBotID   = 200
)

// pesanViewOnceTertahan menjelaskan batasan WhatsApp untuk perangkat tertaut.
const pesanViewOnceTertahan = "WhatsApp menahan media sekali lihat untuk perangkat tertaut (hanya bisa dibuka di HP utama)."

type arsipMedia struct {
	Jenis string
	MIME  string
	Nama  string
	Ket   string
	PTT   bool
	Detik uint32
	Data  []byte
}

type arsipPesan struct {
	ID       string
	Pengirim string
	Waktu    time.Time
	Teks     string
	Media    *arsipMedia
	Raw      *waE2E.Message
	ErrUnduh string
}

type arsipChat struct {
	vo             []arsipPesan
	hapus          []arsipPesan
	terakhir       map[string]arsipPesan
	urutanTerakhir []string
	pendingQuote   map[string]arsipPesan
	urutanQuote    []string
}

var arsip = struct {
	sync.Mutex
	chat map[string]*arsipChat
}{chat: map[string]*arsipChat{}}

// pesanBot mencatat ID pesan yang dikirim oleh bot sendiri agar tidak diproses ulang.
var pesanBot = struct {
	sync.Mutex
	id     map[string]struct{}
	urutan []string
}{id: map[string]struct{}{}}

// aliasChat memetakan JID @lid ke @s.whatsapp.net dari metadata event pesan.
var aliasChat = struct {
	sync.RWMutex
	lidKePN map[string]string
}{lidKePN: map[string]string{}}

func catatAliasChat(lid, pn types.JID) {
	l := lid.ToNonAD()
	p := pn.ToNonAD()
	if l.Server != types.HiddenUserServer || p.Server != types.DefaultUserServer {
		return
	}
	aliasChat.Lock()
	aliasChat.lidKePN[l.String()] = p.String()
	aliasChat.Unlock()
}

func tandaiPesanBot(id string) {
	if id == "" {
		return
	}
	pesanBot.Lock()
	defer pesanBot.Unlock()
	if _, ada := pesanBot.id[id]; ada {
		return
	}
	pesanBot.id[id] = struct{}{}
	pesanBot.urutan = append(pesanBot.urutan, id)
	for len(pesanBot.urutan) > arsipMaksBotID {
		lama := pesanBot.urutan[0]
		pesanBot.urutan = pesanBot.urutan[1:]
		delete(pesanBot.id, lama)
	}
}

func adalahPesanBot(id string) bool {
	if id == "" {
		return false
	}
	pesanBot.Lock()
	defer pesanBot.Unlock()
	_, ada := pesanBot.id[id]
	return ada
}

func kirimPesanWA(ctx context.Context, chat types.JID, msg *waE2E.Message) (whatsmeow.SendResponse, error) {
	if waClient == nil {
		return whatsmeow.SendResponse{}, errors.New("klien WhatsApp belum siap")
	}
	id := waClient.GenerateMessageID()
	tandaiPesanBot(string(id))
	return waClient.SendMessage(ctx, chat.ToNonAD(), msg, whatsmeow.SendRequestExtra{ID: id})
}

func arsipDari(id string) *arsipChat {
	c, ok := arsip.chat[id]
	if !ok {
		c = &arsipChat{
			terakhir:     map[string]arsipPesan{},
			pendingQuote: map[string]arsipPesan{},
		}
		arsip.chat[id] = c
	}
	if c.terakhir == nil {
		c.terakhir = map[string]arsipPesan{}
	}
	if c.pendingQuote == nil {
		c.pendingQuote = map[string]arsipPesan{}
	}
	return c
}

func salinPesan(p arsipPesan) arsipPesan {
	if p.Media != nil {
		m := *p.Media
		p.Media = &m
	}
	return p
}

func rapikanArsip(l []arsipPesan, now time.Time) []arsipPesan {
	if len(l) > arsipMaksPerChat {
		l = l[:arsipMaksPerChat]
	}
	for len(l) > 0 && now.Sub(l[len(l)-1].Waktu) > arsipTTL {
		l = l[:len(l)-1]
	}
	return l
}

func simpanTerakhirLocked(c *arsipChat, p arsipPesan) {
	if p.ID == "" {
		return
	}
	if _, ada := c.terakhir[p.ID]; !ada {
		c.urutanTerakhir = append(c.urutanTerakhir, p.ID)
	}
	c.terakhir[p.ID] = p
	for len(c.terakhir) > arsipMaksCache && len(c.urutanTerakhir) > 0 {
		lama := c.urutanTerakhir[0]
		c.urutanTerakhir = c.urutanTerakhir[1:]
		delete(c.terakhir, lama)
	}
}

// kunciChatJID menormalkan JID chat (memetakan @lid ke @s.whatsapp.net bila tersedia).
func kunciChatJID(chat types.JID) string {
	c := chat.ToNonAD()
	if c.IsEmpty() {
		return ""
	}
	if c.Server == types.HiddenUserServer {
		aliasChat.RLock()
		pnStr := aliasChat.lidKePN[c.String()]
		aliasChat.RUnlock()
		if pnStr != "" {
			return pnStr
		}
		if waClient != nil && waClient.Store != nil && waClient.Store.LIDs != nil {
			if pn, err := waClient.Store.LIDs.GetPNForLID(context.Background(), c); err == nil && !pn.IsEmpty() {
				catatAliasChat(c, pn)
				return pn.ToNonAD().String()
			}
		}
	}
	return c.String()
}

// kandidatJIDChat mengembalikan seluruh representasi JID chat (asli, PN, dan LID) untuk pemeriksaan izin.
func kandidatJIDChat(info types.MessageInfo) []string {
	hasil := []string{}
	tambah := func(j types.JID) {
		j = j.ToNonAD()
		if j.IsEmpty() {
			return
		}
		s := j.String()
		for _, ada := range hasil {
			if ada == s {
				return
			}
		}
		hasil = append(hasil, s)
	}

	tambah(info.Chat)
	if !info.IsGroup {
		if !info.IsFromMe && !info.SenderAlt.IsEmpty() {
			tambah(info.SenderAlt)
		}
		if info.IsFromMe && !info.RecipientAlt.IsEmpty() {
			tambah(info.RecipientAlt)
		}
		if info.Chat.Server == types.HiddenUserServer {
			if pn := kunciChatJID(info.Chat); pn != "" && pn != info.Chat.ToNonAD().String() {
				hasil = append(hasil, pn)
			}
		}
		if waClient != nil && waClient.Store != nil && waClient.Store.LIDs != nil {
			c := info.Chat.ToNonAD()
			if c.Server == types.DefaultUserServer {
				if lid, err := waClient.Store.LIDs.GetLIDForPN(context.Background(), c); err == nil {
					tambah(lid)
				}
			}
		}
	}
	return hasil
}

// kunciChatInfo menentukan kunci arsip kanonik agar pesan masuk, keluar, view-once, dan revoke cocok meski berbeda LID/PN.
func kunciChatInfo(info types.MessageInfo) string {
	if !info.IsGroup {
		if info.Chat.Server == types.DefaultUserServer {
			if !info.IsFromMe && info.SenderAlt.Server == types.HiddenUserServer {
				catatAliasChat(info.SenderAlt, info.Chat)
			} else if info.IsFromMe && info.RecipientAlt.Server == types.HiddenUserServer {
				catatAliasChat(info.RecipientAlt, info.Chat)
			}
			return info.Chat.ToNonAD().String()
		}
		if !info.IsFromMe && info.SenderAlt.Server == types.DefaultUserServer {
			catatAliasChat(info.Chat, info.SenderAlt)
			return info.SenderAlt.ToNonAD().String()
		}
		if info.IsFromMe && info.RecipientAlt.Server == types.DefaultUserServer {
			catatAliasChat(info.Chat, info.RecipientAlt)
			return info.RecipientAlt.ToNonAD().String()
		}
	}
	return kunciChatJID(info.Chat)
}

func namaPengirimInfo(info types.MessageInfo) string {
	if n := strings.TrimSpace(info.PushName); n != "" {
		return n
	}
	if !info.Sender.IsEmpty() {
		return info.Sender.User
	}
	return "tanpa nama"
}

func potongTeks(s string) string {
	if len(s) > arsipMaksTeks {
		return s[:arsipMaksTeks] + "…"
	}
	return s
}

// bukaPembungkus membuka seluruh lapisan pembungkus pesan WhatsApp dan mendeteksi flag view-once.
func bukaPembungkus(m *waE2E.Message, sudahVO bool) (*waE2E.Message, bool) {
	isVO := sudahVO
	cur := m
	for i := 0; i < 10 && cur != nil; i++ {
		var next *waE2E.Message
		switch {
		case cur.GetDeviceSentMessage().GetMessage() != nil:
			next = cur.GetDeviceSentMessage().GetMessage()
		case cur.GetBotInvokeMessage().GetMessage() != nil:
			next = cur.GetBotInvokeMessage().GetMessage()
		case cur.GetEphemeralMessage().GetMessage() != nil:
			next = cur.GetEphemeralMessage().GetMessage()
		case cur.GetViewOnceMessage().GetMessage() != nil:
			next = cur.GetViewOnceMessage().GetMessage()
			isVO = true
		case cur.GetViewOnceMessageV2().GetMessage() != nil:
			next = cur.GetViewOnceMessageV2().GetMessage()
			isVO = true
		case cur.GetViewOnceMessageV2Extension().GetMessage() != nil:
			next = cur.GetViewOnceMessageV2Extension().GetMessage()
			isVO = true
		case cur.GetLottieStickerMessage().GetMessage() != nil:
			next = cur.GetLottieStickerMessage().GetMessage()
		case cur.GetDocumentWithCaptionMessage().GetMessage() != nil:
			next = cur.GetDocumentWithCaptionMessage().GetMessage()
		case cur.GetEditedMessage().GetMessage() != nil:
			next = cur.GetEditedMessage().GetMessage()
		}
		if next == nil {
			break
		}
		if next.MessageContextInfo == nil && cur.MessageContextInfo != nil {
			next.MessageContextInfo = cur.MessageContextInfo
		}
		cur = next
	}
	if cur != nil && !isVO {
		if cur.GetImageMessage().GetViewOnce() ||
			cur.GetVideoMessage().GetViewOnce() ||
			cur.GetAudioMessage().GetViewOnce() ||
			cur.GetExtendedTextMessage().GetViewOnce() {
			isVO = true
		}
	}
	return cur, isVO
}

func ekstrakMedia(m *waE2E.Message) (*arsipMedia, bool) {
	if m == nil {
		return nil, false
	}
	switch {
	case m.GetImageMessage() != nil:
		x := m.GetImageMessage()
		return &arsipMedia{Jenis: "image", MIME: x.GetMimetype(), Ket: x.GetCaption()}, true
	case m.GetVideoMessage() != nil:
		x := m.GetVideoMessage()
		return &arsipMedia{Jenis: "video", MIME: x.GetMimetype(), Ket: x.GetCaption()}, true
	case m.GetAudioMessage() != nil:
		x := m.GetAudioMessage()
		return &arsipMedia{Jenis: "audio", MIME: x.GetMimetype(), PTT: x.GetPTT(), Detik: x.GetSeconds()}, true
	case m.GetDocumentMessage() != nil:
		x := m.GetDocumentMessage()
		return &arsipMedia{Jenis: "document", MIME: x.GetMimetype(), Nama: x.GetFileName(), Ket: x.GetCaption()}, true
	case m.GetStickerMessage() != nil:
		x := m.GetStickerMessage()
		return &arsipMedia{Jenis: "sticker", MIME: x.GetMimetype()}, true
	}
	return nil, false
}

func panjangMedia(m *waE2E.Message) uint64 {
	switch {
	case m.GetImageMessage() != nil:
		return m.GetImageMessage().GetFileLength()
	case m.GetVideoMessage() != nil:
		return m.GetVideoMessage().GetFileLength()
	case m.GetAudioMessage() != nil:
		return m.GetAudioMessage().GetFileLength()
	case m.GetDocumentMessage() != nil:
		return m.GetDocumentMessage().GetFileLength()
	case m.GetStickerMessage() != nil:
		return m.GetStickerMessage().GetFileLength()
	}
	return 0
}

// ambilContextInfo mengekstrak ContextInfo dari pesan teks atau media.
func ambilContextInfo(m *waE2E.Message) *waE2E.ContextInfo {
	if m == nil {
		return nil
	}
	switch {
	case m.GetExtendedTextMessage() != nil:
		return m.GetExtendedTextMessage().GetContextInfo()
	case m.GetImageMessage() != nil:
		return m.GetImageMessage().GetContextInfo()
	case m.GetVideoMessage() != nil:
		return m.GetVideoMessage().GetContextInfo()
	case m.GetAudioMessage() != nil:
		return m.GetAudioMessage().GetContextInfo()
	case m.GetDocumentMessage() != nil:
		return m.GetDocumentMessage().GetContextInfo()
	case m.GetStickerMessage() != nil:
		return m.GetStickerMessage().GetContextInfo()
	}
	return nil
}

// ambilQuoted mengambil pesan yang di-reply beserta stanzaID dan pengirim aslinya.
func ambilQuoted(m *waE2E.Message) (quoted *waE2E.Message, stanzaID, participant string) {
	ci := ambilContextInfo(m)
	if ci == nil || ci.GetQuotedMessage() == nil {
		return nil, "", ""
	}
	return ci.GetQuotedMessage(), ci.GetStanzaID(), ci.GetParticipant()
}

func pathDariURL(rawURL string) string {
	if rawURL == "" {
		return ""
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	p := u.RequestURI()
	if !strings.HasPrefix(p, "/") {
		return ""
	}
	return p
}

func unduhMedia(m *waE2E.Message) ([]byte, error) {
	if waClient == nil {
		return nil, errors.New("klien WhatsApp belum siap")
	}
	m, _ = bukaPembungkus(m, false)
	if m == nil {
		return nil, errors.New("bukan media")
	}
	var (
		d         whatsmeow.DownloadableMessage
		rawURL    string
		mediaType whatsmeow.MediaType
		mmsType   string
	)
	switch {
	case m.GetImageMessage() != nil:
		x := m.GetImageMessage()
		d, rawURL, mediaType, mmsType = x, x.GetURL(), whatsmeow.MediaImage, "image"
	case m.GetVideoMessage() != nil:
		x := m.GetVideoMessage()
		d, rawURL, mediaType, mmsType = x, x.GetURL(), whatsmeow.MediaVideo, "video"
	case m.GetAudioMessage() != nil:
		x := m.GetAudioMessage()
		d, rawURL, mediaType, mmsType = x, x.GetURL(), whatsmeow.MediaAudio, "audio"
	case m.GetDocumentMessage() != nil:
		x := m.GetDocumentMessage()
		d, rawURL, mediaType, mmsType = x, x.GetURL(), whatsmeow.MediaDocument, "document"
	case m.GetStickerMessage() != nil:
		x := m.GetStickerMessage()
		d, rawURL, mediaType, mmsType = x, x.GetURL(), whatsmeow.MediaImage, "image"
	default:
		return nil, errors.New("bukan media")
	}
	size := panjangMedia(m)
	if size > arsipMaksByte {
		return nil, errors.New("media terlalu besar")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if d.GetDirectPath() != "" {
		return waClient.Download(ctx, d)
	}
	if dp := pathDariURL(rawURL); dp != "" {
		return waClient.DownloadMediaWithPath(
			ctx, dp, d.GetFileEncSHA256(), d.GetFileSHA256(), d.GetMediaKey(),
			mediaType, mmsType, false,
		)
	}
	return nil, whatsmeow.ErrNoURLPresent
}

// pesanErrMedia memilih pesan galat yang ramah untuk pengguna.
func pesanErrMedia(err error) string {
	if errors.Is(err, whatsmeow.ErrNoURLPresent) {
		return pesanViewOnceTertahan
	}
	return err.Error()
}

// lengkapiMediaArsip mengunduh media di latar belakang lalu memperbarui entri arsip yang cocok.
func lengkapiMediaArsip(chatKey, id string, raw *waE2E.Message, logVO bool) {
	data, err := unduhMedia(raw)
	pesanErr := ""
	if err != nil {
		if logVO {
			logger.Warnf("gagal mengunduh view once: %v", err)
		}
		pesanErr = pesanErrMedia(err)
	}

	arsip.Lock()
	defer arsip.Unlock()
	c, ok := arsip.chat[chatKey]
	if !ok {
		return
	}
	perbarui := func(l []arsipPesan) {
		for i := range l {
			if l[i].ID != id {
				continue
			}
			if err != nil {
				l[i].ErrUnduh = pesanErr
			} else if l[i].Media != nil {
				l[i].Media.Data = data
				l[i].ErrUnduh = ""
			}
		}
	}
	perbarui(c.vo)
	perbarui(c.hapus)
	if p, ada := c.terakhir[id]; ada {
		if err != nil {
			p.ErrUnduh = pesanErr
		} else if p.Media != nil {
			m := *p.Media
			m.Data = data
			p.Media = &m
			p.ErrUnduh = ""
		}
		c.terakhir[id] = p
	}
}

// catatPesan menyimpan pesan terbaru di cache dan mendeteksi revoke/edit.
func catatPesan(evt *events.Message) {
	inner, isVO := bukaPembungkus(evt.Message, evt.IsViewOnce)
	chatKey := kunciChatInfo(evt.Info)
	if isVO {
		catatViewOnce(chatKey, evt, inner)
		return
	}
	catatPesanDenganKunci(chatKey, evt, inner)
}

func catatPesanDenganKunci(chatKey string, evt *events.Message, inner *waE2E.Message) {
	if inner == nil {
		return
	}
	if pm := inner.GetProtocolMessage(); pm != nil {
		switch pm.GetType() {
		case waE2E.ProtocolMessage_REVOKE:
			targetID := pm.GetKey().GetID()
			if targetID == "" {
				return
			}
			p, ada := catatHapusAmbil(chatKey, targetID)
			if !ada && pm.GetKey().GetRemoteJID() != "" {
				if remoteJID, err := types.ParseJID(pm.GetKey().GetRemoteJID()); err == nil {
					altKey := kunciChatJID(remoteJID)
					if altKey != "" && altKey != chatKey {
						p, ada = catatHapusAmbil(altKey, targetID)
						if ada {
							chatKey = altKey
						}
					}
				}
			}
			if ada && p.Media != nil && len(p.Media.Data) == 0 && p.Raw != nil && waClient != nil {
				go lengkapiMediaArsip(chatKey, targetID, p.Raw, false)
			}
		case waE2E.ProtocolMessage_MESSAGE_EDIT:
			targetID := pm.GetKey().GetID()
			edited, _ := bukaPembungkus(pm.GetEditedMessage(), false)
			if targetID == "" || edited == nil {
				return
			}
			arsip.Lock()
			c := arsipDari(chatKey)
			p, ada := c.terakhir[targetID]
			if !ada {
				p = arsipPesan{
					ID:       targetID,
					Pengirim: namaPengirimInfo(evt.Info),
					Waktu:    time.Now(),
				}
			}
			if t := potongTeks(teksPesan(edited)); t != "" {
				p.Teks = t
			}
			if am, ok := ekstrakMedia(edited); ok {
				p.Media = am
			}
			p.Raw = edited
			simpanTerakhirLocked(c, p)
			arsip.Unlock()
		}
		return
	}

	p := arsipPesan{
		ID:       evt.Info.ID,
		Pengirim: namaPengirimInfo(evt.Info),
		Waktu:    time.Now(),
		Teks:     potongTeks(teksPesan(inner)),
		Raw:      inner,
	}
	if am, ok := ekstrakMedia(inner); ok {
		p.Media = am
	}
	if p.Teks == "" && p.Media == nil {
		return
	}

	arsip.Lock()
	c := arsipDari(chatKey)
	simpanTerakhirLocked(c, p)
	simpanQuoteCadanganLocked(c, inner)
	arsip.Unlock()
}

// simpanQuoteCadanganLocked menyimpan salinan pesan yang di-reply bila pesan aslinya belum ada di cache,
// sehingga tetap bisa dipulihkan oleh /hapus bila nantinya di-revoke.
func simpanQuoteCadanganLocked(c *arsipChat, m *waE2E.Message) {
	quoted, stanzaID, participant := ambilQuoted(m)
	if quoted == nil || stanzaID == "" {
		return
	}
	if _, ada := c.terakhir[stanzaID]; ada {
		return
	}
	if _, ada := c.pendingQuote[stanzaID]; ada {
		return
	}
	qInner, _ := bukaPembungkus(quoted, false)
	if qInner == nil {
		return
	}
	pengirim := "pengirim"
	if participant != "" {
		if pj, err := types.ParseJID(participant); err == nil && pj.User != "" {
			pengirim = pj.User
		}
	}
	qp := arsipPesan{
		ID:       stanzaID,
		Pengirim: pengirim,
		Waktu:    time.Now(),
		Teks:     potongTeks(teksPesan(qInner)),
		Raw:      qInner,
	}
	if am, ok := ekstrakMedia(qInner); ok {
		qp.Media = am
	}
	if qp.Teks == "" && qp.Media == nil {
		return
	}
	c.pendingQuote[stanzaID] = qp
	c.urutanQuote = append(c.urutanQuote, stanzaID)
	for len(c.pendingQuote) > arsipMaksCache && len(c.urutanQuote) > 0 {
		lama := c.urutanQuote[0]
		c.urutanQuote = c.urutanQuote[1:]
		delete(c.pendingQuote, lama)
	}
}

// catatViewOnce langsung menyimpan metadata view once dan mengunduh medianya di latar belakang.
func catatViewOnce(chatKey string, evt *events.Message, inner *waE2E.Message) {
	if inner == nil {
		return
	}
	p := arsipPesan{
		ID:       evt.Info.ID,
		Pengirim: namaPengirimInfo(evt.Info),
		Waktu:    time.Now(),
		Teks:     potongTeks(teksPesan(inner)),
		Raw:      inner,
	}
	if am, ok := ekstrakMedia(inner); ok {
		p.Media = am
	}
	if p.Media == nil && p.Teks == "" {
		return
	}
	simpanVO(chatKey, p)

	arsip.Lock()
	c := arsipDari(chatKey)
	simpanTerakhirLocked(c, salinPesan(p))
	arsip.Unlock()

	if p.Media != nil && len(p.Media.Data) == 0 && waClient != nil {
		go lengkapiMediaArsip(chatKey, p.ID, inner, true)
	}
}

// catatViewOnceTertahan mencatat pesan view once yang diblokir WhatsApp untuk perangkat tertaut.
func catatViewOnceTertahan(evt *events.UndecryptableMessage) {
	if evt.Info.ID == "" {
		return
	}
	chatKey := kunciChatInfo(evt.Info)
	arsip.Lock()
	defer arsip.Unlock()
	c := arsipDari(chatKey)
	for _, ada := range c.vo {
		if ada.ID == evt.Info.ID {
			return
		}
	}
	p := arsipPesan{
		ID:       evt.Info.ID,
		Pengirim: namaPengirimInfo(evt.Info),
		Waktu:    time.Now(),
		ErrUnduh: pesanViewOnceTertahan,
	}
	c.vo = rapikanArsip(append([]arsipPesan{p}, c.vo...), p.Waktu)
	if len(c.vo) > arsipMaksVO {
		c.vo = c.vo[:arsipMaksVO]
	}
}

func simpanVO(chat string, p arsipPesan) {
	arsip.Lock()
	defer arsip.Unlock()
	c := arsipDari(chat)
	if p.ID != "" {
		for i := range c.vo {
			if c.vo[i].ID == p.ID {
				c.vo[i] = p
				return
			}
		}
	}
	c.vo = rapikanArsip(append([]arsipPesan{p}, c.vo...), p.Waktu)
	if len(c.vo) > arsipMaksVO {
		c.vo = c.vo[:arsipMaksVO]
	}
}

// catatHapus memindahkan pesan yang di-revoke dari cache ke daftar hapus.
func catatHapus(chat, id string) {
	catatHapusAmbil(chat, id)
}

func catatHapusAmbil(chat, id string) (arsipPesan, bool) {
	arsip.Lock()
	defer arsip.Unlock()
	c := arsipDari(chat)
	p, ada := c.terakhir[id]
	if ada {
		delete(c.terakhir, id)
	} else if pq, ok := c.pendingQuote[id]; ok {
		p, ada = pq, true
		delete(c.pendingQuote, id)
	} else if !strings.HasSuffix(chat, "@"+types.GroupServer) {
		// Fallback DM lintas @lid / @s.whatsapp.net saat mapping LID-PN belum tercatat.
		for k, other := range arsip.chat {
			if k == chat || strings.HasSuffix(k, "@"+types.GroupServer) {
				continue
			}
			if op, ok := other.terakhir[id]; ok {
				p, ada = op, true
				delete(other.terakhir, id)
				break
			}
			if op, ok := other.pendingQuote[id]; ok {
				p, ada = op, true
				delete(other.pendingQuote, id)
				break
			}
		}
	}
	if !ada {
		return arsipPesan{}, false
	}
	p.Waktu = time.Now()
	if id != "" {
		for _, item := range c.hapus {
			if item.ID == id {
				return salinPesan(item), false
			}
		}
	}
	c.hapus = rapikanArsip(append([]arsipPesan{p}, c.hapus...), p.Waktu)
	return salinPesan(p), true
}

func simpanHapus(chat string, p arsipPesan) {
	arsip.Lock()
	defer arsip.Unlock()
	c := arsipDari(chat)
	if p.ID != "" {
		for _, item := range c.hapus {
			if item.ID == p.ID {
				return
			}
		}
	}
	c.hapus = rapikanArsip(append([]arsipPesan{p}, c.hapus...), p.Waktu)
}

func ambilVO(chat string, urutan int) (*arsipPesan, bool) {
	arsip.Lock()
	defer arsip.Unlock()
	c, ok := arsip.chat[chat]
	if !ok {
		return nil, false
	}
	c.vo = rapikanArsip(c.vo, time.Now())
	if urutan < 1 || urutan > len(c.vo) {
		return nil, false
	}
	p := salinPesan(c.vo[urutan-1])
	return &p, true
}

func ambilHapus(chat string, urutan int) (*arsipPesan, bool) {
	arsip.Lock()
	defer arsip.Unlock()
	c, ok := arsip.chat[chat]
	if !ok {
		return nil, false
	}
	c.hapus = rapikanArsip(c.hapus, time.Now())
	if urutan < 1 || urutan > len(c.hapus) {
		return nil, false
	}
	p := salinPesan(c.hapus[urutan-1])
	return &p, true
}

func daftarHapus(chat string) []arsipPesan {
	arsip.Lock()
	defer arsip.Unlock()
	c, ok := arsip.chat[chat]
	if !ok {
		return nil
	}
	c.hapus = rapikanArsip(c.hapus, time.Now())
	out := make([]arsipPesan, len(c.hapus))
	for i, p := range c.hapus {
		out[i] = salinPesan(p)
	}
	return out
}

func ringkasTeks(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) > 60 {
		return string(r[:60]) + "…"
	}
	return s
}

func labelArsip(p arsipPesan) string {
	if p.Teks != "" {
		return ringkasTeks(p.Teks)
	}
	if p.Media != nil {
		label := "[media]"
		switch p.Media.Jenis {
		case "image":
			label = "[gambar]"
		case "video":
			label = "[video]"
		case "audio":
			label = "[audio]"
		case "document":
			label = "[dokumen]"
		case "sticker":
			label = "[stiker]"
		}
		if p.Media.Ket != "" {
			return label + " " + ringkasTeks(p.Media.Ket)
		}
		return label
	}
	return "[media]"
}

func formatDaftarHapus(daftar []arsipPesan) string {
	if len(daftar) == 0 {
		return "Belum ada pesan yang dihapus selama bot online."
	}
	var sb strings.Builder
	sb.WriteString("*Pesan dihapus* (" + strconv.Itoa(len(daftar)) + ")\n")
	for i, p := range daftar {
		sb.WriteString(strconv.Itoa(i+1) + ". " + p.Pengirim + " · " + p.Waktu.Format("15:04") + " — " + labelArsip(p) + "\n")
	}
	sb.WriteString("\nKetik `/hapus <nomor>` untuk membuka.")
	return sb.String()
}

// kirimMedia mengunggah ulang media arsip lalu mengirimkannya.
func kirimMedia(chat types.JID, am *arsipMedia) {
	if waClient == nil || am == nil || len(am.Data) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	app := whatsmeow.MediaImage
	switch am.Jenis {
	case "video":
		app = whatsmeow.MediaVideo
	case "audio":
		app = whatsmeow.MediaAudio
	case "document":
		app = whatsmeow.MediaDocument
	case "sticker":
		app = whatsmeow.MediaImage
	}
	resp, err := waClient.Upload(ctx, am.Data, app)
	if err != nil {
		logger.Errorf("gagal mengunggah media arsip: %v", err)
		kirimBalasan(chat, "Gagal mengirim media: "+err.Error())
		return
	}

	mime := am.MIME
	if mime == "" {
		mime = "application/octet-stream"
	}
	dasar := func() (url, direct *string, key, enc, sha []byte, panjang *uint64) {
		return &resp.URL, &resp.DirectPath, resp.MediaKey, resp.FileEncSHA256, resp.FileSHA256, &resp.FileLength
	}
	msg := &waE2E.Message{}
	switch am.Jenis {
	case "video":
		u, d, k, e, s, l := dasar()
		v := &waE2E.VideoMessage{URL: u, DirectPath: d, MediaKey: k, FileEncSHA256: e, FileSHA256: s, FileLength: l, Mimetype: proto.String(mime)}
		if am.Ket != "" {
			v.Caption = proto.String(am.Ket)
		}
		msg.VideoMessage = v
	case "audio":
		u, d, k, e, s, l := dasar()
		aud := &waE2E.AudioMessage{
			URL: u, DirectPath: d, MediaKey: k, FileEncSHA256: e, FileSHA256: s, FileLength: l,
			Mimetype: proto.String(mime),
			PTT:      proto.Bool(am.PTT),
		}
		if am.Detik > 0 {
			aud.Seconds = proto.Uint32(am.Detik)
		}
		msg.AudioMessage = aud
	case "document":
		u, d, k, e, s, l := dasar()
		nama := am.Nama
		if nama == "" {
			nama = "pesan-terhapus"
		}
		doc := &waE2E.DocumentMessage{URL: u, DirectPath: d, MediaKey: k, FileEncSHA256: e, FileSHA256: s, FileLength: l, Mimetype: proto.String(mime), FileName: proto.String(nama)}
		if am.Ket != "" {
			doc.Caption = proto.String(am.Ket)
		}
		msg.DocumentMessage = doc
	case "sticker":
		u, d, k, e, s, l := dasar()
		msg.StickerMessage = &waE2E.StickerMessage{URL: u, DirectPath: d, MediaKey: k, FileEncSHA256: e, FileSHA256: s, FileLength: l, Mimetype: proto.String(mime)}
	default:
		u, d, k, e, s, l := dasar()
		img := &waE2E.ImageMessage{URL: u, DirectPath: d, MediaKey: k, FileEncSHA256: e, FileSHA256: s, FileLength: l, Mimetype: proto.String(mime)}
		if am.Ket != "" {
			img.Caption = proto.String(am.Ket)
		}
		msg.ImageMessage = img
	}

	if _, err := kirimPesanWA(ctx, chat, msg); err != nil {
		logger.Errorf("gagal mengirim media arsip: %v", err)
		kirimBalasan(chat, "Gagal mengirim media: "+err.Error())
	}
}

func simpanDataMediaArsip(chatKey, id string, data []byte) {
	if id == "" || len(data) == 0 {
		return
	}
	arsip.Lock()
	defer arsip.Unlock()
	c, ok := arsip.chat[chatKey]
	if !ok {
		return
	}
	isi := func(l []arsipPesan) {
		for i := range l {
			if l[i].ID == id && l[i].Media != nil {
				l[i].Media.Data = data
				l[i].ErrUnduh = ""
			}
		}
	}
	isi(c.vo)
	isi(c.hapus)
}

func cariVOByID(chat, id string) (*arsipPesan, bool) {
	if id == "" {
		return nil, false
	}
	arsip.Lock()
	defer arsip.Unlock()
	c, ok := arsip.chat[chat]
	if !ok {
		return nil, false
	}
	for _, item := range c.vo {
		if item.ID == id {
			p := salinPesan(item)
			return &p, true
		}
	}
	return nil, false
}

// tanganiVO mengirim ulang media sekali lihat tanpa teks tambahan.
func tanganiVO(chat types.JID, arg string) {
	tanganiVODenganPesan(chat, arg, nil)
}

// tanganiVODenganPesan mendukung /vo langsung (berdasarkan reply/quote pesan sekali lihat)
// maupun /vo [n] dari arsip chat terakhir.
func tanganiVODenganPesan(chat types.JID, arg string, pesan *waE2E.Message) {
	chatKey := kunciChatJID(chat)

	if quoted, stanzaID, _ := ambilQuoted(pesan); quoted != nil {
		if p, ada := cariVOByID(chatKey, stanzaID); ada && ((p.Media != nil && len(p.Media.Data) > 0) || p.Teks != "") {
			kirimEntriVO(chat, chatKey, p)
			return
		}
		qInner, isQVO := bukaPembungkus(quoted, false)
		if am, ok := ekstrakMedia(qInner); ok {
			data, err := unduhMedia(qInner)
			if err == nil && len(data) > 0 {
				am.Data = data
				kirimMedia(chat, am)
				return
			}
			if p, ada := cariVOByID(chatKey, stanzaID); ada {
				kirimEntriVO(chat, chatKey, p)
				return
			}
			kirimBalasan(chat, "Gagal mengunduh media sekali lihat dari pesan yang dibalas: "+err.Error())
			return
		}
		if p, ada := cariVOByID(chatKey, stanzaID); ada {
			kirimEntriVO(chat, chatKey, p)
			return
		}
		if isQVO {
			if qt := teksPesan(qInner); qt != "" {
				kirimBalasan(chat, qt)
				return
			}
		}
		kirimBalasan(chat, "Pesan yang dibalas bukan media sekali lihat.")
		return
	}

	urutan := 1
	if n, err := strconv.Atoi(strings.TrimSpace(arg)); err == nil && n > 0 {
		urutan = n
	}
	p, ok := ambilVO(chatKey, urutan)
	if !ok {
		kirimBalasan(chat, "Belum ada pesan sekali lihat.")
		return
	}
	kirimEntriVO(chat, chatKey, p)
}

func kirimEntriVO(chat types.JID, chatKey string, p *arsipPesan) {
	if p.Media != nil {
		if len(p.Media.Data) == 0 && p.Raw != nil && waClient != nil {
			data, err := unduhMedia(p.Raw)
			if err != nil {
				kirimBalasan(chat, "Gagal mengunduh media sekali lihat: "+pesanErrMedia(err))
				return
			}
			p.Media.Data = data
			simpanDataMediaArsip(chatKey, p.ID, data)
		}
		if len(p.Media.Data) > 0 {
			kirimMedia(chat, p.Media)
			return
		}
		if p.ErrUnduh != "" {
			kirimBalasan(chat, "Gagal mengunduh media sekali lihat: "+p.ErrUnduh)
			return
		}
		kirimBalasan(chat, "Media sekali lihat tidak tersedia.")
		return
	}
	if p.Teks != "" {
		kirimBalasan(chat, p.Teks)
		return
	}
	if p.ErrUnduh != "" {
		kirimBalasan(chat, p.ErrUnduh)
		return
	}
	kirimBalasan(chat, "Isi pesan sekali lihat tidak tersedia.")
}

// tanganiHapus menampilkan daftar pesan terhapus, atau membuka nomor tertentu.
func tanganiHapus(chat types.JID, arg string) string {
	chatKey := kunciChatJID(chat)
	if n, err := strconv.Atoi(strings.TrimSpace(arg)); err == nil && n > 0 {
		p, ok := ambilHapus(chatKey, n)
		if !ok {
			return "Nomor pesan terhapus tidak ditemukan."
		}
		if p.Media != nil {
			if len(p.Media.Data) == 0 {
				if p.Raw == nil {
					return "Media pesan terhapus tidak tersedia."
				}
				data, err := unduhMedia(p.Raw)
				if err != nil {
					return "Media pesan terhapus tidak tersedia lagi."
				}
				p.Media.Data = data
				simpanDataMediaArsip(chatKey, p.ID, data)
			}
			go kirimMedia(chat, p.Media)
			return ""
		}
		if p.Teks == "" {
			return "Isi pesan terhapus tidak tersedia."
		}
		return p.Teks
	}
	return formatDaftarHapus(daftarHapus(chatKey))
}
