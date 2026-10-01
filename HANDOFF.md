# Handoff — Peterson interior design tool

A browser-only interior design tool for the Peterson house: a 2D floor plan
and a 3D walkthrough of the same design, covering the main floor, the
upstairs bonus floor, the stair, and the roof. Static site, no server, no
build step. It must keep working from `file://`: plain `<script>` tags, no ES
modules, no `fetch` for local data.

## 1. Source of truth

`~/Library/Mobile Documents/com~apple~CloudDocs/Documents/Peterson 20251216.pdf`.
Read `docs/plan-source.md` first. The key fact: the sheets are plotted at
3/16" = 1'-0" even though the title block says 1/4". The first version of
this tool used 1/4" and was rebuilt because of it.

## 2. Layout and load order

```
index.html  styles.css  vendor/three.min.js (r146 UMD)
data/plan.js        GENERATED — levels (walls, openings, rooms), stair, roof, skirts
data/layout.js      GENERATED — default furniture, each piece tagged with a level
data/furniture.js   catalog (37 types)      data/materials.js   floor materials
tools/extract_plan.py   PDF -> data/plan.js + data/layout.js
js/util.js -> js/geom.js -> js/state.js -> js/view2d.js -> js/view3d.js -> js/app.js
qa/geometry-check.js    qa/interactive-qa.js
```

Do not hand-edit `data/plan.js` or `data/layout.js`. Change
`tools/extract_plan.py` and run `python3 tools/extract_plan.py` (needs
poppler's `pdftocairo`). It prints every room's size next to its label.

## 3. Data model (mm; x east, y north, z up)

- `PET_PLAN.levels[]`: `{id, name, elev, height, rooms, walls, openings}`.
  Main: elev 0, height 3048. Bonus: elev 3353, height 2134, own window and
  door heights. `main.stair` holds the treads, landing, and center rail.
- Walls are explicit: `[x1,y1,x2,y2]` rects straight from the PDF fills, or
  `{d:[x1,y1,x2,y2], t}` for the angled great-room corner. Openings are the
  gaps between walls: `{o, at, a, b, thick, type}`, with type `door`,
  `door2`, `opening`, `closet`, `pocket`, `window`, `slider`, or `garage`.
  Tagged openings also carry `tag`, `height`, and (windows) `sill` and
  `style` (`sh` or `fx`), all read from sheet A2.0.
- Rooms are rects on wall faces. A room made of several rects repeats its id;
  extra rects carry `part: true`. Flags: `porch`, `patio`, `stair`, `void`
  (the upstairs stair well), `vaulted` (no ceiling in walk mode).
- `PET_PLAN.roof[]`: gables and hips (`axis`, `ridgeAt`, `ridgeZ`, `pitch`,
  `ends`) and sheds (`high`, `zHigh`). `skirts[]` are infill walls between a
  lower plate and a roof above it.

## 4. Runtime model

- `PET.buildLevel(plan, level)` turns raw walls into
  `{id, o:'h'|'v'|'d', at, a, b, thick, rect, ext, load, kind, out}`.
  Exterior means one side is outside every indoor room; `out` is the outdoor
  side, used by the 2D dimension lines. Walls are already split at openings,
  so nothing else splits them.
- `store.levels[]` holds every level's built walls; `store.setLevel(id)`
  points `store.plan`, `store.walls`, and `store.openings` at one level for
  the 2D view. `store.furniture` holds every piece; 2D code must use
  `store.levelFurniture()`.
- `PET.roomAt` returns the smallest containing rect, so closets win.
- Bump `LAYOUT_VERSION` in `js/state.js` when the plan or layout changes
  (it is 4), or browsers keep their stale `localStorage` layout.
- Undo/redo is snapshot-based; call `store.commit(label)` after mutating.

## 5. 3D and walking

- Each level is a group; the upstairs group, ceilings, and roof are toggled
  by visibility without a rebuild. Walk mode always shows everything.
- Colliders carry a height range. The walker has feet height `walk.feet`,
  a 170 mm radius, and climbs anything up to 420 mm. `floorAt()` picks the
  highest walkable surface (stair treads, upstairs floors) under the walker;
  colliders block only if they overlap the body's height band.
- A move is blocked only by colliders the walker is not already inside, so
  a bad start position never traps the camera. Moves are sub-stepped at
  60 mm so fast movement cannot tunnel through walls.
- Only large solid furniture collides (beds, sofas, counters, shelving, cars;
  see `BLOCKS`). Chairs, tables, rugs, and plants do not.
- Lighting uses linear tone mapping; the brightness slider sets exposure
  (default 0.8, stored in `localStorage` as `peterson-bright`).
- `PET.view3d.debug` exposes `walkTo`, `step`, and `floorAt` for QA.

## 6. Verify

```bash
cd peterson-interior
python3 tools/extract_plan.py      # regenerate data, print label checks
node qa/geometry-check.js          # both levels, stair, registration
npm install --no-save puppeteer-core
node qa/interactive-qa.js          # original 17 checks + floor switch + walking
```

The interactive suite walks through every door and opening on both floors in
both directions (77 crossings), climbs the stair to the bonus room and back,
and walks through the dining chairs. All pass, with no console errors.

## 7. Known gaps

- Roof is massing-accurate (ridges, pitches, heights match S2.0 and A3.1) but
  has no fascia, gutters, or thickness; valleys come from plane intersections.
- Vaulted rooms show the roof underside rather than a sloped ceiling.
- Default furniture follows what the PDF draws; unfurnished rooms got a
  plausible layout.
- Layout import/export, URL sharing, and wall editing are still open.
