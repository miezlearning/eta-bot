package main

// commands.go -- mesin command bot: parsing tanggal/hari berbahasa Indonesia,
// pemformatan /jadwal, /judul, dan /status. Logika tanggal mengikuti bot
// Telegram versi Node (bot/bot.js fungsi parseTarget).

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// Nama hari & bulan Indonesia (indeks mengikuti konvensi Go).
var namaHari = []string{"Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"}
var namaBulan = []string{"", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
	"Juli", "Agustus", "September", "Oktober", "November", "Desember"}

var hariKe = map[string]int{
	"minggu": 0, "ahad": 0,
	"senin":  1,
	"selasa": 2,
	"rabu":   3, "rebo": 3,
	"kamis": 4,
	"jumat": 5, "jum'at": 5, "jumaat": 5,
	"sabtu": 6,
}

// handleIncoming menangani satu pesan masuk lalu membalas bila cocok command.
func handleIncoming(chat types.JID, text string) {
	lower := strings.ToLower(text)
	if !strings.HasPrefix(lower, "/") && !strings.HasPrefix(lower, "!") {
		return
	}

	fields := strings.Fields(text)
	if len(fields) == 0 {
		return
	}

	cmd := strings.ToLower(fields[0])
	cmd = strings.TrimPrefix(cmd, "/")
	cmd = strings.TrimPrefix(cmd, "!")

	var argumen string
	if len(fields) > 1 {
		argumen = strings.Join(fields[1:], " ")
	}

	var reply string
	switch cmd {
	case "", "start", "help", "menu":
		reply = teksBantuan()
	case "status":
		reply = tanganiStatus()
	case "jadwal":
		reply = tanganiJadwal(argumen)
	case "judul":
		reply = tanganiJudul(argumen)
	case "mhs", "mahasiswa", "cari":
		reply = tanganiMahasiswa(argumen)
	case "statistik", "stats":
		reply = tanganiStatistik(argumen)
	case "tercepat", "cepat", "leaderboard":
		reply = tanganiTercepat(argumen)
	case "detail":
		reply = tanganiDetail(argumen)
	case "eroom":
		reply = tanganiEroom(argumen)
	default:
		// Command tak dikenal: abaikan (aman untuk grup).
		return
	}

	kirimBalasan(chat, reply)
}

// kirimBalasan mengirim teks sebagai pesan WhatsApp biasa.
func kirimBalasan(chat types.JID, teks string) {
	if waClient == nil || teks == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := waClient.SendMessage(ctx, chat, &waE2E.Message{
		Conversation: proto.String(teks),
	})
	if err != nil {
		logger.Errorf("gagal kirim balasan: %v", err)
	}
}

// teksBantuan menampilkan menu command bot.
func teksBantuan() string {
	return strings.Join([]string{
		"Bot e-TA -- Layanan Informasi Skripsi FT Unmul",
		"",
		"Pencarian Mahasiswa & Judul:",
		"/mhs <nama/NIM> -- info judul, dosen pembimbing & penguji, serta riwayat sempro, semhas, & pdd",
		"/judul <kata kunci> -- cari judul skripsi & dosen penilai",
		"/detail <NIM/token> -- detail ruang, kapasitas, SK tim penilai, & audiens hadir",
		"/eroom <ruang/nama> -- kalender seminar e-room se-Fakultas Teknik",
		"",
		"Statistik Sidang:",
		"/statistik -- statistik sempro, semhas, & pdd bulan ini",
		"/statistik <bulan/tahun> -- contoh: /statistik november, /statistik 2026-06, /statistik 2026",
		"/tercepat -- peringkat tercepat sempro → pendadaran (se-FT)",
		"/tercepat angkatan 2022 -- filter angkatan (dari NIM)",
		"/tercepat nama <nama> / nim <NIM> -- cari orang tertentu",
		"/tercepat dosen <nama> / judul <kata> / ruang <kode> -- filter lanjutan",
		"/tercepat tahun 2026 -- pendadaran tahun 2026; tambahkan angka di akhir untuk halaman",
		"",
		"Jadwal Sidang:",
		"/jadwal -- jadwal sidang hari ini",
		"/jadwal besok -- jadwal besok",
		"/jadwal lusa -- jadwal lusa",
		"/jadwal kemarin -- jadwal kemarin",
		"/jadwal kamis -- jadwal hari terdekat",
		"/jadwal 2026-11-23 atau /jadwal 23/11 -- jadwal tanggal tertentu",
		"/jadwal semua -- ringkasan total + 5 jadwal berikutnya",
		"",
		"Lainnya:",
		"/status -- status koneksi API e-TA",
		"/help -- menu bantuan ini",
	}, "\n")
}

// tanganiStatus menampilkan kesehatan API e-TA.
func tanganiStatus() string {
	h, err := eta.FetchHealth()
	if err != nil {
		return "API e-TA tidak bisa dihubungi: " + err.Error()
	}
	var sb strings.Builder
	sb.WriteString("[status API e-TA] " + h.Status)
	if h.Connected {
		sb.WriteString(" -- session e-TA aktif")
	} else {
		sb.WriteString(" -- session e-TA TIDAK aktif (server akan relogin otomatis)")
	}
	if h.Version != "" {
		sb.WriteString("\nVersi: " + h.Version)
	}
	if h.LastLoginAt != "" {
		sb.WriteString("\nLogin terakhir: " + h.LastLoginAt)
	}
	return sb.String()
}

// splitArgAndPage memisahkan kata kunci pencarian dengan nomor halaman di akhir (misal "D209 2" -> "D209", 2).
func splitArgAndPage(arg string) (string, int) {
	fields := strings.Fields(strings.TrimSpace(arg))
	if len(fields) > 1 {
		last := fields[len(fields)-1]
		if len(last) <= 3 {
			if p, err := strconv.Atoi(last); err == nil && p >= 1 {
				query := strings.Join(fields[:len(fields)-1], " ")
				return query, p
			}
		}
	}
	return strings.TrimSpace(arg), 1
}

// tanganiJadwal menampilkan jadwal sesuai argumen (besok/senin/tanggal/dll).
func tanganiJadwal(arg string) string {
	// Lindungi e-TA: hanya 1 fetch berjalan sekaligus.
	if !eta.TryAcquire() {
		return "Bot sedang memproses permintaan lain, coba lagi 10 detik."
	}
	defer eta.Release()

	daftar, iden, err := eta.FetchJadwal()
	if err != nil {
		return "Gagal mengambil jadwal dari API e-TA:\n" + err.Error()
	}
	if len(daftar) == 0 {
		return "Tidak ada jadwal sidang terdaftar saat ini."
	}

	q, page := splitArgAndPage(arg)
	raw := strings.ToLower(strings.TrimSpace(q))
	if raw == "" {
		raw = "hari ini"
	}

	if raw == "semua" || raw == "all" {
		return buatRingkasanSemua(daftar, page)
	}

	target, ok := tglDariArgumen(raw)
	if !ok {
		return "Argumen tidak dikenali: /jadwal " + raw + "\n\n" + teksBantuan()
	}

	isi := jadwalDiTanggal(daftar, target.Format("2006-01-02"))
	return formatJadwalHarian(target, isi, iden, len(daftar))
}

// buatRingkasanSemua: total + breakdown jenis + jadwal mendatang dengan pagination.
func buatRingkasanSemua(daftar []jadwalItem, page int) string {
	hitung := map[string]int{}
	for _, it := range daftar {
		hitung[it.Jenis]++
	}

	hariIni := startOfHari(time.Now())
	berikut := []jadwalItem{}
	nowISO := hariIni.Format("2006-01-02")
	for _, it := range daftar {
		if it.Tanggal >= nowISO {
			berikut = append(berikut, it)
		}
	}
	sort.SliceStable(berikut, func(i, j int) bool {
		if berikut[i].Tanggal != berikut[j].Tanggal {
			return berikut[i].Tanggal < berikut[j].Tanggal
		}
		return berikut[i].Jam < berikut[j].Jam
	})

	const pageSize = 6
	totalMendatang := len(berikut)
	totalPages := (totalMendatang + pageSize - 1) / pageSize
	if totalPages < 1 {
		totalPages = 1
	}
	if page < 1 {
		page = 1
	}
	if page > totalPages {
		page = totalPages
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if end > totalMendatang {
		end = totalMendatang
	}

	var sb strings.Builder
	sb.WriteString("Ringkasan Jadwal Sidang FT Unmul\n\n")
	sb.WriteString("Total Terdata: " + strconv.Itoa(len(daftar)) + " jadwal\n")
	sb.WriteString("Mendatang: " + strconv.Itoa(totalMendatang) + " jadwal\n\n")

	for _, jenis := range []string{"Seminar Proposal", "Seminar Hasil", "Pendadaran"} {
		if hitung[jenis] > 0 {
			sb.WriteString("- " + jenis + ": " + strconv.Itoa(hitung[jenis]) + "\n")
		}
	}

	sb.WriteString("\nJadwal Mendatang (Hal " + strconv.Itoa(page) + " dari " + strconv.Itoa(totalPages) + "):\n")
	for i, it := range berikut[start:end] {
		num := start + i + 1
		sb.WriteString(strconv.Itoa(num) + ". " + formatTanggalPendek(it.Tanggal) + " " + ringkasJam(it.Jam) + " -- " + it.Title + " (" + it.Jenis + ")\n")
	}

	if totalPages > 1 {
		nextPage := page + 1
		if nextPage > totalPages {
			nextPage = 1
		}
		sb.WriteString("\nKetik: /jadwal semua " + strconv.Itoa(nextPage) + " untuk halaman berikutnya.\n")
	}
	return sb.String()
}

// tanganiJudul: /judul [kata kunci] [halaman] -- pencarian judul skripsi dengan pagination.
func tanganiJudul(arg string) string {
	q, page := splitArgAndPage(arg)
	if !eta.TryAcquire() {
		return "Bot sedang memproses permintaan lain, coba lagi 10 detik."
	}
	defer eta.Release()

	daftar, _, err := eta.FetchJudul(q)
	if err != nil {
		return "Gagal mengambil daftar judul dari API e-TA:\n" + err.Error()
	}
	if len(daftar) == 0 {
		hasil := "Tidak ada judul skripsi ditemukan"
		if q != "" {
			hasil += " untuk kata kunci: " + q
		}
		return hasil
	}

	const pageSize = 5
	total := len(daftar)
	totalPages := (total + pageSize - 1) / pageSize
	if totalPages < 1 {
		totalPages = 1
	}
	if page < 1 {
		page = 1
	}
	if page > totalPages {
		page = totalPages
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if end > total {
		end = total
	}

	var sb strings.Builder
	sb.WriteString("Pencarian Judul Skripsi")
	if q != "" {
		sb.WriteString(" (kata kunci: " + q + ")")
	}
	sb.WriteString("\nTotal: " + strconv.Itoa(total) + " judul | Halaman " + strconv.Itoa(page) + " dari " + strconv.Itoa(totalPages) + "\n\n")

	for i, it := range daftar[start:end] {
		num := start + i + 1
		sb.WriteString(strconv.Itoa(num) + ". " + it.Judul + "\n")
		sb.WriteString("   -> " + it.Nama)
		if it.NIM != "" {
			sb.WriteString(" (" + it.NIM + ")")
		}
		sb.WriteString("\n")
	}

	if totalPages > 1 {
		nextPage := page + 1
		if nextPage > totalPages {
			nextPage = 1
		}
		sb.WriteString("\nKetik: /judul " + q + " " + strconv.Itoa(nextPage) + " untuk halaman berikutnya.\n")
	}
	sb.WriteString("Ketik /mhs <NIM> untuk detail mahasiswa.")
	return sb.String()
}

// jadwalDiTanggal memfilter item dengan tanggal "YYYY-MM-DD" lalu urutkan jam.
func jadwalDiTanggal(semua []jadwalItem, tgl string) []jadwalItem {
	isi := []jadwalItem{}
	for _, it := range semua {
		if it.Tanggal == tgl {
			isi = append(isi, it)
		}
	}
	sort.SliceStable(isi, func(i, j int) bool { return isi[i].Jam < isi[j].Jam })
	return isi
}

// formatJadwalHarian menyusun pesan jadwal satu hari.
func formatJadwalHarian(t time.Time, isi []jadwalItem, iden map[string]string, totalSemua int) string {
	var sb strings.Builder
	sb.WriteString("Jadwal Sidang e-TA -- " + formatTanggal(t) + "\n")
	if iden != nil && iden["prodi"] != "" {
		sb.WriteString("(prodi " + iden["prodi"] + ")\n")
	}
	sb.WriteString("\n")

	if len(isi) == 0 {
		sb.WriteString("Tidak ada jadwal sidang pada hari ini.\n")
		sb.WriteString("Total daftar: " + strconv.Itoa(totalSemua) + " jadwal. Coba /jadwal semua.")
		return sb.String()
	}

	for i, it := range isi {
		sb.WriteString(strconv.Itoa(i+1) + ". " + spanJam(it.Jam, it.JamSelesai) +
			" -- " + it.Title + " (" + it.Jenis + ")\n")
	}
	sb.WriteString("\nDetail peserta: /judul <nama>")
	return sb.String()
}

// ringkasJam memangkas "HH:MM:SS" -> "HH:MM" bila ada detik.
func ringkasJam(jam string) string {
	if len(jam) == 8 {
		return jam[:5]
	}
	return jam
}

// spanJam menyusun "HH:MM-HH:MM" bila ada jam selesai.
func spanJam(jam, jamSelesai string) string {
	waktu := ringkasJam(jam)
	if jamSelesai != "" {
		return waktu + "-" + ringkasJam(jamSelesai)
	}
	return waktu
}

// formatTanggal menebak teks "Kamis, 12 November 2026".
func formatTanggal(t time.Time) string {
	return namaHari[int(t.Weekday())] + ", " + strconv.Itoa(t.Day()) + " " +
		namaBulan[int(t.Month())] + " " + strconv.Itoa(t.Year())
}

// formatTanggalPendek dari "YYYY-MM-DD" jadi "12 Nov 2026".
func formatTanggalPendek(iso string) string {
	t, ok := parseTanggalISO(iso)
	if !ok {
		return iso
	}
	bulan := namaBulan[int(t.Month())][:3]
	return strconv.Itoa(t.Day()) + " " + bulan + " " + strconv.Itoa(t.Year())
}

// startOfHari menormalkan time ke 00:00 hari yang sama.
func startOfHari(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

// parseTanggalISO menerima "YYYY-MM-DD".
func parseTanggalISO(iso string) (time.Time, bool) {
	t, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(iso), time.Local)
	if err != nil {
		return time.Time{}, false
	}
	return startOfHari(t), true
}

// tglDariArgumen memetakan argumen command body ke tanggal (besok / kemarin,
// "senin", "2026-11-12", "12/11", "12/11/2026" dst).
func tglDariArgumen(arg string) (time.Time, bool) {
	now := time.Now()
	arg = strings.ToLower(strings.TrimSpace(arg))
	arg = strings.ReplaceAll(arg, ",", " ")
	arg = strings.Join(strings.Fields(arg), " ")

	// Relatif.
	switch {
	case arg == "besok" || arg == "tomorrow":
		return startOfHari(now.AddDate(0, 0, 1)), true
	case arg == "lusa" || arg == "dua hari lagi":
		return startOfHari(now.AddDate(0, 0, 2)), true
	case arg == "kemarin" || arg == "kemaren" || arg == "yesterday":
		return startOfHari(now.AddDate(0, 0, -1)), true
	case arg == "hari ini" || arg == "sekarang" || arg == "today" || arg == "now":
		return startOfHari(now), true
	}
	if strings.Contains(arg, "besok") {
		return startOfHari(now.AddDate(0, 0, 1)), true
	}
	if strings.Contains(arg, "hari ini") {
		return startOfHari(now), true
	}

	// ISO "YYYY-MM-DD".
	if t, ok := parseTanggalISO(arg); ok {
		return t, true
	}

	// "DD/MM/YYYY" / "DD-MM-YYYY" / "DD/MM".
	if t, ok := parseTanggalSlash(arg); ok {
		return t, true
	}

	// Nama hari: cari hari tersebut di pekan mendatang (hari yang sama -> pekan depan).
	first := firstKata(arg)
	if idx, ada := hariKe[first]; ada {
		delta := (idx - int(now.Weekday()) + 7) % 7
		if delta == 0 {
			delta = 7
		}
		return startOfHari(now.AddDate(0, 0, delta)), true
	}

	return time.Time{}, false
}

// firstKata memotong kata pertama argumen (mis. "jum'at pagi" -> "jum'at").
func firstKata(arg string) string {
	kata := strings.Fields(arg)
	if len(kata) == 0 {
		return ""
	}
	return kata[0]
}

// normalNamaHari membuang tanda (', `, dsb) dan lowercase tanpa tanda hubung.
func normalNamaHari(s string) string {
	var b strings.Builder
	for _, r := range s {
		if !unicode.IsLetter(r) && r != '\'' && r != '`' {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// parseTanggalSlash menerima "DD/MM/YYYY", "DD-MM-YYYY", "DD/MM", "DD/MM/YY".
func parseTanggalSlash(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, sep := range []string{"/", "-"} {
		if !strings.Contains(s, sep) {
			continue
		}
		parts := strings.Split(s, sep)
		if len(parts) < 2 || len(parts) > 3 {
			continue
		}
		// "YYYY-MM-DD" sudah ditangani parseTanggalISO.
		if len(parts) == 3 && len(parts[0]) == 4 {
			continue
		}
		if len(parts[0]) != 1 && len(parts[0]) != 2 {
			continue
		}
		hari, errA := strconv.Atoi(parts[0])
		bulan, errB := strconv.Atoi(parts[1])
		if errA != nil || errB != nil {
			continue
		}

		tahun := time.Now().Year()
		if len(parts) == 3 {
			n, errC := strconv.Atoi(parts[2])
			if errC != nil {
				continue
			}
			if len(parts[2]) == 2 {
				tahun = 2000 + n
			} else {
				tahun = n
			}
		}

		t := time.Date(tahun, time.Month(bulan), hari, 0, 0, 0, 0, time.Local)
		if t.Day() != hari || int(t.Month()) != bulan || t.Year() != tahun {
			return time.Time{}, false
		}
		// Tanpa tahun: bila sudah lewat, anggap tahun depan.
		if len(parts) == 2 && t.Before(startOfHari(now())) {
			t = t.AddDate(1, 0, 0)
		}
		return t, true
	}
	return time.Time{}, false
}

// now() di sini dipakai oleh parseTanggalSlash agar konsisten dgn timezone lokal.
func now() time.Time { return time.Now() }

func isAllDigits(s string) bool {
	for _, r := range s {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return len(s) > 0
}

// tanganiMahasiswa: /mhs <nama/NIM> [halaman]
func tanganiMahasiswa(arg string) string {
	q, page := splitArgAndPage(arg)
	q = strings.TrimSpace(q)
	if q == "" {
		return "Format: /mhs <nama atau NIM> [halaman]\nContoh:\n/mhs Renaldi\n/mhs 2209106054\n/mhs Muhammad 2"
	}
	if !eta.TryAcquire() {
		return "Bot sedang memproses permintaan lain, coba lagi beberapa detik."
	}
	defer eta.Release()

	res, err := eta.FetchMahasiswa(q)
	if err != nil {
		return "Gagal mencari data mahasiswa: " + err.Error()
	}
	if res.Total == 0 || len(res.Matches) == 0 {
		return "Mahasiswa dengan kata kunci '" + q + "' tidak ditemukan di sistem e-TA / e-Room.\nTips: Pastikan ejaan nama benar atau gunakan NIM lengkap."
	}

	if res.Total == 1 {
		m := res.Matches[0]
		var sb strings.Builder
		sb.WriteString("Data Mahasiswa & Tugas Akhir FT Unmul\n\n")
		sb.WriteString("Nama: " + m.Nama + "\n")
		sb.WriteString("NIM: " + m.NIM + "\n")
		if m.Prodi != "" {
			sb.WriteString("Prodi: " + m.Prodi + "\n")
		}
		if m.BatasWaktu != "" {
			sb.WriteString("Status Batas: " + m.BatasWaktu + "\n")
		}
		sb.WriteString("\nJudul Tugas Akhir:\n")
		if m.Judul != "" {
			sb.WriteString(m.Judul + "\n")
		} else {
			sb.WriteString("Belum terdaftar\n")
		}

		sb.WriteString("\nDosen Pembimbing & Penguji:\n")
		roles := []struct {
			key, label string
		}{
			{"pembimbing_1", "Pembimbing 1"},
			{"pembimbing_2", "Pembimbing 2"},
			{"penguji_1", "Penguji 1"},
			{"penguji_2", "Penguji 2"},
		}
		adaDosen := false
		for _, r := range roles {
			if d, ok := m.Dosen[r.key]; ok && d.Nama != "" {
				adaDosen = true
				sb.WriteString("- " + r.label + ": " + d.Nama)
				if d.Status != "" {
					sb.WriteString(" [" + d.Status + "]")
				}
				sb.WriteString("\n")
			}
		}
		if !adaDosen {
			sb.WriteString("- Belum ada data penilai\n")
		}

		sb.WriteString("\nRiwayat & Timeline Sidang:\n")
		if len(m.RiwayatSidang) > 0 {
			for _, s := range m.RiwayatSidang {
				sb.WriteString("- " + s.Jenis + ":\n")
				if s.Tanggal != "" {
					jam := s.Jam
					if s.JamSelesai != "" && len(jam) >= 5 {
						jam = jam[:5] + " - " + s.JamSelesai
					}
					sb.WriteString("  Tanggal: " + s.Tanggal + " (" + jam + " WITA)\n")
					ruang := s.Ruang
					if ruang == "" {
						ruang = "Menunggu penetapan ruang"
					}
					sb.WriteString("  Ruang: " + ruang + "\n")
				} else {
					sb.WriteString("  Tanggal: Menunggu jadwal antrean\n")
				}
			}
		} else {
			sb.WriteString("- Belum memiliki jadwal sidang terdaftar\n")
		}
		return sb.String()
	}

	// Multiple matches with pagination
	const pageSize = 5
	total := len(res.Matches)
	totalPages := (total + pageSize - 1) / pageSize
	if totalPages < 1 {
		totalPages = 1
	}
	if page < 1 {
		page = 1
	}
	if page > totalPages {
		page = totalPages
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if end > total {
		end = total
	}

	var sb strings.Builder
	sb.WriteString("Ditemukan " + strconv.Itoa(res.Total) + " mahasiswa untuk kata kunci '" + q + "' (Hal " + strconv.Itoa(page) + " dari " + strconv.Itoa(totalPages) + "):\n\n")
	for i, m := range res.Matches[start:end] {
		num := start + i + 1
		sb.WriteString(strconv.Itoa(num) + ". " + m.Nama + " (" + m.NIM + ")\n")
		if m.Prodi != "" {
			sb.WriteString("   Prodi: " + m.Prodi + "\n")
		}
		if m.Judul != "" {
			jdl := m.Judul
			if len(jdl) > 60 {
				jdl = jdl[:60] + "..."
			}
			sb.WriteString("   Judul: " + jdl + "\n")
		}
	}
	sb.WriteString("\nKetik: /mhs <NIM> untuk melihat detail lengkap.")
	if totalPages > 1 {
		nextPage := page + 1
		if nextPage > totalPages {
			nextPage = 1
		}
		sb.WriteString("\nKetik: /mhs " + q + " " + strconv.Itoa(nextPage) + " untuk halaman berikutnya.")
	}
	return sb.String()
}

// tanganiStatistik: /statistik [bulan/tahun] [halaman]
func tanganiStatistik(arg string) string {
	rawQuery, page := splitArgAndPage(arg)
	raw := strings.TrimSpace(rawQuery)
	if !eta.TryAcquire() {
		return "Bot sedang memproses permintaan lain, coba lagi beberapa detik."
	}
	defer eta.Release()

	var bulanParam, tahunParam string
	if raw == "" || strings.EqualFold(raw, "ini") {
		bulanParam = time.Now().Format("2006-01")
	} else if len(raw) == 4 && isAllDigits(raw) {
		tahunParam = raw
	} else if strings.Contains(raw, "-") || strings.Contains(raw, "/") {
		parts := strings.FieldsFunc(raw, func(r rune) bool { return r == '-' || r == '/' })
		if len(parts) == 2 {
			if len(parts[0]) == 4 {
				m, _ := strconv.Atoi(parts[1])
				bulanParam = fmt.Sprintf("%s-%02d", parts[0], m)
			} else if len(parts[1]) == 4 {
				m, _ := strconv.Atoi(parts[0])
				bulanParam = fmt.Sprintf("%s-%02d", parts[1], m)
			}
		}
	} else {
		lower := strings.ToLower(raw)
		for bNama, bIdx := range map[string]int{
			"januari": 1, "jan": 1, "februari": 2, "feb": 2, "maret": 3, "mar": 3,
			"april": 4, "apr": 4, "mei": 5, "juni": 6, "jun": 6, "juli": 7, "jul": 7,
			"agustus": 8, "agu": 8, "september": 9, "sep": 9, "oktober": 10, "okt": 10,
			"november": 11, "nov": 11, "desember": 12, "des": 12,
		} {
			if strings.Contains(lower, bNama) {
				bulanParam = fmt.Sprintf("%d-%02d", time.Now().Year(), bIdx)
				break
			}
		}
		if bulanParam == "" && !strings.EqualFold(raw, "semua") {
			bulanParam = time.Now().Format("2006-01")
		}
	}

	res, err := eta.FetchStatistik(bulanParam, tahunParam)
	if err != nil {
		return "Gagal mengambil statistik: " + err.Error()
	}

	var sb strings.Builder
	if res.TargetBulan != nil {
		b := res.TargetBulan
		sb.WriteString("Statistik Sidang FT Unmul (" + b.Bulan + ")\n\n")
		sb.WriteString("- Seminar Proposal: " + strconv.Itoa(b.Sempro) + " orang\n")
		sb.WriteString("- Seminar Hasil: " + strconv.Itoa(b.Semhas) + " orang\n")
		sb.WriteString("- Pendadaran: " + strconv.Itoa(b.Pendadaran) + " orang\n")
		sb.WriteString("------------------------------\n")
		sb.WriteString("Total Sidang: " + strconv.Itoa(b.Total) + " orang\n\n")

		if len(b.JadwalList) > 0 {
			const pageSize = 6
			totalList := len(b.JadwalList)
			totalPages := (totalList + pageSize - 1) / pageSize
			if totalPages < 1 {
				totalPages = 1
			}
			if page < 1 {
				page = 1
			}
			if page > totalPages {
				page = totalPages
			}
			start := (page - 1) * pageSize
			end := start + pageSize
			if end > totalList {
				end = totalList
			}

			sb.WriteString("Daftar Sidang (" + strconv.Itoa(totalList) + " jadwal, Hal " + strconv.Itoa(page) + " dari " + strconv.Itoa(totalPages) + "):\n")
			for i, j := range b.JadwalList[start:end] {
				name := strings.Split(j.Title, " - ")[0]
				tgl := j.Tanggal
				if len(tgl) >= 10 {
					tgl = tgl[8:10] + "/" + tgl[5:7]
				}
				sb.WriteString(strconv.Itoa(start+i+1) + ". " + tgl + " -- " + name + " (" + j.Jenis + ")\n")
			}
			if totalPages > 1 {
				nextPage := page + 1
				if nextPage > totalPages {
					nextPage = 1
				}
				queryLabel := raw
				if queryLabel == "" {
					queryLabel = b.Bulan
				}
				sb.WriteString("\nKetik: /statistik " + queryLabel + " " + strconv.Itoa(nextPage) + " untuk halaman berikutnya.\n")
			}
		}
		sb.WriteString("\nContoh lain: /statistik oktober atau /statistik 2026")
		return sb.String()
	}

	if res.TargetTahun != nil {
		y := res.TargetTahun
		sb.WriteString("Statistik Sidang FT Unmul Tahun " + y.Tahun + "\n\n")
		sb.WriteString("Total: " + strconv.Itoa(y.Total) + " orang\n")
		sb.WriteString("- Seminar Proposal: " + strconv.Itoa(y.Sempro) + " orang\n")
		sb.WriteString("- Seminar Hasil: " + strconv.Itoa(y.Semhas) + " orang\n")
		sb.WriteString("- Pendadaran: " + strconv.Itoa(y.Pendadaran) + " orang\n\n")
		sb.WriteString("Rincian per Bulan:\n")
		for _, m := range y.BulanList {
			sb.WriteString("- " + m.Bulan + ": " + strconv.Itoa(m.Total) + " (Sempro: " + strconv.Itoa(m.Sempro) + ", Semhas: " + strconv.Itoa(m.Semhas) + ", Pdd: " + strconv.Itoa(m.Pendadaran) + ")\n")
		}
		return sb.String()
	}

	sb.WriteString("Statistik Keseluruhan Sidang FT Unmul\n\n")
	sb.WriteString("Total Tercatat: " + strconv.Itoa(res.TotalSemua) + " orang\n")
	sb.WriteString("- Seminar Proposal: " + strconv.Itoa(res.Global.Sempro) + " orang\n")
	sb.WriteString("- Seminar Hasil: " + strconv.Itoa(res.Global.Semhas) + " orang\n")
	sb.WriteString("- Pendadaran: " + strconv.Itoa(res.Global.Pendadaran) + " orang\n")
	sb.WriteString("- Menunggu Ruang: " + strconv.Itoa(res.Global.BelumTerjadwal) + " orang\n")
	return sb.String()
}

// tanganiDetail: /detail <token/NIM/nama>
func tanganiDetail(arg string) string {
	q := strings.TrimSpace(arg)
	if q == "" {
		return "Format: /detail <NIM atau Nama atau Token>\nContoh:\n/detail 2209106054\n/detail Renaldi"
	}
	if !eta.TryAcquire() {
		return "Bot sedang memproses permintaan lain, coba lagi beberapa detik."
	}
	defer eta.Release()

	token := q
	if !strings.HasPrefix(token, "eyJ") && len(token) < 50 {
		mhsRes, err := eta.FetchMahasiswa(q)
		if err != nil || len(mhsRes.Matches) == 0 {
			return "Mahasiswa '" + q + "' tidak ditemukan."
		}
		top := mhsRes.Matches[0]
		if len(top.RiwayatSidang) == 0 {
			return "Mahasiswa " + top.Nama + " belum memiliki token sidang terdaftar."
		}
		token = top.RiwayatSidang[len(top.RiwayatSidang)-1].Token
	}

	d, err := eta.FetchDetailSidang(token)
	if err != nil {
		return "Gagal mengambil detail sidang: " + err.Error()
	}

	var sb strings.Builder
	sb.WriteString("Detail Sidang e-TA\n\n")
	sb.WriteString("Judul Tugas Akhir:\n" + d.Judul + "\n\n")
	sb.WriteString("Data Peserta:\n")
	sb.WriteString("- Nama: " + d.Peserta.Nama + "\n")
	sb.WriteString("- NIM: " + d.Peserta.NIM + "\n")
	if d.Peserta.Prodi != "" {
		sb.WriteString("- Prodi: " + d.Peserta.Prodi + "\n")
	}
	sb.WriteString("\nJadwal Pelaksanaan:\n")
	sb.WriteString("- Tahap: " + d.JenisTA + "\n")
	sb.WriteString("- Waktu: " + d.Jadwal.Tanggal + " (" + d.Jadwal.Jam + ")\n")
	sb.WriteString("- Ruang: " + d.Jadwal.Ruang + "\n")
	if d.Jadwal.Kapasitas != "" {
		sb.WriteString("- Kapasitas: " + d.Jadwal.Kapasitas + "\n")
	}
	if d.ProgressBimbingan != "" {
		sb.WriteString("- Progress: " + d.ProgressBimbingan + "\n")
	}

	sb.WriteString("\nTim Penilai:\n")
	for _, p := range d.Penilai {
		sb.WriteString("- " + p.Peran + ": " + p.Nama + "\n")
		if p.NIP != "" {
			sb.WriteString("  NIP: " + p.NIP + " | Prodi: " + p.Prodi + "\n")
		}
	}

	if len(d.Peserta.DaftarHadir) > 0 {
		sb.WriteString("\nMahasiswa Terdaftar Ikut Hadir (" + strconv.Itoa(len(d.Peserta.DaftarHadir)) + " orang):\n")
		for i, h := range d.Peserta.DaftarHadir {
			sb.WriteString(strconv.Itoa(i+1) + ". " + h.Nama)
			if h.NIM != "" {
				sb.WriteString(" (" + h.NIM + ")")
			}
			sb.WriteString("\n")
		}
	} else if d.Peserta.JumlahPeserta != "" && d.Peserta.JumlahPeserta != "0" {
		sb.WriteString("\nJumlah Mahasiswa Terdaftar Hadir: " + d.Peserta.JumlahPeserta + " orang\n")
	} else {
		sb.WriteString("\nMahasiswa Terdaftar Ikut Hadir: Belum ada yang mendaftar\n")
	}

	return sb.String()
}

// tanganiEroom: /eroom [kata kunci/ruang/nama] [halaman]
func tanganiEroom(arg string) string {
	q, page := splitArgAndPage(arg)
	q = strings.TrimSpace(q)
	if !eta.TryAcquire() {
		return "Bot sedang memproses permintaan lain, coba lagi beberapa detik."
	}
	defer eta.Release()

	res, err := eta.FetchEroomJadwal(q)
	if err != nil {
		return "Gagal mengambil jadwal e-room: " + err.Error()
	}
	if len(res.Jadwal) == 0 {
		pesan := "Tidak ada agenda seminar e-room ditemukan"
		if q != "" {
			pesan += " untuk kata kunci: " + q
		}
		return pesan
	}

	const pageSize = 6
	total := len(res.Jadwal)
	totalPages := (total + pageSize - 1) / pageSize
	if totalPages < 1 {
		totalPages = 1
	}
	if page < 1 {
		page = 1
	}
	if page > totalPages {
		page = totalPages
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if end > total {
		end = total
	}

	var sb strings.Builder
	sb.WriteString("Jadwal Seminar e-Room FT Unmul")
	if q != "" {
		sb.WriteString(" (" + q + ")")
	}
	sb.WriteString("\nTotal: " + strconv.Itoa(res.Total) + " agenda (Hal " + strconv.Itoa(page) + " dari " + strconv.Itoa(totalPages) + ")\n\n")

	for i, j := range res.Jadwal[start:end] {
		num := start + i + 1
		tgl := j.Tanggal
		if tgl == "" {
			tgl = "Belum terjadwal"
		}
		jam := ""
		if j.Jam != "" {
			jam = " (" + j.Jam
			if j.JamSelesai != "" {
				jam += "-" + j.JamSelesai
			}
			jam += ")"
		}
		sb.WriteString(strconv.Itoa(num) + ". " + j.Nama + "\n")
		sb.WriteString("   Ruang: " + j.Ruang + " | Tahap: " + j.Jenis + "\n")
		sb.WriteString("   Waktu: " + tgl + jam + "\n")
	}
	sb.WriteString("\nKetik /detail <nama/NIM> untuk info dosen & audiens hadir.")
	if totalPages > 1 {
		nextPage := page + 1
		if nextPage > totalPages {
			nextPage = 1
		}
		qParam := q
		if qParam != "" {
			qParam += " "
		}
		sb.WriteString("\nKetik: /eroom " + qParam + strconv.Itoa(nextPage) + " untuk halaman berikutnya.")
	}
	return sb.String()
}

// kecepatanItem menyimpan durasi sempro -> pendadaran satu mahasiswa.
type kecepatanItem struct {
	Nama       string
	NIM        string
	Angkatan   string
	Judul      string
	Dosen      string
	Ruang      string
	Sempro     string // YYYY-MM-DD
	Pendadaran string // YYYY-MM-DD
	Hari       int
	Peringkat  int
}

// filterTercepat merangkum filter pencarian command /tercepat.
type filterTercepat struct {
	Tahun    string
	Angkatan string
	NIM      string
	Nama     string
	Dosen    string
	Judul    string
	Ruang    string
	Batas    int
	Halaman  int
}

// agregatKecepatan mengumpulkan tanggal terjadwal per mahasiswa.
type agregatKecepatan struct {
	nama   string
	sempro string
	pdd    string
	ruang  string
}

// normalisasiNama dipakai sebagai kunci pengelompokan antar event e-room.
func normalisasiNama(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(s))), " ")
}

// kunciFilterTercepat adalah kata kunci yang harus diikuti nilai.
var kunciFilterTercepat = map[string]bool{
	"angkatan": true, "tahun": true, "nim": true, "nama": true,
	"dosen": true, "judul": true, "ruang": true, "top": true,
}

// angkatanDariNIM mengubah dua digit awal NIM menjadi tahun angkatan.
func angkatanDariNIM(nim string) string {
	if len(nim) < 2 {
		return ""
	}
	for _, r := range nim[:2] {
		if r < '0' || r > '9' {
			return ""
		}
	}
	return "20" + nim[:2]
}

// normAngkatan menerima "22" maupun "2022" dan mengembalikan "2022".
func normAngkatan(s string) string {
	s = strings.TrimSpace(s)
	if len(s) == 2 && s[0] >= '0' && s[0] <= '9' && s[1] >= '0' && s[1] <= '9' {
		return "20" + s
	}
	return s
}

// parseFilterTercepat membaca argumen bentuk:
//
//	/tercepat angkatan 2022 dosen Fahrul tahun 2026 [halaman]
//	/tercepat nim 2209 judul performansi
//	/tercepat budi 2
func parseFilterTercepat(arg string) filterTercepat {
	f := filterTercepat{Batas: 10, Halaman: 1}
	fields := strings.Fields(strings.TrimSpace(arg))

	if len(fields) > 0 {
		last := fields[len(fields)-1]
		if n, err := strconv.Atoi(last); err == nil && n >= 1 && len(last) <= 3 &&
			(len(fields) == 1 || !kunciFilterTercepat[strings.ToLower(fields[len(fields)-2])]) {
			f.Halaman = n
			fields = fields[:len(fields)-1]
		}
	}

	sisa := make([]string, 0, len(fields))
	for _, v := range fields {
		l := strings.ToLower(v)
		if l == "semua" || l == "all" {
			f.Batas = 25
			continue
		}
		sisa = append(sisa, v)
	}
	fields = sisa

	for i := 0; i < len(fields); {
		key := strings.ToLower(fields[i])
		mentah := fields[i]
		i++
		if !kunciFilterTercepat[key] {
			if len(key) == 4 && key[0] >= '0' && key[0] <= '9' {
				if n, err := strconv.Atoi(key); err == nil && n >= 1900 && n <= 2100 {
					f.Tahun = key
					continue
				}
			}
			if len(key) >= 8 {
				if _, err := strconv.Atoi(key); err == nil {
					f.NIM = key
					continue
				}
			}
			bag := []string{mentah}
			for i < len(fields) && !kunciFilterTercepat[strings.ToLower(fields[i])] {
				bag = append(bag, fields[i])
				i++
			}
			f.Nama = strings.Join(bag, " ")
			continue
		}
		if key == "top" {
			if i < len(fields) {
				if n, err := strconv.Atoi(fields[i]); err == nil && n > 0 {
					if n > 50 {
						n = 50
					}
					f.Batas = n
					i++
				}
			}
			continue
		}
		bag := []string{}
		for i < len(fields) && !kunciFilterTercepat[strings.ToLower(fields[i])] {
			bag = append(bag, fields[i])
			i++
		}
		nilai := strings.Join(bag, " ")
		switch key {
		case "angkatan":
			f.Angkatan = normAngkatan(nilai)
		case "tahun":
			f.Tahun = nilai
		case "nim":
			f.NIM = nilai
		case "nama":
			f.Nama = nilai
		case "dosen":
			f.Dosen = nilai
		case "judul":
			f.Judul = nilai
		case "ruang":
			f.Ruang = nilai
		}
	}
	return f
}

// label menampilkan filter aktif untuk header pesan.
func (f filterTercepat) label() string {
	parts := []string{}
	if f.Tahun != "" {
		parts = append(parts, "tahun "+f.Tahun)
	}
	if f.Angkatan != "" {
		parts = append(parts, "angkatan "+f.Angkatan)
	}
	if f.NIM != "" {
		parts = append(parts, "NIM "+f.NIM)
	}
	if f.Nama != "" {
		parts = append(parts, "nama '"+f.Nama+"'")
	}
	if f.Dosen != "" {
		parts = append(parts, "dosen '"+f.Dosen+"'")
	}
	if f.Judul != "" {
		parts = append(parts, "judul '"+f.Judul+"'")
	}
	if f.Ruang != "" {
		parts = append(parts, "ruang '"+f.Ruang+"'")
	}
	if len(parts) == 0 {
		return "tanpa filter"
	}
	return strings.Join(parts, " | ")
}

// keArg menyusun ulang argumen untuk petunjuk halaman berikutnya.
func (f filterTercepat) keArg() string {
	parts := []string{}
	if f.Tahun != "" {
		parts = append(parts, "tahun", f.Tahun)
	}
	if f.Angkatan != "" {
		parts = append(parts, "angkatan", f.Angkatan)
	}
	if f.NIM != "" {
		parts = append(parts, "nim", f.NIM)
	}
	if f.Nama != "" {
		parts = append(parts, "nama", f.Nama)
	}
	if f.Dosen != "" {
		parts = append(parts, "dosen", f.Dosen)
	}
	if f.Judul != "" {
		parts = append(parts, "judul", f.Judul)
	}
	if f.Ruang != "" {
		parts = append(parts, "ruang", f.Ruang)
	}
	if f.Batas == 25 {
		parts = append(parts, "semua")
	} else if f.Batas != 10 {
		parts = append(parts, "top", strconv.Itoa(f.Batas))
	}
	return strings.Join(parts, " ")
}

// cocokFilterTercepat mengecek filter selain tahun (sudah saat agregasi).
func cocokFilterTercepat(h kecepatanItem, f filterTercepat) bool {
	if f.Angkatan != "" && h.Angkatan != f.Angkatan {
		return false
	}
	if f.NIM != "" && !strings.Contains(h.NIM, f.NIM) {
		return false
	}
	if f.Nama != "" && !strings.Contains(normalisasiNama(h.Nama), normalisasiNama(f.Nama)) {
		return false
	}
	if f.Dosen != "" && !strings.Contains(normalisasiNama(h.Dosen), normalisasiNama(f.Dosen)) {
		return false
	}
	if f.Judul != "" && !strings.Contains(normalisasiNama(h.Judul), normalisasiNama(f.Judul)) {
		return false
	}
	if f.Ruang != "" && !strings.Contains(normalisasiNama(h.Ruang), normalisasiNama(f.Ruang)) {
		return false
	}
	return true
}

// hitungTercepat menyusun peringkat mahasiswa berdasarkan durasi tercepat
// dari Seminar Proposal ke Pendadaran. Data judul skripsi dipakai untuk
// melengkapi NIM/angkatan/dosen dan menyaring hasil.
func hitungTercepat(jadwal []eroomItem, daftarJudul []judulItem, f filterTercepat, hariIni time.Time) []kecepatanItem {
	judulMap := make(map[string]judulItem, len(daftarJudul))
	for _, item := range daftarJudul {
		key := normalisasiNama(item.Nama)
		if key == "" {
			continue
		}
		if _, ada := judulMap[key]; !ada {
			judulMap[key] = item
		}
	}

	agregat := make(map[string]*agregatKecepatan)
	hariIniStr := hariIni.Format("2006-01-02")

	for _, j := range jadwal {
		isSempro := j.Jenis == "Seminar Proposal"
		isPdd := j.Jenis == "Pendadaran"
		if !isSempro && !isPdd {
			continue
		}
		if len(j.Tanggal) < 10 {
			continue
		}
		tgl := j.Tanggal[:10]
		if _, err := time.Parse("2006-01-02", tgl); err != nil {
			continue
		}
		if isPdd {
			if f.Tahun != "" && !strings.HasPrefix(tgl, f.Tahun+"-") {
				continue
			}
			if tgl > hariIniStr {
				continue
			}
		}

		nama := strings.TrimSpace(j.Nama)
		if nama == "" {
			nama = strings.TrimSpace(strings.Split(j.Title, " - ")[0])
		}
		key := normalisasiNama(nama)
		if key == "" || key == "tes" {
			continue
		}

		a, ada := agregat[key]
		if !ada {
			a = &agregatKecepatan{nama: nama}
			agregat[key] = a
		}
		if isSempro {
			if a.sempro == "" || tgl < a.sempro {
				a.sempro = tgl
				a.nama = nama
			}
		} else if a.pdd == "" || tgl < a.pdd {
			a.pdd = tgl
			a.ruang = strings.TrimSpace(j.Ruang)
		}
	}

	hasil := make([]kecepatanItem, 0, len(agregat))
	for _, a := range agregat {
		if a.sempro == "" || a.pdd == "" || a.pdd < a.sempro {
			continue
		}
		t1, err1 := time.Parse("2006-01-02", a.sempro)
		t2, err2 := time.Parse("2006-01-02", a.pdd)
		if err1 != nil || err2 != nil {
			continue
		}
		hari := int(t2.Sub(t1).Hours() / 24)
		if hari < 0 || hari > 3650 {
			continue
		}

		h := kecepatanItem{
			Nama:       a.nama,
			Ruang:      a.ruang,
			Sempro:     a.sempro,
			Pendadaran: a.pdd,
			Hari:       hari,
		}
		if item, ada := judulMap[normalisasiNama(a.nama)]; ada {
			h.NIM = item.NIM
			h.Angkatan = angkatanDariNIM(item.NIM)
			h.Judul = item.Judul
			namaDosen := []string{}
			for _, d := range item.Dosen {
				namaD := strings.TrimSpace(d.Nama)
				if namaD != "" {
					namaDosen = append(namaDosen, namaD)
				}
			}
			sort.Strings(namaDosen)
			h.Dosen = strings.Join(namaDosen, ", ")
		}
		if !cocokFilterTercepat(h, f) {
			continue
		}
		hasil = append(hasil, h)
	}

	sort.Slice(hasil, func(i, j int) bool {
		if hasil[i].Hari != hasil[j].Hari {
			return hasil[i].Hari < hasil[j].Hari
		}
		return normalisasiNama(hasil[i].Nama) < normalisasiNama(hasil[j].Nama)
	})
	for i := range hasil {
		hasil[i].Peringkat = i + 1
	}
	return hasil
}

// formatDurasi menampilkan jumlah hari plus perkiraan bulan.
func formatDurasi(hari int) string {
	s := strconv.Itoa(hari) + " hari"
	if hari >= 30 {
		bulan := strconv.FormatFloat(float64(hari)/30.0, 'f', 1, 64)
		bulan = strings.TrimRight(strings.TrimRight(bulan, "0"), ".")
		s += " (≈" + strings.ReplaceAll(bulan, ".", ",") + " bulan)"
	}
	return s
}

// formatTglPendek mengubah YYYY-MM-DD menjadi DD/MM/YYYY.
func formatTglPendek(tgl string) string {
	if len(tgl) < 10 {
		return tgl
	}
	return tgl[8:10] + "/" + tgl[5:7] + "/" + tgl[:4]
}

// tanganiTercepat menampilkan peringkat sekaligus berguna untuk mencari orang.
func tanganiTercepat(arg string) string {
	f := parseFilterTercepat(arg)
	if !eta.TryAcquire() {
		return "Bot sedang memproses permintaan lain, coba lagi beberapa detik."
	}
	defer eta.Release()

	res, err := eta.FetchEroomSemua()
	if err != nil {
		return "Gagal mengambil jadwal e-room: " + err.Error()
	}
	if res == nil || len(res.Jadwal) == 0 {
		return "Data jadwal e-room belum tersedia."
	}

	daftarJudul, _, err := eta.FetchJudul("")
	if err != nil {
		if f.Angkatan != "" || f.NIM != "" || f.Dosen != "" || f.Judul != "" {
			return "Gagal mengambil data judul skripsi: " + err.Error()
		}
		daftarJudul = nil
	}

	hasil := hitungTercepat(res.Jadwal, daftarJudul, f, time.Now())
	if len(hasil) == 0 {
		return "Tidak ada mahasiswa cocok dengan filter: " + f.label() + "."
	}
	total := len(hasil)
	if total > f.Batas {
		hasil = hasil[:f.Batas]
	}

	const pageSize = 8
	totalPages := (len(hasil) + pageSize - 1) / pageSize
	if totalPages < 1 {
		totalPages = 1
	}
	page := f.Halaman
	if page < 1 {
		page = 1
	}
	if page > totalPages {
		page = totalPages
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if end > len(hasil) {
		end = len(hasil)
	}

	var sb strings.Builder
	sb.WriteString("Peringkat Tercepat Sempro → Pendadaran\n")
	sb.WriteString("Sumber: e-room se-FT · pendadaran sudah berlalu\n")
	sb.WriteString("Filter: " + f.label() + "\n")
	sb.WriteString("Mahasiswa cocok: " + strconv.Itoa(total) + " (ditampilkan maks. " + strconv.Itoa(f.Batas) + ")\n\n")
	for _, h := range hasil[start:end] {
		sb.WriteString(strconv.Itoa(h.Peringkat) + ". " + h.Nama + " -- " + formatDurasi(h.Hari) + "\n")
		identitas := ""
		if h.Angkatan != "" {
			identitas += h.Angkatan + " · "
		}
		if h.NIM != "" {
			identitas += h.NIM + " · "
		}
		sb.WriteString("   " + identitas + formatTglPendek(h.Sempro) + " → " + formatTglPendek(h.Pendadaran) + "\n")
	}
	sb.WriteString("\nDurasi dihitung dari Sempro tercepat ke Pendadaran pertama.")
	if totalPages > 1 {
		nextPage := page + 1
		if nextPage > totalPages {
			nextPage = 1
		}
		argLanjutan := f.keArg()
		if argLanjutan != "" {
			argLanjutan += " "
		}
		sb.WriteString("\nKetik: /tercepat " + argLanjutan + strconv.Itoa(nextPage) + " untuk halaman berikutnya.")
	}
	return sb.String()
}
