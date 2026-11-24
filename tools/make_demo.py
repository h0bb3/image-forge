"""Records demo.mp4: drives the page in a headless Chrome over the DevTools
protocol, with a drawn pointer and captions, and joins the screenshots with
ffmpeg. Standard library only (a small WebSocket client is included).

    python tools/make_demo.py [path to chrome] [profile folder]

Needs Chrome and ffmpeg. The model step uses the browser's own store, so the
first run downloads the model (180 MB) into the profile folder.
"""
import base64, json, os, socket, struct, subprocess, sys, tempfile, threading, time, urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROME = sys.argv[1] if len(sys.argv) > 1 else r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
PROFILE = sys.argv[2] if len(sys.argv) > 2 else str(Path(tempfile.gettempdir()) / 'image-forge-demo-profile')
PORT, DEBUG = 8766, 9333
W, H, SCALE = 1280, 720, 1.5


class Quiet(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


class Socket:
    """Just enough WebSocket to talk to Chrome."""

    def __init__(self, url):
        host, rest = url[5:].split('/', 1)
        name, port = host.split(':')
        self.s = socket.create_connection((name, int(port)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET /{rest} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                        f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        assert b' 101 ' in buf.split(b'\r\n')[0], buf
        self.rest = buf.split(b'\r\n\r\n', 1)[1]

    def read(self, n):
        while len(self.rest) < n:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise ConnectionError('closed')
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, text, op=1):
        data = text.encode() if isinstance(text, str) else text
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x80 | op]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack('>H', n)
                                     if n < 65536 else bytes([0x80 | 127]) + struct.pack('>Q', n))
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        whole = b''
        while True:
            a, b = self.read(2)
            n = b & 127
            if n == 126:
                n = struct.unpack('>H', self.read(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self.read(8))[0]
            data = self.read(n)
            op = a & 15
            if op == 9:
                self.send(data, 10)
                continue
            if op == 8:
                raise ConnectionError('closed')
            whole += data
            if a & 0x80:
                return whole.decode()


class Page:
    def __init__(self, ws, frames):
        self.ws, self.n, self.frames = ws, 0, frames
        self.x, self.y = W / 2, H / 2
        self.shots, self.clock, self.last, self.rate = [], 0.0, None, 1.0

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({'id': self.n, 'method': method, 'params': params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == self.n:
                if 'error' in m:
                    raise RuntimeError(f'{method}: {m["error"]}')
                return m['result']

    def js(self, expression):
        r = self.call('Runtime.evaluate', expression=expression, awaitPromise=True, returnByValue=True)
        if 'exceptionDetails' in r:
            raise RuntimeError(r['exceptionDetails'].get('exception', {}).get('description', str(r['exceptionDetails'])))
        return r['result'].get('value')

    # ---- the film
    def frame(self):
        data = self.call('Page.captureScreenshot', format='jpeg', quality=93)['data']
        now = time.perf_counter()
        if self.last is not None:
            self.clock += (now - self.last) * self.rate
        self.last = now
        path = self.frames / f'f{len(self.shots):05d}.jpg'
        path.write_bytes(base64.b64decode(data))
        self.shots.append((path, self.clock))

    def hold(self, seconds):
        end = time.perf_counter() + seconds
        while time.perf_counter() < end:
            self.frame()

    def caption(self, text):
        self.js(f'caption({json.dumps(text)})')

    # ---- the pointer
    def mouse(self, kind, **more):
        self.call('Input.dispatchMouseEvent', type=kind, x=self.x, y=self.y, **more)

    def move(self, x, y, seconds=0.7, held=False):
        x0, y0, t0 = self.x, self.y, time.perf_counter()
        while True:
            k = min(1, (time.perf_counter() - t0) / seconds)
            e = k * k * (3 - 2 * k)
            self.x, self.y = x0 + (x - x0) * e, y0 + (y - y0) * e
            self.mouse('mouseMoved', **({'button': 'left', 'buttons': 1} if held else {}))
            self.frame()
            if k >= 1:
                break

    def click(self, x=None, y=None, seconds=0.7, after=0.35):
        if x is not None:
            self.move(x, y, seconds)
        self.mouse('mousePressed', button='left', buttons=1, clickCount=1)
        self.frame()
        self.mouse('mouseReleased', button='left', clickCount=1)
        self.hold(after)

    def at(self, selector):
        r = self.js(f'(() => {{ const r = document.querySelector({json.dumps(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()')
        return r[0], r[1]

    def spot(self, x, y):
        """A point of the 1600 x 900 sample, on the screen (the picture fitted)."""
        r = self.js(f'''(() => {{ const v = document.getElementById('view').getBoundingClientRect();
            const z = Math.min((v.width - 40) / 1600, (v.height - 40) / 900);
            return [v.left + (v.width - 1600 * z) / 2 + {x} * z, v.top + (v.height - 900 * z) / 2 + {y} * z]; }})()''')
        return r[0], r[1]

    def key(self, key, code, text=None):
        more = {'key': key, 'code': code, 'windowsVirtualKeyCode': ord(key.upper()) if len(key) == 1 else 0}
        self.call('Input.dispatchKeyEvent', type='keyDown', **more, **({'text': text} if text else {}))
        self.call('Input.dispatchKeyEvent', type='keyUp', **more)


OVERLAY = r'''(() => {
  const c = document.createElement('div');
  c.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2v22l6-5 4 9 4-2-4-9h8z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;transform:translate(640px,360px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))';
  document.body.append(c);
  addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX - 2}px,${e.clientY - 2}px)`; }, true);
  const cap = document.createElement('div');
  cap.style.cssText = 'position:fixed;left:475px;bottom:52px;transform:translateX(-50%);z-index:99998;pointer-events:none;background:rgba(10,10,12,.88);color:#fff;font:600 21px system-ui,sans-serif;padding:10px 20px;border-radius:10px;width:max-content;max-width:880px;text-align:center;opacity:0;transition:opacity .25s;box-shadow:0 4px 18px rgba(0,0,0,.4)';
  document.body.append(cap);
  window.caption = t => { if (t) cap.textContent = t; cap.style.opacity = t ? 1 : 0; };
})()'''


def film(p):
    p.caption('Image Forge: cut the views out of a generated sheet')
    p.hold(2.2)
    p.click(*p.at('#sample'), seconds=1.0, after=0.2)
    p.caption('The background is removed, each figure found and boxed')
    p.hold(2.6)

    p.caption('Name each view: one click, or one key')
    for label in ('front', 'left', 'back'):
        p.click(*p.at(f'#tagbar button[data-label={label}]'), seconds=0.8, after=0.7)
    p.caption('A view can be taken from another: right = left, mirrored')
    p.click(*p.at('#tiles .tile:nth-child(4) [data-act=from]'), seconds=1.0, after=2.4)
    p.click(*p.at('#deriveDone'), seconds=0.6, after=0.4)

    p.caption('Keying by colour leaves the soft shadow…')
    fx, fy = p.spot(230, 735)
    p.move(fx, fy, 0.9)
    for _ in range(9):
        p.mouse('mouseWheel', deltaX=0, deltaY=-110)
        p.frame()
    # The feet up from under the caption: a drag with the middle button pans.
    p.mouse('mousePressed', button='middle', buttons=4, clickCount=1)
    x0, y0, t0 = p.x, p.y, time.perf_counter()
    while (k := min(1, (time.perf_counter() - t0) / 0.9)) < 1:
        p.x, p.y = x0 + 130 * k, y0 - 250 * k
        p.mouse('mouseMoved', button='middle', buttons=4)
        p.frame()
    p.mouse('mouseReleased', button='middle', clickCount=1)
    fx, fy = p.x, p.y
    p.hold(1.8)
    p.caption('…so let a model find the figure. It runs in your browser: nothing is uploaded')
    mx, my = p.at('#method')
    p.move(mx, my, 0.9)
    p.hold(0.5)
    p.js("(() => { const m = document.getElementById('method'); m.value = 'both'; m.dispatchEvent(new Event('change', { bubbles: true })); })()")
    p.hold(1.5)
    p.rate = 0.12                      # the wait, shown faster
    end = time.perf_counter() + 240
    while time.perf_counter() < end and p.js("document.getElementById('aiNote').textContent"):
        p.frame()
    p.rate = 1.0
    p.move(fx + 60, fy - 40, 0.8)
    p.hold(2.2)
    p.js("document.getElementById('view').focus()")
    p.key('0', 'Digit0', '0')
    p.hold(0.8)

    p.caption('Fix things by hand: click an area to erase it, or paint. Ctrl+Z undoes')
    p.click(*p.at('[data-tool=wand]'), seconds=0.8, after=0.4)
    p.click(*p.spot(230, 435), seconds=0.9, after=1.4)
    p.click(*p.at('#undo'), seconds=0.8, after=0.9)
    p.click(*p.at('[data-tool=select]'), seconds=0.5, after=0.3)

    p.caption('A quick 3D stand-in built from the views, and a .glb to take along')
    p.click(*p.at('#show3d'), seconds=0.9, after=3.6)
    p.click(*p.at('[data-box3d="1"]'), seconds=0.7, after=1.2)
    gx, gy = p.at('#gl')
    p.move(gx - 120, gy, 0.6)
    p.mouse('mousePressed', button='left', buttons=1, clickCount=1)
    p.move(gx + 170, gy + 30, 2.0, held=True)
    p.move(gx + 60, gy - 20, 1.0, held=True)
    p.mouse('mouseReleased', button='left', clickCount=1)
    p.hold(0.5)
    p.click(*p.at('#close3d'), seconds=0.7, after=0.4)

    p.caption('Export: one PNG per view, all the same size and scale')
    p.click(*p.at('#export'), seconds=1.0, after=2.6)
    p.caption('h0bb3.github.io/image-forge  ·  free and open source')
    p.move(W * 0.37, H * 0.42, 1.0)
    p.hold(3.0)


def main():
    server = ThreadingHTTPServer(('127.0.0.1', PORT), partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    chrome = subprocess.Popen([CHROME, '--headless=new', f'--remote-debugging-port={DEBUG}', f'--user-data-dir={PROFILE}',
                               f'--window-size={W},{H}', '--hide-scrollbars', '--no-first-run', 'about:blank'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{DEBUG}/json'))
                break
            except OSError:
                time.sleep(0.2)
        tab = next(t for t in tabs if t['type'] == 'page')
        with tempfile.TemporaryDirectory() as tmp:
            p = Page(Socket(tab['webSocketDebuggerUrl']), Path(tmp))
            p.call('Emulation.setDeviceMetricsOverride', width=W, height=H, deviceScaleFactor=SCALE, mobile=False)
            p.call('Emulation.setEmulatedMedia', features=[{'name': 'prefers-color-scheme', 'value': 'dark'}])
            p.call('Browser.setDownloadBehavior', behavior='deny')
            p.call('Page.enable')
            p.call('Page.navigate', url=f'http://127.0.0.1:{PORT}/')
            time.sleep(1.5)
            p.js('localStorage.clear()')
            p.call('Page.navigate', url=f'http://127.0.0.1:{PORT}/')
            time.sleep(2.0)
            p.js(OVERLAY)
            film(p)
            p.frame()
            listing = Path(tmp) / 'frames.txt'
            lines = []
            for i, (path, t) in enumerate(p.shots):
                nxt = p.shots[i + 1][1] if i + 1 < len(p.shots) else t + 0.05
                lines += [f"file '{path.as_posix()}'", f'duration {max(nxt - t, 0.001):.4f}']
            listing.write_text('\n'.join(lines) + '\n', encoding='utf-8')
            out = ROOT / 'demo.mp4'
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(listing),
                            '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow',
                            '-crf', '23', '-movflags', '+faststart', str(out)], check=True)
            poster = p.shots[min(len(p.shots) - 1, int(len(p.shots) * 0.2))][0]
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(poster), '-vf', 'scale=1280:-1', str(ROOT / 'demo.jpg')], check=True)
            print(out, f'{p.clock:.1f} s', len(p.shots), 'frames', f'{out.stat().st_size / 1e6:.1f} MB')
    finally:
        chrome.terminate()
        server.shutdown()


if __name__ == '__main__':
    main()
