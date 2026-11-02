import { FLAGS, toArgs, toCommand } from './options.js';

const SCREEN_W = 1512; // logical width of a 14" MacBook Pro, the preview's reference screen
const MAX_UPLOAD = 45 * 1024 * 1024; // base64 grows this to just under the server's 64 MB limit
const $ = (id) => document.getElementById(id);
const form = $('form');
const field = (name) => form.elements.namedItem(name);
const touch = matchMedia('(pointer: coarse)').matches;

let iconFile = null;
let iconUrl = '';
let site = null; // { label, files: [{ path, file }] } or { label, zip: File }
let nameEdited = false;
let remote = false;
let state = { current: null, queue: [] };
let shown = null; // the job in the progress panel: the running one, or the last finished one
let clock = null;

// ---- Small helpers ----

async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && remote) showPairing();
  if (!res.ok) throw new Error(data.error || "web2app's server isn't answering. Is start.command still running on the Mac?");
  return data;
}

function showProblem(el, message, hint) {
  el.hidden = !message;
  el.textContent = message || '';
  if (hint) {
    const small = document.createElement('small');
    small.textContent = hint;
    el.append(small);
  }
}

// Shows a failed action's message in the given problem box instead of a browser dialog.
const report = (id) => (err) => showProblem($(id), err.message);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const formatSize = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const formatElapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const formatDate = (t) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(t);
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// Shows the image when it loads, the first letter of the name otherwise.
function setIcon(img, letter, src, name) {
  letter.textContent = String(name).trim().charAt(0).toUpperCase() || '?';
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  img.hidden = true;
  letter.hidden = false;
  if (!src) return img.removeAttribute('src');
  img.onload = () => { img.hidden = false; letter.hidden = true; };
  img.onerror = () => { img.hidden = true; letter.hidden = false; };
  img.src = src;
}

function iconChip(name, src) {
  const img = el('img', { alt: '', hidden: '' });
  const letter = el('span', { class: 'letter' });
  setIcon(img, letter, src, name);
  return el('span', { class: 'chip-icon', 'aria-hidden': 'true' }, letter, img);
}

// ---- Form values and preview ----

const source = () => form.elements.namedItem('source').value;

function values() {
  const v = {};
  for (const [key, spec] of Object.entries(FLAGS)) {
    const input = field(key);
    if (!input) continue;
    v[key] = spec.type === 'bool' ? input.checked : input.value;
  }
  return v;
}

function siteUrl() {
  try {
    const u = new URL(field('url').value.trim());
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u : null;
  } catch {
    return null;
  }
}

// "music.youtube.com" -> "Youtube Music"
function nameFromHost(host) {
  const parts = host.replace(/^www\./, '').split('.').slice(0, -1).reverse();
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function render() {
  const v = values();
  const isFiles = source() === 'files';
  const u = isFiles ? null : siteUrl();
  const name = v.name.trim() || (u ? nameFromHost(u.hostname) : '') || 'Your app';
  const width = clampInt(v.width, 200, 7680, 1200);
  const height = clampInt(v.height, 200, 4320, 780);
  const zoom = clampInt(v.zoom, 50, 200, 100);

  $('urlBlock').hidden = isFiles;
  $('filesBlock').hidden = !isFiles;
  $('iconHint').textContent = iconFile
    ? `Using ${iconFile.name}. Tap the icon to change it.`
    : isFiles ? 'Leave the icon empty to use the Pake icon.' : "Leave the icon empty to use the site's own icon.";

  const screen = $('screen');
  const win = $('win');
  screen.dataset.mode = v.fullscreen ? 'full' : v.maximize ? 'max' : 'window';
  screen.classList.toggle('no-title', v.hideTitleBar);
  screen.classList.toggle('dark', v.darkMode);
  screen.classList.toggle('on-top', v.alwaysOnTop);
  win.style.setProperty('--w', width / SCREEN_W);
  win.style.setProperty('--h', height / SCREEN_W);
  win.style.setProperty('--zoom', zoom / 100);

  $('menuName').textContent = name;
  $('winTitle').textContent = name;
  $('pageHost').textContent = isFiles ? site?.label || 'Your files' : u ? u.hostname.replace(/^www\./, '') : 'Your website';
  $('pagePath').textContent = isFiles ? 'index.html' : u && u.pathname !== '/' ? u.pathname : '';
  $('caption').textContent = v.fullscreen
    ? 'Opens full screen on any Mac.'
    : v.maximize
      ? 'Opens maximized to fill the screen.'
      : `A ${width} × ${height} window on a ${SCREEN_W} × 982 Mac screen${zoom !== 100 ? `, page zoomed to ${zoom}%` : ''}.`;

  const favicon = u ? `${u.origin}/favicon.ico` : '';
  setIcon($('pageIcon'), $('pageLetter'), favicon, name);
  setIcon($('tileIcon'), $('tileLetter'), iconUrl || favicon, name);

  try {
    const args = toArgs(isFiles ? { path: './site' } : u ? u.href : 'https://example.com', { ...v, name: v.name.trim() || name });
    if (iconFile) args.push(`--icon=${iconFile.name}`);
    const inject = [field('css').value.trim() && 'inject.css', field('js').value.trim() && 'inject.js'].filter(Boolean);
    if (inject.length) args.push(`--inject=${inject.join(',')}`);
    $('command').textContent = toCommand(args);
  } catch {
    // keep the last valid command while a field is half typed
  }
  for (const chip of document.querySelectorAll('.preset')) {
    chip.setAttribute('aria-pressed', String(!isFiles && u?.href === new URL(chip.dataset.url).href));
  }
}

field('url').addEventListener('input', () => {
  const u = siteUrl();
  if (!nameEdited && u) field('name').value = nameFromHost(u.hostname);
});
field('name').addEventListener('input', () => (nameEdited = field('name').value.trim() !== ''));
form.addEventListener('input', render);
form.addEventListener('change', render);

// Opening full screen and opening maximized exclude each other.
field('fullscreen').addEventListener('change', (e) => e.target.checked && (field('maximize').checked = false));
field('maximize').addEventListener('change', (e) => e.target.checked && (field('fullscreen').checked = false));

function setIconFile(file) {
  if (iconUrl) URL.revokeObjectURL(iconUrl);
  iconFile = file || null;
  iconUrl = file ? URL.createObjectURL(file) : '';
  const thumb = $('iconThumb');
  $('iconPlus').textContent = '+';
  thumb.hidden = !file;
  $('iconPlus').hidden = Boolean(file);
  if (file) {
    // .icns and .ico often can't be drawn by the browser; a check mark stands in for them.
    thumb.onerror = () => { thumb.hidden = true; $('iconPlus').hidden = false; $('iconPlus').textContent = '✓'; };
    thumb.src = iconUrl;
  }
  render();
}

$('iconInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file && file.size > 6 * 1024 * 1024) {
    e.target.value = '';
    setIconFile(null);
    $('iconHint').textContent = 'That image is over 6 MB. Pick a smaller one.';
    return;
  }
  setIconFile(file);
});

$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('command').textContent);
    $('copyBtn').textContent = 'Copied';
  } catch {
    $('copyBtn').textContent = 'Select and copy';
  }
  setTimeout(() => ($('copyBtn').textContent = 'Copy'), 1500);
});

// ---- Local files ----

function setSite(next) {
  site = next;
  const total = site ? (site.zip ? site.zip.size : site.files.reduce((n, f) => n + f.file.size, 0)) : 0;
  if (site && total > MAX_UPLOAD) {
    site = null;
    showProblem($('formError'), 'Those files are over 45 MB together. Pick fewer or smaller files.');
  } else {
    showProblem($('formError'), '');
  }
  $('dropTitle').textContent = site
    ? `${site.label}, ${site.zip ? 'zip' : `${site.files.length} file${site.files.length === 1 ? '' : 's'}`}, ${formatSize(total)}`
    : touch ? 'Choose an .html file or a .zip of your site' : 'Drop a folder with an index.html here';
  $('filesHint').textContent = site ? 'Ready. The finished app works without internet.' : 'The finished app works without internet.';
  if (site && !nameEdited) field('name').value = site.label.replace(/\.(html?|zip)$/i, '');
  render();
}

// iOS Safari has no folder picker, so phones get files and .zip only.
$('folderPick').hidden = touch;

$('folderInput').addEventListener('change', (e) => {
  const files = [...e.target.files].filter((f) => !f.name.startsWith('.'));
  if (!files.length) return;
  setSite({ label: files[0].webkitRelativePath.split('/')[0], files: files.map((file) => ({ path: file.webkitRelativePath, file })) });
});

$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setSite(/\.zip$/i.test(file.name) ? { label: file.name, zip: file } : { label: file.name, files: [{ path: file.name, file }] });
});

// Reads a dropped folder; readEntries returns at most 100 entries per call.
async function readEntry(entry, out) {
  if (entry.isFile) {
    if (!entry.name.startsWith('.')) out.push({ path: entry.fullPath.slice(1), file: await new Promise((ok, bad) => entry.file(ok, bad)) });
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((ok, bad) => reader.readEntries(ok, bad));
    if (!batch.length) return;
    for (const child of batch) await readEntry(child, out);
  }
}

const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const entry = e.dataTransfer.items[0]?.webkitGetAsEntry?.();
  if (!entry) return;
  if (entry.isFile) {
    const file = e.dataTransfer.files[0];
    return setSite(/\.zip$/i.test(file.name) ? { label: file.name, zip: file } : { label: file.name, files: [{ path: file.name, file }] });
  }
  const files = [];
  await readEntry(entry, files);
  setSite({ label: entry.name, files });
});

// ---- Presets ----

fetch('presets.json')
  .then((r) => r.json())
  .then((presets) => {
    $('presets').replaceChildren(
      ...presets.map((p) => {
        const chip = el('button', { type: 'button', class: 'preset', 'data-url': p.url, 'aria-pressed': 'false' },
          iconChip(p.title, `${new URL(p.url).origin}/favicon.ico`), p.title);
        chip.addEventListener('click', () => applyPreset(p));
        return chip;
      }),
    );
    render();
  });

function applyPreset(p) {
  form.elements.namedItem('source').value = 'url';
  field('url').value = p.url;
  field('name').value = p.title;
  nameEdited = true;
  field('width').value = p.width || FLAGS.width.default;
  field('height').value = p.height || FLAGS.height.default;
  field('incognito').checked = Boolean(p.incognito);
  render();
  $('build').scrollIntoView({ block: 'start' });
}

// Fills the form from a build in the history.
function applyJob(job) {
  form.elements.namedItem('source').value = job.source;
  field('url').value = job.url || '';
  for (const [key, spec] of Object.entries(FLAGS)) {
    const input = field(key);
    if (!input) continue;
    const value = job.options[key];
    if (spec.type === 'bool') input.checked = value === true;
    else if (key === 'output') form.elements.namedItem('output').value = value || 'dmg';
    else input.value = value ?? (spec.default ?? '');
  }
  field('css').value = job.css || '';
  field('js').value = job.js || '';
  nameEdited = true;
  setIconFile(null);
  setSite(null);
  render();
  const missing = [job.hasIcon && 'icon', job.source === 'files' && 'files'].filter(Boolean);
  if (missing.length) $('iconHint').textContent = `Settings loaded. Pick the ${missing.join(' and ')} again, or use Rebuild in the history to reuse them.`;
  $('build').scrollIntoView({ block: 'start' });
}

// ---- Building ----

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showProblem($('formError'), '');
  for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');

  const v = values();
  const isFiles = source() === 'files';
  try {
    if (isFiles && !site) throw new Error('Pick an .html file, a folder or a .zip first.');
    toArgs(isFiles ? { path: './site' } : field('url').value, v);
  } catch (err) {
    showProblem($('formError'), err.message);
    const bad = /address/.test(err.message) ? 'url' : Object.keys(FLAGS).find((k) => FLAGS[k].label && err.message.startsWith(FLAGS[k].label));
    if (bad && field(bad)) {
      field(bad).setAttribute('aria-invalid', 'true');
      field(bad).focus();
    }
    return;
  }

  const btn = $('buildBtn');
  btn.disabled = true;
  btn.textContent = isFiles ? 'Sending files…' : 'Adding…';
  try {
    const body = { source: source(), url: field('url').value.trim(), options: v, css: field('css').value, js: field('js').value };
    if (iconFile) body.icon = { name: iconFile.name, data: await readAsBase64(iconFile) };
    if (isFiles && site.zip) body.zip = { name: site.zip.name, data: await readAsBase64(site.zip) };
    if (isFiles && site.files) body.files = await Promise.all(site.files.map(async (f) => ({ path: f.path, data: await readAsBase64(f.file) })));
    await api('/api/build', body);
    $('progress').scrollIntoView({ block: 'start' });
  } catch (err) {
    showProblem($('formError'), err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Build app';
  }
});

$('cancelBtn').addEventListener('click', () => state.current && api('/api/cancel', { id: state.current.id }).catch(report('buildError')));

function outputActions(job, i, out) {
  const isApp = out.file.endsWith('.app');
  const act = (path, label) => el('button', {
    type: 'button',
    class: 'btn btn-sm',
    onclick: () => api(path, { id: job.id, index: i }).catch(report(job.id === shown?.id || job.id === state.current?.id ? 'buildError' : 'historyError')),
  }, label);
  return [
    el('a', { class: 'btn btn-sm btn-primary', href: `/api/download/${encodeURIComponent(job.id)}/${i}`, download: '' }, isApp ? 'Download .zip' : 'Download'),
    act('/api/reveal', remote ? 'Show in Finder on Mac' : 'Show in Finder'),
    isApp && act('/api/open', remote ? 'Open on Mac' : 'Open app'),
  ];
}

function renderProgress() {
  const job = state.current || shown;
  const panel = $('progress');
  clearInterval(clock);
  panel.hidden = !job && !state.queue.length;

  const waiting = state.queue.length;
  const pill = $('queuePill');
  pill.hidden = !state.current && !waiting;
  pill.textContent = state.current ? (waiting ? `Building, ${waiting} waiting` : 'Building') : `${waiting} waiting`;

  $('queueBlock').hidden = !waiting;
  $('queueList').replaceChildren(
    ...state.queue.map((q) => el('li', {}, el('span', {}, q.name),
      el('button', { type: 'button', class: 'btn btn-sm', onclick: () => api('/api/cancel', { id: q.id }).catch(() => {}) }, 'Remove'))),
  );
  if (!job) {
    $('buildTitle').textContent = '';
    for (const id of ['cancelBtn', 'firstNote', 'buildError', 'logWrap']) $(id).hidden = true;
    $('outputs').replaceChildren();
    return;
  }

  const running = job.status === 'running' || job.status === 'cancelling';
  $('buildTitle').textContent = {
    running: `Building ${job.name}`,
    cancelling: 'Cancelling…',
    cancelled: `${job.name} was cancelled`,
    done: `${job.name} is ready`,
    failed: `${job.name} didn't build`,
  }[job.status] || job.name;
  $('cancelBtn').hidden = !running;
  $('cancelBtn').disabled = job.status === 'cancelling';
  $('firstNote').hidden = !running;
  $('logWrap').hidden = false;

  const tick = () => ($('elapsed').textContent = job.startedAt ? formatElapsed((job.finishedAt || Date.now()) - job.startedAt) : '');
  tick();
  if (running) clock = setInterval(tick, 1000);

  showProblem($('buildError'), job.error?.message, job.error?.hint);
  $('outputs').replaceChildren(
    ...job.outputs.map((out, i) => el('li', {}, el('b', {}, out.file), el('span', { class: 'size' }, formatSize(out.sizeBytes)), ...outputActions(job, i, out))),
  );
  const log = $('log');
  log.textContent = (job.lines || []).join('\n');
  log.scrollTop = log.scrollHeight;
  $('logWrap').open = running || job.status === 'failed';
}

function appendLog({ id, lines }) {
  if (state.current?.id !== id) return;
  state.current.lines.push(...lines);
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append((log.textContent ? '\n' : '') + lines.join('\n'));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function onFinished(job) {
  shown = job;
  if (job.status !== 'done') return;
  const tile = $('tile');
  tile.classList.add('built');
  tile.classList.remove('arrived');
  void tile.offsetWidth; // restart the animation
  tile.classList.add('arrived');
}

// ---- History ----

let confirming = null;

async function loadHistory() {
  let jobs;
  try {
    jobs = await api('/api/history');
  } catch {
    return;
  }
  $('historyEmpty').hidden = jobs.length > 0;
  $('historyList').replaceChildren(...jobs.map(historyRow));
}

function historyRow(job) {
  const where = job.source === 'files' ? 'Your files' : hostOf(job.url);
  const size = job.outputs[0] ? formatSize(job.outputs[0].sizeBytes) : '';
  const label = { done: '', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', queued: 'Waiting', running: 'Building' }[job.status];
  const busy = job.status === 'queued' || job.status === 'running';

  const actions = confirming === job.id
    ? [
      el('span', { class: 'hint' }, `Delete ${job.name} and its files?`),
      el('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => api('/api/delete', { id: job.id }).then(() => (confirming = null)).catch(report('historyError')) }, 'Delete'),
      el('button', { type: 'button', class: 'btn btn-sm', onclick: () => { confirming = null; loadHistory(); } }, 'Keep'),
    ]
    : [
      ...(job.status === 'done' ? job.outputs.slice(0, 1).flatMap((out) => outputActions(job, 0, out).slice(0, 1)) : []),
      !busy && el('button', { type: 'button', class: 'btn btn-sm', onclick: () => api('/api/rebuild', { id: job.id }).then(() => $('progress').scrollIntoView({ block: 'start' })).catch(report('historyError')) }, 'Rebuild'),
      el('button', { type: 'button', class: 'btn btn-sm', onclick: () => applyJob(job) }, 'Edit'),
      job.status === 'done' && el('button', { type: 'button', class: 'btn btn-sm', onclick: () => api('/api/reveal', { id: job.id, index: 0 }).catch(report('historyError')) }, remote ? 'Show on Mac' : 'Show in Finder'),
      !busy && el('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => { confirming = job.id; loadHistory(); } }, 'Delete'),
    ];

  return el('li', { class: 'h-row' },
    iconChip(job.name, job.source === 'url' ? `${new URL(job.url).origin}/favicon.ico` : ''),
    el('div', { class: 'h-main' },
      el('b', {}, job.name),
      el('div', { class: 'h-meta' },
        el('span', {}, where), el('span', {}, formatDate(job.createdAt)), size && el('span', {}, size),
        label && el('span', { class: `badge ${job.status}` }, label))),
    el('div', { class: 'h-actions' }, ...actions));
}

// ---- Phone access (on the Mac) ----

function renderPhone(p) {
  $('phoneOff').hidden = p.on;
  $('phoneOnBlock').hidden = !p.on;
  $('phoneBtn').textContent = p.on ? 'Phone access on' : 'Use on phone';
  if (!p.on) return;
  $('phoneUrl').textContent = p.url;
  $('phoneCode').textContent = p.code;
  if (window.qrcode) {
    const qr = window.qrcode(0, 'M');
    qr.addData(p.url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
}

$('phoneBtn').addEventListener('click', () => $('phoneDialog').showModal());
for (const [id, on] of [['phoneOn', true], ['phoneOffBtn', false]]) {
  $(id).addEventListener('click', async () => {
    showProblem($('phoneError'), '');
    try {
      renderPhone(await api('/api/phone', { on }));
    } catch (err) {
      showProblem($('phoneError'), err.message);
    }
  });
}

// ---- Pairing (on a phone) ----

function showPairing() {
  $('pairScreen').hidden = false;
  $('pairCode').focus();
}

$('pairForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/pair', { code: $('pairCode').value });
    location.reload();
  } catch (err) {
    showProblem($('pairError'), err.message);
    $('pairCode').select();
  }
});

// ---- Start ----

render();

if (location.protocol !== 'file:') {
  remote = !['localhost', '127.0.0.1'].includes(location.hostname);
  api('/api/info')
    .then((info) => {
      $('footMeta').textContent = `pake-cli ${info.pakeVersion}${info.remote ? ', building on your Mac' : ''}`;
      $('rustWarning').hidden = info.hasRust;
      $('resultSet').hidden = info.platform !== 'darwin';
      $('phoneBtn').hidden = info.remote;
      if (info.phone) renderPhone(info.phone);
      loadHistory();

      const events = new EventSource('/api/events');
      events.addEventListener('state', (e) => {
        state = JSON.parse(e.data);
        if (state.current) shown = null;
        renderProgress();
      });
      events.addEventListener('finished', (e) => onFinished(JSON.parse(e.data)));
      events.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
      events.addEventListener('history', loadHistory);
      events.addEventListener('phone', (e) => renderPhone(JSON.parse(e.data)));
    })
    .catch((err) => {
      if (!$('pairScreen').hidden) return;
      showProblem($('formError'), err.message);
    });
}
