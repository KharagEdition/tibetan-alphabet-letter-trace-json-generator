#!/usr/bin/env node
/* Automatic stroke extraction for every Tibetan letter in letters.json.

     node generate-strokes.cjs             # write letters.json / letters.js
     node generate-strokes.cjs --dry-run   # report only
     node generate-strokes.cjs --preview   # also write strokes-preview.svg
     node generate-strokes.cjs --only ka,kha

   Pipeline per letter (the "skeleton" algorithm):
     1. rasterize the glyph outline (nonzero fill) at viewBox resolution
     2. exact Euclidean distance transform -> local ink radius everywhere
     3. Guo-Hall thinning -> 1px-wide skeleton
     4. build a graph: endpoints/junctions are nodes, branches are edges
     5. prune spurs shorter than the local ink radius (serif/flare noise)
     6. merge branches that continue smoothly through junctions into
        single calligraphic strokes
     7. extend stroke tips toward the true limb ends
     8. smooth (Douglas-Peucker + Chaikin), collapse straight limbs
     9. measure per-point ink radius from the distance field
    10. order and orient strokes by Tibetan writing rules:
        head bar first (left->right), then left->right, top->bottom
*/
'use strict';

const fs = require('fs');
const path = require('path');
const SR = require('./refine.js');

const ROOT = __dirname;
const DRY = process.argv.includes('--dry-run');
const PREVIEW = process.argv.includes('--preview');
const onlyArg = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null;
})();

const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'letters.json'), 'utf8'));
const VB = doc.viewBox || 1000;

/* ───────────────────────── thinning (Guo–Hall) ───────────────────────── */

function thinGuoHall(maskObj) {
  const { w, h } = maskObj;
  const img = Uint8Array.from(maskObj.data);
  const toDel = [];
  let changed = true;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : img[y * w + x];
  while (changed) {
    changed = false;
    for (let iter = 0; iter < 2; iter++) {
      toDel.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!img[y * w + x]) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y),
                p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1),
                p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const C = ((~p2 & (p3 | p4)) & 1) + ((~p4 & (p5 | p6)) & 1) +
                    ((~p6 & (p7 | p8)) & 1) + ((~p8 & (p9 | p2)) & 1);
          const N1 = (p9 | p2) + (p3 | p4) + (p5 | p6) + (p7 | p8);
          const N2 = (p2 | p3) + (p4 | p5) + (p6 | p7) + (p8 | p9);
          const N = Math.min(N1, N2);
          const m = iter === 0 ? ((p6 | p7 | (~p9 & 1)) & p8) : ((p2 | p3 | (~p5 & 1)) & p4);
          if (C === 1 && N >= 2 && N <= 3 && m === 0) toDel.push(y * w + x);
        }
      }
      if (toDel.length) {
        changed = true;
        for (const i of toDel) img[i] = 0;
      }
    }
  }
  return { data: img, w, h };
}

/* ───────────────────────── skeleton graph ───────────────────────── */

const NB8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function skeletonGraph(skel, D) {
  const { data, w, h } = skel;
  const deg = new Uint8Array(w * h);
  const pixels = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!data[i]) continue;
      pixels.push(i);
      let d = 0;
      for (const [dx, dy] of NB8) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && data[ny * w + nx]) d++;
      }
      deg[i] = d;
    }
  }

  // node pixels: endpoints (deg 1) and junctions (deg >= 3).
  // Adjacent junction pixels merge into one node cluster.
  const nodeId = new Int32Array(w * h).fill(-1);
  const nodes = []; // {x, y, pixels:[]}
  for (const i of pixels) {
    if (deg[i] === 2 || nodeId[i] !== -1) continue;
    if (deg[i] === 1) {
      nodeId[i] = nodes.length;
      nodes.push({ x: i % w, y: (i / w) | 0, pixels: [i] });
      continue;
    }
    // flood-fill the junction cluster (deg >= 3 pixels touching each other)
    const id = nodes.length;
    const cluster = [i];
    nodeId[i] = id;
    for (let q = 0; q < cluster.length; q++) {
      const c = cluster[q], cx = c % w, cy = (c / w) | 0;
      for (const [dx, dy] of NB8) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (data[n] && deg[n] >= 3 && nodeId[n] === -1) { nodeId[n] = id; cluster.push(n); }
      }
    }
    let sx = 0, sy = 0;
    for (const c of cluster) { sx += c % w; sy += (c / w) | 0; }
    nodes.push({ x: sx / cluster.length, y: sy / cluster.length, pixels: cluster });
  }

  // trace edges: from each node pixel walk through deg-2 pixels
  const visited = new Uint8Array(w * h);
  const edges = []; // {a, b, pts:[{x,y}]}
  const walk = (startPix, firstPix) => {
    const pts = [{ x: startPix % w, y: (startPix / w) | 0 }];
    let prev = startPix, cur = firstPix;
    while (true) {
      pts.push({ x: cur % w, y: (cur / w) | 0 });
      if (nodeId[cur] !== -1) return { end: cur, pts };
      visited[cur] = 1;
      const cx = cur % w, cy = (cur / w) | 0;
      let next = -1;
      for (const [dx, dy] of NB8) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (data[n] && n !== prev && (nodeId[n] !== -1 || !visited[n])) { next = n; break; }
      }
      if (next === -1) return { end: cur, pts }; // dead end (shouldn't happen)
      prev = cur; cur = next;
    }
  };

  const edgeSeen = new Set();
  for (const node of nodes) {
    for (const p of node.pixels) {
      const px = p % w, py = (p / w) | 0;
      for (const [dx, dy] of NB8) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!data[n]) continue;
        if (nodeId[n] !== -1) {
          // direct node-to-node contact between different clusters
          if (nodeId[n] !== nodeId[p]) {
            const key = Math.min(p, n) + ':' + Math.max(p, n);
            if (!edgeSeen.has(key)) {
              edgeSeen.add(key);
              edges.push({ a: nodeId[p], b: nodeId[n], pts: [{ x: px, y: py }, { x: nx, y: ny }] });
            }
          }
          continue;
        }
        if (visited[n]) continue;
        const { end, pts } = walk(p, n);
        edges.push({ a: nodeId[p], b: nodeId[end] !== -1 ? nodeId[end] : -1, pts });
      }
    }
  }
  // pure cycles (rings with no junction): remaining unvisited deg-2 pixels
  for (const i of pixels) {
    if (deg[i] !== 2 || visited[i] || nodeId[i] !== -1) continue;
    // break the ring at this pixel: make it a temp node and walk around
    const px = i % w, py = (i / w) | 0;
    visited[i] = 1;
    let firstNb = -1;
    for (const [dx, dy] of NB8) {
      const nx = px + dx, ny = py + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && data[ny * w + nx] && !visited[ny * w + nx]) { firstNb = ny * w + nx; break; }
    }
    if (firstNb === -1) continue;
    const { pts } = walk(i, firstNb);
    pts.push({ x: px, y: py }); // close the ring
    edges.push({ a: -1, b: -1, pts, ring: true });
  }
  return { nodes, edges };
}

/* ─────────────────────── spur pruning ─────────────────────── */

function edgeLen(e) { return SR.pathLen(e.pts); }

function pruneSpurs(graph, D, w) {
  // iteratively drop endpoint branches shorter than the ink radius at the
  // junction they hang off (thinning artifacts at serifs and flares)
  let removed = true;
  while (removed) {
    removed = false;
    const degree = new Map();
    for (const e of graph.edges) {
      degree.set(e.a, (degree.get(e.a) || 0) + 1);
      degree.set(e.b, (degree.get(e.b) || 0) + 1);
    }
    for (let i = graph.edges.length - 1; i >= 0; i--) {
      const e = graph.edges[i];
      if (e.ring) continue;
      const aFree = degree.get(e.a) === 1, bFree = degree.get(e.b) === 1;
      if (aFree === bFree) continue; // keep isolated segments and bridges
      const juncEnd = aFree ? e.pts[e.pts.length - 1] : e.pts[0];
      const r = D[Math.round(juncEnd.y) * w + Math.round(juncEnd.x)] || 0;
      const thr = Math.max(1.35 * r, 14);
      if (edgeLen(e) < thr) {
        graph.edges.splice(i, 1);
        removed = true;
      }
    }
    if (removed) healDegreeTwoNodes(graph);
  }
}

/* after pruning, a junction may drop to degree 2 -> weld its two edges */
function healDegreeTwoNodes(graph) {
  let merged = true;
  while (merged) {
    merged = false;
    const incident = new Map();
    graph.edges.forEach((e, i) => {
      if (e.ring) return;
      if (!incident.has(e.a)) incident.set(e.a, []);
      if (!incident.has(e.b)) incident.set(e.b, []);
      incident.get(e.a).push(i);
      incident.get(e.b).push(i);
    });
    for (const [node, list] of incident) {
      if (node === -1 || list.length !== 2 || list[0] === list[1]) continue;
      const [i1, i2] = list;
      const e1 = graph.edges[i1], e2 = graph.edges[i2];
      const p1 = e1.a === node ? e1.pts.slice().reverse() : e1.pts.slice();
      const n1 = e1.a === node ? e1.b : e1.a;
      const p2 = e2.a === node ? e2.pts.slice() : e2.pts.slice().reverse();
      const n2 = e2.a === node ? e2.b : e2.b === node ? e2.a : e2.a;
      const weldedE = { a: n1, b: n2, pts: p1.concat(p2.slice(1)) };
      graph.edges = graph.edges.filter((_, i) => i !== i1 && i !== i2);
      graph.edges.push(weldedE);
      merged = true;
      break;
    }
  }
}

/* ───────────── merge branches into calligraphic strokes ───────────── */

function endTangent(pts, atStart, span) {
  // direction pointing AWAY from the end, into the polyline
  const n = pts.length;
  const a = atStart ? pts[0] : pts[n - 1];
  let b = atStart ? pts[Math.min(n - 1, span)] : pts[Math.max(0, n - 1 - span)];
  let dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  return { x: dx / L, y: dy / L };
}

/* Head-bar extraction: Tibetan letters usually carry a thick horizontal
   head line. Skeleton branches inside the top band are welded into ONE
   left-to-right stroke (the longest path through their subgraph), and are
   never merged with descenders hanging off the bar. */
/* An edge that starts as the head bar and bends smoothly into a descender
   has no junction at the bend. Cut such edges where they leave the top
   band, so the horizontal part can join the bar and the rest stays a
   separate stroke. */
let cutNodeSeq = -1000;
function cutAtBand(edges, bandY) {
  const out = [];
  for (const e of edges) {
    if (e.ring) { out.push(e); continue; }
    const pts = SR.resampleStep(e.pts, 4);
    // maximal run of in-band points at either end of the edge
    let headEnd = 0;
    while (headEnd < pts.length && pts[headEnd].y < bandY) headEnd++;
    let tailStart = pts.length - 1;
    while (tailStart >= 0 && pts[tailStart].y < bandY) tailStart--;
    tailStart++;

    const runQualifies = (i0, i1) => { // [i0, i1)
      if (i1 - i0 < 3) return false;
      const seg = pts.slice(i0, i1);
      const len = SR.pathLen(seg);
      const dx = Math.abs(seg[seg.length - 1].x - seg[0].x);
      const dy = Math.abs(seg[seg.length - 1].y - seg[0].y);
      return len >= 60 && dx > 1.8 * Math.max(1, dy);
    };

    const cuts = [];
    if (headEnd > 0 && headEnd < pts.length && runQualifies(0, headEnd)) cuts.push(headEnd - 1);
    if (tailStart > 0 && tailStart < pts.length && runQualifies(tailStart, pts.length) &&
        !cuts.includes(tailStart)) cuts.push(tailStart);

    if (!cuts.length) { out.push(e); continue; }
    cuts.sort((a, b) => a - b);
    let prev = 0, prevNode = e.a;
    for (const ci of cuts) {
      if (ci <= prev || ci >= pts.length - 1) continue;
      const node = cutNodeSeq--;
      out.push({ a: prevNode, b: node, pts: pts.slice(prev, ci + 1) });
      prev = ci; prevNode = node;
    }
    out.push({ a: prevNode, b: e.b, pts: pts.slice(prev) });
  }
  return out;
}

function extractHeadBar(edges, bbox) {
  const H = bbox.maxY - bbox.minY, W = bbox.maxX - bbox.minX;
  const bandY = bbox.minY + 0.22 * H;
  const isBarEdge = e => {
    if (e.ring) return false;
    let inBand = 0;
    for (const p of e.pts) if (p.y < bandY) inBand++;
    return inBand / e.pts.length > 0.60;
  };
  const barIdx = [], rest = [];
  edges.forEach((e, i) => (isBarEdge(e) ? barIdx : rest).push(i));
  if (process.env.DEBUG_BAR) {
    edges.forEach((e, i) => {
      const inB = e.pts.filter(p => p.y < bandY).length / e.pts.length;
      const meanY = e.pts.reduce((a, p) => a + p.y, 0) / e.pts.length;
      console.log(`    edge#${i} a=${e.a} b=${e.b} len=${edgeLen(e).toFixed(0)} inBand=${inB.toFixed(2)} meanY=${meanY.toFixed(0)} bandY=${bandY.toFixed(0)} ${isBarEdge(e) ? 'BAR' : ''}`);
    });
  }
  if (!barIdx.length) return { bars: [], restIdx: rest };

  // connected components of the bar subgraph (by shared node id)
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const i of barIdx) { parent.set('e' + i, 'e' + i); }
  const nodeOwner = new Map();
  for (const i of barIdx) {
    for (const nid of [edges[i].a, edges[i].b]) {
      if (nid === -1) continue;
      if (nodeOwner.has(nid)) uni('e' + i, nodeOwner.get(nid));
      else nodeOwner.set(nid, 'e' + i);
    }
  }
  const comps = new Map();
  for (const i of barIdx) {
    const r = find('e' + i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(i);
  }

  const restIdx = rest.slice();

  // one spine per component, oriented left->right
  const spines = [];
  for (const [, comp] of comps) {
    const pts = longestPathThrough(edges, comp);
    if (pts.length < 2) { restIdx.push(...comp); continue; }
    if (pts[0].x > pts[pts.length - 1].x) pts.reverse();
    spines.push({ pts, comp });
  }
  spines.sort((a, b) => a.pts[0].x - b.pts[0].x);

  // The bar's medial axis breaks where a wide descender joins it (the
  // skeleton dives into the junction wedge). Bridge x-adjacent spines
  // back into one full-width bar.
  // a spine's facing end often dives into the junction wedge; trim that
  // dip before testing alignment (the dip is an artifact, not bar path)
  const trimDip = (pts, fromEnd) => {
    const inBand = pts.filter(p => p.y < bandY);
    const ys = (inBand.length >= 3 ? inBand : pts).map(p => p.y).sort((a, b) => a - b);
    const barLevel = ys[ys.length >> 1];
    const out = pts.slice();
    let trimmed = 0;
    while (out.length > 2 && trimmed < 140) {
      const p = fromEnd ? out[out.length - 1] : out[0];
      if (p.y - barLevel <= 45) break;
      const q = fromEnd ? out[out.length - 2] : out[1];
      trimmed += Math.hypot(p.x - q.x, p.y - q.y);
      if (fromEnd) out.pop(); else out.shift();
    }
    return out;
  };

  const bridged = [];
  for (const s of spines) {
    const prev = bridged[bridged.length - 1];
    if (prev) {
      const a = trimDip(prev.pts, true), b = trimDip(s.pts, false);
      const pe = a[a.length - 1], ss = b[0];
      const gap = ss.x - pe.x;
      if (gap > -60 && gap < 0.25 * W && Math.abs(ss.y - pe.y) < 90) {
        prev.pts = a.concat(b);
        prev.comp = prev.comp.concat(s.comp);
        continue;
      }
    }
    bridged.push({ pts: s.pts.slice(), comp: s.comp.slice() });
  }

  const bars = [];
  for (const b of bridged) {
    const xs = b.pts.map(p => p.x);
    const span = Math.max(...xs) - Math.min(...xs);
    if (span < 0.30 * W) { restIdx.push(...b.comp); continue; } // not a real bar
    bars.push(b.pts);
  }
  return { bars, restIdx };
}

/* longest simple path (by arc length) through a small edge subgraph */
function longestPathThrough(edges, compIdx) {
  const adj = new Map(); // nodeId -> [{ei, other, fromA}]
  const addAdj = (n, rec) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push(rec); };
  for (const ei of compIdx) {
    const e = edges[ei];
    addAdj(e.a, { ei, other: e.b, fromA: true });
    addAdj(e.b, { ei, other: e.a, fromA: false });
  }
  let best = { len: -1, path: [] };
  const dfs = (node, usedEdges, len, path) => {
    if (len > best.len) best = { len, path: path.slice() };
    for (const rec of adj.get(node) || []) {
      if (usedEdges.has(rec.ei)) continue;
      usedEdges.add(rec.ei);
      path.push(rec);
      dfs(rec.other, usedEdges, len + edgeLen(edges[rec.ei]), path);
      path.pop();
      usedEdges.delete(rec.ei);
    }
  };
  for (const node of adj.keys()) dfs(node, new Set(), 0, []);
  let pts = [];
  for (const rec of best.path) {
    const oriented = rec.fromA ? edges[rec.ei].pts : edges[rec.ei].pts.slice().reverse();
    pts = pts.length ? pts.concat(oriented.slice(1)) : oriented.slice();
  }
  if (!pts.length && compIdx.length) pts = edges[compIdx[0]].pts.slice();
  return pts;
}

function mergeIntoStrokes(graph, bbox) {
  // Pair up edges that continue smoothly through each junction; chains of
  // paired edges become single strokes. The head bar is handled first and
  // kept apart so a descender never fuses with it.
  const H = bbox.maxY - bbox.minY;
  const all = cutAtBand(graph.edges.filter(e => !e.ring), bbox.minY + 0.22 * H);
  const rings = graph.edges.filter(e => e.ring);
  const { bars, restIdx } = extractHeadBar(all, bbox);
  const edges = restIdx.map(i => all[i]);
  const SPAN = 12;
  const partner = edges.map(() => ({ a: -1, b: -1 })); // partner edge index per end

  const incident = new Map(); // node -> [{ei, end:'a'|'b'}]
  edges.forEach((e, i) => {
    if (e.a !== -1) { if (!incident.has(e.a)) incident.set(e.a, []); incident.get(e.a).push({ ei: i, end: 'a' }); }
    if (e.b !== -1) { if (!incident.has(e.b)) incident.set(e.b, []); incident.get(e.b).push({ ei: i, end: 'b' }); }
  });

  for (const [, list] of incident) {
    if (list.length < 2) continue;
    // tangent of each incident end, pointing away from the junction
    const tans = list.map(({ ei, end }) => endTangent(edges[ei].pts, end === 'a', SPAN));
    // greedy best-pair matching: angle between tangents closest to PI
    const cand = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].ei === list[j].ei) continue; // don't pair an edge with itself
        const dot = tans[i].x * tans[j].x + tans[i].y * tans[j].y;
        cand.push({ i, j, dot });
      }
    }
    cand.sort((p, q) => p.dot - q.dot); // most opposite first (dot ~ -1)
    const used = new Set();
    for (const { i, j, dot } of cand) {
      if (used.has(i) || used.has(j)) continue;
      // long limbs only continue through near-straight junctions; short
      // fragments may chain through moderate corners (tracing apps let a
      // stroke turn a corner rather than splinter into pieces)
      const minLen = Math.min(edgeLen(edges[list[i].ei]), edgeLen(edges[list[j].ei]));
      const thr = minLen < 170 ? -0.12 : -0.45;
      if (dot > thr) continue;
      used.add(i); used.add(j);
      partner[list[i].ei][list[i].end] = list[j].ei;
      partner[list[j].ei][list[j].end] = list[i].ei;
    }
  }

  // walk chains
  const consumed = edges.map(() => false);
  const strokes = [];
  for (let i = 0; i < edges.length; i++) {
    if (consumed[i]) continue;
    // find chain start: walk backwards from edge i via 'a' partners
    let cur = i, fromEnd = 'a', guard = edges.length + 2;
    while (partner[cur][fromEnd] !== -1 && guard-- > 0) {
      const prev = partner[cur][fromEnd];
      if (consumed[prev] || prev === i && guard < edges.length) break; // cycle guard
      // continue backward: enter prev at whichever of its ends points at cur
      const enterEnd = partner[prev].a === cur ? 'a' : 'b';
      cur = prev;
      fromEnd = enterEnd === 'a' ? 'b' : 'a';
      if (cur === i) break; // closed cycle of edges
    }
    // now walk forward from cur, starting at end `fromEnd`
    let pts = [];
    let walkEdge = cur, entry = fromEnd;
    guard = edges.length + 2;
    while (walkEdge !== -1 && !consumed[walkEdge] && guard-- > 0) {
      consumed[walkEdge] = true;
      const e = edges[walkEdge];
      const oriented = entry === 'a' ? e.pts : e.pts.slice().reverse();
      pts = pts.length ? pts.concat(oriented.slice(1)) : oriented.slice();
      const exitEnd = entry === 'a' ? 'b' : 'a';
      const nxt = partner[walkEdge][exitEnd];
      if (nxt === -1 || consumed[nxt]) break;
      entry = partner[nxt].a === walkEdge ? 'a' : 'b';
      walkEdge = nxt;
    }
    strokes.push(pts);
  }
  for (const r of rings) strokes.push(r.pts);
  return bars.concat(strokes);
}

/* ─────────────────── smoothing / tip extension / width ─────────────────── */

function douglasPeucker(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const A = pts[s], B = pts[e];
    const dx = B.x - A.x, dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const t = L2 ? Math.max(0, Math.min(1, ((pts[i].x - A.x) * dx + (pts[i].y - A.y) * dy) / L2)) : 0;
      const px = A.x + t * dx, py = A.y + t * dy;
      const d = Math.hypot(pts[i].x - px, pts[i].y - py);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps) { keep[maxI] = 1; stack.push([s, maxI], [maxI, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function chaikin(pts, iters, closed) {
  let out = pts;
  for (let k = 0; k < iters; k++) {
    const next = [];
    if (!closed) next.push(out[0]);
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    if (!closed) next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

function extendTip(pts, atStart, field) {
  // skeleton endpoints stop ~one ink-radius short of the limb tip;
  // march along the end tangent while still comfortably inside the glyph
  const dir = endTangent(pts, atStart, 10);
  const end = atStart ? pts[0] : pts[pts.length - 1];
  const r0 = field.dist(end.x, end.y);
  const maxExt = r0 * 1.6;
  let px = end.x, py = end.y, ext = 0;
  const step = 2;
  while (ext + step <= maxExt) {
    const nx = px - dir.x * step, ny = py - dir.y * step; // dir points inward
    if (field.dist(nx, ny) < 2.2) break;
    px = nx; py = ny; ext += step;
  }
  if (ext < 2) return pts;
  const p = { x: px, y: py };
  return atStart ? [p].concat(pts) : pts.concat([p]);
}

function smoothStroke(rawPts, field) {
  const closed = rawPts.length > 3 &&
    Math.hypot(rawPts[0].x - rawPts[rawPts.length - 1].x, rawPts[0].y - rawPts[rawPts.length - 1].y) < 3;
  let pts = SR.resampleStep(rawPts, 5);
  pts = douglasPeucker(pts, 2.6);
  pts = chaikin(pts, 3, false);
  pts = SR.resampleStep(pts, 10);
  if (!closed) {
    pts = extendTip(pts, true, field);
    pts = extendTip(pts, false, field);
  }
  // collapse to an exact straight segment when the limb is straight
  if (!closed && pts.length > 2) {
    const A = pts[0], B = pts[pts.length - 1];
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
    let maxD = 0;
    for (const p of pts) {
      const t = L2 ? ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2 : 0;
      const d = Math.hypot(p.x - (A.x + t * dx), p.y - (A.y + t * dy));
      if (d > maxD) maxD = d;
    }
    const medR = medianRadius(pts, field);
    if (maxD < Math.max(3, medR * 0.22)) pts = [A, B];
  }
  return SR.resampleStep(pts, 14);
}

function medianRadius(pts, field) {
  const rs = pts.map(p => field.dist(p.x, p.y)).sort((a, b) => a - b);
  return rs[rs.length >> 1] || 0;
}

/* ─────────────────── root stroke ends into neighbors ───────────────────
   A body stroke should START on the head bar (the pen begins on the head
   line and pulls down). When a stroke end stops short of another stroke's
   corridor — a visible notch at the junction — extend it along its own
   direction through the ink until it lands inside the neighbor. Genuine
   letter tips are unaffected: if the extension exits the ink before
   reaching a neighbor, it is discarded. */
function rootStrokesIntoNeighbors(strokes, field) {
  const dense = strokes.map(pts => SR.resampleStep(pts, 6));
  const insideOther = (p, self) => {
    for (let k = 0; k < dense.length; k++) {
      if (k === self) continue;
      for (const q of dense[k]) {
        const r = Math.max(4, field.dist(q.x, q.y));
        if (Math.hypot(p.x - q.x, p.y - q.y) < r * 0.9) return true;
      }
    }
    return false;
  };
  return strokes.map((pts, si) => {
    if (pts.length < 2) return pts;
    let out = pts;
    for (const atStart of [true, false]) {
      const end = atStart ? out[0] : out[out.length - 1];
      if (insideOther(end, si)) continue;             // already rooted
      const dir = endTangent(out, atStart, 10);       // points inward
      const ext = [];
      let px = end.x, py = end.y, landed = false;
      for (let step = 0; step < 30; step++) {
        px -= dir.x * 4; py -= dir.y * 4;
        if (field.dist(px, py) < 2.5) break;          // left the ink: real tip
        ext.push({ x: px, y: py });
        if (insideOther({ x: px, y: py }, si)) { landed = true; break; }
      }
      if (landed && ext.length) {
        out = atStart ? ext.slice().reverse().concat(out) : out.concat(ext);
      }
    }
    return out;
  });
}

/* ─────────────────── ordering / orientation (Tibetan rules) ─────────────────── */

function orientAndOrder(strokes, field, bbox) {
  const infos = strokes.map(pts => {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    const horizontal = w > h * 1.6;
    const nearTop = minY < bbox.minY + (bbox.maxY - bbox.minY) * 0.22;
    const isHead = horizontal && nearTop && w > (bbox.maxX - bbox.minX) * 0.34;
    return { pts, minX, maxX, minY, maxY, horizontal, isHead };
  });

  for (const s of infos) {
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    let flip;
    if (s.horizontal) flip = a.x > b.x;            // horizontals: left -> right
    else if (Math.abs(a.y - b.y) > 4) flip = a.y > b.y; // otherwise: top -> bottom
    else flip = a.x > b.x;
    if (flip) s.pts.reverse();
  }

  const bandH = (bbox.maxY - bbox.minY) * 0.30;
  infos.sort((p, q) => {
    if (p.isHead !== q.isHead) return p.isHead ? -1 : 1;   // head bar first
    const pb = Math.floor((p.pts[0].y - bbox.minY) / bandH);
    const qb = Math.floor((q.pts[0].y - bbox.minY) / bandH);
    if (pb !== qb) return pb - qb;                         // top -> bottom bands
    return p.pts[0].x - q.pts[0].x;                        // then left -> right
  });
  return infos.map(s => s.pts);
}

/* Drop short strokes whose ink corridor is already painted by the other
   strokes (skeleton artifacts at thick wedges / flares). */
function dropRedundantShort(strokes, field, mask) {
  const stampArea = pts => {
    const { w, h } = mask;
    const painted = new Set();
    for (const p of SR.resampleStep(pts, 3)) {
      const r = Math.max(4, field.dist(p.x, p.y)) * 1.6 + 2;
      const R = Math.ceil(r);
      for (let dy = -R; dy <= R; dy++) {
        const yy = Math.round(p.y) + dy;
        if (yy < 0 || yy >= h) continue;
        const half = Math.floor(Math.sqrt(R * R - dy * dy));
        for (let xx = Math.max(0, Math.round(p.x) - half); xx <= Math.min(w - 1, Math.round(p.x) + half); xx++) {
          if (mask.data[yy * w + xx]) painted.add(yy * w + xx);
        }
      }
    }
    return painted;
  };
  const keep = strokes.slice();
  let changed = true;
  while (changed) {
    changed = false;
    const short = keep
      .map((pts, i) => ({ pts, i, len: SR.pathLen(pts) }))
      .filter(s => s.len < 190)
      .sort((a, b) => a.len - b.len);
    for (const s of short) {
      const others = keep.filter((_, j) => j !== s.i);
      if (!others.length) break;
      const mine = stampArea(s.pts);
      const rest = new Set();
      for (const o of others) for (const px of stampArea(o)) rest.add(px);
      let uncovered = 0;
      for (const px of mine) if (!rest.has(px)) uncovered++;
      if (process.env.DEBUG_STUBS) {
        console.log(`    stub? len=${s.len.toFixed(0)} inkArea=${mine.size} uncoveredFrac=${(uncovered / Math.max(1, mine.size)).toFixed(3)}`);
      }
      if (uncovered / Math.max(1, mine.size) < 0.30) {
        keep.splice(s.i, 1);
        changed = true;
        break;
      }
    }
  }
  return keep;
}

/* ─────────────────── coverage QA ─────────────────── */

function coverage(mask, strokes, radii) {
  const { w, h, data } = mask;
  const painted = new Uint8Array(w * h);
  const stamp = (x, y, r) => {
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) {
      const yy = Math.round(y) + dy;
      if (yy < 0 || yy >= h) continue;
      const half = Math.floor(Math.sqrt(R * R - dy * dy));
      const x0 = Math.max(0, Math.round(x) - half), x1 = Math.min(w - 1, Math.round(x) + half);
      for (let xx = x0; xx <= x1; xx++) painted[yy * w + xx] = 1;
    }
  };
  strokes.forEach((pts, si) => {
    const dense = SR.resampleStep(pts, 3);
    const rs = radii[si];
    const L = SR.pathLen(pts);
    let acc = 0;
    dense.forEach((p, i) => {
      if (i > 0) acc += Math.hypot(p.x - dense[i - 1].x, p.y - dense[i - 1].y);
      const t = L ? acc / L : 0;
      const idx = Math.min(rs.length - 1, Math.round(t * (rs.length - 1)));
      stamp(p.x, p.y, rs[idx] * 1.75 + 2);
    });
  });
  let ink = 0, hit = 0;
  for (let i = 0; i < w * h; i++) { if (data[i]) { ink++; if (painted[i]) hit++; } }
  return { ink, hit, pct: ink ? (100 * hit / ink) : 100 };
}

/* ─────────────────────────── main ─────────────────────────── */

const previews = [];
const round1 = v => Math.round(v * 10) / 10;

for (const L of doc.letters || []) {
  if (!L.outline) continue;
  if (onlyArg && !onlyArg.has(L.id)) continue;

  const t0 = Date.now();
  const polys = SR.parsePathPolygons(L.outline, 32);
  const mask = SR.rasterizePolygons(polys, VB, VB, 'nonzero');
  const field = SR.makeField(mask);
  const D = field.D ? null : null; // field.dist used directly
  const Draw = SR.edt(mask);

  const skel = thinGuoHall(mask);
  const graph = skeletonGraph(skel, Draw);
  pruneSpurs(graph, Draw, VB);
  healDegreeTwoNodes(graph);

  const xsAll = polys.flat().map(p => p.x), ysAll = polys.flat().map(p => p.y);
  const bboxEarly = { minX: Math.min(...xsAll), maxX: Math.max(...xsAll), minY: Math.min(...ysAll), maxY: Math.max(...ysAll) };
  let strokes = mergeIntoStrokes(graph, bboxEarly)
    .filter(pts => SR.pathLen(pts) > 30);
  strokes = strokes.map(pts => smoothStroke(pts, field));
  strokes = strokes.filter(pts => SR.pathLen(pts) > 24);
  strokes = dropRedundantShort(strokes, field, mask);

  strokes = orientAndOrder(strokes, field, bboxEarly);
  strokes = rootStrokesIntoNeighbors(strokes, field).map(pts => SR.resampleStep(pts, 14));

  const radii = strokes.map(pts => pts.map(p => round1(Math.max(4, field.dist(p.x, p.y)))));
  const cov = coverage(mask, strokes, radii);

  L.strokes = strokes.map((pts, i) => ({
    points: pts.map(p => [round1(p.x), round1(p.y)]),
    radii: radii[i],
    width: round1(2 * radii[i].slice().sort((a, b) => a - b)[radii[i].length >> 1])
  }));
  L.available = true;

  console.log(
    `${L.glyph} (${L.id})  strokes: ${strokes.length}  ` +
    `coverage: ${cov.pct.toFixed(1)}%  (${Date.now() - t0}ms)` +
    (cov.pct < 94 ? '  ⚠ LOW COVERAGE' : '')
  );
  previews.push({ L, strokes });
}

if (!DRY) {
  const json = JSON.stringify(doc, null, 1);
  fs.writeFileSync(path.join(ROOT, 'letters.json'), json + '\n');
  fs.writeFileSync(path.join(ROOT, 'letters.js'), 'window.LETTERS_DATA = ' + json + '\n;\n');
  console.log('\nWrote letters.json and letters.js');
}

if (PREVIEW) {
  const cell = 250, pad = 8, cols = 6;
  const rows = Math.ceil(previews.length / cols);
  const sc = cell / VB;
  const colors = ['#22C55E', '#3B82F6', '#F59E0B', '#EF4444', '#A855F7', '#14B8A6', '#EC4899'];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * (cell + pad) + pad}" height="${rows * (cell + pad) + pad}" style="background:#151821">\n`;
  previews.forEach((pv, i) => {
    const ox = pad + (i % cols) * (cell + pad), oy = pad + Math.floor(i / cols) * (cell + pad);
    svg += `<g transform="translate(${ox},${oy}) scale(${sc})">`;
    svg += `<rect x="0" y="0" width="${VB}" height="${VB}" fill="#1D2230"/>`;
    svg += `<path d="${pv.L.outline}" fill="#3A4152"/>`;
    svg += `<text x="30" y="970" font-size="80" font-family="sans-serif" fill="#8B93A7">${pv.L.id}</text>`;
    pv.strokes.forEach((pts, si) => {
      const col = colors[si % colors.length];
      const d = pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
      svg += `<path d="${d}" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round"/>`;
      const a = pts[0], b = pts[pts.length - 1];
      svg += `<circle cx="${a.x}" cy="${a.y}" r="22" fill="${col}"/>`;
      svg += `<text x="${a.x}" y="${a.y + 12}" font-size="34" font-family="sans-serif" fill="#fff" text-anchor="middle" font-weight="bold">${si + 1}</text>`;
      svg += `<circle cx="${b.x}" cy="${b.y}" r="12" fill="none" stroke="${col}" stroke-width="6"/>`;
    });
    svg += `</g>\n`;
  });
  svg += '</svg>\n';
  fs.writeFileSync(path.join(ROOT, 'strokes-preview.svg'), svg);
  console.log('Wrote strokes-preview.svg');
}
