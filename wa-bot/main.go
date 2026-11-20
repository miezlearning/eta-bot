package main

// main.go — titik masuk bot WhatsApp e-TA (whatsmeow, jalur unofficial).
//
// Bot ini terhubung ke WhatsApp memakai session yang disimpan di SQLite.
// Login pertama menampilkan QR code di terminal (atau pairing code bila
// WA_PAIR_PHONE diset). Data jadwal diambil dari REST API e-TA (server Node)
// lewat EtaAPI (api.go), dan command diproses commands.go.
//
// Variabel lingkungan (lihat .env.example):
//
//	E_TA_API_BASE     base URL API e-TA (default http://localhost:3001)
//	WA_DB             path file session SQLite (default wa_session.db)
//	WA_PAIR_PHONE     nomor HP "+62..." untuk pairing code (tanpa QR)
//	WA_ALLOWED_CHATS  daftar JID chat yang boleh (pisah koma); kosong = semua
//	WA_LOG            level log: DEBUG|INFO|WARN|ERROR (default WARN)
import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	qrterminal "github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	_ "modernc.org/sqlite"
)

// State global yang dipakai bersama oleh commands.go dan api.go.
var (
	apiBase      string
	dbPath       string
	pairPhone    string
	allowedChats string
	logger       waLog.Logger
	waClient     *whatsmeow.Client
	eta          *EtaAPI
)

// getenv membaca env var dengan nilai default.
func getenv(key, fallback string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	return v
}

// loadDotEnv membaca file .env (KEY=VALUE per baris) ke process env,
// tanpa menimpa env var yang sudah di-set dari luar.
func loadDotEnv() {
	for _, path := range []string{".env", "../.env"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, value, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			key = strings.TrimSpace(key)
			value = strings.TrimSpace(value)
			if _, exists := os.LookupEnv(key); !exists {
				os.Setenv(key, value)
			}
		}
		return
	}
}

// isAllowedChat memeriksa JID chat terhadap WA_ALLOWED_CHATS
// (dipisah koma). Kosong = semua chat boleh memakai bot.
func isAllowedChat(jid string) bool {
	if allowedChats == "" {
		return true
	}
	for _, entry := range strings.Split(allowedChats, ",") {
		entry = strings.TrimSpace(entry)
		if entry != "" && entry == jid {
			return true
		}
	}
	return false
}

// teksPesan mengambil teks dari pesan (chat biasa maupun extended).
func teksPesan(m *waE2E.Message) string {
	if m == nil {
		return ""
	}
	if s := m.GetConversation(); s != "" {
		return s
	}
	return m.GetExtendedTextMessage().GetText()
}

// eventHandler menangani event koneksi & pesan dari WhatsApp.
func eventHandler(v interface{}) {
	switch evt := v.(type) {
	case *events.Connected:
		logger.Infof("terhubung ke WhatsApp")
	case *events.Disconnected:
		logger.Warnf("koneksi WhatsApp terputus")
	case *events.Message:
		chat := evt.Info.Chat
		if evt.Info.IsFromMe || !isAllowedChat(chat.String()) {
			return
		}
		if evt.IsViewOnce {
			go catatViewOnce(evt)
			return
		}
		catatPesan(evt)
		text := teksPesan(evt.Message)
		if text == "" {
			return
		}
		go handleIncoming(chat, text)
	}
}

func main() {
	loadDotEnv()

	apiBase = getenv("E_TA_API_BASE", "http://localhost:3001")
	dbPath = getenv("WA_DB", "wa_session.db")
	pairPhone = getenv("WA_PAIR_PHONE", "")
	allowedChats = getenv("WA_ALLOWED_CHATS", "")
	logLevel := strings.ToUpper(getenv("WA_LOG", "WARN"))

	logger = waLog.Stdout("Bot", logLevel, true)

	fmt.Println("+---------------------------------------------+")
	fmt.Println("| Bot WhatsApp e-TA (/jadwal) -- whatsmeow    |")
	fmt.Println("+---------------------------------------------+")
	fmt.Println("API e-TA     :", apiBase)
	fmt.Println("Session DB   :", dbPath)
	fmt.Println("Log level    :", logLevel)
	if allowedChats != "" {
		fmt.Println("Chat dibolehi:", allowedChats)
	}
	fmt.Println()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	container, err := sqlstore.New(ctx, "sqlite", "file:"+dbPath+"?_foreign_keys=on", logger)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gagal membuka database session:", err)
		os.Exit(1)
	}
	deviceStore, err := container.GetFirstDevice(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gagal membaca device session:", err)
		os.Exit(1)
	}

	eta = NewEtaAPI(apiBase)

	waClient = whatsmeow.NewClient(deviceStore, logger)
	waClient.AddEventHandler(eventHandler)

	// Login pertama: siapkan channel QR SEBELUM Connect().
	barusanLogin := deviceStore.ID == nil
	if barusanLogin {
		qrChan, err := waClient.GetQRChannel(ctx)
		if err != nil {
			fmt.Fprintln(os.Stderr, "gagal menyiapkan QR login:", err)
			os.Exit(1)
		}
		go func() {
			for item := range qrChan {
				switch item.Event {
				case "code":
					fmt.Println("Scan QR berikut lewat WhatsApp HP: Perangkat Tertaut -> Taut Perangkat:")
					qrterminal.GenerateHalfBlock(item.Code, qrterminal.L, os.Stdout)
					fmt.Println("(kode baru muncul otomatis bila kadaluarsa)")
				case "success":
					fmt.Println("Login berhasil! Session disimpan di", dbPath)
				default:
					logger.Errorf("hasil pairing: %s (%v)", item.Event, item.Error)
				}
			}
		}()
	}

	if err := waClient.Connect(); err != nil {
		fmt.Fprintln(os.Stderr, "gagal terhubung ke WhatsApp:", err)
		os.Exit(1)
	}

	// Mode pairing code (tanpa QR) bila WA_PAIR_PHONE diset.
	if barusanLogin && pairPhone != "" {
		code, err := waClient.PairPhone(ctx, pairPhone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
		if err != nil {
			fmt.Fprintln(os.Stderr, "gagal membuat pairing code:", err)
		} else {
			fmt.Println("Buka WhatsApp di HP: Perangkat Tertaut -> Taut dengan nomor telepon saja.")
			fmt.Println("Kode pairing (masukkan di HP): " + code)
		}
	}

	if barusanLogin {
		fmt.Println()
		fmt.Println("Menunggu login... (scan QR, atau masukkan pairing code bila di-set)")
	} else {
		fmt.Println()
		fmt.Println("Session ditemukan -- bot siap.")
	}
	fmt.Println("Tekan Ctrl+C untuk keluar.")
	fmt.Println()

	<-ctx.Done()
	fmt.Println("\nMenutup koneksi WhatsApp...")
	waClient.Disconnect()
}
