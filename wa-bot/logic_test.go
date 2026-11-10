package main

import (
	"strings"
	"testing"
)

func TestTglDariArgumen(t *testing.T) {
	cases := []struct {
		arg  string
		want int // selisih hari dari hari ini
		ok   bool
	}{
		{"hari ini", 0, true},
		{"sekarang", 0, true},
		{"besok", 1, true},
		{"lusa", 2, true},
		{"kemarin", -1, true},
		{"", 0, false}, // string kosong ditolak (ditangani tanganiJadwal dulu)
	}
	// Bikin tanggal tetap: 2026-11-10 (Selasa) via time.Now? Kita bandingkan
	// MELALUI selisih dan bukan dgn tanggal absolut supaya tahan waktu uji.
	now := startOfHari(now())
	for _, c := range cases {
		got, ok := tglDariArgumen(c.arg)
		if ok != c.ok {
			t.Errorf("tglDariArgumen(%q) ok = %v, mau %v", c.arg, ok, c.ok)
			continue
		}
		if ok {
			diff := int(got.Sub(now).Hours() / 24)
			if diff != c.want {
				t.Errorf("tglDariArgumen(%q) = +%d hari, mau +%d", c.arg, diff, c.want)
			}
		}
	}

	// Tanggal eksplisit.
	if got, ok := tglDariArgumen("2026-11-12"); !ok || got.Format("2006-01-02") != "2026-11-12" {
		t.Errorf("tglDariArgumen(\"2026-11-12\") = %s, ok=%v", got.Format("2006-01-02"), ok)
	}
	if got, ok := tglDariArgumen("12/11/2026"); !ok || got.Format("2006-01-02") != "2026-11-12" {
		t.Errorf("tglDariArgumen(\"12/11/2026\") = %s, ok=%v", got.Format("2006-01-02"), ok)
	}
	if got, ok := tglDariArgumen("12/11"); !ok {
		t.Errorf("tglDariArgumen(\"12/11\") ok=false")
	} else if got.Format("01- 02") == "" {
		t.Errorf("tglDariArgumen(\"12/11\") tidak valid")
	}
}

func TestJadwalDiTanggal(t *testing.T) {
	daftar := []jadwalItem{
		{Title: "A", Tanggal: "2026-11-10", Jam: "13:00:00", Jenis: "Pendadaran"},
		{Title: "B", Tanggal: "2026-11-10", Jam: "09:00:00", Jenis: "Seminar Proposal"},
		{Title: "C", Tanggal: "2026-11-11", Jam: "11:00:00", Jenis: "Seminar Hasil"},
	}
	isi := jadwalDiTanggal(daftar, "2026-11-10")
	if len(isi) != 2 {
		t.Fatalf("jumlah isi = %d, mau 2", len(isi))
	}
	if isi[0].Title != "B" || isi[1].Title != "A" {
		t.Errorf("urutan isi salah: %s, %s (mau B dulu lalu A)", isi[0].Title, isi[1].Title)
	}
	pesan := formatJadwalHarian(now(), isi, map[string]string{"prodi": "Informatika"}, len(daftar))
	if !strings.Contains(pesan, "Informatika") || !strings.Contains(pesan, "09:00") {
		t.Errorf("formatJadwalHarian tidak memuat info diharapkan:\n%s", pesan)
	}
}

func TestSpanJam(t *testing.T) {
	if got := spanJam("09:00:00", "11:30:00"); got != "09:00-11:30" {
		t.Errorf("spanJam = %q, mau \"09:00-11:30\"", got)
	}
	if got := ringkasJam("09:00"); got != "09:00" {
		t.Errorf("ringkasJam = %q, mau \"09:00\"", got)
	}
}
