package main

// api.go — klien HTTP menuju REST API e-TA (server Node) dan guard agar
// bot tidak menghujam server saat banyak chat meminta sekaligus.

import (
	"encoding/json"
	"fmt"
	"net/http"
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
}

// jadwalResponse is the envelope returned by /api/jadwal/sidang.
type jadwalResponse struct {
	Identity map[string]string `json:"identity"`
	Jadwal   []jadwalItem      `json:"jadwal"`
}

// judulItem is one entry of the thesis title list.
type judulItem struct {
	Judul      string `json:"judul"`
	NIM        string `json:"nim"`
	Nama       string `json:"nama"`
	BatasWaktu string `json:"batasWaktu"`
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

// FetchHealth mengambil status API e-TA.
func (a *EtaAPI) FetchHealth() (*healthResponse, error) {
	var out healthResponse
	if err := a.fetchJSON("/api/health", &out); err != nil {
		return nil, err
	}
	return &out, nil
}
