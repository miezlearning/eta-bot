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
} = require('./parsers');
const config = require('../config');

class EtaService {
  constructor(creds = config.credentials) {
    this.credentials = creds;
    this.client = null;
    this.connected = false;
    this.lastLoginAt = null;
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

  /** GET data detail sidang per token. */
  async detailSidang(token) {
    const html = await this._get(`/mahasiswa/e-ta/informasi_skripsi/${encodeURIComponent(token)}`);
    return parseInformasiSkripsi(html);
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
   * @param {string} query - Nama atau NIM mahasiswa.
   */
  async cariMahasiswa(query = '') {
    const q = String(query || '').trim();
    if (!q) return { query: '', total: 0, matches: [] };

    await this._ensure();
    const qLower = q.toLowerCase();

    // 1. Ambil data judul skripsi & jadwal dashboard secara paralel
    const [judulData, dashData] = await Promise.all([
      this.judulSkripsi({ q }),
      this.dashboard(),
    ]);

    const allJadwal = dashData.jadwal || [];
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
      const ruang = parts.length > 1 ? parts.slice(1).join(' - ').trim() : null;
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

    // 3. Masukkan data dari jadwal dashboard jika belum ada di candidateMap
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

    // 4. Jika hanya 1 match dan nim/judul masih null, lengkapi via detailSidang
    if (matches.length === 1 && (!matches[0].nim || !matches[0].judul)) {
      const firstEvent = matches[0].riwayatSidang[0];
      if (firstEvent && firstEvent.token) {
        try {
          const detail = await this.detailSidang(firstEvent.token);
          if (detail.peserta && detail.peserta.nim) matches[0].nim = detail.peserta.nim;
          if (detail.peserta && detail.peserta.prodi) matches[0].prodi = detail.peserta.prodi;
          if (detail.judul) matches[0].judul = detail.judul;
          if (detail.penilai && detail.penilai.length) {
            const dosenObj = {};
            detail.penilai.forEach((p) => {
              const roleKey = (p.peran || '').toLowerCase().replace(/\s+/g, '_');
              dosenObj[roleKey] = { nama: p.nama, nip: p.nip, prodi: p.prodi };
            });
            matches[0].dosen = dosenObj;
          }
        } catch (_) {}
      }
    }

    return { query: q, total: matches.length, matches };
  }

  /**
   * Hitung data statistik sidang: berapa orang Sempro, Semhas, dan Pendadaran.
   * @param {object} opts - { bulan, tahun }
   */
  async statistikSidang({ bulan = '', tahun = '' } = {}) {
    await this._ensure();
    const dash = await this.dashboard();
    const jadwal = dash.jadwal || [];

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