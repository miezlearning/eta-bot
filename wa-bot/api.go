package main

// api.go — klien HTTP menuju REST API e-TA (server Node) dan guard agar
// bot tidak menghujam server saat banyak chat meminta sekaligus.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// EtaAPI menyatukan state HTTP ke API e-TA.
type EtaAPI struct {
	base    string
	client  *http.Client
	busy    atomic.Bool
	timeout time.Duration
}

// NewEtaAPI membuat client API baru dengan timeout bawaan.
func NewEtaAPI(base string) *EtaAPI {
	return &EtaAPI{
		base:   strings.TrimRight(base, "/"),
		client: &http.Client{Timeout: 60 * time.Second},
	}
}

// TryAcquire returns true (dan mengunci) bila tidak ada fetch berjalan.
func (a *EtaAPI) TryAcquire() bool { return a.busy.CompareAndSwap(false, true) }

// Release melepaskan kunci busy.
func (a *EtaAPI) Release() { a.busy.Store(false) }

// jadwalItem is one event of the schedule list.
type jadwalItem struct {
	Title      string `json:"title"`
	Tanggal    string `json:"tanggal"` // "YYYY-MM-DD"
	Jam        string `json:"jam"`     // "HH:MM:SS"
	JamSelesai string `json:"jamSelesai"`
	Token      string `json:"token"`
	Jenis      string `json:"jenis"`
	Ruang      string `json:"ruang,omitempty"`
}

// jadwalResponse is the envelope returned by /api/jadwal/sidang.
type jadwalResponse struct {
	Identity map[string]string `json:"identity"`
	Jadwal   []jadwalItem      `json:"jadwal"`
}

// judulDosenItem is one supervisor/examiner info
type judulDosenItem struct {
	Nama   string `json:"nama"`
	Status string `json:"status"`
}

// judulItem is one entry of the thesis title list.
type judulItem struct {
	Judul      string                    `json:"judul"`
	NIM        string                    `json:"nim"`
	Nama       string                    `json:"nama"`
	BatasWaktu string                    `json:"batasWaktu"`
	Dosen      map[string]judulDosenItem `json:"dosen"`
}

// judulResponse is the envelope returned by /api/judul-skripsi.
type judulResponse struct {
	Identity map[string]string `json:"identity"`
	Daftar   []judulItem       `json:"daftar"`
}

// healthResponse is the envelope for /api/health.
type healthResponse struct {
	Status      string `json:"status"`
	Connected   bool   `json:"connected"`
	LastLoginAt string `json:"lastLoginAt"`
	Version     string `json:"version"`
}

// riwayatSidangItem is one stage of student defense history
type riwayatSidangItem struct {
	Jenis      string `json:"jenis"`
	Tanggal    string `json:"tanggal"`
	Jam        string `json:"jam"`
	JamSelesai string `json:"jamSelesai"`
	Ruang      string `json:"ruang"`
	Token      string `json:"token"`
}

// mahasiswaItem is full student profile
type mahasiswaItem struct {
	Nama          string                    `json:"nama"`
	NIM           string                    `json:"nim"`
	Prodi         string                    `json:"prodi"`
	Judul         string                    `json:"judul"`
	Dosen         map[string]judulDosenItem `json:"dosen"`
	BatasWaktu    string                    `json:"batasWaktu"`
	RiwayatSidang []riwayatSidangItem       `json:"riwayatSidang"`
}

// mahasiswaResponse is the envelope for /api/mahasiswa
type mahasiswaResponse struct {
	Query   string          `json:"query"`
	Total   int             `json:"total"`
	Matches []mahasiswaItem `json:"matches"`
}

// bulanStatItem holds counts for one month
type bulanStatItem struct {
	Bulan      string       `json:"bulan"`
	Sempro     int          `json:"sempro"`
	Semhas     int          `json:"semhas"`
	Pendadaran int          `json:"pendadaran"`
	Total      int          `json:"total"`
	JadwalList []jadwalItem `json:"jadwalList"`
}

// tahunStatItem holds counts for one year
type tahunStatItem struct {
	Tahun      string          `json:"tahun"`
	Sempro     int             `json:"sempro"`
	Semhas     int             `json:"semhas"`
	Pendadaran int             `json:"pendadaran"`
	Total      int             `json:"total"`
	BulanList  []bulanStatItem `json:"bulanList"`
}

// globalStatItem holds all-time counts
type globalStatItem struct {
	Sempro         int `json:"sempro"`
	Semhas         int `json:"semhas"`
	Pendadaran     int `json:"pendadaran"`
	BelumTerjadwal int `json:"belumTerjadwal"`
	TotalTerjadwal int `json:"totalTerjadwal"`
}

// statistikResponse is the envelope for /api/statistik
type statistikResponse struct {
	TotalSemua  int             `json:"totalSemua"`
	Global      globalStatItem  `json:"global"`
	PerBulan    []bulanStatItem `json:"perBulan"`
	TargetBulan *bulanStatItem  `json:"targetBulan"`
	TargetTahun *tahunStatItem  `json:"targetTahun"`
}

// penilaiDetailItem holds detailed examiner info from /api/sidang/:token
type penilaiDetailItem struct {
	Peran string `json:"peran"`
	Nama  string `json:"nama"`
	NIP   string `json:"nip"`
	Prodi string `json:"prodi"`
}

// jadwalDetailItem holds schedule detail
type jadwalDetailItem struct {
	Ruang     string `json:"ruang"`
	Kapasitas string `json:"kapasitas"`
	Tanggal   string `json:"tanggal"`
	Jam       string `json:"jam"`
}

// daftarHadirItem holds info of attendees who registered to participate/watch
type daftarHadirItem struct {
	NIM  string `json:"nim"`
	Nama string `json:"nama"`
	Foto string `json:"foto"`
}

// pesertaDetailItem holds student participant detail
type pesertaDetailItem struct {
	Nama          string            `json:"nama"`
	NIM           string            `json:"nim"`
	Prodi         string            `json:"prodi"`
	JumlahPeserta string            `json:"jumlahPeserta"`
	DaftarHadir   []daftarHadirItem `json:"daftarHadir"`
}

// detailSidangResponse is the envelope for /api/sidang/:token
type detailSidangResponse struct {
	Judul             string              `json:"judul"`
	Jadwal            jadwalDetailItem    `json:"jadwal"`
	ProgressBimbingan string              `json:"progressBimbingan"`
	JenisTA           string              `json:"jenisTA"`
	Peserta           pesertaDetailItem   `json:"peserta"`
	Penilai           []penilaiDetailItem `json:"penilai"`
}

// fetchJSON memanggil path API dan mengisi target (pointer ke struct).
func (a *EtaAPI) fetchJSON(path string, target any) error {
	url := a.base + path

	resp, err := a.client.Get(url)
	if err != nil {
		return fmt.Errorf("gagal koneksi API: %w", err)
	}
	defer resp.Body.Close()

	// 502 dipakai server saat session e-TA perlu relogin; coba ulang sekali.
	if resp.StatusCode == http.StatusBadGateway {
		time.Sleep(4 * time.Second)
		resp, err = a.client.Get(url)
		if err != nil {
			return fmt.Errorf("gagal koneksi API (coba 2): %w", err)
		}
		defer resp.Body.Close()
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("API mengembalikan HTTP %d", resp.StatusCode)
	}

	decoder := json.NewDecoder(resp.Body)
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("respon API tidak valid: %w", err)
	}
	return nil
}

// FetchJadwal mengambil seluruh jadwal sidang dari API.
func (a *EtaAPI) FetchJadwal() ([]jadwalItem, map[string]string, error) {
	var out jadwalResponse
	if err := a.fetchJSON("/api/jadwal/sidang", &out); err != nil {
		return nil, nil, err
	}
	return out.Jadwal, out.Identity, nil
}

// FetchJudul mengambil daftar judul skripsi (opsional filter q).
func (a *EtaAPI) FetchJudul(q string) ([]judulItem, map[string]string, error) {
	var out judulResponse
	path := "/api/judul-skripsi"
	if strings.TrimSpace(q) != "" {
		path += "?q=" + strings.ReplaceAll(strings.TrimSpace(q), " ", "%20")
	}
	if err := a.fetchJSON(path, &out); err != nil {
		return nil, nil, err
	}
	return out.Daftar, out.Identity, nil
}

// FetchMahasiswa mencari data mahasiswa berdasarkan nama atau NIM.
func (a *EtaAPI) FetchMahasiswa(query string) (*mahasiswaResponse, error) {
	var out mahasiswaResponse
	path := "/api/mahasiswa?q=" + strings.ReplaceAll(strings.TrimSpace(query), " ", "%20")
	if err := a.fetchJSON(path, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FetchStatistik mengambil data statistik sidang per bulan atau tahun.
func (a *EtaAPI) FetchStatistik(bulan, tahun string) (*statistikResponse, error) {
	var out statistikResponse
	path := "/api/statistik"
	params := []string{}
	if bulan != "" {
		params = append(params, "bulan="+bulan)
	}
	if tahun != "" {
		params = append(params, "tahun="+tahun)
	}
	if len(params) > 0 {
		path += "?" + strings.Join(params, "&")
	}
	if err := a.fetchJSON(path, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FetchDetailSidang mengambil detail sidang lengkap per token.
func (a *EtaAPI) FetchDetailSidang(token string) (*detailSidangResponse, error) {
	var out detailSidangResponse
	path := "/api/sidang/" + token
	if err := a.fetchJSON(path, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// eroomItem holds single seminar event from e-room
type eroomItem struct {
	Title      string `json:"title"`
	Nama       string `json:"nama"`
	Ruang      string `json:"ruang"`
	Jenis      string `json:"jenis"`
	Tanggal    string `json:"tanggal"`
	Jam        string `json:"jam"`
	JamSelesai string `json:"jamSelesai"`
	Token      string `json:"token"`
}

type eroomResponse struct {
	Total  int         `json:"total"`
	Jadwal []eroomItem `json:"jadwal"`
}

// FetchEroomJadwal mencari jadwal seminar dari modul e-room.
func (a *EtaAPI) FetchEroomJadwal(query string) (*eroomResponse, error) {
	var out eroomResponse
	path := "/api/eroom/jadwal?q=" + strings.ReplaceAll(strings.TrimSpace(query), " ", "%20")
	if err := a.fetchJSON(path, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FetchEroomSemua mengambil seluruh agenda e-room se-Fakultas Teknik (tanpa filter).
func (a *EtaAPI) FetchEroomSemua() (*eroomResponse, error) {
	var out eroomResponse
	if err := a.fetchJSON("/api/eroom/jadwal", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FetchEroomDetail mengambil detail sidang e-room (berisi NIM & prodi peserta).
func (a *EtaAPI) FetchEroomDetail(token string) (*detailSidangResponse, error) {
	var out detailSidangResponse
	path := "/api/eroom/sidang/" + url.PathEscape(token)
	if err := a.fetchJSON(path, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FetchHealth mengambil status API e-TA.
func (a *EtaAPI) FetchHealth() (*healthResponse, error) {
	var out healthResponse
	if err := a.fetchJSON("/api/health", &out); err != nil {
		return nil, err
	}
	return &out, nil
}
