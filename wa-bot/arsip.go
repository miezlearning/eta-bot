package main

// arsip.go -- penampung sementara pesan "sekali lihat" (view once) dan pesan
// yang baru saja dihapus. Semua data hanya hidup di memori selama bot online.

import (
	"context"
	"errors"
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
	arsipMaksVO      = 10
	arsipMaksByte    = 20 << 20
	arsipMaksTeks    = 4000
)

type arsipMedia struct {
	Jenis string
	MIME  string
	Nama  string
	Ket   string
	Data  []byte
}

type arsipPesan struct {
	ID       string
	Pengirim string
	Waktu    time.Time
	Teks     string
	Media    *arsipMedia
	Raw      *waE2E.Message
}

type arsipChat struct {
	vo       []arsipPesan
	hapus    []arsipPesan
	terakhir map[string]arsipPesan
}

var arsip = struct {
	sync.Mutex
	chat map[string]*arsipChat
}{chat: map[string]*arsipChat{}}

func arsipDari(id string) *arsipChat {
	c, ok := arsip.chat[id]
	if !ok {
		c = &arsipChat{terakhir: map[string]arsipPesan{}}
		arsip.chat[id] = c
	}
	return c
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

func namaPengirim(evt *events.Message) string {
	if n := strings.TrimSpace(evt.Info.PushName); n != "" {
		return n
	}
	if !evt.Info.Sender.IsEmpty() {
		return evt.Info.Sender.User
	}
	return "tanpa nama"
}

func potongTeks(s string) string {
	if len(s) > arsipMaksTeks {
		return s[:arsipMaksTeks] + "…"
	}
	return s
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
		return &arsipMedia{Jenis: "audio", MIME: x.GetMimetype()}, true
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

func unduhMedia(m *waE2E.Message) ([]byte, error) {
	if waClient == nil {
		return nil, errors.New("klien WhatsApp belum siap")
	}
	var d whatsmeow.DownloadableMessage
	switch {
	case m.GetImageMessage() != nil:
		d = m.GetImageMessage()
	case m.GetVideoMessage() != nil:
		d = m.GetVideoMessage()
	case m.GetAudioMessage() != nil:
		d = m.GetAudioMessage()
	case m.GetDocumentMessage() != nil:
		d = m.GetDocumentMessage()
	case m.GetStickerMessage() != nil:
		d = m.GetStickerMessage()
	default:
		return nil, errors.New("bukan media")
	}
	size := panjangMedia(m)
	if size > arsipMaksByte {
		return nil, errors.New("media terlalu besar")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return waClient.Download(ctx, d)
}

// catatPesan menyimpan pesan terbaru di cache agar isinya bisa ditampilkan
// kembali saat pesan tersebut dihapus, sekaligus mendeteksi revoke.
func catatPesan(evt *events.Message) {
	if evt.Info.IsFromMe {
		return
	}
	chat := evt.Info.Chat.String()
	if pm := evt.Message.GetProtocolMessage(); pm != nil {
		if pm.GetType() == waE2E.ProtocolMessage_REVOKE {
			go catatHapus(chat, pm.GetKey().GetID())
		}
		return
	}

	p := arsipPesan{
		ID:       evt.Info.ID,
		Pengirim: namaPengirim(evt),
		Waktu:    time.Now(),
		Teks:     potongTeks(teksPesan(evt.Message)),
		Raw:      evt.Message,
	}
	if am, ok := ekstrakMedia(evt.Message); ok {
		p.Media = am
	}
	if p.Teks == "" && p.Media == nil {
		return
	}

	arsip.Lock()
	defer arsip.Unlock()
	c := arsipDari(chat)
	c.terakhir[evt.Info.ID] = p
	if len(c.terakhir) > 2*arsipMaksPerChat {
		for id := range c.terakhir {
			if _, masih := c.terakhir[id]; masih && len(c.terakhir) <= arsipMaksPerChat {
				break
			}
			delete(c.terakhir, id)
		}
	}
}

// catatViewOnce langsung mengunduh media sekali lihat lalu menyimpannya.
func catatViewOnce(evt *events.Message) {
	if evt.Info.IsFromMe {
		return
	}
	am, ok := ekstrakMedia(evt.Message)
	if !ok {
		return
	}
	data, err := unduhMedia(evt.Message)
	if err != nil {
		logger.Warnf("gagal mengunduh view once: %v", err)
		return
	}
	am.Data = data
	p := arsipPesan{
		ID:       evt.Info.ID,
		Pengirim: namaPengirim(evt),
		Waktu:    time.Now(),
		Teks:     potongTeks(teksPesan(evt.Message)),
		Media:    am,
	}
	simpanVO(evt.Info.Chat.String(), p)
}

func simpanVO(chat string, p arsipPesan) {
	arsip.Lock()
	defer arsip.Unlock()
	c := arsipDari(chat)
	c.vo = rapikanArsip(append([]arsipPesan{p}, c.vo...), p.Waktu)
	if len(c.vo) > arsipMaksVO {
		c.vo = c.vo[:arsipMaksVO]
	}
}

// catatHapus memindahkan pesan yang di-revoke dari cache ke daftar hapus.
func catatHapus(chat, id string) {
	arsip.Lock()
	c := arsipDari(chat)
	p, ada := c.terakhir[id]
	delete(c.terakhir, id)
	arsip.Unlock()
	if !ada {
		return
	}
	p.Waktu = time.Now()
	simpanHapus(chat, p)
}

func simpanHapus(chat string, p arsipPesan) {
	arsip.Lock()
	defer arsip.Unlock()
	c := arsipDari(chat)
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
	p := c.vo[urutan-1]
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
	p := c.hapus[urutan-1]
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
	copy(out, c.hapus)
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
		switch p.Media.Jenis {
		case "image":
			return "[gambar]"
		case "video":
			return "[video]"
		case "audio":
			return "[audio]"
		case "document":
			return "[dokumen]"
		case "sticker":
			return "[stiker]"
		}
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
		msg.AudioMessage = &waE2E.AudioMessage{URL: u, DirectPath: d, MediaKey: k, FileEncSHA256: e, FileSHA256: s, FileLength: l, Mimetype: proto.String(mime)}
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

	if _, err := waClient.SendMessage(ctx, chat, msg); err != nil {
		logger.Errorf("gagal mengirim media arsip: %v", err)
		kirimBalasan(chat, "Gagal mengirim media: "+err.Error())
	}
}

// tanganiVO mengirim ulang media sekali lihat tanpa teks tambahan.
func tanganiVO(chat types.JID, arg string) {
	urutan := 1
	if n, err := strconv.Atoi(strings.TrimSpace(arg)); err == nil && n > 0 {
		urutan = n
	}
	p, ok := ambilVO(chat.String(), urutan)
	if !ok || p.Media == nil {
		kirimBalasan(chat, "Belum ada pesan sekali lihat.")
		return
	}
	kirimMedia(chat, p.Media)
}

// tanganiHapus menampilkan daftar pesan terhapus, atau membuka nomor tertentu.
func tanganiHapus(chat types.JID, arg string) string {
	if n, err := strconv.Atoi(strings.TrimSpace(arg)); err == nil && n > 0 {
		p, ok := ambilHapus(chat.String(), n)
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
			}
			go kirimMedia(chat, p.Media)
			return ""
		}
		if p.Teks == "" {
			return "Isi pesan terhapus tidak tersedia."
		}
		return p.Teks
	}
	return formatDaftarHapus(daftarHapus(chat.String()))
}
