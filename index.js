const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseSpreadsheet, fetchProducts, buildXml } = require('./viyar');

const PORT = process.env.PORT || 3000;
const MAX_BODY = 20 * 1024 * 1024;
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(INDEX_HTML).pipe(res);
    } else if (req.method === 'POST' && req.url === '/api/parse') {
      sendJson(res, 200, { rows: parseSpreadsheet(await readBody(req)) });
    } else if (req.method === 'POST' && req.url === '/api/prices') {
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

server.listen(PORT, () => console.log(`Сервис запущен: http://localhost:${PORT}`));
