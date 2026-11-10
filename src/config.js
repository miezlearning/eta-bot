/**
 * Konfigurasi aplikasi untuk API e-TA (e-Tugas Akhir) FT UNMUL
 */
require('dotenv').config();

module.exports = {
  /** Base URL aplikasi e-TA */
  baseUrl: process.env.BASE_URL || 'https://e-office.ft.unmul.ac.id',

  /** Kredensial login (default untuk role Mahasiswa) */
  credentials: {
    userid: process.env.E_TA_USERID || '',
    password: process.env.E_TA_PASSWORD || '',
    role: process.env.E_TA_ROLE || 'Mahasiswa',
  },

  /** Server API */
  api: {
    port: parseInt(process.env.API_PORT || '3001', 10),
  },

  /** Notifikasi Telegram (perubahan jadwal). Kosongkan botToken/chatId untuk menonaktifkan. */
  notifier: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    // Interval pengecekan perubahan jadwal (ms). Default 15 menit.
    intervalMs: parseInt(process.env.NOTIFY_INTERVAL_MS || '900000', 10),
  },

  /** Bot Telegram (webhook untuk Vercel / polling untuk VPS & Coolify). */
  bot: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    // Kunci untuk memverifikasi webhook (harus sama dengan yang dipakai saat setWebhook).
    secret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    // Polling aktif secara default di server persisten kecuali diset 'false'.
    polling: process.env.TELEGRAM_POLLING !== 'false',
  },

  /** Timeout HTTP (ms) */
  timeout: parseInt(process.env.HTTP_TIMEOUT || '15000', 10),
};