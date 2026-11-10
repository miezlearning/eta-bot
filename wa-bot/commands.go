package main

// commands.go -- mesin command bot: parsing tanggal/hari berbahasa Indonesia,
// pemformatan /jadwal, /judul, dan /status. Logika tanggal mengikuti bot
// Telegram versi Node (bot/bot.js fungsi parseTarget).

import (
	"context"
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
		"Bot e-TA -- Jadwal Sidang TA/Skripsi FT Unmul",
		"",
		"Perintah:",
		"/jadwal -- jadwal sidang hari ini",
		"/jadwal besok -- jadwal besok",
		"/jadwal lusa -- jadwal lusa",
		"/jadwal kemarin -- jadwal kemarin",
		"/jadwal kamis -- jadwal hari kamis terdekat",
		"/jadwal 2026-11-12 atau /jadwal 12/11 -- jadwal tanggal tertentu",
		"/jadwal semua -- ringkasan total + 5 jadwal berikutnya",
		"",
		"Perintah lain:",
		"/status -- status koneksi API e-TA",
		"/judul <kata kunci> -- cari judul skripsi",
		"",
		"Contoh: /jadwal besok",
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

	raw := strings.ToLower(strings.TrimSpace(arg))
	if raw == "" {
		raw = "hari ini"
	}

	if raw == "semua" || raw == "all" {
		return buatRingkasanSemua(daftar)
	}

	target, ok := tglDariArgumen(raw)
	if !ok {
		return "Argumen tidak dikenali: /jadwal " + raw + "\n\n" + teksBantuan()
	}

	isi := jadwalDiTanggal(daftar, target.Format("2006-01-02"))
	return formatJadwalHarian(target, isi, iden, len(daftar))
}

// buatRingkasanSemua: total + breakdown jenis + 5 jadwal berikutnya.
func buatRingkasanSemua(daftar []jadwalItem) string {
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

	var sb strings.Builder
	sb.WriteString("Ringkasan jadwal sidang e-TA\n\n")
	sb.WriteString("Total: " + strconv.Itoa(len(daftar)) + " jadwal\n")
	sb.WriteString("Mendatang: " + strconv.Itoa(len(berikut)) + " jadwal\n")

	for _, jenis := range []string{"Seminar Proposal", "Seminar Hasil", "Pendadaran"} {
		if hitung[jenis] > 0 {
			sb.WriteString("- " + jenis + ": " + strconv.Itoa(hitung[jenis]) + "\n")
		}
	}

	sb.WriteString("\n5 jadwal berikutnya:\n")
	for i, it := range berikut {
		if i == 5 {
			sb.WriteString("\n...dan " + strconv.Itoa(len(berikut)-5) + " jadwal lagi. Contoh: /jadwal " + berikut[5].Tanggal)
			break
		}
		sb.WriteString("- " + formatTanggalPendek(it.Tanggal) + " " + ringkasJam(it.Jam) + " -- " + it.Title + " (" + it.Jenis + ")\n")
	}
	return sb.String()
}

// tanganiJudul: /judul [kata kunci] -- pencarian judul skripsi (max 10).
func tanganiJudul(arg string) string {
	if !eta.TryAcquire() {
		return "Bot sedang memproses permintaan lain, coba lagi 10 detik."
	}
	defer eta.Release()

	daftar, _, err := eta.FetchJudul(arg)
	if err != nil {
		return "Gagal mengambil daftar judul dari API e-TA:\n" + err.Error()
	}
	if len(daftar) == 0 {
		hasil := "Tidak ada judul skripsi ditemukan"
		if strings.TrimSpace(arg) != "" {
			hasil += " untuk kata kunci: " + arg
		}
		return hasil
	}

	var sb strings.Builder
	sb.WriteString("Pencarian judul skripsi")
	if strings.TrimSpace(arg) != "" {
		sb.WriteString(" (kata kunci: " + arg + ")")
	}
	sb.WriteString("\nTotal ditemukan: " + strconv.Itoa(len(daftar)) + "\n\n")

	const maks = 10
	for i, it := range daftar {
		if i == maks {
			sb.WriteString("\n...dan " + strconv.Itoa(len(daftar)-maks) + " lainnya. Pertajam kata kunci untuk hasil lebih spesifik.")
			break
		}
		sb.WriteString(strconv.Itoa(i+1) + ". " + it.Judul + "\n   -> " + it.Nama + " (" + it.NIM + ")\n")
	}
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
