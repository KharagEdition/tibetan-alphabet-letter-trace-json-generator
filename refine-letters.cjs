#!/usr/bin/env node
/* Auto-refine every recorded stroke in letters.json against the exact
   glyph geometry, then regenerate letters.js.

     node refine-letters.cjs            # refine + write letters.json/letters.js
     node refine-letters.cjs --dry-run  # report only, write nothing
     node refine-letters.cjs --preview  # also write refine-preview.svg

   Each stroke's guide polyline is snapped to the medial axis of its own
   corridor (outline ∩ region), extended to the limb tips, smoothed, and
   collapsed to an exact straight line when the limb is straight. Widths
   are re-measured from the true limb thickness. */
'use strict';

const fs = require('fs');
const path = require('path');
const SR = require('./refine.js');

const ROOT = __dirname;
const DRY = process.argv.includes('--dry-run');
const PREVIEW = process.argv.includes('--preview');

const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'letters.json'), 'utf8'));
const VB = doc.viewBox || 1000;

const DILATE_PX = 3;     // outward overshoot of each region beyond its pixels
const CONTOUR_TOL = 1.2; // Douglas-Peucker tolerance for region polygons

/* Prove the regions cover the outline: every ink pixel must fall inside
   at least one region polygon. Returns the number of uncovered pixels. */
function coverageGap(outlineMask, regionPaths) {
  const { w, h, data } = outlineMask;
  const union = new Uint8Array(w * h);
  for (const rp of regionPaths) {
    const rm = SR.rasterizePolygons(SR.parsePathPolygons(rp, 4), w, h, 'evenodd');
    for (let i = 0; i < w * h; i++) if (rm.data[i]) union[i] = 1;
  }
  let gap = 0;
  for (let i = 0; i < w * h; i++) if (data[i] && !union[i]) gap++;
  return gap;
}

const previews = [];
let refined = 0, skipped = 0;

for (const L of doc.letters || []) {
  if (!L.available || !L.outline || !Array.isArray(L.strokes) || !L.strokes.length) continue;

  const outlinePolys = SR.parsePathPolygons(L.outline, 32);
  const outlineMask = SR.rasterizePolygons(outlinePolys, VB, VB, 'nonzero');
  console.log(`\n${L.glyph}  (${L.id})  strokes: ${L.strokes.length}`);

  const letterPreview = { L, results: [] };

  L.strokes.forEach((s, si) => {
    let mask = outlineMask;
    if (s.region) {
      const regionMask = SR.rasterizePolygons(SR.parsePathPolygons(s.region, 8), VB, VB, 'evenodd');
      mask = SR.intersectMasks(outlineMask, regionMask);
    }
    const field = SR.makeField(mask);
    const raw = s.points.map(([x, y]) => ({ x, y }));
    const res = SR.refineStroke(raw, field, { fallbackWidth: s.width });

    if (!res.stats.ok || res.points.length < 2) {
      skipped++;
      console.log(`  #${si + 1}: SKIPPED (stroke outside its corridor?)`);
      letterPreview.results.push({ raw, res: null });
      return;
    }

    // quality report: clearance along the refined path (should hug width/2)
    const dense = SR.resampleStep(res.points, 8);
    const clear = dense.map(p => field.dist(p.x, p.y));
    const minC = Math.min(...clear).toFixed(1);
    const medC = clear.slice().sort((a, b) => a - b)[clear.length >> 1].toFixed(1);

    const kind = res.stats.collapsed
      ? (res.stats.axisSnapped ? 'straight+axis' : 'straight')
      : `curve(${res.points.length}pt)`;
    console.log(
      `  #${si + 1}: ${kind}  width ${s.width} → ${res.width}` +
      `  moved ≤${res.stats.maxMove}px  ext +${res.stats.extendedHead}/+${res.stats.extendedTail}px` +
      `  clearance med ${medC} min ${minC}`
    );

    if (!DRY) {
      s.points = res.points.map(p => [p.x, p.y]);
      s.width = res.width || s.width;
    }
    refined++;
    letterPreview.results.push({ raw, res });
  });

  // Later strokes yield to earlier ones at junctions (a stem's guide
  // must not poke into the head bar's band).
  if (!DRY) {
    const round1 = v => Math.round(v * 10) / 10;
    const forTrim = L.strokes.map(s => ({
      points: s.points.map(([x, y]) => ({ x, y })),
      width: s.width
    }));
    SR.trimToOtherStrokes(forTrim, {});
    forTrim.forEach((t, si) => {
      L.strokes[si].points = t.points.map(p => [round1(p.x), round1(p.y)]);
    });
  }

  // Regenerate regions from the (refined) guides so their union exactly
  // covers the glyph ink — no dark slivers left behind while tracing.
  const regionPaths = SR.buildRegions(outlineMask, L.strokes, { dilate: DILATE_PX, tol: CONTOUR_TOL });
  const gap = coverageGap(outlineMask, regionPaths);
  const inkPx = outlineMask.data.reduce((a, b) => a + b, 0);
  console.log(`  regions: ${regionPaths.length}, coverage gap ${gap}/${inkPx} ink px ${gap === 0 ? '✓' : '✗ NOT PIXEL-PERFECT'}`);
  if (!DRY && gap === 0) {
    L.strokes.forEach((s, si) => { s.region = regionPaths[si]; });
  } else if (gap !== 0) {
    console.log('  regions left unchanged (coverage gap)');
  }

  previews.push(letterPreview);
}

console.log(`\nRefined ${refined} strokes, skipped ${skipped}.`);

if (!DRY) {
  const json = JSON.stringify(doc, null, 1);
  fs.writeFileSync(path.join(ROOT, 'letters.json'), json + '\n');
  fs.writeFileSync(path.join(ROOT, 'letters.js'), 'window.LETTERS_DATA = ' + json + '\n;\n');
  console.log('Wrote letters.json and letters.js');
}

if (PREVIEW) {
  const cell = 320, pad = 10;
  const cols = Math.max(1, previews.length);
  const sc = cell / VB;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * (cell + pad) + pad}" height="${cell + 2 * pad}" style="background:#111">\n`;
  previews.forEach((pv, i) => {
    const ox = pad + i * (cell + pad);
    svg += `<g transform="translate(${ox},${pad}) scale(${sc})">`;
    svg += `<path d="${pv.L.outline}" fill="#333B4B" stroke="#888" stroke-width="3"/>`;
    for (const { raw, res } of pv.results) {
      const d = pts => pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
      svg += `<path d="${d(raw)}" fill="none" stroke="#EF4444" stroke-width="6" stroke-dasharray="14 10" opacity="0.9"/>`;
      if (res) {
        svg += `<path d="${d(res.points)}" fill="none" stroke="#22C55E" stroke-width="7"/>`;
        const a = res.points[0], b = res.points[res.points.length - 1];
        svg += `<circle cx="${a.x}" cy="${a.y}" r="14" fill="#22C55E"/>`;
        svg += `<circle cx="${b.x}" cy="${b.y}" r="10" fill="none" stroke="#22C55E" stroke-width="5"/>`;
      }
    }
    svg += `</g>\n`;
  });
  svg += '</svg>\n';
  const out = path.join(ROOT, 'refine-preview.svg');
  fs.writeFileSync(out, svg);
  console.log('Wrote', out, '(red dashed = your hand-drawn guide, green = auto-refined)');
}
