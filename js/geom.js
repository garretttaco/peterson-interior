/* ============ Geometry engine: walls, openings, snapping, areas ============ */
(function (PET) {
  "use strict";

  /* ---------- rooms ---------- */
  /* Rooms are axis-aligned rects. A room made of several rects repeats its id;
     every rect after the first has `part: true` (no label, no list entry). */
  PET.roomArea = function (r) { return (r.x2 - r.x1) * (r.y2 - r.y1); };

  PET.roomParts = function (rooms, id) {
    return rooms.filter(function (r) { return r.id === id; });
  };

  PET.roomAreaById = function (rooms, id) {
    return PET.roomParts(rooms, id).reduce(function (s, r) { return s + PET.roomArea(r); }, 0);
  };

  PET.roomBounds = function (rooms, id) {
    var b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    PET.roomParts(rooms, id).forEach(function (r) {
      b.x1 = Math.min(b.x1, r.x1); b.y1 = Math.min(b.y1, r.y1);
      b.x2 = Math.max(b.x2, r.x2); b.y2 = Math.max(b.y2, r.y2);
    });
    return b;
  };

  /* smallest rect containing the point, so closets win over the room around them */
  PET.roomAt = function (plan, x, y) {
    var best = null, ba = Infinity;
    for (var i = 0; i < plan.rooms.length; i++) {
      var r = plan.rooms[i];
      if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2) {
        var a = PET.roomArea(r);
        if (a < ba) { ba = a; best = r; }
      }
    }
    return best;
  };

  /* ---------- walls + openings for one level ----------
     Walls come from the PDF as rectangles ([x1,y1,x2,y2]) or angled
     centerlines ({d:[x1,y1,x2,y2], t}). Openings are the gaps between wall
     rects, so walls never need splitting here.
     wall = { id, o:'h'|'v'|'d', at, a, b, thick, x1,y1,x2,y2 (centerline),
              rect, ext, load, kind:'wall'|'post'|'trim', out (+1/-1 side
              facing outdoors, exterior walls only) }                       */
  PET.buildLevel = function (plan, level) {
    var indoor = level.rooms.filter(function (r) { return !r.patio && !r.porch; });
    function inside(x, y) {
      for (var i = 0; i < indoor.length; i++) {
        var r = indoor[i];
        if (x >= r.x1 - 1 && x <= r.x2 + 1 && y >= r.y1 - 1 && y <= r.y2 + 1) return true;
      }
      return false;
    }

    var walls = level.walls.map(function (src, i) {
      var w = { id: level.id + "-w" + i, level: level.id };
      if (Array.isArray(src)) {
        var rx1 = Math.min(src[0], src[2]), rx2 = Math.max(src[0], src[2]);
        var ry1 = Math.min(src[1], src[3]), ry2 = Math.max(src[1], src[3]);
        w.rect = { x1: rx1, y1: ry1, x2: rx2, y2: ry2 };
        var wx = rx2 - rx1, wy = ry2 - ry1;
        if (wx >= wy) {
          w.o = "h"; w.at = (ry1 + ry2) / 2; w.a = rx1; w.b = rx2; w.thick = wy;
          w.x1 = rx1; w.y1 = w.at; w.x2 = rx2; w.y2 = w.at;
        } else {
          w.o = "v"; w.at = (rx1 + rx2) / 2; w.a = ry1; w.b = ry2; w.thick = wx;
          w.x1 = w.at; w.y1 = ry1; w.x2 = w.at; w.y2 = ry2;
        }
        w.kind = (wx >= 140 && wx < 260 && wy >= 140 && wy < 260 && Math.abs(wx - wy) < 30) ? "post"
               : (w.thick < 60 ? "trim" : "wall");
      } else {
        w.o = "d"; w.thick = src.t;
        w.x1 = src.d[0]; w.y1 = src.d[1]; w.x2 = src.d[2]; w.y2 = src.d[3];
        w.a = 0; w.b = PET.dist(w.x1, w.y1, w.x2, w.y2);
        w.rect = {
          x1: Math.min(w.x1, w.x2) - w.thick / 2, y1: Math.min(w.y1, w.y2) - w.thick / 2,
          x2: Math.max(w.x1, w.x2) + w.thick / 2, y2: Math.max(w.y1, w.y2) + w.thick / 2,
        };
        w.kind = "wall";
      }

      /* exterior = one side of the wall is not inside any indoor room */
      w.ext = false;
      if (w.kind === "post") {
        w.ext = true;
      } else if (w.o !== "d" && w.b - w.a > 150) {
        var off = w.thick / 2 + 120, mid = (w.a + w.b) / 2;
        var pA = w.o === "h" ? [mid, w.at - off] : [w.at - off, mid];
        var pB = w.o === "h" ? [mid, w.at + off] : [w.at + off, mid];
        var inA = inside(pA[0], pA[1]), inB = inside(pB[0], pB[1]);
        if (inA !== inB) { w.ext = true; w.out = inA ? 1 : -1; }
        else if (!inA && !inB) { w.ext = true; w.out = 1; }
      }
      w.load = w.ext && w.kind !== "trim";
      return w;
    });

    var openings = (level.openings || []).map(function (o, i) {
      var op = Object.assign({}, o);
      op.id = level.id + "-op" + i;
      op.w = op.b - op.a;
      return op;
    });

    return { walls: walls, openings: openings };
  };

  /* openings that sit on a given wall line (used for labels/QA only) */
  PET.openingsOn = function (wall, openings, pad) {
    pad = pad || 2;
    if (wall.o === "d") return [];
    return openings.filter(function (op) {
      return op.o === wall.o && Math.abs(op.at - wall.at) <= pad &&
             op.a >= wall.a - 1 && op.b <= wall.b + 1;
    }).sort(function (a, b) { return a.a - b.a; });
  };

  /* nearest wall to a point within maxDist */
  PET.wallAt = function (walls, x, y, maxDist) {
    var best = null, bd = maxDist;
    walls.forEach(function (w) {
      var d = PET.distToSeg(x, y, w.x1, w.y1, w.x2, w.y2) - w.thick / 2;
      if (d < bd) { bd = d; best = w; }
    });
    return best;
  };

  /* corners of an angled wall, for drawing and collision */
  PET.wallPoly = function (w) {
    var dx = w.x2 - w.x1, dy = w.y2 - w.y1, L = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / L * w.thick / 2, ny = dx / L * w.thick / 2;
    return [
      { x: w.x1 + nx, y: w.y1 + ny }, { x: w.x2 + nx, y: w.y2 + ny },
      { x: w.x2 - nx, y: w.y2 - ny }, { x: w.x1 - nx, y: w.y1 - ny },
    ];
  };

  /* ---------- clamp furniture inside its room ----------
     Room rects sit on the wall faces, so the room rect is the usable area. */
  PET.clampToRooms = function (items, walls, rooms) {
    items.forEach(function (f) {
      var r = PET.roomAt({ rooms: rooms }, f.x, f.y);
      if (!r) return;
      var b = PET.furnBounds(f);
      var w = b.x2 - b.x1, h = b.y2 - b.y1;
      /* a multi-part room clamps against the union of its parts on the axis
         where the parts continue, so pieces can straddle the seam */
      var u = r.part || rooms.some(function (q) { return q.id === r.id && q !== r; })
        ? PET.roomBounds(rooms, r.id) : r;
      var ux1 = r.x1, ux2 = r.x2, uy1 = r.y1, uy2 = r.y2;
      if (u !== r) {
        var parts = PET.roomParts(rooms, r.id);
        parts.forEach(function (q) {
          if (q === r) return;
          if (q.y1 < r.y2 && q.y2 > r.y1) { ux1 = Math.min(ux1, q.x1); ux2 = Math.max(ux2, q.x2); }
          if (q.x1 < r.x2 && q.x2 > r.x1) { uy1 = Math.min(uy1, q.y1); uy2 = Math.max(uy2, q.y2); }
        });
      }
      if (ux2 - ux1 < w) { var cx = (ux1 + ux2) / 2; b.x1 = cx - w / 2; b.x2 = cx + w / 2; }
      else {
        if (b.x1 < ux1) { b.x2 += ux1 - b.x1; b.x1 = ux1; }
        if (b.x2 > ux2) { b.x1 -= b.x2 - ux2; b.x2 = ux2; }
      }
      if (uy2 - uy1 < h) { var cy = (uy1 + uy2) / 2; b.y1 = cy - h / 2; b.y2 = cy + h / 2; }
      else {
        if (b.y1 < uy1) { b.y2 += uy1 - b.y1; b.y1 = uy1; }
        if (b.y2 > uy2) { b.y1 -= b.y2 - uy2; b.y2 = uy2; }
      }
      f.x = Math.round((b.x1 + b.x2) / 2);
      f.y = Math.round((b.y1 + b.y2) / 2);
    });
    return items;
  };

  /* ---------- push default furniture out of walls ----------
     Deterministic: for each item, translate along the axis of least
     penetration until it clears every wall rect it overlaps. */
  PET.decollideWalls = function (items, walls) {
    var rects = walls.filter(function (w) { return w.o !== "d"; }).map(function (w) { return w.rect; });
    items.forEach(function (f) {
      for (var iter = 0; iter < 8; iter++) {
        var b = PET.furnBounds(f);
        var moved = false;
        for (var i = 0; i < rects.length; i++) {
          var r = rects[i];
          if (!PET.rectsOverlap(b, r)) continue;
          var ox1 = r.x1 - b.x2, ox2 = r.x2 - b.x1;        // push left (neg) or right (pos)
          var oy1 = r.y1 - b.y2, oy2 = r.y2 - b.y1;
          var pushX = Math.abs(ox1) < Math.abs(ox2) ? ox1 : ox2;
          var pushY = Math.abs(oy1) < Math.abs(oy2) ? oy1 : oy2;
          if (Math.abs(pushX) < Math.abs(pushY)) f.x += pushX + (pushX > 0 ? 2 : -2);
          else f.y += pushY + (pushY > 0 ? 2 : -2);
          moved = true;
          break;
        }
        if (!moved) break;
      }
    });
    return items;
  };

  /* ---------- furniture snapping ---------- */
  /* Snap an axis-aligned furniture rect to wall faces & other furniture.
     f: {x,y,w,h,rot}, items: furniture on the same level, walls: wall segments.
     Returns adjusted {x,y} (or null if no snap). */
  PET.snapFurniture = function (f, walls, items, excludeId) {
    var rot = ((f.rot || 0) % 180 + 180) % 180;
    if (Math.abs(rot % 90) > 0.5) return null;   // only snap axis-aligned
    var fw = rot === 90 ? f.h : f.w, fh = rot === 90 ? f.w : f.h;

    var x1 = f.x - fw / 2, x2 = f.x + fw / 2;
    var y1 = f.y - fh / 2, y2 = f.y + fh / 2;
    var WALL_TOL = 150, ITEM_TOL = 60;

    var vLines = [], hLines = [];   // candidate snap lines
    walls.forEach(function (w) {
      if (w.demolished || w.o === "d") return;
      var r = w.rect;
      vLines.push({ x: r.x1, a: r.y1, b: r.y2 });
      vLines.push({ x: r.x2, a: r.y1, b: r.y2 });
      hLines.push({ y: r.y1, a: r.x1, b: r.x2 });
      hLines.push({ y: r.y2, a: r.x1, b: r.x2 });
    });
    items.forEach(function (it) {
      if (it.id === excludeId) return;
      var b = PET.furnBounds(it);
      vLines.push({ x: b.x1, a: b.y1, b: b.y2, item: true });
      vLines.push({ x: b.x2, a: b.y1, b: b.y2, item: true });
      hLines.push({ y: b.y1, a: b.x1, b: b.x2, item: true });
      hLines.push({ y: b.y2, a: b.x1, b: b.x2, item: true });
    });

    function tryAxis(lines, lo, hi, isV) {
      var best = null;
      lines.forEach(function (L) {
        var tol = L.item ? ITEM_TOL : WALL_TOL;
        var at = isV ? L.x : L.y;
        var la = L.a - 4, lb = L.b + 4;
        var ovLo = isV ? y1 : x1, ovHi = isV ? y2 : x2;
        if (ovHi < la || ovLo > lb) return;       // no perpendicular overlap
        var dLo = at - lo;
        if (Math.abs(dLo) <= tol && (best === null || Math.abs(dLo) < Math.abs(best))) best = dLo;
        var dHi = at - hi;
        if (Math.abs(dHi) <= tol && (best === null || Math.abs(dHi) < Math.abs(best))) best = dHi;
      });
      return best;
    }

    var dx = tryAxis(vLines, x1, x2, true);
    var dy = tryAxis(hLines, y1, y2, false);
    if (dx === null && dy === null) return null;
    return { x: f.x + (dx || 0), y: f.y + (dy || 0), snappedX: dx !== null, snappedY: dy !== null };
  };

})(window.PET);
