/**
 * Notifikasi perubahan jadwal sidang via Telegram Bot.
 *
 * Alur kerja:
 *   - Satu instance ChangeNotifier menyimpan snapshot terakhir (Map token -> fingerprint).
 *   - Setiap interval, server memanggil `check(jadwal, identity)` dengan data terbaru.
 *   - Notifier membandingkan dengan snapshot dan menghasilkan 3 kategori:
 *       * baru    (token belum pernah terlihat)
 *       * berubah (token ada tapi isinya beda)
 *       * hilang  (token di snapshot lama tapi tidak ada lagi)
 *   - Jika ada perubahan & konfigurasi Telegram lengkap, kirim pesan via Bot API.
 *
 * Penggunaan:
 *   const { ChangeNotifier } = require('./notifier');
 *   const notifier = new ChangeNotifier(telegramConfig);
 *   ...
 *   await notifier.check(data.jadwal, identity);
 */

/** Fingerprint stabil per item (cukup untuk membandingkan isi jadwal). */
function fingerprint(item) {
  return JSON.stringify({
    title: item.title,
    tanggal: item.tanggal,
    jam: item.jam,
    jamSelesai: item.jamSelesai,
    jenis: item.jenis,
    url: item.url,
  });
}

class ChangeNotifier {
  /**
   * @param {object} cfg
   * @param {string} cfg.botToken  Token bot Telegram (opsional; nonaktif jika kosong).
   * @param {string} cfg.chatId    Chat/group ID tujuan (opsional).
   */
  constructor(cfg = {}) {
    this.botToken = cfg.botToken || '';
    this.chatId = cfg.chatId || '';
    this.snapshot = new Map(); // token -> { fp, ...item } (last known)
    this.log = [];
  }

  get enabled() {
    return !!(this.botToken && this.chatId);
  }

  /** Bandingkan daftar jadwal terbaru dengan snapshot; kirim notifikasi jika ada perubahan. */
  async check(jadwal = [], identity = {}) {
    // Kelompokkan data baru per token (last occurrence wins bila ada duplikat).
    const latest = new Map();
    for (const item of jadwal) {
      if (!item.token) continue;
      latest.set(item.token, item);
    }

    const perubahan = { baru: [], berubah: [], hilang: [] };

    // 1) Item yang muncul / berubah.
    for (const [token, item] of latest.entries()) {
      const fp = fingerprint(item);
      const prev = this.snapshot.get(token);
      if (!prev) {
        perubahan.baru.push(item);
      } else if (prev.fp !== fp) {
        perubahan.berubah.push(item);
      }
    }

    // 2) Item yang hilang dari snapshot (dulu ada, sekarang tidak).
    for (const token of this.snapshot.keys()) {
      if (!latest.has(token)) {
        perubahan.hilang.push(this.snapshot.get(token));
      }
    }

    // Simpan snapshot terbaru.
    this.snapshot = new Map(
      [...latest.entries()].map(([token, item]) => [token, { fp: fingerprint(item), ...item }])
    );

    const total = perubahan.baru.length + perubahan.berubah.length + perubahan.hilang.length;
    if (total === 0) return { changes: 0, sent: 0, perubahan };

    const sent = this.enabled ? await this._send(perubahan, identity) : 0;
    if (sent > 0) this.log.push({ at: new Date().toISOString(), ...perubahan });
    return { changes: total, sent, perubahan };
  }

  /** Kirim pesan ringkas perubahan ke Telegram. */
  async _send(perubahan, identity = {}) {
    const lines = [];
    lines.push('📋 *e-TA · Jadwal Sidang Baru*');
    if (identity.nama) lines.push(`Mahasiswa: ${identity.nama} (${identity.nim || ''})`);
    lines.push('');

    if (perubahan.baru.length) {
      lines.push(`🆕 *Baru* (${perubahan.baru.length})`);
      for (const i of perubahan.baru.slice(0, 5)) {
        lines.push(`• ${i.tanggal} ${i.jam} — ${i.title} (${i.jenis})`);
      }
      if (perubahan.baru.length > 5) lines.push(`  …dan ${perubahan.baru.length - 5} lagi`);
      lines.push('');
    }
    if (perubahan.berubah.length) {
      lines.push(`✏️ *Berubah* (${perubahan.berubah.length})`);
      for (const i of perubahan.berubah.slice(0, 5)) {
        lines.push(`• ${i.tanggal} ${i.jam} — ${i.title} (${i.jenis})`);
      }
      if (perubahan.berubah.length > 5) lines.push(`  …dan ${perubahan.berubah.length - 5} lagi`);
      lines.push('');
    }
    if (perubahan.hilang.length) {
      lines.push(`🗑 *Hilang* (${perubahan.hilang.length})`);
      for (const i of perubahan.hilang.slice(0, 5)) {
        lines.push(`• ${i.tanggal} ${i.jam} — ${i.title}`);
      }
      if (perubahan.hilang.length > 5) lines.push(`  …dan ${perubahan.hilang.length - 5} lagi`);
    }

    const text = lines.join('\n').trim();
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`[notifier] Telegram mengembalikan ${res.status}: ${body.slice(0, 200)}`);
        return 0;
      }
      return 1;
    } catch (e) {
      console.error(`[notifier] Gagal kirim ke Telegram: ${e.message}`);
      return 0;
    }
  }
}

module.exports = { ChangeNotifier, fingerprint };