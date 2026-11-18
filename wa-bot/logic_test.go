package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func resetCacheProdi() {
	prodiPrefixCache = sync.Map{}
	prodiNamaCache = sync.Map{}
}

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

func TestHitungTercepat(t *testing.T) {
	jadwal := []eroomItem{
		{Nama: "Budi Santoso", Jenis: "Seminar Proposal", Tanggal: "2026-01-10"},
		{Nama: "Budi Santoso", Jenis: "Seminar Hasil", Tanggal: "2026-02-10"},
		{Nama: "Budi Santoso", Jenis: "Pendadaran", Tanggal: "2026-03-01"},
		{Nama: "Siti Aminah", Jenis: "Seminar Proposal", Tanggal: "2026-02-01"},
		{Nama: "Siti Aminah", Jenis: "Pendadaran", Tanggal: "2026-02-21"},
		{Nama: "Siti  AMINAH", Jenis: "Pendadaran", Tanggal: "2026-02-21"},
		{Nama: "Andi", Jenis: "Pendadaran", Tanggal: "2026-02-15"},
		{Nama: "Rani", Jenis: "Pendadaran", Tanggal: "2026-01-01"},
		{Nama: "Rani", Jenis: "Seminar Proposal", Tanggal: "2026-02-01"},
		{Nama: "Future", Jenis: "Seminar Proposal", Tanggal: "2026-11-01"},
		{Nama: "Future", Jenis: "Pendadaran", Tanggal: "2026-12-01"},
	}
	daftarJudul := []judulItem{
		{Nama: "Siti Aminah", NIM: "2209106125", Judul: "Sistem Deteksi Performansi",
			Dosen: map[string]judulDosenItem{"pembimbing_1": {Nama: "Fahrul Agus"}}},
		{Nama: "Budi Santoso", NIM: "2309104321", Judul: "Analisis Sentimen",
			Dosen: map[string]judulDosenItem{"pembimbing_1": {Nama: "Dedy Cahyadi"}}},
	}
	hariIni := time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)
	kosong := filterTercepat{Batas: 10}

	hasil := hitungTercepat(jadwal, daftarJudul, kosong, hariIni)
	if len(hasil) != 2 {
		t.Fatalf("jumlah hasil = %d, mau 2", len(hasil))
	}
	if hasil[0].Nama != "Siti Aminah" || hasil[0].Hari != 20 || hasil[0].Peringkat != 1 {
		t.Errorf("urutan pertama salah: %+v", hasil[0])
	}
	if hasil[0].Angkatan != "2022" || hasil[0].NIM != "2209106125" || hasil[0].Dosen != "Fahrul Agus" {
		t.Errorf("data judul tidak melengkapi hasil: %+v", hasil[0])
	}
	if hasil[1].Nama != "Budi Santoso" || hasil[1].Hari != 50 || hasil[1].Peringkat != 2 {
		t.Errorf("urutan kedua salah: %+v", hasil[1])
	}

	cases := []struct {
		nama   string
		filter filterTercepat
		want   int
	}{
		{"tahun 2026", filterTercepat{Tahun: "2026"}, 2},
		{"tahun 2025", filterTercepat{Tahun: "2025"}, 0},
		{"angkatan 2022", filterTercepat{Angkatan: "2022"}, 1},
		{"angkatan 2023", filterTercepat{Angkatan: "2023"}, 1},
		{"nim 2309", filterTercepat{NIM: "2309"}, 1},
		{"nama budi", filterTercepat{Nama: "budi"}, 1},
		{"dosen fahrul", filterTercepat{Dosen: "fahrul"}, 1},
		{"judul performansi", filterTercepat{Judul: "performansi"}, 1},
	}
	for _, c := range cases {
		if got := hitungTercepat(jadwal, daftarJudul, c.filter, hariIni); len(got) != c.want {
			t.Errorf("filter %s = %d hasil, mau %d", c.nama, len(got), c.want)
		}
	}
}

func TestTanganiTercepat(t *testing.T) {
	resetCacheProdi()
	payloadEroom := `{"total":2,"jadwal":[
		{"nama":"Budi Santoso","jenis":"Seminar Proposal","tanggal":"2026-01-10"},
		{"nama":"Budi Santoso","jenis":"Pendadaran","tanggal":"2026-03-01"},
		{"nama":"Siti Aminah","jenis":"Seminar Proposal","tanggal":"2026-02-01"},
		{"nama":"Siti Aminah","jenis":"Pendadaran","tanggal":"2026-02-21"}
	]}`
	payloadJudul := `{"identity":{"prodi":"Informatika"},"daftar":[
		{"nama":"Siti Aminah","nim":"2209106125","judul":"Sistem Deteksi Performansi",
		 "dosen":{"pembimbing_1":{"nama":"Fahrul Agus"}}},
		{"nama":"Budi Santoso","nim":"2309104321","judul":"Analisis Sentimen",
		 "dosen":{"pembimbing_1":{"nama":"Dedy Cahyadi"}}}
	]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/eroom/jadwal":
			io.WriteString(w, payloadEroom)
		case r.URL.Path == "/api/judul-skripsi":
			io.WriteString(w, payloadJudul)
		case strings.HasPrefix(r.URL.Path, "/api/eroom/sidang/"):
			io.WriteString(w, `{"peserta":{"nim":"2209076036","prodi":"Teknik Elektro"}}`)
		default:
			t.Errorf("path API tidak terduga: %q", r.URL.Path)
		}
	}))
	defer srv.Close()

	lama := eta
	eta = NewEtaAPI(srv.URL)
	defer func() { eta = lama }()

	pesan := tanganiTercepat("")
	for _, ingin := range []string{"Siti Aminah", "20 hari", "01/02/2026", "Budi Santoso", "50 hari", "10/01/2026", "2022", "2209106125"} {
		if !strings.Contains(pesan, ingin) {
			t.Errorf("balasan tidak memuat %q:\n%s", ingin, pesan)
		}
	}

	pesan = tanganiTercepat("angkatan 2022")
	if !strings.Contains(pesan, "Siti Aminah") || strings.Contains(pesan, "Budi Santoso") {
		t.Errorf("filter angkatan 2022 salah:\n%s", pesan)
	}

	pesan = tanganiTercepat("prodi Informatika")
	if !strings.Contains(pesan, "Siti Aminah") || !strings.Contains(pesan, "Informatika") {
		t.Errorf("filter prodi Informatika salah:\n%s", pesan)
	}
	pesan = tanganiTercepat("prodi Teknik Elektro")
	if !strings.Contains(pesan, "Tidak ada mahasiswa cocok") {
		t.Errorf("filter prodi Teknik Elektro harus kosong:\n%s", pesan)
	}
}

func TestParseFilterTercepat(t *testing.T) {
	cases := []struct {
		arg      string
		angkatan string
		tahun    string
		nim      string
		nama     string
		prodi    string
		dosen    string
		judul    string
		halaman  int
		batas    int
	}{
		{arg: "angkatan 2022 dosen Fahrul Agus tahun 2026 2", angkatan: "2022", dosen: "Fahrul Agus", tahun: "2026", halaman: 2, batas: 10},
		{arg: "nim 2209 judul performansi", nim: "2209", judul: "performansi", halaman: 1, batas: 10},
		{arg: "prodi Teknik Elektro angkatan 2022", prodi: "Teknik Elektro", angkatan: "2022", halaman: 1, batas: 10},
		{arg: "budi 3", nama: "budi", halaman: 3, batas: 10},
		{arg: "semua", halaman: 1, batas: 25},
		{arg: "top 5", halaman: 1, batas: 5},
		{arg: "angkatan 22", angkatan: "2022", halaman: 1, batas: 10},
	}
	for _, c := range cases {
		f := parseFilterTercepat(c.arg)
		if f.Angkatan != c.angkatan || f.Tahun != c.tahun || f.NIM != c.nim || f.Nama != c.nama ||
			f.Prodi != c.prodi || f.Dosen != c.dosen || f.Judul != c.judul || f.Halaman != c.halaman || f.Batas != c.batas {
			t.Errorf("parseFilterTercepat(%q) = %+v", c.arg, f)
		}
	}
}

func TestEnrichProdi(t *testing.T) {
	resetCacheProdi()
	hasil := []kecepatanItem{
		{Nama: "Andi", Token: "tokA", Hari: 10, Peringkat: 1},
		{Nama: "Budi", Token: "tokB", Hari: 20, Peringkat: 2},
		{Nama: "Siti", Token: "tokC", Hari: 30, Peringkat: 3},
		{Nama: "Dedi", Token: "tokD", Hari: 40, Peringkat: 4},
	}
	data := map[string]struct{ nim, prodi string }{
		"tokA": {"2209076009", "Teknik Elektro"},
		"tokB": {"2209076036", "Teknik Elektro"},
		"tokC": {"2209066035", "Teknik Kimia"},
		"tokD": {"2209106125", "Informatika"},
	}
	panggilan := 0
	ambil := func(token string) (string, string, error) {
		panggilan++
		v := data[token]
		return v.nim, v.prodi, nil
	}

	out := enrichProdi(hasil, "Teknik Elektro", ambil, 10)
	if len(out) != 2 || out[0].Nama != "Andi" || out[1].Nama != "Budi" {
		t.Fatalf("filter Teknik Elektro = %+v", out)
	}
	if out[0].Peringkat != 1 || out[1].Peringkat != 2 {
		t.Errorf("peringkat tidak disusun ulang: %+v", out)
	}
	if panggilan != 4 {
		t.Errorf("jumlah lookup pertama = %d, mau 4", panggilan)
	}

	panggilan = 0
	out = enrichProdi(hasil, "Teknik Kimia", ambil, 10)
	if len(out) != 1 || out[0].Nama != "Siti" {
		t.Errorf("filter Teknik Kimia (cache) = %+v", out)
	}
	if panggilan != 0 {
		t.Errorf("lookup kedua = %d, mau 0 (cache)", panggilan)
	}
}

func TestFormatKecepatan(t *testing.T) {
	if got := formatDurasi(45); got != "45 hari (≈1,5 bulan)" {
		t.Errorf("formatDurasi(45) = %q", got)
	}
	if got := formatDurasi(60); got != "60 hari (≈2 bulan)" {
		t.Errorf("formatDurasi(60) = %q", got)
	}
	if got := formatDurasi(7); got != "7 hari" {
		t.Errorf("formatDurasi(7) = %q", got)
	}
	if got := formatTglPendek("2026-01-05"); got != "05/01/2026" {
		t.Errorf("formatTglPendek = %q", got)
	}
	if got := normalisasiNama("  SITI   Aminah "); got != "siti aminah" {
		t.Errorf("normalisasiNama = %q", got)
	}
}
