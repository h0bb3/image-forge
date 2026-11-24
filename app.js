// Image Forge: the page. The image work itself is in core.js.
import {
  LABELS, alphaShare, borderColor, removeBackground, contentBounds, detectParts, layoutViews, zip,
  floodMask, paintMask,
} from './core.js';

const $ = id => document.getElementById(id);
const KEYS = { f: 'front', b: 'back', l: 'left', r: 'right', t: 'top', d: 'bottom' };
const COLORS = { front: '#d9480f', back: '#1971c2', left: '#2f9e44', right: '#9c36b5', top: '#b08900', bottom: '#0c8599' };
const NEUTRAL = '#868e96';

// ---------------------------------------------------------------- settings
const defaults = {
  tolerance: 18, soft: 14, defringe: true, choke: 0, holes: false, gap: 1.2,
  trim: true, padding: 6, square: true, same: true, size: 0, fill: 'transparent', fillColor: '#ffffff',
  brush: 30,
};
const opt = { ...defaults };
try { Object.assign(opt, JSON.parse(localStorage.getItem('image-forge') || '{}')); } catch { /* defaults */ }
const save = () => { try { localStorage.setItem('image-forge', JSON.stringify(opt)); } catch { /* not kept */ } };

// ------------------------------------------------------------------- state
/** A sheet: one opened picture, what is left of it and its marked parts. */
const sheets = [];
let current = null;      // the sheet shown
let selected = null;     // the selected box (of the current sheet)
let picking = false;     // the next click takes the background colour
let tool = 'select';     // select | wand (erase an area) | erase | restore (brushes)
let hover = null;        // where the pointer is over the picture, for the brush
let showOriginal = false;
let nextId = 1;
let nameTyped = false;

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
async function addImage(blob, name) {
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
    id: nextId++, name: (name || 'picture').replace(/\.[^.]+$/, ''), w, h, src, out: src, srcCanvas, canvas,
    on: alphaShare(src) < 0.02,   // a picture that is already cut out is left alone
    auto: true, color: borderColor(src, w, h),
    boxes: [], found: true,       // found: the boxes are as detected, nobody has touched them
    mask: null, undo: [],         // the work by hand: 1 erased, 2 kept (see core.js)
    view: null,
  };
  sheets.push(sheet);
  process(sheet);
  show(sheet);
  if (!nameTyped) $('name').value = sheets[0].name;
}

async function addFiles(files) {
  for (const f of files) if (f.type.startsWith('image/')) await addImage(f, f.name);
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
  sheet.out = sheet.on
    ? removeBackground(sheet.src, sheet.w, sheet.h, {
      color: sheet.color, tolerance: opt.tolerance, soft: opt.soft, holes: opt.holes, defringe: opt.defringe, choke: opt.choke,
      mask: sheet.mask,
    })
    : sheet.mask
      // No background to key out: only the work by hand counts.
      ? removeBackground(sheet.src, sheet.w, sheet.h, { color: [0, 0, 0], tolerance: -1, mask: sheet.mask })
      : sheet.src;
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
    // On to the next part that has no label yet.
    const i = current.boxes.indexOf(box);
    const order = [...current.boxes.slice(i + 1), ...current.boxes.slice(0, i)];
    selected = order.find(b => !b.label) || box;
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
/** The labelled parts, in the order of the views, with what to cut out. */
function collect() {
  const items = [];
  for (const label of LABELS) {
    const hit = allBoxes().find(e => e.box.label === label);
    if (!hit) continue;
    const { sheet, box } = hit;
    const r = (opt.trim && contentBounds(sheet.out, sheet.w, sheet.h, box)) || { x: box.x, y: box.y, w: box.w, h: box.h };
    items.push({ label, sheet, box, r });
  }
  return items;
}

/** The pictures of `items` as canvases; `limit` caps the longer side (thumbnails). */
function render(items, limit = 0) {
  const lay = layoutViews(items.map(i => i.r), opt);
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
    g.drawImage(it.sheet.canvas, it.r.x, it.r.y, it.r.w, it.r.h, L.x * k, L.y * k, L.w * k, L.h * k);
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
    <span class="acts"><span data-act="save" title="Download this view">save</span><span data-act="clear" title="Take the view from its part">×</span></span>`;
  el.title = `${label[0].toUpperCase()}${label.slice(1)} (${key})`;
  const act = e => {
    const hit = allBoxes().find(x => x.box.label === label);
    const what = e.target.dataset?.act;
    if (what === 'save') exportOne(label);
    else if (what === 'clear') { if (hit) { hit.box.label = null; refresh(); } }
    else if (selected && selected.label !== label) assign(selected, label);
    else if (hit) { if (hit.sheet !== current) show(hit.sheet); selected = hit.box; refresh(); }
    else toast('Select a part in the picture first');
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
  const x = clamp(s.x + s.w / 2 - bw / 2, 4, Math.max(4, r.width - bw - 4));
  let y = s.y + s.h + 8;
  if (y + bh > r.height - 4) y = Math.max(4, Math.min(s.y + s.h, r.height) - bh - 8);
  tagbar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

const refreshTiles = debounce(() => {
  const items = collect(), thumbs = render(items, 220);
  for (const label of LABELS) {
    const el = tiles[label], i = items.findIndex(it => it.label === label);
    el.querySelector('canvas')?.remove();
    el.classList.toggle('full', i >= 0);
    el.classList.toggle('empty', i < 0);
    el.classList.toggle('on', i >= 0 && items[i].box === selected);
    if (i >= 0) el.prepend(thumbs[i]);
  }
  const lay = layoutViews(items.map(i => i.r), opt);
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
  ctx.fillStyle = checker;
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
    drag = { kind: 'brush', last: q };
    stroke(q, q);
  } else {
    const h = hit(p);
    if (h) {
      selected = h.box;
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
for (const el of document.querySelectorAll('[data-opt]')) {
  const key = el.dataset.opt, out = el.closest('label')?.querySelector('output');
  const unit = { gap: ' %', padding: ' %', choke: ' px' }[key] || '';
  const showValue = () => { if (out) out.textContent = opt[key] + unit; };
  if (el.type === 'checkbox') el.checked = !!opt[key]; else el.value = opt[key];
  showValue();
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

$('bgOn').addEventListener('change', e => { if (current) { current.on = e.target.checked; process(current); refresh(); } });
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

new ResizeObserver(() => draw()).observe(view);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { checker = null; draw(); });
refresh();

// ?src=picture.png opens a picture from an address (same site, or one that allows it).
const src = new URLSearchParams(location.search).get('src');
if (src) addUrl(src);
