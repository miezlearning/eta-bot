/**
 * Daftarkan webhook Telegram ke URL Vercel.
 *
 * Penggunaan:
 *   node scripts/setWebhook.js https://<anda>.vercel.app/api/webhook
 *
 * Butuh env var: TELEGRAM_BOT_TOKEN (dan opsional TELEGRAM_WEBHOOK_SECRET).
 */
require('dotenv').config();

(async () => {
  const url = process.argv[2];
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!url) {
    console.error('Gunakan: node scripts/setWebhook.js <URL_WEBHOOK>');
    process.exit(1);
  }
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN belum diset di .env');
    process.exit(1);
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const api = 'https://api.telegram.org/bot' + token + '/setWebhook';

  try {
    const res = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secret || undefined }),
    });
    const data = await res.json();
    console.log('status:', res.status);
    console.log(JSON.stringify(data, null, 2));
    if (!data.ok) {
      console.error('Gagal set webhook. Cek token/URL.');
      process.exit(1);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();