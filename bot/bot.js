/**
 * Handler bot Telegram untuk e-TA.
 *
 * Menangani command /jadwal dengan sub-kategori:
 *   /jadwal            -> jadwal sidang hari ini
 *   /jadwal besok      -> jadwal sidang besok
 *   /jadwal <hari>     -> jadwal hari tertentu (senin, selasa, dll)
 *   /jadwal <tanggal>  -> jadwal tanggal tertentu (contoh: 2026-11-12)
 *   /jadwal semua      -> semua jadwal (bisa banyak)
 *
 * Bot ini dipanggil via webhook (Vercel serverless). Menerima update Telegram
 * dan mengembalikan pesan reply. Tidak ada polling.
 *
 * Penggunaan:
 *   const { handleUpdate } = require('./bot');
 *   // di dalam fungsi webhook:
 *   await handleUpdate(update);
 */

const config = require('../src/config');
const { EtaService } = require('../src/eta/service');

// Instance service global (reuse session selama function hidup di Vercel).
const svc = new EtaService(config.credentials);

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

/** Helper: kirim pesan ke Telegram via Bot API. */
async function sendMessage(chatId, text) {
  const token = config.bot.botToken;
  if (!token) return;
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch (e) {
    console.error('[bot] gagal kirim:', e.message);
    return false;
  }
}

/** Cari jadwal untuk tanggal tertentu (format YYYY-MM-DD) dari daftar event. */
function jadwalTanggal(jadwal, tanggal) {
  return jadwal.filter((e) => e.tanggal === tanggal);
}

/** Konversi input "besok" / "senin" / tanggal menjadi format YYYY-MM-DD. */
function parseTarget(args) {
  const now = new Date();

  // "besok" -> besok
  if (/besok|lusa/i.test(args)) {
    const d = new Date(now);
    d.setDate(d.getDate() + (/lusa/i.test(args) ? 2 : 1));
    return d.toISOString().slice(0, 10);
  }

  // "hari ini" / "sekarang"
  if (/hari.?ini|sekarang|sekarang/i.test(args)) {
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
    // cari tanggal terdekat dengan hari tersebut (hari ini atau mendatang)
    const d = new Date(now);
    let diff = (hariIdx - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7; // hari yang sama hari ini? pakai minggu depan agar jelas
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
    return (i + 1) + '. ' + e.jam + ' — ' + e.title + ' (_' + e.jenis + '_)';
  });
  return header + '\n' + lines.join('\n');
}

/** Handler utama untuk satu update Telegram. */
async function handleUpdate(update) {
  // Hanya tangani pesan teks.
  const msg = update && update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Command /jadwal dengan argumen.
  const jadwalMatch = text.match(/^\/(jadwal|jadwal_skripsi|skripsi)(?:\s+(.*))?$/i);
  if (!jadwalMatch) {
    await sendMessage(chatId, helpText());
    return;
  }

  const args = (jadwalMatch[2] || '').trim();

  try {
    // Pastikan login & ambil data jadwal.
    // enrich=false -> hanya 1 request (cepat). Bot tidak menampilkan prodi per-event.
    await svc.connect();
    const data = await svc.jadwalSkripsi({ enrich: false, useCache: true });

    // Format nama hari Indonesia untuk tanggal.
    const today = new Date();
    const namaHari = NAMA_HARI[today.getDay()];

    // "/jadwal" tanpa argumen -> hari ini.
    if (!args) {
      const tgl = today.toISOString().slice(0, 10);
      const text = formatJadwalTanggal(data.jadwal, tgl, namaHari);
      await sendMessage(chatId, text);
      return;
    }

    // "/jadwal semua" -> tampilkan semua (jumlah).
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
    const text = formatJadwalTanggal(data.jadwal, target, namaTarget);
    await sendMessage(chatId, text);
  } catch (e) {
    await sendMessage(chatId, '⚠️ Gagal mengambil jadwal: ' + (e.message || 'kesalahan tidak dikenal'));
  }
}

/** Teks bantuan command. */
function helpText() {
  return (
    '📋 *e-TA Jadwal Sidang*\n\n' +
    'Command:\n' +
    '`/jadwal` — jadwal hari ini\n' +
    '`/jadwal besok` — jadwal besok\n' +
    '`/jadwal lusa` — jadwal lusa\n' +
    '`/jadwal senin` — jadwal hari Senin terdekat (minggu/besok)\n' +
    '`/jadwal 2026-11-12` — jadwal tanggal tertentu\n' +
    '`/jadwal semua` — total semua jadwal\n' +
    '`/start`, `/help` — bantuan ini'
  );
}

module.exports = { handleUpdate, parseTarget, formatJadwalTanggal, jadwalTanggal };