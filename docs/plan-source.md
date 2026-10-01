# Peterson plan — source and extraction

Source: `Peterson 20251216.pdf` (Freestone Built, December 16, 2025).

| Sheet | Used for |
|---|---|
| A1.0 Simplified floor plan | Main and bonus floor walls, openings, room labels |
| A2.0 Floor plan | Window and door size tags (WWHH), overall dimensions for cross-checks |
| A3.1 Exterior elevations | Roof heights (25'-7" ridge, 24'-5" garage, 16'-8" east roof) |
| A4.1 Section plans | 10'-0" main ceiling, bonus floor at 11'-0", 7'-0" bonus ceiling, stair |
| S2.0 Roof framing plan | Ridge and hip lines, pitches (12:12, 7:12, 10:12, 9:12, 1:12) |

## Scale

A1.0 is plotted at **3/16" = 1'-0"**, not the 1/4" printed in the title
block. Three independent checks agree: the garage measures 25'-0" × 30'-6",
stair treads measure 10", and every labeled room size matches only at 3/16".
One unit of the PDF wall layer (0.12 pt) is 2.70933 mm. S2.0 uses half-size
units: `A1 = S2 / 2 + (-4342, +155)`.

An earlier version of this tool read the sheet at 1/4", which made the house
25% too small and forced hand-fitted rooms (the great room came out 7'-4"
wide instead of 18'-0"). This version replaces it entirely.

## Method

`tools/extract_plan.py` reproduces everything:

1. `pdftocairo -svg` page 1; every gray (80%) fill under the wall transform
   is a wall rectangle. Zero-area slivers and the triangles of the angled
   great-room corner are dropped; the angled walls are authored as
   centerlines.
2. The bonus plan registers onto the main plan with a shift of 8094 units
   west and none north-south: its 13 stair tread lines land exactly on the
   main stair's.
3. Rooms are rectangles on the wall faces, read off the gridded sheet;
   L-shaped rooms are several rects with one id. The generator prints each
   room's size against its label.
4. Openings are the gaps between collinear wall rects, typed from door-swing
   arcs and window lines. Each one takes the nearest size tag from A2.0
   (`2656 SH` = 2'-6" × 5'-6" single-hung); every tag width matches its gap
   within 80 mm. Main-floor heads are 8'-0" (A3.1, A4.1), so a window's sill
   is 8'-0" minus its height; upstairs heads are 6'-10". The two living-room
   east openings, the garage door, and the coat closet are untagged on A2.0
   and read from the elevations (`5070 FX`, `5080 SGD`, `18080`, `2680 DR`).
5. Stair: U-shape, 4-tread north run to a landing, 12-tread south run up into
   the bonus room; 18 risers of 186 mm (7-5/16") over 3353 mm.

## Roof

One 12:12 ridge at 25'-7" runs north-south over both west wings. The garage
(24'-5") and pantry (20'-7") roofs are 12:12 gables facing west; the bonus
room is a 7:12 gable with a 10:12 cross gable to the south; a 9:12 gable at
16'-8" faces east over Bed 2; a 9:12 roof (ridge 23'-2") covers the stair.
Over the stair, the 12:12 roof stops about 20'-5" up east of the ridge
(A4.1 section 2), which gives the stair its headroom. Porch and patio roofs
are 1:12 metal sheds topping out at 11'-8", on 8×8 posts with 10×12 (front
patio) and 8×12 beams.

## Known simplifications

- Roof planes are modeled as gables, hips, and sheds from the S2.0 ridge
  lines; valleys are where the planes intersect, not cut. No fascia, gutters,
  or roof thickness.
- Vaulted rooms (north kitchen and living, south-west master) show the roof
  underside instead of a sloped ceiling.
- Small closet partitions and shower glass come from the PDF as-is; closet
  fit-out (rods, shelves) is approximate.
