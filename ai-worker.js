// Image Forge: background removal by a model, in a worker of its own so the
// page stays alive while it runs. Nothing leaves the computer: the model is
// downloaded once (the browser keeps it) and runs here, on ONNX Runtime Web.
//
// The model is IS-Net, general use (Qin et al., "Highly Accurate Dichotomous
// Image Segmentation", Apache 2.0 licence; the ONNX file is the one of rembg).
// It runs on the processor (WebAssembly), some 15 seconds a picture. The
// graphics card (WebGPU) is not tried: ONNX Runtime Web 1.31 cannot run this
// model there (its MaxPool lacks ceil_mode); when it can, add it to WAYS.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.all.bundle.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
ort.env.logLevel = 'error';

const SIDE = 1024;
const FULL = 'https://huggingface.co/BritishWerewolf/IS-Net/resolve/main/onnx/model.onnx';
const WAYS = [
  { provider: 'wasm', url: FULL, name: 'processor' },
];

const say = text => self.postMessage({ type: 'progress', text });
let session = null, way = -1;

/** The bytes of the model: from the browser's store, or downloaded into it. */
async function fetchModel(url) {
  const store = await caches.open('image-forge-models').catch(() => null);
  const kept = store && await store.match(url);
  if (kept) return new Uint8Array(await kept.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the model could not be downloaded (${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader(), parts = [];
  let got = 0, told = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    const mb = Math.round(got / 1e6);
    if (mb !== told) { told = mb; say(`Downloading the model, once: ${mb}${total ? ` of ${Math.round(total / 1e6)}` : ''} MB`); }
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  // Kept for the next time; if the store is full the model still runs now.
  if (store) await store.put(url, new Response(bytes.slice().buffer, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return bytes;
}

async function load(from, only) {
  let last;
  for (let i = from; i < WAYS.length; i++) {
    const w = WAYS[i];
    if (only !== undefined && i !== only) continue;
    if (w.provider === 'webgpu' && !(self.navigator.gpu && await self.navigator.gpu.requestAdapter().catch(() => null))) continue;
    try {
      const bytes = await fetchModel(w.url);
      say(`Starting the model on the ${w.name}…`);
      session = await ort.InferenceSession.create(bytes, { executionProviders: [w.provider], graphOptimizationLevel: 'all' });
      way = i;
      return;
    } catch (e) { last = e; session = null; say(`(${w.name}: ${String(e?.message || e).slice(0, 200)})`); }
  }
  throw last || new Error('this browser can run the model neither on the graphics card nor on the processor');
}

/** The share of the thing in each pixel of an RGBA picture, 0-255. */
async function matte(data, width, height, only) {
  if (!session || (only !== undefined && only !== way)) await load(0, only);
  // The picture on white, at the size the model takes (as rembg does: stretched).
  const small = new OffscreenCanvas(SIDE, SIDE), g = small.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, SIDE, SIDE);
  g.imageSmoothingQuality = 'high';
  const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(data), width, height));
  g.drawImage(bitmap, 0, 0, SIDE, SIDE);
  bitmap.close();
  const px = g.getImageData(0, 0, SIDE, SIDE).data, n = SIDE * SIDE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i] = px[i * 4] / 255 - .5;
    input[n + i] = px[i * 4 + 1] / 255 - .5;
    input[2 * n + i] = px[i * 4 + 2] / 255 - .5;
  }
  for (;;) {
    try {
      say(`Working on the ${WAYS[way].name}${WAYS[way].provider === 'wasm' ? ': some 15 seconds' : ''}…`);
      const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIDE, SIDE]) });
      const o = (result.output_image ?? result[session.outputNames[0]]).data;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) { if (o[i] < lo) lo = o[i]; if (o[i] > hi) hi = o[i]; }
      const grey = new ImageData(SIDE, SIDE), k = 255 / Math.max(hi - lo, 1e-6);
      for (let i = 0; i < n; i++) { grey.data[i * 4] = (o[i] - lo) * k; grey.data[i * 4 + 3] = 255; }
      g.putImageData(grey, 0, 0);
      // Back to the size of the picture.
      const big = new OffscreenCanvas(width, height), b = big.getContext('2d', { willReadFrequently: true });
      b.imageSmoothingQuality = 'high';
      b.drawImage(small, 0, 0, width, height);
      const full = b.getImageData(0, 0, width, height).data, out = new Uint8Array(width * height);
      for (let i = 0; i < out.length; i++) out[i] = full[i * 4];
      return { matte: out, way: WAYS[way].name };
    } catch (e) {
      // The graphics card may start the model and still fail to run it.
      say(`(${WAYS[way].name}: ${String(e?.message || e).slice(0, 200)})`);
      if (only !== undefined || way + 1 >= WAYS.length) throw e;
      try { await session?.release(); } catch { /* gone anyway */ }
      session = null;
      await load(way + 1);
    }
  }
}

let queue = Promise.resolve();
self.onmessage = e => {
  const { id, data, width, height, only } = e.data;
  queue = queue.then(async () => {
    try {
      const t0 = performance.now();
      const r = await matte(data, width, height, only);
      self.postMessage({ type: 'done', id, matte: r.matte.buffer, way: r.way, ms: Math.round(performance.now() - t0) }, [r.matte.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, message: String(err?.message || err) });
    }
  });
};
