/**
 * REST API untuk sistem e-TA (e-Tugas Akhir) FT Unmul.
 *
 * Service ini login otomatis ke aplikasi live e-office.ft.unmul.ac.id
 * lalu mengekspos data sebagai endpoint REST JSON.
 *
 * Jalankan: node server.js
 */
const express = require('express');
const config = require('./src/config');
const { EtaService } = require('./src/eta/service');
const { ChangeNotifier } = require('./src/eta/notifier');

const app = express();
app.use(express.json());
app.disable('x-powered-by');

// Instance service global (menggunakan kredensial dari .env)
const svc = new EtaService(config.credentials);
// Notifier perubahan jadwal sidang (aktif jika TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID diisi)
const notifier = new ChangeNotifier(config.notifier);

/** Cek perubahan jadwal sekali; aman dipanggil berulang (tidak double-kirim untuk data sama). */
async function pollJadwalOnce() {
  try {
    const data = await svc.jadwalSkripsi();
    const res = await notifier.check(data.jadwal, data.identity);
    if (res.changes > 0) {
      console.log(
        `[notifier] ${res.changes} perubahan jadwal (baru=${res.perubahan.baru.length}, berubah=${res.perubahan.berubah.length}, hilang=${res.perubahan.hilang.length})`
      );
    }
  } catch (e) {
    // Jangan crash scheduler karena satu fetch gagal.
    console.error(`[notifier] gagal cek jadwal: ${e.message}`);
  }
}

/** Helper: wrapper error handling. */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// --- Bot Telegram (polling otomatis & webhook di VPS/Coolify) ---
const { handleUpdate, startPolling, stopPolling } = require('./bot/bot');

app.post('/api/webhook', (req, res) => {
  // Verifikasi secret header untuk keamanan (sama dengan api/webhook.js).
  const secret = config.bot.secret;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  // Ack cepat ke Telegram, lalu proses di background (server persisten sudah aman).
  res.status(200).json({ ok: true });
  handleUpdate(req.body).catch((e) => console.error('[webhook] error:', e.message));
});

// --- Middleware: pastikan session aktif sebelum semua route di bawah ini ---
app.use('/api', async (req, res, next) => {
  try {
    await svc.connect();
    next();
  } catch (e) {
    res.status(502).json({ error: 'Gagal menghubungkan ke sistem e-TA', detail: e.message });
  }
});

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'e-TA FT Unmul REST API',
    connected: svc.connected,
    lastLoginAt: svc.lastLoginAt,
    notifier: {
      enabled: notifier.enabled,
      intervalMs: config.notifier.intervalMs,
      lastNotifiedAt: notifier.log.length ? notifier.log[notifier.log.length - 1].at : null,
      totalNotified: notifier.log.length,
    },
    version: '1.0.0',
  });
});

// --- Dashboard: jadwal sidang hari ini dari beranda ---
app.get('/api/dashboard', asyncHandler(async (req, res) => {
  const data = await svc.dashboard();
  res.json(data);
}));

// --- Jadwal sidang (kalender) ---
app.get('/api/jadwal/sidang', asyncHandler(async (req, res) => {
  const { enrich, q, nama, nim, prodi, useCache } = req.query;
  const data = await svc.jadwalSkripsi({
    enrich: enrich === 'true' || enrich === '1',
    useCache: useCache === undefined || useCache === 'true' || useCache === '1',
    q: q || '',
    nama: nama || '',
    nim: nim || '',
    prodi: prodi || '',
  });
  res.json(data);
}));

// --- Daftar judul skripsi ---
app.get('/api/judul-skripsi', asyncHandler(async (req, res) => {
  const { q, nama, nim, prodi } = req.query;
  const data = await svc.judulSkripsi({
    q: q || '',
    nama: nama || '',
    nim: nim || '',
    prodi: prodi || '',
  });
  res.json(data);
}));

// --- Data per jenis seminar (proposal / hasil / pendadaran) ---
app.get('/api/data/proposal', asyncHandler(async (req, res) => {
  res.json(await svc.dataProposal());
}));
app.get('/api/data/hasil', asyncHandler(async (req, res) => {
  res.json(await svc.dataHasil());
}));
app.get('/api/data/pendadaran', asyncHandler(async (req, res) => {
  res.json(await svc.dataPendadaran());
}));

// --- Bimbingan & seminar skripsi ---
app.get('/api/bimbingan', asyncHandler(async (req, res) => {
  res.json(await svc.bimbinganSkripsi());
}));
app.get('/api/seminar', asyncHandler(async (req, res) => {
  res.json(await svc.seminarSkripsi());
}));

// --- Detail sidang per token ---
app.get('/api/sidang/:token', asyncHandler(async (req, res) => {
  const data = await svc.detailSidang(req.params.token);
  res.json(data);
}));

// --- Profil mahasiswa lengkap (nilai, publikasi, dll) ---
app.get('/api/profil', asyncHandler(async (req, res) => {
  const data = await svc.profilMahasiswa();
  res.json(data);
}));

// --- Ruang seminar per prodi ---
app.get('/api/ruang', asyncHandler(async (req, res) => {
  const data = await svc.ruangSeminar();
  res.json(data);
}));

// --- Root ---
app.get('/', (req, res) => {
  res.json({
    service: 'e-TA FT Unmul REST API',
    endpoints: {
      health: '/api/health',
      dashboard: '/api/dashboard',
      'jadwal (search)': '/api/jadwal/sidang?nama=&nim=&prodi=&q=&enrich=',
      'judul (search)': '/api/judul-skripsi?nama=&nim=&q=',
      'data proposal': '/api/data/proposal',
      'data hasil': '/api/data/hasil',
      'data pendadaran': '/api/data/pendadaran',
      bimbingan: '/api/bimbingan',
      seminar: '/api/seminar',
      detail: '/api/sidang/:token',
      profil: '/api/profil',
      ruang: '/api/ruang',
    },
  });
});

// --- Error handler ---
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: 'Terjadi kesalahan internal',
    detail: err.message,
  });
});

// --- Start ---
app.listen(config.api.port, async () => {
  console.log(`e-TA REST API berjalan di http://localhost:${config.api.port}`);

  // Bot Telegram: Long polling otomatis berjalan jika TELEGRAM_BOT_TOKEN diset
  if (config.bot.botToken) {
    startPolling().catch((e) => console.error('[bot] Gagal memulai polling:', e.message));
  } else {
    console.log('[bot] Bot Telegram nonaktif (TELEGRAM_BOT_TOKEN belum diset di environment)');
  }

  if (notifier.enabled) {
    console.log(`[notifier] Telegram aktif, cek perubahan tiap ${Math.round(config.notifier.intervalMs / 1000)} detik`);
    // Jalankan sekali untuk mengisi snapshot awal (tanpa kirim), lalu berjalan berkala.
    await pollJadwalOnce();
    setInterval(() => pollJadwalOnce(), config.notifier.intervalMs);
  } else {
    console.log('[notifier] Telegram nonaktif (atur TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID untuk mengaktifkan)');
  }
});

// Penanganan graceful shutdown
process.on('SIGTERM', () => {
  console.log('Menerima SIGTERM, mematikan server & polling...');
  stopPolling();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('Menerima SIGINT, mematikan server & polling...');
  stopPolling();
  process.exit(0);
});