import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toArgs } from './public/options.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
// WEB2APP_BUILDS moves the builds and their history out of the app folder (the Homebrew install sets it).
const BUILDS = process.env.WEB2APP_BUILDS ? path.resolve(process.env.WEB2APP_BUILDS) : path.join(ROOT, 'builds');
const PAKE = path.join(ROOT, 'node_modules', '.bin', 'pake');
const CACHE_LOCK = path.join(ROOT, 'node_modules', 'pake-cli', 'src-tauri', 'target', '.pake-build.lock');
const PORT = Number(process.env.PORT) || 7417;
const SMALL_BODY = 256 * 1024;
const UPLOAD_BODY = 64 * 1024 * 1024;
const MAX_INJECT = 200 * 1024;
const ICON_TYPES = new Set(['.png', '.icns', '.ico', '.jpg', '.jpeg']);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

// Started from Finder, PATH lacks cargo and Homebrew, and Pake would report Rust as missing.
process.env.PATH = [path.join(os.homedir(), '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':');
fs.mkdirSync(BUILDS, { recursive: true });

const pakeVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'pake-cli', 'package.json'))).version;
const hasRust = spawnSync('cargo', ['-V']).status === 0;

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---- Jobs, queue and history ----
// Every build has a folder builds/<id>/ with a job.json, which is the history.
// One build runs at a time: Pake locks a shared cache, so parallel builds would only clash.

let current = null; // { ...job, lines, child }
const queue = [];
const listeners = new Set(); // { res, local }

function emit(event, data, localOnly = false) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const l of listeners) if (!localOnly || l.local) l.res.write(msg);
}

function dirOf(id) {
  if (typeof id !== 'string' || !/^[\w-][\w.-]*$/.test(id)) throw fail(404, 'That build is gone.');
  return path.join(BUILDS, id);
}

function saveJob(job) {
  const { lines, child, ...data } = job;
  fs.writeFileSync(path.join(dirOf(job.id), 'job.json'), JSON.stringify(data, null, 1));
}

function loadJob(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'job.json')));
  } catch (err) {
    throw err.status ? err : fail(404, 'That build is gone.');
  }
}

// What pages see: no absolute paths, no file contents.
function publicJob(job, withLines = false) {
  if (!job) return null;
  return {
    id: job.id, name: job.name, source: job.source, url: job.url, options: job.options, css: job.css, js: job.js,
    hasIcon: Boolean(job.icon), status: job.status, error: job.error, offline: job.offline,
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    outputs: (job.outputs || []).map((o) => ({ file: path.basename(o.path), sizeBytes: o.sizeBytes, format: o.format })),
    ...(withLines ? { lines: job.lines } : {}),
  };
}

function stateMessage() {
  return { current: publicJob(current, true), queue: queue.map((j) => publicJob(j)) };
}

function listHistory() {
  return fs.readdirSync(BUILDS)
    .filter((id) => fs.existsSync(path.join(BUILDS, id, 'job.json')))
    .map((id) => publicJob(loadJob(id)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// A server that stopped mid-build leaves jobs that will never finish.
for (const job of listHistory()) {
  if (job.status === 'running' || job.status === 'queued') saveJob({ ...loadJob(job.id), status: 'interrupted' });
}

function checkText(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_INJECT) throw fail(400, `${label} can be at most 200 KB.`);
  return value;
}

// Creates the job folder and fills it with `stage(dir, job)`. Nothing is left behind if that throws.
function createJob(spec, stage) {
  const source = spec.source === 'files' ? 'files' : 'url';
  const options = spec.options && typeof spec.options === 'object' ? spec.options : {};
  toArgs(source === 'files' ? { path: 'site' } : spec.url, options); // throws a readable error
  const css = checkText(spec.css, 'Custom CSS');
  const js = checkText(spec.js, 'Custom JavaScript');
  const now = Date.now();
  const id = `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${options.name.replace(/[^\w-]+/g, '-').slice(0, 40)}`;
  const dir = dirOf(id);
  fs.mkdirSync(dir);
  const job = {
    id, name: options.name.trim(), source, url: source === 'url' ? spec.url.trim() : '', options,
    css, js,
    status: 'queued', outputs: [], error: null, createdAt: now,
  };
  try {
    stage(dir, job);
    if (job.css) fs.writeFileSync(path.join(dir, 'inject.css'), job.css);
    if (job.js) fs.writeFileSync(path.join(dir, 'inject.js'), job.js);
    saveJob(job);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return job;
}

// Writes an upload into dir from the request body: the icon and, for local files, the site.
function stageUpload(body) {
  return (dir, job) => {
    if (body.icon) {
      const ext = path.extname(String(body.icon.name)).toLowerCase();
      if (!ICON_TYPES.has(ext)) throw fail(400, 'Use a .png, .icns, .ico or .jpg file for the icon.');
      job.icon = `icon${ext}`;
      fs.writeFileSync(path.join(dir, job.icon), Buffer.from(String(body.icon.data), 'base64'));
    }
    if (job.source !== 'files') return;

    const site = path.join(dir, 'site');
    fs.mkdirSync(site);
    if (body.zip) {
      const zip = path.join(dir, 'upload.zip');
      fs.writeFileSync(zip, Buffer.from(String(body.zip.data), 'base64'));
      const unzip = spawnSync('ditto', ['-x', '-k', zip, site]);
      fs.rmSync(zip);
      if (unzip.status !== 0) throw fail(400, "That .zip couldn't be opened. Make it again with Finder's Compress.");
    } else {
      const files = Array.isArray(body.files) ? body.files : [];
      if (!files.length || files.length > 5000) throw fail(400, 'Pick an .html file, a folder or a .zip.');
      for (const f of files) {
        let rel = path.normalize(String(f.path)).replace(/^\/+/, '');
        if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '.') throw fail(400, `"${f.path}" isn't a valid file name.`);
        if (files.length === 1 && /\.html?$/i.test(rel)) rel = 'index.html';
        fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true });
        fs.writeFileSync(path.join(site, rel), Buffer.from(String(f.data), 'base64'));
      }
    }
    job.siteRoot = path.relative(dir, findSiteRoot(site));
  };
}

// Pake packages a folder with an index.html at its top. Uploads often wrap that in one folder.
function findSiteRoot(site) {
  fs.rmSync(path.join(site, '__MACOSX'), { recursive: true, force: true });
  for (const entry of fs.readdirSync(site, { recursive: true, withFileTypes: true })) {
    // A link could point anywhere on the Mac, and Pake would copy what it points to into the app.
    if (entry.isSymbolicLink()) throw fail(400, 'Files that are links are not supported. Copy the real files in.');
  }
  let root = site;
  for (;;) {
    if (fs.existsSync(path.join(root, 'index.html'))) return root;
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
    if (entries.length !== 1 || !entries[0].isDirectory()) break;
    root = path.join(root, entries[0].name);
  }
  throw fail(400, 'There is no index.html at the top of these files. Pake opens that file when the app starts.');
}

// Copies the files of an earlier build into a new one, for Rebuild.
function stageCopy(old) {
  return (dir, job) => {
    const from = dirOf(old.id);
    if (old.icon) {
      job.icon = old.icon;
      fs.copyFileSync(path.join(from, old.icon), path.join(dir, old.icon));
    }
    if (old.source === 'files') {
      if (!old.siteRoot || !fs.existsSync(path.join(from, old.siteRoot))) throw fail(410, 'The files of that build are gone. Pick them again.');
      fs.cpSync(path.join(from, 'site'), path.join(dir, 'site'), { recursive: true });
      job.siteRoot = old.siteRoot;
    }
  };
}

// A cancelled Pake can exit without removing its cache lock, and every later build
// would then fail. Pake's own hint is to delete it once no Pake process owns it.
function clearStaleLock() {
  let pid;
  try {
    pid = Number(fs.readFileSync(CACHE_LOCK, 'utf8'));
  } catch {
    return; // no lock
  }
  try {
    if (pid > 0) return void process.kill(pid, 0); // its owner still runs
  } catch (err) {
    if (err.code !== 'ESRCH') return;
  }
  fs.rmSync(CACHE_LOCK, { force: true });
}

function isOffline() {
  if (process.env.WEB2APP_OFFLINE === '1') return Promise.resolve(true);
  return new Promise((resolve) => {
    const socket = net.connect({ host: 'index.crates.io', port: 443, timeout: 2000 });
    const done = (offline) => { socket.destroy(); resolve(offline); };
    socket.on('connect', () => done(false));
    socket.on('timeout', () => done(true));
    socket.on('error', () => done(true));
  });
}

async function runNext() {
  if (current || !queue.length) return;
  const job = queue.shift();
  current = job;
  job.lines = [];
  job.status = 'running';
  job.startedAt = Date.now();
  broadcastState();
  job.offline = await isOffline();
  if (job.status === 'cancelling') {
    // Cancelled during the network check, before Pake started.
    Object.assign(job, { status: 'cancelled', finishedAt: Date.now() });
    saveJob(job);
    current = null;
    emit('finished', publicJob(job, true));
    broadcastState();
    emit('history', null);
    return runNext();
  }

  clearStaleLock();
  const dir = dirOf(job.id);
  const args = toArgs(job.source === 'files' ? { path: path.join(dir, job.siteRoot) } : job.url, job.options);
  if (job.icon) args.push(`--icon=${path.join(dir, job.icon)}`);
  const inject = ['inject.css', 'inject.js'].filter((f) => fs.existsSync(path.join(dir, f))).map((f) => path.join(dir, f));
  if (inject.length) args.push(`--inject=${inject.join(',')}`);
  args.push('--json');

  const env = { ...process.env };
  if (job.offline) {
    // Pake passes the environment on to its pnpm install and to cargo.
    Object.assign(env, { CARGO_NET_OFFLINE: 'true', npm_config_offline: 'true' });
    job.lines.push('No internet. Building from the local cache.');
  }
  saveJob(job);
  broadcastState();
  emit('history', null);

  const child = spawn(PAKE, args, { cwd: dir, env });
  job.child = child;
  let stdout = '';
  let partial = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => {
    const parts = (partial + d).split(/\r?\n|\r/);
    partial = parts.pop();
    const lines = parts.filter((l) => l.trim());
    if (!lines.length) return;
    job.lines.push(...lines);
    if (job.lines.length > 4000) job.lines.splice(0, job.lines.length - 4000);
    emit('log', { id: job.id, lines });
  });
  child.on('close', (code, signal) => {
    if (partial.trim()) job.lines.push(partial);
    let result = null;
    try {
      result = JSON.parse(stdout.trim().split('\n').pop());
    } catch {}
    if (job.status === 'cancelling' || signal) {
      job.status = 'cancelled';
    } else if (result?.ok) {
      job.status = 'done';
      job.outputs = result.outputs;
    } else {
      job.status = 'failed';
      job.error = result?.error || { message: `Pake stopped with exit code ${code}.`, hint: 'The build log shows the last thing it did.' };
      if (job.offline && !job.error.hint) job.error.hint = "This Mac is offline. The very first build needs internet once to download Pake's parts.";
    }
    job.finishedAt = Date.now();
    saveJob(job);
    current = null;
    // The page keeps showing this finished job until the next one starts.
    emit('finished', publicJob(job, true));
    broadcastState();
    emit('history', null);
    runNext();
  });
}

function broadcastState() {
  emit('state', stateMessage());
}

function enqueue(job) {
  queue.push(job);
  broadcastState();
  emit('history', null);
  runNext();
  return publicJob(job);
}

function outputAt(id, index) {
  const job = current?.id === id ? current : loadJob(id);
  const out = job.status === 'done' && job.outputs[Number(index)];
  if (!out || !fs.existsSync(out.path)) throw fail(404, 'That file is gone. Build the app again.');
  return { file: out.path, dir: dirOf(id) };
}

// ---- Phone access ----
// Off until switched on from this Mac. Then a second listener on the Wi-Fi address
// accepts devices that typed the 6-digit code shown on the Mac.

const phone = { server: null, ip: '', code: '', tries: 0, lockedUntil: 0, tokens: new Set() };

function lanAddress() {
  if (process.env.WEB2APP_PHONE_HOST) return process.env.WEB2APP_PHONE_HOST; // for tests, e.g. ::1
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|utun|awdl|llw|bridge|anpi|ap\d)/.test(name)) continue;
    const v4 = addrs.find((a) => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  return '';
}

const phoneHost = () => `${phone.ip.includes(':') ? `[${phone.ip}]` : phone.ip}:${PORT}`;

function newCode() {
  phone.code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  phone.tries = 0;
}

function phoneState() {
  return phone.server ? { on: true, url: `http://${phoneHost()}`, code: phone.code } : { on: false };
}

async function setPhone(on) {
  if (on && !phone.server) {
    const ip = lanAddress();
    if (!ip) throw fail(409, "This Mac isn't connected to a Wi-Fi or wired network.");
    const server = http.createServer((req, res) => handle(req, res, false));
    await new Promise((resolve, reject) => server.once('error', reject).listen(PORT, ip, resolve));
    Object.assign(phone, { server, ip });
    newCode();
  } else if (!on && phone.server) {
    phone.server.close();
    phone.server.closeAllConnections();
    phone.tokens.clear();
    for (const l of listeners) if (!l.local) l.res.end();
    Object.assign(phone, { server: null, ip: '', code: '' });
  }
  emit('phone', phoneState(), true);
  return phoneState();
}

function isPaired(req) {
  const token = req.headers.cookie?.match(/(?:^|;\s*)web2app=([a-f0-9]{64})/)?.[1];
  return Boolean(token && phone.tokens.has(token));
}

function pair(res, body) {
  if (!phone.server) return send(res, 403, { error: 'Phone access is off. Turn it on from the Mac.' });
  if (Date.now() < phone.lockedUntil) return send(res, 429, { error: 'Too many wrong codes. Wait a minute, then use the new code on the Mac.' });
  if (String(body.code).trim() !== phone.code) {
    if (++phone.tries >= 5) {
      newCode();
      phone.lockedUntil = Date.now() + 60_000;
      emit('phone', phoneState(), true);
    }
    return send(res, 401, { error: "That code doesn't match. Check the code on the Mac." });
  }
  const token = crypto.randomBytes(32).toString('hex');
  phone.tokens.add(token);
  res.setHeader('Set-Cookie', `web2app=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
  return send(res, 200, { ok: true });
}

// ---- HTTP ----

function hosts() {
  const list = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (phone.server) list.push(phoneHost());
  return list;
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(fail(413, limit === UPLOAD_BODY ? 'Those files are over 45 MB together. Pick fewer or smaller files.' : 'That request is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(fail(400, 'The request was not valid JSON.'));
      }
    });
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// `local` is true for requests to the main listener, which only this Mac can reach (127.0.0.1).
async function handleApi(req, res, url, local) {
  const isPost = req.method === 'POST';
  if (isPost) {
    // A page on another site could otherwise make the browser post here and start builds.
    const origin = req.headers.origin?.replace(/^http:\/\//, '');
    if (!origin || !hosts().includes(origin) || !req.headers['content-type']?.startsWith('application/json')) {
      return send(res, 403, { error: 'Requests have to come from this page.' });
    }
  }
  if (isPost && url.pathname === '/api/pair') return pair(res, await readJson(req, SMALL_BODY));
  if (!local && !isPaired(req)) return send(res, 401, { error: 'Enter the code shown on the Mac.' });

  if (req.method === 'GET') {
    if (url.pathname === '/api/info') {
      return send(res, 200, { pakeVersion, platform: process.platform, hasRust, remote: !local, phone: local ? phoneState() : undefined });
    }
    if (url.pathname === '/api/history') return send(res, 200, listHistory());
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const listener = { res, local };
      listeners.add(listener);
      res.write(`event: state\ndata: ${JSON.stringify(stateMessage())}\n\n`);
      req.on('close', () => listeners.delete(listener));
      return;
    }
    const download = url.pathname.match(/^\/api\/download\/([^/]+)\/(\d+)$/);
    if (download) {
      let { file, dir } = outputAt(decodeURIComponent(download[1]), download[2]);
      if (fs.statSync(file).isDirectory()) {
        // A .app is a folder; ditto zips it the way Finder does, keeping signatures and symlinks.
        const zip = path.join(dir, `${path.basename(file)}.zip`);
        if (!fs.existsSync(zip)) spawnSync('ditto', ['-c', '-k', '--keepParent', file, zip]);
        file = zip;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
      });
      return fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, { error: 'Not found.' });
  }

  if (!isPost) return send(res, 404, { error: 'Not found.' });
  const body = await readJson(req, url.pathname === '/api/build' ? UPLOAD_BODY : SMALL_BODY);

  switch (url.pathname) {
    case '/api/build':
      return send(res, 202, enqueue(createJob(body, stageUpload(body))));
    case '/api/rebuild': {
      const old = loadJob(body.id);
      return send(res, 202, enqueue(createJob(old, stageCopy(old))));
    }
    case '/api/cancel': {
      if (current?.id === body.id) {
        current.status = 'cancelling';
        broadcastState();
        current.child?.kill('SIGINT'); // Pake cleans up its workspace on SIGINT
        return send(res, 202, { ok: true });
      }
      const i = queue.findIndex((j) => j.id === body.id);
      if (i < 0) return send(res, 409, { error: 'That build is not waiting or running.' });
      queue.splice(i, 1);
      fs.rmSync(dirOf(body.id), { recursive: true, force: true });
      broadcastState();
      emit('history', null);
      return send(res, 200, { ok: true });
    }
    case '/api/delete': {
      if (current?.id === body.id || queue.some((j) => j.id === body.id)) return send(res, 409, { error: 'Cancel this build before you delete it.' });
      loadJob(body.id); // only folders that are builds
      fs.rmSync(dirOf(body.id), { recursive: true, force: true });
      emit('history', null);
      return send(res, 200, { ok: true });
    }
    case '/api/reveal':
    case '/api/open': {
      const { file } = outputAt(body.id, body.index);
      spawn('open', url.pathname === '/api/reveal' ? ['-R', file] : [file], { stdio: 'ignore' });
      return send(res, 200, { ok: true });
    }
    case '/api/phone':
      if (!local) return send(res, 403, { error: 'Phone access can only be changed on the Mac.' });
      return send(res, 200, await setPhone(body.on === true));
  }
  return send(res, 404, { error: 'Not found.' });
}

function serveStatic(res, pathname) {
  const file = path.join(PUBLIC, path.normalize(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res, local) {
  // Refuse other host names so a DNS-rebinding site cannot reach this server.
  if (!hosts().includes(req.headers.host)) return res.writeHead(421).end(`Open this app at http://localhost:${PORT}`);
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, local);
    else serveStatic(res, url.pathname);
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong on the Mac. The Terminal window shows the details.' });
  }
}

const server = http.createServer((req, res) => handle(req, res, true));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. web2app may already be running at http://localhost:${PORT}`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`web2app is running at http://localhost:${PORT}`);
  if (!hasRust) console.log('Rust was not found. Install it from https://rustup.rs before building.');
});

// SIGHUP arrives when the start.command Terminal window is closed.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    queue.length = 0;
    if (!current?.child) process.exit(0);
    console.log('Stopping the running build first…');
    current.status = 'cancelling';
    current.child.kill('SIGINT');
    current.child.on('close', () => process.exit(0));
  });
}
