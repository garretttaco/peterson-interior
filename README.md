# Peterson Residence — Interior Designer

A single-page interior design tool for the **Peterson** house: main floor,
upstairs bonus floor, stair, and roof, all built from the plan set (sheets
A1.0, A3.1, A4.1, and S2.0). Runs entirely in the browser with no server and
no build step. Works from `file://` and from GitHub Pages.

## What it does

**2D floor plan**
- Walls recreated from the plan at real scale (mm), drawn with load-bearing
  walls hatched and partition walls light
- Doors with swing arcs, windows, sliding doors, overhead garage door
- Room names with **automatic area calculation** (m²) and perimeter dimension
  lines (mm) around the outside of the envelope
- Furniture placed at real-world sizes; drag to move, wheels/handles to rotate
  and resize; **snaps to wall faces and to other furniture**
- Measure tool (click two points), demolition of **non-load-bearing** walls
  (load-bearing walls refuse and tell you why), floor material replacement
  per room
- Undo/redo, autosave to `localStorage`, reset to the default layout,
  export the plan as PNG

**Two floors** — the **Main** / **Upstairs** switch picks the floor shown and
edited in 2D. The upstairs plan shows the main floor faintly underneath.

**3D view**
- Same design scheme generated with three.js: walls with real window and door
  openings, floors in the chosen materials, furniture modeled per type
- The upstairs sits on its floor structure at 11'-0", connected by the
  U-shaped stair; the roof (gables, hips, porch sheds) comes from the roof
  framing plan
- **Roof** and **Upstairs** toggles for cutaway views, and a brightness slider
- **Bird's-eye orbit** (drag to orbit, right-drag to pan, wheel to zoom) and
  **first-person walkthrough** (click *Walk*, then W A S D + mouse, Shift to
  run, Esc exits). You can walk through every doorway, past chairs and tables,
  and up the stairs to the bonus room
- Live sync: any 2D edit rebuilds the 3D scene

**Switching** — the 2D/3D buttons cross-fade between views; camera and design
state are preserved, both views always show the same data.

## On a phone

The page opens on the 3D house with the upstairs and roof showing.

- **Orbit:** drag with one finger to turn the house; pinch to zoom; move two
  fingers together to pan.
- **Walk:** tap **Walk**, then push the round joystick (bottom left) to walk
  and drag anywhere else to look around. Walk up the stairs to reach the
  bonus room, or switch to **Up** first to start there.
- **2D plan:** drag to pan, pinch to zoom, tap a room to select it, drag
  furniture to move it.
- **⋯** opens the editing tools; the first tool opens the rooms, furniture,
  and floor panels.

## Run it

Open `index.html` in a browser. That's it.

## Host on GitHub Pages

The repo root is the site. In **Settings → Pages**, deploy from the `main`
branch, `/ (root)` folder, then open `https://<user>.github.io/<repo>/`.

No build, no dependencies to install. `vendor/three.min.js` (r146) is bundled,
so it works offline.

## Files

```
index.html             app shell (toolbar, sidebar, viewports)
styles.css             UI theme
vendor/three.min.js    bundled three.js (r146, MIT)
data/plan.js           GENERATED: both floors (walls, openings, rooms), stair, roof
data/layout.js         GENERATED: default furniture layout (120 pieces)
data/furniture.js      furniture catalog (37 types)
data/materials.js      floor material catalog
tools/extract_plan.py  generator: reads the PDF, writes data/plan.js + data/layout.js
js/util.js             math + helpers
js/geom.js             walls per level, snapping, clamping, areas
js/state.js            model store, levels, undo/redo, localStorage
js/view2d.js           canvas plan view + all 2D interactions
js/view3d.js           three.js scene, roof, orbit + walkthrough
js/app.js              wiring: toolbar, sidebar, view and floor switching, export
qa/                    geometry check (node) + interactive check (headless Chrome)
docs/plan-source.md    how the plan was extracted from the PDF
```

## Keyboard

| Key | Action |
|---|---|
| `V` `M` `D` `F` | select / measure / demolish / floor material |
| `R`, `[` `]` | rotate selected furniture 90° / ∓5° |
| `Shift`+wheel | rotate selected furniture 5° |
| arrows | nudge 10 mm (`Shift` = 100 mm) |
| `Ctrl/⌘+Z`, `Ctrl/⌘+Y` | undo / redo |
| `Ctrl/⌘+D`, `Delete` | duplicate / delete furniture |
| `0`, `Esc` | zoom to fit / cancel |

## Notes on the model

Walls are the PDF's own wall fills, so positions and thicknesses match the
drawing exactly. The sheets are plotted at 3/16" = 1'-0" (the title block
says 1/4"); at that scale every labeled room size matches the model to within
1/8" (master bedroom 13'-10" × 15'-7", great room 18'-0" × 22'-7", bonus room
18'-2" × 26'-8"). See `docs/plan-source.md`.
