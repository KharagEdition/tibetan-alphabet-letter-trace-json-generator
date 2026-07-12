/* ═════════════════════════════════════════════════════════════
   STROKE AUTO-REFINEMENT ENGINE

   Takes a hand-drawn stroke polyline plus the exact glyph ink
   geometry (a binary mask) and produces the "perfect" guide path:

     raw sketch → densify → relax onto the medial axis (the exact
     centerline of the limb) → trim/extend ends to the limb tips →
     smooth → uniform resample → collapse to a straight segment
     when the limb is straight (with exact horizontal/vertical
     snapping) → width = true limb thickness.

   Works in the browser (mask from a canvas ImageData ghost) and in
   Node (mask rasterized from the letters.json outline/region SVG
   paths). No dependencies.
════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.StrokeRefine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── SVG path parsing (absolute M/L/H/V/Q/C/Z, implicit repeats) ── */

  function parsePathPolygons(d, quadSegs) {
    quadSegs = quadSegs || 24;
    const tokens = d.match(/[A-Za-z]|-?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/g) || [];
    const polys = [];
    let poly = [];
    let cur = { x: 0, y: 0 };
    let cmd = null;
    let i = 0;

    const num = () => parseFloat(tokens[i++]);
    const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);
    const flush = () => { if (poly.length > 2) polys.push(poly); poly = []; };
    const quadTo = (cx, cy, x, y) => {
      const p0 = { x: cur.x, y: cur.y };
      for (let k = 1; k <= quadSegs; k++) {
        const t = k / quadSegs, u = 1 - t;
        poly.push({
          x: u * u * p0.x + 2 * u * t * cx + t * t * x,
          y: u * u * p0.y + 2 * u * t * cy + t * t * y
        });
      }
      cur = { x, y };
    };
    const cubicTo = (ax, ay, bx, by, x, y) => {
      const p0 = { x: cur.x, y: cur.y };
      for (let k = 1; k <= quadSegs; k++) {
        const t = k / quadSegs, u = 1 - t;
        poly.push({
          x: u * u * u * p0.x + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x,
          y: u * u * u * p0.y + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y
        });
      }
      cur = { x, y };
    };

    while (i < tokens.length) {
      if (!isNum()) cmd = tokens[i++];
      else if (cmd === 'M') cmd = 'L'; // pairs after a moveto are linetos

      switch (cmd) {
        case 'M': { flush(); const x = num(), y = num(); cur = { x, y }; poly.push({ x, y }); break; }
        case 'L': { const x = num(), y = num(); poly.push({ x, y }); cur = { x, y }; break; }
        case 'H': { const x = num(); poly.push({ x, y: cur.y }); cur = { x, y: cur.y }; break; }
        case 'V': { const y = num(); poly.push({ x: cur.x, y }); cur = { x: cur.x, y }; break; }
        case 'Q': quadTo(num(), num(), num(), num()); break;
        case 'C': cubicTo(num(), num(), num(), num(), num(), num()); break;
        case 'Z': case 'z': flush(); break;
        default: throw new Error('Unsupported path command: ' + cmd);
      }
    }
    flush();
    return polys;
  }

  /* ── Scanline rasterizer (nonzero / evenodd) ── */

  function rasterizePolygons(polys, w, h, rule) {
    const mask = new Uint8Array(w * h);
    const edges = [];
    for (const poly of polys) {
      const n = poly.length;
      for (let k = 0; k < n; k++) {
        const a = poly[k], b = poly[(k + 1) % n];
        if (a.y === b.y) continue;
        edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: a.y < b.y ? 1 : -1 });
      }
    }
    for (let iy = 0; iy < h; iy++) {
      const y = iy + 0.5;
      const xs = [];
      for (const e of edges) {
        const ymin = Math.min(e.y0, e.y1), ymax = Math.max(e.y0, e.y1);
        if (y < ymin || y >= ymax) continue; // half-open: no vertex double count
        const t = (y - e.y0) / (e.y1 - e.y0);
        xs.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.dir });
      }
      if (!xs.length) continue;
      xs.sort((a, b) => a.x - b.x);
      if (rule === 'evenodd') {
        for (let k = 0; k + 1 < xs.length; k += 2) fillSpan(mask, w, iy, xs[k].x, xs[k + 1].x);
      } else {
        let wind = 0, spanX = 0;
        for (const c of xs) {
          const prev = wind;
          wind += c.dir;
          if (prev === 0 && wind !== 0) spanX = c.x;
          else if (prev !== 0 && wind === 0) fillSpan(mask, w, iy, spanX, c.x);
        }
      }
    }
    return { data: mask, w, h };
  }

  function fillSpan(mask, w, iy, xa, xb) {
    let x0 = Math.ceil(xa - 0.5), x1 = Math.floor(xb - 0.5);
    if (x0 < 0) x0 = 0;
    if (x1 >= w) x1 = w - 1;
    const off = iy * w;
    for (let x = x0; x <= x1; x++) mask[off + x] = 1;
  }

  function intersectMasks(a, b) {
    const out = new Uint8Array(a.w * a.h);
    for (let i = 0; i < out.length; i++) out[i] = a.data[i] & b.data[i];
    return { data: out, w: a.w, h: a.h };
  }

  /* ── Exact Euclidean distance transform (Felzenszwalb–Huttenlocher) ── */

  function edt(maskObj) {
    const { data, w, h } = maskObj;
    const INF = 1e12;
    const n = Math.max(w, h);
    const f = new Float64Array(n);
    const dfun = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    const D = new Float64Array(w * h);

    for (let i = 0; i < w * h; i++) D[i] = data[i] ? INF : 0;

    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = D[y * w + x];
      dt1d(f, h, dfun, v, z);
      for (let y = 0; y < h; y++) D[y * w + x] = dfun[y];
    }
    for (let y = 0; y < h; y++) {
      const off = y * w;
      for (let x = 0; x < w; x++) f[x] = D[off + x];
      dt1d(f, w, dfun, v, z);
      for (let x = 0; x < w; x++) D[off + x] = dfun[x];
    }
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(D[i]);
    return out;
  }

  function dt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -1e20;
    z[1] = 1e20;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }

  /* ── Field: bilinear distance sampling over pixel centers ── */

  function makeField(maskObj) {
    const { w, h } = maskObj;
    const D = edt(maskObj);
    function dist(x, y) {
      let fx = x - 0.5, fy = y - 0.5;
      if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
      if (fy < 0) fy = 0; else if (fy > h - 1) fy = h - 1;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
      const tx = fx - x0, ty = fy - y0;
      const d00 = D[y0 * w + x0], d10 = D[y0 * w + x1];
      const d01 = D[y1 * w + x0], d11 = D[y1 * w + x1];
      return (d00 * (1 - tx) + d10 * tx) * (1 - ty) + (d01 * (1 - tx) + d11 * tx) * ty;
    }
    function inside(x, y) {
      const ix = Math.floor(x), iy = Math.floor(y);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) return false;
      return maskObj.data[iy * w + ix] === 1;
    }
    return { w, h, dist, inside, D, mask: maskObj };
  }

  /* Browser helper: build a mask from canvas ImageData alpha. */
  function maskFromImageData(imageData, alphaThreshold) {
    const t = alphaThreshold == null ? 60 : alphaThreshold;
    const { width: w, height: h, data } = imageData;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = data[i * 4 + 3] > t ? 1 : 0;
    return { data: mask, w, h };
  }

  /* ── Polyline helpers ── */

  function dist2d(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  function pathLen(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += dist2d(pts[i - 1], pts[i]);
    return L;
  }

  function resampleN(pts, n) {
    const L = pathLen(pts);
    if (L === 0) {
      const a = pts[0], b = pts[pts.length - 1];
      return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist2d(pts[i - 1], pts[i]));
    const out = [];
    let seg = 0;
    for (let k = 0; k < n; k++) {
      const s = (k / (n - 1)) * L;
      while (seg < pts.length - 2 && cum[seg + 1] < s) seg++;
      const segLen = cum[seg + 1] - cum[seg];
      const t = segLen > 0 ? (s - cum[seg]) / segLen : 0;
      out.push({
        x: pts[seg].x + t * (pts[seg + 1].x - pts[seg].x),
        y: pts[seg].y + t * (pts[seg + 1].y - pts[seg].y)
      });
    }
    return out;
  }

  function resampleStep(pts, step) {
    if (pts.length < 2) return pts.slice();
    const n = Math.max(2, Math.round(pathLen(pts) / step) + 1);
    return resampleN(pts, n);
  }

  function tangentAt(pts, i) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    return { x: dx / L, y: dy / L };
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* Ridge (local max of the distance field) along the normal through p.
     Returns the signed offset s* ∈ [-R, R] of the ridge nearest to s=0,
     with a small bias toward taller ridges, or null if none found —
     keeps points on their own limb near junctions. */
  function ridgeOffset(field, p, nrm, R) {
    const N = Math.max(4, Math.ceil(R));
    const stepLen = R / N;
    const vals = new Float64Array(2 * N + 1);
    for (let k = -N; k <= N; k++) {
      vals[k + N] = field.dist(p.x + nrm.x * k * stepLen, p.y + nrm.y * k * stepLen);
    }
    let bestIdx = -1, bestScore = Infinity;
    for (let k = 0; k <= 2 * N; k++) {
      const v = vals[k];
      if (v <= 0.5) continue;
      const lo = k > 0 ? vals[k - 1] : -1;
      const hi = k < 2 * N ? vals[k + 1] : -1;
      if (v >= lo && v >= hi) {
        const score = Math.abs(k - N) - (v / stepLen) * 0.15;
        if (score < bestScore) { bestScore = score; bestIdx = k; }
      }
    }
    if (bestIdx < 0) return null;
    let s = (bestIdx - N) * stepLen;
    if (bestIdx > 0 && bestIdx < 2 * N) {
      const d0 = vals[bestIdx - 1], d1 = vals[bestIdx], d2 = vals[bestIdx + 1];
      const denom = d0 - 2 * d1 + d2;
      if (Math.abs(denom) > 1e-9) {
        const frac = 0.5 * (d0 - d2) / denom;
        if (Math.abs(frac) <= 1) s += frac * stepLen;
      }
    }
    return s;
  }

  function gaussianAlong(pts) {
    if (pts.length < 5) return pts;
    const k = [1, 4, 6, 4, 1];
    return pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return { x: p.x, y: p.y };
      let sx = 0, sy = 0, sw = 0;
      for (let j = -2; j <= 2; j++) {
        const idx = i + j;
        if (idx < 0 || idx >= pts.length) continue;
        sx += pts[idx].x * k[j + 2];
        sy += pts[idx].y * k[j + 2];
        sw += k[j + 2];
      }
      return { x: sx / sw, y: sy / sw };
    });
  }

  function fitLine(pts) {
    if (pts.length < 2) return null;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) {
      const dx = p.x - mx, dy = p.y - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dir = { x: Math.cos(theta), y: Math.sin(theta) };
    let maxDev = 0;
    for (const p of pts) {
      const dev = Math.abs((p.x - mx) * -dir.y + (p.y - my) * dir.x);
      if (dev > maxDev) maxDev = dev;
    }
    return { cx: mx, cy: my, dir, maxDev };
  }

  function project(line, p) {
    const t = (p.x - line.cx) * line.dir.x + (p.y - line.cy) * line.dir.y;
    return { x: line.cx + t * line.dir.x, y: line.cy + t * line.dir.y };
  }

  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function distToPolyline(p, pts) {
    if (pts.length === 1) return dist2d(p, pts[0]);
    let dmin = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distToSeg(p, pts[i], pts[i + 1]);
      if (d < dmin) dmin = d;
    }
    return dmin;
  }

  /* If the limb is straight, collapse the path to a clean 2-point
     segment. "Straight" is judged against a line fitted to the middle
     60% of the path (immune to end artifacts). Allowed deviations:
       • short bent runs at the ends (ridge hooks at flared limb tips),
         each at most ~1.3 limb-widths of arc
       • short, shallow interior dips (ridge wiggles at junction-seam
         notches)
     A genuinely curved limb deviates over most of its length and is
     rejected. On success the segment is snapped to exact horizontal/
     vertical when within axisSnapDeg and re-extended straight until
     the corridor narrows. */
  function tryCollapse(pts, field, o) {
    const total = pathLen(pts);
    if (total < 6 * o.scale) return null;

    const dense = resampleStep(pts, Math.max(2 * o.scale, 2));
    const cum = [0];
    for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + dist2d(dense[i - 1], dense[i]));

    const mid = dense.filter((_, i) => cum[i] >= 0.2 * total && cum[i] <= 0.8 * total);
    if (mid.length < 3) return null;
    const midLine = fitLine(mid);
    if (!midLine || midLine.maxDev > o.devTol) return null;

    const devOf = (line, p) =>
      Math.abs((p.x - line.cx) * -line.dir.y + (p.y - line.cy) * line.dir.x);
    const devs = dense.map(p => devOf(midLine, p));
    const inlier = devs.map(d => d <= o.devTol);

    let first = inlier.indexOf(true);
    let last = inlier.lastIndexOf(true);
    if (first < 0 || last <= first) return null;

    // end hooks: bounded arc (an artifact hook is at most ~a limb-width
    // long; real curves bend over much more of their length)
    const endAllow = Math.min(0.9 * o.width, 0.2 * total);
    if (cum[first] > endAllow) return null;
    if (total - cum[last] > endAllow) return null;
    if (cum[first] + (total - cum[last]) > 0.3 * total) return null;

    // interior outlier bursts: short and shallow only
    let burstStart = -1, interiorOutlierArc = 0;
    for (let i = first; i <= last; i++) {
      if (!inlier[i]) {
        if (burstStart < 0) burstStart = i;
        if (devs[i] > 2 * o.devTol) return null;              // too deep
      } else if (burstStart >= 0) {
        const burstArc = cum[i] - cum[burstStart];
        if (burstArc > Math.max(o.width, 8 * o.scale)) return null; // too long
        interiorOutlierArc += burstArc;
        burstStart = -1;
      }
    }
    if (interiorOutlierArc > 0.22 * total) return null;

    // refit on inliers only
    const inlierPts = dense.filter((_, i) => i >= first && i <= last && inlier[i]);
    const line = fitLine(inlierPts);
    if (!line || line.maxDev > o.devTol) return null;

    let a = project(line, dense[first]);
    let b = project(line, dense[last]);
    let axisSnapped = false;

    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const deg = ang * 180 / Math.PI;
    const mod = ((deg % 90) + 90) % 90;
    const offAxis = Math.min(mod, 90 - mod);
    if (offAxis < o.axisSnapDeg) {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y) / 2;
      const horiz = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
      const sx = Math.sign(b.x - a.x) || 1, sy = Math.sign(b.y - a.y) || 1;
      const a2 = horiz ? { x: cx - len * sx, y: cy } : { x: cx, y: cy - len * sy };
      const b2 = horiz ? { x: cx + len * sx, y: cy } : { x: cx, y: cy + len * sy };
      let snapDev = 0;
      for (const p of inlierPts) snapDev = Math.max(snapDev, distToSeg(p, a2, b2));
      if (snapDev < 1.2 * o.devTol) { a = a2; b = b2; axisSnapped = true; }
    }

    // re-extend along the (possibly snapped) straight direction
    const dL = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dir = { x: (b.x - a.x) / dL, y: (b.y - a.y) / dL };
    const step = 3 * o.scale;
    const march = (from, d) => {
      let cur = { x: from.x, y: from.y };
      let walked = 0;
      while (walked < o.maxExt) {
        const nxt = { x: cur.x + d.x * step, y: cur.y + d.y * step };
        if (field.dist(nxt.x, nxt.y) < o.stopD) break;
        cur = nxt;
        walked += step;
      }
      return cur;
    };
    b = march(b, dir);
    a = march(a, { x: -dir.x, y: -dir.y });

    return { pts: [a, b], axisSnapped };
  }

  /* ── The main refinement ── */

  function refineStroke(rawPts, field, opts) {
    opts = opts || {};
    const scale = opts.scale || 1;           // defaults tuned for a 1000-box
    const sampleStep = opts.sampleStep || 6 * scale;
    const outStep = opts.outStep || 12 * scale;
    const iters = opts.iters || 16;
    const maxStep = opts.maxStep || 3 * scale;
    const lambda = opts.lambda == null ? 0.22 : opts.lambda;
    const stats = { collapsed: false, axisSnapped: false, extendedHead: 0, extendedTail: 0, maxMove: 0, ok: false };

    if (!rawPts || rawPts.length < 2) {
      return { points: rawPts ? rawPts.slice() : [], width: opts.fallbackWidth || 0, stats };
    }

    let pts = resampleStep(rawPts.map(p => ({ x: p.x, y: p.y })), sampleStep);

    // initial half-width estimate from samples inside the ink
    const dIn = pts.map(p => field.dist(p.x, p.y)).filter(d => d > 0.5);
    if (dIn.length < Math.max(2, pts.length * 0.3)) {
      // stroke drawn mostly outside the glyph — leave it alone
      return { points: rawPts.slice(), width: opts.fallbackWidth || 0, stats };
    }
    const h0 = median(dIn);
    const R = opts.searchR || Math.min(Math.max(1.8 * h0, 8 * scale), 70 * scale);

    // ── relax onto the medial axis ──
    for (let it = 0; it < iters; it++) {
      pts = pts.map((p, i) => {
        const t = tangentAt(pts, i);
        const nrm = { x: -t.y, y: t.x };
        const s = ridgeOffset(field, p, nrm, R);
        if (s == null) return { x: p.x, y: p.y };
        const move = Math.max(-maxStep, Math.min(maxStep, s * 0.7));
        return { x: p.x + nrm.x * move, y: p.y + nrm.y * move };
      });
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i - 1].x + pts[i + 1].x) / 2;
        const my = (pts[i - 1].y + pts[i + 1].y) / 2;
        pts[i] = { x: pts[i].x + lambda * (mx - pts[i].x), y: pts[i].y + lambda * (my - pts[i].y) };
      }
      if (it % 4 === 3) pts = resampleStep(pts, sampleStep);
    }

    // refreshed width estimate from the centered path
    const hMid = pts.map(p => field.dist(p.x, p.y)).filter(d => d > 0.5);
    const h = hMid.length ? median(hMid) : h0;
    const minD = Math.max(1.5 * scale, (opts.minDFrac == null ? 0.20 : opts.minDFrac) * h);
    const stopD = Math.max(2 * scale, (opts.stopDFrac == null ? 0.45 : opts.stopDFrac) * h);

    // ── trim ends that sit outside / too close to the boundary ──
    while (pts.length > 2 && field.dist(pts[0].x, pts[0].y) < minD) pts.shift();
    while (pts.length > 2 && field.dist(pts[pts.length - 1].x, pts[pts.length - 1].y) < minD) pts.pop();

    // ── junction guard: a stroke's end may not overshoot through a
    // junction into a transverse limb (e.g. a stem poking into the head
    // bar). Scan inward from each end: if clearance exceeds junctionD
    // anywhere in the end zone, the stroke crossed a wider limb — cut
    // everything from the end through that crossing, then keep cutting
    // until clearance settles back to the stroke's own half-width.
    // Only meaningful on a whole-glyph field; inside a per-stroke
    // corridor the clearance never exceeds the limb width.
    const junctionD = (opts.junctionFrac == null ? 1.35 : opts.junctionFrac) * h;
    const junctionTrim = (arr) => {
      const zone = Math.floor(arr.length * 0.35);
      let cut = -1;
      for (let i = 0; i < zone; i++) {
        if (field.dist(arr[i].x, arr[i].y) > junctionD) cut = i;
      }
      if (cut < 0) return arr;
      cut++;
      while (cut < arr.length - 2 && field.dist(arr[cut].x, arr[cut].y) > 1.05 * h) cut++;
      return arr.slice(cut);
    };
    if (pts.length > 4) {
      pts = junctionTrim(pts);
      pts = junctionTrim(pts.reverse()).reverse();
    }

    // ── extend both ends along the limb until near its tip ──
    const maxExt = opts.maxExtend == null ? 400 * scale : opts.maxExtend;
    const extend = (reverse) => {
      let path = reverse ? pts.slice().reverse() : pts.slice();
      const step = Math.max(2 * scale, sampleStep / 2.5);
      let cur = path[path.length - 1];
      let dir = (() => {
        const a = path[Math.max(0, path.length - 3)];
        const d = { x: cur.x - a.x, y: cur.y - a.y };
        const L = Math.hypot(d.x, d.y) || 1;
        return { x: d.x / L, y: d.y / L };
      })();
      const dir0 = { x: dir.x, y: dir.y };
      let added = 0;
      while (added < maxExt) {
        let cand = { x: cur.x + dir.x * step, y: cur.y + dir.y * step };
        // re-center laterally so the extension follows curved limbs
        const nrm = { x: -dir.y, y: dir.x };
        const s = ridgeOffset(field, cand, nrm, Math.max(R * 0.75, 4));
        if (s != null) cand = { x: cand.x + nrm.x * s * 0.85, y: cand.y + nrm.y * s * 0.85 };
        const dc = field.dist(cand.x, cand.y);
        if (dc < stopD || dc > junctionD) break; // limb tip / crossing a junction
        const nd = { x: cand.x - cur.x, y: cand.y - cur.y };
        const ndL = Math.hypot(nd.x, nd.y) || 1;
        const ndir = { x: nd.x / ndL, y: nd.y / ndL };
        const stepTurn = Math.acos(Math.max(-1, Math.min(1, ndir.x * dir.x + ndir.y * dir.y)));
        const totalTurn = Math.acos(Math.max(-1, Math.min(1, ndir.x * dir0.x + ndir.y * dir0.y)));
        if (stepTurn > (20 * Math.PI / 180) || totalTurn > (75 * Math.PI / 180)) break;
        path.push(cand);
        cur = cand;
        dir = ndir;
        added += ndL;
      }
      pts = reverse ? path.reverse() : path;
      return added;
    };
    stats.extendedTail = Math.round(extend(false) * 10) / 10;
    stats.extendedHead = Math.round(extend(true) * 10) / 10;

    // ── settle: light relax + smooth + uniform resample ──
    for (let it = 0; it < 3; it++) {
      pts = pts.map((p, i) => {
        const t = tangentAt(pts, i);
        const nrm = { x: -t.y, y: t.x };
        const s = ridgeOffset(field, p, nrm, R * 0.6);
        if (s == null) return p;
        const move = Math.max(-maxStep, Math.min(maxStep, s * 0.6));
        return { x: p.x + nrm.x * move, y: p.y + nrm.y * move };
      });
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i - 1].x + pts[i + 1].x) / 2;
        const my = (pts[i - 1].y + pts[i + 1].y) / 2;
        pts[i] = { x: pts[i].x + 0.18 * (mx - pts[i].x), y: pts[i].y + 0.18 * (my - pts[i].y) };
      }
    }
    pts = resampleStep(pts, sampleStep);
    pts = gaussianAlong(pts);
    pts = resampleStep(pts, outStep);

    // ── measure width from the middle 80% of the final path ──
    const hs = [];
    for (let i = 0; i < pts.length; i++) {
      const frac = pts.length > 1 ? i / (pts.length - 1) : 0.5;
      if (frac < 0.1 || frac > 0.9) continue;
      const d = field.dist(pts[i].x, pts[i].y);
      if (d > 0.5) hs.push(d);
    }
    const width = 2 * (hs.length ? median(hs) : h);

    // ── straight-line collapse + exact horizontal/vertical snap ──
    const devTol = Math.max(2.2 * scale, (opts.devTolFrac == null ? 0.12 : opts.devTolFrac) * width);
    const collapsed = tryCollapse(pts, field, {
      devTol,
      stopD,
      scale,
      maxExt,
      width,
      axisSnapDeg: opts.axisSnapDeg == null ? 2.5 : opts.axisSnapDeg
    });
    if (collapsed) {
      pts = collapsed.pts;
      stats.collapsed = true;
      stats.axisSnapped = collapsed.axisSnapped;
    }

    // displacement statistic vs the raw sketch
    const rawDense = resampleStep(rawPts.map(p => ({ x: p.x, y: p.y })), sampleStep);
    for (const p of rawDense) {
      const d = distToPolyline(p, pts);
      if (d > stats.maxMove) stats.maxMove = d;
    }
    stats.maxMove = Math.round(stats.maxMove * 10) / 10;
    stats.ok = true;

    const round1 = v => Math.round(v * 10) / 10;
    return {
      points: pts.map(p => ({ x: round1(p.x), y: round1(p.y) })),
      width: round1(width),
      stats
    };
  }

  /* ── Mask → polygon tooling (for region generation) ── */

  function dilateMask(maskObj, r) {
    let { data, w, h } = maskObj;
    let src = data;
    for (let pass = 0; pass < r; pass++) {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (src[i]) { out[i] = 1; continue; }
          let on = 0;
          for (let dy = -1; dy <= 1 && !on; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= w) continue;
              if (src[ny * w + nx]) { on = 1; break; }
            }
          }
          out[i] = on;
        }
      }
      src = out;
    }
    return { data: src, w, h };
  }

  /* Trace the boundary of a binary mask as closed rectilinear loops
     (inside kept on the left), then Douglas-Peucker simplify. Handles
     holes and disjoint blobs; loop orientation is irrelevant for
     evenodd filling. */
  function traceMaskContours(maskObj, tol) {
    const { data, w, h } = maskObj;
    const isIn = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] === 1;
    const K = w + 2;
    const edges = new Map(); // start corner -> outgoing edge endpoints
    const addEdge = (x0, y0, x1, y1) => {
      const k = x0 + y0 * K;
      let arr = edges.get(k);
      if (!arr) { arr = []; edges.set(k, arr); }
      arr.push({ x: x1, y: y1 });
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[y * w + x] !== 1) continue;
        if (!isIn(x, y - 1)) addEdge(x, y, x + 1, y);
        if (!isIn(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
        if (!isIn(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
        if (!isIn(x - 1, y)) addEdge(x, y + 1, x, y);
      }
    }
    const loops = [];
    for (const [k, arr] of edges) {
      while (arr.length) {
        const startX = k % K;
        const startY = (k - startX) / K;
        const first = arr.pop();
        const loop = [{ x: startX, y: startY }];
        let cx = first.x, cy = first.y;
        let guard = 4 * (w + 1) * (h + 1);
        while ((cx !== startX || cy !== startY) && guard-- > 0) {
          loop.push({ x: cx, y: cy });
          const cand = edges.get(cx + cy * K);
          if (!cand || !cand.length) break;
          let idx = 0;
          if (cand.length > 1) {
            // diagonal-touch corner: pick the sharpest left turn so the
            // two blobs/holes stay separate loops
            const prev = loop[loop.length - 2];
            const inx = cx - prev.x, iny = cy - prev.y;
            let best = -1e9;
            cand.forEach((e, i2) => {
              const cross = inx * (e.y - cy) - iny * (e.x - cx);
              if (cross > best) { best = cross; idx = i2; }
            });
          }
          const e = cand.splice(idx, 1)[0];
          cx = e.x; cy = e.y;
        }
        if (loop.length >= 4) loops.push(simplifyClosed(loop, tol == null ? 1 : tol));
      }
    }
    return loops.filter(l => l.length >= 3);
  }

  function dpSimplify(pts, tol) {
    if (pts.length <= 2) return pts.slice();
    const a = pts[0], b = pts[pts.length - 1];
    let maxD = -1, maxI = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = distToSeg(pts[i], a, b);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD <= tol) return [a, b];
    const left = dpSimplify(pts.slice(0, maxI + 1), tol);
    const right = dpSimplify(pts.slice(maxI), tol);
    return left.slice(0, -1).concat(right);
  }

  function simplifyClosed(loop, tol) {
    // rotate so the loop starts at an extreme corner (kept by DP)
    let mi = 0;
    for (let i = 1; i < loop.length; i++) {
      if (loop[i].x > loop[mi].x || (loop[i].x === loop[mi].x && loop[i].y > loop[mi].y)) mi = i;
    }
    const rot = loop.slice(mi).concat(loop.slice(0, mi));
    rot.push({ x: rot[0].x, y: rot[0].y });
    const out = dpSimplify(rot, tol);
    out.pop();
    return out;
  }

  function contoursToPath(loops) {
    return loops.map(l =>
      'M' + l.map(p => `${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`).join('L') + 'Z'
    ).join('');
  }

  /* ── Cross-stroke junction trim ──
     Later strokes yield to earlier ones: if an end of stroke B lies
     inside an EARLIER stroke A's core band (within 0.55×A.width of A's
     guide, crossing at a real angle), cut B back to where it exits
     that band. This is what places guide starts just below the head
     bar — like the reference tracing apps — and keeps the region
     partition from biting wedges out of earlier strokes' territory.
     strokes: [{ points: [{x,y},…], width }] — points are mutated. */
  function trimToOtherStrokes(strokes, opts) {
    opts = opts || {};
    const scale = opts.scale || 1;
    const coreFrac = opts.coreFrac == null ? 0.55 : opts.coreFrac;
    const minAngle = (opts.minAngleDeg == null ? 25 : opts.minAngleDeg) * Math.PI / 180;
    const outStep = opts.outStep || 12 * scale;

    const segsOf = strokes.map(s => {
      const segs = [];
      for (let i = 0; i + 1 < s.points.length; i++) {
        const a = s.points[i], b = s.points[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const L2 = dx * dx + dy * dy;
        if (L2 > 1e-9) segs.push({ ax: a.x, ay: a.y, dx, dy, L2, len: Math.sqrt(L2) });
      }
      return segs;
    });

    const insideEarlierCore = (bi, p, tan) => {
      for (let ai = 0; ai < bi; ai++) {
        const core = coreFrac * (strokes[ai].width || 0);
        if (core <= 0) continue;
        for (const s of segsOf[ai]) {
          const t = ((p.x - s.ax) * s.dx + (p.y - s.ay) * s.dy) / s.L2;
          if (t < 0.02 || t > 0.98) continue;
          const lat = Math.abs((p.x - s.ax) * s.dy - (p.y - s.ay) * s.dx) / s.len;
          if (lat >= core) continue;
          const dot = Math.abs(tan.x * s.dx + tan.y * s.dy) / s.len;
          if (Math.acos(Math.min(1, dot)) > minAngle) return true;
        }
      }
      return false;
    };

    for (let bi = 1; bi < strokes.length; bi++) {
      const orig = strokes[bi].points;
      if (orig.length < 2) continue;
      const wasStraight = orig.length === 2;
      let dense = resampleStep(orig, Math.max(2 * scale, 2));
      const trimEnd = (arr) => {
        const zone = Math.floor(arr.length * 0.4);
        let cut = -1;
        for (let i = 0; i < zone; i++) {
          if (insideEarlierCore(bi, arr[i], tangentAt(arr, i))) cut = i;
        }
        return cut < 0 ? arr : arr.slice(Math.min(cut + 1, arr.length - 2));
      };
      dense = trimEnd(dense);
      dense = trimEnd(dense.reverse()).reverse();
      if (dense.length < 2) continue;
      strokes[bi].points = wasStraight
        ? [dense[0], dense[dense.length - 1]]
        : resampleStep(dense, outStep);
    }
    return strokes;
  }

  /* ── Region generation: flat-seam partition of the glyph ink ──
     strokes: [{ points: [[x,y],…], width }] in mask coordinates.
     A pixel belongs to a stroke only if it projects PERPENDICULARLY
     onto one of its guide segments (first/last segments reject
     beyond-cap projections, so territories end in straight caps at the
     stroke's endpoints; interior vertices clamp so bends leave no
     gaps), within a claim radius of ~1.6 stroke widths. Pixels beyond
     every cap (flared corners, limb tips past the guide ends) are
     split by lateral distance to the strokes' extended lines, keeping
     junction seams straight. Each territory is dilated outward so it
     overshoots the outline and its neighbours; rendered as
     fill(region) clipped to the outline, the union covers every ink
     pixel. Returns one SVG path string per stroke. */
  function buildRegions(outlineMask, strokes, opts) {
    opts = opts || {};
    const dilateR = opts.dilate == null ? 3 : opts.dilate;
    const tol = opts.tol == null ? 1.2 : opts.tol;
    const { w, h, data } = outlineMask;
    const label = new Int16Array(w * h).fill(-1);

    const segs = [];
    strokes.forEach((s, si) => {
      const pts = s.points;
      const maxD2 = Math.pow(Math.max(1.6 * (s.width || 80), 24), 2);
      for (let i = 0; i + 1 < pts.length; i++) {
        const ax = pts[i][0], ay = pts[i][1];
        const dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay;
        const L2 = dx * dx + dy * dy;
        if (L2 > 1e-9) {
          segs.push({
            si, ax, ay, dx, dy, L2, maxD2,
            capStart: i === 0,
            capEnd: i === pts.length - 2
          });
        }
      }
    });
    if (!segs.length) return strokes.map(() => '');

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (data[i] !== 1) continue;
        let bi = -1, bd = Infinity;
        for (const s of segs) {
          let t = ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.L2;
          if (t < 0) { if (s.capStart) continue; t = 0; }
          if (t > 1) { if (s.capEnd) continue; t = 1; }
          const px = s.ax + t * s.dx - x, py = s.ay + t * s.dy - y;
          const d2 = px * px + py * py;
          if (d2 <= s.maxD2 && d2 < bd) { bd = d2; bi = s.si; }
        }
        if (bi < 0) {
          for (const s of segs) {
            const t = ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.L2;
            const segLen = Math.sqrt(s.L2);
            let score;
            if (t < 0 && s.capStart) {
              const lat = Math.abs((x - s.ax) * s.dy - (y - s.ay) * s.dx) / segLen;
              score = lat + 0.2 * (-t) * segLen;
            } else if (t > 1 && s.capEnd) {
              const lat = Math.abs((x - s.ax) * s.dy - (y - s.ay) * s.dx) / segLen;
              score = lat + 0.2 * (t - 1) * segLen;
            } else {
              const tc = Math.max(0, Math.min(1, t));
              const px = s.ax + tc * s.dx - x, py = s.ay + tc * s.dy - y;
              score = Math.sqrt(px * px + py * py);
            }
            if (score < bd) { bd = score; bi = s.si; }
          }
        }
        label[i] = bi;
      }
    }

    return strokes.map((_, si) => {
      const m = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) m[i] = (data[i] === 1 && label[i] === si) ? 1 : 0;
      const dilated = dilateMask({ data: m, w, h }, dilateR);
      const loops = traceMaskContours(dilated, tol);
      return contoursToPath(loops);
    });
  }

  return {
    parsePathPolygons,
    rasterizePolygons,
    intersectMasks,
    maskFromImageData,
    edt,
    makeField,
    refineStroke,
    resampleStep,
    pathLen,
    dilateMask,
    traceMaskContours,
    contoursToPath,
    trimToOtherStrokes,
    buildRegions
  };
});
