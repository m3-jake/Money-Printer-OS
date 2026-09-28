import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
const DASH = path.join(ROOT, 'public', 'dashboard.html');
const MAIN = path.join(ROOT, 'desktop', 'main.cjs');
const SHELL_CSS = path.join(ROOT, 'public', 'css', 'mpo-shell.css');

function pngInfo(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bit: buf[24],
    color: buf[25],
    bytes: buf.length,
  };
}

function jpegSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xda || marker === 0xd9) break;
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  throw new Error(`no JPEG SOF in ${file}`);
}

function py(script) {
  return execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim();
}

test('required visual assets ship with usable geometry', () => {
  const icons = ['money', 'network', 'robinhood', 'settings', 'sportsbook', 'trade'];
  for (const name of icons) {
    const info = pngInfo(path.join(ASSETS, 'icons', `${name}.png`));
    assert.equal(info.width, 96, `${name} width`);
    assert.equal(info.height, 96, `${name} height`);
    assert.equal(info.color, 6, `${name} must be RGBA`);
  }
  const logo = pngInfo(path.join(ASSETS, 'money-printer-logo.png'));
  assert.equal(logo.color, 6);
  assert.ok(logo.width >= 512 && logo.height >= 512, 'logo too small');
  const bill = pngInfo(path.join(ASSETS, 'bill.png'));
  assert.equal(bill.color, 6);
  assert.ok(bill.width >= 56 && bill.height >= 24, 'bill sprite too small');
  for (const name of ['money-bill.webp','fire-low.webp','fire-high.webp','smoke-medium.webp']) {
    const file = path.join(ASSETS, name);
    assert.ok(fs.existsSync(file), `${name} missing`);
    assert.ok(fs.statSync(file).size > 100000, `${name} is unexpectedly tiny`);
  }
  const appIcon = pngInfo(path.join(ASSETS, 'app-icon.png'));
  assert.equal(appIcon.color, 6);
  assert.equal(appIcon.width, 256);
  const bliss = jpegSize(path.join(ASSETS, 'bliss-4k.jpg'));
  assert.equal(bliss.width, 3840);
  assert.equal(bliss.height, 2160);
});

test('the 1.29 MB logo master stays off the desktop, which draws a sized derivative', () => {
  // P3.5. The master is the packaging source (desktop/main.cjs tray + window icon, build/icon.icns)
  // and stays referenced by the docs; the desktop only ever draws it in boxes of 64 px (boot mark),
  // 72/80/108 px (brand marks) and 120 px (stacked-bill FX sprite), so it is resampled once, offline
  // by scripts/make-logo-derivative.py, instead of being shipped whole to each of the five slots.
  const master = pngInfo(path.join(ASSETS, 'money-printer-logo.png'));
  const sized = pngInfo(path.join(ASSETS, 'money-printer-logo-512.png'));
  assert.equal(sized.color, 6, 'the derivative keeps the RGBA contract');
  assert.equal(sized.width, 512);
  assert.equal(sized.height, 512);
  assert.ok(sized.width >= 3 * 120, '3x the widest drawn box (120 px), the same rule the master was sized by');
  assert.ok(sized.bytes < master.bytes / 3, `derivative must reclaim weight: ${sized.bytes} vs ${master.bytes}`);
  const html = fs.readFileSync(DASH, 'utf8');
  assert.equal((html.match(/money-printer-logo-512\.png/g) || []).length, 5, 'all five drawn slots use the derivative');
  assert.doesNotMatch(html, /money-printer-logo\.png/, 'the master must not be drawn on the desktop');
});

test('desktop icons are shaded artwork, not 10-color placeholders', () => {
  const floors = { money: 4000, network: 2000, robinhood: 2000, settings: 4000, sportsbook: 2000, trade: 2000 };
  for (const [name, minBytes] of Object.entries(floors)) {
    const file = path.join(ASSETS, 'icons', `${name}.png`);
    const info = pngInfo(file);
    assert.ok(info.bytes >= minBytes, `${name} is ${info.bytes} bytes; placeholder icons are <1KB`);
    const unique = Number(py(`
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGBA')
print(len(im.getcolors(maxcolors=200000) or []))
`));
    assert.ok(unique >= 200, `${name} has ${unique} colors; restored icons have hundreds`);
  }
});

test('every desktop item has a 96px RGBA icon', () => {
  const html = fs.readFileSync(DASH, 'utf8');
  const map = html.match(/const ICON_PNG=\{[^;]+\};/);
  const ids = html.match(/const DESKTOP_ICONS=\[[^;]+\];/);
  assert.ok(map && ids, 'desktop icon declarations exist');
  const { ICON_PNG, DESKTOP_ICONS } = vm.runInNewContext(`${map[0]}\n${ids[0]}\n({ICON_PNG,DESKTOP_ICONS})`);
  for (const id of DESKTOP_ICONS) {
    const file = ICON_PNG[id];
    assert.ok(file, `${id} uses an image icon`);
    const info = pngInfo(path.join(ASSETS, 'icons', file));
    assert.equal(info.width, 96, `${id} width`);
    assert.equal(info.height, 96, `${id} height`);
    assert.equal(info.color, 6, `${id} RGBA`);
    assert.ok(info.bytes >= 2000, `${id} is not placeholder art`);
  }
});

test('wallpaper corner is grass, not a stock-site plate', () => {
  const file = path.join(ASSETS, 'bliss-4k.jpg');
  const script = `
from PIL import Image
im = Image.open(${JSON.stringify(file)})
r,g,b = im.getpixel((3760, 2140))
print(r, g, b)
print(im.info.get('comment') or '')
`;
  const lines = py(script).split('\n');
  const [r, g, b] = lines[0].split(/\s+/).map(Number);
  assert.ok(g > r && g > b, `expected green grass, got ${r},${g},${b}`);
  assert.ok(r < 110 && g < 140, `watermark plate is gray-bright, got ${r},${g},${b}`);
  const comment = (lines[1] || '').toLowerCase();
  assert.doesNotMatch(comment, /wallpaper|stock|wide\.com/);
  const raw = fs.readFileSync(file);
  assert.doesNotMatch(raw.toString('latin1'), /WALLPAPERSWIDE/i);
});

test('desktop chrome uses cohesive assets and has no fire leftover', () => {
  const html = fs.readFileSync(DASH, 'utf8');
  const main = fs.readFileSync(MAIN, 'utf8');
  const shellCss = fs.readFileSync(SHELL_CSS, 'utf8');
  assert.match(html, /class="bootmark"/);
  assert.match(html, /class="tico" src="\/assets\/icons\/money\.png"/);
  assert.match(shellCss, /\/assets\/money-bill\.webp/);
  assert.match(html, /brand-mark/);
  assert.doesNotMatch(html, /makeFireSprites|fire-low\.webp|fire-high\.webp|smoke-medium\.webp/);
  assert.doesNotMatch(html, /WALLPAPERSWIDE/);
  assert.doesNotMatch(html, /🔄|🧬|🌐/);
  assert.doesNotMatch(html, /id="horizonFire"|id="bottomFire"/);
  assert.match(html, /id="moneyRain"/);
  assert.match(html, /id="moneyPile"/);
  assert.match(main, /app-icon\.png/);
  assert.equal((shellCss.match(/bliss-4k\.jpg/g) || []).length, 0);
  assert.equal((shellCss.match(/bliss-hill\.webp/g) || []).length, 1);
  assert.doesNotMatch(shellCss.match(/\.hill-foreground\s*\{[^}]*\}/)[0], /clip-path/);
  const hill=fs.readFileSync(path.join(ASSETS,'bliss-hill.webp'));
  assert.equal(hill.toString('ascii',0,4),'RIFF');
  assert.equal(hill.toString('ascii',8,12),'WEBP');
  assert.equal(hill.toString('ascii',12,16),'VP8X');
  assert.ok(hill[20]&0x10);
  assert.equal(hill.readUIntLE(24,3)+1,3840);
  assert.equal(hill.readUIntLE(27,3)+1,2160);
  for(let i=1;i<=10;i++)assert.ok(fs.existsSync(path.join(ASSETS,'clouds',String(i).padStart(2,'0')+'.webp')));
  assert.ok(fs.existsSync(path.join(ASSETS,'mpo-logo-3d.webp')));
  assert.equal((html.match(/class="sky-cloud"/g)||[]).length,11);
  assert.ok(html.indexOf('class="wallpaper"')<html.indexOf('class="sky-clouds"')&&html.indexOf('class="sky-clouds"')<html.indexOf('class="hill-foreground"'));
  assert.match(shellCss,/\.sky-clouds\s*\{[^}]*z-index:1/);
  assert.match(shellCss,/#3a91e8/i);
  assert.match(shellCss,/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.sky-cloud\s*\{\s*animation-play-state: paused/);
  assert.match(html,/class="brand-logo"/);
  assert.match(html, /class="brand-logo" src="\/assets\/mpo-logo-3d\.webp"/);
  assert.doesNotMatch(html, /mpo-logo-3d\.js|mpo-logo-model\.glb/);
  assert.doesNotMatch(shellCss, /\.brand-model|\.mpo-logo\.has-3d/);
  assert.match(html, /ahead=known&&pnlSol>1e-6&&pnlPct>0/);
  assert.match(html, /trackComboProfitBurst/);
  assert.match(html, /triggerMoneyBurst/);
  assert.doesNotMatch(html, /else\{rain\.innerHTML=makeBills/);
  assert.match(shellCss, /\.ico img,\s*\.task \.tico/);
  assert.match(shellCss, /image-rendering:\s*auto/);
});
