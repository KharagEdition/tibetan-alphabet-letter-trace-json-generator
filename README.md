# Tibetan Alphabet Letter Tracing

Game-grade stroke tracing for Tibetan script, with fully automatic
stroke-data generation from the font glyphs themselves. Letters are grouped
into 7 categories, opened from a category picker in the tracer:

| Category | Count | Letters |
|---|---|---|
| Consonants | 30 | ཀ – ཨ |
| Vowel Signs | 4 | ི ུ ེ ོ |
| Prefix Letters | 5 | ག ད བ མ འ |
| Superscribed Letters | 3 | ར ལ ས |
| Subscribed Letters | 4 | ྱ ྲ ླ ྭ |
| Suffix Letters | 10 | ག ང ད ན བ མ འ ར ལ ས |
| Second Suffixes | 2 | ད ས |

Prefix, Superscribed, Suffix and Second Suffix letters reuse the same
glyph/stroke data as the matching root consonant (tagged with a `roles`
array in `letters.json`) rather than duplicating tracing content — they're
the same shape in a different grammatical position. Vowel Signs and
Subscribed Letters are distinct glyphs with their own outline + stroke
data. Per-category JSON exports (one file per category, each a
self-contained `{version, viewBox, letters}` document) live in
[`categories/`](categories/).

- **[Stroke Studio](https://kharagedition.github.io/tibetan-alphabet-letter-trace-json-generator/)** — edit strokes AND trace them **side by side, live**; export letters.json from the same page
- **[Stroke Tracer](https://kharagedition.github.io/tibetan-alphabet-letter-trace-json-generator/stroke-trace.html)** — the standalone tracing game
- **[Stroke Recorder](https://kharagedition.github.io/tibetan-alphabet-letter-trace-json-generator/recorder.html)** — optional manual recorder (legacy)
## Preview

<img width="800" height="590" alt="ScreenRecording2026-07-16at1 51 45PM-ezgif com-video-to-gif-converter" src="https://github.com/user-attachments/assets/bba973fb-9187-4296-a1f1-bb550fa6f6eb" />


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
glyph the stroke corridors cover) — all 38 letters sit at 99.5 – 100 %.

### 2. Tracing engine (`trace-core.js`, used by the Studio and `stroke-trace.html`)

The reveal model is deliberately simple so the drawing always looks right:

1. **While tracing, ink is a plain brush line.** A smooth round brush
   follows the pen along the guide path — always solid, including through
   self-crossings and junctions. Nothing else appears around the pen: no
   partial fills, no seams. The brush is configurable (see below).

2. **On the last stroke's completion, the whole glyph fills** with a smooth
   fade — the finished letter is pixel-identical to the printed letterform
   (ink is always clipped to the glyph outline, so its edges come from the
   font geometry).

3. **Monotonic arc-length progress.** Pointer input is matched to the guide
   path only inside a small window ahead of current progress, with a per-event
   advance cap. You cannot skip across the letter, jump to the end, or scrub
   backwards — the stroke must be travelled in order, in the right direction.

**Brush settings** — the Studio's *Brush* panel controls how the trace
draws: *Follow letter* (brush tracks the limb thickness) or *Fixed* (one
constant width per stroke, like a marker), plus a width slider (50–200 %).
Settings apply live, persist in the browser, and are exported as a
top-level `"brush"` object in `letters.json`, which the tracer (and your
app) picks up automatically.

Letters without an outline (legacy recorder data) simply keep the brush
corridors as the final look.

Game feel: numbered start badges, animated dashed guide with direction
chevrons, idle hint dot, off-path ring + haptic feedback, per-stroke progress
bar, finish-snap animation, confetti + chime on completion, a "show me" demo
mode, and per-letter progress saved in `localStorage`.

### 3. Stroke Studio (`index.html`)

The generator gets ~90 % of the way; the Studio is where you make each letter
exactly right — and **you see the result as you edit**: the anchor editor and
the real tracing game sit side by side on one page, always in sync. No
exporting, no copying JSON between URLs.

- every letter opens **prefilled** with the current strokes; fix only what's wrong
- paths are **anchor-based**: click to place points, drag to move; segments
  between points are smooth curves or straight lines (double-click a point to
  toggle corner ⇄ curve) — zero zigzag by construction
- points are **clamped inside the glyph outline** automatically
- reorder strokes (writing order), reverse direction, add/delete strokes
- the **live trace pane** reloads within ~0.3 s of every edit — trace it
  right there, run the 👁 demo, restart with ↺
- **⇩ letters.json / letters.js** downloads the production files from the
  same page; *Open full tracer* launches the standalone game with your data
- **⇪ Import JSON** loads a previously exported `letters.json` (or
  `letters.js`) back into the Studio for re-editing — strokes, anchors and
  brush settings round-trip exactly; a partial file with just the letters
  you want to fix works too (matched by id/glyph, others stay untouched)
- work is auto-saved in the browser; *Revert letter* restores the generated data

(`editor.html` now redirects here; saved edits carry over.)

Traditional order to follow (per Uchen calligraphy convention): head (mgo)
line first, drawn left→right; then remaining strokes top→bottom, left→right.

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
      "category": "consonant",      // consonant | vowelSign | subscribed
      "roles": ["prefix", "suffix"],// extra grammatical roles (may be empty)
      "outline": "M758.0 40.0 …Z",  // exact glyph outline (SVG path data)
      "strokes": [
        {
          "points": [[283, 104.9], …],   // guide path centerline
          "radii":  [47.0, 46.2, …],     // local ink radius at each point
          "width":  94.2                 // 2 × median radius (fallback)
        }
      ]
    }
  ],
  "categories": [
    { "id": "consonants", "label": "Consonants", "count": 30, "letters": [ /* {id, glyph, roman, available} */ ] }
    // … one entry per category, see the table above
  ]
}
```

`letters.js` is the same document as `window.LETTERS_DATA` for file:// use.
`categories/*.json` are per-category exports (regenerate with the same
scripts used to build them — see `Repo map` below).

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
| `index.html` | **Stroke Studio** — anchor editor + live tracer side by side |
| `trace-core.js` | shared tracing engine (region reveal + validation + game feel) |
| `generate-strokes.cjs` | automatic stroke extraction (the algorithm above) |
| `export-categories.cjs` | rebuilds `categories` in letters.json/js + `categories/*.json` from each letter's `category`/`roles` tags |
| `refine.js` | geometry primitives (path parsing, rasterizer, EDT, contours) |
| `letters.json` / `letters.js` | generated stroke data for all 38 letters across 7 categories |
| `categories/*.json` | one self-contained JSON export per category |
| `stroke-trace.html` | the standalone tracing game — opens on a category picker |
| `strokes-preview.svg` | QA grid of every letter's strokes (run with `--preview`) |
| `editor.html` | redirect to the Studio (kept for old links) |
| `recorder.html` | legacy manual stroke recorder |

## License

MIT
