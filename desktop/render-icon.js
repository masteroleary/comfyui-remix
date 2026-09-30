'use strict';
// ── App icon ───────────────────────────────────────────────────────────────
// Renders favicon.svg into desktop/resources/icon.png, the 1024px master that
// electron-builder cuts the .ico, the .icns and the Linux sizes from. Run with
// Electron (`npm run desktop:icon`): Chromium is the SVG renderer the build already
// has, and adding a second one to draw a single file is not worth a dependency.
//
// The PNG is generated, like favicon.ico and apple-touch-icon.png beside the SVG:
// edit favicon.svg and re-run this, never the PNG.
//
// The backdrop is the SVG's own. favicon.svg is already an app icon rather than a
// bare glyph — a dark tile with rx 7 on a 32 box, which is 22%, the macOS corner —
// so nothing is laid behind it; a second backdrop would only frame the first. What
// is added is margin: the tile is drawn at 824 on a 1024 canvas, transparent
// around it, which is Apple's icon grid. macOS lays every Dock icon out on that
// grid, and a tile filled to the edge sits visibly larger than everything beside
// it. Windows and Linux want the corners transparent, which the tile's own
// rounding already gives. The glyph keeps the proportion the SVG drew it at
// (about two thirds of the tile), since that is what it was drawn to read at.
//
// Apple's template also draws a drop shadow into that margin. Left out: at the 16
// and 32px frames Windows cuts from this, a shadow becomes a grey fringe round the
// tile. The margin itself costs the 16px frame about three pixels, which is the
// price of one master for three platforms.
const electron = require('electron');
const fs = require('fs');
const path = require('path');

// Under plain Node — or Electron with ELECTRON_RUN_AS_NODE set, which some
// terminals and editors export — `require('electron')` is the binary's path, not
// the API, and everything below fails on an undefined `app`.
if (typeof electron === 'string') {
  console.error('render-icon: run this with Electron (npm run desktop:icon), and with ELECTRON_RUN_AS_NODE unset.');
  process.exit(1);
}
const { app, BrowserWindow, nativeImage } = electron;

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'favicon.svg');
const OUT = path.join(__dirname, 'resources', 'icon.png');
const SIZE = 1024;
const TILE = 824;   // Apple's grid: 100px clear on every side of a 1024 canvas

// Software raster, so re-running this on another machine redraws the same pixels
// rather than whatever that GPU's driver anti-aliases an edge to — a generated file
// that changes on every regeneration is noise in every diff it appears in.
app.disableHardwareAcceleration();

// Runs in the page. Drawn through a canvas rather than captured from the window:
// the canvas is exactly SIZE pixels whatever the display's scale factor, where a
// capturePage of a 1024px window is 1536 on a 150% screen and has to be resampled
// back down. The SVG's root is given the tile size as its own width and height, so
// the image is rasterised at the size it is drawn at rather than scaled up from 32.
function renderInPage(src, size, tile) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d');
      const at = (size - tile) / 2;
      g.drawImage(img, at, at, tile, tile);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('the SVG did not load as an image'));
    img.src = src;
  });
}

// The root <svg> tag only: width/height anywhere else in the file belong to shapes.
function sizedSvg(svg, px) {
  return svg.replace(/<svg\b[^>]*>/, tag => tag
    .replace(/\s(width|height)="[^"]*"/g, '')
    .replace(/^<svg/, `<svg width="${px}" height="${px}"`));
}

// Three pixels that say the drawing happened, since the failure worth catching is
// a silent one: an image that decoded to nothing draws nothing, and the build would
// ship a transparent square. A corner must be clear (the margin), the middle of the
// tile opaque, and the centre of the middle target node lit — the tile is near
// black, the node is the purple-to-magenta gradient.
function checkPixels(png) {
  const img = nativeImage.createFromBuffer(png);
  const { width, height } = img.getSize();
  if (width !== SIZE || height !== SIZE) throw new Error(`rendered ${width}x${height}, not ${SIZE}x${SIZE}`);
  // toBitmap is BGRA or RGBA depending on the platform; alpha is the fourth byte
  // either way, and the brightness test below sums the other three.
  const bmp = img.toBitmap();
  const px = (x, y) => { const i = (y * width + x) * 4; return [bmp[i], bmp[i + 1], bmp[i + 2], bmp[i + 3]]; };
  const toCanvas = u => Math.round((SIZE - TILE) / 2 + (u / 32) * TILE);
  const corner = px(0, 0);
  const middle = px(SIZE / 2, SIZE / 2);
  const node = px(toCanvas(23), toCanvas(16));   // <circle cx="23" cy="16"> in the SVG
  if (corner[3] !== 0) throw new Error(`the corner is not transparent (alpha ${corner[3]})`);
  if (middle[3] !== 255) throw new Error(`the tile is not opaque at its centre (alpha ${middle[3]})`);
  if (node[0] + node[1] + node[2] < 300) throw new Error(`the glyph did not draw (node pixel ${node.slice(0, 3).join(',')})`);
}

async function main() {
  const svg = sizedSvg(fs.readFileSync(SRC, 'utf8'), TILE);
  // base64 rather than a percent-encoded data URL: the SVG's comments are not ASCII.
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');

  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  await win.loadURL('about:blank');
  const dataUrl = await win.webContents.executeJavaScript(
    `(${renderInPage})(${JSON.stringify(src)}, ${SIZE}, ${TILE})`);
  win.destroy();

  const png = Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64');
  checkPixels(png);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, png);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${SIZE}x${SIZE}, ${png.length} bytes`);
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch(e => {
    console.error('render-icon: ' + (e && e.message ? e.message : e));
    app.exit(1);
  });
