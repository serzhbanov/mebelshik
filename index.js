const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseSpreadsheet, fetchProducts, buildXml } = require('./viyar');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const MAX_BODY = 20 * 1024 * 1024;
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
const LOGIN_HTML = path.join(__dirname, 'public', 'login.html');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Файл слишком большой'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendHtml(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function redirect(res, location, cookie) {
  res.writeHead(303, { Location: location, ...(cookie && { 'Set-Cookie': cookie }) });
  res.end();
}

const clientIp = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(`[http] ${req.method} ${req.url} → ${res.statusCode} (${Date.now() - started} мс) ${clientIp(req)}`);
  });
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/login') {
      if (req.method === 'GET') return auth.isAuthenticated(req) ? redirect(res, '/') : sendHtml(res, LOGIN_HTML);
      if (req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        const username = form.get('username') || '';
        if (auth.checkCredentials(username, form.get('password') || '')) {
          console.log(`[auth] вход выполнен: ${username} ${clientIp(req)}`);
          return redirect(res, '/', auth.sessionCookie(req));
        }
        console.warn(`[auth] неверный логин или пароль: "${username}" ${clientIp(req)}`);
        await new Promise(r => setTimeout(r, 1000)); // притормаживаем перебор паролей
        return redirect(res, '/login?error=1');
      }
    }
    if (pathname === '/logout') return redirect(res, '/login', auth.clearCookie(req));

    if (!auth.isAuthenticated(req)) {
      return pathname.startsWith('/api/') ? sendJson(res, 401, { error: 'Требуется вход' }) : redirect(res, '/login');
    }

    if (req.method === 'GET' && pathname === '/') {
      sendHtml(res, INDEX_HTML);
    } else if (req.method === 'POST' && pathname === '/api/parse') {
      const rows = parseSpreadsheet(await readBody(req));
      console.log(`[parse] файл прочитан: ${rows.length} арт., из них Вияр: ${rows.filter(r => r.isViyar).length}`);
      sendJson(res, 200, { rows });
    } else if (req.method === 'POST' && pathname === '/api/prices') {
      const { articles } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!Array.isArray(articles) || !articles.length) return sendJson(res, 400, { error: 'Список артикулов пуст' });
      console.log(`[prices] запрошено ${articles.length} арт.`);
      const { products, missing } = await fetchProducts(articles);
      const xml = buildXml(products);
      console.log(`[prices] XML сформирован: ${products.length} материалов, ${Buffer.byteLength(xml)} байт`);
      sendJson(res, 200, { products, missing, xml });
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    console.error(`[error] ${req.method} ${req.url}:`, err);
    sendJson(res, 500, { error: err.message });
  }
});

if (!auth.enabled) console.warn('AUTH_PASSWORD не задан — вход без пароля');
server.listen(PORT, () => console.log(`Сервис запущен: http://localhost:${PORT}`));
