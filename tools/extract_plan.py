#!/usr/bin/env python3
"""Generate data/plan.js and data/layout.js from the Peterson PDF.

Walls come straight from the PDF vector layer: every gray wall fill on sheet
A1.0 becomes one wall rectangle, so wall positions and thicknesses match the
drawing exactly. Rooms, opening types, the stair, the roof, and the default
furniture are authored below in drawing units, read off the sheets.

Usage (from peterson-interior/):
    python3 tools/extract_plan.py [path/to/Peterson 20251216.pdf]

Requires poppler (`pdftocairo`) on PATH.

Drawing units
-------------
Sheet A1.0 is plotted at 3/16" = 1'-0" (the title block says 1/4", but the
labeled room sizes and the 10" stair treads only match at 3/16"). One unit of
the wall layer is 0.12 pt on paper = 2.70933 mm (exactly 1/9.375 in).
E = east, N = north, in the sheet's own frame. The bonus plan is drawn to the
right of the main plan; its stair treads line up with the main stair when
shifted 8094 units west (no north-south shift).
Sheet S2.0 (roof framing) uses half-size units: A1 = S2 / 2 + (-4342, +155).
"""
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PDF = os.path.expanduser(
    "~/Library/Mobile Documents/com~apple~CloudDocs/Documents/Peterson 20251216.pdf")

U = 25.4 / 9.375            # mm per drawing unit
E0, N0 = -18569.0, 1228.0   # main-floor origin: garage west face, SW-wing south face
BONUS_DX = -8094.0          # bonus plan -> main plan registration (units)
SPLIT_E = -9000.0           # walls east of this belong to the bonus plan


def mm(e, n, bonus=False):
    if bonus:
        e += BONUS_DX
    return round((e - E0) * U), round((n - N0) * U)


def mmlen(u):
    return round(u * U)


# --------------------------------------------------------------------------
# 1. Walls from the PDF (gray fills under the wall transform)
# --------------------------------------------------------------------------
def extract_walls(pdf):
    with tempfile.TemporaryDirectory() as tmp:
        svg_path = os.path.join(tmp, "a10.svg")
        subprocess.run(["pdftocairo", "-f", "1", "-l", "1", "-svg", pdf, svg_path], check=True)
        svg = open(svg_path).read()
    rects = set()
    for m in re.finditer(r"<path ([^>]*)/>", svg):
        a = m.group(1)
        if 'fill="rgb(79.998779%' not in a or "matrix(0, -0.12" not in a:
            continue
        d = re.search(r' d="([^"]*)"', a).group(1)
        for sub in d.split("M")[1:]:
            nums = [float(x) for x in re.findall(r"-?[\d.]+", sub)]
            pts = [(-y, x) for x, y in zip(nums[0::2], nums[1::2])]   # (E, N)
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            bb = (min(xs), min(ys), max(xs), max(ys))
            on_corners = all(
                (abs(p[0] - bb[0]) < 0.6 or abs(p[0] - bb[2]) < 0.6) and
                (abs(p[1] - bb[1]) < 0.6 or abs(p[1] - bb[3]) < 0.6) for p in pts)
            if not on_corners:
                continue            # diagonal wall triangles: authored below
            if bb[2] - bb[0] < 2 or bb[3] - bb[1] < 2:
                continue            # zero-area slivers inside some fills
            rects.add(tuple(round(v, 1) for v in bb))
    return merge(sorted(rects))


def extract_tags(pdf):
    """Window/door size tags on A2.0 (page 2), e.g. '2656 SH' at (E, N) units.

    Tags read WWHH in feet+inches: 2656 = 2'-6" wide x 5'-6" tall. Vertical
    tags are rotated text, so number and suffix are paired by position."""
    with tempfile.TemporaryDirectory() as tmp:
        html = os.path.join(tmp, "a2.html")
        subprocess.run(["pdftotext", "-f", "2", "-l", "2", "-bbox", pdf, html], check=True)
        h = open(html).read()
    words = [(float(a), float(b), float(c), float(d), t) for a, b, c, d, t in re.findall(
        r'xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<', h)]
    nums = [w for w in words if re.fullmatch(r"\d{4,5}", w[4])]
    kinds = [w for w in words if re.fullmatch(r"(SH|FX|DR|PKT|SGD|PIC)\.?", w[4])]
    tags = []
    for n in nums:
        vert = (n[3] - n[1]) > (n[2] - n[0])
        best = None
        for k in kinds:
            if vert:
                same_col = abs((k[0] + k[2]) / 2 - (n[0] + n[2]) / 2) < 3
                if same_col and (0 <= n[1] - k[3] < 6 or 0 <= k[1] - n[3] < 6):
                    best = k
            elif abs(k[1] - n[1]) < 2 and 0 <= k[0] - n[2] < 6:
                best = k
        if not best:
            continue
        x0, y0 = min(n[0], best[0]), min(n[1], best[1])
        x1, y1 = max(n[2], best[2]), max(n[3], best[3])
        tags.append((n[4] + " " + best[4].strip("."), ((x0 + x1) / 2 - 2592) / .12, (1728 - (y0 + y1) / 2) / .12))
    return tags


def tag_size(tag):
    """'2656 SH' -> (width_mm, height_mm); '18080 OHD' -> 18'-0" x 8'-0"."""
    d = tag.split()[0]
    w, h = d[:-2], d[-2:]
    def ftin(v):
        if len(v) == 3 and int(v[1:]) <= 11:     # 210 = 2'-10"
            return int(v[0]) * 12 + int(v[1:])
        if len(v) == 3:                         # 180 = 18'-0"
            return int(v[:2]) * 12 + int(v[2])
        return int(v[0]) * 12 + int(v[1:])      # 26 = 2'-6"
    return round(ftin(w) * 25.4), round(ftin(h) * 25.4)


def merge(rs):
    """Union rectangles that share a band and touch end to end."""
    rs = [list(r) for r in rs]
    changed = True
    while changed:
        changed = False
        out = []
        while rs:
            r = rs.pop()
            i = 0
            while i < len(rs):
                s = rs[i]
                same_h = abs(r[1] - s[1]) < 1.5 and abs(r[3] - s[3]) < 1.5 and s[0] <= r[2] + 1.5 and s[2] >= r[0] - 1.5
                same_v = abs(r[0] - s[0]) < 1.5 and abs(r[2] - s[2]) < 1.5 and s[1] <= r[3] + 1.5 and s[3] >= r[1] - 1.5
                if same_h or same_v:
                    r = [min(r[0], s[0]), min(r[1], s[1]), max(r[2], s[2]), max(r[3], s[3])]
                    rs.pop(i)
                    changed = True
                    continue
                i += 1
            out.append(r)
        rs = out
    return sorted(rs, key=lambda r: (r[1], r[0]))


# Angled walls in the great-room corner (A/R chase), centerlines in units.
DIAG_MAIN = [
    (-14476, 2817, -14348, 2651, 37),
    (-14348, 2648, -14440, 2571, 37),
    (-14442, 2567, -14269, 2343, 37),
    (-14269, 2331, -14130, 2331, 37),
    (-14110, 2343, -14017, 2222, 37),
]

# --------------------------------------------------------------------------
# 2. Rooms (units). Each entry: id, name, kind, flags, list of rects.
#    The first rect carries the label; extra rects are parts of the same room.
#    Rects sit on wall faces, so labeled sizes can be checked exactly.
# --------------------------------------------------------------------------
MAIN_ROOMS = [
    # north wing
    ("m-bath-n", "Master Bath", "bath", {"label": "14'-6\" x 9'-10\""}, [(-17519, 12440, -15888, 13546)]),
    ("wic-n", "Walk-in Closet", "hall", {"label": "14'-6\" x 5'-5\""}, [(-17519, 11793, -15888, 12402)]),
    ("m-bed-n", "Master Bedroom", "bedroom", {"label": "13'-10\" x 15'-7\""}, [(-15850, 11793, -14294, 13546)]),
    ("pantry-n", "Pantry", "utility", {"label": "5'-8\" x 18'-9\""}, [(-17932, 9646, -17294, 11756)]),
    ("kitchen-n", "Kitchen", "kitchen", {"label": "12'-10\" x 23'-8\"", "vaulted": True}, [(-17256, 9646, -15813, 11756)]),
    ("living", "Living Room", "living", {"label": "13'-6\" x 23'-8\"", "vaulted": True}, [(-15813, 9093, -14294, 11756)]),
    ("foyer", "Foyer", "hall", {}, [(-17519, 9093, -15813, 9646)]),
    ("coat", "Coat Closet", "hall", {}, [(-17519, 8821, -17125, 9056)]),
    ("gb-clo", "Closet", "hall", {}, [(-17088, 8821, -16563, 9056)]),
    ("guest-bed", "Guest Bedroom", "bedroom", {"label": "12'-4\" x 12'-9\""}, [(-17519, 7621, -16131, 8784), (-16525, 8784, -16131, 9056)]),
    ("guest-bath", "Guest Bath", "bath", {"label": "5'-5\" x 8'-6\""}, [(-16094, 7621, -15484, 8578)]),
    ("hall-n", "Hall", "hall", {}, [(-16094, 8615, -15484, 9093)]),
    ("office-clo", "Closet", "hall", {}, [(-15447, 7621, -15213, 8578)]),
    ("office", "Office", "bedroom", {"label": "10'-3\" x 12'-9\""}, [(-15175, 7621, -14294, 9056), (-15447, 8578, -15175, 9056)]),
    ("laundry", "Laundry", "utility", {"label": "12'-0\" x 18'-4\""}, [(-15644, 6056, -14294, 7584), (-15644, 5522, -14538, 6056)]),
    ("garage", "2-Car Garage", "garage", {"label": "25'-0\" x 30'-6\""}, [(-18513, 4134, -16113, 7097), (-16113, 5015, -15700, 7565), (-17519, 7097, -16113, 7565)]),
    ("hall-st", "Hall", "hall", {}, [(-15644, 4997, -14538, 5484), (-15288, 4547, -14538, 4997)]),
    ("stair", "Stair", "hall", {"stair": True}, [(-16056, 4134, -15288, 4959), (-15288, 4134, -14538, 4547)]),
    ("hall-sw", "Hall", "hall", {}, [(-16113, 3497, -14538, 4097), (-16113, 2897, -15700, 3497)]),
    ("pantry-s", "Pantry", "utility", {"label": "10'-0\" x 5'-0\""}, [(-15663, 2897, -14538, 3459)]),
    ("wic-s", "Walk-in Closet", "hall", {"label": "12'-2\" x 10'-6\""}, [(-17519, 2897, -16150, 4078)]),
    ("wc-s", "Toilet", "bath", {}, [(-17519, 2522, -17003, 2859)]),
    ("linen-s", "Linen", "hall", {}, [(-16488, 2466, -16150, 2859)]),
    ("m-bath-s", "Master Bath", "bath", {"label": "10'-6\" x 12'-2\""}, [(-17519, 1284, -16150, 2466), (-16966, 2466, -16488, 2859)]),
    ("m-bed-s", "Master Bedroom", "bedroom", {"label": "14'-0\" x 14'-0\"", "vaulted": True}, [(-16113, 1284, -14538, 2859)]),
    # south-east wing (attached suite)
    ("kitchen-s", "Kitchen", "kitchen", {"label": "18'-0\" x 11'-2\""}, [(-14500, 4762, -12475, 6018)]),
    ("great", "Great Room", "living", {"label": "18'-0\" x 22'-7\""}, [(-14500, 2222, -12475, 4762)]),
    ("bath2", "Bath 2", "bath", {"label": "5'-0\" x 11'-0\""}, [(-12437, 4209, -11875, 5447)]),
    ("bed2", "Bed 2", "bedroom", {"label": "11'-6\" x 11'-0\""}, [(-11819, 4209, -10525, 5447)]),
    ("hall-se", "Hall", "hall", {}, [(-12437, 3759, -11444, 4172)]),
    ("clo-se", "Closet", "hall", {}, [(-11406, 3759, -11200, 4172)]),
    ("wic-se", "Walk-in Closet", "hall", {"label": "5'-8\" x 3'-8\""}, [(-11162, 3759, -10525, 4172)]),
    ("bed1-clo", "Closet", "hall", {}, [(-12437, 3497, -11200, 3722)]),
    ("bed1", "Bed 1", "bedroom", {"label": "11'-0\" x 11'-0\""}, [(-12437, 2222, -11200, 3459)]),
    # outdoor
    ("porch-e", "Porch", "patio", {"porch": True, "label": "58'-3\" x 10'-0\""}, [(-14238, 7050, -13112, 13602)]),
    ("porch-r", "Rear Porch", "patio", {"porch": True, "label": "33'-6\" x 13'-9\""}, [(-12419, 5503, -10468, 7050), (-14238, 6075, -12419, 7050)]),
    ("patio-s", "Patio", "patio", {"patio": True, "label": "35'-8\" x 6'-0\""}, [(-14481, 1491, -10468, 2166)]),
    ("patio-e", "Patio", "patio", {"patio": True, "label": "6'-0\" x 13'-8\""}, [(-11144, 2166, -10468, 3703)]),
]

BONUS_ROOMS = [   # bonus-plan units (shifted by BONUS_DX on output)
    ("stair-b", "Stair", "hall", {"stair": True, "void": True}, [(-7963, 4134, -6444, 4959)]),
    ("bonus", "Bonus Room", "living", {"label": "18'-2\" x 26'-8\""}, [(-6406, 3300, -4363, 5203), (-5394, 2203, -4363, 3300)]),
    ("lin3", "Linen", "hall", {}, [(-4025, 4415, -3781, 4640)]),
    ("clo3", "Closet", "hall", {}, [(-3744, 4415, -3087, 4640)]),
    ("bath3", "Bath 3", "bath", {"label": "11'-0\" x 7'-0\""}, [(-4325, 4678, -3087, 5203), (-4325, 4415, -4025, 4678)]),
    ("bed3", "Bed 3", "bedroom", {"label": "11'-0\" x 11'-8\""}, [(-4325, 3066, -3087, 4378)]),
    ("clo-b", "Closet", "hall", {}, [(-4325, 2203, -4119, 3028)]),
]

# --------------------------------------------------------------------------
# 3. Openings: (orient, wall-line, a, b, thick, type). Gaps in the wall fill,
#    typed from the door-swing arcs and window lines on A1.0.
#    type: door | door2 (double) | opening | closet | window | slider | garage
# --------------------------------------------------------------------------
MAIN_OPENINGS = [
    ("h", 1256, -17163, -16863, 56, "window"), ("h", 1256, -16056, -15756, 56, "window"),
    ("h", 1256, -14894, -14594, 56, "window"),
    ("h", 2194, -13956, -13675, 56, "window"), ("h", 2194, -13637, -13356, 56, "window"),
    ("h", 2194, -13131, -12569, 56, "door2"),
    ("h", 2194, -12344, -12062, 56, "window"), ("h", 2194, -12025, -11744, 56, "window"),
    ("h", 2494, -16966, -16525, 56, "opening"),
    ("h", 2878, -16891, -16591, 38, "door"), ("h", 2878, -16056, -15756, 38, "door"),
    ("h", 3478, -14838, -14575, 38, "door"), ("h", 3478, -11870, -11308, 38, "closet"),
    ("h", 3740, -12353, -12053, 37, "door"), ("h", 3740, -10956, -10731, 37, "window"),
    ("h", 3938, -16047, -15785, 37, "closet"), ("h", 3938, -15681, -15006, 37, "opening"),
    ("h", 4190, -12400, -12137, 37, "door"), ("h", 4190, -11781, -11481, 37, "door"),
    ("h", 4190, -10956, -10731, 37, "opening"),
    ("h", 4978, -15288, -14538, 38, "opening"),
    ("h", 5503, -15250, -14931, 38, "door"),
    ("h", 6037, -13703, -13478, 38, "window"), ("h", 6046, -13459, -13234, 57, "window"),
    ("h", 6046, -12981, -12531, 57, "window"),
    ("h", 7125, -17932, -17613, 56, "door"),
    ("h", 7602, -15128, -14809, 37, "door"),
    ("h", 8596, -16056, -15756, 37, "door"),
    ("h", 8802, -17022, -16628, 37, "closet"),
    ("h", 9074, -17463, -17181, 37, "closet"), ("h", 9074, -16094, -15484, 37, "opening"),
    ("h", 11774, -15813, -15494, 37, "door"),
    ("h", 12421, -16244, -15925, 38, "door"),
    ("h", 13574, -17003, -16760, 56, "window"), ("h", 13574, -16722, -16478, 56, "window"),
    ("h", 13574, -15709, -15466, 56, "window"), ("h", 13574, -14678, -14434, 56, "window"),
    ("v", -18541, 4603, 6628, 56, "garage"),
    ("v", -17960, 10363, 11038, 56, "window"),
    ("v", -17547, 1425, 2325, 56, "window"), ("v", -17547, 2578, 2803, 56, "window"),
    ("v", -17547, 3037, 3937, 56, "window"),
    ("v", -17547, 7884, 8184, 56, "window"), ("v", -17547, 8221, 8521, 56, "window"),
    ("v", -17547, 9215, 9553, 56, "door"),
    ("v", -17547, 11985, 12435, 56, "window"), ("v", -17547, 12941, 13391, 56, "window"),
    ("v", -17275, 9684, 10003, 38, "opening"), ("v", -17275, 11015, 11334, 38, "opening"),
    ("v", -17125, 12834, 13152, 38, "door"),
    ("v", -16984, 2541, 2841, 37, "door"), ("v", -16506, 2527, 2789, 37, "door"),
    ("v", -16132, 2044, 2381, 37, "door"),
    ("v", -16132, 3337, 3637, 37, "door"),
    ("v", -16112, 8700, 9018, 37, "door"),
    ("v", -15869, 12477, 12796, 38, "door"),
    ("v", -15672, 5081, 5400, 56, "door"),
    ("v", -15466, 8700, 9018, 37, "door"),
    ("v", -15194, 7706, 8043, 38, "closet"), ("v", -15194, 8156, 8493, 38, "closet"),
    ("v", -14519, 3544, 3881, 38, "opening"), ("v", -14519, 4378, 4715, 38, "opening"),
    ("v", -14266, 6595, 7045, 56, "window"),
    ("v", -14266, 8020, 8320, 56, "window"), ("v", -14266, 8357, 8657, 56, "window"),
    ("v", -14266, 9206, 9768, 56, "slider"), ("v", -14266, 11081, 11643, 56, "slider"),
    ("v", -14266, 12313, 12651, 56, "window"), ("v", -14266, 12688, 13026, 56, "window"),
    ("v", -12456, 3797, 4134, 38, "opening"),
    ("v", -12447, 5531, 5868, 56, "door"),
    ("v", -11425, 3834, 4097, 38, "door"),
    ("v", -11172, 2334, 2559, 56, "window"), ("v", -11172, 3131, 3356, 56, "window"),
    ("v", -10496, 4659, 4997, 57, "window"),
]

# Tags that A2.0 leaves off, read from the elevations (A3.1): keyed by (orient, line, a)
TAG_OVERRIDES = {
    ("v", -14266, 9206): "5070 FX",     # living room east, south
    ("v", -14266, 11081): "5080 SGD",   # living room east, north (sliding glass door)
    ("v", -18541, 4603): "18080 OHD",   # garage door
    ("h", 9074, -17463): "2680 DR",     # coat closet
    ("h", 2194, -13131): "5080 DR",     # great-room French doors
}

BONUS_OPENINGS = [
    ("h", 2184, -4925, -4588, 37, "window"),
    ("h", 4396, -4287, -4025, 37, "door"),
    ("h", 4396, -3641, -3191, 37, "closet"),
    ("v", -6425, 4134, 4565, 38, "opening"),
    ("v", -4344, 2433, 2733, 38, "door"),
    ("v", -4344, 3928, 4228, 38, "door"),
    ("v", -4344, 4565, 4828, 38, "door"),
    ("v", -3068, 3703, 4040, 37, "window"),
]

# --------------------------------------------------------------------------
# 4. Heights (mm), from section A4.1 and elevations A3.1
# --------------------------------------------------------------------------
MAIN_CEIL = 3048            # 10'-0" CLG
MAIN_HEAD = 2438            # 8'-0" HDR (A3.1, A4.1): every main-floor window and door head
BONUS_HEAD = 2083           # 6'-10" upstairs window head (A3.1 front elevation)
FLOOR_TO_FLOOR = 3353       # bonus finished floor at 11'-0" (section 2)
BONUS_CEIL = 2134           # 7'-0" CLG
RISERS = 18                 # 4-tread north run + landing + 12-tread south run
TREAD_U = 93.75             # 10" treads


# --------------------------------------------------------------------------
# 5. Roof (S2.0 ridges + A3.1 heights). Footprints include the 1'-6" overhang.
#    gable/hip: ridge axis 'x' (runs east-west) or 'y'; ridgeAt in units;
#    ridgeZ absolute mm; pitch rise/run; ends: [low end, high end] types.
#    shed: high side n/s/e/w, zHigh mm.
# --------------------------------------------------------------------------
O = 169   # 1'-6" overhang in units
SHED_TOP = 3556   # metal porch roofs top out at 11'-8" against the house (A3.1)
ROOF = [
    # One continuous 12:12 ridge at 25'-7" runs over both west wings (A3.1 left elevation).
    dict(id="north", kind="gable", rect=(-17575 - O, 5300, -14238 + O, 13602 + O), axis="y",
         ridgeAt=-15906.5, ridgeZ=7820, pitch=1.0, ends=["open", "gable"],
         note="North wing 12:12, ridge 25'-7\""),
    dict(id="pantry", kind="gable", rect=(-17988 - O, 9590 - O, -16463, 11812 + O), axis="x",
         ridgeAt=10701, ridgeZ=6310, pitch=1.0, ends=["gable", "open"], note="Pantry gable 12:12, 20'-7\", faces west"),
    dict(id="garage", kind="gable", rect=(-18569 - O, 4097 - O, -15765, 7153 + O), axis="x",
         ridgeAt=5625, ridgeZ=7439, pitch=1.0, ends=["gable", "open"], note="Garage gable 12:12, 24'-5\", faces west"),
    # Over the stair the 12:12 roof stops ~20'-5" up, east of the ridge (A4.1 section 2),
    # and the 9:12 stair roof covers the rest, so the stair keeps its headroom.
    dict(id="ridge-link", kind="gable", rect=(-16700, 4097, -15329, 5300), axis="y",
         ridgeAt=-15906.5, ridgeZ=7820, pitch=1.0, ends=["open", "open"],
         note="Main ridge carried over the stair"),
    dict(id="southwest", kind="gable", rect=(-17575 - O, 1228 - O, -14481 + O, 4097), axis="y",
         ridgeAt=-15906.5, ridgeZ=7820, pitch=1.0, ends=["gable", "open"],
         gableWindows=[dict(end=0, tag="2640 FX", head=5486)],
         note="South-west suite 12:12, same ridge as the north wing"),
    dict(id="stairhall", kind="gable", rect=(-16300, 3600, -14500, 5500), axis="x",
         ridgeAt=4547, ridgeZ=7077, pitch=0.75, ends=["open", "open"], note="Stair roof 9:12, ridge 23'-2\""),
    dict(id="bonus", kind="gable", rect=(-14500 - O, 1875, -11144 + O, 6075 + O), axis="x",
         ridgeAt=3955, ridgeZ=7798, pitch=7 / 12, ends=["gable", "gable"], gableBase=5487,
         note="Bonus room 7:12, ridge 25'-7\""),
    dict(id="cross", kind="gable", rect=(-13488 - O, 2166 - O, -12175 + O, 3955), axis="y",
         ridgeAt=-12832, ridgeZ=7081, pitch=10 / 12, ends=["gable", "open"], note="Great-room cross gable 10:12"),
    dict(id="east", kind="gable", rect=(-11144, 3703 - O, -10468 + O, 5503 + O), axis="x",
         ridgeAt=4603, ridgeZ=5080, pitch=0.75, ends=["open", "gable"], note="East gable 9:12, 16'-8\""),
    dict(id="porch-e", kind="shed", rect=(-14238, 7050, -13112 + O, 13602 + O), high="w", zHigh=SHED_TOP, pitch=1 / 12),
    dict(id="porch-r1", kind="shed", rect=(-12419, 5503, -10468 + O, 7050 + O), high="s", zHigh=SHED_TOP, pitch=1 / 12),
    dict(id="porch-r2", kind="shed", rect=(-14238, 6075, -12419, 7050 + O), high="s", zHigh=SHED_TOP, pitch=1 / 12),
    dict(id="patio-s", kind="shed", rect=(-14481 - O, 1491 - O, -10468 + O, 2166), high="n", zHigh=SHED_TOP, pitch=1 / 12),
    dict(id="patio-e", kind="shed", rect=(-11144, 2166, -10468 + O, 3703), high="w", zHigh=SHED_TOP, pitch=1 / 12),
]
# Infill walls between a lower plate and a roof above it: (x1,y1,x2,y2,z0,roofId)
SKIRTS = [
    (-14538, 6018, -12419, 6075, MAIN_CEIL, "bonus"),     # kitchen north wall up to the bonus roof
    (-14481, 2166, -13488, 2222, MAIN_CEIL, "bonus"),     # great-room south wall, west of the cross gable
    (-12175, 2166, -11144, 2222, MAIN_CEIL, "bonus"),     # great-room south wall, east of the cross gable
]


# Porch beams under the shed roofs (A3.1): 10x12 on the front patio, 8x12 elsewhere.
# (x1, y1, x2, y2 units, depth mm, shed id)
BEAMS = [
    (-14538, 1481, -10468, 1575, 305, "patio-s"),
    (-10552, 1575, -10459, 3703, 305, "patio-e"),
    (-10552, 5503, -10459, 7050, 305, "porch-r1"),
    (-12419, 6966, -10468, 7059, 305, "porch-r1"),
    (-14238, 6966, -12419, 7059, 305, "porch-r2"),
    (-13196, 7059, -13103, 13602, 305, "porch-e"),
    (-14238, 13518, -13112, 13611, 305, "porch-e"),
]


def shed_z(r, e, n):
    """Height (mm) of a shed roof plane at unit point (e, n)."""
    x1, y1, x2, y2 = r["rect"]
    d = {"n": y2 - n, "s": n - y1, "e": x2 - e, "w": e - x1}[r["high"]] * U
    return r["zHigh"] - d * r["pitch"]


def roof_z(r, e, n):
    """Height (mm) of a gable roof plane at unit point (e, n)."""
    d = abs((n if r["axis"] == "x" else e) - r["ridgeAt"]) * U
    return r["ridgeZ"] - d * r["pitch"]


# --------------------------------------------------------------------------
# 6. Default furniture (units; rot degrees as the app defines it)
# --------------------------------------------------------------------------
MAIN_FURN = [
    # master suite (north)
    ("bed-king", -15000, 13171, 0), ("nightstand", -15460, 13470, 0), ("nightstand", -14540, 13470, 0),
    ("dresser", -15100, 11890, 180), ("lounge", -14520, 12050, 45),
    ("tub", -16800, 13380, 0), ("vanity", -16730, 12545, 0, 1650, 550), ("toilet", -17400, 13420, 180),
    ("shower", -16090, 13236, 0, 1080, 1650),
    ("shelf", -16700, 11870, 0, 3200, 450), ("shelf", -16780, 12330, 0, 2300, 450),
    # kitchen + living (north)
    ("island", -16265, 10505, 0, 1165, 2950),
    ("counter", -17150, 10500, 0, 600, 2700), ("range", -17150, 10560, 270),
    ("counter", -16780, 11650, 0, 2600, 600), ("fridge", -16100, 11620, 180),
    ("chair", -15930, 10050, 270), ("chair", -15930, 10350, 270), ("chair", -15930, 10650, 270), ("chair", -15930, 10950, 270),
    ("rug", -15200, 10450, 90), ("sofa3", -15640, 10450, 90), ("coffee", -15250, 10450, 90),
    ("armchair", -14560, 10950, 270), ("armchair", -14560, 9950, 270),
    ("shelf", -17840, 11250, 0, 450, 1800), ("shelf", -17840, 10150, 0, 450, 1800),
    ("console", -17000, 9180, 0), ("plant", -16000, 9200, 0),
    # guest wing
    ("bed-queen", -16930, 7996, 180), ("nightstand", -17330, 7700, 0), ("nightstand", -16530, 7700, 0),
    ("dresser-t", -16820, 8930, 0), ("tub", -15812, 7700, 0, 1500, 700), ("toilet", -15610, 8040, 270),
    ("vanity", -15590, 8390, 270, 900, 550),
    ("desk", -14435, 8475, 90), ("deskchair", -14640, 8475, 270), ("bookshelf", -15330, 8100, 90),
    # laundry, garage, halls
    ("washer", -14425, 7330, 270), ("dryer", -14425, 7050, 270), ("sink", -14420, 6790, 270),
    ("washer", -14425, 6500, 270), ("dryer", -14425, 6230, 270),
    ("counter", -15530, 6600, 0, 600, 3000),
    ("car", -17470, 4850, 90), ("car", -17470, 6150, 90), ("workbench", -15810, 6250, 90),
    ("bench", -15340, 4040, 0, 1500, 400),
    # south-west suite
    ("bed-king", -14910, 2070, 90), ("nightstand", -14600, 2590, 0), ("nightstand", -14600, 1550, 0),
    ("dresser", -15500, 1350, 0), ("vanity", -17418, 1850, 90, 2700, 550),
    ("shower", -16670, 1640, 0, 1250, 1850), ("toilet", -17410, 2700, 90),
    ("washer", -16330, 3140, 0), ("shelf", -16850, 3980, 0, 3000, 400), ("shelf", -17440, 3450, 90, 1700, 400),
    ("shelf", -15100, 2975, 0, 2800, 400),
    # south-east kitchen / dining / great room
    ("island", -13930, 5240, 0, 1981, 1067),
    ("chair", -14130, 4985, 0), ("chair", -13930, 4985, 0), ("chair", -13730, 4985, 0),
    ("counter", -13850, 5910, 0, 3600, 600), ("range", -14400, 5480, 270), ("fridge", -14400, 5100, 270),
    ("counter", -12570, 5000, 0, 600, 1500),
    ("diningtable", -13750, 4375, 0, 2400, 900),
    ("chair", -14030, 4585, 180), ("chair", -13750, 4585, 180), ("chair", -13470, 4585, 180),
    ("chair", -14030, 4165, 0), ("chair", -13750, 4165, 0), ("chair", -13470, 4165, 0),
    ("chair", -14270, 4375, 90), ("chair", -13230, 4375, 270),
    ("rug", -13500, 3150, 0), ("sofa3", -13500, 3530, 180), ("coffee", -13500, 3100, 0),
    ("armchair", -14100, 2950, 90), ("armchair", -12900, 2950, 270), ("tvconsole", -13800, 2290, 0),
    # bath 2, bed 2, bed 1
    ("tub", -12156, 5310, 0, 1500, 760), ("toilet", -11970, 4920, 270), ("vanity", -11975, 4500, 270, 900, 550),
    ("bed-queen", -11180, 5072, 0), ("nightstand", -11620, 5370, 0), ("nightstand", -10740, 5370, 0),
    ("bed-queen", -11575, 2860, 90), ("nightstand", -11285, 3310, 0), ("nightstand", -11285, 2400, 0),
    ("shelf", -10840, 3880, 0, 1600, 400),
    # outdoor
    ("bistrotbl", -12000, 1830, 0), ("chair", -12230, 1830, 90), ("chair", -11770, 1830, 270),
    ("bbq", -10800, 1830, 0), ("lounge", -11800, 6550, 0), ("lounge", -11400, 6550, 0),
    ("lounge", -13700, 9600, 270), ("lounge", -13700, 10600, 270), ("planter", -13650, 12800, 0),
]
BONUS_FURN = [   # bonus-plan units
    ("rug", -5400, 4300, 0), ("sofa3", -5400, 3780, 0), ("coffee", -5400, 4300, 0),
    ("tvconsole", -5400, 5130, 180), ("armchair", -6080, 4380, 90), ("armchair", -4720, 4380, 270),
    ("desk", -4900, 2370, 0), ("deskchair", -4900, 2560, 180), ("bookshelf", -5320, 2800, 90),
    ("bed-queen", -3640, 3441, 180), ("nightstand", -4070, 3140, 0), ("nightstand", -3220, 3140, 0),
    ("dresser", -3700, 4290, 180, 1300, 450),
    ("vanity", -4150, 5120, 180, 1000, 550), ("toilet", -3830, 5070, 180), ("shower", -3256, 4940, 0, 880, 1400),
    ("shelf", -3415, 4590, 0, 1700, 400), ("shelf", -4222, 2615, 90, 2100, 400),
]


# --------------------------------------------------------------------------
def build(pdf):
    walls = extract_walls(pdf)
    main_w = [r for r in walls if r[2] < SPLIT_E]
    bonus_w = [r for r in walls if r[0] > SPLIT_E]

    def wall_out(r, bonus=False):
        x1, y1 = mm(r[0], r[1], bonus)
        x2, y2 = mm(r[2], r[3], bonus)
        return [x1, y1, x2, y2]

    def diag_out(d):
        x1, y1 = mm(d[0], d[1])
        x2, y2 = mm(d[2], d[3])
        return {"d": [x1, y1, x2, y2], "t": mmlen(d[4])}

    def room_out(rm, bonus=False):
        rid, name, kind, flags, rects = rm
        out = []
        for i, r in enumerate(rects):
            x1, y1 = mm(r[0], r[1], bonus)
            x2, y2 = mm(r[2], r[3], bonus)
            o = {"id": rid, "name": name, "kind": kind, "x1": x1, "y1": y1, "x2": x2, "y2": y2}
            for k, v in flags.items():
                if i == 0 or k in ("porch", "patio", "stair", "void", "vaulted"):
                    o[k] = v
            if i > 0:
                o["part"] = True
            out.append(o)
        return out

    def op_out(o, bonus=False):
        orient, at, a, b, th, typ = o
        if orient == "h":
            xa, yat = mm(a, at, bonus)
            xb, _ = mm(b, at, bonus)
            out = {"o": "h", "at": yat, "a": xa, "b": xb, "thick": mmlen(th), "type": typ}
            cx, cy = (a + b) / 2, at
        else:
            xat, ya = mm(at, a, bonus)
            _, yb = mm(at, b, bonus)
            out = {"o": "v", "at": xat, "a": ya, "b": yb, "thick": mmlen(th), "type": typ}
            cx, cy = at, (a + b) / 2
        tag = TAG_OVERRIDES.get((orient, at, a))
        if not tag and typ not in ("opening",):
            want = ("FX", "SH", "PIC") if typ == "window" else ("DR", "PKT", "SGD")
            best = None
            for t, te, tn in tags:
                if t.split()[1] not in want:
                    continue
                d = abs(te - cx) + abs(tn - cy)
                if d < 330 and (best is None or d < best[0]):
                    best = (d, t)
            tag = best and best[1]
        if tag:
            kind = tag.split()[1]
            w_mm, h_mm = tag_size(tag)
            out["tag"] = tag
            out["height"] = h_mm
            if kind in ("FX", "SH", "PIC"):
                out["type"] = "window"
                out["style"] = "sh" if kind == "SH" else "fx"
                out["sill"] = (BONUS_HEAD if bonus else MAIN_HEAD) - h_mm
            elif kind == "SGD":
                out["type"] = "slider"
            elif kind == "PKT":
                out["type"] = "pocket"
            elif typ == "closet" and w_mm >= 1000:
                pass                                   # bifold pair, keep
            elif typ == "closet":
                out["type"] = "door"
        elif typ == "window":
            untagged.append(out)
        return out

    def furn_out(f, level, bonus=False):
        t, e, n, rot = f[:4]
        x, y = mm(e, n, bonus)
        o = {"type": t, "x": x, "y": y, "rot": rot, "level": level}
        if len(f) > 4:
            o["w"], o["h"] = f[4], f[5]
        return o

    untagged = []
    tags = extract_tags(pdf)

    # stair (main units)
    riser = FLOOR_TO_FLOOR / RISERS
    treads = []
    for k in range(1, 5):            # north run, climbing west
        e2 = -15288 - (k - 1) * TREAD_U
        e1 = e2 - TREAD_U
        x1, y1 = mm(e1, 4547)
        x2, y2 = mm(e2, 4959)
        treads.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "z": round(k * riser)})
    lx1, ly1 = mm(-16056, 4134)
    lx2, ly2 = mm(-15663, 4959)
    treads.append({"x1": lx1, "y1": ly1, "x2": lx2, "y2": ly2, "z": round(5 * riser), "landing": True})
    for k in range(1, 13):           # south run, climbing east
        e1 = -15663 + (k - 1) * TREAD_U
        e2 = e1 + TREAD_U
        x1, y1 = mm(e1, 4134)
        x2, y2 = mm(e2, 4547)
        treads.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "z": round((5 + k) * riser)})
    gx1, gy = mm(-15663, 4547)
    gx2, _ = mm(-14538, 4547)
    stair = {
        "riser": round(riser, 1), "treads": treads,
        # guard rail on the open side of the upper run (bonus side of the void)
        "rail": {"x1": gx1, "y1": gy - 20, "x2": gx2, "y2": gy + 20},
        "arrowUp": [mm(-15240, 4753), mm(-15900, 4753)],
    }

    roof = []
    for r in ROOF:
        x1, y1 = mm(r["rect"][0], r["rect"][1])
        x2, y2 = mm(r["rect"][2], r["rect"][3])
        o = {"id": r["id"], "kind": r["kind"], "x1": x1, "y1": y1, "x2": x2, "y2": y2, "pitch": round(r["pitch"], 4)}
        if r["kind"] == "shed":
            o.update(high=r["high"], zHigh=r["zHigh"])
        else:
            ra = mm(r["ridgeAt"], 0)[0] if r["axis"] == "y" else mm(0, r["ridgeAt"])[1]
            o.update(axis=r["axis"], ridgeAt=ra, ridgeZ=r["ridgeZ"], ends=r["ends"])
            if "gableBase" in r:
                o["gableBase"] = r["gableBase"]
        if "note" in r:
            o["note"] = r["note"]
        roof.append(o)
    roof_by_id = {r["id"]: r for r in ROOF}
    beams = []
    for bx in BEAMS:
        x1, y1 = mm(bx[0], bx[1])
        x2, y2 = mm(bx[2], bx[3])
        top = round(shed_z(roof_by_id[bx[5]], (bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2) - 60)
        beams.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "z0": top - bx[4], "z1": top})
    for r, o in zip(ROOF, roof):
        if "gableWindows" in r:
            o["gableWindows"] = [dict(end=g["end"], tag=g["tag"], w=tag_size(g["tag"])[0],
                                      h=tag_size(g["tag"])[1], head=g["head"]) for g in r["gableWindows"]]
    skirts = []
    for s in SKIRTS:
        x1, y1 = mm(s[0], s[1])
        x2, y2 = mm(s[2], s[3])
        rr = roof_by_id[s[5]]
        z1 = round(roof_z(rr, (s[0] + s[2]) / 2, (s[1] + s[3]) / 2))
        skirts.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "z0": s[4], "z1": z1})

    plan = {
        "source": "Peterson 20251216.pdf — A1.0 (plans), A4.1 (sections), A3.1 (elevations), S2.0 (roof)",
        "dims": {
            "doorHeight": MAIN_HEAD, "headerHeight": MAIN_HEAD, "windowSill": 914, "windowTop": MAIN_HEAD,
            "floorThick": FLOOR_TO_FLOOR - MAIN_CEIL,
        },
        "levels": [
            {"id": "main", "name": "Main floor", "elev": 0, "height": MAIN_CEIL,
             "rooms": [o for rm in MAIN_ROOMS for o in room_out(rm)],
             "walls": [wall_out(r) for r in main_w] + [diag_out(d) for d in DIAG_MAIN],
             "openings": [op_out(o) for o in MAIN_OPENINGS],
             "stair": stair},
            {"id": "bonus", "name": "Bonus floor", "elev": FLOOR_TO_FLOOR, "height": BONUS_CEIL,
             "windowSill": 762, "windowTop": BONUS_HEAD, "doorHeight": 2032,
             "rooms": [o for rm in BONUS_ROOMS for o in room_out(rm, True)],
             "walls": [wall_out(r, True) for r in bonus_w],
             "openings": [op_out(o, True) for o in BONUS_OPENINGS]},
        ],
        "roof": roof,
        "skirts": skirts,
        "beams": beams,
        "overhang": mmlen(O),
    }
    layout = [furn_out(f, "main") for f in MAIN_FURN] + [furn_out(f, "bonus", True) for f in BONUS_FURN]
    for u in untagged:
        print("  untagged window:", u)
    return plan, layout, (len(main_w), len(bonus_w))


HEADER = """/* ============================================================
   Peterson Residence — plan data, GENERATED by tools/extract_plan.py.
   Do not edit by hand: change the generator and re-run it.
   Source: Peterson 20251216.pdf (A1.0, A3.1, A4.1, S2.0).
   Units: millimetres. x -> east, y -> north, z -> up.
   Origin: garage west face (x) / south-west suite south face (y).
   Walls: [x1,y1,x2,y2] rectangles taken from the PDF wall fills,
          or {d:[x1,y1,x2,y2], t} for angled walls (centerline + thickness).
   ============================================================ */
"""


def main():
    pdf = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PDF
    plan, layout, counts = build(pdf)
    with open(os.path.join(ROOT, "data", "plan.js"), "w") as f:
        f.write(HEADER + "window.PET_PLAN = " + json.dumps(plan, indent=1) + ";\n")
    with open(os.path.join(ROOT, "data", "layout.js"), "w") as f:
        f.write("/* Default furniture layout — GENERATED by tools/extract_plan.py. */\n")
        f.write("window.PET_FURNITURE_DEFAULT = " + json.dumps(layout) + ";\n")
    print("main walls %d, bonus walls %d, furniture %d" % (counts[0], counts[1], len(layout)))
    # room-size check against the labels on A1.0
    for lvl in plan["levels"]:
        for r in lvl["rooms"]:
            if "label" in r and not r.get("part"):
                parts = [q for q in lvl["rooms"] if q["id"] == r["id"]]
                w = (max(q["x2"] for q in parts) - min(q["x1"] for q in parts)) / 304.8
                h = (max(q["y2"] for q in parts) - min(q["y1"] for q in parts)) / 304.8
                print("  %-15s label %-18s model %5.2f' x %5.2f'" % (r["name"], r["label"], w, h))


if __name__ == "__main__":
    main()
