/* ============ 3D view: three.js scene, orbit + first-person walkthrough ============ */
(function (PET) {
  "use strict";

  var THREE = window.THREE;
  var renderer, scene, camera, container, sun;
  var ready = false, active = false;
  var mode = "orbit";                       // orbit | walk
  var orbit = { theta: -Math.PI / 4, phi: 1.0, dist: 56000, target: new THREE.Vector3(11000, 0, -16800) };
  var walk = { yaw: 0, pitch: 0, keys: {}, eye: 1620, speed: 3000, feet: 0, locked: false };
  var BODY_R = 170;                          // walker radius (mm)
  var STEP = 420;                            // highest step the walker climbs (mm)
  var colliders = [];                        // {x1,z1,x2,z2,y0,y1} world AABBs
  var surfaces = [];                         // {x1,y1,x2,y2,h} plan rects you can stand on
  var root = null;                           // scene group rebuilt on change
  var parts = {};                            // named sub-groups toggled without a rebuild
  var view = { roof: false, upper: true };   // orbit-mode visibility
  var brightness = 0.8;

  try {
    var savedB = parseFloat(localStorage.getItem("peterson-bright"));
    if (savedB > 0.2 && savedB < 2) brightness = savedB;
  } catch (e) { /* storage blocked — keep default */ }

  var MAT = {};

  function initMats() {
    MAT.wall = new THREE.MeshStandardMaterial({ color: 0xebe6dc, roughness: 0.94 });
    MAT.wallExt = new THREE.MeshStandardMaterial({ color: 0xe6dfd1, roughness: 0.97 });   // stucco
    MAT.partition = new THREE.MeshStandardMaterial({ color: 0xf3f0ea, roughness: 0.95 });
    MAT.trim = new THREE.MeshStandardMaterial({ color: 0xe4dfd5, roughness: 0.8 });
    MAT.post = new THREE.MeshStandardMaterial({ color: 0x9b8468, roughness: 0.8 });
    MAT.glass = new THREE.MeshStandardMaterial({ color: 0xbfe0ef, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.38 });
    MAT.frame = new THREE.MeshStandardMaterial({ color: 0xf3f1ec, roughness: 0.5 });     // white window frames
    MAT.fascia = new THREE.MeshStandardMaterial({ color: 0xebe7df, roughness: 0.7 });
    MAT.rail = new THREE.MeshStandardMaterial({ color: 0x6f5a43, roughness: 0.6 });
    MAT.door = new THREE.MeshStandardMaterial({ color: 0xb08356, roughness: 0.6 });
    MAT.doorDark = new THREE.MeshStandardMaterial({ color: 0x7f6243, roughness: 0.6 });
    MAT.ground = new THREE.MeshStandardMaterial({ color: 0x8e9b7d, roughness: 1 });
    MAT.stair = new THREE.MeshStandardMaterial({ color: 0xc9a77c, roughness: 0.7 });
    MAT.slab = new THREE.MeshStandardMaterial({ color: 0xcfc8ba, roughness: 0.95 });
    MAT.ceiling = new THREE.MeshStandardMaterial({ color: 0xf1eee8, roughness: 0.98, side: THREE.DoubleSide });
    MAT.roof = new THREE.MeshStandardMaterial({ color: 0x4d4a47, roughness: 0.95, side: THREE.DoubleSide });   // architectural asphalt shingles
    MAT.roofMetal = new THREE.MeshStandardMaterial({ color: 0x737b84, roughness: 0.55, metalness: 0.25, side: THREE.DoubleSide });
    MAT.gable = new THREE.MeshStandardMaterial({ color: 0xe6dfd1, roughness: 0.97, side: THREE.DoubleSide });
  }

  function box(w, h, d, mat) {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  }

  /* axis-aligned box from plan rect + height range; plan y maps to -z */
  function prism(g, x1, y1, x2, y2, z0, z1, mat, shadow) {
    if (x2 - x1 < 1 || y2 - y1 < 1 || z1 - z0 < 1) return null;
    var m = box(x2 - x1, z1 - z0, y2 - y1, mat);
    m.position.set((x1 + x2) / 2, (z0 + z1) / 2, -(y1 + y2) / 2);
    if (shadow !== false) { m.castShadow = true; m.receiveShadow = true; }
    g.add(m);
    return m;
  }

  function addCollider(x1, y1, x2, y2, z0, z1) {
    colliders.push({ x1: x1, x2: x2, z1: -y2, z2: -y1, y0: z0, y1: z1 });
  }

  /* ================= SCENE BUILD ================= */

  function levelElev(L) { return L.def.elev || 0; }

  function buildFloors(g, L) {
    var store = PET.store, D = store.data.dims, elev = levelElev(L);
    L.def.rooms.forEach(function (r) {
      if (r.void) return;
      var mat = store.materialById(store.materials[r.id] || "oak");
      var m = new THREE.MeshStandardMaterial({ color: mat.color3d, roughness: r.patio ? 0.95 : 0.7 });
      var outdoor = r.patio || r.porch;
      var top = elev + (outdoor ? -25 : 0);
      prism(g, r.x1, r.y1, r.x2, r.y2, top - 40, top, m, false).receiveShadow = true;
      if (outdoor) prism(g, r.x1, r.y1, r.x2, r.y2, -110, top - 40, MAT.slab, false);
      if (elev > 0) {
        /* floor structure under an upper level; reaches into the walls */
        var e = 70;
        prism(g, r.x1 - e, r.y1 - e, r.x2 + e, r.y2 + e, elev - D.floorThick, elev - 40, MAT.slab);
        surfaces.push({ x1: r.x1 - 120, y1: r.y1 - 120, x2: r.x2 + 120, y2: r.y2 + 120, h: elev });
      }
    });
  }

  function wallMat(w) {
    if (w.kind === "post") return MAT.post;
    if (w.kind === "trim") return MAT.trim;
    return w.load ? MAT.wallExt : MAT.partition;
  }

  function buildWalls(g, L) {
    var store = PET.store, D = store.data.dims, def = L.def, elev = levelElev(L);
    var H = def.height;
    L.walls.forEach(function (w) {
      if (store.demolished[w.id]) return;
      var z0 = elev, z1 = elev + H;
      if (elev > 0 && w.ext) z0 = elev - D.floorThick;     // close the rim of the floor structure
      var mat = wallMat(w);
      if (w.o === "d") {
        var len = PET.dist(w.x1, w.y1, w.x2, w.y2);
        var m = box(len, z1 - z0, w.thick, mat);
        m.position.set((w.x1 + w.x2) / 2, (z0 + z1) / 2, -(w.y1 + w.y2) / 2);
        m.rotation.y = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
        m.castShadow = true; m.receiveShadow = true;
        g.add(m);
        /* collision: small boxes along the centerline */
        var n = Math.max(1, Math.ceil(len / 120));
        for (var i = 0; i <= n; i++) {
          var px = w.x1 + (w.x2 - w.x1) * i / n, py = w.y1 + (w.y2 - w.y1) * i / n, hw = w.thick / 2;
          addCollider(px - hw, py - hw, px + hw, py + hw, z0, z1);
        }
        return;
      }
      var r = w.rect;
      if (w.kind === "post") z1 = postTop(r);
      prism(g, r.x1, r.y1, r.x2, r.y2, z0, z1, mat);
      addCollider(r.x1, r.y1, r.x2, r.y2, z0, z1);
    });
  }

  /* porch posts stop under the beam they carry */
  function postTop(r) {
    var beams = PET.store.data.beams || [];
    for (var i = 0; i < beams.length; i++) {
      var b = beams[i];
      if (r.x1 < b.x2 + 40 && r.x2 > b.x1 - 40 && r.y1 < b.y2 + 40 && r.y2 > b.y1 - 40) return b.z0;
    }
    return 2945;
  }

  /* window frame + muntins in the plane of the glass.
     r: opening rect, z0..z1: glass, style 'sh' (single-hung) or 'fx' (fixed) */
  function windowTrim(g, op, r, z0, z1, style) {
    var t = op.thick, fw = 50;
    var along = op.o === "h", cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
    var a0 = along ? r.x1 : r.y1, a1 = along ? r.x2 : r.y2;
    function bar(p0, p1, q0, q1, depth) {     /* p along the wall, q = height */
      depth = depth || 60;
      if (along) prism(g, p0, cy - depth / 2, p1, cy + depth / 2, q0, q1, MAT.frame, false);
      else prism(g, cx - depth / 2, p0, cx + depth / 2, p1, q0, q1, MAT.frame, false);
    }
    bar(a0, a0 + fw, z0, z1, t + 30); bar(a1 - fw, a1, z0, z1, t + 30);     // jambs
    bar(a0, a1, z1 - fw, z1, t + 30); bar(a0, a1, z0, z0 + fw, t + 50);     // head, sill
    var w = a1 - a0, h = z1 - z0, m = (a0 + a1) / 2;
    if (style === "sh") {
      bar(a0, a1, (z0 + z1) / 2 - 30, (z0 + z1) / 2 + 30, 70);              // meeting rail
      if (w >= 600) bar(m - 14, m + 14, z0, z1);
    } else {
      var cols = Math.max(1, Math.round(w / 700)), rows = Math.max(1, Math.round(h / 650));
      for (var i = 1; i < cols; i++) { var u = a0 + w * i / cols; bar(u - 14, u + 14, z0, z1); }
      for (var j = 1; j < rows; j++) { var v = z0 + h * j / rows; bar(a0, a1, v - 14, v + 14); }
    }
  }

  function buildOpenings(g, L) {
    var store = PET.store, D = store.data.dims, def = L.def, elev = levelElev(L);
    var top = elev + def.height;
    var sill = elev + (def.windowSill || D.windowSill);
    var wtop = elev + (def.windowTop || D.windowTop);
    var dh = elev + (def.doorHeight || D.doorHeight);
    var hh = elev + Math.min(def.height, D.headerHeight);
    L.openings.forEach(function (op) {
      var t = op.thick;
      /* plan rect of the opening */
      var r = op.o === "h"
        ? { x1: op.a, y1: op.at - t / 2, x2: op.b, y2: op.at + t / 2 }
        : { x1: op.at - t / 2, y1: op.a, x2: op.at + t / 2, y2: op.b };
      var cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
      var mat = t > 120 ? MAT.wallExt : MAT.partition;
      function pane(z0, z1, inset) {
        var gt = Math.max(16, t * 0.25);
        var pr = op.o === "h"
          ? { x1: r.x1 + inset, y1: cy - gt / 2, x2: r.x2 - inset, y2: cy + gt / 2 }
          : { x1: cx - gt / 2, y1: r.y1 + inset, x2: cx + gt / 2, y2: r.y2 - inset };
        prism(g, pr.x1, pr.y1, pr.x2, pr.y2, z0, z1, MAT.glass, false);
      }
      if (op.type === "window") {
        var ws = op.sill !== undefined ? elev + op.sill : sill;
        var wt = op.height ? ws + op.height : wtop;
        prism(g, r.x1, r.y1, r.x2, r.y2, elev, ws, mat);
        prism(g, r.x1, r.y1, r.x2, r.y2, wt, top, mat);
        pane(ws, wt, 0);
        windowTrim(g, op, r, ws, wt, op.style || "fx");
        addCollider(r.x1, r.y1, r.x2, r.y2, elev, top);
      } else if (op.type === "slider") {
        if (op.height) hh = Math.min(top, elev + op.height);
        prism(g, r.x1, r.y1, r.x2, r.y2, hh, top, mat);
        windowTrim(g, op, r, elev, hh, "fx");
        /* fixed half is glass; the sliding half stands open */
        var half = op.o === "h"
          ? { x1: r.x1, y1: r.y1, x2: (r.x1 + r.x2) / 2, y2: r.y2 }
          : { x1: r.x1, y1: r.y1, x2: r.x2, y2: (r.y1 + r.y2) / 2 };
        var gt2 = Math.max(16, t * 0.25);
        if (op.o === "h") prism(g, half.x1, cy - gt2 / 2, half.x2, cy + gt2 / 2, elev, hh, MAT.glass, false);
        else prism(g, cx - gt2 / 2, half.y1, cx + gt2 / 2, half.y2, elev, hh, MAT.glass, false);
        addCollider(half.x1, half.y1, half.x2, half.y2, elev, top);
      } else if (op.type === "garage") {
        var gh = elev + 2438;
        prism(g, r.x1, r.y1, r.x2, r.y2, gh, top, mat);
        var p = op.o === "h"
          ? { x1: r.x1, y1: cy - 30, x2: r.x2, y2: cy + 30 }
          : { x1: cx - 30, y1: r.y1, x2: cx + 30, y2: r.y2 };
        prism(g, p.x1, p.y1, p.x2, p.y2, elev, gh, MAT.doorDark);
        /* raised panels: 4 rows x 4 columns, as drawn on the left elevation */
        for (var gi = 1; gi < 4; gi++) {
          var gz = elev + (gh - elev) * gi / 4;
          if (op.o === "h") prism(g, r.x1, cy - 45, r.x2, cy + 45, gz - 18, gz + 18, MAT.trim, false);
          else prism(g, cx - 45, r.y1, cx + 45, r.y2, gz - 18, gz + 18, MAT.trim, false);
        }
        for (var gj = 1; gj < 4; gj++) {
          var ga = op.a + (op.b - op.a) * gj / 4;
          if (op.o === "h") prism(g, ga - 18, cy - 45, ga + 18, cy + 45, elev, gh, MAT.trim, false);
          else prism(g, cx - 45, ga - 18, cx + 45, ga + 18, elev, gh, MAT.trim, false);
        }
        addCollider(r.x1, r.y1, r.x2, r.y2, elev, top);
      } else {
        /* doors, double doors, closets, cased openings: header only */
        if (op.height) dh = elev + op.height;
        var head = op.type === "opening" ? Math.max(dh, hh) : dh;
        if (head > top) head = top;
        prism(g, r.x1, r.y1, r.x2, r.y2, head, top, mat);
        if (op.type === "door") doorLeaf(g, op, elev, dh, op.a + 20, op.w - 40, 1);
        if (op.type === "door2") {
          doorLeaf(g, op, elev, dh, op.a + 20, op.w / 2 - 30, 1, MAT.glass);
          doorLeaf(g, op, elev, dh, op.b - 20, op.w / 2 - 30, -1, MAT.glass);
        }
        if (op.type === "closet") {
          var cp = op.o === "h"
            ? { x1: r.x1 + 10, y1: cy - 18, x2: r.x2 - 10, y2: cy + 18 }
            : { x1: cx - 18, y1: r.y1 + 10, x2: cx + 18, y2: r.y2 - 10 };
          prism(g, cp.x1, cp.y1, cp.x2, cp.y2, elev, dh, MAT.door);
          addCollider(r.x1, r.y1, r.x2, r.y2, elev, top);
        }
      }
    });
  }

  /* open door leaf, hinged at `at` along the opening, swung 62° */
  function doorLeaf(g, op, elev, dh, at, leafW, dir, mat) {
    if (leafW < 100) return;
    var h = dh - elev - 30;
    var leaf = box(leafW, h, 40, mat || MAT.door);
    leaf.geometry.translate(dir * leafW / 2, 0, 0);
    var swing = 62 * Math.PI / 180;
    if (op.o === "h") {
      leaf.position.set(at, elev + h / 2, -op.at);
      leaf.rotation.y = dir * swing;
    } else {
      leaf.position.set(op.at, elev + h / 2, -at);
      leaf.rotation.y = Math.PI / 2 + dir * -swing;
    }
    leaf.castShadow = true;
    g.add(leaf);
  }

  function buildStair(g) {
    var main = PET.store.levelById("main");
    var st = main && main.def.stair;
    if (!st) return;
    st.treads.forEach(function (t) {
      var solid = t.landing || t.z <= 2200;
      var z0 = solid ? 0 : t.z - 260;
      prism(g, t.x1, t.y1, t.x2, t.y2, z0, t.z, MAT.stair);
      addCollider(t.x1, t.y1, t.x2, t.y2, z0, t.z);
      surfaces.push({ x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, h: t.z });
    });
    /* handrails on the wall side of each run, 900 mm above the nosings */
    var north = st.treads.filter(function (t) { return !t.landing && t.y1 > st.rail.y1; });
    var south = st.treads.filter(function (t) { return !t.landing && t.y2 <= st.rail.y2; });
    if (north.length) {
      var n0 = north[0], n1 = north[north.length - 1];
      band(g, [n0.x2, n0.y2 - 70, n0.z + 900 - st.riser], [n1.x1, n1.y2 - 70, n1.z + 900], 50, 50, MAT.rail, true);
    }
    if (south.length) {
      var s0 = south[0], s1 = south[south.length - 1];
      band(g, [s0.x1, s0.y1 + 70, s0.z + 900 - st.riser], [s1.x2, s1.y1 + 70, s1.z + 900], 50, 50, MAT.rail, true);
    }
    /* centre wall between the runs, carried up as the guard at the upper floor */
    var rl = st.rail, railTop = PET.store.levelById("bonus").def.elev + 950;
    prism(g, rl.x1, rl.y1 - 30, rl.x2, rl.y2 + 30, 0, railTop, MAT.partition);
    addCollider(rl.x1, rl.y1 - 30, rl.x2, rl.y2 + 30, 0, railTop);
  }

  function buildCeilings(g) {
    var store = PET.store;
    store.levels.forEach(function (L) {
      var z = levelElev(L) + L.def.height;
      L.def.rooms.forEach(function (r) {
        if (r.patio || r.porch || r.vaulted) return;
        if (r.stair && levelElev(L) === 0) return;        // open stairwell up to the bonus floor
        prism(g, r.x1 - 60, r.y1 - 60, r.x2 + 60, r.y2 + 60, z, z + 20, MAT.ceiling, false);
      });
    });
  }

  /* ---------- roof ---------- */
  function triMesh(g, tris, mat) {
    if (!tris.length) return;
    var pos = [];
    tris.forEach(function (t) {
      t.forEach(function (p) { pos.push(p[0], p[2], -p[1]); });   // plan (x,y,z) -> world
    });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    var m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
  }

  function quad(a, b, c, d) { return [[a, b, c], [a, c, d]]; }

  /* a straight member from plan point A to B ([x, y, z]); hangs below the
     line unless `centred` (fascia boards hang, handrails sit centred) */
  function band(g, A, B, h, t, mat, centred) {
    var a = new THREE.Vector3(A[0], A[2], -A[1]), b = new THREE.Vector3(B[0], B[2], -B[1]);
    var d = new THREE.Vector3().subVectors(b, a), len = d.length();
    if (len < 1) return;
    var m = box(len, h, t, mat);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize());
    m.position.copy(a).add(b).multiplyScalar(0.5);
    if (!centred) m.position.y -= h / 2;
    m.castShadow = true;
    g.add(m);
  }

  function buildRoof(g) {
    var data = PET.store.data, ov = data.overhang || 457;
    var plate = PET.store.levelById("main").def.height;
    data.roof.forEach(function (r) {
      var tris = [], gables = [];
      if (r.kind === "shed") {
        var zAt = function (x, y) {
          var d = r.high === "n" ? r.y2 - y : r.high === "s" ? y - r.y1 : r.high === "e" ? r.x2 - x : x - r.x1;
          return r.zHigh - d * r.pitch;
        };
        var c = [[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2]].map(function (p) { return [p[0], p[1], zAt(p[0], p[1])]; });
        tris = tris.concat(quad(c[0], c[1], c[2], c[3]));
        triMesh(g, tris, MAT.roofMetal);
        for (var e = 0; e < 4; e++) band(g, c[e], c[(e + 1) % 4], 150, 25, MAT.fascia);
        return;
      }
      /* gable/hip in a local frame: u along the ridge, v across it */
      var X = r.axis === "x";
      var u1 = X ? r.x1 : r.y1, u2 = X ? r.x2 : r.y2;
      var v1 = X ? r.y1 : r.x1, v2 = X ? r.y2 : r.x2, vr = r.ridgeAt;
      var H = r.ridgeZ, p = r.pitch;
      var z1 = H - (vr - v1) * p, z2 = H - (v2 - vr) * p;
      var run = Math.min(vr - v1, v2 - vr);
      var ua = r.ends[0] === "hip" ? u1 + run : u1;
      var ub = r.ends[1] === "hip" ? u2 - run : u2;
      function P(u, v, z) { return X ? [u, v, z] : [v, u, z]; }
      tris = tris.concat(quad(P(u1, v1, z1), P(u2, v1, z1), P(ub, vr, H), P(ua, vr, H)));
      tris = tris.concat(quad(P(u2, v2, z2), P(u1, v2, z2), P(ua, vr, H), P(ub, vr, H)));
      if (r.ends[0] === "hip") tris.push([P(u1, v2, z2), P(u1, v1, z1), P(ua, vr, H)]);
      if (r.ends[1] === "hip") tris.push([P(u2, v1, z1), P(u2, v2, z2), P(ub, vr, H)]);
      triMesh(g, tris, MAT.roof);
      /* fascia along both eaves and up each gable rake */
      band(g, P(u1, v1, z1), P(u2, v1, z1), 230, 30, MAT.fascia);
      band(g, P(u1, v2, z2), P(u2, v2, z2), 230, 30, MAT.fascia);
      [0, 1].forEach(function (k) {
        if (r.ends[k] !== "gable") return;
        var ue = k === 0 ? u1 : u2;
        band(g, P(ue, v1, z1), P(ue, vr, H), 230, 30, MAT.fascia);
        band(g, P(ue, vr, H), P(ue, v2, z2), 230, 30, MAT.fascia);
      });
      /* gable-end walls at the wall line (one overhang in from the roof edge) */
      var base = r.gableBase || plate;
      [0, 1].forEach(function (k) {
        if (r.ends[k] !== "gable") return;
        var u = k === 0 ? u1 + ov : u2 - ov;
        var va = v1 + ov, vb = v2 - ov;
        var za = H - (vr - va) * p, zb = H - (vb - vr) * p;
        var pts = [P(u, va, base), P(u, va, Math.max(base, za)), P(u, vr, H), P(u, vb, Math.max(base, zb)), P(u, vb, base)];
        for (var i = 1; i < pts.length - 1; i++) gables.push([pts[0], pts[i], pts[i + 1]]);
      });
      triMesh(g, gables, MAT.gable);
      /* windows set in a gable end (A3.1), e.g. the 2640 FX high in the south-west gable */
      (r.gableWindows || []).forEach(function (gw) {
        var k = gw.end, u = (k === 0 ? u1 + ov : u2 - ov) + (k === 0 ? -25 : 25);
        var z0 = gw.head - gw.h, va = vr - gw.w / 2, vb = vr + gw.w / 2;
        var pa = P(u, va, 0), pb = P(u, vb, 0);
        var gr = { x1: Math.min(pa[0], pb[0]) - (X ? 15 : 0), x2: Math.max(pa[0], pb[0]) + (X ? 15 : 0),
                   y1: Math.min(pa[1], pb[1]) - (X ? 0 : 15), y2: Math.max(pa[1], pb[1]) + (X ? 0 : 15) };
        prism(g, gr.x1, gr.y1, gr.x2, gr.y2, z0, gw.head, MAT.glass, false);
        windowTrim(g, { o: X ? "v" : "h", thick: 40 }, gr, z0, gw.head, "fx");
      });
    });

    (data.skirts || []).forEach(function (s) {
      prism(g, s.x1, s.y1, s.x2, s.y2, s.z0, s.z1, MAT.wallExt);
    });
  }

  /* ---------- furniture ---------- */
  /* only large solid pieces block the walker; chairs, tables, rugs,
     plants, and small items do not, so you can walk past them */
  var BLOCKS = { "bed-king": 1, "bed-queen": 1, sofa3: 1, island: 1, counter: 1, fridge: 1, range: 1,
    shelf: 1, "dresser-t": 1, dresser: 1, bookshelf: 1, car: 1, workbench: 1, tub: 1, vanity: 1,
    washer: 1, dryer: 1, tvconsole: 1, shower: 1 };

  function buildFurniture(levelGroups) {
    var store = PET.store, cat = store.catalogByType;
    store.furniture.forEach(function (f) {
      var L = store.levelById(f.level || "main");
      if (!L) return;
      var elev = levelElev(L);
      var c = cat(f.type) || { color: 0xcccccc, h3d: 700, shape: "box" };
      var grp = furnitureMesh(f, c);
      grp.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      grp.position.set(f.x, elev, -f.y);
      grp.rotation.y = -(f.rot || 0) * Math.PI / 180;
      levelGroups[L.def.id].add(grp);
      if (BLOCKS[f.type]) {
        var b = PET.furnBounds(f);
        addCollider(b.x1 + 40, b.y1 + 40, b.x2 - 40, b.y2 - 40, elev, elev + c.h3d);
      }
    });
  }

  function furnitureMesh(f, c) {
    var grp = new THREE.Group();
    var mat = new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.75 });
    var h = c.h3d;
    var shape = c.shape;
    if (shape === "bed") {
      var base = box(f.w, 350, f.h, mat); base.position.y = 175; grp.add(base);
      var mattress = box(f.w - 60, 220, f.h - 60, new THREE.MeshStandardMaterial({ color: 0xf0e8da, roughness: 0.9 }));
      mattress.position.y = 460; grp.add(mattress);
      var pillow = box(f.w - 160, 110, 420, new THREE.MeshStandardMaterial({ color: 0xfaf6ee, roughness: 0.95 }));
      pillow.position.set(0, 600, -(f.h / 2 - 330)); grp.add(pillow);
    } else if (shape === "sofa") {
      var seat = box(f.w, 420, f.h, mat); seat.position.y = 210; grp.add(seat);
      var back = box(f.w, 360, f.h * 0.24, mat);
      back.position.set(0, 560, f.h / 2 - f.h * 0.12); grp.add(back);
      var armL = box(f.w * 0.12, 260, f.h, mat);
      armL.position.set(-f.w / 2 + f.w * 0.06, 550, 0); grp.add(armL);
      var armR = armL.clone(); armR.position.x = f.w / 2 - f.w * 0.06; grp.add(armR);
    } else if (shape === "table") {
      var top = box(f.w, 50, f.h, mat); top.position.y = h - 25; grp.add(top);
      var legGeo = new THREE.BoxGeometry(70, h - 50, 70);
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (p) {
        var leg = new THREE.Mesh(legGeo, mat);
        leg.position.set(p[0] * (f.w / 2 - 70), (h - 50) / 2, p[1] * (f.h / 2 - 70));
        grp.add(leg);
      });
    } else if (shape === "chair") {
      var seatC = box(f.w, 60, f.h, mat); seatC.position.y = h - 490; grp.add(seatC);
      var backC = box(f.w, 440, 60, mat); backC.position.set(0, h - 240, f.h / 2 - 30); grp.add(backC);
      var legGeo2 = new THREE.BoxGeometry(50, h - 490, 50);
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (p) {
        var leg = new THREE.Mesh(legGeo2, mat);
        leg.position.set(p[0] * (f.w / 2 - 55), (h - 490) / 2, p[1] * (f.h / 2 - 55));
        grp.add(leg);
      });
    } else if (shape === "toilet") {
      var tank = box(f.w, 380, 200, mat); tank.position.set(0, 500, f.h / 2 - 100); grp.add(tank);
      var bowl = box(f.w, 400, f.h - 220, mat); bowl.position.set(0, 200, -110); grp.add(bowl);
    } else if (shape === "tub") {
      var outer = box(f.w, h, f.h, mat); outer.position.y = h / 2; grp.add(outer);
      var inner = box(f.w - 160, 60, f.h - 160, new THREE.MeshStandardMaterial({ color: 0xf6f9fa, roughness: 0.3 }));
      inner.position.y = h - 10; grp.add(inner);
    } else if (shape === "shower") {
      var pan = box(f.w, 90, f.h, new THREE.MeshStandardMaterial({ color: 0xd6dfe3, roughness: 0.4 }));
      pan.position.y = 45; grp.add(pan);
      var glassS = new THREE.MeshStandardMaterial({ color: 0xcfe6ee, transparent: true, opacity: 0.28, roughness: 0.1 });
      var side1 = box(30, h - 90, f.h, glassS); side1.position.set(f.w / 2 - 15, (h - 90) / 2 + 90, 0); grp.add(side1);
      var side2 = box(f.w, h - 90, 30, glassS); side2.position.set(0, (h - 90) / 2 + 90, f.h / 2 - 15); grp.add(side2);
    } else if (shape === "rug") {
      var rug = box(f.w, 14, f.h, mat); rug.position.y = 7; grp.add(rug);
    } else if (shape === "car") {
      var body = box(f.w, 520, f.h, mat); body.position.y = 330; grp.add(body);
      var cabin = box(f.w - 160, 420, f.h * 0.45, new THREE.MeshStandardMaterial({ color: 0xc3d2e0, roughness: 0.2 }));
      cabin.position.set(0, 780, -f.h * 0.05); grp.add(cabin);
      var wheelGeo = new THREE.CylinderGeometry(300, 300, 180, 16);
      wheelGeo.rotateZ(Math.PI / 2);
      var wmat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.9 });
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (p) {
        var wheel = new THREE.Mesh(wheelGeo, wmat);
        wheel.position.set(p[0] * (f.w / 2), 300, p[1] * (f.h / 2 - 750));
        grp.add(wheel);
      });
    } else if (shape === "plant") {
      var pot = new THREE.Mesh(new THREE.CylinderGeometry(f.w * 0.32, f.w * 0.26, h * 0.42, 12), new THREE.MeshStandardMaterial({ color: 0x8f7a64, roughness: 0.9 }));
      pot.position.y = h * 0.21; grp.add(pot);
      var foliage = new THREE.Mesh(new THREE.SphereGeometry(f.w * 0.42, 12, 10), mat);
      foliage.position.y = h * 0.72; foliage.scale.y = 1.1; grp.add(foliage);
    } else if (shape === "bbq") {
      var kettle = new THREE.Mesh(new THREE.SphereGeometry(f.w * 0.42, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), mat);
      kettle.position.y = h * 0.62; grp.add(kettle);
      var legs = box(f.w * 0.7, 30, f.w * 0.7, mat); legs.position.y = 4; grp.add(legs);
      var pole = box(60, h * 0.62, 60, mat); pole.position.y = h * 0.31; grp.add(pole);
    } else {
      var b = box(f.w, h, f.h, mat);
      b.position.y = h / 2;
      grp.add(b);
    }
    return grp;
  }

  /* ================= REBUILD ================= */
  var rebuildQueued = false;
  function rebuild() {
    if (!ready) return;
    rebuildQueued = false;
    if (root) {
      scene.remove(root);
      root.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
      });
    }
    root = new THREE.Group();
    colliders = [];
    surfaces = [];
    parts = {};
    var store = PET.store;
    var levelGroups = {};
    store.levels.forEach(function (L) {
      var g = new THREE.Group();
      g.name = "level-" + L.def.id;
      buildFloors(g, L);
      buildWalls(g, L);
      buildOpenings(g, L);
      levelGroups[L.def.id] = g;
      root.add(g);
    });
    buildStair(levelGroups.main);
    (store.data.beams || []).forEach(function (b) {          // porch beams on the posts
      prism(levelGroups.main, b.x1, b.y1, b.x2, b.y2, b.z0, b.z1, MAT.post);
    });
    buildFurniture(levelGroups);
    parts.upper = levelGroups.bonus;
    parts.ceilings = new THREE.Group(); buildCeilings(parts.ceilings); root.add(parts.ceilings);
    parts.roof = new THREE.Group(); buildRoof(parts.roof); root.add(parts.roof);
    applyVisibility();
    scene.add(root);
    if (active) renderFrame();
  }

  function applyVisibility() {
    if (!parts.roof) return;
    var inWalk = mode === "walk";
    var upper = inWalk || view.upper;
    var roof = inWalk || (view.roof && upper);
    if (parts.upper) parts.upper.visible = upper;
    parts.roof.visible = roof;
    parts.ceilings.visible = inWalk;
    var br = document.getElementById("btn-roof"), bu = document.getElementById("btn-upper");
    if (br) br.classList.toggle("active", view.roof);
    if (bu) bu.classList.toggle("active", view.upper);
  }

  function scheduleRebuild() {
    if (rebuildQueued) return;
    rebuildQueued = true;
    setTimeout(rebuild, 90);
  }

  PET.view3dSchedule = scheduleRebuild;

  /* ================= INIT ================= */

  function planBounds() {
    var b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    PET.store.levels.forEach(function (L) {
      L.def.rooms.forEach(function (r) {
        b.x1 = Math.min(b.x1, r.x1); b.y1 = Math.min(b.y1, r.y1);
        b.x2 = Math.max(b.x2, r.x2); b.y2 = Math.max(b.y2, r.y2);
      });
    });
    return b;
  }

  function planCentre() {
    var b = planBounds();
    return new THREE.Vector3((b.x1 + b.x2) / 2, 0, -(b.y1 + b.y2) / 2);
  }

  function init(el) {
    container = el;
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = brightness;
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xd3dae2);
    scene.fog = new THREE.Fog(0xd3dae2, 70000, 180000);

    camera = new THREE.PerspectiveCamera(50, 1, 10, 300000);

    var c = planCentre();
    orbit.target.copy(c);

    /* lights — softer than before; the brightness slider scales exposure */
    var hemi = new THREE.HemisphereLight(0xf6f3ec, 0x6f7462, 0.62);
    scene.add(hemi);
    sun = new THREE.DirectionalLight(0xfff0d8, 1.0);
    sun.position.set(c.x - 26000, 40000, c.z - 20000);
    sun.target.position.copy(c);
    scene.add(sun.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    var d = 26000;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1000; sun.shadow.camera.far = 120000;
    sun.shadow.bias = -0.0004;
    scene.add(sun);
    var fill = new THREE.DirectionalLight(0xdfe8ff, 0.25);
    fill.position.set(c.x + 26000, 20000, c.z + 26000);
    scene.add(fill);

    /* ground */
    var ground = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000), MAT.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -110;
    ground.receiveShadow = true;
    scene.add(ground);
    var grid = new THREE.GridHelper(400000, 200, 0x86927a, 0x8d9981);
    grid.position.y = -105;
    scene.add(grid);

    ready = true;
    resize();
    bindInput();
    rebuild();
    animate();
  }

  function resize() {
    if (!ready) return;
    var r = container.getBoundingClientRect();
    var w = Math.max(2, r.width), h = Math.max(2, r.height);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + "px";
    renderer.domElement.style.height = h + "px";
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderFrame();
  }

  /* ================= CAMERA ================= */

  function cameraFromOrbit() {
    var o = orbit;
    var sx = Math.sin(o.phi) * Math.sin(o.theta);
    var sy = Math.cos(o.phi);
    var sz = Math.sin(o.phi) * Math.cos(o.theta);
    camera.position.set(
      o.target.x + o.dist * sx,
      o.target.y + o.dist * sy,
      o.target.z + o.dist * sz
    );
    camera.lookAt(o.target);
  }

  /* ================= INPUT: ORBIT ================= */
  var dragBtn = -1, lastX = 0, lastY = 0;

  function bindInput() {
    var el = renderer.domElement;
    el.addEventListener("pointerdown", function (e) {
      if (mode !== "orbit") return;
      dragBtn = e.button;
      lastX = e.clientX; lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", function (e) {
      if (mode !== "orbit" || dragBtn < 0) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (dragBtn === 0 && !e.shiftKey) {
        orbit.theta -= dx * 0.0055;
        orbit.phi = PET.clamp(orbit.phi - dy * 0.0045, 0.08, Math.PI / 2 - 0.03);
      } else {
        /* pan target in view plane */
        var panScale = orbit.dist * 0.0011;
        var right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        var up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        orbit.target.addScaledVector(right, -dx * panScale);
        orbit.target.addScaledVector(up, dy * panScale);
      }
      cameraFromOrbit();
      renderFrame();
    });
    el.addEventListener("pointerup", function () {
      dragBtn = -1;
    });
    el.addEventListener("wheel", function (e) {
      if (mode !== "orbit") return;
      e.preventDefault();
      orbit.dist = PET.clamp(orbit.dist * (e.deltaY > 0 ? 1.12 : 1 / 1.12), 3000, 220000);
      cameraFromOrbit();
      renderFrame();
    }, { passive: false });
    el.addEventListener("dblclick", function () {
      if (mode === "orbit") startWalk();
      else stopWalk();
    });
    /* pointer lock for walk mode */
    document.addEventListener("pointerlockchange", function () {
      walk.locked = document.pointerLockElement === renderer.domElement;
      var hint = document.getElementById("walk-hint");
      if (hint) hint.classList.toggle("hidden", !(mode === "walk" && walk.locked));
    });
    document.addEventListener("mousemove", function (e) {
      if (mode !== "walk" || !walk.locked) return;
      walk.yaw -= e.movementX * 0.0022;
      walk.pitch = PET.clamp(walk.pitch - e.movementY * 0.0018, -1.35, 1.35);
    });
    window.addEventListener("keydown", function (e) {
      if (mode !== "walk") return;
      walk.keys[e.code] = true;
      if (e.code === "Escape") stopWalk();
    });
    window.addEventListener("keyup", function (e) {
      if (mode !== "walk") return;
      walk.keys[e.code] = false;
    });
  }

  /* ================= WALK MODE ================= */

  /* where the walk starts: the camera's spot if it is inside a room on the
     active floor, otherwise that floor's main living space */
  function walkStart() {
    var store = PET.store;
    var L = store.levelById(store.level) || store.levels[0];
    var elev = levelElev(L);
    var x = orbit.target.x, y = -orbit.target.z;
    var r = PET.roomAt(L.def, x, y);
    if (!r || r.void || r.patio || r.porch || r.stair) {
      var prefer = elev > 0 ? "bonus" : "foyer";
      var b = PET.roomBounds(L.def.rooms, prefer);
      x = (b.x1 + b.x2) / 2; y = (b.y1 + b.y2) / 2;
    }
    return { x: x, y: y, feet: elev };
  }

  function startWalk() {
    mode = "walk";
    applyVisibility();
    var s = walkStart();
    walk.feet = s.feet;
    camera.position.set(s.x, s.feet + walk.eye, -s.y);
    var c = planCentre();
    walk.yaw = Math.atan2(-(c.x - s.x), -(c.z + s.y));
    walk.pitch = -0.06;
    try { renderer.domElement.requestPointerLock(); } catch (e) { /* headless */ }
    syncModeButtons();
    renderFrame();
  }

  function stopWalk() {
    mode = "orbit";
    if (document.pointerLockElement) document.exitPointerLock();
    orbit.target.copy(camera.position);
    orbit.target.y = 0;
    applyVisibility();
    cameraFromOrbit();
    syncModeButtons();
    renderFrame();
  }

  /* floor height under (x, y) for someone whose feet are at `feet` */
  function floorAt(x, y, feet) {
    var best = 0;
    for (var i = 0; i < surfaces.length; i++) {
      var s = surfaces[i];
      if (x < s.x1 || x > s.x2 || y < s.y1 || y > s.y2) continue;
      if (s.h <= feet + STEP && s.h > best) best = s.h;
    }
    return best;
  }

  /* colliders the body overlaps at (x, z) with feet at `feet` */
  function hits(x, z, feet) {
    var out = [];
    var lo = feet + STEP, hi = feet + 1750, r = BODY_R;
    for (var i = 0; i < colliders.length; i++) {
      var c = colliders[i];
      if (c.y1 <= lo || c.y0 >= hi) continue;
      if (x > c.x1 - r && x < c.x2 + r && z > c.z1 - r && z < c.z2 + r) out.push(i);
    }
    return out;
  }

  /* a move is blocked only by colliders the walker is not already inside,
     so a bad start position can never trap the camera */
  function blocked(x, z, feet, stuck) {
    var h = hits(x, z, feet);
    for (var i = 0; i < h.length; i++) if (stuck.indexOf(h[i]) < 0) return true;
    return false;
  }

  function walkMove(dt) {
    var k = walk.keys;
    var fwd = 0, strafe = 0;
    if (k.KeyW || k.ArrowUp) fwd += 1;
    if (k.KeyS || k.ArrowDown) fwd -= 1;
    if (k.KeyD || k.ArrowRight) strafe += 1;
    if (k.KeyA || k.ArrowLeft) strafe -= 1;
    var speed = walk.speed * (k.ShiftLeft || k.ShiftRight ? 2 : 1) * dt;
    var sin = Math.sin(walk.yaw), cos = Math.cos(walk.yaw);
    var dx = (-sin * fwd + cos * strafe) * speed;
    var dz = (-cos * fwd - sin * strafe) * speed;
    var p = camera.position;
    var stuck = hits(p.x, p.z, walk.feet);
    /* sub-step so fast moves cannot tunnel through thin walls */
    var n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 60));
    for (var i = 0; i < n; i++) {
      var nx = p.x + dx / n, nz = p.z + dz / n;
      if (!blocked(nx, p.z, walk.feet, stuck)) p.x = nx;
      if (!blocked(p.x, nz, walk.feet, stuck)) p.z = nz;
    }
    /* follow the floor: climb stairs, drop down a step */
    var target = floorAt(p.x, -p.z, walk.feet);
    walk.feet += (target - walk.feet) * Math.min(1, dt * 14);
    if (Math.abs(target - walk.feet) < 2) walk.feet = target;
    var moving = fwd !== 0 || strafe !== 0;
    p.y = walk.feet + walk.eye + (moving ? Math.sin(performance.now() / 95) * 12 : 0);
    camera.rotation.set(walk.pitch, walk.yaw, 0, "YXZ");
  }

  /* ================= LOOP ================= */

  var lastT = 0;
  function animate() {
    requestAnimationFrame(animate);
    var now = performance.now();
    var dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    if (!active) return;
    if (mode === "walk") {
      walkMove(dt);
      renderFrame();
    }
  }

  var renderQueued = false;
  function renderFrame() {
    if (!ready || !active) return;
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      renderer.render(scene, camera);
    });
  }

  /* ================= UI ================= */

  function syncModeButtons() {
    var bm = document.getElementById("btn-mode-orbit");
    var bw = document.getElementById("btn-mode-walk");
    if (bm) bm.classList.toggle("active", mode === "orbit");
    if (bw) bw.classList.toggle("active", mode === "walk");
    var hint = document.getElementById("walk-hint");
    if (hint) hint.classList.toggle("hidden", !(mode === "walk" && walk.locked));
  }

  /* ================= PUBLIC API ================= */

  var api = {};
  api.init = init;
  api.rebuild = rebuild;
  api.resize = resize;
  api.cameraFromOrbit = cameraFromOrbit;
  api.isReady = function () { return ready; };

  api.setActive = function (on) {
    active = on;
    if (on) {
      resize();
      rebuild();
      cameraFromOrbit();
      renderFrame();
      lastT = performance.now();
    } else if (mode === "walk") {
      stopWalk();
    }
  };

  api.topView = function () {
    if (mode === "walk") stopWalk();
    orbit.theta = 0;
    orbit.phi = 0.1;
    orbit.dist = 58000;
    orbit.target.copy(planCentre());
    cameraFromOrbit();
    renderFrame();
  };

  api.isoView = function () {
    if (mode === "walk") stopWalk();
    orbit.theta = -Math.PI / 4;
    orbit.phi = 1.0;
    orbit.dist = 56000;
    orbit.target.copy(planCentre());
    cameraFromOrbit();
    renderFrame();
  };

  api.orbitMode = function () {
    if (mode === "walk") stopWalk();
    else { syncModeButtons(); renderFrame(); }
  };
  api.walkMode = function () { startWalk(); };
  api.getMode = function () { return mode; };

  api.toggleRoof = function () {
    view.roof = !view.roof;
    if (view.roof) view.upper = true;
    applyVisibility(); renderFrame();
  };
  api.toggleUpper = function () {
    view.upper = !view.upper;
    applyVisibility(); renderFrame();
  };
  api.setView = function (v) {
    if ("roof" in v) view.roof = !!v.roof;
    if ("upper" in v) view.upper = !!v.upper;
    applyVisibility(); renderFrame();
  };
  api.getView = function () { return { roof: view.roof, upper: view.upper }; };
  api.setOrbit = function (theta, phi, dist, tx, ty) {
    if (mode === "walk") stopWalk();
    orbit.theta = theta; orbit.phi = phi; orbit.dist = dist;
    var c = planCentre();
    orbit.target.set(tx === undefined ? c.x : tx, 0, ty === undefined ? c.z : -ty);
    cameraFromOrbit(); renderFrame();
  };
  /* 2D floor switch: show the upstairs only when it is the floor being edited */
  api.levelChanged = function () {
    view.upper = PET.store.level !== "main";
    if (!view.upper) view.roof = false;
    applyVisibility(); renderFrame();
  };

  api.getBrightness = function () { return brightness; };
  api.setBrightness = function (v) {
    brightness = v;
    if (renderer) renderer.toneMappingExposure = v;
    try { localStorage.setItem("peterson-bright", String(v)); } catch (e) { /* ignore */ }
    renderFrame();
  };

  /* test hooks for qa/interactive-qa.js */
  api.debug = {
    floorAt: function (x, y, feet) { return floorAt(x, y, feet); },
    walkTo: function (x, y, feet) {
      walk.feet = feet; camera.position.set(x, feet + walk.eye, -y);
    },
    step: function (keys, seconds, yaw) {
      if (yaw !== undefined) walk.yaw = yaw;
      walk.keys = keys;
      var t = 0;
      while (t < seconds) { walkMove(1 / 60); t += 1 / 60; }
      walk.keys = {};
      return { x: camera.position.x, y: -camera.position.z, feet: walk.feet };
    },
    counts: function () { return { colliders: colliders.length, surfaces: surfaces.length }; },
  };

  api.snapshot = function () {
    if (!ready) return null;
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL("image/png");
  };

  PET.view3d = api;
  initMats();

})(window.PET);
