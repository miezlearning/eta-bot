package main

import (
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func resetArsip() {
	arsip.Lock()
	arsip.chat = map[string]*arsipChat{}
	arsip.Unlock()
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
