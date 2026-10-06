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

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/login') {
      if (req.method === 'GET') return auth.isAuthenticated(req) ? redirect(res, '/') : sendHtml(res, LOGIN_HTML);
      if (req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        if (auth.checkCredentials(form.get('username') || '', form.get('password') || '')) {
          return redirect(res, '/', auth.sessionCookie(req));
        }
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
      sendJson(res, 200, { rows: parseSpreadsheet(await readBody(req)) });
    } else if (req.method === 'POST' && pathname === '/api/prices') {
      const { articles } = JSON.parse((await readBody(req)).toString('utf8'));
      if (!Array.isArray(articles) || !articles.length) return sendJson(res, 400, { error: 'Список артикулов пуст' });
      const { products, missing } = await fetchProducts(articles);
      sendJson(res, 200, { products, missing, xml: buildXml(products) });
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

if (!auth.enabled) console.warn('AUTH_PASSWORD не задан — вход без пароля');
server.listen(PORT, () => console.log(`Сервис запущен: http://localhost:${PORT}`));
