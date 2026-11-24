// Image Forge: the image work, free of the page (see test.html).
// Pixels are RGBA bytes, row by row, as in ImageData.

export const LABELS = ['front', 'back', 'left', 'right', 'top', 'bottom'];

/** The share of pixels that are not opaque. */
export function alphaShare(d) {
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) n++;
  return n / (d.length / 4);
}

/** The commonest colour along the border: the background of a sheet. */
export function borderColor(d, w, h) {
  const bins = new Map();
  const add = (x, y) => {
    const p = (y * w + x) * 4;
    if (d[p + 3] < 128) return;
    const k = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
    let b = bins.get(k);
    if (!b) bins.set(k, (b = [0, 0, 0, 0]));
    b[0]++; b[1] += d[p]; b[2] += d[p + 1]; b[3] += d[p + 2];
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }
  let best = null;
  for (const b of bins.values()) if (!best || b[0] > best[0]) best = b;
  return best ? [1, 2, 3].map(i => Math.round(best[i] / best[0])) : [255, 255, 255];
}

/**
 * Makes the background transparent. A pixel is background when its colour is
 * within `tolerance` (0-255) of `color`; over the next `soft` it fades, and
 * the background's share of its colour is taken out. Unless `holes`, only
 * what is reached from the border goes: a white eye stays in a white sheet.
 * `choke` shrinks what is left by that many pixels.
 */
export function removeBackground(src, w, h, { color, tolerance, soft = 0, holes = false, choke = 0 }) {
  const out = new Uint8ClampedArray(src);
  const n = w * h, [br, bg, bb] = color, lim = tolerance + soft;
  const dist = i => {
    const p = i * 4, r = src[p] - br, g = src[p + 1] - bg, b = src[p + 2] - bb;
    return Math.sqrt((r * r + g * g + b * b) / 3);
  };
  const pass = i => src[i * 4 + 3] < 8 || dist(i) <= lim;
  const mark = new Uint8Array(n);
  if (holes) {
    for (let i = 0; i < n; i++) if (pass(i)) mark[i] = 1;
  } else {
    const stack = new Int32Array(n);
    let sp = 0;
    const push = i => { if (!mark[i] && pass(i)) { mark[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const i = stack[--sp], x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < n - w) push(i + w);
    }
  }
  for (let i = 0; i < n; i++) {
    if (!mark[i]) continue;
    const p = i * 4, d = dist(i);
    const a = d <= tolerance || soft <= 0 ? 0 : (d - tolerance) / soft;
    if (a <= 0) { out[p + 3] = 0; continue; }
    if (a >= 1) continue;
    out[p] = br + (src[p] - br) / a;
    out[p + 1] = bg + (src[p + 1] - bg) / a;
    out[p + 2] = bb + (src[p + 2] - bb) / a;
    out[p + 3] = src[p + 3] * a;
  }
  for (let k = 0; k < choke; k++) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = out[i * 4 + 3];
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        let m = a[i];
        if (!m) continue;
        if (x > 0 && a[i - 1] < m) m = a[i - 1];
        if (x < w - 1 && a[i + 1] < m) m = a[i + 1];
        if (y > 0 && a[i - w] < m) m = a[i - w];
        if (y < h - 1 && a[i + w] < m) m = a[i + w];
        out[i * 4 + 3] = m;
      }
    }
  }
  return out;
}

/** The tight box of what is visible inside `box`, or null if nothing is. */
export function contentBounds(d, w, h, box, threshold = 16) {
  const bx0 = Math.max(0, Math.floor(box.x)), by0 = Math.max(0, Math.floor(box.y));
  const bx1 = Math.min(w, Math.ceil(box.x + box.w)), by1 = Math.min(h, Math.ceil(box.y + box.h));
  let x0 = bx1, y0 = by1, x1 = -1, y1 = -1;
  for (let y = by0; y < by1; y++) {
    let p = (y * w + bx0) * 4 + 3;
    for (let x = bx0; x < bx1; x++, p += 4) {
      if (d[p] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Boxes as one reads them: rows from the top, each from the left. */
export function readingOrder(boxes) {
  const rest = [...boxes].sort((a, b) => a.y - b.y), out = [];
  while (rest.length) {
    const bottom = rest[0].y + rest[0].h;
    const row = rest.filter(b => b.y + b.h / 2 < bottom);
    row.sort((a, b) => a.x - b.x);
    out.push(...row);
    for (const b of row) rest.splice(rest.indexOf(b), 1);
  }
  return out;
}

/**
 * The separate things in a picture with a transparent background, as boxes
 * in reading order. Pieces nearer each other than `gap` (a share of the
 * longer side) are one thing; things smaller than `minArea` (a share of the
 * picture) are dropped.
 */
export function detectParts(d, w, h, { gap = 0.012, minArea = 0.0015, grid = 400 } = {}) {
  const s = Math.min(1, grid / Math.max(w, h));
  const gw = Math.max(1, Math.ceil(w * s)), gh = Math.max(1, Math.ceil(h * s));
  const m = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const row = Math.min(gh - 1, Math.floor(y * s)) * gw;
    let p = y * w * 4 + 3;
    for (let x = 0; x < w; x++, p += 4) if (d[p] > 32) m[row + Math.min(gw - 1, Math.floor(x * s))] = 1;
  }
  // Grow by half the gap, so that pieces a gap apart meet.
  const r = Math.round(gap * Math.max(gw, gh) / 2);
  let dm = m;
  if (r > 0) {
    const t = new Uint8Array(gw * gh);
    dm = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++)
        if (m[y * gw + x]) for (let k = Math.max(0, x - r); k <= Math.min(gw - 1, x + r); k++) t[y * gw + k] = 1;
    for (let y = 0; y < gh; y++)
      for (let x = 0; x < gw; x++)
        if (t[y * gw + x]) for (let k = Math.max(0, y - r); k <= Math.min(gh - 1, y + r); k++) dm[k * gw + x] = 1;
  }
  const seen = new Uint8Array(gw * gh), stack = new Int32Array(gw * gh), boxes = [];
  for (let start = 0; start < gw * gh; start++) {
    if (!dm[start] || seen[start]) continue;
    let sp = 0, x0 = gw, y0 = gh, x1 = -1, y1 = -1, area = 0;
    seen[start] = 1; stack[sp++] = start;
    while (sp) {
      const i = stack[--sp], x = i % gw, y = (i - x) / gw;
      if (m[i]) {
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const j = ny * gw + nx;
          if (dm[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
        }
      }
    }
    if (area < Math.max(1, minArea * gw * gh)) continue;
    const bx = Math.floor(x0 / s), by = Math.floor(y0 / s);
    const rough = { x: bx, y: by, w: Math.min(w, Math.ceil((x1 + 1) / s)) - bx, h: Math.min(h, Math.ceil((y1 + 1) / s)) - by };
    boxes.push(contentBounds(d, w, h, rough, 32) || rough);
  }
  return readingOrder(boxes);
}

/**
 * Where each cut-out goes in its exported picture. `items` are sizes {w, h};
 * `padding` is a percentage of the longer side, `square` makes each picture
 * square, `same` gives all of them one size (so the views keep their scale
 * to each other), `size` scales the longer side to that many pixels (0: as
 * it is). Returns the picture size W, H and the rectangle x, y, w, h in it.
 */
export function layoutViews(items, { padding = 0, square = false, same = false, size = 0 }) {
  const frames = items.map(it => {
    const pad = Math.round(Math.max(it.w, it.h) * padding / 100);
    let W = it.w + 2 * pad, H = it.h + 2 * pad;
    if (square) W = H = Math.max(W, H);
    return { W, H };
  });
  if (same && frames.length) {
    const W = Math.max(...frames.map(f => f.W)), H = Math.max(...frames.map(f => f.H));
    for (const f of frames) { f.W = W; f.H = H; }
  }
  return items.map((it, i) => {
    const { W, H } = frames[i];
    const k = size > 0 ? size / Math.max(W, H) : 1;
    const ow = Math.max(1, Math.round(W * k)), oh = Math.max(1, Math.round(H * k));
    return { W: ow, H: oh, x: (ow - it.w * k) / 2, y: (oh - it.h * k) / 2, w: it.w * k, h: it.h * k };
  });
}

let crcTable;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of `files` ({name, data: Uint8Array}), stored as they are. */
export function zip(files, date = new Date()) {
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), len = f.data.length;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint16(10, time, true); head.setUint16(12, day, true); head.setUint32(14, crc, true);
    head.setUint32(18, len, true); head.setUint32(22, len, true); head.setUint16(26, name.length, true);
    parts.push(new Uint8Array(head.buffer), name, f.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true); dir.setUint16(12, time, true); dir.setUint16(14, day, true);
    dir.setUint32(16, crc, true); dir.setUint32(20, len, true); dir.setUint32(24, len, true);
    dir.setUint16(28, name.length, true); dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + len;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}
