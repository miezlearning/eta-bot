/**
 * Skrip uji coba cepat: login ke e-TA dan tes parsing beberapa halaman.
 * Jalankan: node test.js
 */
require('dotenv').config();
const { EtaService } = require('./src/eta/service');

(async () => {
  const svc = new EtaService();
  console.log('=== Mencoba login ke e-TA ===');
  try {
    await svc.connect();
    console.log('Login berhasil!');
    console.log('Last login:', svc.lastLoginAt);

    console.log('\n=== Dashboard (jadwal sidang) ===');
    const dash = await svc.dashboard();
    console.log('Identity:', JSON.stringify(dash.identity));
    console.log('Jumlah jadwal:', dash.jadwal ? dash.jadwal.length : 0);
    if (dash.jadwal && dash.jadwal.length) {
      console.log('Contoh:', JSON.stringify(dash.jadwal[0]));
    }

    console.log('\n=== Jadwal Sidang (kalender) ===');
    const jadwal = await svc.jadwalSkripsi();
    console.log('Jumlah jadwal:', jadwal.jadwal ? jadwal.jadwal.length : 0);
    if (jadwal.jadwal && jadwal.jadwal.length) {
      console.log('Contoh:', JSON.stringify(jadwal.jadwal[0]));
    }

    console.log('\n=== Judul Skripsi ===');
    const judul = await svc.judulSkripsi();
    console.log('Jumlah judul:', judul.daftar ? judul.daftar.length : 0);
    if (judul.daftar && judul.daftar.length) {
      console.log('Contoh:', JSON.stringify(judul.daftar[0]));
    }

    console.log('\n=== Profil Mahasiswa ===');
    const profil = await svc.profilMahasiswa();
    console.log('Identity:', JSON.stringify(profil.identity));
    console.log('Jumlah nilai:', profil.nilai ? profil.nilai.length : 0);
    if (profil.nilai && profil.nilai.length) {
      console.log('Contoh nilai:', JSON.stringify(profil.nilai[0]));
    }

    console.log('\n Semua tes berhasil!');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();