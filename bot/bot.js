/**
 * Handler bot Telegram untuk e-TA.
 *
 * Menangani command:
 *   /start, /help, /menu -> bantuan perintah
 *   /jadwal              -> jadwal sidang hari ini
 *   /jadwal besok        -> jadwal sidang besok
 *   /jadwal <hari>       -> jadwal hari tertentu (senin, selasa, dll)
 *   /jadwal <tanggal>    -> jadwal tanggal tertentu (contoh: 2026-11-12)
 *   /jadwal semua        -> semua jadwal (bisa banyak)
 *   /judul <kata kunci>  -> pencarian judul skripsi
 *   /status              -> status koneksi e-TA
 *
 * Mendukung mode Long Polling (otomatis di VPS/Coolify/lokal)
 * dan Webhook (Vercel serverless atau reverse proxy VPS).
 */

const config = require('../src/config');

// ---------------------------------------------------------------------------
// Lazy service load: module service (cheerio/axios/tough-cookie) hanya dimuat
// saat ada command yang butuh data e-TA. /start & /help tetap instan walau
// cold start (Vercel).
let _svc = null;
function getSvc() {
  if (!_svc) {
    const { EtaService } = require('../src/eta/service');
    _svc = new EtaService(config.credentials);
  }
  return _svc;
}

// ---------------------------------------------------------------------------
// Dedup update: Telegram mengirim ulang update yang sama bila webhook tidak
// segera di-ack; tanpa filter ini antrean menumpuk dan SEMUA command terasa
// lambat. Set menjaga urutan insertion, jadi penuh tinggal buang yang terlama.
const seenUpdates = new Set();
function isDuplicate(updateId) {
  if (seenUpdates.has(updateId)) return true;
  seenUpdates.add(updateId);
  if (seenUpdates.size > 1000) {
    for (const id of seenUpdates) {
      seenUpdates.delete(id);
      if (seenUpdates.size <= 500) break;
    }
  }
  return false;
}

// Nama hari Indonesia -> indeks JS (0=Minggu).
const NAMA_HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const HARI_MAP = {
  minggu: 0, ahad: 0,
  senin: 1, seninmalam: 1,
  selasa: 2,
  rabu: 3, rebo: 3,
  kamis: 4, kamismalam: 4,
  jumat: 5, 'jum\'at': 5, jumaat: 5,
  sabtu: 6,
};

/** Kalau parse_mode Markdown ditolak Telegram (judul mengandung _ * [ dll),
 *  fallback tanpa parse_mode supaya user tetap dapat balasan. */
async function sendMessage(chatId, text) {
  const token = config.bot.botToken;
  if (!token) {
    console.error('[bot] sendMessage dibatalkan: TELEGRAM_BOT_TOKEN kosong di environment!');
    return false;
  }
  if (!text) return false;
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage';

  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
  const bodyPlain = JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });

  for (const payload of [body, bodyPlain]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (res.ok) return true;
      const detail = await res.text().catch(() => '');
      console.error('[bot] sendMessage gagal (' + res.status + '):', detail.slice(0, 200));
    } catch (e) {
      console.error('[bot] sendMessage network error:', e.message);
      return false;
    }
  }
  return false;
}

/** Indikator "typing..." supaya user tahu bot sedang memproses. */
async function sendTyping(chatId) {
  const token = config.bot.botToken;
  if (!token) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendChatAction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch (_) {
    // Best-effort saja; gagal typing tidak boleh mempengaruhi jawaban.
  }
}

/** Escape karakter Markdown agar parse_mode tidak gagal pada judul e-TA. */
function escapeMd(s) {
  return String(s || '').replace(/([_*\[`])/g, '\\$1');
}

/** Cari jadwal untuk tanggal tertentu (format YYYY-MM-DD) dari daftar event. */
function jadwalTanggal(jadwal, tanggal) {
  return jadwal.filter((e) => e.tanggal === tanggal);
}

/** Konversi input "besok" / "senin" / tanggal menjadi format YYYY-MM-DD. */
function parseTarget(args) {
  const now = new Date();

  // "besok" / "lusa"
  if (/besok|lusa/i.test(args)) {
    const d = new Date(now);
    d.setDate(d.getDate() + (/lusa/i.test(args) ? 2 : 1));
    return d.toISOString().slice(0, 10);
  }

  // "hari ini" / "sekarang"
  if (/hari.?ini|sekarang/i.test(args)) {
    return now.toISOString().slice(0, 10);
  }

  // tanggal eksplisit YYYY-MM-DD
  const tglMatch = args.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (tglMatch) {
    return tglMatch[0];
  }

  // tanggal dalam format DD/MM/YYYY atau DD-MM-YYYY
  const dmy = args.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return yyyy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  }

  // nama hari Indonesia (contoh: "senin", "kamis")
  const hariKey = args.toLowerCase().replace(/[^a-z']/g, '');
  const hariIdx = HARI_MAP[hariKey];
  if (hariIdx !== undefined) {
    // cari tanggal terdekat dengan hari tersebut (hari yang sama -> minggu depan)
    const d = new Date(now);
    let diff = (hariIdx - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  return null;
}

/** Bangun teks pesan daftar jadwal untuk satu tanggal. */
function formatJadwalTanggal(jadwal, tanggal, namaHari) {
  const events = jadwalTanggal(jadwal, tanggal);
  const header = '*' + namaHari + ', ' + tanggal + '*';
  if (!events.length) {
    return header + '\n\nTidak ada jadwal sidang pada tanggal ini.';
  }
  const lines = events.map((e, i) => {
    const jam = typeof e.jam === 'string' ? e.jam.slice(0, 5) : e.jam;
    return (i + 1) + '. ' + jam + ' — ' + escapeMd(e.title) + ' (_' + escapeMd(e.jenis) + '_)';
  });
  return header + '\n' + lines.join('\n');
}

/** Handler utama untuk satu update Telegram. */
async function handleUpdate(update) {
  // Hanya tangani pesan teks.
  const msg = update && update.message;
  if (!msg || !msg.text) return;

  // Skip update yang sudah pernah diproses (retry Telegram).
  if (update.update_id !== undefined && isDuplicate(update.update_id)) return;

  const chatId = msg.chat.id;
  const rawText = msg.text.trim();

  // Bersihkan command dari suffix username bot (/start@nama_bot -> /start)
  const text = rawText.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+bot\b/i, '$1');
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  // Di grup, abaikan chat biasa yang bukan command.
  if (!text.startsWith('/')) {
    if (isGroup) return;
    await sendMessage(chatId, helpText());
    return;
  }

  const senderName = msg.from ? (msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'user')) : 'unknown';
  console.log(`[bot] Update #${update.update_id || '-'}: command dari ${chatId} (${senderName}): "${text}"`);

  // /start, /help, /menu
  if (/^\/(start|help|menu)$/i.test(text)) {
    await sendMessage(chatId, helpText());
    return;
  }

  // /status
  if (/^\/status$/i.test(text)) {
    await sendTyping(chatId);
    try {
      const svc = getSvc();
      const statusText =
        '📊 *Status API & Bot e-TA*\n\n' +
        '• Status: *Online*\n' +
        `• Session e-TA: *${svc.connected ? 'Terhubung' : 'Belum aktif (login saat request)'}*\n` +
        (svc.lastLoginAt ? `• Login terakhir: \`${svc.lastLoginAt}\`\n` : '') +
        `• Mode Telegram: *${process.env.TELEGRAM_POLLING === 'false' ? 'Webhook' : 'Polling'}*`;
      await sendMessage(chatId, statusText);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal cek status: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // /judul <kata kunci>
  const judulMatch = text.match(/^\/judul(?:\s+([\s\S]+))?$/i);
  if (judulMatch) {
    await sendTyping(chatId);
    const query = (judulMatch[1] || '').trim();
    try {
      const svc = getSvc();
      await svc.connect();
      const res = await svc.judulSkripsi({ q: query });
      const daftar = res.daftar || [];
      if (!daftar.length) {
        await sendMessage(chatId, `Tidak ditemukan judul skripsi${query ? ` untuk kata kunci: *${escapeMd(query)}*` : ''}.`);
        return;
      }
      const maks = 10;
      let reply = `📚 *Daftar Judul Skripsi*${query ? ` (filter: ${escapeMd(query)})` : ''}\nTotal ditemukan: *${daftar.length}*\n\n`;
      const items = daftar.slice(0, maks).map((item, idx) => {
        return `${idx + 1}. *${escapeMd(item.judul)}*\n   👤 ${escapeMd(item.nama)} (${escapeMd(item.nim)})`;
      });
      reply += items.join('\n\n');
      if (daftar.length > maks) {
        reply += `\n\n_...dan ${daftar.length - maks} judul lainnya. Pertajam kata kunci untuk hasil lebih spesifik._`;
      }
      await sendMessage(chatId, reply);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mencari judul: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // /jadwal dengan argumen.
  const jadwalMatch = text.match(/^\/(jadwal|jadwal_skripsi|skripsi)(?:\s+([\s\S]+))?$/i);
  if (!jadwalMatch) {
    await sendMessage(chatId, 'Perintah tidak dikenali.\n\n' + helpText());
    return;
  }

  // Feedback cepat: "typing..." sebelum proses e-TA.
  await sendTyping(chatId);

  const args = (jadwalMatch[2] || '').trim();

  try {
    const svc = getSvc();
    // Pastikan login & ambil data jadwal.
    // enrich=false -> hanya 1 request (cepat). Field prodi tidak dipakai bot.
    await svc.connect();
    const data = await svc.jadwalSkripsi({ enrich: false, useCache: true });

    const today = new Date();
    const namaHari = NAMA_HARI[today.getDay()];

    // "/jadwal" tanpa argumen -> hari ini.
    if (!args) {
      const tgl = today.toISOString().slice(0, 10);
      const replyText = formatJadwalTanggal(data.jadwal, tgl, namaHari);
      await sendMessage(chatId, replyText);
      return;
    }

    // "/jadwal semua" -> ringkasan total.
    if (/^semua|all$/i.test(args)) {
      const total = data.jadwal.length;
      await sendMessage(
        chatId,
        '📊 Total *' + total + '* jadwal sidang.\n\n' +
        'Pakai `/jadwal <hari|tanggal>` untuk melihat per hari.\n' +
        'Contoh: `/jadwal besok`, `/jadwal kamis`, `/jadwal 2026-11-12`'
      );
      return;
    }

    // "/jadwal <target>" -> tanggal spesifik.
    const target = parseTarget(args);
    if (!target) {
      await sendMessage(chatId, 'Format tidak dikenali. Contoh:\n`/jadwal`\n`/jadwal besok`\n`/jadwal kamis`\n`/jadwal 2026-11-12`');
      return;
    }
    const tglDate = new Date(target + 'T00:00:00');
    const namaTarget = NAMA_HARI[tglDate.getDay()];
    const replyText = formatJadwalTanggal(data.jadwal, target, namaTarget);
    await sendMessage(chatId, replyText);
  } catch (e) {
    await sendMessage(chatId, '⚠️ Gagal mengambil jadwal: ' + (e.message || 'kesalahan tidak dikenal'));
  }
}

/** Teks bantuan command. */
function helpText() {
  return (
    '📋 *Bot e-TA FT Unmul*\n\n' +
    'Perintah Jadwal Sidang:\n' +
    '`/jadwal` — jadwal sidang hari ini\n' +
    '`/jadwal besok` — jadwal besok\n' +
    '`/jadwal lusa` — jadwal lusa\n' +
    '`/jadwal senin` — jadwal hari tertentu terdekat\n' +
    '`/jadwal 2026-11-12` — jadwal tanggal tertentu\n' +
    '`/jadwal semua` — total semua jadwal\n\n' +
    'Perintah Lainnya:\n' +
    '`/judul <kata kunci>` — cari judul skripsi\n' +
    '`/status` — cek status koneksi e-TA\n' +
    '`/help` — panduan bantuan ini'
  );
}

let _pollingRunning = false;

/**
 * Jalankan long-polling Telegram.
 * Dipakai saat berjalan sebagai server persisten (VPS/Coolify/lokal),
 * sehingga bot langsung merespons tanpa butuh domain, SSL, ataupun webhook.
 */
async function startPolling() {
  const token = config.bot.botToken;
  if (!token) {
    console.log('[bot] TELEGRAM_BOT_TOKEN belum diatur. Bot Telegram polling tidak aktif.');
    return;
  }

  if (process.env.TELEGRAM_POLLING === 'false') {
    console.log('[bot] TELEGRAM_POLLING=false. Menggunakan mode webhook di /api/webhook.');
    return;
  }

  if (_pollingRunning) return;
  _pollingRunning = true;

  // Bersihkan webhook yang mungkin masih aktif agar getUpdates tidak menghasilkan error 409 Conflict.
  try {
    const delRes = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
    });
    const delData = await delRes.json().catch(() => ({}));
    if (delData.ok) {
      console.log('[bot] Webhook dibersihkan, beralih ke mode Telegram polling.');
    }
  } catch (e) {
    console.warn('[bot] Gagal membersihkan webhook lama:', e.message);
  }

  console.log('[bot] Telegram long-polling aktif, siap menerima perintah (/start, /jadwal, dll)!');

  let offset = 0;
  (async () => {
    while (_pollingRunning) {
      try {
        const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=25`;
        const res = await fetch(url, { signal: AbortSignal.timeout(35000) });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          console.error(`[bot] getUpdates gagal (${res.status}): ${detail.slice(0, 150)}`);
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }

        const data = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            offset = update.update_id + 1;
            handleUpdate(update).catch((e) => {
              console.error('[bot] Error memproses update:', e.message);
            });
          }
        }
      } catch (e) {
        if (e.name !== 'TimeoutError' && !e.message?.includes('aborted')) {
          console.error('[bot] Polling network error:', e.message);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
}

function stopPolling() {
  _pollingRunning = false;
}

module.exports = {
  handleUpdate,
  startPolling,
  stopPolling,
  parseTarget,
  formatJadwalTanggal,
  jadwalTanggal,
  sendMessage,
  helpText,
};
