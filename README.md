# Tibetan Alphabet Stroke Tracer

A professional web-based tool for recording and practicing Tibetan letter stroke orders. This project consists of two interconnected HTML applications:

1. **Stroke Recorder** - Record stroke paths for Tibetan letters
2. **Stroke Tracer** - Practice tracing with guided feedback

## Live Demo

- [Stroke Recorder](https://kharagedition.github.io/tibetan-alphabet-letter-trace-json-generator/)
- [Stroke Tracer](https://kharagedition.github.io/tibetan-alphabet-letter-trace-json-generator/stroke-trace.html)

## Quick Start

### Part 1: Recording Stroke Data

1. Open the **[Stroke Recorder](https://kharagedition.github.io/tibetan-alphabet-letter-trace-json-generator/)**

2. Select a letter from the grid (e.g., ཀ - Ka)

3. Draw each stroke of the letter:
   - Touch/click and drag on the canvas to draw a stroke
   - The app automatically filters and simplifies your points
   - Click **"Add Stroke"** to commit each stroke
   - Continue until all strokes are recorded

4. Click **"✓ Save Letter & Continue"** to save

5. Repeat for all 30 consonants

6. Export your data:
   - Click the **📦** icon
   - Copy or download the JSON file

### Part 2: Practicing Tracing

1. Open the **[Stroke Tracer](https://kharagedition.github.io/tibetan-alphabet-letter-trace-json-generator/stroke-trace.html)**

2. Paste the JSON data from the Stroke Recorder

3. Click **"Load Letters →"**

4. Practice tracing:
   - Follow the numbered waypoints (1, 2, 3...)
   - Stay within the tolerance zone (blue guide path)
   - The letter fills in as you trace correctly
   - Red indicator appears if you go off-track

## Features

### Stroke Recorder

| Feature | Description |
|---------|-------------|
| **Point Smoothing** | Douglas-Peucker simplification algorithm |
| **Curve Interpolation** | Catmull-Rom spline for smooth curves |
| **Normalization** | Resolution-independent 0-1 coordinate system |
| **Adaptive Filtering** | Removes touch jitter automatically |
| **Processing Stats** | Shows raw → filtered → simplified point counts |

### Stroke Tracer

| Feature | Description |
|---------|-------------|
| **Distance-Based Validation** | Accurate path following detection |
| **Key Point Waypoints** | Numbered markers at actual stroke features |
| **Tolerance Zone** | 8% forgiveness for natural variations |
| **Progress Tracking** | Real-time completion percentage |
| **Off-Path Detection** | Visual feedback when you stray |
| **Fog-of-War Reveal** | Letter fills as you trace correctly |

## JSON Format (v1.0)

The exported JSON uses a normalized coordinate system for resolution independence:

```json
{
  "version": "1.0",
  "coordinateSystem": "normalized-0-1",
  "canvasSize": 1000,
  "letters": {
    "ཀ": {
      "name": "Ka",
      "index": 1,
      "strokes": [
        {
          "type": "path",
          "points": [
            {"x": 0.5, "y": 0.2},
            {"x": 0.5, "y": 0.5},
            {"x": 0.3, "y": 0.8}
          ]
        }
      ],
      "boundingBox": {
        "minX": 0.1,
        "maxX": 0.9,
        "minY": 0.1,
        "maxY": 0.9
      }
    }
  }
}
```

## How It Works

### Point Processing Pipeline

```
Raw Capture → Min Distance Filter → Douglas-Peucker → Catmull-Rom → Normalize 0-1
```

1. **Raw Capture** - Records points as you draw
2. **Min Distance Filter** - Removes jitter (adaptive threshold)
3. **Douglas-Peucker** - Simplifies while preserving shape
4. **Catmull-Rom** - Generates smooth curves through points
5. **Normalize** - Converts to 0-1 coordinates for any resolution

### Tracing Validation

The tracer uses distance-based validation:

1. Finds the closest point on the stroke path to your input
2. Measures the perpendicular distance
3. Checks if within tolerance (8% of canvas size)
4. Tracks cumulative distance along the stroke for progress

## Technical Details

### Configuration Constants

**Recorder:**
- `SIMPLIFY_EPSILON: 0.008` - Douglas-Peucker tolerance
- `MIN_PT_DISTANCE: 0.015` - Minimum point spacing
- `CANVAS_PADDING: 0.13` - 13% padding around letter

**Tracer:**
- `TOLERANCE_RATIO: 0.08` - 8% path tolerance
- `KEY_POINT_ANGLE_THRESHOLD: π/5` - Corner detection threshold

### Browser Compatibility

- Modern browsers with Canvas API support
- Touch devices (tablets recommended)
- Desktop with mouse/touchpad

## Tips for Best Results

### Recording

1. **Use a stylus** on a tablet for most accurate strokes
2. **Draw slowly and steadily** - the app will smooth and simplify
3. **Follow the actual stroke order** of Tibetan calligraphy
4. **Each stroke should be one continuous motion**
5. **Review processing stats** - fewer points = cleaner data

### Tracing

1. **Start at waypoint 1** (green circle when reached)
2. **Follow the dotted blue line** as your guide
3. **Go through each numbered waypoint** in order
4. **Stay within the tolerance zone** - don't stray too far
5. **The progress bar** shows how much of the stroke remains

## Tibetan Stroke Order Reference

The standard stroke order for Tibetan consonants follows the traditional calligraphic sequence:

1. **Horizontal head stroke** (when present)
2. **Vertical main stroke**
3. **Diagonal connecting strokes**
4. **Closing strokes**

The recorded data should reflect the proper order for educational use.

## Data Storage

Recorded data is saved to your browser's localStorage (`tib_paths_v3`). Data persists between sessions but is browser-specific. Always export your JSON for backup.

## License

MIT License - feel free to use and modify for your projects.

## Credits

Created for Tibetan language learning and calligraphy practice.
