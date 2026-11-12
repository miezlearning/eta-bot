/**
 * Handler bot Telegram untuk e-TA.
 *
 * Menangani command:
 *   /start, /help, /menu    -> bantuan perintah lengkap
 *   /mhs <nama/NIM>         -> info mahasiswa: judul, dosen pembimbing & penguji, riwayat sempro/semhas/pdd
 *   /judul <kata kunci>     -> pencarian judul skripsi & dosen penilai
 *   /detail <token/NIM>     -> detail lengkap ruang, kapasitas, peserta, & tim penilai sidang
 *   /statistik [bulan/thn]  -> statistik berapa orang sempro, semhas, & pendadaran
 *   /jadwal                 -> jadwal sidang hari ini / besok / hari / tanggal
 *   /status                 -> status koneksi API e-TA
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

const BULAN_MAP = {
  januari: '01', jan: '01',
  februari: '02', feb: '02',
  maret: '03', mar: '03',
  april: '04', apr: '04',
  mei: '05',
  juni: '06', jun: '06',
  juli: '07', jul: '07',
  agustus: '08', agu: '08', agt: '08',
  september: '09', sep: '09',
  oktober: '10', okt: '10',
  november: '11', nov: '11',
  desember: '12', des: '12',
};

const NAMA_BULAN = [
  '', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/** Kirim pesan Telegram (dengan opsi inline keyboard markup). */
async function sendMessage(chatId, text, replyMarkup = null) {
  const token = config.bot.botToken;
  if (!token) {
    console.error('[bot] sendMessage dibatalkan: TELEGRAM_BOT_TOKEN kosong di environment!');
    return false;
  }
  if (!text) return false;
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage';

  const bodyObj = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };
  if (replyMarkup) bodyObj.reply_markup = replyMarkup;

  const bodyPlainObj = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (replyMarkup) bodyPlainObj.reply_markup = replyMarkup;

  for (const payload of [JSON.stringify(bodyObj), JSON.stringify(bodyPlainObj)]) {
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

/** Edit teks pesan yang sudah ada secara in-place (berguna untuk pagination). */
async function editMessageText(chatId, messageId, text, replyMarkup = null) {
  const token = config.bot.botToken;
  if (!token || !chatId || !messageId) return false;
  const url = 'https://api.telegram.org/bot' + token + '/editMessageText';

  const bodyObj = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };
  if (replyMarkup) bodyObj.reply_markup = replyMarkup;

  const bodyPlainObj = {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  };
  if (replyMarkup) bodyPlainObj.reply_markup = replyMarkup;

  for (const payload of [JSON.stringify(bodyObj), JSON.stringify(bodyPlainObj)]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (res.ok) return true;
    } catch (_) {}
  }
  return false;
}

/** Jawab callback query dari tombol inline agar icon loading berhenti. */
async function answerCallbackQuery(callbackQueryId, text = '') {
  const token = config.bot.botToken;
  if (!token || !callbackQueryId) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (_) {}
}

/** Potong array sesuai halaman dan ukuran halaman. */
function paginateArray(items, page = 1, pageSize = 6) {
  const total = (items || []).length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.max(1, Math.min(Number(page) || 1, totalPages));
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, total);
  const pageItems = (items || []).slice(startIndex, endIndex);

  return {
    total,
    totalPages,
    currentPage,
    pageSize,
    startIndex,
    endIndex,
    items: pageItems,
  };
}

/** Buat keyboard pagination inline (Telegram) yang ramah batas 64 byte callback_data. */
function buildPaginationKeyboard(type, query, currentPage, totalPages) {
  if (totalPages <= 1) return null;

  const buttons = [];
  const qClean = encodeURIComponent(String(query || '').slice(0, 25));

  if (currentPage > 1) {
    buttons.push({
      text: '⬅️ Sebelumnya',
      callback_data: `pg:${type}:${qClean}:${currentPage - 1}`,
    });
  }

  buttons.push({
    text: `📄 ${currentPage}/${totalPages}`,
    callback_data: 'noop',
  });

  if (currentPage < totalPages) {
    buttons.push({
      text: 'Selanjutnya ➡️',
      callback_data: `pg:${type}:${qClean}:${currentPage + 1}`,
    });
  }

  return {
    inline_keyboard: [buttons],
  };
}

/** Pisahkan argumen teks dengan nomor halaman opsional di bagian akhir (contoh: "D209 2" -> q: "D209", page: 2). */
function parseArgAndPage(raw) {
  const s = String(raw || '').trim();
  if (!s) return { q: '', page: 1 };
  // Hanya ambil jika kata terakhir berupa 1-3 digit angka
  const match = s.match(/^(.*?)(?:\s+(\d{1,3}))$/);
  if (match && match[1].trim()) {
    return { q: match[1].trim(), page: parseInt(match[2], 10) || 1 };
  }
  return { q: s, page: 1 };
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

/** Format tanggal YYYY-MM-DD ke format Indonesia (contoh: 23 November 2026). */
function formatTanggalIndo(tglStr) {
  if (!tglStr) return 'Belum terjadwal';
  const parts = tglStr.split('-');
  if (parts.length !== 3) return tglStr;
  const thn = parts[0];
  const blnIdx = parseInt(parts[1], 10);
  const tgl = parseInt(parts[2], 10);
  const namaB = NAMA_BULAN[blnIdx] || parts[1];
  return `${tgl} ${namaB} ${thn}`;
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

  // "kemarin"
  if (/kemarin/i.test(args)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
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
    const d = new Date(now);
    let diff = (hariIdx - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  return null;
}

/** Parse input periode bulan/tahun untuk command /statistik. */
function parseBulanTahun(input, now = new Date()) {
  const s = String(input || '').trim().toLowerCase();
  if (!s || s === 'ini' || s === 'sekarang' || s === 'bulan ini') {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return { type: 'bulan', val: `${y}-${m}`, label: `${NAMA_BULAN[now.getMonth() + 1]} ${y}` };
  }

  if (s === 'semua' || s === 'all' || s === 'total') {
    return { type: 'semua', label: 'Seluruh Periode' };
  }

  // YYYY-MM
  const ymMatch = s.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (ymMatch) {
    const y = ymMatch[1];
    const m = String(parseInt(ymMatch[2], 10)).padStart(2, '0');
    return { type: 'bulan', val: `${y}-${m}`, label: `${NAMA_BULAN[parseInt(m, 10)]} ${y}` };
  }

  // MM-YYYY atau MM/YYYY
  const myMatch = s.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (myMatch) {
    const y = myMatch[2];
    const m = String(parseInt(myMatch[1], 10)).padStart(2, '0');
    return { type: 'bulan', val: `${y}-${m}`, label: `${NAMA_BULAN[parseInt(m, 10)]} ${y}` };
  }

  // YYYY (tahun saja)
  if (/^\d{4}$/.test(s)) {
    return { type: 'tahun', val: s, label: `Tahun ${s}` };
  }

  // Nama bulan bahasa Indonesia (contoh: "oktober", "november 2026")
  for (const [namaB, kodeB] of Object.entries(BULAN_MAP)) {
    if (s.includes(namaB)) {
      const yearMatch = s.match(/\b(20\d{2})\b/);
      const y = yearMatch ? yearMatch[1] : String(now.getFullYear());
      return { type: 'bulan', val: `${y}-${kodeB}`, label: `${NAMA_BULAN[parseInt(kodeB, 10)]} ${y}` };
    }
  }

  // Angka bulan 1 - 12
  const mNum = parseInt(s, 10);
  if (!isNaN(mNum) && mNum >= 1 && mNum <= 12) {
    const y = now.getFullYear();
    const m = String(mNum).padStart(2, '0');
    return { type: 'bulan', val: `${y}-${m}`, label: `${NAMA_BULAN[mNum]} ${y}` };
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
  return header + '\n\n' + lines.join('\n');
}

/** Format profil detail satu mahasiswa lengkap dengan dosen & riwayat sidang. */
function formatProfilMahasiswa(mhs) {
  let text = '🎓 *Data Mahasiswa & Tugas Akhir e-TA*\n\n';
  text += `👤 *Nama*: *${escapeMd(mhs.nama)}*\n`;
  text += `🆔 *NIM*: \`${mhs.nim || '-'}\`\n`;
  if (mhs.prodi) text += `🏛️ *Prodi*: ${escapeMd(mhs.prodi)}\n`;
  if (mhs.batasWaktu) text += `⏳ *Status Batas*: _${escapeMd(mhs.batasWaktu)}_\n`;
  text += '\n';

  text += '📖 *Judul Tugas Akhir*:\n';
  text += `_${escapeMd(mhs.judul || 'Belum terdaftar di sistem')}_\n\n`;

  text += '👥 *Dosen Pembimbing & Penguji*:\n';
  const dosen = mhs.dosen || {};
  const dosenEntries = [];

  const roles = [
    ['pembimbing_1', 'Pembimbing 1'],
    ['pembimbing_2', 'Pembimbing 2'],
    ['penguji_1', 'Penguji 1'],
    ['penguji_2', 'Penguji 2'],
    ['pembimbing_3', 'Pembimbing 3'],
  ];

  roles.forEach(([key, label]) => {
    if (dosen[key] && dosen[key].nama) {
      const d = dosen[key];
      const statusBadge = d.status ? ` \`[${escapeMd(d.status)}]\`` : '';
      dosenEntries.push(`• *${label}*: ${escapeMd(d.nama)}${statusBadge}`);
    }
  });

  if (dosenEntries.length > 0) {
    text += dosenEntries.join('\n') + '\n\n';
  } else {
    text += '• _Belum ada data penilai terdaftar_\n\n';
  }

  text += '📅 *Riwayat & Timeline Sidang*:\n';
  const sidangList = mhs.riwayatSidang || [];
  if (sidangList.length > 0) {
    const stageIcons = {
      'Seminar Proposal': '📝',
      'Seminar Hasil': '📋',
      'Pendadaran': '🎓',
    };

    sidangList.forEach((s) => {
      const icon = stageIcons[s.jenis] || '📌';
      text += `${icon} *${escapeMd(s.jenis)}*:\n`;
      if (s.tanggal) {
        const jam = s.jam ? (s.jamSelesai ? `${s.jam.slice(0, 5)} - ${s.jamSelesai}` : s.jam.slice(0, 5)) : '';
        text += `  🗓️ ${formatTanggalIndo(s.tanggal)}${jam ? ` | ⏰ ${jam} WITA` : ''}\n`;
        text += `  📍 Ruang: ${escapeMd(s.ruang || 'Menunggu penetapan ruang')}\n`;
      } else {
        text += '  🗓️ _Menunggu jadwal / verifikasi antrean_\n';
      }
    });
  } else {
    text += '• _Belum memiliki jadwal sidang terdaftar (Sempro, Semhas, atau Pendadaran)_\n';
  }

  return text;
}

/** Render halaman jadwal seminar e-room (dengan pagination). */
async function renderEroomPage(chatId, messageId, q, page = 1) {
  const svc = getSvc();
  await svc.connect();
  const res = await svc.jadwalSeminarEroom({ q });
  const all = res.jadwal || [];
  if (!all.length) {
    const emptyText = `ℹ️ Tidak ada jadwal seminar e-room ditemukan${q ? ` untuk "*${escapeMd(q)}*"` : ''}.`;
    if (messageId) await editMessageText(chatId, messageId, emptyText);
    else await sendMessage(chatId, emptyText);
    return;
  }

  const p = paginateArray(all, page, 6);
  let reply = `🏢 *Jadwal Seminar e-Room FT Unmul*${q ? ` — Pencarian "*${escapeMd(q)}*"` : ''}\n`;
  reply += `Total: *${p.total}* agenda | Halaman *${p.currentPage}* dari *${p.totalPages}*\n\n`;

  p.items.forEach((j, i) => {
    const num = p.startIndex + i + 1;
    const tgl = j.tanggal ? formatTanggalIndo(j.tanggal) : 'Belum terjadwal';
    const jam = j.jam ? ` (${j.jam}${j.jamSelesai ? '-' + j.jamSelesai : ''} WITA)` : '';
    reply += `${num}. *${escapeMd(j.nama)}*\n`;
    reply += `   📍 *Ruang*: \`${escapeMd(j.ruang)}\` | *Tahap*: ${escapeMd(j.jenis)}\n`;
    reply += `   🗓️ ${tgl}${jam}\n`;
  });

  if (p.totalPages > 1) {
    reply += `\n💡 _Gunakan tombol di bawah atau ketik:_ \`/eroom ${q ? q + ' ' : ''}${p.currentPage < p.totalPages ? p.currentPage + 1 : 1}\`\n`;
  }
  reply += '👉 _Ketik \`/detail <nama/NIM>\` untuk melihat dosen & audiens hadir._';

  const kb = buildPaginationKeyboard('erm', q, p.currentPage, p.totalPages);
  if (messageId) {
    await editMessageText(chatId, messageId, reply, kb);
  } else {
    await sendMessage(chatId, reply, kb);
  }
}

/** Render halaman daftar judul skripsi (dengan pagination). */
async function renderJudulPage(chatId, messageId, query, page = 1) {
  const svc = getSvc();
  await svc.connect();
  const res = await svc.judulSkripsi({ q: query });
  const daftar = res.daftar || [];

  if (!daftar.length) {
    const emptyText = `Tidak ditemukan judul skripsi untuk kata kunci: *${escapeMd(query)}*.`;
    if (messageId) await editMessageText(chatId, messageId, emptyText);
    else await sendMessage(chatId, emptyText);
    return;
  }

  const p = paginateArray(daftar, page, 5);
  let reply = `📚 *Daftar Judul Skripsi* (filter: _${escapeMd(query)}_)\n`;
  reply += `Total: *${p.total}* judul | Halaman *${p.currentPage}* dari *${p.totalPages}*\n\n`;

  p.items.forEach((item, idx) => {
    const num = p.startIndex + idx + 1;
    reply += `${num}. *${escapeMd(item.judul)}*\n`;
    reply += `   👤 *${escapeMd(item.nama)}* (\`${item.nim || '-'}\`)\n`;

    const dosen = item.dosen || {};
    const p1 = dosen.pembimbing_1?.nama ? `P1: ${dosen.pembimbing_1.nama}` : '';
    const p2 = dosen.pembimbing_2?.nama ? `P2: ${dosen.pembimbing_2.nama}` : '';
    const pemb = [p1, p2].filter(Boolean).join(' | ');
    if (pemb) reply += `   👥 ${escapeMd(pemb)}\n`;
    if (item.batasWaktu) reply += `   ⏳ Status: _${escapeMd(item.batasWaktu)}_\n`;
    reply += '\n';
  });

  if (p.totalPages > 1) {
    reply += `💡 _Gunakan tombol di bawah atau ketik:_ \`/judul ${query} ${p.currentPage < p.totalPages ? p.currentPage + 1 : 1}\`\n`;
  }
  reply += '👉 _Ketik \`/mhs <NIM>\` untuk melihat detail riwayat sidang._';

  const kb = buildPaginationKeyboard('jdl', query, p.currentPage, p.totalPages);
  if (messageId) {
    await editMessageText(chatId, messageId, reply, kb);
  } else {
    await sendMessage(chatId, reply, kb);
  }
}

/** Render halaman daftar mahasiswa hasil pencarian nama (dengan pagination). */
async function renderMahasiswaListPage(chatId, messageId, query, page = 1) {
  const svc = getSvc();
  await svc.connect();
  const result = await svc.cariMahasiswa(query);
  const matches = result.matches || [];

  if (!matches.length) {
    const emptyText = `❌ Mahasiswa dengan kata kunci "*${escapeMd(query)}*" tidak ditemukan di sistem.\n\nTips: Pastikan ejaan nama benar atau gunakan NIM lengkap.`;
    if (messageId) await editMessageText(chatId, messageId, emptyText);
    else await sendMessage(chatId, emptyText);
    return;
  }

  // Jika hanya 1 hasil dan bukan navigasi callback: tampilkan profil detail langsung
  if (matches.length === 1 && !messageId) {
    const textReply = formatProfilMahasiswa(matches[0]);
    await sendMessage(chatId, textReply);
    return;
  }

  const p = paginateArray(matches, page, 5);
  let reply = `🔍 *Pencarian Mahasiswa* (kata kunci: "*${escapeMd(query)}*")\n`;
  reply += `Total: *${p.total}* orang | Halaman *${p.currentPage}* dari *${p.totalPages}*\n\n`;

  p.items.forEach((m, idx) => {
    const num = p.startIndex + idx + 1;
    const tahap = (m.riwayatSidang || []).map((s) => s.jenis.replace('Seminar ', '')).join(', ') || 'Belum ada jadwal';
    reply += `${num}. *${escapeMd(m.nama)}* (\`${m.nim || '-'}\`)\n`;
    if (m.prodi) reply += `   🏛️ Prodi: ${escapeMd(m.prodi)}\n`;
    if (m.judul) {
      const cutJudul = m.judul.length > 70 ? m.judul.slice(0, 70) + '...' : m.judul;
      reply += `   📖 _${escapeMd(cutJudul)}_\n`;
    }
    reply += `   📅 Sidang: ${escapeMd(tahap)}\n\n`;
  });

  if (p.totalPages > 1) {
    reply += `💡 _Gunakan tombol di bawah atau ketik:_ \`/mhs ${query} ${p.currentPage < p.totalPages ? p.currentPage + 1 : 1}\`\n`;
  }
  reply += '👉 *Ketik:* `/mhs <NIM>` untuk melihat detail salah satu mahasiswa di atas.';

  const kb = buildPaginationKeyboard('mhs', query, p.currentPage, p.totalPages);
  if (messageId) {
    await editMessageText(chatId, messageId, reply, kb);
  } else {
    await sendMessage(chatId, reply, kb);
  }
}

/** Render halaman jadwal harian / semua (dengan pagination). */
async function renderJadwalPage(chatId, messageId, targetArg, page = 1) {
  const svc = getSvc();
  await svc.connect();
  const data = await svc.jadwalSeminarEroom().catch(() => svc.jadwalSkripsi({ enrich: false, useCache: true }));
  const allJadwal = data.jadwal || [];

  const today = new Date();
  const isAll = /^semua|all$/i.test(targetArg);

  let filtered = [];
  let titleHeader = '';

  if (isAll) {
    filtered = allJadwal;
    titleHeader = '📊 *Semua Agenda Seminar e-Room FT Unmul*';
  } else {
    let tgl = targetArg ? parseTarget(targetArg) : today.toISOString().slice(0, 10);
    if (!tgl) tgl = today.toISOString().slice(0, 10);
    filtered = allJadwal.filter((e) => e.tanggal === tgl);
    const dObj = new Date(tgl + 'T00:00:00');
    const namaH = NAMA_HARI[dObj.getDay()] || '';
    titleHeader = `📅 *Jadwal Sidang ${namaH}, ${formatTanggalIndo(tgl)}*`;
  }

  if (!filtered.length) {
    const emptyText = `${titleHeader}\n\nTidak ada jadwal sidang pada tanggal ini.`;
    if (messageId) await editMessageText(chatId, messageId, emptyText);
    else await sendMessage(chatId, emptyText);
    return;
  }

  const p = paginateArray(filtered, page, 6);
  let reply = `${titleHeader}\n`;
  reply += `Total: *${p.total}* agenda | Halaman *${p.currentPage}* dari *${p.totalPages}*\n\n`;

  p.items.forEach((e, i) => {
    const num = p.startIndex + i + 1;
    const jam = typeof e.jam === 'string' ? e.jam.slice(0, 5) : (e.jam || '-');
    const ruang = e.ruang ? ` [Ruang ${e.ruang}]` : '';
    reply += `${num}. \`${jam}\` — *${escapeMd(e.title)}* (_${escapeMd(e.jenis)}_${escapeMd(ruang)})\n`;
  });

  if (p.totalPages > 1) {
    reply += `\n💡 _Gunakan tombol di bawah atau ketik:_ \`/jadwal ${targetArg || 'hari ini'} ${p.currentPage < p.totalPages ? p.currentPage + 1 : 1}\``;
  }

  const kb = buildPaginationKeyboard('jdwl', targetArg || 'today', p.currentPage, p.totalPages);
  if (messageId) {
    await editMessageText(chatId, messageId, reply, kb);
  } else {
    await sendMessage(chatId, reply, kb);
  }
}

/** Render halaman rincian sidang bulanan statistik (dengan pagination). */
async function renderStatistikPage(chatId, messageId, periodeVal, page = 1) {
  const svc = getSvc();
  await svc.connect();
  const statData = await svc.statistikSidang({ bulan: periodeVal });
  const b = statData.targetBulan || { sempro: 0, semhas: 0, pendadaran: 0, total: 0, jadwalList: [] };

  const parts = (periodeVal || '').split('-');
  const namaB = NAMA_BULAN[parseInt(parts[1], 10)] || periodeVal;
  const label = `${namaB} ${parts[0] || ''}`.trim();

  let reply = `📊 *Statistik Sidang e-Room FT — ${label}*\n\n`;
  reply += `• 📝 *Seminar Proposal*: *${b.sempro}* orang\n`;
  reply += `• 📋 *Seminar Hasil*: *${b.semhas}* orang\n`;
  reply += `• 🎓 *Pendadaran*: *${b.pendadaran}* orang\n`;
  reply += '━━━━━━━━━━━━━━━━━━━━\n';
  reply += `• 📌 *Total Sidang*: *${b.total}* orang\n\n`;

  const list = b.jadwalList || [];
  if (!list.length) {
    reply += 'ℹ️ _Belum ada jadwal sidang terdaftar di bulan ini._\n';
  } else {
    const p = paginateArray(list, page, 6);
    reply += `🗓️ *Daftar Sidang (${p.total} orang) — Hal ${p.currentPage}/${p.totalPages}*:\n`;
    p.items.forEach((j, i) => {
      const num = p.startIndex + i + 1;
      const shortName = (j.title || '').split(' - ')[0].trim();
      const tgl = (j.tanggal || '').slice(8, 10) + '/' + (j.tanggal || '').slice(5, 7);
      reply += `${num}. ${tgl} — *${escapeMd(shortName)}* (_${escapeMd(j.jenis)}_)\n`;
    });

    const kb = buildPaginationKeyboard('stat', periodeVal, p.currentPage, p.totalPages);
    if (messageId) {
      await editMessageText(chatId, messageId, reply, kb);
    } else {
      await sendMessage(chatId, reply, kb);
    }
    return;
  }

  if (messageId) await editMessageText(chatId, messageId, reply);
  else await sendMessage(chatId, reply);
}

/** Handler callback query untuk tombol inline pagination Telegram. */
async function handleCallbackQuery(cq) {
  const data = cq.data || '';
  if (!data || data === 'noop') {
    await answerCallbackQuery(cq.id);
    return;
  }

  const parts = data.split(':');
  if (parts[0] !== 'pg' || parts.length < 4) {
    await answerCallbackQuery(cq.id);
    return;
  }

  const type = parts[1];
  const query = decodeURIComponent(parts[2] || '');
  const page = parseInt(parts[3], 10) || 1;
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  if (!chatId || !messageId) {
    await answerCallbackQuery(cq.id);
    return;
  }

  await answerCallbackQuery(cq.id);

  try {
    if (type === 'erm' || type === 'eroom') {
      await renderEroomPage(chatId, messageId, query, page);
    } else if (type === 'jdl' || type === 'judul') {
      await renderJudulPage(chatId, messageId, query, page);
    } else if (type === 'mhs' || type === 'mahasiswa') {
      await renderMahasiswaListPage(chatId, messageId, query, page);
    } else if (type === 'jdwl' || type === 'jadwal') {
      await renderJadwalPage(chatId, messageId, query, page);
    } else if (type === 'stat' || type === 'statistik') {
      await renderStatistikPage(chatId, messageId, query, page);
    }
  } catch (e) {
    console.error('[bot] Error render callback query:', e.message);
  }
}

/** Handler utama untuk satu update Telegram. */
async function handleUpdate(update) {
  if (update.update_id !== undefined && isDuplicate(update.update_id)) return;

  // Handle callback query dari inline button (pagination, dll.)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const msg = update && update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const rawText = msg.text.trim();

  // Bersihkan username bot dari command (/mhs@my_bot -> /mhs)
  const text = rawText.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+bot\b/i, '$1');
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (!text.startsWith('/')) {
    if (isGroup) return;
    await sendMessage(chatId, helpText());
    return;
  }

  const senderName = msg.from ? (msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'user')) : 'unknown';
  console.log(`[bot] Update #${update.update_id || '-'}: command dari ${chatId} (${senderName}): "${text}"`);

  // 1. /start, /help, /menu
  if (/^\/(start|help|menu)$/i.test(text)) {
    await sendMessage(chatId, helpText());
    return;
  }

  // 2. /status
  if (/^\/status$/i.test(text)) {
    await sendTyping(chatId);
    try {
      const svc = getSvc();
      const statusText =
        '📊 *Status API & Bot e-TA*\n\n' +
        '• Status: *Online*\n' +
        `• Session e-TA: *${svc.connected ? 'Terhubung' : 'Belum aktif (login otomatis)'}*\n` +
        (svc.lastLoginAt ? `• Login terakhir: \`${svc.lastLoginAt}\`\n` : '') +
        `• Mode Telegram: *${process.env.TELEGRAM_POLLING === 'false' ? 'Webhook' : 'Polling'}*`;
      await sendMessage(chatId, statusText);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal cek status: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // 3. /mhs, /mahasiswa, /cari <nama / NIM> [halaman]
  const mhsMatch = text.match(/^\/(mhs|mahasiswa|cari)(?:\s+([\s\S]+))?$/i);
  if (mhsMatch) {
    const rawArgs = (mhsMatch[2] || '').trim();
    if (!rawArgs) {
      await sendMessage(
        chatId,
        'ℹ️ *Pencarian Mahasiswa e-TA & e-Room*\n\n' +
        'Gunakan format:\n' +
        '`/mhs <nama atau NIM> [halaman]`\n\n' +
        'Contoh:\n' +
        '`/mhs Renaldi`\n' +
        '`/mhs 2209106054`\n' +
        '`/mhs Muhammad 2`'
      );
      return;
    }

    const { q: query, page } = parseArgAndPage(rawArgs);
    await sendTyping(chatId);
    try {
      await renderMahasiswaListPage(chatId, null, query, page);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mencari data mahasiswa: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // 4. /statistik, /stats [bulan/tahun] [halaman]
  const statMatch = text.match(/^\/(statistik|stats)(?:\s+([\s\S]+))?$/i);
  if (statMatch) {
    const rawArg = (statMatch[2] || '').trim();
    const { q: periodArg, page: statPage } = parseArgAndPage(rawArg);
    const target = parseBulanTahun(periodArg || rawArg);

    if (!target) {
      await sendMessage(
        chatId,
        'Format periode tidak dikenali.\n\n' +
        'Contoh penggunaan:\n' +
        '`/statistik` — bulan ini\n' +
        '`/statistik november` — statistik bulan November\n' +
        '`/statistik 2026-06` — statistik Juni 2026\n' +
        '`/statistik 2026` — statistik sepanjang tahun 2026\n' +
        '`/statistik semua` — statistik keseluruhan'
      );
      return;
    }

    await sendTyping(chatId);
    try {
      const svc = getSvc();
      await svc.connect();

      if (target.type === 'bulan') {
        await renderStatistikPage(chatId, null, target.val, statPage);
        return;
      }

      if (target.type === 'tahun') {
        const statData = await svc.statistikSidang({ tahun: target.val });
        const y = statData.targetTahun || { total: 0, sempro: 0, semhas: 0, pendadaran: 0, bulanList: [] };

        let reply = `📊 *Statistik Sidang e-TA — Tahun ${target.val}*\n\n`;
        reply += `Total Sidang Terdaftar: *${y.total}* orang\n`;
        reply += `• 📝 *Seminar Proposal*: ${y.sempro} orang\n`;
        reply += `• 📋 *Seminar Hasil*: ${y.semhas} orang\n`;
        reply += `• 🎓 *Pendadaran*: ${y.pendadaran} orang\n\n`;

        if (y.bulanList && y.bulanList.length > 0) {
          reply += '📅 *Rincian per Bulan*:\n';
          y.bulanList.forEach((m) => {
            const parts = m.bulan.split('-');
            const namaB = NAMA_BULAN[parseInt(parts[1], 10)] || m.bulan;
            reply += `• *${namaB}*: *${m.total}* orang (Sempro: ${m.sempro}, Semhas: ${m.semhas}, Pdd: ${m.pendadaran})\n`;
          });
        }

        await sendMessage(chatId, reply);
        return;
      }

      // target.type === 'semua'
      const statData = await svc.statistikSidang();
      const g = statData.global;
      let reply = '📊 *Ringkasan Statistik Sidang e-TA (Semua Periode)*\n\n';
      reply += `Total Sidang Tercatat: *${statData.totalSemua}* orang\n`;
      reply += `• 📝 *Seminar Proposal*: ${g.sempro} orang\n`;
      reply += `• 📋 *Seminar Hasil*: ${g.semhas} orang\n`;
      reply += `• 🎓 *Pendadaran*: ${g.pendadaran} orang\n`;
      reply += `• ⏳ *Menunggu Jadwal Ruang*: ${g.belumTerjadwal} orang\n\n`;

      reply += '📅 *5 Bulan Terakhir*:\n';
      statData.perBulan.slice(0, 5).forEach((m) => {
        const parts = m.bulan.split('-');
        const namaB = NAMA_BULAN[parseInt(parts[1], 10)] + ' ' + parts[0];
        reply += `• *${namaB}*: ${m.total} orang (Sempro ${m.sempro}, Semhas ${m.semhas}, Pdd ${m.pendadaran})\n`;
      });

      await sendMessage(chatId, reply);
      return;
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mengambil statistik: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // 5. /detail <token / NIM / nama>
  const detailMatch = text.match(/^\/detail(?:\s+([\s\S]+))?$/i);
  if (detailMatch) {
    const rawTarget = (detailMatch[1] || '').trim();
    if (!rawTarget) {
      await sendMessage(
        chatId,
        'ℹ️ *Detail Sidang e-TA*\n\n' +
        'Gunakan format:\n' +
        '`/detail <NIM atau Nama atau Token>`\n\n' +
        'Contoh:\n' +
        '`/detail 2209106054`\n' +
        '`/detail Renaldi`'
      );
      return;
    }

    await sendTyping(chatId);
    try {
      const svc = getSvc();
      await svc.connect();

      let targetToken = rawTarget;

      // Jika argumen bukan token (bukan base64 URL e-TA), cari mahasiswa untuk ambil token sidangnya
      if (!targetToken.includes('eyJ') && targetToken.length < 50) {
        const mhsRes = await svc.cariMahasiswa(rawTarget);
        if (!mhsRes.matches || mhsRes.matches.length === 0) {
          await sendMessage(chatId, `❌ Mahasiswa "*${escapeMd(rawTarget)}*" tidak ditemukan.`);
          return;
        }
        const topMhs = mhsRes.matches[0];
        const latestSidang = (topMhs.riwayatSidang || [])[topMhs.riwayatSidang.length - 1];
        if (!latestSidang || !latestSidang.token) {
          await sendMessage(chatId, `ℹ️ Mahasiswa *${escapeMd(topMhs.nama)}* belum memiliki token sidang terdaftar.`);
          return;
        }
        targetToken = latestSidang.token;
      }

      const d = await svc.detailSidang(targetToken);

      let reply = '📋 *Detail Sidang e-TA*\n\n';
      reply += '🎓 *Judul Tugas Akhir*:\n';
      reply += `_${escapeMd(d.judul || '-')}_\n\n`;

      reply += '👤 *Data Peserta*:\n';
      reply += `• *Nama*: *${escapeMd(d.peserta?.nama || '-')}*\n`;
      reply += `• *NIM*: \`${d.peserta?.nim || '-'}\`\n`;
      if (d.peserta?.prodi) reply += `• *Prodi*: ${escapeMd(d.peserta.prodi)}\n`;
      reply += '\n';

      reply += '📅 *Jadwal & Ruang Pelaksanaan*:\n';
      reply += `• *Tahap*: *${escapeMd(d.jenisTA || '-')}*\n`;
      reply += `• *Waktu*: ${escapeMd(d.jadwal?.tanggal || '-')} (${escapeMd(d.jadwal?.jam || '-')})\n`;
      reply += `• *Ruangan*: ${escapeMd(d.jadwal?.ruang || '-')}\n`;
      if (d.jadwal?.kapasitas) reply += `• *Kapasitas*: ${escapeMd(d.jadwal.kapasitas)}\n`;
      if (d.progressBimbingan) reply += `• *Progress*: ${escapeMd(d.progressBimbingan)}\n`;
      reply += '\n';

      reply += '👥 *Tim Penilai (SK Sidang)*:\n';
      if (d.penilai && d.penilai.length > 0) {
        d.penilai.forEach((p) => {
          reply += `• *${escapeMd(p.peran || 'Penilai')}*: ${escapeMd(p.nama)}\n`;
          if (p.nip) reply += `  NIP: \`${p.nip}\` | Prodi: ${escapeMd(p.prodi || '-')}\n`;
        });
      } else {
        reply += '• _Belum ada susunan penilai terdaftar_\n';
      }

      // Daftar audiens / mahasiswa yang mendaftar ikut hadir menonton
      const hadirList = d.peserta?.daftarHadir || [];
      reply += '\n';
      if (hadirList.length > 0) {
        reply += `👥 *Mahasiswa yang Mendaftar Ikut Hadir (${hadirList.length} orang)*:\n`;
        hadirList.forEach((h, idx) => {
          reply += `${idx + 1}. *${escapeMd(h.nama)}* (\`${h.nim || '-'}\`)\n`;
        });
      } else if (d.peserta?.jumlahPeserta && d.peserta.jumlahPeserta !== '0') {
        reply += `👥 *Jumlah Mahasiswa Mendaftar Hadir*: *${escapeMd(d.peserta.jumlahPeserta)}* orang\n`;
      } else {
        reply += '👥 *Mahasiswa Mendaftar Ikut Hadir*: _Belum ada yang mendaftar hadir (0 orang)_\n';
      }

      await sendMessage(chatId, reply);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mengambil detail sidang: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // 6. /judul <kata kunci> [halaman]
  const judulMatch = text.match(/^\/judul(?:\s+([\s\S]+))?$/i);
  if (judulMatch) {
    const raw = (judulMatch[1] || '').trim();
    if (!raw) {
      await sendMessage(
        chatId,
        'ℹ️ *Pencarian Judul Skripsi*\n\n' +
        'Gunakan format: `/judul <kata kunci> [halaman]`\n' +
        'Contoh: `/judul kecerdasan buatan` atau `/judul sistem 2`'
      );
      return;
    }

    const { q: query, page } = parseArgAndPage(raw);
    await sendTyping(chatId);
    try {
      await renderJudulPage(chatId, null, query, page);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mencari judul: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // 7. /jadwal [hari / tanggal / semua] [halaman]
  const jadwalMatch = text.match(/^\/(jadwal|jadwal_skripsi|skripsi)(?:\s+([\s\S]+))?$/i);
  if (jadwalMatch) {
    await sendTyping(chatId);
    const raw = (jadwalMatch[2] || '').trim();
    const { q: targetArg, page } = parseArgAndPage(raw);
    try {
      await renderJadwalPage(chatId, null, targetArg, page);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mengambil jadwal: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // 8. /eroom [kata kunci / ruang / nama] [halaman]
  const eroomMatch = text.match(/^\/eroom(?:\s+([\s\S]+))?$/i);
  if (eroomMatch) {
    const raw = (eroomMatch[1] || '').trim();
    const { q: query, page } = parseArgAndPage(raw);
    await sendTyping(chatId);
    try {
      await renderEroomPage(chatId, null, query, page);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mengambil jadwal e-room: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // Jika command diawali '/' tapi tidak dikenali
  await sendMessage(chatId, 'Perintah tidak dikenali.\n\n' + helpText());
}

/** Teks bantuan command. */
function helpText() {
  return (
    '📋 *Bot e-TA & e-Room FT Unmul — Menu Layanan*\n\n' +
    '🎓 *Pencarian Mahasiswa & Judul:*\n' +
    '`/mhs <nama/NIM>` — info lengkap mahasiswa: judul TA, dosen pembimbing & penguji, serta riwayat sempro, semhas, & pdd\n' +
    '`/judul <kata kunci>` — cari judul skripsi & dosen penilai\n' +
    '`/detail <NIM/token>` — rincian ruang, kapasitas, SK tim penilai, & daftar hadir audiens\n' +
    '`/eroom <ruang/nama>` — kalender seminar e-room se-Fakultas Teknik (3.000+ agenda)\n\n' +
    '📊 *Statistik Sidang:*\n' +
    '`/statistik` — statistik sempro, semhas, & pdd bulan ini\n' +
    '`/statistik <bulan/tahun>` — contoh: `/statistik november`, `/statistik 2026-06`, `/statistik 2026`\n\n' +
    '📅 *Jadwal Sidang Harian:*\n' +
    '`/jadwal` — jadwal sidang hari ini\n' +
    '`/jadwal besok` — jadwal sidang besok\n' +
    '`/jadwal <hari>` — contoh: `/jadwal senin`, `/jadwal kamis`\n' +
    '`/jadwal <tanggal>` — contoh: `/jadwal 2026-11-23`\n' +
    '`/jadwal semua` — total semua jadwal\n\n' +
    '⚙️ *Lainnya:*\n' +
    '`/status` — cek status koneksi server & session e-TA\n' +
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

  console.log('[bot] Telegram long-polling aktif, siap menerima perintah (/start, /mhs, /statistik, dll)!');

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
  parseBulanTahun,
  formatJadwalTanggal,
  formatProfilMahasiswa,
  formatTanggalIndo,
  jadwalTanggal,
  sendMessage,
  helpText,
};
