const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const BASE_DIR = __dirname;
const HTML_PATH = path.join(BASE_DIR, 'index.html');
const CONFIG_PATH = path.join(BASE_DIR, 'colecoes.json');
const REBUILD_SCRIPT = path.join(BASE_DIR, 'rebuild.js');
const UPLOADS_DIR = path.join(BASE_DIR, 'uploads');

const SCRIPT_INJECT = '<script>window.__SERVER__=true</script>';
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const TPL_PATH = path.join(BASE_DIR, 'page_template.html');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function getUploadCards() {
  if (!fs.existsSync(UPLOADS_DIR)) return [];
  const extMap = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image', '.svg': 'image', '.stl': 'model', '.obj': 'model', '.zip': 'archive', '.rar': 'archive', '.7z': 'archive' };
  const thumbExt = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.gif': 1, '.webp': 1, '.bmp': 1, '.svg': 1 };
  const files = fs.readdirSync(UPLOADS_DIR);
  const items = [];
  for (const f of files) {
    if (f === '.gitkeep') continue;
    const ext = path.extname(f).toLowerCase();
    const name = path.basename(f, ext).replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    const enc = encodeURIComponent(f);
    if (thumbExt[ext]) {
      items.push({ title: name, sub: 'Arquivo local', img: '/uploads/' + enc, link: '/uploads/' + enc, label: 'Abrir' });
    } else {
      items.push({ title: name, sub: (extMap[ext] || 'Arquivo') + ' local', img: '', link: '/uploads/' + enc, label: 'Baixar' });
    }
  }
  return items;
}

function quickRebuildAfterUpload() {
  const cachedPath = path.join(CACHE_DIR, 'new_collections.js');
  if (!fs.existsSync(cachedPath)) return false;
  if (!fs.existsSync(TPL_PATH)) return false;
  let cached = fs.readFileSync(cachedPath, 'utf-8');
  const uploadCards = getUploadCards();
  if (uploadCards.length === 0) return true;

  const sanitize = s => (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let uploadItemsJs = '';
  for (const it of uploadCards) {
    const t = sanitize(it.title);
    const s = sanitize(it.sub);
    uploadItemsJs += '      { title: "' + t + '", sub: "' + s + '", img: "' + it.img + '", link: "' + it.link + '", label: "' + it.label + '" },\n';
  }

  try {
    const fn = new Function('return (' + cached.replace(/^var COLLECTIONS\s*=\s*/, '') + ')');
    const collections = fn();
    const filtered = collections.filter(c => c.name !== 'Enviados');
    filtered.push({ name: 'Enviados', items: uploadCards.map(it => ({ title: it.title, sub: it.sub, img: it.img, link: it.link, label: it.label })) });
    let js = 'var COLLECTIONS = ' + JSON.stringify(filtered, null, 2) + ';\n';
    fs.writeFileSync(cachedPath, js, 'utf-8');
    const tpl = fs.readFileSync(TPL_PATH, 'utf-8');
    const page = tpl.replace('__COLLECTIONS__', js);
    fs.writeFileSync(HTML_PATH, page, 'utf-8');
    return true;
  } catch (e) {
    console.error('quickRebuild failed:', e.message);
    return false;
  }
}

let rebuildState = { running: false, output: '', exitCode: null, done: false };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function readBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  let start = buffer.indexOf(boundaryBuf) + boundaryBuf.length + 2;
  while (true) {
    let end = buffer.indexOf(boundaryBuf, start);
    if (end === -1) break;
    const part = buffer.slice(start, end - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = end + boundaryBuf.length + 2; continue; }
    const headers = part.slice(0, headerEnd).toString('utf-8');
    const body = part.slice(headerEnd + 4);
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const contentTypeMatch = headers.match(/Content-Type:\s*(.+)/i);
    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : '',
      data: body,
    });
    start = end + boundaryBuf.length + 2;
  }
  return parts;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.stl': 'model/stl',
      '.obj': 'model/obj',
      '.zip': 'application/zip',
      '.rar': 'application/vnd.rar',
      '.7z': 'application/x-7z-compressed',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      fs.readFile(HTML_PATH, 'utf-8', (err, html) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('500 Internal Server Error');
          return;
        }
        const lastScriptIndex = html.lastIndexOf('<script');
        if (lastScriptIndex === -1) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('500 Internal Server Error');
          return;
        }
        const modified = html.slice(0, lastScriptIndex) + SCRIPT_INJECT + '\n' + html.slice(lastScriptIndex);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(modified);
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/config') {
      fs.readFile(CONFIG_PATH, 'utf-8', (err, data) => {
        if (err) {
          sendJson(res, 500, { error: 'Failed to read config' });
          return;
        }
        if (data.charCodeAt(0) === 0xFEFF) data = data.slice(1);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/config') {
      readBody(req).then(body => {
        fs.writeFile(CONFIG_PATH, JSON.stringify(body, null, 2), 'utf-8', err => {
          if (err) {
            sendJson(res, 500, { error: 'Failed to save config' });
            return;
          }
          sendJson(res, 200, { ok: true });
        });
      }).catch(() => {
        sendJson(res, 400, { error: 'Invalid JSON body' });
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/upload') {
      const ct = req.headers['content-type'] || '';
      const boundaryMatch = ct.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        sendJson(res, 400, { error: 'No multipart boundary' });
        return;
      }
      const boundary = boundaryMatch[1];
      readBodyRaw(req).then(buffer => {
        const parts = parseMultipart(buffer, boundary);
        const saved = [];
        for (const part of parts) {
          if (part.filename) {
            const safeName = part.filename.replace(/[<>:"/\\|?*]/g, '_');
            const dest = path.join(UPLOADS_DIR, safeName);
            fs.writeFileSync(dest, part.data);
            saved.push({ name: safeName, size: part.data.length });
          }
        }
        quickRebuildAfterUpload();
        sendJson(res, 200, { ok: true, files: saved });
      }).catch(e => {
        sendJson(res, 500, { error: e.message });
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/uploads') {
      const files = fs.readdirSync(UPLOADS_DIR).map(name => {
        const stat = fs.statSync(path.join(UPLOADS_DIR, name));
        return { name, size: stat.size, modified: stat.mtime.toISOString() };
      });
      sendJson(res, 200, files);
      return;
    }

    if (req.method === 'DELETE' && req.url.startsWith('/api/uploads/')) {
      const fileName = decodeURIComponent(req.url.slice('/api/uploads/'.length));
      const filePath = path.join(UPLOADS_DIR, fileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        quickRebuildAfterUpload();
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 404, { error: 'File not found' });
      }
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/api/rebuild')) {
      if (rebuildState.running) {
        sendJson(res, 200, { ok: true, message: 'Rebuild already in progress' });
        return;
      }
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const refresh = urlObj.searchParams.get('refresh') === '1';
      const args = [REBUILD_SCRIPT];
      if (refresh) args.push('--refresh');
      rebuildState = { running: true, output: '', exitCode: null, done: false };
      const child = spawn(process.execPath, args, {
        cwd: BASE_DIR,
        windowsHide: true,
      });
      child.stdout.on('data', chunk => { rebuildState.output += chunk.toString('utf-8'); });
      child.stderr.on('data', chunk => { rebuildState.output += chunk.toString('utf-8'); });
      child.on('close', code => {
        rebuildState.running = false;
        rebuildState.exitCode = code;
        rebuildState.done = true;
      });
      child.on('error', () => {
        rebuildState.running = false;
        rebuildState.exitCode = -1;
        rebuildState.done = true;
        rebuildState.output += '\nFailed to spawn rebuild process';
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      sendJson(res, 200, rebuildState);
      return;
    }

    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }
    const filePath = path.join(BASE_DIR, urlPath);
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      serveFile(res, filePath);
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log('Servidor: http://localhost:3000');
});
