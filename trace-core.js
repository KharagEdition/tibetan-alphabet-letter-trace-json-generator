/* ============================================================
   trace-core.js — shared Tibetan letter-tracing engine.

   Used by index.html (the Studio, editor + live tracer) and
   stroke-trace.html (the standalone tracing game).

   THE REVEAL MODEL (plain brush line → glyph fill at the end)
   -----------------------------------------------------------
   1. WHILE TRACING, the only ink that appears is a smooth round
      brush line following the pen along the guide path. The brush is
      configurable (see BRUSH below) and its width never jumps — a
      self-crossing or junction is painted on every pass, so the line
      is always plain and solid. Nothing else moves: no partial fills,
      no fringes, no seams.
   2. WHEN THE LAST STROKE COMPLETES, the whole glyph fills with a
      smooth ~0.45 s fade — the finished letter is pixel-identical to
      the printed letterform (the ink is always clipped to the glyph
      outline, so its edges come from the font geometry).

   BRUSH (user-configurable via setBrush)
   --------------------------------------
     { mode: 'follow' | 'fixed', widthScale: number }
   - 'follow': the brush tracks the letter's local limb thickness
     (per-point radii from the stroke data).
   - 'fixed':  one constant width per stroke (the stroke's recorded
     width), like a marker pen.
   - widthScale: global multiplier (e.g. 0.5–2) applied on top.
   Documents may carry a top-level "brush" object in letters.json;
   hosts pass it to setBrush so the exported look is reproduced
   everywhere.

   INPUT VALIDATION
   ----------------
   Monotonic arc-length progress: the pointer only matches the guide
   inside a small window ahead of current progress, with a per-event
   advance cap — you must travel the stroke in order, in the right
   direction.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TraceCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VB = 1000;                 // everything works in a 0–1000 box
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;

  const DEFAULT_BRUSH = { mode: 'follow', widthScale: 1 };

  function normalizeBrush(b) {
    const out = { ...DEFAULT_BRUSH };
    if (b && typeof b === 'object') {
      if (b.mode === 'fixed' || b.mode === 'follow') out.mode = b.mode;
      const w = Number(b.widthScale);
      if (isFinite(w) && w > 0) out.widthScale = clamp(w, 0.25, 3);
    }
    return out;
  }

  /* ---------------- data normalization ----------------
     Accept several data shapes and normalize to
     {letters:[{id, glyph, roman, outline?, strokes:[{points:[[x,y]…], radii?, width?}]}]}
     - v2 (generate-strokes.cjs / editor): letters array, [x,y] in 0–1000, outline
     - v1 (legacy recorder): letters object map, {x,y} points in 0–1, no outline */
  function normalizeDoc(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('not a JSON object');
    const srcVB = doc.viewBox || (doc.coordinateSystem === 'normalized-0-1' ? 1 : 1000);
    const k = VB / srcVB;
    let list;
    if (Array.isArray(doc.letters)) {
      list = doc.letters;
    } else if (doc.letters && typeof doc.letters === 'object') {
      list = Object.entries(doc.letters).map(([glyph, L], i) => ({
        id: (L.name || glyph).toLowerCase(),
        glyph,
        roman: L.name || glyph,
        order: L.index != null ? L.index : i + 1,
        outline: L.outline,
        strokes: L.strokes
      }));
    } else throw new Error('no "letters" found');

    const out = [];
    for (const L of list) {
      if (!L || !Array.isArray(L.strokes)) continue;
      const strokes = [];
      for (const s of L.strokes) {
        const raw = s && s.points;
        if (!Array.isArray(raw) || raw.length < 2) continue;
        const points = raw.map(p =>
          Array.isArray(p) ? [p[0] * k, p[1] * k] : [p.x * k, p.y * k]);
        const stroke = { points };
        if (Array.isArray(s.radii)) stroke.radii = s.radii.map(r => r * k);
        stroke.width = (s.width ? s.width * k : 70);
        strokes.push(stroke);
      }
      if (!strokes.length) continue;
      out.push({
        id: L.id || L.glyph || String(out.length),
        glyph: L.glyph || L.id || '?',
        roman: L.roman || L.name || L.id || '',
        order: L.order != null ? L.order : out.length + 1,
        outline: L.outline || null,
        strokes
      });
    }
    if (!out.length) throw new Error('no letters with usable strokes');
    out.sort((a, b) => (a.order || 0) - (b.order || 0));
    return out;
  }

  /* ---------------- stroke geometry ---------------- */
  function buildStroke(raw, brush) {
    brush = brush || DEFAULT_BRUSH;
    // dense resample (~4 vb units) + cumulative length + per-point radius
    const fixedR = (raw.width || 60) / 2;
    const src = raw.points.map((p, i) => ({
      x: p[0], y: p[1],
      r: (brush.mode === 'fixed'
        ? fixedR
        : (raw.radii ? raw.radii[Math.min(i, raw.radii.length - 1)] : fixedR)
      ) * brush.widthScale
    }));
    if (src.length === 1) src.push({ ...src[0], x: src[0].x + 1 });
    const pts = [];
    for (let i = 0; i < src.length - 1; i++) {
      const a = src[i], b = src[i + 1];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.round(d / 4));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        pts.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), r: lerp(a.r, b.r, t) });
      }
    }
    pts.push({ ...src[src.length - 1] });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const width = raw.width || 60;
    return { pts, cum, len: cum[cum.length - 1], width };
  }

  function pointAt(st, s) {
    s = clamp(s, 0, st.len);
    let lo = 0, hi = st.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (st.cum[mid] < s) lo = mid + 1; else hi = mid; }
    const i = Math.max(1, lo);
    const t = (s - st.cum[i - 1]) / Math.max(1e-6, st.cum[i] - st.cum[i - 1]);
    const a = st.pts[i - 1], b = st.pts[i];
    return {
      x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), r: lerp(a.r, b.r, t),
      dx: b.x - a.x, dy: b.y - a.y
    };
  }

  /* nearest arc position to p inside [s0, s1]; returns {s, dist} */
  function locate(st, p, s0, s1) {
    let best = { s: -1, dist: Infinity };
    const n = st.pts.length;
    for (let i = 1; i < n; i++) {
      if (st.cum[i] < s0) continue;
      if (st.cum[i - 1] > s1) break;
      const a = st.pts[i - 1], b = st.pts[i];
      const vx = b.x - a.x, vy = b.y - a.y;
      const L2 = vx * vx + vy * vy;
      let t = L2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2 : 0;
      t = clamp(t, 0, 1);
      const qx = a.x + t * vx, qy = a.y + t * vy;
      const d = Math.hypot(p.x - qx, p.y - qy);
      if (d < best.dist) best = { s: st.cum[i - 1] + t * Math.sqrt(L2), dist: d };
    }
    return best;
  }

  /* ---------------- tuning (vb units) ---------------- */
  const CFG = {
    brushScale: 1.3,       // painted brush radius = configured radius × this
    tolScale: 2.1,         // finger tolerance = local radius × this
    tolMin: 42,
    startTolScale: 2.6,    // touch-down tolerance around stroke start / tip
    aheadWindow: 90,       // how far ahead of progress we search
    backWindow: 55,        // small backward window (jitter forgiveness)
    advancePerMove: 2.6,   // max progress per event ≈ finger distance × this
    advanceFloor: 14,
    endTolScale: 1.6,      // stroke counts as finished this close to the end
    endTolMin: 34,
    fillMs: 450,           // whole-glyph fill animation on letter completion
    snapMs: 160,
    hintIdleMs: 3200,
    offPathMs: 420,
    demoSpeed: 9
  };

  /* ---------------- audio (tiny synth, no assets) ---------------- */
  let AC = null;
  function beep(freq, dur, type = 'sine', gain = .12, when = 0) {
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === 'suspended') AC.resume();
      const o = AC.createOscillator(), gn = AC.createGain();
      o.type = type; o.frequency.value = freq;
      gn.gain.setValueAtTime(gain, AC.currentTime + when);
      gn.gain.exponentialRampToValueAtTime(.0001, AC.currentTime + when + dur);
      o.connect(gn).connect(AC.destination);
      o.start(AC.currentTime + when); o.stop(AC.currentTime + when + dur + .05);
    } catch (e) { /* audio unavailable */ }
  }

  /* ================================================================
     TraceEngine — attach to a <canvas>, feed it letters, it does the
     rest: ghost, guides, brush reveal, validation, demo, feedback.
     ================================================================ */
  class TraceEngine {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign({
        sfx: true,
        haptics: true,
        ghost: '#2A3450',
        accent: '#4F8DFD',
        inkFrom: '#60A5FA',
        inkTo: '#2E6BE6',
        guide: 'rgba(234,240,250,.5)',
        onStrokeChange: null,   // (strokeIndex, strokeCount, finished)
        onComplete: null        // (letter)
      }, opts);

      this.DPR = 1; this.CSS = 480;
      this.brush = { ...DEFAULT_BRUSH };
      this.letter = null;
      this.glyphPath = null;
      this.strokes = [];
      this.si = 0;
      this.progress = 0;
      this.finished = false;
      this.fillAnim = null;            // {start} whole-glyph fill on completion
      this.tracing = false;
      this.lastInput = (typeof performance !== 'undefined' ? performance.now() : 0);
      this.offPathSince = 0;
      this.hintT = 0;
      this.snapAnim = null;
      this.demoAnim = null;
      this.particles = [];
      this.lastP = null;
      this._destroyed = false;

      /* brush reveal layer */
      this.reveal = document.createElement('canvas');
      this.rctx = this.reveal.getContext('2d');
      this.revealed = [];

      this.inkCanvas = null; this.inkCtx = null;

      this._onDown = e => this._pointerDown(e);
      this._onMove = e => this._pointerMove(e);
      this._onUp = () => { this.tracing = false; this.offPathSince = 0; this.lastP = null; };
      canvas.addEventListener('pointerdown', this._onDown);
      canvas.addEventListener('pointermove', this._onMove);
      canvas.addEventListener('pointerup', this._onUp);
      canvas.addEventListener('pointercancel', this._onUp);

      this._raf = requestAnimationFrame(t => this._frame(t));
    }

    destroy() {
      this._destroyed = true;
      cancelAnimationFrame(this._raf);
      const c = this.canvas;
      c.removeEventListener('pointerdown', this._onDown);
      c.removeEventListener('pointermove', this._onMove);
      c.removeEventListener('pointerup', this._onUp);
      c.removeEventListener('pointercancel', this._onUp);
    }

    /* host tells us the square CSS size to occupy */
    resize(cssPx) {
      this.CSS = Math.max(200, cssPx);
      this.DPR = Math.min(2.5, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.CSS * this.DPR);
      this.canvas.height = Math.round(this.CSS * this.DPR);
      this.canvas.style.width = this.CSS + 'px';
      this.canvas.style.height = this.CSS + 'px';
      this.reveal.width = this.canvas.width;
      this.reveal.height = this.canvas.height;
      this._tintCache = null;
      if (this.letter) this._redrawCorridor();
    }

    /* letter: {glyph, roman, outline?, strokes:[{points,radii?,width?}]} in vb 1000 */
    setLetter(letter) {
      this.letter = letter || null;
      this.glyphPath = letter && letter.outline ? new Path2D(letter.outline) : null;
      this.strokes = letter ? letter.strokes.map(s => buildStroke(s, this.brush)) : [];
      this._tintCache = null;
      this.reset();
    }

    /* brush: {mode:'follow'|'fixed', widthScale} — applies immediately */
    setBrush(brush) {
      this.brush = normalizeBrush(brush);
      if (this.letter) this.setLetter(this.letter);
    }

    reset() {
      this.si = 0; this.progress = 0; this.finished = false;
      this.fillAnim = null;
      this.tracing = false;
      this.snapAnim = this.demoAnim = null;
      this.particles = [];
      this.lastP = null;
      this.offPathSince = 0;
      this.lastInput = performance.now();
      this.hintT = 0;
      this.revealed = this.strokes.map(() => 0);
      this.rctx.clearRect(0, 0, this.reveal.width, this.reveal.height);
      this._emitStroke();
    }

    demo() {
      if (!this.strokes.length) return;
      this.reset();
      this.demoAnim = { k: 0, s: 0 };
    }

    get strokeCount() { return this.strokes.length; }
    get strokeIndex() { return this.si; }
    get isFinished() { return this.finished; }

    /* ---------------- brush reveal layer ---------------- */
    _paintCorridor(g, st, s0, s1) {
      const scale = (this.CSS * this.DPR) / VB;
      const step = 3;
      g.fillStyle = '#fff';
      for (let s = Math.max(0, s0 - 2); s <= Math.min(st.len, s1); s += step) {
        const q = pointAt(st, s);
        g.beginPath();
        g.arc(q.x * scale, q.y * scale, Math.max(6, q.r * CFG.brushScale) * scale, 0, 7);
        g.fill();
      }
      const q = pointAt(st, clamp(s1, 0, st.len));
      g.beginPath();
      g.arc(q.x * scale, q.y * scale, Math.max(6, q.r * CFG.brushScale) * scale, 0, 7);
      g.fill();
    }

    _redrawCorridor() {
      this.rctx.clearRect(0, 0, this.reveal.width, this.reveal.height);
      this.strokes.forEach((st, k) => {
        if (this.finished) this._paintCorridor(this.rctx, st, 0, st.len);
        else if (this.revealed[k] > 0) this._paintCorridor(this.rctx, st, 0, this.revealed[k]);
      });
    }

    _advanceReveal(k, to) {
      const st = this.strokes[k];
      if (to <= this.revealed[k]) return;
      this._paintCorridor(this.rctx, st, this.revealed[k], to);
      this.revealed[k] = to;
    }

    _completeStrokeReveal(k) {
      const st = this.strokes[k];
      this._paintCorridor(this.rctx, st, 0, st.len);
      this.revealed[k] = st.len;
    }

    /* ---------------- input ---------------- */
    _evPos(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width * VB, y: (e.clientY - r.top) / r.height * VB };
    }

    _pointerDown(e) {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this.lastInput = performance.now(); this.hintT = 0;
      if (this.finished || this.snapAnim || this.demoAnim || !this.strokes[this.si]) return;
      const p = this._evPos(e);
      const st = this.strokes[this.si];
      const tip = pointAt(st, this.progress);
      const startTol = Math.max(CFG.tolMin, tip.r * CFG.startTolScale) + 18;
      if (Math.hypot(p.x - tip.x, p.y - tip.y) <= startTol) {
        this.tracing = true;
        this.offPathSince = 0;
        this.lastP = p;
        this._feed(p);
      } else {
        this.offPathSince = performance.now() - CFG.offPathMs;
      }
    }

    _pointerMove(e) {
      if (!this.tracing) return;
      e.preventDefault();
      this.lastInput = performance.now();
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) this._feed(this._evPos(ev));
    }

    _feed(p) {
      const st = this.strokes[this.si];
      if (!st || this.snapAnim) return;

      const moved = this.lastP ? Math.hypot(p.x - this.lastP.x, p.y - this.lastP.y) : 0;
      this.lastP = p;

      const hit = locate(st, p, this.progress - CFG.backWindow, this.progress + CFG.aheadWindow);
      const tolHere = hit.s >= 0
        ? Math.max(CFG.tolMin, pointAt(st, hit.s).r * CFG.tolScale)
        : 0;

      if (hit.s >= 0 && hit.dist <= tolHere) {
        this.offPathSince = 0;
        if (hit.s > this.progress) {
          const cap = this.progress + moved * CFG.advancePerMove + CFG.advanceFloor;
          this.progress = Math.min(hit.s, cap, st.len);
          this._advanceReveal(this.si, this.progress);
        }
        const endTol = Math.max(CFG.endTolMin, st.pts[st.pts.length - 1].r * CFG.endTolScale);
        if (this.progress >= st.len - endTol) this._completeStroke();
      } else {
        if (!this.offPathSince) this.offPathSince = performance.now();
        else if (performance.now() - this.offPathSince > CFG.offPathMs * 2) {
          if (this.opts.sfx) beep(160, .1, 'square', .04);
          if (this.opts.haptics && navigator.vibrate) navigator.vibrate(18);
          this.offPathSince = performance.now();
        }
      }
    }

    _completeStroke() {
      this.tracing = false;
      this.snapAnim = { from: this.progress, start: performance.now() };
      if (this.opts.sfx) { beep(660, .12, 'sine', .1); beep(880, .16, 'sine', .1, .09); }
      if (this.opts.haptics && navigator.vibrate) navigator.vibrate(10);
    }

    _finishSnapTick(now) {
      if (!this.snapAnim) return;
      const st = this.strokes[this.si];
      const t = clamp((now - this.snapAnim.start) / CFG.snapMs, 0, 1);
      this.progress = lerp(this.snapAnim.from, st.len, t);
      this._advanceReveal(this.si, this.progress);
      if (t >= 1) {
        this._completeStrokeReveal(this.si);
        this.snapAnim = null;
        this.si++;
        this.progress = 0;
        this.lastP = null;
        if (this.si >= this.strokes.length) this._completeLetter();
        this._emitStroke();
      }
    }

    _completeLetter() {
      this.finished = true;
      this.strokes.forEach((st, k) => this._completeStrokeReveal(k));
      /* the whole glyph fills smoothly — the finished letter is the
         exact printed letterform */
      this.fillAnim = { start: performance.now() };
      if (this.opts.sfx) [523, 659, 784, 1047].forEach((f, i) => beep(f, .18, 'sine', .1, i * .1));
      if (this.opts.haptics && navigator.vibrate) navigator.vibrate([16, 60, 24]);
      for (let i = 0; i < 70; i++) {
        const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 9;
        this.particles.push({
          x: VB / 2, y: VB / 2.4,
          vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6,
          s: 5 + Math.random() * 9, life: .9 + Math.random() * .7,
          c: ['#4F8DFD', '#22C55E', '#F59E0B', '#EC4899', '#A855F7'][i % 5]
        });
      }
      if (this.opts.onComplete) this.opts.onComplete(this.letter);
    }

    _emitStroke() {
      if (this.opts.onStrokeChange) {
        this.opts.onStrokeChange(this.si, this.strokes.length, this.finished);
      }
    }

    /* ---------------- demo ---------------- */
    _demoTick() {
      if (!this.demoAnim) return;
      const st = this.strokes[this.demoAnim.k];
      this.demoAnim.s += CFG.demoSpeed;
      this.si = this.demoAnim.k;
      this.progress = clamp(this.demoAnim.s, 0, st.len);
      this._advanceReveal(this.demoAnim.k, this.progress);
      if (this.demoAnim.s >= st.len + 30) {
        this._completeStrokeReveal(this.demoAnim.k);
        this.demoAnim.k++;
        this.demoAnim.s = 0;
        if (this.demoAnim.k >= this.strokes.length) {
          this.demoAnim = null;
          setTimeout(() => {              // reset for the player's turn
            if (!this._destroyed && !this.demoAnim) this.reset();
          }, 650);
        } else {
          this.si = this.demoAnim.k;
          this.progress = 0;
          this._emitStroke();
        }
      }
    }

    /* ---------------- rendering ---------------- */
    _tintLayer() {
      const c = this._tintCache;
      if (c && c.si === this.si && c.letter === this.letter &&
          c.canvas.width === this.canvas.width) return c.canvas;
      const cv = (c && c.canvas.width === this.canvas.width)
        ? c.canvas : document.createElement('canvas');
      cv.width = this.canvas.width; cv.height = this.canvas.height;
      const g = cv.getContext('2d');
      g.clearRect(0, 0, cv.width, cv.height);
      this._paintCorridor(g, this.strokes[this.si], 0, this.strokes[this.si].len);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = this.opts.accent;
      g.fillRect(0, 0, cv.width, cv.height);
      g.globalCompositeOperation = 'source-over';
      this._tintCache = { si: this.si, letter: this.letter, canvas: cv };
      return cv;
    }

    _makeInk(now) {
      const w = this.canvas.width, h = this.canvas.height;
      if (!this.inkCanvas || this.inkCanvas.width !== w || this.inkCanvas.height !== h) {
        this.inkCanvas = document.createElement('canvas');
        this.inkCanvas.width = w; this.inkCanvas.height = h;
        this.inkCtx = this.inkCanvas.getContext('2d');
      }
      const g = this.inkCtx;
      g.clearRect(0, 0, w, h);
      /* the brush line itself */
      g.drawImage(this.reveal, 0, 0);
      /* completed letter: fade the whole glyph in (the ink canvas is
         drawn clipped to the outline, so this fills exactly the glyph) */
      if (this.fillAnim && this.glyphPath) {
        const t = clamp((now - this.fillAnim.start) / CFG.fillMs, 0, 1);
        const a = t * t * (3 - 2 * t);   // smoothstep
        if (a > 0) {
          g.globalAlpha = a;
          g.fillStyle = '#fff';
          g.fillRect(0, 0, w, h);
          g.globalAlpha = 1;
        }
      }
      g.globalCompositeOperation = 'source-in';
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, this.opts.inkFrom); grad.addColorStop(1, this.opts.inkTo);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
      return this.inkCanvas;
    }

    _render(now) {
      const ctx = this.ctx;
      const scale = (this.CSS * this.DPR) / VB;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      if (!this.letter) return;

      /* ghost — glyph fill, or stroke corridors when there is no outline */
      if (this.glyphPath) {
        ctx.fillStyle = this.opts.ghost;
        ctx.fill(this.glyphPath);
      } else {
        ctx.save();
        ctx.strokeStyle = this.opts.ghost;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const st of this.strokes) {
          for (let i = 4; i < st.pts.length + 3; i += 4) {
            const a = st.pts[Math.min(st.pts.length - 1, i) - 4] || st.pts[0];
            const b = st.pts[Math.min(st.pts.length - 1, i)];
            ctx.lineWidth = Math.max(14, (a.r + b.r) * CFG.brushScale);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
        ctx.restore();
      }

      /* current stroke: corridor tint + dashed centerline + chevrons */
      if (!this.finished && this.strokes[this.si]) {
        const st = this.strokes[this.si];
        ctx.save();
        if (this.glyphPath) ctx.clip(this.glyphPath);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = .16;
        ctx.drawImage(this._tintLayer(), 0, 0);
        ctx.globalAlpha = 1;
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = this.opts.guide;
        ctx.lineWidth = 3.5; ctx.setLineDash([14, 12]);
        ctx.lineDashOffset = -(now / 90) % 26;
        ctx.beginPath();
        st.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = 'rgba(234,240,250,.55)';
        for (let s = 70; s < st.len - 40; s += 130) {
          const q = pointAt(st, s);
          const a = Math.atan2(q.dy, q.dx);
          ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(a);
          ctx.beginPath();
          ctx.moveTo(7, 0); ctx.lineTo(-5, -8); ctx.lineTo(-2, 0); ctx.lineTo(-5, 8);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }

      /* revealed ink, clipped to the glyph */
      ctx.save();
      if (this.glyphPath) ctx.clip(this.glyphPath);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this._makeInk(now), 0, 0);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.restore();

      /* stroke start badge or live tip */
      if (!this.finished && this.strokes[this.si]) {
        const st = this.strokes[this.si];
        if (this.progress < 24 && !this.snapAnim && !this.demoAnim) {
          const p0 = st.pts[0];
          const pulse = 1 + .08 * Math.sin(now / 260);
          ctx.beginPath();
          ctx.arc(p0.x, p0.y, 30 * pulse, 0, 7);
          ctx.fillStyle = this.opts.accent;
          ctx.shadowColor = 'rgba(79,141,253,.8)'; ctx.shadowBlur = 22;
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#fff';
          ctx.font = '700 34px -apple-system, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(this.si + 1), p0.x, p0.y + 2);
        } else {
          const q = pointAt(st, this.progress);
          ctx.beginPath();
          ctx.arc(q.x, q.y, 15, 0, 7);
          ctx.fillStyle = '#fff';
          ctx.shadowColor = 'rgba(255,255,255,.9)'; ctx.shadowBlur = 16;
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        /* idle hint: glowing dot runs ahead along the path */
        if (now - this.lastInput > CFG.hintIdleMs && !this.tracing && !this.snapAnim && !this.demoAnim) {
          this.hintT = (this.hintT + 2.6) % (st.len - this.progress + 130);
          const q = pointAt(st, clamp(this.progress + this.hintT, 0, st.len));
          ctx.beginPath();
          ctx.arc(q.x, q.y, 13, 0, 7);
          ctx.fillStyle = 'rgba(255,213,79,.95)';
          ctx.shadowColor = 'rgba(255,213,79,.9)'; ctx.shadowBlur = 18;
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        /* off-path feedback ring */
        if (this.offPathSince && now - this.offPathSince > CFG.offPathMs) {
          const q = pointAt(st, this.progress);
          ctx.beginPath();
          ctx.arc(q.x, q.y, 34 + 6 * Math.sin(now / 110), 0, 7);
          ctx.strokeStyle = 'rgba(239,68,68,.75)';
          ctx.lineWidth = 5;
          ctx.stroke();
        }
      }

      /* celebration particles */
      if (this.particles.length) {
        this.particles = this.particles.filter(p => (p.life -= .016) > 0);
        for (const p of this.particles) {
          p.x += p.vx; p.y += p.vy; p.vy += .5;
          ctx.globalAlpha = Math.min(1, p.life * 2);
          ctx.fillStyle = p.c;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, 7); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    _frame(now) {
      if (this._destroyed) return;
      this._finishSnapTick(now);
      this._demoTick();
      this._render(now);
      this._raf = requestAnimationFrame(t => this._frame(t));
    }
  }

  return { VB, CFG, DEFAULT_BRUSH, normalizeBrush, normalizeDoc, buildStroke, pointAt, locate, TraceEngine };
});
