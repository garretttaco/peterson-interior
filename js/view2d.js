/* ============ 2D plan view: canvas renderer + interactions ============ */
(function (PET) {
  "use strict";

  var canvas, ctx, dpr = 1;
  var W = 0, H = 0;
  var view = { cx: 11000, cy: 16800, scale: 0.035 };   // px per mm, world point at screen centre
  var hover = null;            // {kind:'furniture'|'wall'|'room', id}
  var drag = null;             // active drag state
  var measureP1 = null;        // first click of measure tool
  var mouseWorld = { x: 0, y: 0 };
  var snapGuides = [];         // lines to flash while snapping
  var spaceDown = false;

  var COL = {
    paper: "#f6f4ef",
    grid: "#e7e4dc",
    wallLoad: "#3c4351",
    wallEdge: "#2c313c",
    wallPart: "#c8ccd2",
    wallPartEdge: "#9aa0a9",
    wallPorch: "#b9c6cd",
    demo: "#e5484d",
    accent: "#f5a623",
    accentSoft: "rgba(245,166,35,.18)",
    blue: "#3f88d8",
    glass: "#bfe0ef",
    dim: "#7a8290",
    text: "#2a2f38",
    textDim: "#7d8590",
    selection: "#f5a623",
  };

  /* ---------- transforms ---------- */
  function w2s(x, y) {
    return { x: (x - view.cx) * view.scale + W / 2, y: H / 2 - (y - view.cy) * view.scale };
  }
  function s2w(sx, sy) {
    return { x: (sx - W / 2) / view.scale + view.cx, y: view.cy - (sy - H / 2) / view.scale };
  }

  /* ---------- public ---------- */
  var api = {};

  api.init = function (el) {
    canvas = el;
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
    bindEvents();
    api.fit();
  };

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    var r = canvas.parentElement.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    api.render();
  }

  /* bounds of every level, so switching floors keeps the plan registered */
  function planBounds() {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    PET.store.levels.forEach(function (L) {
      L.def.rooms.forEach(function (r) {
        x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1);
        x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2);
      });
    });
    return { x1: x1, y1: y1, x2: x2, y2: y2 };
  }

  api.fit = function () {
    var b = planBounds();
    var x1 = b.x1, y1 = b.y1, x2 = b.x2, y2 = b.y2;
    var pad = 2600;
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
    view.cx = (x1 + x2) / 2;
    view.cy = (y1 + y2) / 2;
    view.scale = Math.min(W / (x2 - x1), H / (y2 - y1));
    api.render();
  };

  api.zoomToRoom = function (room) {
    room = PET.roomBounds(PET.store.plan.rooms, room.id);
    var pad = 1200;
    view.cx = (room.x1 + room.x2) / 2;
    view.cy = (room.y1 + room.y2) / 2;
    view.scale = Math.min(W / (room.x2 - room.x1 + pad * 2), H / (room.y2 - room.y1 + pad * 2)) * 0.92;
    api.render();
  };

  api.zoomBy = function (f, sx, sy) {
    var before = s2w(sx, sy);
    view.scale = PET.clamp(view.scale * f, 0.008, 0.6);
    var after = s2w(sx, sy);
    view.cx += before.x - after.x;
    view.cy += before.y - after.y;
    api.render();
  };

  api.getView = function () { return view; };

  /* ================= RENDER ================= */

  api.render = function () {
    if (!ctx) return;
    var g = { ctx: ctx, W: W, H: H, s: view.scale, cx: view.cx, cy: view.cy, dpr: dpr, boost: false };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(g);
    updateZoomLabel();
  };

  function updateZoomLabel() {
    var el = document.getElementById("st-zoom");
    if (el) el.textContent = Math.round(view.scale / 0.045 * 100) + "%";
  }

  function T(g, x, y) {   /* world -> screen (for a given render target) */
    return { x: (x - g.cx) * g.s + g.W / 2, y: g.H / 2 - (y - g.cy) * g.s };
  }

  function drawScene(g) {
    var ctx = g.ctx;
    ctx.fillStyle = COL.paper;
    ctx.fillRect(0, 0, g.W, g.H);
    drawGrid(g);
    drawGhost(g);
    drawRooms(g);
    drawStairs(g);
    drawWalls(g);
    drawOpenings(g);
    drawFurniture(g);
    drawRoomLabels(g);
    drawDimensions(g);
    drawMeasurements(g);
    drawSnapGuides(g);
    drawScaleBar(g);
    drawNorth(g);
  }

  function drawGrid(g) {
    var ctx = g.ctx;
    var step = 1000;    // 1 m
    while (step * g.s < 26) step *= 2;
    var tl = { x: (0 - g.W / 2) / g.s + g.cx, y: g.cy - (0 - g.H / 2) / g.s };
    var br = { x: (g.W - g.W / 2) / g.s + g.cx, y: g.cy - (g.H - g.H / 2) / g.s };
    var x0 = Math.floor(tl.x / step) * step, x1 = Math.ceil(br.x / step) * step;
    var y0 = Math.floor(br.y / step) * step, y1 = Math.ceil(tl.y / step) * step;
    ctx.save();
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = x0; x <= x1; x += step) {
      var a = T(g, x, y0), b = T(g, x, y1);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (var y = y0; y <= y1; y += step) {
      var c = T(g, x0, y), d = T(g, x1, y);
      ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawRooms(g) {
    var ctx = g.ctx;
    var store = PET.store;
    store.plan.rooms.forEach(function (r) {
      var mat = store.materialById(store.materials[r.id] || "oak");
      var a = T(g, r.x1, r.y2), b = T(g, r.x2, r.y1);
      if (r.void) {          /* open to the floor below (stair well) */
        ctx.fillStyle = "rgba(246,244,239,.6)";
        ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        crossHatch(ctx, a.x, a.y, b.x - a.x, b.y - a.y, "rgba(120,128,140,.28)");
        return;
      }
      ctx.fillStyle = r.porch ? "#dcd7cb" : mat.color2d;
      ctx.globalAlpha = r.patio ? 0.55 : 1;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.globalAlpha = 1;
      if (r.patio || r.porch) {
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = "rgba(90,95,105,.45)";
        ctx.lineWidth = 1.2;
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.restore();
      }
      if (store.selection && store.selection.kind === "room" && store.selection.id === r.id) {
        ctx.fillStyle = COL.accentSoft;
        ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.strokeStyle = COL.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      }
    });
  }

  /* faint outline of the floor below, for registration */
  function drawGhost(g) {
    var store = PET.store;
    if (store.level === "main") return;
    var below = store.levelById("main");
    var ctx = g.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(60,67,81,.13)";
    below.walls.forEach(function (w) { fillWall(g, w); });
    ctx.restore();
  }

  function drawStairs(g) {
    var ctx = g.ctx, store = PET.store;
    var main = store.levelById("main").def;
    var st = main.stair;
    if (!st) return;
    var up = store.level === "main";
    ctx.save();
    ctx.strokeStyle = up ? "#8d949c" : "rgba(141,148,156,.75)";
    ctx.lineWidth = 1;
    st.treads.forEach(function (t) {
      var a = T(g, t.x1, t.y2), b = T(g, t.x2, t.y1);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    });
    /* centre wall between the two runs */
    var rl = st.rail, ra = T(g, rl.x1, rl.y2), rb = T(g, rl.x2, rl.y1);
    ctx.fillStyle = "#9aa0a9";
    ctx.fillRect(ra.x, ra.y, rb.x - ra.x, Math.max(2, rb.y - ra.y));
    /* walking line: north run west, landing, south run east */
    var p0 = T(g, st.arrowUp[0][0], st.arrowUp[0][1]);
    var land = st.treads.filter(function (t) { return t.landing; })[0];
    var p1 = T(g, (land.x1 + land.x2) / 2, st.arrowUp[0][1]);
    var lowY = (st.treads[st.treads.length - 1].y1 + st.treads[st.treads.length - 1].y2) / 2;
    var p2 = T(g, (land.x1 + land.x2) / 2, lowY);
    var top = st.treads[st.treads.length - 1];
    var p3 = T(g, top.x2 - 150, lowY);
    ctx.strokeStyle = COL.textDim;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y);
    ctx.stroke();
    var tip = up ? p3 : p0, from = up ? p2 : p1;
    arrow(ctx, tip.x, tip.y, Math.atan2(tip.y - from.y, tip.x - from.x));
    ctx.fillStyle = COL.textDim;
    ctx.font = "600 10px Inter, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    var lbl = up ? p0 : p3;
    ctx.fillText(up ? "UP" : "DN", lbl.x + (up ? 14 : -14), lbl.y - 3);
    ctx.restore();
  }

  /* fill a wall shape with the current fillStyle */
  function fillWall(g, wall) {
    var ctx = g.ctx;
    if (wall.o === "d") {
      var P = PET.wallPoly(wall);
      ctx.beginPath();
      P.forEach(function (p, i) { var s2 = T(g, p.x, p.y); if (i) ctx.lineTo(s2.x, s2.y); else ctx.moveTo(s2.x, s2.y); });
      ctx.closePath();
      ctx.fill();
      return;
    }
    var a = T(g, wall.rect.x1, wall.rect.y2), b = T(g, wall.rect.x2, wall.rect.y1);
    ctx.fillRect(a.x, a.y, Math.max(1, b.x - a.x), Math.max(1, b.y - a.y));
  }

  function drawWalls(g) {
    var ctx = g.ctx, store = PET.store;
    store.walls.forEach(function (wall) {
      var demolished = !!store.demolished[wall.id];
      var hov = hover && hover.kind === "wall" && hover.id === wall.id && store.tool === "demolish";
      if (wall.o === "d") {
        var P = PET.wallPoly(wall).map(function (p) { return T(g, p.x, p.y); });
        ctx.beginPath();
        P.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
        ctx.closePath();
        ctx.fillStyle = COL.wallPart;
        ctx.fill();
        ctx.strokeStyle = hov ? COL.accent : COL.wallPartEdge;
        ctx.lineWidth = hov ? 2 : 1;
        ctx.stroke();
        return;
      }
      var a = T(g, wall.rect.x1, wall.rect.y2), b = T(g, wall.rect.x2, wall.rect.y1);
      var x = a.x, y = a.y, w = Math.max(1, b.x - a.x), h = Math.max(1, b.y - a.y);
      if (demolished) {
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = COL.demo;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
        crossHatch(ctx, x, y, w, h);
        return;
      }
      ctx.fillStyle = wall.load ? COL.wallLoad : (wall.kind === "trim" ? COL.wallPorch : COL.wallPart);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = wall.load ? COL.wallEdge : COL.wallPartEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      if (wall.load && w > 3 && h > 3) hatch(ctx, x, y, w, h);
      if (hov) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = wall.load ? COL.demo : COL.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
        ctx.restore();
      }
    });
  }

  function hatch(ctx, x, y, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = -h; i < w + h; i += 7) {
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function crossHatch(ctx, x, y, w, h, color) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = color || "rgba(229,72,77,.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = -h; i < w + h; i += 6) {
      ctx.moveTo(x + i, y); ctx.lineTo(x + i + h, y + h);
      ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- openings: doors, windows, sliders ---------- */
  function drawOpenings(g) {
    var ctx = g.ctx, store = PET.store;
    store.openings.forEach(function (op) {
      var c = op.o === "h" ? { x: (op.a + op.b) / 2, y: op.at } : { x: op.at, y: (op.a + op.b) / 2 };
      var w = op.w * g.s, tt = op.thick * g.s;
      var p = T(g, c.x, c.y);
      ctx.save();
      ctx.translate(p.x, p.y);
      if (op.o === "v") ctx.rotate(-Math.PI / 2);
      /* local frame: opening along +x, wall thickness on y */
      function jambs() {
        ctx.strokeStyle = COL.wallEdge;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-w / 2, -tt / 2); ctx.lineTo(-w / 2, tt / 2);
        ctx.moveTo(w / 2, -tt / 2); ctx.lineTo(w / 2, tt / 2);
        ctx.stroke();
      }
      function leaf(hx, dir, len, side) {      /* hinge x, swing direction ±1, leaf length */
        ctx.strokeStyle = "#8d949c";
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(hx, 0, len, dir > 0 ? -Math.PI / 2 : Math.PI, dir > 0 ? 0 : -Math.PI / 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(hx, 0); ctx.lineTo(hx, -len);
        ctx.stroke();
      }
      if (op.type === "window") {
        ctx.fillStyle = COL.glass;
        ctx.fillRect(-w / 2, -tt / 2, w, tt);
        ctx.strokeStyle = "#5b8ba0";
        ctx.lineWidth = 1;
        ctx.strokeRect(-w / 2, -tt / 2, w, tt);
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0);
        ctx.stroke();
      } else if (op.type === "door") {
        jambs();
        leaf(-w / 2, 1, w);
      } else if (op.type === "door2") {
        jambs();
        leaf(-w / 2, 1, w / 2);
        leaf(w / 2, -1, w / 2);
      } else if (op.type === "closet") {
        jambs();
        ctx.strokeStyle = "#8d949c";
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        var q = w / 4, d = Math.min(w / 6, 9);
        ctx.moveTo(-w / 2, 0); ctx.lineTo(-w / 2 + q, -d); ctx.lineTo(0, 0);
        ctx.lineTo(w / 2 - q, -d); ctx.lineTo(w / 2, 0);
        ctx.stroke();
      } else if (op.type === "slider") {
        jambs();
        ctx.strokeStyle = "#5b8ba0";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-w / 2, -tt / 5); ctx.lineTo(w / 6, -tt / 5);
        ctx.moveTo(-w / 6, tt / 5); ctx.lineTo(w / 2, tt / 5);
        ctx.stroke();
      } else if (op.type === "garage") {
        ctx.setLineDash([8, 5]);
        ctx.strokeStyle = "#8d949c";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COL.textDim;
        ctx.font = "600 9px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("OVERHEAD DOOR", 0, op.o === "v" ? 14 : -6);
      } else if (op.type === "pocket") {
        jambs();
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "#8d949c";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2 + w * 0.9, 0);
        ctx.stroke();
        ctx.restore();
      } else {               /* cased opening */
        ctx.strokeStyle = COL.wallPartEdge;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-w / 2, -tt / 2); ctx.lineTo(-w / 2, tt / 2);
        ctx.moveTo(w / 2, -tt / 2); ctx.lineTo(w / 2, tt / 2);
        ctx.stroke();
      }
      ctx.restore();
      /* size tag from sheet A2.0 (e.g. 2656 SH) once zoomed in far enough */
      if (op.tag && g.s > 0.07) {
        ctx.save();
        ctx.font = "600 " + PET.clamp(g.s * 110, 8, 11) + "px Inter, sans-serif";
        ctx.fillStyle = op.type === "window" || op.type === "slider" ? "#3f7088" : COL.textDim;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        var off = (op.thick / 2 + 260) * g.s;
        ctx.translate(p.x, p.y);
        if (op.o === "v") ctx.rotate(-Math.PI / 2);
        ctx.fillText(op.tag, 0, -off);
        ctx.restore();
      }
    });
  }

  /* ---------- furniture ---------- */
  function drawFurniture(g) {
    var ctx = g.ctx, store = PET.store;
    store.levelFurniture().forEach(function (f) {
      var cat = store.catalogByType(f.type) || { fill: "#ccc", stroke: "#888", shape: "box" };
      var p = T(g, f.x, f.y);
      var w = f.w * g.s, h = f.h * g.s;
      var sel = store.selection && store.selection.kind === "furniture" && store.selection.id === f.id;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-(f.rot || 0) * Math.PI / 180);
      /* rug first, very light */
      ctx.fillStyle = cat.fill;
      ctx.globalAlpha = f.type === "rug" ? 0.75 : 1;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(4, w * 0.1, h * 0.1));
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = cat.stroke;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      /* shape details */
      ctx.strokeStyle = "rgba(0,0,0,.22)";
      ctx.lineWidth = 1;
      var shape = cat.shape;
      if (shape === "bed") {
        ctx.beginPath();
        ctx.moveTo(-w / 2, -h / 2 + h * (f.type === "bed-king" ? 0.22 : 0.24));
        ctx.lineTo(w / 2, -h / 2 + h * (f.type === "bed-king" ? 0.22 : 0.24));
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,.55)";
        ctx.fillRect(-w / 2 + 3, -h / 2 + 3, w - 6, h * 0.16);
      } else if (shape === "sofa") {
        ctx.beginPath();
        var back = -h / 2 + h * 0.22;
        ctx.moveTo(-w / 2, back); ctx.lineTo(w / 2, back);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-w / 2 + w * 0.12, back); ctx.lineTo(-w / 2 + w * 0.12, h / 2);
        ctx.moveTo(w / 2 - w * 0.12, back); ctx.lineTo(w / 2 - w * 0.12, h / 2);
        ctx.stroke();
      } else if (shape === "chair") {
        ctx.beginPath();
        ctx.moveTo(-w / 2, -h / 2 + h * 0.2); ctx.lineTo(w / 2, -h / 2 + h * 0.2);
        ctx.stroke();
      } else if (shape === "table") {
        ctx.strokeRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8);
      } else if (shape === "toilet") {
        ctx.beginPath();
        ctx.ellipse(0, h * 0.12, w * 0.32, h * 0.3, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shape === "tub") {
        ctx.beginPath();
        ctx.roundRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, Math.min(w, h) * 0.4);
        ctx.stroke();
      } else if (shape === "shower") {
        ctx.beginPath();
        ctx.arc(0, 0, Math.min(w, h) * 0.3, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shape === "plant") {
        ctx.beginPath();
        ctx.arc(0, 0, Math.min(w, h) * 0.28, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shape === "car") {
        ctx.strokeRect(-w / 2, -h / 2 + h * 0.16, w, h * 0.68);
        ctx.beginPath();
        ctx.moveTo(-w / 2, -h / 2 + h * 0.16); ctx.lineTo(w / 2, -h / 2 + h * 0.16);
        ctx.stroke();
      }
      if (sel) {
        ctx.strokeStyle = COL.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(-w / 2 - 1.5, -h / 2 - 1.5, w + 3, h + 3);
      }
      ctx.restore();

      if (sel) drawFurnHandles(g, f);
    });
  }

  function drawFurnHandles(g, f) {
    var ctx = g.ctx;
    var r = (f.rot || 0) * Math.PI / 180;
    var hw = f.w / 2, hh = f.h / 2;
    var corners = [   /* world coordinates: +y is north */
      { x: -hw, y: hh, mode: "nw" }, { x: hw, y: hh, mode: "ne" },
      { x: hw, y: -hh, mode: "se" }, { x: -hw, y: -hh, mode: "sw" },
    ];
    ctx.save();
    corners.forEach(function (c) {
      var wpt = PET.rotatePt(f.x + c.x, f.y + c.y, f.x, f.y, f.rot || 0);
      var p = T(g, wpt.x, wpt.y);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = COL.accent;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.rect(p.x - 4, p.y - 4, 8, 8);
      ctx.fill(); ctx.stroke();
    });
    /* rotate handle above top edge */
    var rw = PET.rotatePt(f.x, f.y + hh + 26 / view.scale, f.x, f.y, f.rot || 0);
    var rp = T(g, rw.x, rw.y);
    var top = PET.rotatePt(f.x, f.y + hh, f.x, f.y, f.rot || 0);
    var tp = T(g, top.x, top.y);
    ctx.strokeStyle = COL.accent;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(tp.x, tp.y); ctx.lineTo(rp.x, rp.y); ctx.stroke();
    ctx.fillStyle = COL.accent;
    ctx.beginPath(); ctx.arc(rp.x, rp.y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(rp.x, rp.y, 3.4, 0.6, 4.6); ctx.stroke();
    ctx.restore();
  }

  /* ---------- room labels ---------- */
  function drawRoomLabels(g) {
    var ctx = g.ctx, store = PET.store;
    store.plan.rooms.forEach(function (r) {
      if (r.part || r.void) return;
      var w = (r.x2 - r.x1) * g.s, h = (r.y2 - r.y1) * g.s;
      if (w < 46 || h < 30) return;
      var cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
      /* keep labels in the visible room area (avoid overlapping dims) */
      var p = T(g, cx, cy);
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      var showArea = w > 90 && h > 58;
      var nameSize = PET.clamp(Math.min(w / 14, h / 6), 9, 13);
      ctx.font = "700 " + nameSize + "px Inter, sans-serif";
      ctx.fillStyle = COL.text;
      ctx.fillText(r.name.toUpperCase(), p.x, p.y - (showArea ? nameSize * 0.9 : 0));
      if (showArea) {
        ctx.font = "500 " + (nameSize - 1.5) + "px Inter, sans-serif";
        ctx.fillStyle = COL.textDim;
        var areaTxt = PET.m2(PET.roomAreaById(store.plan.rooms, r.id));
        ctx.fillText(areaTxt, p.x, p.y + nameSize * 0.55);
        var mat = store.materialById(store.materials[r.id] || "oak");
        ctx.beginPath();
        ctx.arc(p.x - ctx.measureText(areaTxt).width / 2 - 9, p.y + nameSize * 0.55, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = mat.color2d;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,.35)";
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  /* ---------- perimeter dimensions ---------- */
  function drawDimensions(g) {
    var ctx = g.ctx, store = PET.store;
    ctx.save();
    ctx.strokeStyle = COL.dim;
    ctx.fillStyle = COL.dim;
    ctx.lineWidth = 1;
    ctx.font = "500 9.5px " + "Inter, sans-serif";

    /* one dimension per exterior wall run, offset to the outdoor side */
    store.walls.forEach(function (wall) {
      if (!wall.ext || wall.kind !== "wall" || wall.o === "d" || store.demolished[wall.id]) return;
      if (wall.b - wall.a < 1200 || (wall.b - wall.a) * g.s < 34) return;
      var off = 520;
      var outside = wall.out || 1;
      var dimLine = wall.at + outside * (wall.thick / 2 + off);
      var a = wall.o === "h" ? T(g, wall.a, dimLine) : T(g, dimLine, wall.a);
      var b = wall.o === "h" ? T(g, wall.b, dimLine) : T(g, dimLine, wall.b);
      var wa = wall.o === "h" ? T(g, wall.a, wall.at) : T(g, wall.at, wall.a);
      var wb = wall.o === "h" ? T(g, wall.b, wall.at) : T(g, wall.at, wall.b);
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(wa.x, wa.y); ctx.lineTo(a.x, a.y);
      ctx.moveTo(wb.x, wb.y); ctx.lineTo(b.x, b.y);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.stroke();
      /* ticks */
      tick(ctx, a.x, a.y, wall.o);
      tick(ctx, b.x, b.y, wall.o);
      /* label */
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var len = Math.round(wall.b - wall.a);
      var txt = len + "";
      var tw = ctx.measureText(txt).width;
      ctx.save();
      if (wall.o === "h") {
        ctx.fillStyle = COL.paper;
        ctx.fillRect(mx - tw / 2 - 3, my - 6, tw + 6, 12);
        ctx.fillStyle = COL.dim;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(txt, mx, my);
      } else {
        ctx.translate(mx, my);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = COL.paper;
        ctx.fillRect(-tw / 2 - 3, -6, tw + 6, 12);
        ctx.fillStyle = COL.dim;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(txt, 0, 0);
      }
      ctx.restore();
    });
    ctx.globalAlpha = 1;

    /* overall bounding dims */
    var rooms = store.plan.rooms.filter(function (r) { return !r.patio && !r.porch; });
    var bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
    rooms.forEach(function (r) {
      bx1 = Math.min(bx1, r.x1); by1 = Math.min(by1, r.y1);
      bx2 = Math.max(bx2, r.x2); by2 = Math.max(by2, r.y2);
    });
    var dy = by1 - 1750;
    var a2 = T(g, bx1, dy), b2 = T(g, bx2, dy);
    ctx.strokeStyle = COL.text; ctx.fillStyle = COL.text;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y); ctx.stroke();
    ctx.fillRect(a2.x - 1, a2.y - 5, 2, 10);
    ctx.fillRect(b2.x - 1, b2.y - 5, 2, 10);
    ctx.font = "700 11px Inter, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    var t2 = Math.round(bx2 - bx1) + "";
    var tw2 = ctx.measureText(t2).width;
    ctx.fillStyle = COL.paper;
    ctx.fillRect((a2.x + b2.x) / 2 - tw2 / 2 - 4, a2.y - 8, tw2 + 8, 16);
    ctx.fillStyle = COL.text;
    ctx.fillText(t2, (a2.x + b2.x) / 2, a2.y);

    var dx = bx1 - 1750;
    var a3 = T(g, dx, by1), b3 = T(g, dx, by2);
    ctx.beginPath(); ctx.moveTo(a3.x, a3.y); ctx.lineTo(b3.x, b3.y); ctx.stroke();
    ctx.fillRect(a3.x - 5, a3.y - 1, 10, 2);
    ctx.fillRect(b3.x - 5, b3.y - 1, 10, 2);
    ctx.save();
    ctx.translate(a3.x, (a3.y + b3.y) / 2);
    ctx.rotate(-Math.PI / 2);
    var t3 = Math.round(by2 - by1) + "";
    var tw3 = ctx.measureText(t3).width;
    ctx.fillStyle = COL.paper;
    ctx.fillRect(-tw3 / 2 - 4, -8, tw3 + 8, 16);
    ctx.fillStyle = COL.text;
    ctx.fillText(t3, 0, 0);
    ctx.restore();

    ctx.restore();
  }

  function tick(ctx, x, y, o) {
    ctx.beginPath();
    if (o === "h") { ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); }
    else { ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); }
    ctx.stroke();
  }

  /* ---------- measurements ---------- */
  function drawMeasurements(g) {
    var ctx = g.ctx, store = PET.store;
    ctx.save();
    ctx.strokeStyle = COL.accent;
    ctx.fillStyle = COL.accent;
    ctx.lineWidth = 1.5;
    store.measurements.forEach(function (m) {
      dimLine(ctx, g, m.x1, m.y1, m.x2, m.y2);
    });
    if (measureP1 && mouseWorld) {
      ctx.setLineDash([6, 4]);
      dimLine(ctx, g, measureP1.x, measureP1.y, mouseWorld.x, mouseWorld.y);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function dimLine(ctx, g, x1, y1, x2, y2) {
    var a = T(g, x1, y1), b = T(g, x2, y2);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    arrow(ctx, a.x, a.y, Math.atan2(b.y - a.y, b.x - a.x));
    arrow(ctx, b.x, b.y, Math.atan2(a.y - b.y, a.x - b.x));
    var d = Math.round(PET.dist(x1, y1, x2, y2));
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.save();
    var txt = d + " mm";
    ctx.font = "600 11px Inter, sans-serif";
    var tw = ctx.measureText(txt).width;
    ctx.fillStyle = "#fff8ec";
    ctx.strokeStyle = COL.accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(mx - tw / 2 - 5, my - 9, tw + 10, 18, 5);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#8a5b00";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(txt, mx, my);
    ctx.restore();
  }

  function arrow(ctx, x, y, ang) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(-8, -3.6); ctx.lineTo(-8, 3.6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawSnapGuides(g) {
    if (!snapGuides.length) return;
    var ctx = g.ctx;
    ctx.save();
    ctx.strokeStyle = COL.blue;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    snapGuides.forEach(function (l) {
      var a = T(g, l.x1, l.y1), b = T(g, l.x2, l.y2);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    ctx.restore();
  }

  function drawScaleBar(g) {
    var ctx = g.ctx;
    var target = 2000;
    while (target * g.s < 60) target *= 2;
    while (target * g.s > 220) target /= 2;
    var w = target * g.s;
    var x = 18, y = g.H - 26;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.strokeStyle = "rgba(0,0,0,.15)";
    ctx.beginPath(); ctx.roundRect(x - 8, y - 16, w + 60, 30, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = COL.text;
    ctx.fillRect(x, y, w / 2, 6);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x + w / 2, y, w / 2, 6);
    ctx.strokeStyle = COL.text;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, 6);
    ctx.fillStyle = COL.text;
    ctx.font = "600 10px Inter, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("0", x - 3, y - 8);
    ctx.fillText((target / 1000) + " m", x + w - 8, y - 8);
    ctx.restore();
  }

  function drawNorth(g) {
    var ctx = g.ctx;
    var x = g.W - 44, y = 44;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.strokeStyle = "rgba(0,0,0,.15)";
    ctx.beginPath(); ctx.arc(x, y, 20, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = COL.text;
    ctx.beginPath();
    ctx.moveTo(x, y - 13);
    ctx.lineTo(x - 5, y + 6);
    ctx.lineTo(x, y + 2);
    ctx.lineTo(x + 5, y + 6);
    ctx.closePath(); ctx.fill();
    ctx.font = "700 9px Inter, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("N", x, y + 12);
    ctx.restore();
  }

  /* ================= HIT TESTING ================= */

  function hitFurniture(x, y) {
    var items = PET.store.levelFurniture();
    for (var i = items.length - 1; i >= 0; i--) {
      var f = items[i];
      if (PET.hitRotRect(x, y, f.x, f.y, f.w, f.h, f.rot || 0)) return f;
    }
    return null;
  }

  function handleAt(f, x, y) {
    var hw = f.w / 2, hh = f.h / 2;
    var tol = 10 / view.scale;
    var cand = [   /* world coordinates: +y is north */
      { x: -hw, y: hh, mode: "nw" }, { x: hw, y: hh, mode: "ne" },
      { x: hw, y: -hh, mode: "se" }, { x: -hw, y: -hh, mode: "sw" },
    ];
    for (var i = 0; i < cand.length; i++) {
      var c = cand[i];
      var wpt = PET.rotatePt(f.x + c.x, f.y + c.y, f.x, f.y, f.rot || 0);
      if (PET.dist(x, y, wpt.x, wpt.y) < tol) return c.mode;
    }
    /* rotate handle */
    var rOff = 26 / view.scale;
    var rw = PET.rotatePt(f.x, f.y + hh + rOff, f.x, f.y, f.rot || 0);
    if (PET.dist(x, y, rw.x, rw.y) < tol * 1.3) return "rotate";
    return null;
  }

  /* ================= EVENTS ================= */

  function evtPos(e) {
    var r = canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  function bindEvents() {
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("contextmenu", function (e) {
      if (PET.store.tool === "measure") {
        e.preventDefault();
        PET.store.measurements = [];
        measureP1 = null;
        api.render();
      }
    });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
  }

  function onDown(e) {
    if (e.button === 1 || spaceDown || (e.button === 0 && e.altKey)) {
      var p0 = evtPos(e);
      drag = { mode: "pan", sx: p0.sx, sy: p0.sy, cx: view.cx, cy: view.cy };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    var p = evtPos(e);
    var w = s2w(p.sx, p.sy);
    var store = PET.store;

    if (store.tool === "measure") {
      if (!measureP1) {
        measureP1 = { x: w.x, y: w.y };
      } else {
        if (PET.dist(measureP1.x, measureP1.y, w.x, w.y) > 50) {
          store.measurements.push({ x1: measureP1.x, y1: measureP1.y, x2: w.x, y2: w.y });
          store.commit("measure");
        }
        measureP1 = { x: w.x, y: w.y };
      }
      api.render();
      return;
    }

    if (store.tool === "demolish") {
      var wall = PET.wallAt(store.walls, w.x, w.y, PET.clamp(11 / view.scale, 220, 700));
      if (wall) {
        if (wall.load) {
          PET.toast("Load-bearing wall — cannot demolish", true);
        } else {
          if (store.demolished[wall.id]) delete store.demolished[wall.id];
          else store.demolished[wall.id] = true;
          store.commit("demolish");
        }
      }
      return;
    }

    if (store.tool === "material") {
      var room = PET.roomAt(store.plan, w.x, w.y);
      if (room) {
        store.materials[room.id] = store.activeMaterial;
        store.selection = { kind: "room", id: room.id };
        store.commit("material");
        setInfo(room.name + " — floor set to " + store.materialById(store.activeMaterial).name);
      }
      return;
    }

    /* --- select tool --- */
    var sel = store.selection;
    if (sel && sel.kind === "furniture") {
      var sf = store.furniture.find(function (f) { return f.id === sel.id; });
      if (sf) {
        var h = handleAt(sf, w.x, w.y);
        if (h === "rotate") {
          drag = { mode: "rotate", item: sf };
          canvas.setPointerCapture(e.pointerId);
          return;
        }
        if (h) {
          var fx = h === "nw" || h === "sw" ? sf.x + sf.w / 2 : sf.x - sf.w / 2;
          var fy = h === "se" || h === "sw" ? sf.y + sf.h / 2 : sf.y - sf.h / 2;
          drag = { mode: "resize", item: sf, corner: h, fixed: { x: fx, y: fy }, startW: sf.w, startH: sf.h };
          canvas.setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    var f = hitFurniture(w.x, w.y);
    if (f) {
      store.selection = { kind: "furniture", id: f.id };
      drag = { mode: "move", item: f, sx: w.x, sy: w.y, ox: f.x, oy: f.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
      var cat = store.catalogByType(f.type);
      setInfo((cat ? cat.name : f.type) + " — " + Math.round(f.w) + "×" + Math.round(f.h) + " mm · " + Math.round(f.rot) + "°");
      api.render();
      return;
    }
    var r2 = PET.roomAt(store.plan, w.x, w.y);
    if (r2) {
      store.selection = { kind: "room", id: r2.id };
      var mat = store.materialById(store.materials[r2.id]);
      setInfo(r2.name + " — " + PET.m2(PET.roomAreaById(store.plan.rooms, r2.id)) + " · floor: " + mat.name);
      api.render();
      return;
    }
    store.selection = null;
    setInfo("");
    api.render();
  }

  function onMove(e) {
    var p = evtPos(e);
    var w = s2w(p.sx, p.sy);
    mouseWorld = w;

    if (drag) {
      if (drag.mode === "pan") {
        view.cx = drag.cx - (p.sx - drag.sx) / view.scale;
        view.cy = drag.cy + (p.sy - drag.sy) / view.scale;
        api.render();
        return;
      }
      if (drag.mode === "move") {
        var nx = drag.ox + (w.x - drag.sx);
        var ny = drag.oy + (w.y - drag.sy);
        if (Math.abs(w.x - drag.sx) + Math.abs(w.y - drag.sy) > 2) drag.moved = true;
        var cand = { x: nx, y: ny, w: drag.item.w, h: drag.item.h, rot: drag.item.rot };
        var sn = PET.snapFurniture(cand, PET.store.walls, PET.store.levelFurniture(), drag.item.id);
        snapGuides = [];
        if (sn) {
          cand.x = sn.x; cand.y = sn.y;
          if (sn.snappedX) {
            snapGuides.push({ x1: cand.x - cand.w / 2, y1: cand.y - cand.h / 2 - 200, x2: cand.x - cand.w / 2, y2: cand.y + cand.h / 2 + 200 });
          }
          if (sn.snappedY) {
            snapGuides.push({ x1: cand.x - cand.w / 2 - 200, y1: cand.y - cand.h / 2, x2: cand.x + cand.w / 2 + 200, y2: cand.y - cand.h / 2 });
          }
        }
        drag.item.x = cand.x;
        drag.item.y = cand.y;
        updateSelInfo(drag.item);
        api.render();
        return;
      }
      if (drag.mode === "rotate") {
        var f = drag.item;
        var ang = Math.atan2(w.y - f.y, w.x - f.x) * 180 / Math.PI;
        ang = 90 - ang;                       // handle sits at +y of the item
        if (!e.shiftKey) ang = Math.round(ang / 15) * 15;
        f.rot = ((ang % 360) + 360) % 360;
        updateSelInfo(f);
        api.render();
        return;
      }
      if (drag.mode === "resize") {
        var it = drag.item;
        var lx = PET.rotatePt(w.x, w.y, drag.fixed.x, drag.fixed.y, -(it.rot || 0));
        var dx = lx.x - drag.fixed.x, dy = lx.y - drag.fixed.y;
        var nw = Math.max(200, Math.abs(dx)), nh = Math.max(200, Math.abs(dy));
        if (e.shiftKey) {
          var ratio = drag.startH / drag.startW;
          var target = Math.max(nw, nh / ratio);
          nw = target; nh = target * ratio;
        }
        var sx = dx >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1;
        var cLocal = { x: sx * nw / 2, y: sy * nh / 2 };
        var cc = PET.rotatePt(drag.fixed.x + cLocal.x, drag.fixed.y + cLocal.y, drag.fixed.x, drag.fixed.y, it.rot || 0);
        it.w = nw; it.h = nh; it.x = cc.x; it.y = cc.y;
        updateSelInfo(it);
        api.render();
        return;
      }
    }

    /* hover feedback */
    var hov = null;
    if (PET.store.tool === "select" || PET.store.tool === "measure") {
      var f2 = hitFurniture(w.x, w.y);
      if (f2) hov = { kind: "furniture", id: f2.id };
    } else if (PET.store.tool === "demolish") {
      var wl = PET.wallAt(PET.store.walls, w.x, w.y, PET.clamp(11 / view.scale, 220, 700));
      if (wl) hov = { kind: "wall", id: wl.id, load: wl.load };
    }
    var changed = JSON.stringify(hov) !== JSON.stringify(hover);
    hover = hov;
    if (changed) api.render();
    else if (measureP1) api.render();

    /* cursor + coords */
    var cursor = "default";
    if (PET.store.tool === "measure") cursor = "crosshair";
    else if (PET.store.tool === "demolish") cursor = hover && hover.load ? "not-allowed" : "pointer";
    else if (PET.store.tool === "material") cursor = "copy";
    else if (hover && hover.kind === "furniture") cursor = "move";
    canvas.style.cursor = cursor;
    setCoords(w);
  }

  function onUp(e) {
    if (!drag) return;
    if (drag.mode === "move") {
      if (drag.moved) {
        PET.store.commit("move");
        snapGuides = [];
      }
    } else if (drag.mode === "rotate" || drag.mode === "resize") {
      PET.store.commit(drag.mode);
    }
    drag = null;
    api.render();
  }

  function onWheel(e) {
    e.preventDefault();
    var p = evtPos(e);
    if (e.shiftKey) {
      /* rotate selected furniture */
      var sel = PET.store.selection;
      if (sel && sel.kind === "furniture") {
        var f = PET.store.furniture.find(function (it) { return it.id === sel.id; });
        if (f) {
          var step = 5;
          f.rot = (((f.rot || 0) + (e.deltaY > 0 ? -step : step)) % 360 + 360) % 360;
          api.render();
          return;
        }
      }
    }
    var f2 = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    api.zoomBy(f2, p.sx, p.sy);
  }

  function onDblClick(e) {
    var p = evtPos(e);
    var w = s2w(p.sx, p.sy);
    var f = hitFurniture(w.x, w.y);
    if (f) return;
    var r = PET.roomAt(PET.store.plan, w.x, w.y);
    if (r) api.zoomToRoom(r);
  }

  function onKeyDown(e) {
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    var store = PET.store;
    var meta = e.metaKey || e.ctrlKey;

    if (meta && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) store.redo(); else store.undo();
      return;
    }
    if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); store.redo(); return; }
    if (meta && e.key.toLowerCase() === "d") {
      e.preventDefault();
      if (store.selection && store.selection.kind === "furniture") {
        var f = store.furniture.find(function (it) { return it.id === store.selection.id; });
        if (f) {
          var copy = Object.assign({}, f, { id: PET.uid(), x: f.x + 300, y: f.y + 300 });
          store.furniture.push(copy);
          store.selection = { kind: "furniture", id: copy.id };
          store.commit("duplicate");
          api.render();
        }
      }
      return;
    }
    if (e.code === "Space") { spaceDown = true; canvas.style.cursor = "grab"; e.preventDefault(); return; }

    switch (e.key) {
      case "v": case "V": setTool("select"); break;
      case "m": case "M": setTool("measure"); break;
      case "d": case "D": setTool("demolish"); break;
      case "f": case "F": setTool("material"); break;
      case "0": api.fit(); break;
      case "Escape":
        measureP1 = null;
        if (store.selection) { store.selection = null; }
        api.render();
        break;
      case "Delete": case "Backspace":
        if (store.selection && store.selection.kind === "furniture") {
          store.furniture = store.furniture.filter(function (it) { return it.id !== store.selection.id; });
          store.selection = null;
          store.commit("delete");
          api.render();
        }
        break;
      case "r": case "R":
        if (store.selection && store.selection.kind === "furniture") {
          var f2 = store.furniture.find(function (it) { return it.id === store.selection.id; });
          if (f2) { f2.rot = (((f2.rot || 0) + 90) % 360 + 360) % 360; store.commit("rotate"); api.render(); }
        }
        break;
      case "[": case "]":
        if (store.selection && store.selection.kind === "furniture") {
          var f3 = store.furniture.find(function (it) { return it.id === store.selection.id; });
          if (f3) {
            f3.rot = (((f3.rot || 0) + (e.key === "]" ? 5 : -5)) % 360 + 360) % 360;
            store.commit("rotate"); api.render();
          }
        }
        break;
      case "ArrowLeft": case "ArrowRight": case "ArrowUp": case "ArrowDown":
        if (store.selection && store.selection.kind === "furniture") {
          e.preventDefault();
          var f4 = store.furniture.find(function (it) { return it.id === store.selection.id; });
          if (f4) {
            var d = e.shiftKey ? 100 : 10;
            if (e.key === "ArrowLeft") f4.x -= d;
            if (e.key === "ArrowRight") f4.x += d;
            if (e.key === "ArrowUp") f4.y += d;
            if (e.key === "ArrowDown") f4.y -= d;
            nudgeCommit();
            api.render();
          }
        }
        break;
    }
  }

  var nudgeCommit = PET.debounce(function () { PET.store.commit("nudge"); }, 500);

  function onKeyUp(e) {
    if (e.code === "Space") { spaceDown = false; canvas.style.cursor = "default"; }
  }

  /* ================= small UI helpers ================= */
  function setCoords(w) {
    var el = document.getElementById("st-coords");
    if (el) el.textContent = Math.round(w.x) + ", " + Math.round(w.y) + " mm";
  }
  function setInfo(txt) {
    var el = document.getElementById("st-info");
    if (el && txt !== undefined && txt !== null && txt !== "") el.textContent = txt;
  }
  function updateSelInfo(f) {
    var cat = PET.store.catalogByType(f.type);
    setInfo((cat ? cat.name : f.type) + " — " + Math.round(f.w) + "×" + Math.round(f.h) + " mm · " + Math.round(f.rot) + "°");
  }

  api.setTool = function (t) {
    PET.store.tool = t;
    measureP1 = null;
    if (t !== "select") {
      /* keep selection for context, but drop furniture handles */
    }
    api.render();
  };

  var setTool = api.setTool;

  api.addFurniture = function (type) {
    var cat = PET.store.catalogByType(type);
    if (!cat) return;
    var item = {
      id: PET.uid(), type: type,
      x: Math.round(view.cx), y: Math.round(view.cy),
      rot: 0, w: cat.w, h: cat.h, level: PET.store.level,
    };
    /* nudge off existing items so it is visible */
    var tries = 0;
    while (PET.store.levelFurniture().some(function (f) {
      return PET.rectsOverlap(PET.furnBounds(f), PET.furnBounds(item));
    }) && tries < 12) {
      item.x += 300; item.y += 300; tries++;
    }
    PET.store.furniture.push(item);
    PET.store.selection = { kind: "furniture", id: item.id };
    PET.store.commit("add");
    api.render();
    setInfo(cat.name + " added — drag to place, R to rotate");
  };

  api.renderExport = function (scaleFactor) {
    /* returns a PNG data URL drawn at higher resolution */
    var bb = planBounds();
    var x1 = bb.x1, y1 = bb.y1, x2 = bb.x2, y2 = bb.y2;
    var pad = 2600;
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
    var s = Math.min(2400 / (x2 - x1), 1500 / (y2 - y1)) * (scaleFactor || 1);
    var W2 = Math.round((x2 - x1) * s), H2 = Math.round((y2 - y1) * s);
    var c2 = document.createElement("canvas");
    c2.width = W2; c2.height = H2;
    var g = {
      ctx: c2.getContext("2d"), W: W2, H: H2, s: s,
      cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, dpr: 1,
    };
    drawScene(g);
    return c2.toDataURL("image/png");
  };

  PET.view2d = api;

})(window.PET);
