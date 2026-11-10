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
}

module.exports = { EtaService };