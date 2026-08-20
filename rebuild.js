#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const BASE_DIR = __dirname;
const CACHE_DIR = path.join(BASE_DIR, 'cache');
const FOLDERS_DIR = path.join(CACHE_DIR, 'folders');
const CONFIG_PATH = path.join(BASE_DIR, 'colecoes.json');
const TPL_PATH = path.join(BASE_DIR, 'page_template.html');
const OUT_PATH = path.join(BASE_DIR, 'index.html');
const SNAP_PATH = path.join(CACHE_DIR, 'snapshot.json');

const REFRESH = process.argv.includes('--refresh');

if (!fs.existsSync(FOLDERS_DIR)) fs.mkdirSync(FOLDERS_DIR, { recursive: true });

function log(msg) { process.stdout.write(msg + '\n'); }

function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function testGenericZip(name) {
  const n = norm(path.basename(name, path.extname(name)));
  return n === 'stl' || n === 'stlfiles' || n === 'stlfile' || n === 'stls';
}

function cleanTitle(zipName, folderLabel) {
  if (testGenericZip(zipName)) return folderLabel;
  let t = path.basename(zipName, path.extname(zipName))
    .replace(/\+/g, ' ').replace(/_/g, '').replace(/%20/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (norm(t) === 'stl' || norm(t) === 'stlfiles' || norm(t) === 'stlfile' || norm(t) === 'stls' || t.length === 0) return folderLabel;
  return t;
}

function getTokens(s) {
  const common = new Set(['fab365', 'foldable', 'caneca', 'stl', 'files', 'mug', 'set']);
  const base = path.basename(s, path.extname(s)).toLowerCase();
  return base.split(/[^a-z0-9]+/).filter(t => t.length >= 5 && !common.has(t) && !/^\d+$/.test(t));
}

function getZipScore(zipName, imgName) {
  const zn = norm(path.basename(zipName, path.extname(zipName)));
  const in_ = norm(path.basename(imgName, path.extname(imgName)));
  if (zn.length === 0 || in_.length === 0) return -1;
  if (zn === in_) return 1000;
  if (in_.includes(zn) || zn.includes(in_)) return 800;
  const zt = getTokens(zipName), it = getTokens(imgName);
  let score = 0;
  for (const t of zt) { if (it.includes(t)) score += t.length; }
  return score;
}

function sanitize(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getFolderId(url) {
  let m = url.match(/\/folders\/([^/?#]+)/);
  if (m) return m[1];
  m = url.match(/id=([^&]+)/);
  if (m) return m[1];
  throw new Error('URL invalida: ' + url);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── fetch HTML from Google Drive ──
function fetchHtml(id) {
  const url = `https://drive.google.com/drive/folders/${id}`;
  return new Promise((resolve) => {
    const opts = {
      hostname: 'drive.google.com',
      path: `/drive/folders/${id}`,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 40000,
    };
    const req = https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = new URL(res.headers.location, url);
        const opts2 = {
          hostname: loc.hostname,
          path: loc.pathname + loc.search,
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 40000,
        };
        const req2 = https.get(opts2, (res2) => {
          const chunks = [];
          res2.on('data', c => chunks.push(c));
          res2.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          res2.on('error', () => resolve(''));
        });
        req2.on('error', () => resolve(''));
        req2.on('timeout', () => { req2.destroy(); resolve(''); });
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', () => resolve(''));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

// ── unescape JS strings from Drive HTML ──
function unescapeJs(s) {
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  s = s.replace(/\\\//g, '/').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return s;
}

// ── parse items from Drive folder HTML ──
function getItems(html) {
  const items = [];

  // Method 1: _DRIVE_ivd data
  const m = html.match(/_DRIVE_ivd = '([^']+)';/);
  if (m) {
    try {
      const j = JSON.parse(unescapeJs(m[1]));
      if (Array.isArray(j) && Array.isArray(j[0])) {
        for (const e of j[0]) {
          items.push({ type: 'FILE', id: e[0], name: e[2], mime: e[3] });
        }
      }
    } catch (e) { /* ignore parse error */ }
  }

  // Method 2: data-tooltip fallback
  if (items.length === 0) {
    const re = /by9fbe38:([A-Za-z0-9_\-]+)-0-16[^>]*?data-tooltip="([^"]+)"/g;
    let mm;
    while ((mm = re.exec(html)) !== null) {
      const fid = mm[1];
      let tip = mm[2];
      let mime = '', name = tip;
      if (tip.endsWith(' Shared folder')) { mime = 'application/vnd.google-apps.folder'; name = tip.slice(0, -14); }
      else if (tip.endsWith(' Image')) { mime = 'image'; name = tip.slice(0, -6); }
      else if (tip.endsWith(' Compressed archive')) { mime = 'archive'; name = tip.slice(0, -19); }
      items.push({ type: 'FILE', id: fid, name: name, mime: mime });
    }
  }

  return items;
}

// ── fetch all items in a folder (up to 3 levels deep) ──
async function fetchFolderItems(id) {
  const all = [];
  const h = await fetchHtml(id);
  if (!h) return all;
  const top = getItems(h);
  const subDirs = top.filter(i => i.mime === 'application/vnd.google-apps.folder');
  for (const i of top.filter(i => i.mime !== 'application/vnd.google-apps.folder')) all.push(i);

  for (const sd of subDirs) {
    const h2 = await fetchHtml(sd.id);
    if (!h2) continue;
    const subAll = getItems(h2);
    const subSub = subAll.filter(i => i.mime === 'application/vnd.google-apps.folder');
    for (const i of subAll.filter(i => i.mime !== 'application/vnd.google-apps.folder')) all.push(i);

    for (const ssd of subSub) {
      const h3 = await fetchHtml(ssd.id);
      if (!h3) continue;
      for (const i of getItems(h3).filter(i => i.mime !== 'application/vnd.google-apps.folder')) all.push(i);
      await sleep(80);
    }
    await sleep(80);
  }
  return all;
}

// ── load a folder (with cache) ──
async function loadFolder(url, label) {
  const id = getFolderId(url);
  const cf = path.join(FOLDERS_DIR, id + '.json');
  if (!REFRESH && fs.existsSync(cf)) {
    try { return JSON.parse(fs.readFileSync(cf, 'utf-8')); } catch (e) { /* fallthrough */ }
  }
  log('FETCH ' + id + ' | ' + label);
  const items = await fetchFolderItems(id);
  const obj = { id, label, items };
  fs.writeFileSync(cf, JSON.stringify(obj), 'utf-8');
  await sleep(120);
  return obj;
}

// ── expand root (find subfolders and load each) ──
async function expandRoot(url) {
  const id = getFolderId(url);
  const h = await fetchHtml(id);
  if (!h) return [];
  const root = getItems(h);
  const subs = root.filter(i => i.mime === 'application/vnd.google-apps.folder');
  const out = [];
  for (const s of subs) {
    const expanded = await expandFolder(s.id, s.name, 0);
    out.push(...expanded);
  }
  return out;
}

async function expandFolder(id, label, depth) {
  const out = [];
  if (depth > 3) return out;
  const cf = path.join(FOLDERS_DIR, id + '.json');
  if (!REFRESH && fs.existsSync(cf)) {
    try {
      const data = JSON.parse(fs.readFileSync(cf, 'utf-8'));
      out.push(data);
      return out;
    } catch (e) { /* fallthrough */ }
  }
  log('EXPAND ' + id + ' | ' + label);
  const h = await fetchHtml(id);
  if (!h) return out;
  const all = getItems(h);
  const direct = all.filter(i => i.mime !== 'application/vnd.google-apps.folder');
  const subs = all.filter(i => i.mime === 'application/vnd.google-apps.folder');

  if (direct.length > 0 || subs.length === 0) {
    const items = await fetchFolderItems(id);
    const obj = { id, label, items };
    fs.writeFileSync(cf, JSON.stringify(obj), 'utf-8');
    out.push(obj);
    await sleep(120);
  } else {
    for (const s of subs) {
      const expanded = await expandFolder(s.id, s.name, depth + 1);
      out.push(...expanded);
    }
  }
  return out;
}

// ── build card items from folders ──
function buildItems(folders) {
  const out = [];
  for (const f of folders) {
    const imgs = f.items.filter(i => i.mime === 'image');
    const zips = f.items.filter(i => i.mime === 'archive');

    if (zips.length === 0) {
      const img = imgs.length > 0 ? imgs[0].id : '';
      out.push({ title: f.label, sub: 'Pasta (vários arquivos)', img, zip: '', link: 'https://drive.google.com/drive/folders/' + f.id, label: 'Abrir no Drive' });
    } else if (zips.length === 1) {
      const img = imgs.length > 0 ? imgs[0].id : '';
      out.push({ title: f.label, sub: f.label, img, zip: zips[0].id, link: '', label: 'Baixar ZIP' });
    } else {
      const used = new Set();
      const folderCards = [];
      const ordered = [...zips].sort((a, b) => (testGenericZip(a.name) ? 1 : 0) - (testGenericZip(b.name) ? 1 : 0));
      for (const z of ordered) {
        let best = null, bestScore = -1;
        for (const im of imgs) {
          if (used.has(im.id)) continue;
          const s = getZipScore(z.name, im.name);
          if (s > bestScore) { bestScore = s; best = im; }
        }
        if (!best) { for (const im of imgs) { if (!used.has(im.id)) { best = im; break; } } }
        let imgId = '';
        if (best) { imgId = best.id; used.add(best.id); }
        folderCards.push({ title: cleanTitle(z.name, f.label), sub: f.label, img: imgId, zip: z.id, link: '', label: 'Baixar ZIP' });
      }

      // check for duplicate titles → collapse to folder link
      const titleCounts = {};
      for (const c of folderCards) { const n = norm(c.title); titleCounts[n] = (titleCounts[n] || 0) + 1; }
      const hasDup = Object.values(titleCounts).some(v => v > 1);
      if (hasDup) {
        const img = folderCards.length > 0 ? folderCards[0].img : '';
        out.push({ title: f.label, sub: 'Pasta (vários arquivos)', img, zip: '', link: 'https://drive.google.com/drive/folders/' + f.id, label: 'Abrir no Drive' });
      } else {
        for (const c of folderCards) out.push(c);
      }
    }
  }
  return out;
}

function getCardKey(it) {
  if (it.zip) return 'z:' + it.zip;
  if (it.link) return 'l:' + it.link;
  return 'x:noid';
}

function emitCards(items) {
  const lines = [];
  for (const it of items) {
    const t = sanitize(it.title);
    const s = sanitize(it.sub);
    if (it.link) {
      lines.push(`      { title: "${t}", sub: "${s}", img: "${it.img}", link: "${it.link}", label: "${it.label}" },`);
    } else {
      lines.push(`      { title: "${t}", sub: "${s}", img: "${it.img}", zip: "${it.zip}" },`);
    }
  }
  return lines;
}

// ── main ──
async function main() {
  log('=== REBUILD START ===');

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

  // load snapshot
  let snapshot = {};
  if (fs.existsSync(SNAP_PATH)) {
    try { snapshot = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf-8')); } catch (e) { snapshot = {}; }
  }

  // seed legacy zips as old
  if (Object.keys(snapshot).length === 0) {
    for (const legacy of ['Dobraveis', 'Utensilios', 'Articulados', 'Luminarias', 'Decoracao', 'Multipartes', 'Veiculos']) {
      const fp = path.join(CACHE_DIR, legacy + '-fast.json');
      if (!fs.existsSync(fp)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        for (const f of data) {
          for (const it of (f.items || [])) {
            if (it.mime === 'archive' && !snapshot[it.id]) snapshot[it.id] = '2000-01-01';
          }
        }
      } catch (e) { /* skip */ }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const globalSeen = new Map();
  const blocks = [];
  const updatesItems = [];

  for (const tab of cfg.tabs) {
    if (tab.type === 'updates') {
      blocks.push({ name: tab.name, raw: false, updates: true, items: [], max: tab.max || 80 });
      continue;
    }

    if (tab.type === 'static') {
      // Read the static tab JS file
      const staticPath = path.join(BASE_DIR, tab.file);
      if (fs.existsSync(staticPath)) {
        const raw = fs.readFileSync(staticPath, 'utf-8');
        blocks.push({ name: tab.name, raw: true, content: raw });
      }
      log('STATIC ' + tab.name);
      continue;
    }

    if (tab.type === 'drive') {
      const acc = [];
      const seenUrls = new Map();
      const links = Array.isArray(tab.links) ? tab.links : [];

      if (tab.expand) {
        for (const link of links) {
          const url = typeof link === 'string' ? link : link.url;
          const normUrl = url.replace(/\/$/, '').toLowerCase();
          if (seenUrls.has(normUrl)) { log('SKIP duplicate link in ' + tab.name + ': ' + url); continue; }
          seenUrls.set(normUrl, true);
          const expanded = await expandRoot(url);
          acc.push(...expanded);
        }
      } else {
        for (const link of links) {
          const url = typeof link === 'string' ? link : link.url;
          const label = typeof link === 'string' ? '' : (link.label || '');
          const normUrl = url.replace(/\/$/, '').toLowerCase();
          if (seenUrls.has(normUrl)) { log('SKIP duplicate link in ' + tab.name + ': ' + url); continue; }
          seenUrls.set(normUrl, true);
          const folder = await loadFolder(url, label);
          acc.push(folder);
        }
      }

      const items = buildItems(acc);

      // dedup global
      const uniq = [];
      for (const it of items) {
        const key = getCardKey(it);
        if (globalSeen.has(key)) continue;
        globalSeen.set(key, true);
        uniq.push(it);
      }
      blocks.push({ name: tab.name, raw: false, items: uniq });
      log('TAB ' + tab.name + ': ' + uniq.length + ' cards (' + (items.length - uniq.length) + ' dups removed)');

      // feed updates
      const fromUpdates = /atualiza/i.test(tab.name);
      for (const it of items) {
        if (!it.zip) continue;
        const key = it.zip;
        let known = snapshot[key];
        if (!known) { snapshot[key] = today; known = today; }
        const date = String(known);
        const isNew = (date >= cutoff) || fromUpdates;
        if (isNew) {
          updatesItems.push({ title: it.title, sub: it.sub + ' - ' + date, img: it.img, zip: it.zip, link: it.link, label: it.label, date });
        }
      }
    }
  }

  // sort updates
  updatesItems.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));

  // find updates tab config
  const updatesTab = cfg.tabs.find(t => t.type === 'updates');
  const maxUpdates = updatesTab && updatesTab.max ? updatesTab.max : 80;
  const sortedUpdates = updatesItems.slice(0, maxUpdates);

  // ── emit new_collections.js ──
  let js = 'var COLLECTIONS = [\n';
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.updates) {
      js += '  {\n';
      js += `    name: "${b.name}",\n`;
      js += '    items: [\n';
      for (const l of emitCards(sortedUpdates)) js += l + '\n';
      js += '    ]\n';
      js += k < blocks.length - 1 ? '  },\n' : '  }\n';
      continue;
    }
    if (b.raw) {
      const inner = b.content.match(/\{([\s\S]*)\}/);
      js += '  {\n';
      js += inner ? inner[1].trim() + '\n' : '';
      js += k < blocks.length - 1 ? '  },\n' : '  }\n';
      continue;
    }
    js += '  {\n';
    js += `    name: "${b.name}",\n`;
    js += '    items: [\n';
    for (const l of emitCards(b.items)) js += l + '\n';
    js += '    ]\n';
    js += k < blocks.length - 1 ? '  },\n' : '  }\n';
  }
  js += '];\n';

  fs.writeFileSync(path.join(CACHE_DIR, 'new_collections.js'), js, 'utf-8');
  log('new_collections.js generated');

  // persist snapshot
  fs.writeFileSync(SNAP_PATH, JSON.stringify(snapshot, null, 0), 'utf-8');
  log('snapshot saved');

  // ── rebuild page ──
  const tpl = fs.readFileSync(TPL_PATH, 'utf-8');
  const page = tpl.replace('__COLLECTIONS__', js);
  fs.writeFileSync(OUT_PATH, page, 'utf-8');
  log('PAGE OK: ' + OUT_PATH);
  log('UPDATES: ' + sortedUpdates.length + ' items');
  log('=== REBUILD DONE ===');
}

main().catch(e => {
  console.error('REBUILD FAILED:', e.message);
  process.exit(1);
});
