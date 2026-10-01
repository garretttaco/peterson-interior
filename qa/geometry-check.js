#!/usr/bin/env node
/* Geometry consistency check — no browser needed.
   Verifies, per level: walls, openings, room overlaps, furniture placement,
   stair rise, and that the upstairs sits on top of the main floor.
   Run from peterson-interior/:  node qa/geometry-check.js  */
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
global.window = global;
require(path.join(ROOT, "js/util.js"));
require(path.join(ROOT, "js/geom.js"));
require(path.join(ROOT, "data/plan.js"));
require(path.join(ROOT, "data/furniture.js"));
require(path.join(ROOT, "data/layout.js"));

const PET = global.PET;
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });
const cat = {};
PET_FURNITURE_CATALOG.forEach((c) => (cat[c.type] = c));

for (const L of PET_PLAN.levels) {
  const built = PET.buildLevel(PET_PLAN, L);
  const tag = "[" + L.id + "] ";

  /* 1. walls */
  check(tag + "walls built", built.walls.length > (L.id === "main" ? 150 : 20), built.walls.length + " walls");
  check(tag + "no zero-size walls", built.walls.every((w) => w.o === "d" || (w.rect.x2 - w.rect.x1 > 5 && w.rect.y2 - w.rect.y1 > 5)), "");
  check(tag + "load-bearing walls exist", built.walls.some((w) => w.load), built.walls.filter((w) => w.load).length + " load-bearing");

  /* 2. every opening is flanked by wall on both ends (it is a real gap) */
  const rects = built.walls.filter((w) => w.o !== "d").map((w) => w.rect);
  const touches = (x, y) => rects.some((r) => x >= r.x1 - 25 && x <= r.x2 + 25 && y >= r.y1 - 25 && y <= r.y2 + 25);
  const orphan = built.openings.filter((op) => {
    const a = op.o === "h" ? [op.a, op.at] : [op.at, op.a];
    const b = op.o === "h" ? [op.b, op.at] : [op.at, op.b];
    return !touches(a[0], a[1]) || !touches(b[0], b[1]);
  });
  check(tag + "openings sit in wall gaps", orphan.length === 0,
    orphan.map((o) => o.type + "@" + o.o + o.at).join(" | ") || built.openings.length + " openings");
  const blockedOps = built.openings.filter((op) => {
    const mid = (op.a + op.b) / 2;
    const p = op.o === "h" ? [mid, op.at] : [op.at, mid];
    return rects.some((r) => p[0] > r.x1 + 1 && p[0] < r.x2 - 1 && p[1] > r.y1 + 1 && p[1] < r.y2 - 1);
  });
  check(tag + "no wall inside an opening", blockedOps.length === 0, blockedOps.map((o) => o.id).join(" | "));

  /* every tagged opening's width matches its A2.0 tag (WWHH, feet+inches) */
  const tagW = (t) => {
    const w = t.split(" ")[0].slice(0, -2);
    const inch = w.length === 3 ? (+w.slice(1) <= 11 ? +w[0] * 12 + +w.slice(1) : +w.slice(0, 2) * 12 + +w[2]) : +w[0] * 12 + +w.slice(1);
    return inch * 25.4;
  };
  const tagged = built.openings.filter((op) => op.tag);
  const badTag = tagged.filter((op) => Math.abs(tagW(op.tag) - op.w) > 80);
  check(tag + "opening widths match A2.0 tags", badTag.length === 0,
    badTag.map((o) => o.tag + " vs " + o.w).join(" | ") || tagged.length + " tagged openings within 80 mm");

  /* 3. no overlaps between different rooms unless one nests in the other */
  const rooms = L.rooms;
  const ov = [];
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
    const a = rooms[i], b = rooms[j];
    if (a.id === b.id) continue;
    const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    const nested = (a.x1 <= b.x1 && a.x2 >= b.x2 && a.y1 <= b.y1 && a.y2 >= b.y2) ||
                   (b.x1 <= a.x1 && b.x2 >= a.x2 && b.y1 <= a.y1 && b.y2 >= a.y2);
    if (ox > 1 && oy > 1 && !nested) ov.push(a.id + "/" + b.id);
  }
  check(tag + "no room overlaps", ov.length === 0, ov.join(" | ") || rooms.length + " room rects");

  /* 4. default furniture clear of walls and inside rooms (after the app's prep passes) */
  const items = PET_FURNITURE_DEFAULT.filter((d) => d.level === L.id).map((d, i) => ({
    id: "f" + i, type: d.type, x: d.x, y: d.y, rot: d.rot || 0,
    w: d.w || cat[d.type].w, h: d.h || cat[d.type].h,
  }));
  PET.prepareItems = PET.prepareItems || ((it, w, r) => { PET.clampToRooms(it, w, r); PET.decollideWalls(it, w); PET.clampToRooms(it, w, r); });
  PET.clampToRooms(items, built.walls, rooms);
  PET.decollideWalls(items, built.walls);
  PET.clampToRooms(items, built.walls, rooms);
  PET.decollideWalls(items, built.walls);
  PET.clampToRooms(items, built.walls, rooms);
  const crossing = items.filter((f) => rects.some((r) => PET.rectsOverlap(PET.furnBounds(f), r)));
  check(tag + "furniture clear of walls", crossing.length === 0, crossing.map((f) => f.type + "@" + f.x + "," + f.y).join(" | ") || items.length + " pieces");
  const outside = items.filter((f) => !PET.roomAt({ rooms }, f.x, f.y));
  check(tag + "furniture inside rooms", outside.length === 0, outside.map((f) => f.type).join(" | ") || "all inside");
}

/* 5. stair: 18 even risers from the main floor to the upstairs */
const main = PET_PLAN.levels.find((l) => l.id === "main");
const bonus = PET_PLAN.levels.find((l) => l.id === "bonus");
const zs = main.stair.treads.filter((t) => !t.landing).map((t) => t.z);
const top = Math.max(...zs);
check("stair reaches the upstairs", Math.abs(top + main.stair.riser - bonus.elev) < 2,
  "top tread " + top + " + riser " + main.stair.riser + " = " + Math.round(top + main.stair.riser) + " vs floor " + bonus.elev);
check("stair riser within code (≤ 196 mm)", main.stair.riser <= 196, main.stair.riser + " mm");

/* 6. the upstairs sits on the main floor footprint, and the stair well is over the stair */
const inMain = (x, y) => main.rooms.some((r) => !r.patio && !r.porch && x >= r.x1 - 200 && x <= r.x2 + 200 && y >= r.y1 - 200 && y <= r.y2 + 200);
const floating = bonus.rooms.filter((r) => !inMain((r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2));
check("upstairs rooms are over the main floor", floating.length === 0, floating.map((r) => r.id).join(" | ") || bonus.rooms.length + " rects");
const well = bonus.rooms.find((r) => r.void);
const sb = main.stair.treads.reduce((b, t) => ({ x1: Math.min(b.x1, t.x1), y1: Math.min(b.y1, t.y1), x2: Math.max(b.x2, t.x2), y2: Math.max(b.y2, t.y2) }), { x1: 1e9, y1: 1e9, x2: -1e9, y2: -1e9 });
check("stair well matches the stair", Math.abs(well.x1 - sb.x1) < 60 && Math.abs(well.x2 - sb.x2) < 120 && Math.abs(well.y1 - sb.y1) < 60 && Math.abs(well.y2 - sb.y2) < 60,
  JSON.stringify(well) + " vs " + JSON.stringify(sb));

/* report */
let all = true;
for (const r of results) {
  console.log((r.pass ? "PASS" : "FAIL") + " - " + r.name + (r.detail ? "  [" + r.detail + "]" : ""));
  if (!r.pass) all = false;
}
console.log(all ? "\nGEOMETRY OK" : "\nGEOMETRY FAILED");
process.exit(all ? 0 : 1);
