/**
 * Service layer untuk e-TA.
 * Menggabungkan client (session/cookie) dan parsers (HTML->JSON).
 *
 * Pola penggunaan:
 *   const svc = new EtaService(credentials);
 *   await svc.connect();        // login
 *   const data = await svc.jadwalSkripsi();
 */
const { createAxiosInstance, login } = require('./client');
const {
  parseJadwalSkripsi,
  parseInformasiSkripsi,
  parseJudulSkripsi,
  parseProfilMahasiswa,
  parseRuangSeminar,
  parseJadwalSeminarEroom,
} = require('./parsers');
const config = require('../config');

class EtaService {
  constructor(creds = config.credentials) {
    this.credentials = creds;
    this.client = null;
    this.connected = false;
    this.lastLoginAt = null;

    // Cache jadwal e-room (karena berukuran ~2MB dengan 3000+ event)
    this._eroomJadwalCache = null;
    this._eroomCacheTime = 0;
    this._eroomCacheTTL = 5 * 60 * 1000; // 5 menit
    this._eroomIdentity = null;
  }

  /** Login ke sistem dan siapkan session. */
  async connect() {
    if (this.connected && this.client) return true;
    const client = createAxiosInstance();
    const ok = await login(client, this.credentials);
    if (!ok) throw new Error('Login gagal: kredensial salah atau akses ditolak');
    this.client = client;
    this.connected = true;
    this.lastLoginAt = new Date().toISOString();
    return true;
  }

  /** Pastikan session aktif; jika token kadaluarsa, coba login ulang sekali. */
  async _ensure() {
    if (!this.connected) {
      await this.connect();
    }
  }

  /** GET halaman dan kembalikan data HTML body. */
  async _get(path) {
    await this._ensure();
    const res = await this.client.get(path);
    // Jika ter-redirect ke halaman login, token sudah invalid -> login ulang.
    if (res.status === 200 && res.data && /Masukkan Akun AIS/i.test(res.data)) {
      this.connected = false;
      await this.connect();
      const res2 = await this.client.get(path);
      return res2.data;
    }
    return res.data;
  }

  /** GET data jadwal sidang (kalender), dengan pencarian opsional.
   * @param {object} opts - { enrich, useCache, q, nama, nim, prodi }
   *   q/nama/nim memfilter title; prodi butuh enrich (otomatis bila diminta).
   */
  async jadwalSkripsi({ enrich = false, useCache = true, q = '', nama = '', nim = '', prodi = '' } = {}) {
    const html = await this._get('/mahasiswa/e-ta/lihat_jadwal_skripsi');
    const data = parseJadwalSkripsi(html);

    // Jika filter prodi diminta, aktifkan enrich (diperlukan utk tahu prodi tiap event).
    const needEnrich = enrich || !!prodi;
    if (needEnrich && data.jadwal.length) {
      data.jadwal = await this._enrichJadwalProdi(data.jadwal, useCache);
    }

    // Terapkan filter pencarian.
    if (q || nama || nim || prodi) {
      const ql = q.toLowerCase();
      const namal = nama.toLowerCase();
      const nimal = nim.toLowerCase();
      const prodil = prodi.toLowerCase();
      data.jadwal = data.jadwal.filter((e) => {
        const title = (e.title || '').toLowerCase();
        const eNim = (e.title.match(/\d{10}/) || [''])[0];
        const eProdi = (e.prodi || '').toLowerCase();
        if (q && !title.includes(ql) && !eNim.includes(ql)) return false;
        if (nama && !title.includes(namal)) return false;
        if (nim && !eNim.includes(nimal)) return false;
        if (prodi && !eProdi.includes(prodil)) return false;
        return true;
      });
    }

    return data;
  }

  /** Tambahkan field `prodi` pada tiap event jadwal dengan menarik halaman detail.
   *  Hasil di-cache per nama peserta (key stabil) — token detail bersifat sementara (berubah tiap request). */
  async _enrichJadwalProdi(jadwal, useCache) {
    if (!this._prodiCache) this._prodiCache = new Map();
    const out = [];
    for (const item of jadwal) {
      const token = item.token;
      // Key cache stabil: nama peserta dari title (format "Nama - Ruangan").
      // Token berubah tiap request, jadi tidak bisa dipakai sebagai key.
      const nama = (item.title.split(' - ')[0] || item.title).trim().toLowerCase();
      const key = nama || token;
      let prodi = null;
      if (useCache && this._prodiCache.has(key)) {
        prodi = this._prodiCache.get(key);
      } else {
        try {
          const detail = await this.detailSidang(token);
          prodi = (detail.peserta && detail.peserta.prodi) || null;
          this._prodiCache.set(key, prodi);
        } catch (e) {
          prodi = null;
        }
      }
      out.push({ ...item, prodi });
    }
    return out;
  }

  /**
   * GET daftar judul skripsi, dengan pencarian opsional.
   * @param {object} opts - { q, nama, nim, prodi } (semua case-insensitive substring).
   */
  async judulSkripsi({ q = '', nama = '', nim = '', prodi = '' } = {}) {
    const html = await this._get('/mahasiswa/e-ta/lihat_judul_skripsi');
    const data = parseJudulSkripsi(html);


    if (q || nama || nim || prodi) {
      const ql = q.toLowerCase();
      const nimal = nim.toLowerCase();
      const namal = nama.toLowerCase();
      const prodil = prodi.toLowerCase();
      data.daftar = data.daftar.filter((d) => {
        const dJudul = (d.judul || '').toLowerCase();
        const dNama = (d.nama || '').toLowerCase();
        const dNim = (d.nim || '').toLowerCase();
        // Prodi tidak tersedia di daftar judul (halaman tidak menampilkannya),
        // jadi kita filter berdasar q/nama/nim saja.
        if (q && !dJudul.includes(ql) && !dNama.includes(ql) && !dNim.includes(ql)) return false;
        if (nama && !dNama.includes(namal)) return false;
        if (nim && !dNim.includes(nimal)) return false;
        return true;
      });
    }

    return data;
  }

  /**
   * GET data detail sidang per token.
   * Mendukung token dari e-TA (/mahasiswa/e-ta/informasi_skripsi/:token)
   * maupun e-room (/mahasiswa/e-room/informasi_seminar/:token).
   */
  async detailSidang(token, { source = 'auto' } = {}) {
    if (!token) throw new Error('Token sidang diperlukan');
    const cleanToken = encodeURIComponent(String(token).trim());

    if (source === 'eroom') {
      const html = await this._get(`/mahasiswa/e-room/informasi_seminar/${cleanToken}`);
      return parseInformasiSkripsi(html);
    }
    if (source === 'eta') {
      const html = await this._get(`/mahasiswa/e-ta/informasi_skripsi/${cleanToken}`);
      return parseInformasiSkripsi(html);
    }

    // Default 'auto': coba e-room dulu, jika gagal coba e-ta
    try {
      const html = await this._get(`/mahasiswa/e-room/informasi_seminar/${cleanToken}`);
      const parsed = parseInformasiSkripsi(html);
      if (parsed.judul || (parsed.peserta && parsed.peserta.nama)) {
        return parsed;
      }
    } catch (_) {}

    const etaHtml = await this._get(`/mahasiswa/e-ta/informasi_skripsi/${cleanToken}`);
    return parseInformasiSkripsi(etaHtml);
  }

  /**
   * GET jadwal seminar dari modul e-room (/mahasiswa/e-room/lihat_jadwal_seminar).
   * Berisi kalender komprehensif seminar se-Fakultas Teknik (3.000+ agenda).
   * Dilengkapi in-memory TTL caching (5 menit) agar response secepat kilat.
   * @param {object} opts - { q, nama, jenis, ruang, tanggal, bulan, tahun, forceRefresh }
   */
  async jadwalSeminarEroom({
    q = '',
    nama = '',
    jenis = '',
    ruang = '',
    tanggal = '',
    bulan = '',
    tahun = '',
    forceRefresh = false,
  } = {}) {
    await this._ensure();
    const now = Date.now();
    const isCacheValid = this._eroomJadwalCache && (now - this._eroomCacheTime < this._eroomCacheTTL);

    if (forceRefresh || !isCacheValid) {
      const html = await this._get('/mahasiswa/e-room/lihat_jadwal_seminar');
      const parsed = parseJadwalSeminarEroom(html);
      this._eroomJadwalCache = parsed.jadwal || [];
      this._eroomCacheTime = now;
      this._eroomIdentity = parsed.identity || {};
    }

    let list = this._eroomJadwalCache || [];

    if (q || nama || jenis || ruang || tanggal || bulan || tahun) {
      const ql = q.toLowerCase();
      const namal = nama.toLowerCase();
      const jenisl = jenis.toLowerCase();
      const ruangl = ruang.toLowerCase();

      list = list.filter((item) => {
        const iTitle = (item.title || '').toLowerCase();
        const iNama = (item.nama || '').toLowerCase();
        const iJenis = (item.jenis || '').toLowerCase();
        const iRuang = (item.ruang || '').toLowerCase();
        const iTgl = item.tanggal || '';

        if (q && !iTitle.includes(ql) && !iNama.includes(ql)) return false;
        if (nama && !iNama.includes(namal)) return false;
        if (jenis && !iJenis.includes(jenisl)) return false;
        if (ruang && !iRuang.includes(ruangl)) return false;
        if (tanggal && iTgl !== tanggal) return false;
        if (bulan && !iTgl.startsWith(bulan)) return false;
        if (tahun && !iTgl.startsWith(tahun)) return false;
        return true;
      });
    }

    return {
      identity: this._eroomIdentity || {},
      total: list.length,
      jadwal: list,
    };
  }

  /** GET profil mahasiswa lengkap (nilai, publikasi, dll). */
  async profilMahasiswa() {
    const html = await this._get('/mahasiswa/e-ta/lengkapi_data');
    return parseProfilMahasiswa(html);
  }

  /** GET daftar ruang seminar per prodi. */
  async ruangSeminar() {
    const html = await this._get('/mahasiswa/e-ta/lihat_jadwal_ruangan_seminar_prodi_eta');
    return parseRuangSeminar(html);
  }

  /** GET daftar semua jadwal yang tampil di dashboard. */
  async dashboard() {
    const html = await this._get('/mahasiswa/e-ta/index');
    return parseJadwalSkripsi(html);
  }

  /** GET data proposal skripsi (route /lihat_data_proposal). */
  async dataProposal() {
    const html = await this._get('/mahasiswa/e-ta/lihat_data_proposal');
    return this._parseDataRows(html);
  }

  /** GET data hasil seminar (route /lihat_data_hasil). */
  async dataHasil() {
    const html = await this._get('/mahasiswa/e-ta/lihat_data_hasil');
    return this._parseDataRows(html);
  }

  /** GET data pendadaran (route /lihat_data_pendadaran). */
  async dataPendadaran() {
    const html = await this._get('/mahasiswa/e-ta/lihat_data_pendadaran');
    return this._parseDataRows(html);
  }

  /** GET data bimbingan skripsi (route /lihat_bimbingan_skripsi). */
  async bimbinganSkripsi() {
    const html = await this._get('/mahasiswa/e-ta/lihat_bimbingan_skripsi');
    return this._parseDataRows(html);
  }

  /** GET data seminar skripsi (route /lihat_seminar_skripsi). */
  async seminarSkripsi() {
    const html = await this._get('/mahasiswa/e-ta/lihat_seminar_skripsi');
    return this._parseDataRows(html);
  }

  /** Parse tabel-tabel data pada halaman generik (proposal/hasil/pendadaran/dll). */
  _parseDataRows(html) {
    const { parseGenericRows } = require('./parsers');
    return parseGenericRows(html);
  }

  /**
   * Cari informasi mahasiswa lengkap: judul TA, dosen pembimbing & penguji,
   * serta riwayat semua sidang (Sempro, Semhas, Pendadaran).
   * Menggabungkan sumber data dari e-TA dan e-room (kalender komprehensif se-FT).
   * @param {string} query - Nama atau NIM mahasiswa.
   */
  async cariMahasiswa(query = '') {
    const q = String(query || '').trim();
    if (!q) return { query: '', total: 0, matches: [] };

    await this._ensure();
    const qLower = q.toLowerCase();

    // 1. Ambil data judul skripsi, jadwal dashboard, dan jadwal e-room secara paralel
    const [judulData, dashData, eroomData] = await Promise.all([
      this.judulSkripsi({ q }).catch(() => ({ daftar: [] })),
      this.dashboard().catch(() => ({ jadwal: [] })),
      this.jadwalSeminarEroom({ q }).catch(() => ({ jadwal: [] })),
    ]);

    // Satukan jadwal dashboard dan e-room, prioritaskan e-room bila ada
    const rawAllJadwal = [
      ...(dashData.jadwal || []),
      ...(eroomData.jadwal || []),
    ];

    const seenEventKeys = new Set();
    const allJadwal = [];
    for (const j of rawAllJadwal) {
      const nameKey = (j.nama || (j.title || '').split(' - ')[0]).trim().toLowerCase();
      const eventKey = `${nameKey}_${j.jenis || ''}_${j.tanggal || ''}`;
      if (!seenEventKeys.has(eventKey)) {
        seenEventKeys.add(eventKey);
        allJadwal.push(j);
      }
    }

    const candidateMap = new Map();

    const findSchedulesForName = (nama) => {
      const nLower = String(nama || '').trim().toLowerCase();
      if (!nLower) return [];
      return allJadwal.filter((j) => {
        const titleName = (j.title || '').split(' - ')[0].trim().toLowerCase();
        return titleName.includes(nLower) || nLower.includes(titleName);
      });
    };

    const sortSchedules = (schedules) => {
      const typeWeight = {
        'Seminar Proposal': 1,
        'Seminar Hasil': 2,
        'Pendadaran': 3,
      };
      return [...schedules].sort((a, b) => {
        const tA = a.tanggal || '9999-99-99';
        const tB = b.tanggal || '9999-99-99';
        if (tA !== tB) return tA.localeCompare(tB);
        const wA = typeWeight[a.jenis] || 99;
        const wB = typeWeight[b.jenis] || 99;
        return wA - wB;
      });
    };

    const formatScheduleItem = (j) => {
      const parts = (j.title || '').split(' - ');
      const ruang = parts.length > 1 ? parts.slice(1).join(' - ').trim() : (j.ruang || null);
      return {
        jenis: j.jenis,
        tanggal: j.tanggal || null,
        jam: j.jam || null,
        jamSelesai: j.jamSelesai || null,
        ruang: ruang,
        token: j.token,
      };
    };

    // 2. Masukkan data dari judul skripsi
    for (const item of (judulData.daftar || [])) {
      const key = item.nim || item.nama.toLowerCase();
      const rawSchedules = findSchedulesForName(item.nama);
      const sortedSchedules = sortSchedules(rawSchedules).map(formatScheduleItem);

      candidateMap.set(key, {
        nama: item.nama,
        nim: item.nim,
        judul: item.judul,
        dosen: item.dosen || {},
        batasWaktu: item.batasWaktu,
        riwayatSidang: sortedSchedules,
      });
    }

    // 3. Masukkan data dari jadwal (dashboard & e-room) jika belum ada di candidateMap
    for (const j of allJadwal) {
      const titleName = (j.title || '').split(' - ')[0].trim();
      if (!titleName) continue;
      if (titleName.toLowerCase().includes(qLower)) {
        const key = titleName.toLowerCase();
        const exists = Array.from(candidateMap.values()).some((c) =>
          c.nama.toLowerCase() === titleName.toLowerCase()
        );
        if (!exists) {
          const rawSchedules = findSchedulesForName(titleName);
          const sortedSchedules = sortSchedules(rawSchedules).map(formatScheduleItem);
          candidateMap.set(key, {
            nama: titleName,
            nim: null,
            judul: null,
            dosen: {},
            batasWaktu: null,
            riwayatSidang: sortedSchedules,
          });
        }
      }
    }

    const matches = Array.from(candidateMap.values());

    // 4. Jika ada match yang nim/judul masih null, lengkapi via detailSidang
    for (const m of matches) {
      if ((!m.nim || !m.judul) && m.riwayatSidang && m.riwayatSidang.length > 0) {
        // Ambil event dengan token valid
        const targetEvent = m.riwayatSidang.find((e) => e.token) || m.riwayatSidang[0];
        if (targetEvent && targetEvent.token) {
          try {
            const detail = await this.detailSidang(targetEvent.token);
            if (detail.peserta && detail.peserta.nim) m.nim = detail.peserta.nim;
            if (detail.peserta && detail.peserta.prodi) m.prodi = detail.peserta.prodi;
            if (detail.judul) m.judul = detail.judul;
            if (detail.penilai && detail.penilai.length && Object.keys(m.dosen || {}).length === 0) {
              const dosenObj = {};
              detail.penilai.forEach((p) => {
                const roleKey = (p.peran || '').toLowerCase().replace(/\s+/g, '_');
                dosenObj[roleKey] = { nama: p.nama, nip: p.nip, prodi: p.prodi };
              });
              m.dosen = dosenObj;
            }
          } catch (_) {}
        }
      }
    }

    return { query: q, total: matches.length, matches };
  }

  /**
   * Hitung data statistik sidang: berapa orang Sempro, Semhas, dan Pendadaran.
   * Mendukung sumber data dari e-room (seluruh Fakultas Teknik: 3.000+ data),
   * e-TA dashboard, atau gabungan.
   * @param {object} opts - { bulan, tahun, source } (source: 'eroom' | 'eta' | 'all')
   */
  async statistikSidang({ bulan = '', tahun = '', source = 'eroom' } = {}) {
    await this._ensure();

    let jadwal = [];
    if (source === 'eta') {
      const dash = await this.dashboard();
      jadwal = dash.jadwal || [];
    } else {
      // Default: gunakan e-room yang mencakup kalender komprehensif se-Fakultas Teknik
      const eroom = await this.jadwalSeminarEroom();
      jadwal = eroom.jadwal || [];
    }

    const monthlyMap = new Map();
    let totalSempro = 0;
    let totalSemhas = 0;
    let totalPdd = 0;
    let belumTerjadwal = 0;

    for (const item of jadwal) {
      const isSempro = item.jenis === 'Seminar Proposal';
      const isSemhas = item.jenis === 'Seminar Hasil';
      const isPdd = item.jenis === 'Pendadaran';

      if (isSempro) totalSempro++;
      else if (isSemhas) totalSemhas++;
      else if (isPdd) totalPdd++;

      const ym = (item.tanggal || '').slice(0, 7);
      if (!ym) {
        belumTerjadwal++;
        continue;
      }

      if (!monthlyMap.has(ym)) {
        monthlyMap.set(ym, {
          bulan: ym,
          sempro: 0,
          semhas: 0,
          pendadaran: 0,
          total: 0,
          jadwalList: [],
        });
      }
      const entry = monthlyMap.get(ym);
      entry.total++;
      if (isSempro) entry.sempro++;
      else if (isSemhas) entry.semhas++;
      else if (isPdd) entry.pendadaran++;
      entry.jadwalList.push({
        title: item.title,
        tanggal: item.tanggal,
        jam: item.jam,
        jenis: item.jenis,
        token: item.token,
      });
    }

    const sortedMonths = Array.from(monthlyMap.values()).sort((a, b) => b.bulan.localeCompare(a.bulan));

    let targetMonthData = null;
    let targetYearData = null;

    if (bulan) {
      targetMonthData = sortedMonths.find((m) => m.bulan === bulan) || {
        bulan,
        sempro: 0,
        semhas: 0,
        pendadaran: 0,
        total: 0,
        jadwalList: [],
      };
    }

    if (tahun) {
      const yearMonths = sortedMonths.filter((m) => m.bulan.startsWith(tahun));
      targetYearData = {
        tahun,
        sempro: yearMonths.reduce((sum, m) => sum + m.sempro, 0),
        semhas: yearMonths.reduce((sum, m) => sum + m.semhas, 0),
        pendadaran: yearMonths.reduce((sum, m) => sum + m.pendadaran, 0),
        total: yearMonths.reduce((sum, m) => sum + m.total, 0),
        bulanList: yearMonths,
      };
    }

    return {
      totalSemua: jadwal.length,
      global: {
        sempro: totalSempro,
        semhas: totalSemhas,
        pendadaran: totalPdd,
        belumTerjadwal,
        totalTerjadwal: jadwal.length - belumTerjadwal,
      },
      perBulan: sortedMonths,
      targetBulan: targetMonthData,
      targetTahun: targetYearData,
    };
  }
}

module.exports = { EtaService };