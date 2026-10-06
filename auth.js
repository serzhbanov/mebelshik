const crypto = require('crypto');

const COOKIE = 'session';
const MAX_AGE = 30 * 24 * 60 * 60; // 30 дней, в секундах

const USER = process.env.AUTH_USER || 'admin';
const PASSWORD = process.env.AUTH_PASSWORD || '';
// Без SESSION_SECRET сессии сбрасываются при каждом перезапуске сервера
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const enabled = Boolean(PASSWORD);

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const sign = payload => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function checkCredentials(user, password) {
  // Обе проверки выполняются всегда, чтобы время ответа не выдавало верный логин
  const userOk = safeEqual(user, USER);
  const passOk = safeEqual(password, PASSWORD);
  return enabled && userOk && passOk;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function isAuthenticated(req) {
  if (!enabled) return true;
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const [expires, sig] = token.split('.');
  if (!sig || Number(expires) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(`${USER}:${expires}`));
}

function cookieAttrs(req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function sessionCookie(req) {
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE;
  return `${COOKIE}=${expires}.${sign(`${USER}:${expires}`)}; Max-Age=${MAX_AGE}; ${cookieAttrs(req)}`;
}

function clearCookie(req) {
  return `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`;
}

module.exports = { enabled, checkCredentials, isAuthenticated, sessionCookie, clearCookie };
