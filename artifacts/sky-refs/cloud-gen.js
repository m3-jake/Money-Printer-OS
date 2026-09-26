/* Procedural cloud sprites for the Money Printer OS sunny sky.
   Plain browser JS: no imports, no DOM. Exposes MPOClouds on the global object
   ({ makeCumulus, makeCirrus, mulberry32 }). Each maker returns
   { width, height, data } where data is a straight-alpha RGBA Uint8ClampedArray
   ready for `new ImageData(data, width, height)`.

   Cumulus model: a pseudo-3D height field built from a hierarchy of spheres
   (big base lobes and towers, then smaller and smaller billows grown on their
   upper/front surfaces), roughened with billow fbm. Lighting = Lambert (wrapped)
   from the sphere normals x soft self-shadowing from a short height-field ray
   march toward the sun + blue sky ambient from above + grey ground bounce from
   below. Flat, ragged base; soft thin edges. */
(function (root) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Seeded 2D gradient (Perlin) noise, output roughly in [-1, 1].
  function makeNoise(rand) {
    var p = new Uint8Array(256), perm = new Uint8Array(512);
    var gx = new Float32Array(256), gy = new Float32Array(256);
    var i, j, t, a;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) { j = (rand() * (i + 1)) | 0; t = p[i]; p[i] = p[j]; p[j] = t; }
    for (i = 0; i < 512; i++) perm[i] = p[i & 255];
    for (i = 0; i < 256; i++) { a = rand() * Math.PI * 2; gx[i] = Math.cos(a); gy[i] = Math.sin(a); }
    return function (x, y) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var xf = x - xi, yf = y - yi;
      xi &= 255; yi &= 255;
      var pa = perm[xi], pb = perm[xi + 1];
      var aa = perm[pa + yi], ab = perm[pa + yi + 1], ba = perm[pb + yi], bb = perm[pb + yi + 1];
      var u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
      var v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
      var n00 = gx[aa] * xf + gy[aa] * yf;
      var n10 = gx[ba] * (xf - 1) + gy[ba] * yf;
      var n01 = gx[ab] * xf + gy[ab] * (yf - 1);
      var n11 = gx[bb] * (xf - 1) + gy[bb] * (yf - 1);
      var x1 = n00 + u * (n10 - n00), x2 = n01 + u * (n11 - n01);
      return (x1 + v * (x2 - x1)) * 1.4;
    };
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function smooth(e0, e1, x) { var t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }
  function hexRgb(h) { var n = parseInt(h.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }

  /* makeCumulus(seed, w, h, opt)
     w:h around 2:1 .. 2.6:1 looks right for fair-weather cumulus.
     opt.haze    0..1  blend toward the horizon haze colour (far clouds)
     opt.opacity 0..1  overall alpha multiplier
     opt.hazeColor     default '#C4E5FC' (the sky's horizon colour) */
  function makeCumulus(seed, w, h, opt) {
    opt = opt || {};
    var W = Math.max(8, w | 0), H = Math.max(4, h | 0), N = W * H;
    var rand = mulberry32(seed >>> 0);
    var noise = makeNoise(rand);
    var haze = opt.haze || 0, opacity = opt.opacity == null ? 1 : opt.opacity;
    var hazeRgb = hexRgb(opt.hazeColor || '#C4E5FC');
    var i, k, n, x, y, idx;

    // ---- 1. silhouette profile: a broad dome (main tower) + a lower second tower
    //         + a low shelf, so the cloud is tallest near the middle and flat below.
    var yb = H * 0.80, top0 = H * 0.05, span = yb - top0;
    var c1 = 0.38 + 0.24 * rand(), hw1 = 0.24 + 0.08 * rand();
    var c2 = c1 + (rand() < 0.5 ? -1 : 1) * (0.18 + 0.10 * rand());
    var hw2 = 0.16 + 0.07 * rand(), k2 = 0.55 + 0.25 * rand();
    var c3 = 1 - c2 + (rand() - 0.5) * 0.1, hw3 = 0.12 + 0.06 * rand(), k3 = 0.35 + 0.2 * rand();
    function dome(u) { return u * u < 1 ? Math.pow(1 - u * u, 0.8) : 0; }
    function topFrac(xn) {
      var us = (xn - 0.5) / 0.43;
      var sh = us * us < 1 ? 0.22 * (1 - us * us * us * us) : 0;  // low shelf, tapered
      return Math.max(dome((xn - c1) / hw1), k2 * dome((xn - c2) / hw2), k3 * dome((xn - c3) / hw3), sh);
    }

    // ---- 2. sphere hierarchy (pixel units; x right, y down, z toward viewer)
    var SX = [], SY = [], SZ = [], SR = [];
    function add(px, py, pz, pr) { SX.push(px); SY.push(py); SZ.push(pz); SR.push(pr); }
    x = W * 0.07;
    while (x < W * 0.93) {
      var f = topFrac(x / W);
      if (f > 0.02) {
        var t = yb - f * span * (0.92 + 0.12 * rand());
        var r = Math.max(H * 0.05, (yb - t) * (0.55 + 0.12 * rand()));
        r = Math.min(r, x - W * 0.02, W * 0.98 - x);
        if (r > 1) add(x, t + r, rand() * 0.15 * r, r);
        x += Math.max(2, r * (0.45 + 0.30 * rand()));
      } else {
        x += W * 0.02;
      }
    }
    var levelStart = 0, levelEnd = SX.length;
    var kids = [5, 4, 3], rMin = [0.38, 0.38, 0.40], rMax = [0.56, 0.55, 0.55];
    for (var lv = 0; lv < kids.length; lv++) {
      for (i = levelStart; i < levelEnd; i++) {
        var pr = SR[i];
        if (pr * rMin[lv] < 1.8) continue;     // below pixel scale: leave it to the noise
        n = kids[lv] - 1 + ((rand() * 3) | 0);
        for (k = 0; k < n; k++) {
          var vx = rand() * 2 - 1, vy = -(0.25 + rand() * 0.9), vz = rand() * 0.6;
          var vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
          vx /= vl; vy /= vl; vz /= vl;
          var dist = pr * (0.62 + 0.24 * rand());
          var cr = pr * (rMin[lv] + (rMax[lv] - rMin[lv]) * rand());
          var cy = SY[i] + vy * dist, cx = SX[i] + vx * dist;
          if (cy - cr < H * 0.02 || cx - cr < W * 0.015 || cx + cr > W * 0.985) continue;
          add(cx, cy, SZ[i] + vz * dist, cr);
        }
      }
      levelStart = levelEnd; levelEnd = SX.length;
    }

    // ---- 3. splat: height Z (smooth union) and signed distance inside silhouette E
    var Z = new Float32Array(N), E = new Float32Array(N).fill(-1e4);
    var soft = Math.max(0.7, H * 0.008);
    var margin = soft * 4 + H * 0.05;
    var s, x0, x1, y0, y1, dx, dy, d2, r2, zc, sxc, syc, ev, zv, zo, kk, hh;
    for (s = 0; s < SX.length; s++) {
      sxc = SX[s]; syc = SY[s]; r = SR[s]; r2 = r * r; zc = SZ[s]; kk = r * 0.04;
      var rm = r + margin;
      x0 = Math.max(0, Math.floor(sxc - rm)); x1 = Math.min(W - 1, Math.ceil(sxc + rm));
      y0 = Math.max(0, Math.floor(syc - rm)); y1 = Math.min(H - 1, Math.ceil(syc + rm));
      for (y = y0; y <= y1; y++) {
        dy = y + 0.5 - syc;
        idx = y * W;
        for (x = x0; x <= x1; x++) {
          dx = x + 0.5 - sxc; d2 = dx * dx + dy * dy;
          ev = r - Math.sqrt(d2);
          if (ev > E[idx + x]) E[idx + x] = ev;
          if (d2 < r2) {
            zv = zc + Math.sqrt(r2 - d2); zo = Z[idx + x];
            if (zo > 0) {                      // near-hard max (a wide smooth max leaves crater rings)
              hh = kk - Math.abs(zo - zv);
              zv = (zv > zo ? zv : zo) + (hh > 0 ? hh * hh * 0.25 / kk : 0);
            }
            Z[idx + x] = zv;
          }
        }
      }
    }

    // ---- 4. billow fbm roughens height + edge; alpha with a flat, ragged base
    var A = new Float32Array(N), ZN = new Float32Array(N), B = new Float32Array(N);
    var f0 = 1 / (H * 0.20);
    var oct = Math.max(2, Math.min(5, Math.floor(Math.log2(H / 5))));
    var baseF = 1 / (H * 0.45);
    for (y = 0; y < H; y++) {
      var tv = clamp01((y / H - 0.30) / 0.5);     // 0 at the top .. 1 near the base
      var fuzz = soft * (1 + 3 * tv);
      for (x = 0; x < W; x++) {
        idx = y * W + x;
        ev = E[idx];
        if (ev < -margin) continue;
        var fx = x * f0, fy = y * f0, amp = 1, sum = 0, norm = 0;
        for (var o = 0; o < oct; o++) {
          sum += amp * Math.abs(noise(fx, fy));
          norm += amp; amp *= 0.5; fx *= 2.07; fy *= 2.07;
        }
        var b = sum / norm - 0.3;                 // ~ -0.3 .. +0.3
        B[idx] = b;
        var e2 = ev + b * H * (0.05 + 0.07 * tv);
        var a = smooth(-fuzz * 0.5, fuzz * 1.5, e2);
        var xe = Math.abs(x / W - 0.5) * 2;           // base curls up at the far ends (no spurs)
        var baseY = yb + noise(x * baseF + 17.3, 3.1) * H * 0.02 + b * H * 0.04 - H * 0.10 * xe * xe * xe * xe;
        a *= smooth(baseY + H * 0.03, baseY - H * 0.02, y);
        var bd = Math.min(x, W - 1 - x, y, H - 1 - y);   // never clip at the sprite border
        if (bd < 2) a *= bd * 0.5;
        A[idx] = a;
        ZN[idx] = (Z[idx] + b * H * 0.03) * a;
      }
    }

    // normals come from a lightly blurred copy (no hard rings at sphere rims)
    var ZS = boxBlur(ZN, W, H, Math.max(1, Math.round(H * 0.025)));
    // crevice term: how far below its broad neighbourhood a point sits
    var ZB = boxBlur(ZN, W, H, Math.max(1, Math.round(H * 0.10)));
    // per-column silhouette top, for the volumetric darkening toward the base
    var TOP = new Float32Array(W);
    for (x = 0; x < W; x++) {
      TOP[x] = yb;
      for (y = 0; y < yb; y++) if (A[y * W + x] > 0.5) { TOP[x] = y; break; }
    }
    TOP = boxBlur(TOP, W, 1, Math.max(1, Math.round(W * 0.04)));  // no column seams

    // ---- 5. light
    var Lx = -0.45, Ly = -0.85, Lz = 0.30;
    var ll = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz); Lx /= ll; Ly /= ll; Lz /= ll;
    var l2 = Math.sqrt(Lx * Lx + Ly * Ly), sdx = Lx / l2, sdy = Ly / l2, rise = Lz / l2;
    var STEPS = 10, stepLen = H * 0.03;
    var sigma = 1.0 / (H * 0.10);
    var LIT = [1.0, 0.995, 0.975];
    var SKY_SH = [0.68, 0.75, 0.86];              // shadow facing up: sky fill
    var GND_SH = [0.53, 0.57, 0.65];              // shadow facing down: dim ground bounce
    var BASE = [0.58, 0.62, 0.71];                // flat underside
    var out = new Uint8ClampedArray(N * 4);
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        idx = y * W + x;
        a = A[idx] * opacity;
        if (a <= 0.002) continue;
        var zl = x > 0 ? ZS[idx - 1] : ZS[idx], zr = x < W - 1 ? ZS[idx + 1] : ZS[idx];
        var zu = y > 0 ? ZS[idx - W] : ZS[idx], zd = y < H - 1 ? ZS[idx + W] : ZS[idx];
        var nx = -(zr - zl) * 0.5, ny = -(zd - zu) * 0.5, nz = 1;
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz); nx /= nl; ny /= nl; nz /= nl;
        var ndl = nx * Lx + ny * Ly + nz * Lz;
        var diff = clamp01((ndl + 0.15) / 1.15);
        // soft self-shadow: march toward the sun through the height field
        var od = 0, px = x + 0.5, py = y + 0.5, zray = ZN[idx], st;
        for (st = 1; st <= STEPS; st++) {
          var sl = stepLen * (0.5 + st * 0.2);
          px += sdx * sl; py += sdy * sl; zray += rise * sl;
          var ix = px | 0, iy = py | 0;
          if (ix < 0 || iy < 0 || ix >= W || iy >= H) break;
          var zs = ZN[iy * W + ix] - zray;
          if (zs > 0) od += sl * Math.min(1, zs / (H * 0.06));
        }
        var T = Math.exp(-sigma * od);
        T = Math.max(T, 0.30 * Math.exp(-sigma * 0.3 * od));
        // light has crossed more cloud the lower we are below the local top
        var tcol = TOP[x], depth = clamp01((y - tcol) / Math.max(1, yb - tcol));
        var sunI = diff * T * (1 - 0.6 * smooth(0.2, 1.0, depth));
        var ao = clamp01((ZB[idx] - ZN[idx]) / (H * 0.14));
        var up = clamp01(-ny * 0.7 + 0.5);
        var shR = GND_SH[0] + (SKY_SH[0] - GND_SH[0]) * up;
        var shG = GND_SH[1] + (SKY_SH[1] - GND_SH[1]) * up;
        var shB = GND_SH[2] + (SKY_SH[2] - GND_SH[2]) * up;
        var li = smooth(0.05, 0.8, sunI);
        var rr = shR + (LIT[0] - shR) * li, gg = shG + (LIT[1] - shG) * li, bb = shB + (LIT[2] - shB) * li;
        var dark = 1 - 0.18 * ao;
        rr *= dark; gg *= dark; bb *= dark;
        // the flat underside we see from below: darker grey-blue band
        var band = smooth(yb - H * 0.22, yb - H * 0.03, y + B[idx] * H * 0.12) * 0.8;
        rr += (BASE[0] - rr) * band; gg += (BASE[1] - gg) * band; bb += (BASE[2] - bb) * band;
        if (haze > 0) {
          rr += (hazeRgb[0] - rr) * haze; gg += (hazeRgb[1] - gg) * haze; bb += (hazeRgb[2] - bb) * haze;
        }
        var o4 = idx * 4;
        out[o4] = rr * 255; out[o4 + 1] = gg * 255; out[o4 + 2] = bb * 255; out[o4 + 3] = a * 255;
      }
    }
    return { width: W, height: H, data: out };
  }

  // separable box blur (sliding window), used for the crevice term
  function boxBlur(src, W, H, R) {
    var tmp = new Float32Array(W * H), dst = new Float32Array(W * H);
    var x, y, acc, inv = 1 / (2 * R + 1), row, xi;
    for (y = 0; y < H; y++) {
      row = y * W; acc = 0;
      for (x = -R; x <= R; x++) acc += src[row + (x < 0 ? 0 : x >= W ? W - 1 : x)];
      for (x = 0; x < W; x++) {
        tmp[row + x] = acc * inv;
        xi = x + R + 1; acc += src[row + (xi >= W ? W - 1 : xi)];
        xi = x - R; acc -= src[row + (xi < 0 ? 0 : xi)];
      }
    }
    for (x = 0; x < W; x++) {
      acc = 0;
      for (y = -R; y <= R; y++) acc += tmp[(y < 0 ? 0 : y >= H ? H - 1 : y) * W + x];
      for (y = 0; y < H; y++) {
        dst[y * W + x] = acc * inv;
        xi = y + R + 1; acc += tmp[(xi >= H ? H - 1 : xi) * W + x];
        xi = y - R; acc -= tmp[(xi < 0 ? 0 : xi) * W + x];
      }
    }
    return dst;
  }

  /* makeCirrus(seed, w, h, opt) — high, wispy, fibrous streaks. w:h ~ 4:1.
     opt.maxAlpha default 0.45. */
  function makeCirrus(seed, w, h, opt) {
    opt = opt || {};
    var W = Math.max(8, w | 0), H = Math.max(4, h | 0), N = W * H;
    var rand = mulberry32(seed >>> 0);
    var noise = makeNoise(rand);
    var maxA = opt.maxAlpha == null ? 0.45 : opt.maxAlpha;
    var out = new Uint8ClampedArray(N * 4);
    // a few elongated soft patches along a gently curved spine
    var np = 4 + ((rand() * 3) | 0), PX = [], PY = [], PW = [], PH = [], PA = [];
    for (var i = 0; i < np; i++) {
      PX.push(0.15 + 0.7 * (i + rand() * 0.8) / np);
      PY.push(0.5 + (rand() - 0.5) * 0.35);
      PW.push(0.16 + 0.16 * rand());
      PH.push(0.20 + 0.14 * rand());
      PA.push(0.55 + 0.45 * rand());
    }
    var tilt = (rand() - 0.5) * 0.25;
    var oct = Math.max(2, Math.min(5, Math.floor(Math.log2(H / 3))));
    for (var y = 0; y < H; y++) {
      var v = y / H;
      for (var x = 0; x < W; x++) {
        var u = x / W;
        // domain warp: long gentle bends of the fibres
        var wv = v + tilt * (u - 0.5) + noise(u * 2.2 + 5.1, v * 1.3) * 0.26;
        var env = 0;
        for (var p = 0; p < np; p++) {
          var ex = (u - PX[p]) / PW[p], ey = (wv - PY[p]) / PH[p];
          var g = Math.exp(-(ex * ex + ey * ey) * 1.6) * PA[p];
          if (g > env) env = g;
        }
        if (env < 0.02) continue;
        // fibrous: stretched fbm (x frequency / 5), plus a ridged fine streak layer
        var fx = u * 3.0, fy = wv * 15.0, amp = 1, sum = 0, norm = 0;
        for (var o = 0; o < oct; o++) {
          sum += amp * noise(fx + 11.7 * o, fy);
          norm += amp; amp *= 0.55; fx *= 2.0; fy *= 2.0;
        }
        var f = sum / norm * 0.5 + 0.5;
        var ridge = 1 - Math.abs(noise(u * 3.0 + 3.3 + wv * 2.0, wv * 20.0));
        var d = env * (0.35 + 0.95 * f) * (0.70 + 0.30 * ridge * ridge) - 0.26;
        var a = clamp01(d / 0.38);
        a = a * a * (3 - 2 * a) * maxA;
        var bd = Math.min(x, W - 1 - x, y, H - 1 - y);
        if (bd < 2) a *= bd * 0.5;
        if (a <= 0.002) continue;
        var o4 = (y * W + x) * 4;
        out[o4] = 255; out[o4 + 1] = 255; out[o4 + 2] = 255; out[o4 + 3] = a * 255;
      }
    }
    return { width: W, height: H, data: out };
  }

  root.MPOClouds = { makeCumulus: makeCumulus, makeCirrus: makeCirrus, mulberry32: mulberry32 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
