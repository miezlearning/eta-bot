/**
 * Parser HTML -> JSON untuk halaman-halaman e-TA.
 *
 * Setiap fungsi menerima string HTML (response body) dan mengembalikan
 * objek JSON terstruktur yang siap disajikan sebagai response API.
 */
const cheerio = require('cheerio');

/** Utility: ambil teks bersih dari elemen. */
function clean($el) {
  return ($el && $el.text ? $el.text().replace(/\s+/g, ' ').trim() : '').trim();
}

/**
 * Parse data identitas mahasiswa dari blok "NIM/Nama/Prodi".
 * Ditemukan di banyak halaman dalam bentuk tabel kecil di bagian atas.
 */
function parseIdentity($) {
  const profile = {};
  const table = $('table').first();
  if (table.length) {
    table.find('tr').each((i, tr) => {
      const $tr = $(tr);
      const cells = $tr.find('td,th').map((j, td) => clean($(td))).get();
      // Format: [label, ":", nilai]
      if (cells.length >= 3 && cells[0] && cells[2]) {
        profile[cells[0].toLowerCase().replace(/[:\s]+/g, '_')] = cells[2];
      }
    });
  }
  return profile;
}

/**
 * Parse kalender jadwal sidang dari halaman /lihat_jadwal_skripsi.
 * Data dirender sebagai FullCalendar JSON di dalam <script>.
 * Struktur event: { title, start, end, url, backgroundColor, borderColor }
 */
function parseJadwalSkripsi(html) {
  const $ = cheerio.load(html);
  const identity = parseIdentity($);

  // Warna background memetakan jenis seminar
  const JENIS_WARNA = {
    'bd362f': 'Pendadaran',
    '609450': 'Seminar Proposal',
    '4a8bc2': 'Seminar Hasil',
  };

  // Ambil blok "events: [...]" dari FullCalendar
  const evIdx = html.indexOf('events: [');
  let jadwal = [];
  if (evIdx >= 0) {
    // Potong dari events: [ sampai ']' penutup di baris tsb.
    const block = html.slice(evIdx, html.indexOf(']', evIdx) + 1);
    // Ekstrak setiap objek { ... } di dalam array (regex kasar).
    const objRe = /\{\s*title:\s*'([^']*)'\s*,\s*start:\s*'([^']*)'\s*,\s*end:\s*'([^']*)'\s*,\s*url:\s*'([^']*)'\s*,\s*backgroundColor:\s*"#([0-9a-fA-F]{6})"[^}]*\}/g;
    let m;
    while ((m = objRe.exec(block)) !== null) {
      const [, title, start, end, url, color] = m;
      const [tanggal, jam] = start.split(' ');
      const nimMatch = title.match(/(\d{10})/);
      jadwal.push({
        title,
        tanggal,
        jam,
        jamSelesai: (end.split(' ')[1] || '').slice(0, 5),
        url: url.trim(),
        token: url.trim().split('/').pop().trim(),
        jenis: JENIS_WARNA[color] || 'Lainnya',
      });
    }
  }

  return { identity, jadwal };
}

/**
 * Parse detail sidang dari halaman /informasi_skripsi/{token}.
 */
function parseInformasiSkripsi(html) {
  const $ = cheerio.load(html);
  const out = {};

  // 1. Identitas mahasiswa (halaman ini biasanya menampilkan identitas pengguna,
  //    bukan identitas peserta sidang — yang peserta ada di blok peserta).
  out.identity = parseIdentity($);

  // 2. Judul TA (dari h3 align="center")
  out.judul = clean($('h3[align="center"]').first());

  // 3. Jadwal pelaksanaan sidang
  const jadwal = { ruang: null, fakultas: null, kapasitas: null, tanggal: null, jam: null };
  // Blok "Jadwal Pelaksanaan Sidang"
  const jadwalWidget = $('.widget').filter((i, w) => /jadwal pelaksanaan sidang/i.test(clean($(w).find('h4').first())));
  if (jadwalWidget.length) {
    const w = jadwalWidget.first();
    // Ruang (media-body lead)
    const leadP = w.find('.media-body p.lead');
    const allP = w.find('.media-body p');
    const texts = allP.map((i, p) => clean($(p))).get();
    if (texts.length >= 0) {
      // Cari yang berupa nama ruang, kapasitas, tanggal+jam
      const ruang = texts.find(t => /ruang|gedung/i.test(t));
      const kap = texts.find(t => /kapasitas/i.test(t));
      const kal = texts.find(t => /\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/i.test(t) || /[a-z]+,\s*\d{1,2}\s+[a-z]+\s+\d{4}/i.test(t));
      jadwal.ruang = ruang || null;
      jadwal.kapasitas = kap || null;
      if (kal) {
        const tglMatch = kal.match(/([a-z]+,\s*\d{1,2}\s+[a-z]+\s+\d{4})/i);
        const jamMatch = kal.match(/(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*wita?)/i);
        jadwal.tanggal = tglMatch ? tglMatch[1] : null;
        jadwal.jam = jamMatch ? jamMatch[1] : null;
      }
    }
  }
  out.jadwal = jadwal;

  // 4. Progress bimbingan & jenis TA
  // Keduanya dirender sebagai <p class="strong lead margin-none">Label</p>
  // diikuti <p class="strong margin-none">Value</p>.
  out.progressBimbingan = null;
  out.jenisTA = null;
  $('p.strong.lead.margin-none').each((i, p) => {
    const $p = $(p);
    const label = clean($p);
    // Nilai ada di <p> sibling berikutnya dengan class "strong margin-none"
    const nextP = $p.next('p.strong.margin-none');
    if (!nextP.length) return;
    if (/progress bimbingan/i.test(label)) {
      out.progressBimbingan = clean(nextP) || null;
    } else if (/jenis tugas akhir/i.test(label)) {
      out.jenisTA = clean(nextP) || null;
    }
  });

  // 5. Penilai seminar (pembimbing & penguji)
  const penilai = [];
  $('.widget').each((i, w) => {
    const $w = $(w);
    const h4text = clean($w.find('h4').first());
    if (/penilai seminar|sidang tugas akhir/i.test(h4text)) {
      $w.find('.row.row-merge').each((j, row) => {
        const $row = $(row);
        const peran = clean($row.find('.label').first());
        const nama = clean($row.find('h5').first());
        const items = $row.find('li').map((k, li) => clean($(li))).get();
        if (nama) {
          penilai.push({
            peran,
            nama,
            nip: items[0] || null,
            prodi: items[1] || null,
          });
        }
      });
    }
  });
  out.penilai = penilai;

  // 6. Info peserta (mahasiswa yang bersidang & daftar hadir penonton)
  const daftarHadir = [];
  $('a[data-toggle="image-preview"]').each((i, el) => {
    const raw = ($(el).attr('data-title') || '').replace(/\s+/g, ' ').trim();
    const match = raw.match(/^(\d{10})\s+(.+)$/);
    if (match) {
      daftarHadir.push({
        nim: match[1],
        nama: match[2].trim(),
        foto: $(el).attr('data-image-preview') || null,
      });
    } else if (raw.trim()) {
      daftarHadir.push({
        nim: null,
        nama: raw.trim(),
        foto: $(el).attr('data-image-preview') || null,
      });
    }
  });

  const peserta = {
    nama: clean($('p.lead.strong.margin-none').first()) || null,
    nim: clean($('p.lead:not(.strong)').first()) || null,
    prodi: clean($('.label-success strong').first()) || null,
    jumlahPeserta: clean($('.badge.bg-warning').first()) || null,
    daftarHadir,
  };
  out.peserta = peserta;

  return out;
}

/**
 * Parse daftar judul skripsi dari /lihat_judul_skripsi.
 */
function parseJudulSkripsi(html) {
  const $ = cheerio.load(html);
  const identity = parseIdentity($);
  const daftar = [];

  $('table').each((i, tbl) => {
    const $tbl = $(tbl);
    const headText = clean($tbl.find('thead th').first());
    if (/judul tugas akhir|judul/i.test(headText)) {
      $tbl.find('tbody tr').each((j, tr) => {
        const $tr = $(tr);
        const $tds = $tr.find('td');

        // Kolom 1: Judul + NIM + Nama
        const $c1 = $tds.eq(0);
        const judul = clean($c1.find('strong').first());
        // Ambil teks setelah <strong>: pola "NIM<br>Nama"
        const c1Html = $c1.html() || '';
        const restHtml = c1Html.split('</strong>')[1] || '';
        const restText = cheerio.load(restHtml)('body').text().replace(/\s+/g, ' ').trim();
        const nimMatch = restText.match(/(\d{10})/);
        const nama = restText.replace(nimMatch ? nimMatch[1] : '', '').trim();

        // Kolom 2: dosen penilai — parse dari DOM
        const $c2 = $tds.eq(1);
        const dosen = {};
        // Setiap blok dosen punya label <br> sebelum dan <span class="label label-primary|inverse">
        $c2.contents().each((k, node) => {
          const txt = $(node).text().trim();
          const roleMatch = txt.match(/^(Pembimbing 1|Pembimbing 2|Penguji 1|Penguji 2|Pembimbing 3)\s*:/);
          if (roleMatch) {
            const peran = roleMatch[1].replace(/\s+/g, '_').toLowerCase();
            // Status adalah span dengan class label sebelum nama
            const statusLabel = $c2.find(`span.label`).eq(k).text().trim() || null;
            // Nama ada di span.label-primary / span.label-inverse setelah status
            dosen[peran] = { status: statusLabel, nama: null };
          }
        });
        // Ambil nama-nama dari span label-primary & label-inverse
        $c2.find('span.label-primary, span.label-inverse').each((k, sp) => {
          const namaD = clean($(sp));
          // Pasangkan ke dosen berdasarkan urutan
          const keys = Object.keys(dosen);
          if (keys[k]) dosen[keys[k]].nama = namaD;
        });

        // Kolom 3: batas waktu
        const batasWaktu = clean($tds.eq(2)) || null;

        daftar.push({
          judul: judul || null,
          nim: nimMatch ? nimMatch[1] : null,
          nama: nama || null,
          dosen,
          batasWaktu: batasWaktu || null,
        });
      });
    }
  });

  return { identity, daftar };
}

/**
 * Parse data profil mahasiswa lengkap (dari /lengkapi_data atau /lihat_data_proposal).
 * Berisi informasi pribadi, nilai KRS, penelitian, publikasi, dst.
 */
function parseProfilMahasiswa(html) {
  const $ = cheerio.load(html);
  const out = {};

  out.identity = parseIdentity($);

  // Bio personal information — blok "Bio Personal information"
  const bio = {};
  $('.widget').each((i, w) => {
    const $w = $(w);
    const h4text = clean($w.find('h4').first());
    if (/bio personal/i.test(h4text)) {
      $w.find('li').each((j, li) => {
        const txt = clean($(li));
        const parts = txt.split(':');
        if (parts.length >= 2) {
          const key = parts[0].trim().toLowerCase().replace(/[\s:]+/g, '_').replace(/-/g, '');
          bio[key] = parts.slice(1).join(':').trim();
        }
      });
    }
  });
  out.bio = bio;

  // Tabel nilai (KRS)
  out.nilai = [];
  $('table').each((i, tbl) => {
    const $tbl = $(tbl);
    const headText = clean($tbl.find('thead th').first());
    if (/kode mk|nama mata kuliah/i.test(headText)) {
      out.nilai = $tbl.find('tbody tr').map((j, tr) => {
        const cells = $(tr).find('td').map((k, td) => clean($(td))).get();
        if (cells.length >= 6) {
          return {
            kode: cells[0],
            nama: cells[1],
            sks: cells[2],
            jenis: cells[3],
            nilai: cells[4],
            huruf: cells[5],
          };
        }
        return null;
      }).get().filter(Boolean);
    }
  });

  return out;
}

/**
 * Parse daftar ruang seminar dari /lihat_jadwal_ruangan_seminar_prodi_eta.
 * Halaman ini menampilkan dropdown ruangan dan daftar jadwal yang
 * di-render dinamis (AJAX). Kita ambil daftar ruangan dari <select>.
 */
function parseRuangSeminar(html) {
  const $ = cheerio.load(html);
  const out = { identity: parseIdentity($), ruang: [], jadwalSeminar: null };

  // Daftar ruangan dari <select id="ruang">
  $('select#ruang option').each((i, opt) => {
    const $opt = $(opt);
    const val = $opt.attr('value');
    const nama = clean($opt);
    if (val) {
      out.ruang.push({ kode: val, nama });
    }
  });

  // Daftar ruangan/jadwal seminar per prodi (tabel-tebel yang ada)
  // Setiap blok ruangan punya heading "RUANG SEMINAR PRODI ..." lalu tabel.
  out.jadwalSeminar = null;
  const jadwal = [];
  const ruangHeaders = [];
  $('table').each((i, tbl) => {
    const $tbl = $(tbl);
    const txt = clean($tbl);
    if (/ruang|seminar|gedung/i.test(txt)) {
      const cells = $tbl.find('td,th').map((j, td) => clean($(td))).get().filter(Boolean);
      // Buang yang cuma "NIM/Nama/Prodi" identity
      if (txt.length > 30 && cells.length > 2) {
        jadwal.push(cells.slice(0, 15));
      }
    }
  });

  return out;
}

/**
 * Parse tabel-tabel generik pada halaman data (proposal/hasil/pendadaran/dll).
 * Mengubah setiap <table> yang punya header menjadi array objek ber-key kolom.
 * Menyertakan identitas mahasiswa dari blok kecil di atas.
 */
function parseGenericRows(html) {
  const $ = cheerio.load(html);
  const identity = parseIdentity($);
  const tables = [];

  $('table').each((i, tbl) => {
    const $tbl = $(tbl);
    const $headTh = $tbl.find('thead th');
    const headCells = $headTh.map((j, th) => clean($(th))).get().filter(Boolean);

    // Lewati tabel identitas kecil (yang cuma "NIM : ... Nama : ...")
    if (headCells.length === 0) return;

    const rows = [];
    $tbl.find('tbody tr').each((j, tr) => {
      const cells = $(tr).find('td').map((k, td) => clean($(td))).get();
      const obj = {};
      headCells.forEach((h, idx) => {
        obj[h.toLowerCase().replace(/[\s:]+/g, '_')] = cells[idx] != null ? cells[idx] : null;
      });
      rows.push(obj);
    });
    if (rows.length) tables.push({ kolom: headCells, rows });
  });

  return { identity, tables };
}

/**
 * Parse kalender jadwal seminar dari halaman /mahasiswa/e-room/lihat_jadwal_seminar.
 * Berisi ribuan agenda seminar (Sempro, Semhas, Pendadaran) se-Fakultas Teknik.
 */
function parseJadwalSeminarEroom(html) {
  const $ = cheerio.load(html);
  const identity = parseIdentity($);

  const startIdx = html.indexOf('events: [');
  if (startIdx === -1) {
    return { identity, jadwal: [] };
  }
  const eventsCloseIdx = html.indexOf('],', startIdx);
  if (eventsCloseIdx === -1) {
    return { identity, jadwal: [] };
  }

  const arrayStr = html.slice(startIdx + 'events:'.length, eventsCloseIdx + 1).trim();
  let rawEvents = [];
  try {
    rawEvents = new Function('return ' + arrayStr)();
  } catch (e) {
    return { identity, jadwal: [], error: e.message };
  }

  const JENIS_WARNA = {
    '609450': 'Seminar Proposal',
    '4a8bc2': 'Seminar Hasil',
    'bd362f': 'Pendadaran',
  };

  const jadwal = [];
  for (const e of rawEvents) {
    if (!e || typeof e !== 'object') continue;
    const title = (e.title || '').trim();
    if (!title || title.toLowerCase() === 'tes') continue;

    const dashIdx = title.lastIndexOf(' - ');
    let nama = title;
    let ruang = '';
    if (dashIdx !== -1) {
      nama = title.slice(0, dashIdx).trim();
      ruang = title.slice(dashIdx + 3).trim();
    }

    const hex = (e.backgroundColor || '').replace('#', '').toLowerCase();
    const jenis = JENIS_WARNA[hex] || 'Sidang Tugas Akhir';

    const rawUrl = (e.url || '').trim();
    let token = null;
    if (rawUrl.includes('/informasi_seminar/')) {
      token = rawUrl.split('/informasi_seminar/')[1].trim();
    } else if (rawUrl.includes('/informasi_skripsi/')) {
      token = rawUrl.split('/informasi_skripsi/')[1].trim();
    }

    let startStr = '';
    if (typeof e.start === 'string') {
      startStr = e.start.trim();
    } else if (e.start instanceof Date) {
      startStr = e.start.toISOString().replace('T', ' ').slice(0, 19);
    }

    let endStr = '';
    if (typeof e.end === 'string') {
      endStr = e.end.trim();
    } else if (e.end instanceof Date) {
      endStr = e.end.toISOString().replace('T', ' ').slice(0, 19);
    }

    let tanggal = '';
    let jam = '';
    let jamSelesai = '';

    if (startStr && /^\d{4}-\d{2}-\d{2}/.test(startStr)) {
      tanggal = startStr.slice(0, 10);
      jam = startStr.slice(11, 16);
    }
    if (endStr && /^\d{4}-\d{2}-\d{2}/.test(endStr)) {
      jamSelesai = endStr.slice(11, 16);
    }

    jadwal.push({
      title,
      nama,
      ruang: ruang || 'belum',
      jenis,
      tanggal,
      jam,
      jamSelesai,
      start: startStr,
      end: endStr,
      url: rawUrl,
      token,
      color: e.backgroundColor || null,
      source: 'eroom',
    });
  }

  return { identity, jadwal };
}

module.exports = {
  parseJadwalSkripsi,
  parseInformasiSkripsi,
  parseJudulSkripsi,
  parseProfilMahasiswa,
  parseRuangSeminar,
  parseGenericRows,
  parseJadwalSeminarEroom,
  clean,
};