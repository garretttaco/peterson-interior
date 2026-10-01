/* ============ State store: model + undo/redo + localStorage ============ */
(function (PET) {
  "use strict";

  var LS_KEY = "peterson-interior-v1";
  var LAYOUT_VERSION = 4;      // bump when the default plan/layout changes
  var MAX_HISTORY = 80;

  var store = {
    data: null,          // static plan data (all levels, roof)
    levels: [],          // [{ def, walls, openings }] per level
    level: "main",       // id of the level shown in 2D
    plan: null,          // active level: { id, name, rooms, stair, dims, ... }
    walls: [],           // active level's walls
    openings: [],        // active level's openings
    furniture: [],       // runtime furniture items
    materials: {},       // roomId -> materialId
    demolished: {},      // wallId -> true
    measurements: [],    // {x1,y1,x2,y2}
    selection: null,     // {kind:'furniture'|'room'|'wall', id}
    tool: "select",
    activeMaterial: "oak",
    listeners: [],
    undoStack: [],
    redoStack: [],
    baseline: null,      // serialised state as of the last commit
  };

  PET.store = store;

  store.on = function (fn) { store.listeners.push(fn); };
  store.emit = function (what) {
    store.listeners.forEach(function (fn) { fn(what); });
  };

  /* ---------- serialisable slice ---------- */
  function slice() {
    return {
      v: LAYOUT_VERSION,
      furniture: store.furniture,
      materials: store.materials,
      demolished: store.demolished,
      measurements: store.measurements,
    };
  }
  function applySlice(s) {
    store.furniture = s.furniture;
    store.materials = s.materials;
    store.demolished = s.demolished;
    store.measurements = s.measurements || [];
  }

  /* ---------- history ----------
     The stacks hold *previous* states: commit() pushes the state as it was
     before the action that just happened (kept in `baseline`). */
  store.markBaseline = function () {
    store.baseline = JSON.stringify(slice());
  };

  store.commit = function (label) {
    if (store.baseline === null) store.markBaseline();
    store.undoStack.push(store.baseline);
    if (store.undoStack.length > MAX_HISTORY) store.undoStack.shift();
    store.redoStack.length = 0;
    store.baseline = JSON.stringify(slice());
    store.save();
    store.emit("commit:" + (label || ""));
  };

  store.undo = function () {
    if (!store.undoStack.length) return false;
    store.redoStack.push(JSON.stringify(slice()));
    var prev = store.undoStack.pop();
    applySlice(JSON.parse(prev));
    store.baseline = prev;
    store.ensureSelection();
    store.save();
    store.emit("undo");
    return true;
  };

  store.redo = function () {
    if (!store.redoStack.length) return false;
    store.undoStack.push(JSON.stringify(slice()));
    var next = store.redoStack.pop();
    applySlice(JSON.parse(next));
    store.baseline = next;
    store.ensureSelection();
    store.save();
    store.emit("redo");
    return true;
  };

  store.canUndo = function () { return store.undoStack.length > 0; };
  store.canRedo = function () { return store.redoStack.length > 0; };

  store.ensureSelection = function () {
    var sel = store.selection;
    if (!sel) return;
    if (sel.kind === "furniture" && !store.furniture.some(function (f) { return f.id === sel.id; })) {
      store.selection = null;
    }
  };

  /* ---------- persistence ---------- */
  store.save = PET.debounce(function () {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(slice()));
      store.emit("saved");
    } catch (e) { /* quota / private mode — ignore */ }
  }, 400);

  store.saveNow = function () {
    try { localStorage.setItem(LS_KEY, JSON.stringify(slice())); } catch (e) {}
  };

  store.load = function () {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      var s = JSON.parse(raw);
      if (s && s.v === LAYOUT_VERSION && Array.isArray(s.furniture)) { applySlice(s); return true; }
    } catch (e) { /* corrupt — fall through */ }
    return false;
  };

  store.reset = function () {
    if (store.baseline === null) store.markBaseline();
    PET.store.undoStack.push(store.baseline);
    store.furniture = PET.buildDefaultFurniture();
    prepareDefaults();
    store.materials = PET.buildDefaultMaterials(store.data);
    store.demolished = {};
    store.measurements = [];
    store.selection = null;
    store.redoStack.length = 0;
    store.markBaseline();
    store.saveNow();
    store.emit("reset");
  };

  /* clamp → decollide → clamp, per level, so the default layout always sits
     cleanly inside its rooms and flush off the walls */
  function prepareDefaults() {
    store.levels.forEach(function (L) {
      var items = store.furniture.filter(function (f) { return (f.level || "main") === L.def.id; });
      PET.prepareItems(items, L.walls, L.def.rooms);
    });
  }

  PET.prepareItems = function (items, walls, rooms) {
    PET.clampToRooms(items, walls, rooms);
    PET.decollideWalls(items, walls);
    PET.clampToRooms(items, walls, rooms);
    PET.decollideWalls(items, walls);
    PET.clampToRooms(items, walls, rooms);
    return items;
  };

  /* ---------- init ---------- */
  PET.buildDefaultMaterials = function (plan) {
    var map = {};
    var table = {
      living: "oak", kitchen: "oak", bedroom: "carpet", bath: "tile-lg",
      garage: "concrete", patio: "stone", utility: "vinyl", hall: "oak",
    };
    plan.levels.forEach(function (L) {
      L.rooms.forEach(function (r) {
        map[r.id] = r.porch ? "stone" : (table[r.kind] || "oak");
      });
    });
    return map;
  };

  PET.buildDefaultFurniture = function () {
    var cat = {};
    PET_FURNITURE_CATALOG.forEach(function (c) { cat[c.type] = c; });
    return PET_FURNITURE_DEFAULT.map(function (d, i) {
      var c = cat[d.type];
      return {
        id: "f" + i,
        type: d.type,
        x: d.x, y: d.y,
        rot: d.rot || 0,
        level: d.level || "main",
        w: d.w || c.w,
        h: d.h || c.h,
      };
    });
  };

  store.init = function (data) {
    store.data = data;
    store.levels = data.levels.map(function (L) {
      var built = PET.buildLevel(data, L);
      return { def: L, walls: built.walls, openings: built.openings };
    });
    store.setLevel("main", true);

    if (!store.load()) {
      store.furniture = PET.buildDefaultFurniture();
      prepareDefaults();
      store.materials = PET.buildDefaultMaterials(data);
    }
    /* make sure every room has a material */
    data.levels.forEach(function (L) {
      L.rooms.forEach(function (r) {
        if (!store.materials[r.id]) store.materials[r.id] = r.porch ? "stone" : "oak";
      });
    });

    store.furniture.forEach(function (f) {
      if (!f.id) f.id = PET.uid();
      if (!f.level) f.level = "main";
    });
    store.markBaseline();
  };

  /* switch the level shown (and edited) in 2D */
  store.setLevel = function (id, silent) {
    var L = store.levelById(id) || store.levels[0];
    store.level = L.def.id;
    store.plan = Object.assign({}, L.def, { dims: store.data.dims });
    store.walls = L.walls;
    store.openings = L.openings;
    if (store.selection && store.selection.kind !== "furniture") store.selection = null;
    if (store.selection && store.selection.kind === "furniture") {
      var f = store.furniture.find(function (it) { return it.id === store.selection.id; });
      if (!f || f.level !== store.level) store.selection = null;
    }
    if (!silent) store.emit("level");
  };

  store.levelById = function (id) {
    for (var i = 0; i < store.levels.length; i++) if (store.levels[i].def.id === id) return store.levels[i];
    return null;
  };

  /* furniture on the active 2D level */
  store.levelFurniture = function () {
    return store.furniture.filter(function (f) { return (f.level || "main") === store.level; });
  };

  /* helpful lookups */
  store.catalogByType = function (t) {
    for (var i = 0; i < PET_FURNITURE_CATALOG.length; i++) {
      if (PET_FURNITURE_CATALOG[i].type === t) return PET_FURNITURE_CATALOG[i];
    }
    return null;
  };

  store.materialById = function (id) {
    for (var i = 0; i < PET_MATERIALS.length; i++) {
      if (PET_MATERIALS[i].id === id) return PET_MATERIALS[i];
    }
    return PET_MATERIALS[0];
  };

})(window.PET);
