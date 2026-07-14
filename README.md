# Tibetan Alphabet Letter Tracing

Game-grade stroke tracing for all 30 Tibetan consonants (ཀ – ཨ), with fully
automatic stroke-data generation from the font glyphs themselves.

- **[Stroke Tracer](https://kharagedition.github.io/tibetan-alphabet-letter-trace-json-generator/stroke-trace.html)** — the tracing game
- **[Stroke Recorder](https://kharagedition.github.io/tibetan-alphabet-letter-trace-json-generator/)** — optional manual recorder (legacy)
## Preview

<img height="415" alt="Tracing" src="https://github.com/user-attachments/assets/135d167b-3b73-422d-82c5-d7aaf124f96b" />

<img width="400" alt="Stroke" src="https://github.com/user-attachments/assets/a01e54e3-5076-496c-bd58-c0eee2a59772" />



## How it works

The system has two halves: a **generator** that derives stroke guide paths from
the Noto Serif Tibetan outlines, and a **tracer** that turns them into a
zero-seam tracing game.

### 1. Stroke generator (`generate-strokes.cjs`)

Every letter's strokes are extracted automatically from its glyph outline:

```
outline (SVG path)
  → nonzero-fill rasterization (1000×1000)
  → exact Euclidean distance transform  (local ink radius everywhere)
  → Guo–Hall thinning                   (1-px skeleton)
  → skeleton graph                      (endpoints/junctions + branches)
  → spur pruning                        (serif/flare artifacts, scaled by local radius)
  → head-bar extraction                 (top-band branches welded into ONE left→right bar,
                                         bridged across junction-wedge breaks)
  → collinear branch merging            (smooth continuations chain through junctions)
  → redundancy cleanup                  (short strokes whose ink is already covered are dropped)
  → smoothing                           (Douglas-Peucker + Chaikin, straight-limb collapse)
  → tip extension                       (reach the true limb ends)
  → per-point radius sampling           (from the distance field)
  → ordering by Tibetan writing rules   (head bar first, then top→bottom, left→right;
                                         horizontals run left→right, verticals top→bottom)
```

Run it:

```bash
node generate-strokes.cjs             # rewrites letters.json + letters.js
node generate-strokes.cjs --dry-run   # report only
node generate-strokes.cjs --preview   # also writes strokes-preview.svg (QA grid)
node generate-strokes.cjs --only ka,kha
```

The generator prints an ink-coverage percentage per letter (how much of the
glyph the stroke corridors cover) — all 30 letters sit at 99.5 – 100 %.

### 2. Tracer (`stroke-trace.html`)

Two invariants make the tracing robust ("zero stroke issues"):

1. **Ink = brush ∩ glyph.** Revealed ink is a round-cap corridor painted along
   the guide path with the *local ink radius* (from the distance field), then
   clipped to the glyph outline. Visible edges always come from the font
   geometry, so there are no seams at stroke junctions and no gaps at flared
   tips. When the final stroke completes, the whole glyph floods so no sliver
   is ever left behind.

2. **Monotonic arc-length progress.** Pointer input is matched to the guide
   path only inside a small window ahead of current progress, with a per-event
   advance cap. You cannot skip across the letter, jump to the end, or scrub
   backwards — the stroke must be travelled in order, in the right direction.
   Tolerance scales with the local limb radius.

Game feel: numbered start badges, animated dashed guide with direction
chevrons, idle hint dot, off-path ring + haptic feedback, per-stroke progress
bar, finish-snap animation, confetti + chime on completion, a "show me" demo
mode, and per-letter progress saved in `localStorage`.

**Custom data:** the 📂 button in the tracer loads your own JSON — pick a
file or paste it. It accepts the v2 format below, and also the legacy
recorder format (normalized 0–1 `{x,y}` points, no outlines; those letters
trace against their stroke corridors instead of a glyph fill). Custom data is
remembered across reloads until you press *Use built-in letters*.

## JSON format (v2)

```jsonc
{
  "version": 1,
  "viewBox": 1000,                  // all coordinates are 0–1000
  "letters": [
    {
      "id": "ka",
      "glyph": "ཀ",
      "roman": "ka",
      "order": 1,
      "outline": "M758.0 40.0 …Z",  // exact glyph outline (SVG path data)
      "strokes": [
        {
          "points": [[283, 104.9], …],   // guide path centerline
          "radii":  [47.0, 46.2, …],     // local ink radius at each point
          "width":  94.2                 // 2 × median radius (fallback)
        }
      ]
    }
  ]
}
```

`letters.js` is the same document as `window.LETTERS_DATA` for file:// use.

## Using the data in your own app

Per stroke, the render/validate recipe is:

1. Build a dense polyline from `points`, interpolate `radii` along it.
2. Reveal: stamp discs of `radius × ~1.3` along the traced portion, clipped to
   `outline` (Android: `clipPath` + `drawCircle`; the outline string is valid
   `PathParser` / `Path2D` input).
3. Validate: nearest point on path within `[progress − 55, progress + 90]`,
   tolerance `max(42, radius × 2.1)`, cap the advance per event, complete at
   `length − max(34, endRadius × 1.6)`.
4. On the last stroke's completion, fill the whole outline.

## Repo map

| File | Purpose |
|---|---|
| `generate-strokes.cjs` | automatic stroke extraction (the algorithm above) |
| `refine.js` | geometry primitives (path parsing, rasterizer, EDT, contours) |
| `letters.json` / `letters.js` | generated stroke data for all 30 consonants |
| `stroke-trace.html` | the tracing game |
| `strokes-preview.svg` | QA grid of every letter's strokes (run with `--preview`) |
| `index.html` | legacy manual stroke recorder |

## License

MIT
