// Image Forge: the page. The image work itself is in core.js.
import {
  LABELS, alphaShare, borderColor, removeBackground, contentBounds, detectParts, layoutViews, zip,
  floodMask, paintMask, unzip, applyMatte,
} from './core.js';

const $ = id => document.getElementById(id);
const KEYS = { f: 'front', b: 'back', l: 'left', r: 'right', t: 'top', d: 'bottom' };
const COLORS = { front: '#d9480f', back: '#1971c2', left: '#2f9e44', right: '#9c36b5', top: '#b08900', bottom: '#0c8599' };
const NEUTRAL = '#868e96';
const OPPOSITE = { front: 'back', back: 'front', left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

// ---------------------------------------------------------------- settings
const defaults = {
  tolerance: 18, soft: 14, defringe: true, choke: 0, holes: false, gap: 1.2,
  trim: true, padding: 6, square: true, same: true, size: 0, fill: 'transparent', fillColor: '#ffffff',
  brush: 30,
  method: 'color',   // how the background is found: color | ai | both
  // Views taken from another view: {left: {from: 'right', mirror: true, turn: 0}}.
  derived: {},
};
const opt = { ...defaults };
try { Object.assign(opt, JSON.parse(localStorage.getItem('image-forge') || '{}')); } catch { /* defaults */ }
opt.derived = { ...opt.derived };   // never the object of the defaults
const save = () => { try { localStorage.setItem('image-forge', JSON.stringify(opt)); } catch { /* not kept */ } };

// ------------------------------------------------------------------- state
/** A sheet: one opened picture, what is left of it and its marked parts. */
const sheets = [];
let current = null;      // the sheet shown
let selected = null;     // the selected box (of the current sheet)
let picking = false;     // the next click takes the background colour
let tool = 'select';     // select | wand (erase an area) | erase | restore (brushes)
let hover = null;        // where the pointer is over the picture, for the brush
// Where the bar of views sits at the selected part: above or below it, and
// at which x (null: its middle). A click on a part puts it by the pointer.
const barAt = { side: 'top', x: null };
let showOriginal = false;
let nextId = 1;
let nameTyped = false;
let deriving = null;     // the view whose source is being chosen

const view = $('view'), ctx = view.getContext('2d');
const stage = $('stage');

// ------------------------------------------------------------------ helpers
const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
const allBoxes = () => sheets.flatMap(s => s.boxes.map(box => ({ sheet: s, box })));

// ------------------------------------------------------------ opening files
/** A sheet of a picture, not yet worked on nor shown. */
async function makeSheet(blob, name) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob); } catch { toast(`Could not read ${name || 'the picture'}`); return; }
  const w = bitmap.width, h = bitmap.height;
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w; srcCanvas.height = h;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const src = sctx.getImageData(0, 0, w, h).data;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const sheet = {
    id: nextId++, name: name || 'picture', blob, w, h, src, out: src, srcCanvas, canvas,
    on: alphaShare(src) < 0.02,   // a picture that is already cut out is left alone
    auto: true, color: borderColor(src, w, h),
    boxes: [], found: true,       // found: the boxes are as detected, nobody has touched them
    mask: null, undo: [],         // the work by hand: 1 erased, 2 kept (see core.js)
    method: opt.method, matte: null, busy: false,   // the model's matte, once it has run
    view: null,
  };
  return sheet;
}

async function addImage(blob, name) {
  const sheet = await makeSheet(blob, (name || 'picture').replace(/\.[^.]+$/, ''));
  if (!sheet) return;
  sheets.push(sheet);
  process(sheet);
  show(sheet);
  wantMatte(sheet);
  if (!nameTyped) $('name').value = sheets[0].name;
}

const isProject = f => /\.imageforge$/i.test(f.name || '');

async function addFiles(files) {
  for (const f of files) {
    if (isProject(f)) await openProject(f);
    else if (f.type.startsWith('image/')) await addImage(f, f.name);
  }
}

// ----------------------------------------------------------------- projects
// A project is a zip: project.json, the pictures as they were opened, and
// the work by hand on each as a PNG (its red is 100 times the mask).
async function maskPng(sheet, bytes = sheet.mask, scale = 100) {
  const c = document.createElement('canvas');
  c.width = sheet.w; c.height = sheet.h;
  const image = new ImageData(sheet.w, sheet.h), d = image.data;
  for (let i = 0; i < bytes.length; i++) { d[i * 4] = bytes[i] * scale; d[i * 4 + 3] = 255; }
  c.getContext('2d').putImageData(image, 0, 0);
  return new Uint8Array(await (await toPng(c)).arrayBuffer());
}

async function readMask(bytes, w, h, scale = 100) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none' });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  const d = g.getImageData(0, 0, w, h).data, mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = Math.round(d[i * 4] / scale);
  return mask;
}

async function saveProject() {
  if (!sheets.length) { toast('Nothing to save yet: open a picture first'); return; }
  const files = [], list = [];
  for (const [i, s] of sheets.entries()) {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[s.blob.type] || 'img';
    const file = `image-${i + 1}.${ext}`;
    files.push({ name: file, data: new Uint8Array(await s.blob.arrayBuffer()) });
    let mask = null;
    if (s.mask && s.mask.some(v => v)) {
      mask = `mask-${i + 1}.png`;
      files.push({ name: mask, data: await maskPng(s) });
    }
    // The model's matte too, so that it need not run again.
    let matte = null;
    if (s.matte) {
      matte = `matte-${i + 1}.png`;
      files.push({ name: matte, data: await maskPng(s, s.matte, 1) });
    }
    list.push({
      name: s.name, file, type: s.blob.type, mask, matte, method: s.method, on: s.on, auto: s.auto, color: s.color, found: s.found,
      boxes: s.boxes.map(({ x, y, w, h, label }) => ({ x, y, w, h, label })),
    });
  }
  const project = { format: 'image-forge', version: 1, name: $('name').value, current: sheets.indexOf(current), opt, sheets: list };
  files.unshift({ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(project, null, 1)) });
  download(new Blob([zip(files)], { type: 'application/zip' }), `${fileName('x').slice(0, -6)}.imageforge`);
  toast('Project saved: open the file again to go on');
}

async function openProject(file) {
  let entries, project;
  try {
    entries = unzip(new Uint8Array(await file.arrayBuffer()));
    project = JSON.parse(new TextDecoder().decode(entries.find(e => e.name === 'project.json').data));
    if (project.format !== 'image-forge' || !Array.isArray(project.sheets)) throw new Error('format');
  } catch { toast(`${file.name} is not an Image Forge project`); return; }
  const opened = [];
  for (const s of project.sheets) {
    const entry = entries.find(e => e.name === s.file);
    const sheet = entry && await makeSheet(new Blob([entry.data], { type: s.type || 'image/png' }), s.name);
    if (!sheet) continue;
    sheet.on = !!s.on; sheet.auto = !!s.auto; sheet.found = !!s.found;
    if (Array.isArray(s.color)) sheet.color = s.color;
    sheet.boxes = (s.boxes || []).map(b => ({ id: nextId++, x: b.x, y: b.y, w: b.w, h: b.h, label: LABELS.includes(b.label) ? b.label : null }));
    const mask = s.mask && entries.find(e => e.name === s.mask);
    if (mask) sheet.mask = await readMask(mask.data, sheet.w, sheet.h);
    const matte = s.matte && entries.find(e => e.name === s.matte);
    if (matte) sheet.matte = await readMask(matte.data, sheet.w, sheet.h, 1);
    sheet.method = ['color', 'ai', 'both'].includes(s.method) ? s.method : 'color';
    opened.push(sheet);
  }
  if (!opened.length) { toast(`${file.name} holds no pictures`); return; }
  // The project takes the place of what was open.
  for (const key of Object.keys(defaults)) if (project.opt && key in project.opt) opt[key] = project.opt[key];
  opt.derived = { ...(project.opt?.derived || {}) };
  save();
  syncControls();
  sheets.length = 0; deriving = null; tool = 'select'; picking = false;
  sheets.push(...opened);
  for (const s of sheets) process(s, false);
  for (const s of sheets) wantMatte(s);
  $('name').value = project.name || ''; nameTyped = true;
  show(sheets[project.current] || sheets[0]);
  toast(`Opened ${file.name}`);
}

function closeSheet(sheet) {
  sheets.splice(sheets.indexOf(sheet), 1);
  if (current === sheet) show(sheets[sheets.length - 1] || null);
  else refresh();
}

function show(sheet) {
  current = sheet;
  selected = sheet ? sheet.boxes.find(b => !b.label) || null : null;
  if (sheet && !sheet.view) fit();
  refresh();
}

// --------------------------------------------------------------- processing
function process(sheet, redetect = sheet.found) {
  const { src, w, h, mask } = sheet;
  // Only the work by hand: no background is keyed out by colour.
  const byHand = () => (mask ? removeBackground(src, w, h, { color: [0, 0, 0], tolerance: -1, mask }) : src);
  const byColor = choke => removeBackground(src, w, h, {
    color: sheet.color, tolerance: opt.tolerance, soft: opt.soft, holes: opt.holes, defringe: opt.defringe, choke, mask,
  });
  if (!sheet.on) sheet.out = byHand();
  else if (sheet.method === 'color' || !sheet.matte) sheet.out = byColor(opt.choke);   // also while the model is still at it
  else if (sheet.method === 'both') sheet.out = applyMatte(byColor(0), w, h, sheet.matte, { mask, choke: opt.choke });
  else {
    const out = byHand();
    sheet.out = applyMatte(out === src ? new Uint8ClampedArray(src) : out, w, h, sheet.matte, {
      mask, color: opt.defringe ? sheet.color : null, choke: opt.choke,
    });
  }
  sheet.canvas.getContext('2d').putImageData(new ImageData(sheet.out, sheet.w, sheet.h), 0, 0);
  if (redetect) detect(sheet);
}

function detect(sheet) {
  const was = sheet === current && selected ? sheet.boxes.indexOf(selected) : -1;
  sheet.boxes = detectParts(sheet.out, sheet.w, sheet.h, { gap: opt.gap / 100 })
    .map(b => ({ id: nextId++, ...b, label: null }));
  sheet.found = true;
  if (sheet === current) selected = sheet.boxes[was] || sheet.boxes[0] || null;
}

// ------------------------------------------------------------- the AI model
// It runs in a worker (ai-worker.js), which is only started, and the model
// only downloaded, when a picture first asks for it.
let aiWorker = null, aiNote = '';
const aiWaiting = new Map();

function wantMatte(sheet) {
  if (!sheet.on || sheet.method === 'color' || sheet.matte || sheet.busy) return;
  if (!aiWorker) {
    aiWorker = new Worker('ai-worker.js', { type: 'module' });
    aiWorker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') { aiNote = m.text; $('aiNote').textContent = aiNote; return; }
      const s = aiWaiting.get(m.id);
      aiWaiting.delete(m.id);
      if (!aiWaiting.size) aiNote = '';
      if (!s) return;
      s.busy = false;
      if (m.type === 'done') {
        s.matte = new Uint8Array(m.matte);
        if (sheets.includes(s)) { process(s); toast(`The model found the background in ${Math.round(m.ms / 1000)} s`); }
      } else {
        s.method = 'color';
        toast(`The model did not run: ${m.message}`.slice(0, 160));
      }
      refresh();
    };
    aiWorker.onerror = e => {
      for (const s of aiWaiting.values()) { s.busy = false; s.method = 'color'; }
      aiWaiting.clear(); aiNote = ''; aiWorker = null;
      toast(`The model could not be started: ${e.message || 'no connection?'}`.slice(0, 160));
      refresh();
    };
  }
  sheet.busy = true;
  aiWaiting.set(sheet.id, sheet);
  aiNote ||= 'Starting the model…';
  aiWorker.postMessage({ id: sheet.id, data: sheet.src.buffer.slice(0), width: sheet.w, height: sheet.h });
  refresh();
}

// ------------------------------------------------------------ work by hand
function remember() {
  current.undo.push(current.mask ? current.mask.slice() : null);
  if (current.undo.length > 30) current.undo.shift();
  if (!current.mask) current.mask = new Uint8Array(current.w * current.h);
}

function undo() {
  if (!current?.undo.length) { toast('Nothing to undo'); return; }
  current.mask = current.undo.pop();
  process(current);
  refresh();
}

/** Erases the one-coloured area around a point of the picture. */
function eraseArea(q) {
  const x = Math.floor(q.x), y = Math.floor(q.y);
  if (x < 0 || y < 0 || x >= current.w || y >= current.h) return;
  remember();
  floodMask(current.src, current.w, current.h, x, y, Math.max(6, opt.tolerance + opt.soft), current.mask, 1);
  process(current);
  refresh();
}

/** A piece of a brush stroke: into the mask, and at once onto the picture shown. */
function stroke(from, to) {
  const r = opt.brush / 2, g = current.canvas.getContext('2d');
  paintMask(current.mask, current.w, current.h, from.x, from.y, to.x, to.y, r, tool === 'erase' ? 1 : 2);
  g.save();
  g.lineWidth = 2 * r; g.lineCap = 'round';
  g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(to.x + .01, to.y);
  if (tool === 'erase') {
    g.globalCompositeOperation = 'destination-out';
    g.stroke();
  } else {
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, r / 2));
    g.beginPath();
    for (let i = 0; i <= steps; i++) {
      const k = steps ? i / steps : 0, x = from.x + (to.x - from.x) * k, y = from.y + (to.y - from.y) * k;
      g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2);
    }
    g.clip();
    g.globalCompositeOperation = 'copy';
    g.drawImage(current.srcCanvas, 0, 0);
  }
  g.restore();
}

function setTool(next) {
  tool = next;
  picking = false;
  refresh();
}

const reprocessAll = debounce(() => { for (const s of sheets) process(s); refresh(); }, 50);

// ------------------------------------------------------------------ labels
function assign(box, label) {
  if (box.label === label) box.label = null;
  else {
    for (const { box: other } of allBoxes()) if (other.label === label) other.label = null;
    box.label = label;
    if (opt.derived[label]) { delete opt.derived[label]; save(); if (deriving === label) deriving = null; }
    // On to the next part that has no label yet.
    const i = current.boxes.indexOf(box);
    const order = [...current.boxes.slice(i + 1), ...current.boxes.slice(0, i)];
    const next = order.find(b => !b.label) || box;
    if (next !== selected) barAt.x = null;
    selected = next;
  }
  current.found = false;
  refresh();
}

function removeBox(box) {
  const i = current.boxes.indexOf(box);
  current.boxes.splice(i, 1);
  current.found = false;
  selected = current.boxes[Math.min(i, current.boxes.length - 1)] || null;
  refresh();
}

// ------------------------------------------------------------------- export
/**
 * The views to export, in their order, with what to cut out: the labelled
 * parts, and the views that are taken from one of those, mirrored or turned.
 */
function collect() {
  const direct = {};
  for (const { sheet, box } of allBoxes()) {
    if (!box.label) continue;
    const r = (opt.trim && contentBounds(sheet.out, sheet.w, sheet.h, box)) || { x: box.x, y: box.y, w: box.w, h: box.h };
    direct[box.label] = { label: box.label, sheet, box, r, mirror: false, turn: 0, size: { w: r.w, h: r.h } };
  }
  const items = [];
  for (const label of LABELS) {
    const d = opt.derived[label];
    if (direct[label]) items.push(direct[label]);
    else if (d && direct[d.from]) {
      const from = direct[d.from], side = d.turn % 180 !== 0;
      items.push({
        ...from, label, derived: true, mirror: !!d.mirror, turn: d.turn || 0,
        size: side ? { w: from.r.h, h: from.r.w } : from.size,
      });
    }
  }
  return items;
}

/** The pictures of `items` as canvases; `limit` caps the longer side (thumbnails). */
function render(items, limit = 0) {
  const lay = layoutViews(items.map(i => i.size), opt);
  return items.map((it, i) => {
    const L = lay[i];
    const k = limit ? Math.min(1, limit / Math.max(L.W, L.H)) : 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(L.W * k)); c.height = Math.max(1, Math.round(L.H * k));
    const g = c.getContext('2d');
    if (opt.fill !== 'transparent') {
      g.fillStyle = opt.fill === 'custom' ? opt.fillColor : opt.fill;
      g.fillRect(0, 0, c.width, c.height);
    }
    g.imageSmoothingQuality = 'high';
    // The cut-out about the middle of its place: mirrored first, then turned.
    const side = it.turn % 180 !== 0, dw = (side ? L.h : L.w) * k, dh = (side ? L.w : L.h) * k;
    g.translate((L.x + L.w / 2) * k, (L.y + L.h / 2) * k);
    g.rotate(it.turn * Math.PI / 180);
    if (it.mirror) g.scale(-1, 1);
    g.drawImage(it.sheet.canvas, it.r.x, it.r.y, it.r.w, it.r.h, -dw / 2, -dh / 2, dw, dh);
    return c;
  });
}

const fileName = label => `${($('name').value.trim() || 'model').replace(/[\\/:*?"<>|]+/g, '-')}_${label}.png`;
const toPng = canvas => new Promise(done => canvas.toBlob(done, 'image/png'));

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** Every labelled view as its own PNG, downloaded one after the other. */
async function exportImages() {
  const items = collect();
  if (!items.length) { toast('Nothing to export yet: give a part a view first'); return; }
  const canvases = render(items);
  for (let i = 0; i < items.length; i++) {
    download(await toPng(canvases[i]), fileName(items[i].label));
    await new Promise(done => setTimeout(done, 250));   // browsers drop downloads that come all at once
  }
  toast(`Exported ${items.length} picture${items.length > 1 ? 's' : ''}`);
}

async function exportZip() {
  const items = collect();
  if (!items.length) { toast('Nothing to export yet: give a part a view first'); return; }
  const canvases = render(items);
  const files = [];
  for (let i = 0; i < items.length; i++) {
    const blob = await toPng(canvases[i]);
    files.push({ name: fileName(items[i].label), data: new Uint8Array(await blob.arrayBuffer()) });
  }
  const base = fileName('x').slice(0, -6);
  download(new Blob([zip(files)], { type: 'application/zip' }), `${base}_views.zip`);
  toast(`Exported ${files.length} view${files.length > 1 ? 's' : ''}`);
}

async function exportOne(label) {
  const items = collect();
  const i = items.findIndex(it => it.label === label);
  if (i >= 0) download(await toPng(render(items)[i]), fileName(label));
}

// -------------------------------------------------------------------- tiles
const tiles = {};
for (const label of LABELS) {
  const key = Object.keys(KEYS).find(k => KEYS[k] === label).toUpperCase();
  const el = document.createElement('div');
  el.className = 'tile empty';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.style.setProperty('--c', COLORS[label]);
  el.innerHTML = `<span class="name">${label}</span><kbd>${key}</kbd>
    <span class="src"></span>
    <span class="acts"><span data-act="from" title="Take this view from another view, mirrored or turned">from…</span><span data-act="save" title="Download this view">save</span><span data-act="clear" title="Empty this view">×</span></span>`;
  el.title = `The ${label} view. With a part selected: click to give it this view (key ${key}). Otherwise: click to select its part.`;
  const act = e => {
    const hit = allBoxes().find(x => x.box.label === label);
    const what = e.target.dataset?.act;
    if (what === 'save') exportOne(label);
    else if (what === 'clear') {
      if (hit) hit.box.label = null;
      delete opt.derived[label]; save();
      if (deriving === label) deriving = null;
      refresh();
    } else if (what === 'from') {
      // One click gives the usual case: the opposite view, mirrored.
      if (!opt.derived[label]) {
        if (hit) hit.box.label = null;
        opt.derived[label] = { from: OPPOSITE[label], mirror: true, turn: 0 };
        save();
      }
      deriving = label;
      refresh();
    } else if (selected && selected.label !== label) assign(selected, label);
    else if (hit) { if (hit.sheet !== current) show(hit.sheet); selected = hit.box; refresh(); }
    else if (opt.derived[label]) { deriving = label; refresh(); }
    else toast('Select a part in the picture first, or use "from…" to take this view from another');
  };
  el.addEventListener('click', act);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(e); } });
  $('tiles').append(el);
  tiles[label] = el;
}

// The same choice by the mouse, right at the selected part.
const tagbar = $('tagbar');
for (const label of LABELS) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.dataset.label = label;
  b.title = `The selected part is the ${label} view (key ${Object.keys(KEYS).find(k => KEYS[k] === label).toUpperCase()})`;
  b.style.setProperty('--c', COLORS[label]);
  b.addEventListener('click', () => { if (selected) assign(selected, label); view.focus(); });
  tagbar.append(b);
}
{
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = '×'; b.title = 'Remove this part (Delete)'; b.className = 'x';
  b.addEventListener('click', () => { if (selected) removeBox(selected); view.focus(); });
  tagbar.append(b);
}

function placeTagbar(r) {
  if (!current || !selected || tool !== 'select' || picking || drag) { tagbar.style.display = 'none'; return; }
  tagbar.style.display = 'flex';
  for (const b of tagbar.children) b.classList.toggle('on', !!b.dataset.label && b.dataset.label === selected.label);
  const s = toScreen(selected, current.view), bw = tagbar.offsetWidth, bh = tagbar.offsetHeight;
  const x = clamp((barAt.x ?? s.x + s.w / 2) - bw / 2, 4, Math.max(4, r.width - bw - 4));
  // Above the part (clear of its name tag) or below it; inside the view,
  // and under the tools, even when the part reaches beyond.
  const top = 52, bottom = Math.max(top, r.height - bh - 4);
  const y = clamp(barAt.side === 'top' ? s.y - bh - 24 : s.y + s.h + 8, top, bottom);
  tagbar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

const refreshTiles = debounce(() => {
  const items = collect(), thumbs = render(items, 220);
  for (const label of LABELS) {
    const el = tiles[label], i = items.findIndex(it => it.label === label);
    el.querySelector('canvas')?.remove();
    el.classList.toggle('full', i >= 0);
    el.classList.toggle('empty', i < 0);
    el.classList.toggle('on', i >= 0 && !items[i].derived && items[i].box === selected);
    if (i >= 0) el.prepend(thumbs[i]);
    const d = opt.derived[label];
    el.querySelector('.src').textContent = d ? `= ${d.from}${d.mirror ? ', mirrored' : ''}${d.turn ? ', turned' : ''}` : '';
  }
  // The choice of where a view is taken from.
  const d = deriving && opt.derived[deriving];
  $('derive').style.display = d ? 'flex' : 'none';
  if (d) {
    $('deriveName').textContent = deriving;
    $('deriveFrom').replaceChildren(...LABELS.filter(l => l !== deriving).map(l => new Option(l, l)));
    $('deriveFrom').value = d.from;
    $('deriveMirror').checked = !!d.mirror;
    $('deriveTurn').value = String(d.turn || 0);
    $('deriveNote').textContent = allBoxes().some(e => e.box.label === d.from) ? '' : `Nothing to show yet: no part is the ${d.from} view.`;
  }
  const lay = layoutViews(items.map(i => i.size), opt);
  const sizes = [...new Set(lay.map(l => `${l.W} × ${l.H}`))];
  $('sizes').textContent = !items.length ? '' : sizes.length === 1
    ? `${items.length} picture${items.length > 1 ? 's' : ''} of ${sizes[0]} px`
    : `${items.length} pictures, ${sizes.join(', ')} px`;
}, 30);

// ------------------------------------------------------------------ drawing
let checker;
function fit() {
  if (!current) return;
  const r = view.getBoundingClientRect();
  const z = Math.min((r.width - 40) / current.w, (r.height - 40) / current.h) || 1;
  current.view = { z, x: (r.width - current.w * z) / 2, y: (r.height - current.h * z) / 2 };
  draw();
}

const HANDLES = [[0, 0], [.5, 0], [1, 0], [1, .5], [1, 1], [.5, 1], [0, 1], [0, .5]];
const toScreen = (b, v) => ({ x: v.x + b.x * v.z, y: v.y + b.y * v.z, w: b.w * v.z, h: b.h * v.z });

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; paint(); });
}

function paint() {
  const dpr = window.devicePixelRatio || 1, r = view.getBoundingClientRect();
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (view.width !== W || view.height !== H) { view.width = W; view.height = H; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  placeTagbar(r);
  if (!current) return;
  const v = current.view, css = getComputedStyle(document.documentElement);
  if (!checker) {
    const c = document.createElement('canvas');
    c.width = c.height = 20;
    const g = c.getContext('2d');
    g.fillStyle = css.getPropertyValue('--check-a'); g.fillRect(0, 0, 20, 20);
    g.fillStyle = css.getPropertyValue('--check-b'); g.fillRect(0, 0, 10, 10); g.fillRect(10, 10, 10, 10);
    checker = ctx.createPattern(c, 'repeat');
  }
  // Behind the picture: what the exported pictures will have behind them.
  ctx.fillStyle = opt.fill === 'transparent' ? checker : opt.fill === 'custom' ? opt.fillColor : opt.fill;
  ctx.fillRect(v.x, v.y, current.w * v.z, current.h * v.z);
  ctx.imageSmoothingEnabled = v.z < 2;
  ctx.drawImage(showOriginal ? current.srcCanvas : current.canvas, v.x, v.y, current.w * v.z, current.h * v.z);

  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const b of [...current.boxes.filter(b => b !== selected), ...(selected ? [selected] : [])]) {
    const s = toScreen(b, v), color = b.label ? COLORS[b.label] : NEUTRAL, on = b === selected;
    ctx.lineWidth = on ? 2.5 : 1.5;
    ctx.strokeStyle = color;
    ctx.setLineDash(b.label ? [] : [6, 4]);
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.setLineDash([]);
    const text = (b.label || 'no view').toUpperCase(), tw = ctx.measureText(text).width + 10;
    const ty = s.y >= 18 ? s.y - 17 : s.y;
    ctx.fillStyle = color;
    ctx.fillRect(s.x - 1, ty, tw, 17);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, s.x + 4, ty + 9);
    if (on) {
      for (const [hx, hy] of HANDLES) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.rect(s.x + s.w * hx - 4, s.y + s.h * hy - 4, 8, 8); ctx.fill(); ctx.stroke();
      }
    }
  }
  if ((tool === 'erase' || tool === 'restore') && hover) {
    for (const [color, width] of [['#000', 3], ['#fff', 1.5]]) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.arc(hover.x, hover.y, Math.max(2, opt.brush / 2 * v.z), 0, Math.PI * 2); ctx.stroke();
    }
  }
}

function refresh() {
  $('empty').style.display = current ? 'none' : '';
  // The strip of opened pictures.
  $('sheets').replaceChildren(...sheets.map(s => {
    const el = document.createElement('div');
    el.className = 'sheet' + (s === current ? ' on' : '');
    const name = document.createElement('span');
    name.textContent = s.name;
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '×'; x.title = 'Close this picture';
    x.addEventListener('click', e => { e.stopPropagation(); closeSheet(s); });
    el.append(name, x);
    el.addEventListener('click', () => show(s));
    return el;
  }));
  $('bgOn').checked = !!current?.on;
  $('method').value = current?.method || opt.method;
  $('aiNote').textContent = current?.busy ? aiNote : '';
  $('bgColor').value = hex(current?.color || [255, 255, 255]);
  $('bgAuto').classList.toggle('on', !!current?.auto);
  $('bgPick').classList.toggle('on', picking);
  $('info').textContent = current
    ? `${current.w} × ${current.h} px · ${current.boxes.length} part${current.boxes.length === 1 ? '' : 's'} · ${Math.round(current.view.z * 100)} %`
    : '';
  view.style.cursor = picking || tool === 'wand' ? 'crosshair' : tool !== 'select' ? 'none' : '';
  $('tools').style.display = current ? 'flex' : 'none';
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  $('brushSize').style.display = tool === 'erase' || tool === 'restore' ? '' : 'none';
  $('undo').disabled = !current?.undo.length;
  $('hint').textContent = {
    select: 'Drag: mark a part · Wheel: zoom · Space or middle button: pan · 0: fit',
    wand: 'Click an area to make it transparent (as far as Tolerance and Soft edge reach) · Ctrl+Z: undo',
    erase: 'Paint what is to be transparent · [ ]: size · Ctrl+Z: undo',
    restore: 'Paint what is to come back · [ ]: size · Ctrl+Z: undo',
  }[tool];
  draw();
  refreshTiles();
}

// ----------------------------------------------------------------- pointing
let drag = null, spaceDown = false;
const local = e => { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const toImage = p => ({ x: (p.x - current.view.x) / current.view.z, y: (p.y - current.view.y) / current.view.z });

function hit(p) {
  const v = current.view;
  if (selected) {
    const s = toScreen(selected, v);
    for (const [hx, hy] of HANDLES) {
      if (Math.abs(p.x - (s.x + s.w * hx)) <= 7 && Math.abs(p.y - (s.y + s.h * hy)) <= 7) return { box: selected, handle: [hx, hy] };
    }
  }
  const inside = current.boxes.filter(b => {
    const s = toScreen(b, v);
    return p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h;
  });
  if (!inside.length) return null;
  // Of nested boxes the smallest is the one meant.
  inside.sort((a, b) => a.w * a.h - b.w * b.h);
  return { box: inside[0] };
}

const CURSORS = { '0,0': 'nwse', '1,1': 'nwse', '1,0': 'nesw', '0,1': 'nesw', '0.5,0': 'ns', '0.5,1': 'ns', '0,0.5': 'ew', '1,0.5': 'ew' };

view.addEventListener('pointerdown', e => {
  if (!current) return;
  view.focus();
  const p = local(e);
  if (e.button === 1 || e.button === 2 || spaceDown) {
    drag = { kind: 'pan', p, x: current.view.x, y: current.view.y };
  } else if (picking) {
    const q = toImage(p), x = Math.floor(q.x), y = Math.floor(q.y);
    if (x >= 0 && y >= 0 && x < current.w && y < current.h) {
      const i = (y * current.w + x) * 4;
      current.color = [current.src[i], current.src[i + 1], current.src[i + 2]];
      current.auto = false; current.on = true;
      process(current);
    }
    picking = false;
    refresh();
    return;
  } else if (tool === 'wand') {
    eraseArea(toImage(p));
    return;
  } else if (tool !== 'select') {
    const q = toImage(p);
    remember();
    drag = { kind: 'brush', p, last: q };
    stroke(q, q);
  } else {
    const h = hit(p);
    if (h) {
      selected = h.box;
      const s = toScreen(h.box, current.view);
      barAt.side = p.y < s.y + s.h / 2 ? 'top' : 'bottom';
      barAt.x = p.x;
      drag = { kind: h.handle ? 'size' : 'move', p, box: h.box, handle: h.handle, from: { ...h.box }, moved: false };
    } else {
      drag = { kind: 'new', p, start: toImage(p), box: null };
    }
  }
  view.setPointerCapture(e.pointerId);
  e.preventDefault();
  refresh();
});

view.addEventListener('pointermove', e => {
  if (!current) return;
  const p = local(e), v = current.view;
  hover = p;
  if (tool === 'erase' || tool === 'restore') draw();
  if (!drag) {
    if (picking || tool !== 'select') return;
    const h = hit(p);
    view.style.cursor = spaceDown ? 'grab' : h?.handle ? CURSORS[h.handle.join(',')] + '-resize' : h ? 'move' : 'crosshair';
    return;
  }
  const dx = (p.x - drag.p.x) / v.z, dy = (p.y - drag.p.y) / v.z;
  if (drag.kind === 'pan') {
    v.x = drag.x + p.x - drag.p.x; v.y = drag.y + p.y - drag.p.y;
    draw();
    return;
  }
  if (drag.kind === 'brush') {
    const q = toImage(p);
    stroke(drag.last, q);
    drag.last = q;
    draw();
    return;
  }
  const W = current.w, H = current.h;
  if (drag.kind === 'move') {
    const b = drag.box, f = drag.from;
    b.x = Math.round(clamp(f.x + dx, 0, W - f.w)); b.y = Math.round(clamp(f.y + dy, 0, H - f.h));
    drag.moved = true;
  } else {
    let x0, y0, x1, y1;
    if (drag.kind === 'new') {
      if (!drag.box && Math.hypot(p.x - drag.p.x, p.y - drag.p.y) < 5) return;
      if (!drag.box) {
        drag.box = { id: nextId++, x: 0, y: 0, w: 1, h: 1, label: null };
        current.boxes.push(drag.box);
        selected = drag.box;
      }
      const q = toImage(p);
      x0 = drag.start.x; y0 = drag.start.y; x1 = q.x; y1 = q.y;
    } else {
      const f = drag.from, [hx, hy] = drag.handle;
      x0 = f.x; y0 = f.y; x1 = f.x + f.w; y1 = f.y + f.h;
      if (hx === 0) x0 += dx; else if (hx === 1) x1 += dx;
      if (hy === 0) y0 += dy; else if (hy === 1) y1 += dy;
    }
    const b = drag.box;
    const ax = Math.round(clamp(Math.min(x0, x1), 0, W)), bx = Math.round(clamp(Math.max(x0, x1), 0, W));
    const ay = Math.round(clamp(Math.min(y0, y1), 0, H)), by = Math.round(clamp(Math.max(y0, y1), 0, H));
    b.x = ax; b.y = ay; b.w = Math.max(1, bx - ax); b.h = Math.max(1, by - ay);
    drag.moved = true;
  }
  current.found = false;
  draw();
  refreshTiles();
});

function endDrag() {
  if (!drag) return;
  if (drag.kind === 'brush') process(current);
  if (drag.kind === 'new' && !drag.box) selected = null;   // a click on nothing
  if (drag.kind === 'new' && drag.box && (drag.box.w < 3 || drag.box.h < 3)) removeBox(drag.box);
  drag = null;
  refresh();
}
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);
view.addEventListener('pointerleave', () => { hover = null; draw(); });
view.addEventListener('contextmenu', e => e.preventDefault());

view.addEventListener('wheel', e => {
  if (!current) return;
  e.preventDefault();
  const p = local(e), v = current.view;
  const z = clamp(v.z * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), 0.02, 40);
  v.x = p.x - (p.x - v.x) * z / v.z; v.y = p.y - (p.y - v.y) * z / v.z; v.z = z;
  refresh();
}, { passive: false });

// ----------------------------------------------------------------- keyboard
const typing = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'range';

window.addEventListener('keydown', e => {
  if (typing(e)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); if (e.shiftKey) exportZip(); else exportImages(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === ' ') { spaceDown = true; if (e.target === view || e.target === document.body) e.preventDefault(); return; }
  if (!current) return;
  if (k === 'o') { if (!showOriginal) { showOriginal = true; draw(); } return; }
  if (k === '0') { fit(); refresh(); return; }
  if (k === 'escape') { picking = false; if (tool !== 'select') tool = 'select'; else selected = null; refresh(); return; }
  const picked = { v: 'select', w: 'wand', e: 'erase', q: 'restore' }[k];
  if (picked) { setTool(picked); return; }
  if (k === '[' || k === ']') {
    opt.brush = clamp(Math.round(opt.brush * (k === ']' ? 1.25 : 0.8)), 2, 300);
    save();
    document.querySelector('[data-opt=brush]').value = opt.brush;
    draw();
    return;
  }
  if (tool !== 'select') return;
  if (k === 'tab' && e.target === view) {
    e.preventDefault();
    const n = current.boxes.length;
    if (n) selected = current.boxes[(current.boxes.indexOf(selected) + (e.shiftKey ? n - 1 : 1) + n) % n];
    refresh();
    return;
  }
  if (!selected) return;
  if (KEYS[k]) { assign(selected, KEYS[k]); return; }
  const n = LABELS[Number(k) - 1];
  if (n) { assign(selected, n); return; }
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); removeBox(selected); return; }
  const step = e.shiftKey ? 10 : 1;
  const move = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
  if (move && (e.target === view || e.target === document.body)) {
    e.preventDefault();
    selected.x = clamp(selected.x + move[0], 0, current.w - selected.w);
    selected.y = clamp(selected.y + move[1], 0, current.h - selected.h);
    current.found = false;
    refresh();
  }
});
window.addEventListener('keyup', e => {
  if (e.key === ' ') spaceDown = false;
  if (e.key.toLowerCase() === 'o' && showOriginal && !$('original').checked) { showOriginal = false; draw(); }
});

// ----------------------------------------------------------------- controls
const syncers = [];
const syncControls = () => { for (const sync of syncers) sync(); $('fillColor').hidden = opt.fill !== 'custom'; };
for (const el of document.querySelectorAll('[data-opt]')) {
  const key = el.dataset.opt, out = el.closest('label')?.querySelector('output');
  const unit = { gap: ' %', padding: ' %', choke: ' px' }[key] || '';
  const showValue = () => { if (out) out.textContent = opt[key] + unit; };
  const sync = () => { if (el.type === 'checkbox') el.checked = !!opt[key]; else el.value = opt[key]; showValue(); };
  sync();
  syncers.push(sync);
  el.addEventListener(el.type === 'range' || el.type === 'color' ? 'input' : 'change', () => {
    opt[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' || key === 'size' ? Number(el.value) : el.value;
    save();
    showValue();
    if (['tolerance', 'soft', 'defringe', 'choke', 'holes'].includes(key)) reprocessAll();
    else if (key === 'gap') { if (current) { detect(current); refresh(); } }
    else refresh();
    $('fillColor').hidden = opt.fill !== 'custom';
  });
}
$('fillColor').hidden = opt.fill !== 'custom';

$('bgOn').addEventListener('change', e => { if (current) { current.on = e.target.checked; process(current); refresh(); wantMatte(current); } });
$('method').addEventListener('change', e => {
  opt.method = e.target.value;   // and for the pictures opened from now on
  save();
  if (!current) return;
  current.method = e.target.value;
  process(current);
  refresh();
  wantMatte(current);
});
$('bgColor').addEventListener('input', e => {
  if (!current) return;
  current.color = rgb(e.target.value); current.auto = false; current.on = true;
  process(current); refresh();
});
$('bgAuto').addEventListener('click', () => {
  if (!current) return;
  current.color = borderColor(current.src, current.w, current.h); current.auto = true; current.on = true;
  process(current); refresh();
});
$('bgPick').addEventListener('click', () => { if (current) { picking = !picking; refresh(); } });
$('original').addEventListener('change', e => { showOriginal = e.target.checked; draw(); });
$('detect').addEventListener('click', () => { if (current) { detect(current); refresh(); } });
$('remove').addEventListener('click', () => { if (selected) removeBox(selected); });
$('name').addEventListener('input', () => { nameTyped = true; });
for (const id of ['deriveFrom', 'deriveMirror', 'deriveTurn']) {
  $(id).addEventListener('change', () => {
    if (!deriving) return;
    opt.derived[deriving] = { from: $('deriveFrom').value, mirror: $('deriveMirror').checked, turn: Number($('deriveTurn').value) };
    save();
    refresh();
  });
}
$('deriveOff').addEventListener('click', () => { delete opt.derived[deriving]; deriving = null; save(); refresh(); });
$('deriveDone').addEventListener('click', () => { deriving = null; refresh(); });
$('saveProject').addEventListener('click', saveProject);
$('export').addEventListener('click', exportImages);
$('exportZip').addEventListener('click', exportZip);
$('undo').addEventListener('click', undo);
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => { setTool(b.dataset.tool); view.focus(); });
$('open').addEventListener('click', () => $('file').click());
$('open2').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async e => { await addFiles([...e.target.files]); e.target.value = ''; });
$('sample').addEventListener('click', () => addUrl('sample.png'));
$('paste').addEventListener('click', async () => {
  try {
    let found = false;
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(t => t.startsWith('image/'));
      if (type) { found = true; await addImage(await item.getType(type), 'pasted'); }
    }
    if (!found) toast('There is no picture on the clipboard');
  } catch { toast('The browser did not allow that: press Ctrl+V instead'); }
});
window.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); for (const f of files) addImage(f, f.name === 'image.png' ? 'pasted' : f.name); }
});

for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, e => { e.preventDefault(); stage.classList.add('drop'); });
}
window.addEventListener('dragleave', e => { if (!e.relatedTarget) stage.classList.remove('drop'); });
window.addEventListener('drop', e => {
  e.preventDefault();
  stage.classList.remove('drop');
  addFiles([...(e.dataTransfer?.files || [])]);
});

async function addUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    await addImage(await res.blob(), url.split(/[/?#]/).filter(Boolean).pop());
  } catch { toast('Could not load ' + url); }
}

// ------------------------------------------------------------- explanations
// An (i) beside each setting, and one bubble that shows the explanation of
// whatever is under the pointer: of an (i) at once, of a button after a moment.
const TIPS = [
  ['aside section:nth-of-type(1) h2', 'The six views a 3D tool asks for. Each can hold one part of a picture, or be taken from another view (from…). What is shown here is exactly what is exported.'],
  ['aside section:nth-of-type(2) h2', 'How the background is made transparent. It goes by colour: everything close enough to the background colour, starting from the border of the picture.'],
  ['aside section:nth-of-type(3) h2', 'The boxes in the picture. Each separate thing that is left when the background is gone gets a box; drag in the picture to draw one yourself.'],
  ['aside section:nth-of-type(4) h2', 'What the exported pictures look like. Export images gives one PNG per view, named name_front.png and so on.'],
  ['#method', 'By colour: everything close to the background colour goes. Sharp edges on a plain sheet; leaves closed-in gaps and shadows. By AI model: a model (IS-Net) finds the figures themselves, gaps and shadows included, on any background; softer edges, about 15 seconds a picture, and a download of 180 MB the first time. Both: the colour cut, with what the model calls background taken away as well. All of it runs on this computer.'],
  ['#bgOn', 'Off: the picture is used as it is, for one that is already cut out. Erasing by hand still works.'],
  ['[data-opt=tolerance]', 'How far a colour may be from the background colour and still be removed. Raise it if background or shadow is left; lower it if light parts of the figure disappear. Erase area uses it too.'],
  ['[data-opt=soft]', 'Beyond the tolerance, colours this much further away fade out gradually instead of being cut hard. Gives smoother edges and thins out soft shadows.'],
  ['[data-opt=defringe]', 'The outermost pixels of a figure are a blend of figure and background. This gives them transparency and the colour of the figure, so no light or dark rim follows the cut-out.'],
  ['[data-opt=choke]', 'Cuts this many pixels off the edge all round. For a rim of background that is still left.'],
  ['[data-opt=holes]', 'Also removes background-coloured areas that are closed in by the figure, such as the gap between an arm and the body. Careful: it removes highlights and white eyes too. Erase area does the same for one spot.'],
  ['#original', 'Shows the picture as it was opened, to compare.'],
  ['[data-opt=gap]', 'Loose pieces closer to each other than this (in percent of the longer side of the picture) count as one part. Raise it if a figure falls apart into several boxes; lower it if two figures share one.'],
  ['#name', 'The start of the file names: name_front.png, name_back.png … and of the project file.'],
  ['[data-opt=trim]', 'Cuts each view down to what is visible inside its box, so the box need not be drawn precisely.'],
  ['[data-opt=padding]', 'Empty space around the figure, in percent of its longer side.'],
  ['[data-opt=square]', 'Makes every picture square, with the figure in the middle.'],
  ['[data-opt=same]', 'Gives all views the same picture size, that of the largest. The figures then keep their size relative to each other, which tools that build 3D from views expect.'],
  ['[data-opt=size]', 'Scales the exported pictures so that their longer side has this many pixels.'],
  ['[data-opt=fill]', 'What is behind the figure in the exported pictures: nothing (transparent), or a colour. The workspace shows the same behind the picture, so you see the cut-out as it will be exported.'],
];
for (const [selector, text] of TIPS) {
  const el = document.querySelector(selector);
  if (!el) continue;
  const i = document.createElement('span');
  i.className = 'info'; i.textContent = 'i'; i.tabIndex = 0; i.dataset.tip = text;
  i.setAttribute('role', 'note'); i.setAttribute('aria-label', text);
  i.addEventListener('click', e => e.preventDefault());   // not a click on the setting it sits in
  const label = el.closest('label');
  if (!label) el.append(i);
  else if (label.classList.contains('slider')) label.insertBefore(i, label.querySelector('output'));
  else if (label.classList.contains('check')) label.append(i);
  else label.insertBefore(i, label.querySelector('input, select'));
}
for (const el of document.querySelectorAll('[title]')) { el.dataset.tip = el.title; el.removeAttribute('title'); }

const tip = $('tip');
let tipFor = null, tipTimer;
function showTip(el) {
  tip.textContent = el.dataset.tip;
  tip.style.display = 'block';
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  let y = r.bottom + 8;
  if (y + h > window.innerHeight - 6) y = Math.max(6, r.top - h - 8);
  tip.style.left = Math.round(clamp(r.left + r.width / 2 - w / 2, 6, Math.max(6, window.innerWidth - w - 6))) + 'px';
  tip.style.top = Math.round(y) + 'px';
}
function hideTip() { clearTimeout(tipTimer); tipFor = null; tip.style.display = 'none'; }
document.addEventListener('pointerover', e => {
  const el = e.target.closest?.('[data-tip]');
  if (el === tipFor) return;
  hideTip();
  if (!el) return;
  tipFor = el;
  tipTimer = setTimeout(() => showTip(el), el.classList.contains('info') ? 0 : 450);
});
document.addEventListener('pointerdown', hideTip);
document.addEventListener('scroll', hideTip, true);
document.addEventListener('focusin', e => { if (e.target.classList?.contains('info')) { hideTip(); tipFor = e.target; showTip(e.target); } });
document.addEventListener('focusout', e => { if (e.target.classList?.contains('info')) hideTip(); });

new ResizeObserver(() => draw()).observe(view);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { checker = null; draw(); });
refresh();

// ?src=picture.png opens a picture from an address (same site, or one that allows it).
const src = new URLSearchParams(location.search).get('src');
if (src) addUrl(src);
