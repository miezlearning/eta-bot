/**
 * Vercel Serverless Function — webhook bot Telegram untuk e-TA.
 *
 * Telegram mengirim update (POST) ke URL webhook yang didaftarkan via
 *   POST https://api.telegram.org/bot<TOKEN>/setWebhook
 *        { url: "https://<anda>.vercel.app/api/webhook", secret_token: "..." }
 *
 * Fungsi ini menerima update, memverifikasi secret header (X-Telegram-Bot-Api-Secret-Token),
 * lalu memanggil handler bot dan menjawab 200 secepat mungkin.
 */

const { handleUpdate } = require('../bot/bot');
const config = require('../src/config');

module.exports = async function handler(req, res) {
  // Hanya terima POST.
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  // Verifikasi secret webhook (jika di-set) untuk keamanan.
  const secret = config.bot.secret;
  if (secret) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (headerSecret !== secret) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
  }

  const update = req.body;

  // Proses update bot (login e-TA + kirim balasan ke Telegram), lalu balas 200.
  // Dengan enrich=false, satu command /jadwal hanya ~1-2 request e-TA, masih dalam
  // batas timeout Vercel (10s default). Jika melebihi, Vercel akan timeout & retry.
  try {
    await handleUpdate(update);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook] error:', e);
    res.status(200).json({ ok: true, processed: false });
  }
};