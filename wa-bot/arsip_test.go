package main

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func resetArsip() {
	arsip.Lock()
	arsip.chat = map[string]*arsipChat{}
	arsip.Unlock()
	aliasChat.Lock()
	aliasChat.lidKePN = map[string]string{}
	aliasChat.Unlock()
	pesanBot.Lock()
	pesanBot.id = map[string]struct{}{}
	pesanBot.urutan = nil
	pesanBot.Unlock()
}

func TestArsipViewOnceUrut(t *testing.T) {
	resetArsip()
	chat := "628111@s.whatsapp.net"
	simpanVO(chat, arsipPesan{Pengirim: "Andi", Waktu: time.Now(), Media: &arsipMedia{Jenis: "image", Data: []byte{1}}})
	simpanVO(chat, arsipPesan{Pengirim: "Budi", Waktu: time.Now(), Media: &arsipMedia{Jenis: "video", Data: []byte{2}}})

	p, ok := ambilVO(chat, 1)
	if !ok || p.Pengirim != "Budi" || p.Media.Jenis != "video" {
		t.Fatalf("view once terbaru salah: %+v", p)
	}
	p, ok = ambilVO(chat, 2)
	if !ok || p.Pengirim != "Andi" {
		t.Fatalf("view once kedua salah: %+v", p)
	}
	if _, ok := ambilVO(chat, 3); ok {
		t.Error("urutan di luar batas harus kosong")
	}
	if _, ok := ambilVO("lain@s.whatsapp.net", 1); ok {
		t.Error("chat lain tidak boleh melihat arsip")
	}
}

func TestArsipPesanDihapus(t *testing.T) {
	resetArsip()
	chat := types.NewJID("628222", types.DefaultUserServer)
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat},
			ID:            "MSG1",
			PushName:      "Budi",
		},
		Message: &waE2E.Message{Conversation: proto.String("pesan rahasia")},
	}
	catatPesan(evt)
	catatHapus(chat.String(), "MSG1")

	daftar := daftarHapus(chat.String())
	if len(daftar) != 1 {
		t.Fatalf("jumlah pesan terhapus = %d, mau 1", len(daftar))
	}
	if daftar[0].Teks != "pesan rahasia" || daftar[0].Pengirim != "Budi" {
		t.Errorf("isi pesan terhapus salah: %+v", daftar[0])
	}

	teks := formatDaftarHapus(daftar)
	for _, ingin := range []string{"*Pesan dihapus*", "1. Budi", "pesan rahasia", "/hapus <nomor>"} {
		if !strings.Contains(teks, ingin) {
			t.Errorf("daftar hapus tidak memuat %q:\n%s", ingin, teks)
		}
	}

	// Revoke kedua untuk ID yang sama tidak boleh menggandakan entri.
	catatHapus(chat.String(), "MSG1")
	if len(daftarHapus(chat.String())) != 1 {
		t.Error("revoke ganda menambah entri")
	}
}

func TestArsipTanpaPesan(t *testing.T) {
	resetArsip()
	if got := formatDaftarHapus(nil); !strings.Contains(got, "Belum ada") {
		t.Errorf("daftar kosong = %q", got)
	}
}

func TestBukaPembungkusDanViewOnceLangsung(t *testing.T) {
	resetArsip()
	chat := types.NewJID("628333", types.DefaultUserServer)

	// Kasus 1: ImageMessage dengan ViewOnce=true tanpa wrapper ViewOnceMessageV2.
	evtLangsung := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat},
			ID:            "VO1",
			PushName:      "Citra",
		},
		Message: &waE2E.Message{
			ImageMessage: &waE2E.ImageMessage{
				Mimetype: proto.String("image/jpeg"),
				Caption:  proto.String("rahasia"),
				ViewOnce: proto.Bool(true),
			},
		},
	}
	inner, isVO := bukaPembungkus(evtLangsung.Message, evtLangsung.IsViewOnce)
	if !isVO || inner.GetImageMessage() == nil {
		t.Fatalf("ViewOnce pada ImageMessage langsung tidak terdeteksi: isVO=%v", isVO)
	}
	catatViewOnce(kunciChatInfo(evtLangsung.Info), evtLangsung, inner)

	p, ok := ambilVO(chat.String(), 1)
	if !ok || p.Media == nil || p.Media.Jenis != "image" || p.Media.Ket != "rahasia" {
		t.Fatalf("arsip view once langsung salah: %+v", p)
	}

	// Kasus 2: ViewOnceMessageV2 membungkus EphemeralMessage membungkus AudioMessage PTT.
	evtNested := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat},
			ID:            "VO2",
			PushName:      "Dina",
		},
		Message: &waE2E.Message{
			ViewOnceMessageV2: &waE2E.FutureProofMessage{
				Message: &waE2E.Message{
					EphemeralMessage: &waE2E.FutureProofMessage{
						Message: &waE2E.Message{
							AudioMessage: &waE2E.AudioMessage{
								Mimetype: proto.String("audio/ogg; codecs=opus"),
								PTT:      proto.Bool(true),
								Seconds:  proto.Uint32(7),
							},
						},
					},
				},
			},
		},
	}
	inner2, isVO2 := bukaPembungkus(evtNested.Message, evtNested.IsViewOnce)
	if !isVO2 || inner2.GetAudioMessage() == nil {
		t.Fatalf("nested ViewOnceMessageV2+Ephemeral gagal dibuka: isVO=%v", isVO2)
	}
	catatViewOnce(kunciChatInfo(evtNested.Info), evtNested, inner2)

	p2, ok := ambilVO(chat.String(), 1)
	if !ok || p2.Media == nil || !p2.Media.PTT || p2.Media.Detik != 7 {
		t.Fatalf("metadata audio PTT view once hilang: %+v", p2)
	}
}

func TestViewOnceTertahanDigantiPesanAsli(t *testing.T) {
	resetArsip()
	chat := types.NewJID("628444", types.DefaultUserServer)
	info := types.MessageInfo{
		MessageSource: types.MessageSource{Chat: chat},
		ID:            "VO-UNAVAIL",
		PushName:      "Eko",
	}
	catatViewOnceTertahan(&events.UndecryptableMessage{
		Info:            info,
		IsUnavailable:   true,
		UnavailableType: events.UnavailableTypeViewOnce,
	})
	p, ok := ambilVO(chat.String(), 1)
	if !ok || p.ErrUnduh == "" {
		t.Fatalf("placeholder view once tertahan tidak tercatat: %+v", p)
	}

	// Saat HP utama mengirim ulang isi aslinya dengan ID sama, entri diganti tanpa duplikasi.
	evtResend := &events.Message{
		Info:       info,
		IsViewOnce: true,
		Message: &waE2E.Message{
			ImageMessage: &waE2E.ImageMessage{Mimetype: proto.String("image/png")},
		},
	}
	inner, isVO := bukaPembungkus(evtResend.Message, evtResend.IsViewOnce)
	if !isVO {
		t.Fatal("IsViewOnce harus true")
	}
	catatViewOnce(kunciChatInfo(info), evtResend, inner)

	p, ok = ambilVO(chat.String(), 1)
	if !ok || p.Media == nil || p.ErrUnduh != "" {
		t.Fatalf("entri view once gagal diperbarui dari resend: %+v", p)
	}
	if _, adaKedua := ambilVO(chat.String(), 2); adaKedua {
		t.Error("entri ID sama tidak boleh terduplikasi")
	}
}

func TestArsipHapusFIFODanAliasLID(t *testing.T) {
	resetArsip()
	lid := types.NewJID("99887766", types.HiddenUserServer)
	pn := types.NewJID("628555", types.DefaultUserServer)

	// Isi lebih dari arsipMaksCache pesan; pesan paling baru tidak boleh ikut terhapus oleh eviksi.
	for i := 0; i < arsipMaksCache+15; i++ {
		id := "MSG-" + strconv.Itoa(i)
		evt := &events.Message{
			Info: types.MessageInfo{
				MessageSource: types.MessageSource{Chat: lid, SenderAlt: pn},
				ID:            id,
				PushName:      "Fajar",
			},
			Message: &waE2E.Message{Conversation: proto.String("pesan " + id)},
		}
		catatPesan(evt)
	}

	// Pesan terakhir datang lewat PN, lalu di-revoke lewat LID (termasuk IsFromMe=true).
	lastID := "MSG-TERAKHIR"
	catatPesan(&events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: pn, IsFromMe: true},
			ID:            lastID,
			PushName:      "Saya",
		},
		Message: &waE2E.Message{Conversation: proto.String("pesan penting terakhir")},
	})
	catatPesan(&events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: lid, IsFromMe: true},
			ID:            "REV-1",
		},
		Message: &waE2E.Message{
			ProtocolMessage: &waE2E.ProtocolMessage{
				Type: waE2E.ProtocolMessage_REVOKE.Enum(),
				Key:  &waCommon.MessageKey{ID: proto.String(lastID)},
			},
		},
	})

	daftar := daftarHapus(kunciChatJID(lid))
	if len(daftar) != 1 || daftar[0].Teks != "pesan penting terakhir" {
		t.Fatalf("hapus lintas LID/PN atau FIFO gagal: %+v", daftar)
	}
}

func TestArsipEditSebelumHapusDanPesanBot(t *testing.T) {
	resetArsip()
	chat := types.NewJID("628666", types.DefaultUserServer)

	catatPesan(&events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: chat}, ID: "E1", PushName: "Gita"},
		Message: &waE2E.Message{Conversation: proto.String("typo")},
	})
	catatPesan(&events.Message{
		Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat}, ID: "E1-EDIT", PushName: "Gita"},
		Message: &waE2E.Message{
			ProtocolMessage: &waE2E.ProtocolMessage{
				Type:          waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
				Key:           &waCommon.MessageKey{ID: proto.String("E1")},
				EditedMessage: &waE2E.Message{Conversation: proto.String("sudah diperbaiki")},
			},
		},
	})
	catatPesan(&events.Message{
		Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat}, ID: "E1-REV"},
		Message: &waE2E.Message{
			ProtocolMessage: &waE2E.ProtocolMessage{
				Type: waE2E.ProtocolMessage_REVOKE.Enum(),
				Key:  &waCommon.MessageKey{ID: proto.String("E1")},
			},
		},
	})

	daftar := daftarHapus(chat.String())
	if len(daftar) != 1 || daftar[0].Teks != "sudah diperbaiki" {
		t.Fatalf("pesan edit sebelum hapus tidak tercatat: %+v", daftar)
	}

	tandaiPesanBot("BOT-1")
	if !adalahPesanBot("BOT-1") || adalahPesanBot("USER-1") {
		t.Error("pelacakan ID pesan bot tidak akurat")
	}
}
