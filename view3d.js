// Image Forge: the views stood up as flat quads in space, to turn about.
// A small WebGL viewer; where each quad goes is decided in core.js (quads).

const VS = `
attribute vec3 p; attribute vec2 uv; uniform mat4 m; varying vec2 v;
void main() { v = uv; gl_Position = m * vec4(p, 1.); }`;
const FS = `
precision mediump float; uniform sampler2D t; varying vec2 v;
void main() { vec4 c = texture2D(t, v); if (c.a < .1) discard; gl_FragColor = vec4(c.rgb * c.a, c.a); }`;

// 4x4 matrices, column by column as WebGL takes them.
const mul = (a, b) => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
};
const perspective = (fov, aspect, near, far) => {
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
};
const rotX = a => new Float32Array([1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1]);
const rotY = a => new Float32Array([Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]);
const move = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

/**
 * A viewer on `canvas`. `show(list)` takes the quads to draw, each
 * {positions (4 corners: top left, top right, bottom right, bottom left),
 * doubleSided, canvas (its picture)}; drag turns, the wheel moves nearer.
 */
export function viewer(canvas) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: true });
  if (!gl) return null;
  const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const aP = gl.getAttribLocation(prog, 'p'), aUv = gl.getAttribLocation(prog, 'uv'), uM = gl.getUniformLocation(prog, 'm');
  // The corners are drawn top left, bottom left, bottom right; top left,
  // bottom right, top right: counter-clockwise seen from outside.
  const uvs = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvs);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]), gl.STATIC_DRAW);

  let items = [], yaw = -0.5, pitch = 0.12, dist = 2.6, centre = [0, 0.5, 0], spin = true, queued = false, alive = true;

  function show(list) {
    for (const it of items) { gl.deleteTexture(it.tex); gl.deleteBuffer(it.buf); }
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    items = list.map(q => {
      const p = q.positions;
      const ccw = new Float32Array([...p.slice(0, 3), ...p.slice(9, 12), ...p.slice(6, 9), ...p.slice(0, 3), ...p.slice(6, 9), ...p.slice(3, 6)]);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, ccw, gl.STATIC_DRAW);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, q.canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const mid = [0, 1, 2].map(k => (p[k] + p[3 + k] + p[6 + k] + p[9 + k]) / 4);
      for (let i = 0; i < 12; i++) { lo[i % 3] = Math.min(lo[i % 3], p[i]); hi[i % 3] = Math.max(hi[i % 3], p[i]); }
      return { buf, tex, mid, doubleSided: q.doubleSided };
    });
    if (items.length) {
      centre = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
      dist = Math.max(1.2, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1.8);
    }
    draw();
  }

  function paint() {
    queued = false;
    if (!alive) return;
    const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (spin) yaw += 0.006;
    const view = mul(move(0, 0, -dist), mul(rotX(pitch), mul(rotY(yaw), move(-centre[0], -centre[1], -centre[2]))));
    const m = mul(perspective(0.6, W / H, 0.05, 50), view);
    // The furthest first, for the soft edges of the nearer ones.
    const depth = it => view[2] * it.mid[0] + view[6] * it.mid[1] + view[10] * it.mid[2] + view[14];
    for (const it of [...items].sort((a, b) => depth(a) - depth(b))) {
      if (it.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
      gl.uniformMatrix4fv(uM, false, m);
      gl.bindBuffer(gl.ARRAY_BUFFER, it.buf);
      gl.enableVertexAttribArray(aP);
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, uvs);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, it.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    if (spin) draw();
  }
  function draw() { if (!queued && alive) { queued = true; requestAnimationFrame(paint); } }

  let last = null;
  canvas.addEventListener('pointerdown', e => { last = [e.clientX, e.clientY]; spin = false; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!last) return;
    yaw += (e.clientX - last[0]) * 0.01;
    pitch = Math.min(1.55, Math.max(-1.55, pitch + (e.clientY - last[1]) * 0.01));
    last = [e.clientX, e.clientY];
    draw();
  });
  canvas.addEventListener('pointerup', () => { last = null; });
  canvas.addEventListener('pointercancel', () => { last = null; });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    dist = Math.min(20, Math.max(0.3, dist * Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015))));
    draw();
  }, { passive: false });
  new ResizeObserver(draw).observe(canvas);

  return {
    show,
    stop() { alive = false; },
    start() { alive = true; draw(); },
  };
}
