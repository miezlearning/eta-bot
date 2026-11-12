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

/** Handler utama untuk satu update Telegram. */
async function handleUpdate(update) {
  const msg = update && update.message;
  if (!msg || !msg.text) return;

  if (update.update_id !== undefined && isDuplicate(update.update_id)) return;

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

  // 3. /mhs, /mahasiswa, /cari <nama / NIM>
  const mhsMatch = text.match(/^\/(mhs|mahasiswa|cari)(?:\s+([\s\S]+))?$/i);
  if (mhsMatch) {
    const query = (mhsMatch[2] || '').trim();
    if (!query) {
      await sendMessage(
        chatId,
        'ℹ️ *Pencarian Mahasiswa e-TA*\n\n' +
        'Gunakan format:\n' +
        '`/mhs <nama atau NIM>`\n\n' +
        'Contoh:\n' +
        '`/mhs Renaldi`\n' +
        '`/mhs 2209106054`'
      );
      return;
    }

    await sendTyping(chatId);
    try {
      const svc = getSvc();
      await svc.connect();
      const result = await svc.cariMahasiswa(query);

      if (!result.matches || result.matches.length === 0) {
        await sendMessage(
          chatId,
          `❌ Mahasiswa dengan kata kunci "*${escapeMd(query)}*" tidak ditemukan di sistem e-TA.\n\n` +
          'Tips: Pastikan ejaan nama benar atau gunakan NIM lengkap.'
        );
        return;
      }

      // Jika hanya ada 1 hasil: tampilkan profil detail langsung!
      if (result.matches.length === 1) {
        const textReply = formatProfilMahasiswa(result.matches[0]);
        await sendMessage(chatId, textReply);
        return;
      }

      // Jika ada beberapa hasil (2 - 10): tampilkan daftar kandidat
      const maks = 10;
      const list = result.matches.slice(0, maks);
      let listText = `🔍 Ditemukan *${result.total}* mahasiswa untuk kata kunci "*${escapeMd(query)}*":\n\n`;

      list.forEach((m, idx) => {
        const tahap = (m.riwayatSidang || []).map((s) => s.jenis.replace('Seminar ', '')).join(', ') || 'Belum ada jadwal';
        listText += `${idx + 1}. *${escapeMd(m.nama)}* (\`${m.nim || '-'}\`)\n`;
        if (m.judul) {
          const cutJudul = m.judul.length > 70 ? m.judul.slice(0, 70) + '...' : m.judul;
          listText += `   📖 _${escapeMd(cutJudul)}_\n`;
        }
        listText += `   📅 Sidang: ${escapeMd(tahap)}\n\n`;
      });

      if (result.total > maks) {
        listText += `_...dan ${result.total - maks} mahasiswa lainnya. Masukkan NIM untuk hasil spesifik._\n\n`;
      }

      listText += '👉 *Ketik:* `/mhs <NIM>` untuk melihat detail lengkap salah satu mahasiswa di atas.';
      await sendMessage(chatId, listText);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mencari data mahasiswa: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // 4. /statistik, /stats [bulan/tahun]
  const statMatch = text.match(/^\/(statistik|stats)(?:\s+([\s\S]+))?$/i);
  if (statMatch) {
    const rawArg = (statMatch[2] || '').trim();
    const target = parseBulanTahun(rawArg);

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
        const statData = await svc.statistikSidang({ bulan: target.val });
        const b = statData.targetBulan || { sempro: 0, semhas: 0, pendadaran: 0, total: 0, jadwalList: [] };

        let reply = `📊 *Statistik Sidang e-TA — ${target.label}*\n\n`;
        reply += `• 📝 *Seminar Proposal*: *${b.sempro}* orang\n`;
        reply += `• 📋 *Seminar Hasil*: *${b.semhas}* orang\n`;
        reply += `• 🎓 *Pendadaran*: *${b.pendadaran}* orang\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━\n';
        reply += `• 📌 *Total Sidang*: *${b.total}* orang\n\n`;

        if (b.jadwalList && b.jadwalList.length > 0) {
          const sample = b.jadwalList.slice(0, 6);
          reply += `🗓️ *Daftar Sidang Bulan Ini (${b.total} terdaftar)*:\n`;
          sample.forEach((j, i) => {
            const shortName = (j.title || '').split(' - ')[0].trim();
            const tgl = (j.tanggal || '').slice(8, 10) + '/' + (j.tanggal || '').slice(5, 7);
            reply += `${i + 1}. ${tgl} — *${escapeMd(shortName)}* (_${escapeMd(j.jenis)}_)\n`;
          });
          if (b.jadwalList.length > 6) {
            reply += `_...dan ${b.jadwalList.length - 6} sidang lainnya._\n`;
          }
          reply += '\n';
        } else {
          reply += 'ℹ️ _Belum ada jadwal sidang terdaftar di bulan ini._\n\n';
        }

        reply += '💡 _Gunakan `/statistik <bulan>` (contoh: `/statistik oktober` atau `/statistik 2026`) untuk periode lain._';
        await sendMessage(chatId, reply);
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

  // 6. /judul <kata kunci>
  const judulMatch = text.match(/^\/judul(?:\s+([\s\S]+))?$/i);
  if (judulMatch) {
    const query = (judulMatch[1] || '').trim();
    if (!query) {
      await sendMessage(
        chatId,
        'ℹ️ *Pencarian Judul Skripsi*\n\n' +
        'Gunakan format: `/judul <kata kunci>`\n' +
        'Contoh: `/judul artificial intelligence` atau `/judul augmented reality`'
      );
      return;
    }

    await sendTyping(chatId);
    try {
      const svc = getSvc();
      await svc.connect();
      const res = await svc.judulSkripsi({ q: query });
      const daftar = res.daftar || [];

      if (!daftar.length) {
        await sendMessage(chatId, `Tidak ditemukan judul skripsi untuk kata kunci: *${escapeMd(query)}*.`);
        return;
      }

      const maks = 5;
      let reply = `📚 *Daftar Judul Skripsi* (filter: _${escapeMd(query)}_)\n`;
      reply += `Total ditemukan: *${daftar.length}* judul\n\n`;

      const items = daftar.slice(0, maks).map((item, idx) => {
        let block = `${idx + 1}. *${escapeMd(item.judul)}*\n`;
        block += `   👤 *${escapeMd(item.nama)}* (\`${item.nim || '-'}\`)\n`;

        const dosen = item.dosen || {};
        const p1 = dosen.pembimbing_1?.nama ? `P1: ${dosen.pembimbing_1.nama}` : '';
        const p2 = dosen.pembimbing_2?.nama ? `P2: ${dosen.pembimbing_2.nama}` : '';
        const pemb = [p1, p2].filter(Boolean).join(' | ');
        if (pemb) block += `   👥 ${escapeMd(pemb)}\n`;

        if (item.batasWaktu) block += `   ⏳ Status: _${escapeMd(item.batasWaktu)}_\n`;
        return block;
      });

      reply += items.join('\n');
      if (daftar.length > maks) {
        reply += `\n_...dan ${daftar.length - maks} judul lainnya._\n`;
      }
      reply += '\n💡 _Ketik `/mhs <NIM>` untuk melihat detail riwayat sempro, semhas, & pendadaran._';

      await sendMessage(chatId, reply);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mencari judul: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // 7. /jadwal dengan argumen.
  const jadwalMatch = text.match(/^\/(jadwal|jadwal_skripsi|skripsi)(?:\s+([\s\S]+))?$/i);
  if (jadwalMatch) {
    await sendTyping(chatId);
    const args = (jadwalMatch[2] || '').trim();

    try {
      const svc = getSvc();
      await svc.connect();
      const data = await svc.jadwalSeminarEroom().catch(() => svc.jadwalSkripsi({ enrich: false, useCache: true }));

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
          'Contoh: `/jadwal besok`, `/jadwal kamis`, `/jadwal 2026-11-23`'
        );
        return;
      }

      // "/jadwal <target>" -> tanggal spesifik.
      const target = parseTarget(args);
      if (!target) {
        await sendMessage(
          chatId,
          'Format tidak dikenali. Contoh:\n`/jadwal`\n`/jadwal besok`\n`/jadwal kamis`\n`/jadwal 2026-11-23`'
        );
        return;
      }
      const tglDate = new Date(target + 'T00:00:00');
      const namaTarget = NAMA_HARI[tglDate.getDay()];
      const replyText = formatJadwalTanggal(data.jadwal, target, namaTarget);
      await sendMessage(chatId, replyText);
    } catch (e) {
      await sendMessage(chatId, '⚠️ Gagal mengambil jadwal: ' + (e.message || 'kesalahan tidak dikenal'));
    }
    return;
  }

  // 7. /eroom [kata kunci / ruang / nama]
  const eroomMatch = text.match(/^\/eroom(?:\s+([\s\S]+))?$/i);
  if (eroomMatch) {
    const q = (eroomMatch[1] || '').trim();
    await sendTyping(chatId);
    try {
      const svc = getSvc();
      await svc.connect();
      const res = await svc.jadwalSeminarEroom({ q });
      if (!res.jadwal || res.jadwal.length === 0) {
        await sendMessage(chatId, `ℹ️ Tidak ada jadwal seminar e-room ditemukan${q ? ` untuk "*${escapeMd(q)}*"` : ''}.`);
        return;
      }
      let reply = `🏢 *Jadwal Seminar e-Room FT Unmul*${q ? ` — Pencarian "*${escapeMd(q)}*"` : ''}\n\n`;
      reply += `Total ditemukan: *${res.total}* agenda\n\n`;
      const sample = res.jadwal.slice(0, 8);
      sample.forEach((j, i) => {
        const tgl = j.tanggal ? formatTanggalIndo(j.tanggal) : 'Belum terjadwal';
        const jam = j.jam ? ` (${j.jam}${j.jamSelesai ? '-' + j.jamSelesai : ''} WITA)` : '';
        reply += `${i + 1}. *${escapeMd(j.nama)}*\n`;
        reply += `   📍 *Ruang*: \`${escapeMd(j.ruang)}\` | *Tahap*: ${escapeMd(j.jenis)}\n`;
        reply += `   🗓️ ${tgl}${jam}\n`;
      });
      if (res.jadwal.length > 8) {
        reply += `\n_...dan ${res.jadwal.length - 8} agenda lainnya._\n`;
      }
      reply += '\n💡 _Ketik `/detail <nama/NIM>` untuk melihat dosen penilai & audiens hadir._';
      await sendMessage(chatId, reply);
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
