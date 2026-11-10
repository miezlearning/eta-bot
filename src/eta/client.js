/**
 * Client session untuk sistem e-TA (e-Tugas Akhir) FT Unmul.
 *
 * Menangani login dan request HTTP ke aplikasi Laravel yang live,
 * mempertahankan cookie/session dan token CSRF di dalam memori.
 */
const axios = require('axios');
const tough = require('tough-cookie');
const config = require('../config');

const BASE = config.baseUrl;

/** Ambil token CSRF `_token` dari halaman HTML. */
function extractCsrfToken(html) {
  const m = html.match(/name=["']?_token["']?\s+value=["']([^"']+)["']/i)
        || html.match(/value=["']([^"']+)["']\s+name=["']?_token["']/i);
  return m ? m[1] : null;
}

/** Helper: resolve URL absolut dari config axios (karena config.url path relatif). */
function resolveUrl(config) {
  return new URL(config.url || '', config.baseURL || '').toString();
}

/**
 * Membuat instance axios dengan jar cookie untuk mengelola session.
 */
function createAxiosInstance() {
  const jar = new tough.CookieJar();
  const client = axios.create({
    baseURL: BASE,
    timeout: config.timeout,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'id,en-US;q=0.9,en;q=0.8',
    },
    withCredentials: true,
  });

  // Request interceptor: kirim cookie dari jar.
  client.interceptors.request.use(async (c) => {
    const fullUrl = resolveUrl(c);
    const cookieHeader = await jar.getCookieString(fullUrl);
    if (cookieHeader) {
      c.headers = c.headers || {};
      c.headers.Cookie = cookieHeader;
    }
    return c;
  });

  // Response interceptor: simpan cookie dari Set-Cookie ke jar.
  client.interceptors.response.use((res) => {
    const setCookies = res.headers['set-cookie'];
    if (setCookies && setCookies.length) {
      setCookies.forEach((sc) => {
        const fullUrl = resolveUrl(res.config);
        jar.setCookieSync(sc, fullUrl, { ignoreError: true });
      });
    }
    return res;
  });

  return client;
}

/**
 * Melakukan login ke sistem e-TA.
 * @param {{userid,password,role}} cred
 * @returns {Promise<boolean>} true jika berhasil login.
 */
async function login(client, cred = config.credentials) {
  // 1. GET halaman login untuk dapat CSRF token.
  const loginPage = await client.get('/e-ta');
  const token = extractCsrfToken(loginPage.data);
  if (!token) throw new Error('Gagal mengambil token CSRF dari halaman login');

  // 2. POST kredensial ke proses_login_eta dengan urlencoded.
  const body = new URLSearchParams();
  body.set('_token', token);
  body.set('userid2', cred.userid);
  body.set('password', cred.password);
  body.set('role', cred.role || 'Mahasiswa');

  const res = await client.post('/user/proses_login_eta', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0, // tangani redirect manual
    validateStatus: () => true,
  });

  // Setelah login biasanya redirect ke dashboard (302) dengan Location.
  const loc = res.headers.location || '';
  const success = res.status === 302 && loc.includes('/mahasiswa/e-ta/')
                  || res.status === 200 && (res.data.includes('Selamat Datang') || res.data.includes('Mahasiswa FT Unmul'));

  return success;
}

module.exports = { createAxiosInstance, login, extractCsrfToken, resolveUrl };