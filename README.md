# e-TA FT Unmul REST API

REST API untuk **Sistem e-Tugas Akhir (e-TA)** Fakultas Teknik Universitas Mulawarman.
Service ini login otomatis ke aplikasi live `e-office.ft.unmul.ac.id` lalu mengekspos
datanya sebagai endpoint REST JSON — siap dipakai sebagai backend bot Telegram, aplikasi web,
script otomasi, dsb.

> ⚠️ **Catatan penting:** Service ini menggunakan akun AIS pribadi untuk mengakses data.
> Pastikan Anda berhak menggunakan akun tersebut dan memahami kebijakan penggunaan sistem
> milik universitas. Kredensial disimpan dalam file `.env`.

---

## Daftar Isi

- [Fitur](#fitur)
- [Prasyarat](#prasyarat)
- [Instalasi & Konfigurasi](#instalasi--konfigurasi)
- [Menjalankan](#menjalankan)
- [Endpoint API](#endpoint-api)
- [Pencarian & Filter](#pencarian--filter)
- [Notifikasi Telegram](#notifikasi-perubahan-jadwal-telegram)
- [Deploy ke Vercel (Bot Telegram)](#deploy-ke-vercel-bot-telegram--webhook)
- [Bot WhatsApp (Go)](#bot-whatsapp-go-wa-bot)
- [Deploy ke Coolify (VPS)](#deploy-ke-coolify-vps)
- [Contoh Pemakaian](#contoh-pemakaian)
- [Contoh Respons](#contoh-respons)
- [Struktur Project](#struktur-project)
- [Keterbatasan](#keterbatasan)
- [Disclaimer](#disclaimer)

---

## Fitur

- **Login otomatis** + manajemen session (cookie/CSRF) ke aplikasi Laravel e-TA, dengan auto re-login jika session kadaluarsa.
- **Jadwal sidang** — kalender FullCalendar dengan jenis seminar (Proposal/Hasil/Pendadaran) & token detail.
- **Detail sidang** — judul, jadwal (ruang/jam/tanggal), pembimbing, penguji, peserta.
- **Daftar judul skripsi** — semua judul + status dosen penilai + batas waktu.
- **Profil mahasiswa** — info pribadi, nilai KRS, dst.
- **Daftar ruang seminar** — dropdown ruangan per prodi.
- **Pencarian & filter** — filter jadwal & judul berdasarkan nama / NIM / prodi / kata kunci.
- **Label prodi per event** — enrich jadwal dengan prodi peserta (dengan cache agar cepat).
- **Notifikasi Telegram** — pantau perubahan jadwal (baru/berubah/hilang) dan kirim pesan otomatis.

---

## Prasyarat

- Node.js 18+ (ditest di v23)
- npm

## Instalasi & Konfigurasi

```bash
npm install
cp .env.example .env
```

Isi file `.env`:

```
# === Kredensial e-TA ===
E_TA_USERID=your_nim
E_TA_PASSWORD=your_password
E_TA_ROLE=Mahasiswa

# === Server API ===
API_PORT=3001
BASE_URL=https://e-office.ft.unmul.ac.id
HTTP_TIMEOUT=15000

# === Notifikasi Telegram (opsional) ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
NOTIFY_INTERVAL_MS=900000
```

> **Role yang tersedia:** `Mahasiswa`, `DTPS` (Dosen FT), `DTPT` (Dosen PT), `Staf`, `Mitra`.
> Data yang tampil **dibatasi oleh role akun** — role `Mahasiswa` hanya melihat data prodi sendiri.

## Menjalankan

```bash
npm start          # atau node server.js
npm run dev        # mode watch (restart otomatis saat edit)
```

Server berjalan di `http://localhost:3001`.

---

## Endpoint API

Semua endpoint adalah `GET` dan mengembalikan JSON. Otentikasi dikelola otomatis oleh server.

| Endpoint | Deskripsi |
|----------|-----------|
| `/` | Daftar semua endpoint (menu API) |
| `/api/health` | Status koneksi, info session, status notifier |
| `/api/dashboard` | Jadwal sidang dari beranda |
| `/api/jadwal/sidang` | Kalender jadwal sidang (jenis & token) + pencarian |
| `/api/judul-skripsi` | Daftar judul skripsi + dosen penilai + pencarian |
| `/api/mahasiswa` | Cari mahasiswa lengkap: judul TA, tim dosen, & timeline sidang sempro/semhas/pdd (e-TA & e-room) |
| `/api/statistik` | Data statistik sidang per bulan/tahun/semua (`?source=eroom|eta`) |
| `/api/eroom/jadwal` | Kalender seminar dari modul e-room (3.000+ data se-Fakultas Teknik) |
| `/api/eroom/sidang/:token` | Detail sidang modul e-room lengkap dengan tim penilai & audiens hadir |
| `/api/sidang/:token` | Detail sidang per token (judul, jadwal, penilai, audiens) |
| `/api/data/proposal` | Tabel data proposal (KRS/identitas) |
| `/api/data/hasil` | Data hasil seminar (per akun) |
| `/api/data/pendadaran` | Data pendadaran (per akun) |
| `/api/bimbingan` | Progress bimbingan (per akun) |
| `/api/seminar` | Riwayat seminar (per akun) |
| `/api/profil` | Profil mahasiswa lengkap (nilai, dst.) |
| `/api/ruang` | Daftar ruang seminar per prodi |

> **Catatan route data:** `/api/data/hasil`, `/api/data/pendadaran`, `/api/bimbingan`,
> `/api/seminar` hanya berisi tabel bila akun yang login **memiliki rekam data** tersebut.
> Untuk akun tanpa riwayat, response-nya `{ identity, tables: [] }`.

### `GET /api/health`

```json
{
  "status": "ok",
  "service": "e-TA FT Unmul REST API",
  "connected": true,
  "lastLoginAt": "2026-11-09T21:47:29.267Z",
  "notifier": {
    "enabled": false,
    "intervalMs": 900000,
    "lastNotifiedAt": null,
    "totalNotified": 0
  },
  "version": "1.0.0"
}
```

- `connected` — `true` bila session ke e-TA aktif.
- `notifier.enabled` — `true` bila `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID` sudah diisi.
- `notifier.lastNotifiedAt` / `totalNotified` — riwayat pengiriman notifikasi.

---

## Pencarian & Filter

Endpoint **jadwal** dan **judul** mendukung filter query-string (semua case-insensitive):

```
/api/jadwal/sidang?nama=Nizam
/api/jadwal/sidang?nim=2209106100
/api/jadwal/sidang?prodi=Informatika
/api/jadwal/sidang?q=skripsi
/api/jadwal/sidang?enrich=true
/api/judul-skripsi?nama=rizky
/api/judul-skripsi?nim=2209106125
/api/judul-skripsi?q=augmented%20reality
```

| Param | Berlaku di | Arti |
|-------|-----------|------|
| `q` | jadwal, judul, mahasiswa, eroom | Pencarian bebas pada judul/nama/NIM/ruang |
| `nama` | jadwal & judul | Filter nama (substring) |
| `nim` | jadwal & judul | Filter NIM (substring) |
| `prodi` | jadwal | Filter prodi. **Otomatis mengaktifkan enrich** bila belum aktif |
| `enrich` | jadwal | `true`/`1` → tambah field `prodi` per event (tarik dari halaman detail) |
| `useCache` | jadwal | `false` untuk melewati cache enrich (default `true`) |
| `page` | jadwal, judul, mahasiswa, eroom, statistik | Nomor halaman pagination (mulai dari 1) |
| `limit` | jadwal, judul, mahasiswa, eroom, statistik | Jumlah item per halaman (default: 20 di REST API) |

### Tentang `enrich` & cache

Event jadwal asalnya tidak punya field prodi (halaman list tidak menampilkannya). Dengan
`enrich=true`, server menarik satu halaman detail per event untuk mendapatkan prodi peserta.

- **Panggilan pertama** lambat (bisa 20–30 detik untuk ~200 event).
- Hasil di-**cache per nama peserta** (nama stabil, sementara token berubah tiap request),
  sehingga **panggilan berikutnya hampir instan** (< 1 detik).
- Filter `?prodi=` otomatis mengaktifkan enrich.

---

## Notifikasi Perubahan Jadwal (Telegram)

Server bisa memantau jadwal sidang secara berkala dan **mengirim notifikasi ke Telegram**
saat ada jadwal *baru*, *berubah*, atau *hilang*. Tidak perlu dependensi tambahan —
menggunakan `fetch` bawaan Node 18+.

### Konfigurasi

Isi di `.env`:

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...   # token dari @BotFather
TELEGRAM_CHAT_ID=123456789             # ID chat/group tujuan
NOTIFY_INTERVAL_MS=900000              # interval cek (ms); default 15 menit
```

- Kosongkan `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID` untuk menonaktifkan.
- Server menjalankan **satu cek saat startup** untuk mengisi snapshot awal (tidak dikirim),
  lalu memeriksa ulang setiap interval.
- Status bisa dicek di `GET /api/health` → field `notifier`.

### Cara kerja

Setiap interval, server menarik jadwal terbaru lalu membandingkannya dengan snapshot
sebelumnya. Perubahan diklasifikasikan:

| Jenis | Arti |
|-------|------|
| 🆕 **Baru** | Jadwal yang belum pernah terlihat sebelumnya |
| ✏️ **Berubah** | Jadwal ada tapi isinya berbeda (jam/ruang/jenis) |
| 🗑 **Hilang** | Jadwal yang dulu ada kini tidak ada lagi |

### Format pesan

```
📋 e-TA · Jadwal Sidang Baru
Mahasiswa: ROIHAN NINGRAT SAPUTRA (2209106125)

🆕 Baru (2)
• 2026-11-10 11:00 — Muhammad Nizam - D209 (Pendadaran)
...
```

---

## Deploy ke Vercel (Bot Telegram + Webhook)

Bot Telegram **/jadwal** berjalan di Vercel sebagai serverless function via **webhook**.

> ⚠️ **Penting:** Vercel itu **serverless** — tidak bisa menjalankan proses `node server.js`
> yang terus berjalan. Karena itu **polling & notifikasi berkala (scheduler) TIDAK jalan di Vercel.**
> Yang jalan adalah **command bot** (`/jadwal`, `/jadwal besok`, `/jadwal [tanggal]`) via webhook.
> Untuk notifikasi otomatis, jalankan `server.js` di mesin yang selalu menyala (laptop/NAS).

### Struktur Vercel

```
api/webhook.js   # Fungsi serverless — titik masuk webhook Telegram
bot/bot.js       # Handler command bot (memanggil service e-TA)
vercel.json      # Konfigurasi Vercel (timeout & memory)
scripts/setWebhook.js   # Skrip daftarkan webhook ke Telegram
```

### Command bot yang tersedia (Telegram & WhatsApp)

| Command | Fungsi | Contoh |
|---------|--------|--------|
| `/start`, `/help` | Menampilkan bantuan & daftar perintah lengkap | `/help` |
| `/mhs <nama/NIM> [hal]` | Info lengkap mahasiswa (judul TA, dosen, timeline sidang sempro/semhas/pdd). Didukung pagination inline & text. | `/mhs renaldi` atau `/mhs muhammad 2` |
| `/judul <kata kunci> [hal]` | Cari judul skripsi, mahasiswa, & dosen penilai (pagination inline button & text) | `/judul sistem informasi 2` |
| `/detail <NIM/token>` | Rincian ruang sidang, kapasitas, peserta, dosen penilai, & daftar audiens hadir | `/detail 2209106054` |
| `/eroom [ruang/nama] [hal]` | Jadwal seminar e-room se-Fakultas Teknik (3.300+ data, pagination inline & text) | `/eroom D209 2` |
| `/statistik` | Statistik jumlah orang Sempro, Semhas, & Pendadaran bulan ini | `/statistik` |
| `/statistik <bln/thn> [hal]` | Statistik sidang periode tertentu + pagination daftar peserta | `/statistik oktober 2`, `/statistik 2026` |
| `/jadwal` | Jadwal sidang hari ini | `/jadwal` |
| `/jadwal besok` | Jadwal sidang besok | `/jadwal besok` |
| `/jadwal lusa` | Jadwal sidang lusa | `/jadwal lusa` |
| `/jadwal senin` (dst.) | Jadwal hari tertentu terdekat | `/jadwal kamis` |
| `/jadwal <tanggal>` | Jadwal tanggal tertentu | `/jadwal 2026-11-23` |
| `/jadwal semua [hal]` | Ringkasan total & jadwal mendatang dengan pagination | `/jadwal semua 2` |
| `/status` | Cek status server API & session e-TA | `/status` |

> 💡 **Navigasi Pagination Interaktif di Telegram:**
> Pada hasil daftar panjang (`/mhs`, `/judul`, `/jadwal semua`, `/eroom`, `/statistik`), bot Telegram menyediakan **Inline Keyboard Buttons** (`⬅️ Prev`, `Hal X/Y`, `Next ➡️`) untuk berpindah halaman secara interaktif langsung di chat tanpa spam pesan baru! Pengguna juga dapat mengetikkan nomor halaman di akhir perintah (misal `/eroom D209 2`).

### Langkah deploy

1. **Set env var di Vercel** (Project → Settings → Environment Variables):
   ```
   E_TA_USERID
   E_TA_PASSWORD
   E_TA_ROLE=Mahasiswa
   TELEGRAM_BOT_TOKEN
   TELEGRAM_WEBHOOK_SECRET   # string acak untuk verifikasi webhook
   ```
   (Optional: `BASE_URL`, `HTTP_TIMEOUT`)

2. **Deploy** proyek ini ke Vercel (import repo ke Vercel). Vercel otomatis
   mendeteksi `vercel.json` dan memakai `api/webhook.js` sebagai fungsi.

3. **Daftarkan webhook** ke Telegram dengan URL Vercel Anda:
   ```bash
   npm run set-webhook -- https://<anda>.vercel.app/api/webhook
   ```
   Atau manual:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
        -H "Content-Type: application/json" \
        -d '{"url":"https://<anda>.vercel.app/api/webhook","secret_token":"<WEBHOOK_SECRET>"}'
   ```

4. Kirim `/start` ke bot di Telegram → bot membalas bantuan.

### Catatan performa Vercel

- Fungsi webhook memakai `enrich: false` (1 request e-TA) agar cepat dan dalam batas
  timeout Vercel. Field `prodi` per-event **tidak ditampilkan** bot.
- `vercel.json` menyetel `maxDuration: 25` & `memory: 1024` agar cukup untuk login e-TA.
- Di Vercel Hobby (free), fungsi dibatasi waktu; bila sering timeout, naikkan
  ke Hobby+ (60s) atau gunakan provider lain untuk proses lama.

---

## Bot WhatsApp (Go, `wa-bot/`)

Bot WhatsApp versi **Go** yang memakai **whatsmeow** (`go.mau.fi/whatsmeow`) —
library *unofficial* yang meniru WhatsApp Web.

> ⚠️ **Risiko:** jalur ini **melanggar ToS WhatsApp** dan nomor yang dipakai
> berpotensi **di-reban/diblokir oleh Meta** (risiko milik pengguna).
> Untuk keperluan personal/internal pribadi. Gunakan nomor cadangan bila bisa.

### Struktur

```
wa-bot/
├── main.go         # Koneksi WA (QR / pairing code), event loop, allowlist chat
├── commands.go     # Command engine: /jadwal, /judul, /status, /help (logika = bot Telegram)
├── api.go          # HTTP client menuju REST API e-TA (fetch, retry 502, busy-guard)
├── logic_test.go   # Unit test logika tanggal & format (go test ./...)
└── .env.example    # Template konfigurasi (E_TA_API_BASE, WA_DB, WA_PAIR_PHONE, ...)
```

### Command bot WhatsApp (sama seperti bot Telegram, ditambah `/tercepat`)

| Perintah | Hasil |
|----------|-------|
| `/mhs <nama/NIM> [hal]` | Info mahasiswa: judul TA, dosen pembimbing & penguji, riwayat sempro/semhas/pdd (e-TA + e-room) + pagination |
| `/judul <kata kunci> [hal]` | Cari judul skripsi, mahasiswa, & dosen penilai (didukung pagination nomor halaman) |
| `/detail <NIM/token>` | Rincian ruang, kapasitas, SK penilai sidang, & daftar peserta/audiens hadir |
| `/eroom [ruang/nama] [hal]` | Cari jadwal seminar e-room se-Fakultas Teknik (3.300+ agenda) + pagination halaman |
| `/statistik [periode] [hal]` | Statistik berapa orang sempro, semhas, & pendadaran (se-FT) + pagination daftar sidang |
| `/tercepat [filter] [hal]` | Peringkat tercepat Sempro → Pendadaran + pencarian orang: filter angkatan, nama, NIM, prodi, dosen, judul, ruang, tahun |
| `/terlambat [filter] [hal]` | Kebalikan `/tercepat`: durasi Sempro → Pendadaran paling lama (filter sama) |
| `/jadwal` | Jadwal sidang hari ini |
| `/jadwal besok` / `lusa` / `kemarin` | Jadwal tanggal relatif |
| `/jadwal kamis` (dst.) | Jadwal hari tersebut di pekan mendatang |
| `/jadwal 2026-11-23` atau `/jadwal 23/11` | Jadwal tanggal spesifik |
| `/jadwal semua [hal]` | Ringkasan total + jadwal mendatang ber-halaman (misal `/jadwal semua 2`) |
| `/status` | Status koneksi API e-TA |
| `/help` | Menu bantuan perintah |

Catatan `/tercepat`: memakai seluruh agenda e-room se-FT yang digabung dengan
`/api/judul-skripsi` (NIM, judul, dosen). Hanya mahasiswa dengan jadwal
**Seminar Proposal** dan **Pendadaran** yang dihitung, dengan tanggal pendadaran
sudah berlalu (≤ hari ini). Durasi = selisih dari sempro tercepat ke pendadaran
pertama. Pengelompokan memakai nama e-room yang dinormalisasi; angkatan diturunkan
dari 2 digit awal NIM.

Filter bisa digabung, diikuti nomor halaman di akhir:

| Filter | Contoh | Keterangan |
|--------|--------|------------|
| Angkatan | `/tercepat angkatan 2022` | Dari NIM; `22` juga diterima |
| Tahun pendadaran | `/tercepat tahun 2026` | Angka 4 digit saja juga diterima |
| Nama | `/tercepat nama budi` | Bisa langsung `/tercepat budi` |
| NIM | `/tercepat nim 2209` | Substring NIM |
| Prodi | `/tercepat prodi Informatika` | Dari NIM (prodi akun) + detail e-room; di-cache per nama & prefiks NIM |
| Dosen | `/tercepat dosen Fahrul Agus` | Pembimbing/penguji dari data judul |
| Judul | `/tercepat judul performansi` | Kata kunci judul skripsi |
| Ruang | `/tercepat ruang D209` | Ruang pendadaran di e-room |
| Jumlah | `/tercepat semua`, `/tercepat top 5` | Bawaan 20 (10 per halaman), `semua` = 50 |
| Halaman | `/tercepat angkatan 2022 2` | Nomor di akhir |

Contoh gabungan: `/tercepat angkatan 2022 dosen Fahrul tahun 2026 2`.

Tampilan memakai markdown WhatsApp (`*tebal*`, `_miring_`, `` `kode` ``) dengan
satu baris per mahasiswa agar 10 entri muat dalam satu pesan. `/terlambat`
menerima filter yang sama dan mengurutkan durasi dari yang paling lama.

Catatan filter prodi: daftar e-room tidak memuat prodi, jadi prodi diambil dari
halaman **detail e-room** (`/api/eroom/sidang/:token`, field `peserta.prodi`).
Untuk prodi akun sendiri, NIM dari `/api/judul-skripsi` langsung dipakai tanpa
request tambahan. Untuk prodi lain, bot melakukan satu pencarian detail per
mahasiswa saat pertama kali ditemui, lalu menyimpan hasilnya di cache (per nama
dan per 4 digit kode prodi pada NIM) agar query berikutnya cepat. Contoh:
`/tercepat prodi "Teknik Elektro"`.

### Cara jalan (lokal — butuh proses persisten)

```bash
cd wa-bot
copy .env.example .env     # isi minimal E_TA_API_BASE
go build .                 # -> wa-bot.exe  (kompilasi butuh Go 1.26; toolchain diunduh otomatis)
.\wa-bot.exe
```

1. Login pertama menampilkan **QR code** di terminal — scan lewat WhatsApp HP
   (Perangkat Tertaut). Atau isi `WA_PAIR_PHONE=+62...` di `.env` untuk ditampilkan **kode pairing**.
2. Session disimpan di `WA_DB` (SQLite pure-Go, tanpa CGO — aman di Windows).
3. Pastikan **API e-TA jalan dulu** (`npm start` di repo utama) — bot memanggil
   `/api/jadwal/sidang` & `/api/judul-skripsi`, bukan mencari e-TA sendiri.
4. Bot melindungi e-TA via **busy-guard**: hanya 1 fetch seketika; request dianggap
   menolak bila ada yang lain masih jalan.
5. Terhubung ke **grup** juga bisa — batasi pakai `WA_ALLOWED_CHATS`
   (JID dipisah koma) supaya tidak semua chat bisa memakai bot.

### Catatan

- **Tidak bisa di-deploy ke Vercel** — serverless tidak bisa menjalankan proses persisten
  + WebSocket WhatsApp. Bot WA harus jalan di mesin yang selalu nyala
  (laptop/PC opsren, VPS, NAS, Raspberry Pi).
- Session DB jangan ikut di-commit; sudah masuk `.gitignore`.

---

## Deploy ke Coolify (VPS)

Deploy **semua sekaligus** (API + WA bot + webhook Telegram) sebagai satu stack
**Docker Compose** di Coolify. Panduan ini memakai nama konsep yang stabil antar
versi Coolify — karena Coolify sering memperbarui UI, **label tombol/tab bisa
berubah tapi konsepnya sama**; kalau posisinya beda, cari konsepnya di panel
kiri/atas dashboard.

### File deployment yang disiapkan

```
Dockerfile              # Build API Node (image ringan alpine)
.dockerignore           # Menjaga build context kecil & aman
docker-compose.yaml     # Stack 2 service: api + wa (volume persisten)
wa-bot/Dockerfile       # Multi-stage build bot Go (tanpa CGO)
wa-bot/.dockerignore
```

### Arsitektur di VPS

```
                            ┌────────── Coolify (VPS) ──────────┐
Telegram ── webhook ──────► │  service api: 3001                │
  (via domain proxy)        │   • REST API e-TA                 │
                            │   • POST /api/webhook (bot TG)    │
                            │   • scheduler notifikasi Telegram │
                            │                │ http://api:3001  │
HP WhatsApp ◄─────────────► │  service wa:                    │
  (whatsmeow WebSocket)     │   • wa-bot (Go, whatsmeow)       │
                            │   • volume: wa-session (SQLite)  │
                            └────────────────────────────────────┘
```

### Langkah deploy

**1. Repo sudah ter-push** ke `https://github.com/miezlearning/eta-bot` (branch `main`).

**2. Buat resource baru di Coolify:**
- Dashboard **Projects** → pilih/buat project → **New Resource**.
- Pilih sumber repo (GitHub App / Public Repository / Deploy Key — salah satu).
- Pilih repo `miezlearning/eta-bot`, branch `main`.
- Coolify otomatis mendeteksi `docker-compose.yaml` — pilih tipe **Docker Compose**.

**3. Set Environment Variables** (tab **Environments/Envs** — tersimpan di Coolify,
bukan di repo; kredensial tidak ikut ke GitHub):

| Env var | Nilai | Wajib |
|---------|-------|-------|
| `E_TA_USERID` | NIM Anda | ✅ |
| `E_TA_PASSWORD` | password AIS | ✅ |
| `E_TA_ROLE` | `Mahasiswa` | ✅ |
| `TELEGRAM_BOT_TOKEN` | token dari @BotFather | notifikasi |
| `TELEGRAM_CHAT_ID` | chat ID target notifikasi | notifikasi |
| `NOTIFY_INTERVAL_MS` | `900000` (15 menit) | — |
| `TELEGRAM_WEBHOOK_SECRET` | string acak | webhook TG |
| `WA_PAIR_PHONE` | `+62xxx` (login tanpa QR) | login WA |
| `WA_ALLOWED_CHATS` | JID dipisah koma | keamanan WA |
| `WA_LOG` | `WARN` | — |

Kredensial e-TA hanya dibutuhkan service `api`; bot WA tidak butuh kredensial
e-TA (bot hanya memanggil API internal via `http://api:3001`).

**4. Klik Deploy** — Coolify membangun kedua image & menjalankan stack.
Lihat **Logs** untuk progres build dan output runtime.

### Login WhatsApp pertama kali di VPS

- QR code tampil di tab **Logs** service `wa` (render unicode). Tapi di layar
  VPS sering susah discan — **disarankan set `WA_PAIR_PHONE=+62xxx` di env**
  lalu redeploy: bot tampilkan **kode pairing 8 digit** yang dimasukkan lewat
  HP (WhatsApp → Perangkat Tertaut → Taut dengan nomor telepon saja).
- Session tersimpan di **volume `wa-session`** (dikelola Coolify) — login
  bertahan antar redeploy/restart container.

### Bot Telegram di VPS/Coolify (Polling Otomatis vs Webhook)

Secara default, saat server Node berjalan di VPS/Coolify, bot Telegram otomatis menggunakan **Long Polling** (`TELEGRAM_POLLING=true`).
- **Langsung jalan tanpa domain & SSL**: bot langsung menghubungi API Telegram secara outbound, sehingga `/start` dan semua command langsung direspon seketika setelah deploy!
- Otomatis menghapus webhook lama (jika sebelumnya pernah memakai webhook di Vercel) agar polling tidak konflik.

**Opsi Webhook (Bila punya Domain & SSL):**
Jika ingin beralih ke mode webhook murni di VPS:
1. Set env var di Coolify: `TELEGRAM_POLLING=false` dan buat `TELEGRAM_WEBHOOK_SECRET`.
2. Pasang domain HTTPS ke service `api` di Coolify.
3. Daftarkan webhook ke Telegram:
   ```bash
   npm run set-webhook -- https://api.domainanda.com/api/webhook
   ```

### Monitoring & maintenance

- **Health check**: `GET /api/health` — sudah di-set sebagai healthcheck Docker
  container `api` (interval 60s). Status tampil di halaman resource Coolify.
- **Env berubah?** Edit di tab Environments → klik **Redeploy/Restart**.
- **Ganti kode?** push ke GitHub → klik **Deploy** ulang (atau aktifkan webhook
  auto-deploy Coolify dari GitHub, kalau versi Anda memilikinya).
- **Bongkar WA login**: hapus isi volume `wa-session` dari menu
  Persistent Storage lalu deploy ulang untuk login baru.

### Catatan penting VPS

- Zona waktu: container default UTC — compose sudah set `TZ=Asia/Jakarta` di
  kedua service supaya perhitungan "jadwal hari ini" tidak bergeser.
- Scan QR lewat layar menu Logs bisa merepotkan — `WA_PAIR_PHONE` lebih praktis.
- Tambah/cari konsep di UI Coolify, bukan nama tombol: versi Coolify sering
  berganti label, tapi tab **Environments / Domains / Persistent Storage /
  Logs / Deploy** selalu ada di dalam halaman resource.

---

## Contoh Pemakaian

### Cek server hidup

```bash
curl http://localhost:3001/api/health
```

### Jadwal sidang mendatang (semua)

```bash
curl http://localhost:3001/api/jadwal/sidang
```

### Cari jadwal berdasarkan nama

```bash
curl "http://localhost:3001/api/jadwal/sidang?nama=Nizam"
```

### Cari judul skripsi berdasarkan NIM

```bash
curl "http://localhost:3001/api/judul-skripsi?nim=2209106100"
```

### Pencarian bebas kata kunci

```bash
curl "http://localhost:3001/api/judul-skripsi?q=augmented%20reality"
```

### Jadwal dengan label prodi (enrich)

```bash
curl "http://localhost:3001/api/jadwal/sidang?prodi=Informatika"
```

### Detail satu sidang (pakai token dari jadwal)

```bash
curl "http://localhost:3001/api/sidang/eyJpdiI6..."
```

### Pemakaian dari PowerShell (Windows)

```powershell
Invoke-RestMethod 'http://localhost:3001/api/jadwal/sidang?nama=Nizam'
Invoke-RestMethod 'http://localhost:3001/api/judul-skripsi?nim=2209106125'
```

### Integrasi ke bot Telegram (pola)

Bot Anda tinggal memanggil endpoint saat menerima perintah `/jadwal`:

```js
const jadwal = await fetch('http://localhost:3001/api/jadwal/sidang').then(r => r.json());
const text = jadwal.jadwal
  .map(e => `${e.tanggal} ${e.jam} — ${e.title} (${e.jenis})`)
  .join('\n');
// kirim text ke Telegram via sendMessage
```

### Integrasi ke aplikasi web (pola)

```js
// Frontend: ambil daftar judul lalu render
const res = await fetch('http://localhost:3001/api/judul-skripsi?q=ar');
const data = await res.json();
// data.identity -> profil akun
// data.daftar  -> [{ judul, nim, nama, dosen, batasWaktu }, ...]
```

---

## Contoh Respons

### `GET /api/jadwal/sidang`

```json
{
  "identity": { "nim": "2209106125", "nama": "ROIHAN NINGRAT SAPUTRA", "prodi": "Informatika" },
  "jadwal": [
    {
      "title": "Muhammad Nizam - D209",
      "tanggal": "2026-11-10",
      "jam": "11:00:00",
      "jamSelesai": "12:00",
      "url": "/mahasiswa/e-ta/informasi_skripsi/eyJpdiI6...",
      "token": "eyJpdiI6...",
      "jenis": "Pendadaran",
      "prodi": "Informatika"
    }
  ]
}
```

> Field `prodi` hanya muncul bila request memakai `enrich=true` atau `prodi=`.

### `GET /api/sidang/:token`

```json
{
  "judul": "Sistem Informasi Geografis Pendukung Keputusan Prioritas Kunjungan Mobil Perpustakaan Keliling di Kota Samarinda",
  "jadwal": {
    "ruang": "RUANG SEMINAR LABORATORY BUILDING GEDUNG BARU 1 Lt.2 No. D209",
    "kapasitas": "Kapasitas Peserta : 30 Orang",
    "tanggal": "Selasa, 10 November 2026",
    "jam": "11:00 - 12:00 Wita"
  },
  "progressBimbingan": "Lebih Dari 5 Kali",
  "jenisTA": "Pendadaran",
  "penilai": [
    { "peran": "Pembimbing 1", "nama": "Prof. Dr.. Fahrul Agus, S.Si., M.T.", "nip": "196909261994121002", "prodi": "INFORMATIKA" },
    { "peran": "Penguji 1", "nama": "Ir. Dedy Cahyadi, S.T., M.Eng.", "nip": "197908092005011013", "prodi": "INFORMATIKA" }
  ],
  "peserta": {
    "nama": "Muhammad Nizam",
    "nim": "2209106100",
    "prodi": "Informatika",
    "jumlahPeserta": "0"
  }
}
```

### `GET /api/judul-skripsi?nim=2209106100`

```json
{
  "identity": { "nim": "2209106125", "nama": "ROIHAN NINGRAT SAPUTRA", "prodi": "Informatika" },
  "daftar": [
    {
      "judul": "Sistem Informasi Geografis Pendukung Keputusan Prioritas Kunjungan Mobil Perpustakaan di Kota Samarinda",
      "nim": "2209106100",
      "nama": "Muhammad Nizam",
      "dosen": {
        "pembimbing_1": { "status": null, "nama": "Prof. Dr. Fahrul Agus, S.Si., M.T." },
        "pembimbing_2": { "status": null, "nama": null },
        "penguji_1": { "status": null, "nama": null },
        "penguji_2": { "status": null, "nama": null }
      },
      "batasWaktu": "2 bulan 24 hari"
    }
  ]
}
```

### `GET /api/profil`

```json
{
  "identity": { "nim": "2209106125", "nama": "ROIHAN NINGRAT SAPUTRA", "prodi": "Informatika" },
  "bio": {
    "nim": "2209106125",
    "nama": "ROIHAN NINGRAT SAPUTRA",
    "prodi": "INFORMATIKA",
    "angkatan": "2022",
    "tanggal_lahir": "01-01-1970",
    "gender": "",
    "no_hp": "",
    "email": "",
    "dosen_wali": "-",
    "status": "Aktif",
    "lama_kuliah": "4 Tahun 4 Bulan",
    "indek_prestasi": "1.5416666"
  },
  "nilai": [
    { "kode": "210901602W007", "nama": "Pengantar Teknologi Informasi", "sks": "2", "jenis": "Wajib", "nilai": "3", "huruf": "B" }
  ]
}
```

### `GET /api/ruang`

```json
{
  "identity": { "nim": "2209106125", "nama": "ROIHAN NINGRAT SAPUTRA", "prodi": "Informatika" },
  "ruang": [
    { "kode": "4B1", "nama": "Ruang 4B1 - Gedung..." }
  ]
}
```

### `GET /api/data/proposal`

```json
{
  "identity": { "nim": "2209106125", "nama": "ROIHAN NINGRAT SAPUTRA", "prodi": "Informatika" },
  "tables": [
    {
      "kolom": ["Kode MK", "Nama Mata Kuliah", "SKS", "Jenis MK", "Nilai", "Huruf"],
      "rows": [
        { "kode_mk": "210901602W007", "nama_mata_kuliah": "Pengantar Teknologi Informasi", "sks": "2", "jenis_mk": "Wajib", "nilai": "3", "huruf": "B" }
      ]
    }
  ]
}
```

---

## Struktur Project

```
RAE/
├── src/
│   ├── config.js          # Konfigurasi dari .env
│   └── eta/
│       ├── client.js      # Axios + cookie jar + CSRF (session)
│       ├── service.js     # Service layer (login, request, parser wiring, cache enrich)
│       ├── parsers.js     # HTML -> JSON parsers
│       └── notifier.js    # Notifikasi perubahan jadwal via Telegram (server lokal)
├── bot/
│   └── bot.js             # Handler command bot Telegram (/jadwal, dll)
├── api/
│   └── webhook.js         # Fungsi Vercel — webhook bot Telegram
├── scripts/
│   └── setWebhook.js      # Daftarkan webhook Telegram ke URL Vercel
├── vercel.json            # Konfigurasi deploy Vercel
├── Dockerfile             # Build image API Node (untuk Coolify/VPS)
├── .dockerignore
├── docker-compose.yaml    # Stack Coolify: service api + wa (volume persisten)
├── wa-bot/
│   ├── main.go            # Entry point bot WhatsApp (koneksi QR/pairing + event loop)
│   ├── commands.go        # Command engine bot WA (/jadwal, /judul, /status)
│   ├── api.go             # HTTP client menuju API e-TA
│   ├── logic_test.go      # Unit test logika tanggal & format
│   └── Dockerfile         # Multi-stage build bot Go (tanpa CGO)
├── server.js              # Express REST API server (routes + scheduler, run lokal)
├── test.js                # Skrip uji coba (login + parse)
├── .env.example           # Template konfigurasi
└── .env                   # Kredensial (JANGAN di-commit)
```

---

## Keterbatasan

- **Data terikat pada struktur HTML situs** — jika situs e-TA diubah (restrukturisasi HTML, route, CSS), parser perlu diperbarui.
- **Akses lintas-prodi dibatasi sistem** — halaman jadwal & judul **dikunci server-side** ke prodi akun yang login (mis. Informatika). Data prodi lain berada di route role-tinggi (`/admin_prodi`, `/staf_prodi`) yang **tidak bisa diakses akun Mahasiswa** (mengembalikan 404). Untuk menarik prodi lain butuh akun dengan role `DTPS`/`Staf`.
- **Jadwal ruang** hanya menampilkan dropdown ruangan (detail jadwal per ruangan dirender via AJAX di situs, belum bisa di-scrape langsung).
- **Token detail bersifat sementara** — URL `informasi_skripsi/{token}` berubah tiap request. Enrich prodi memakai cache berbasis nama peserta agar cepat pada panggilan berulang.
- **Route data (hasil/pendadaran/bimbingan/seminar)** kosong untuk akun yang belum punya rekam data tersebut.
- **Rate limiting / IP block** tidak diimplementasikan — hindari request berlebihan agar tidak diblokir server.
- Kredensial tersimpan plaintext di `.env`.

---

## Disclaimer

Project ini dibuat untuk keperluan **pribadi/edukasi**. Gunakan dengan bijak dan
hormati kebijakan penggunaan aplikasi milik Fakultas Teknik Universitas Mulawarman.