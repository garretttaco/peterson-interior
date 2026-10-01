/* ============ App bootstrap: UI wiring, view switching, export ============ */
(function (PET) {
  "use strict";

  var toastTimer = null;
  PET.toast = function (msg, isErr) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "show" + (isErr ? " err" : " ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ""; }, 2400);
  };

  var view3dInited = false;
  var currentView = "2d";

  /* ---------- view switching ---------- */
  function showView(which) {
    currentView = which;
    var c2 = document.getElementById("canvas2d");
    var v3 = document.getElementById("view3d");
    var b2 = document.getElementById("btn-2d");
    var b3 = document.getElementById("btn-3d");
    if (which === "2d") {
      v3.classList.add("hidden");
      c2.classList.remove("hidden");
      b2.classList.add("active");
      b3.classList.remove("active");
      PET.view2d.render();
    } else {
      c2.classList.add("hidden");
      v3.classList.remove("hidden");
      b3.classList.add("active");
      b2.classList.remove("active");
      if (!view3dInited) {
        view3dInited = true;
        try {
          PET.view3d.init(document.getElementById("three-container"));
          PET.view3d.isoView();
        } catch (e) {
          PET.toast("3D failed to start: " + e.message, true);
          return;
        }
      }
      /* wait for the CSS transition frame so sizes are real */
      requestAnimationFrame(function () {
        PET.view3d.setActive(true);
        PET.view3d.isoView();
      });
    }
  }

  /* ---------- sidebar: rooms ---------- */
  function buildRoomList() {
    var ul = document.getElementById("room-list");
    ul.innerHTML = "";
    var all = PET.store.plan.rooms;
    var rooms = all.filter(function (r) { return !r.part && !r.void; }).sort(function (a, b) {
      return (a.name > b.name) ? 1 : -1;
    });
    rooms.forEach(function (r) {
      var li = document.createElement("li");
      li.dataset.room = r.id;
      var mat = PET.store.materialById(PET.store.materials[r.id]);
      var area = PET.m2(PET.roomAreaById(all, r.id));
      li.innerHTML = '<span class="dot" style="background:' + mat.color2d + '"></span>' +
        '<span>' + r.name + '</span>' +
        '<span class="area">' + area + '</span>';
      li.addEventListener("click", function () {
        if (currentView !== "2d") showView("2d");
        PET.store.selection = { kind: "room", id: r.id };
        PET.view2d.zoomToRoom(r);
        document.getElementById("st-info").textContent =
          r.name + " — " + area + " · floor: " + mat.name;
        highlightRoomRow(r.id);
      });
      ul.appendChild(li);
    });
    document.getElementById("room-count").textContent = rooms.length;
  }

  function highlightRoomRow(id) {
    var lis = document.querySelectorAll("#room-list li");
    for (var i = 0; i < lis.length; i++) {
      lis[i].classList.toggle("active", lis[i].dataset.room === id);
    }
  }

  /* ---------- sidebar: furniture palette ---------- */
  function buildFurniturePalette() {
    var box = document.getElementById("furniture-list");
    box.innerHTML = "";
    PET_FURNITURE_CATALOG.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "fitem";
      b.title = c.name + " — " + c.w + "×" + c.h + " mm";
      b.innerHTML = PET.glyph(c.type) + "<span>" + c.name + "</span>";
      b.addEventListener("click", function () {
        if (currentView !== "2d") showView("2d");
        PET.view2d.addFurniture(c.type);
      });
      box.appendChild(b);
    });
  }

  /* ---------- sidebar: materials ---------- */
  function buildMaterialList() {
    var box = document.getElementById("material-list");
    box.innerHTML = "";
    PET_MATERIALS.forEach(function (m) {
      var b = document.createElement("button");
      b.className = "mitem" + (PET.store.activeMaterial === m.id ? " active" : "");
      b.dataset.mat = m.id;
      b.innerHTML = '<span class="swatch" style="background:' + m.color2d + '"></span><span>' + m.name + '</span>';
      b.addEventListener("click", function () {
        PET.store.activeMaterial = m.id;
        var all = document.querySelectorAll(".mitem");
        for (var i = 0; i < all.length; i++) all[i].classList.toggle("active", all[i].dataset.mat === m.id);
        /* apply to selected room immediately if there is one */
        var sel = PET.store.selection;
        if (sel && sel.kind === "room") {
          PET.store.materials[sel.id] = m.id;
          PET.store.commit("material");
          PET.toast("Floor set to " + m.name);
        } else {
          PET.toast("Pick a room with the Floor tool", false);
        }
      });
      box.appendChild(b);
    });
  }

  /* ---------- toolbar ---------- */
  function setActiveTool(t) {
    var btns = document.querySelectorAll("#toolbar .tool[data-tool]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].dataset.tool === t);
    }
    PET.view2d.setTool(t);
    var hints = {
      select: "Drag furniture to move · snap to walls · R rotate · [ ] fine rotate · Delete removes",
      measure: "Click two points to measure · right-click clears all",
      demolish: "Click a partition wall to remove/restore it · load-bearing walls refuse",
      material: "Pick a material in the sidebar, then click a room",
    };
    document.getElementById("st-info").textContent = hints[t] || "";
  }

  function wireToolbar() {
    var btns = document.querySelectorAll("#toolbar .tool[data-tool]");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function () { setActiveTool(b.dataset.tool); });
      })(btns[i]);
    }
    document.getElementById("btn-undo").addEventListener("click", function () {
      if (!PET.store.undo()) PET.toast("Nothing to undo");
    });
    document.getElementById("btn-redo").addEventListener("click", function () {
      if (!PET.store.redo()) PET.toast("Nothing to redo");
    });
    document.getElementById("btn-fit").addEventListener("click", function () {
      if (currentView === "2d") PET.view2d.fit(); else PET.view3d.isoView();
    });
    document.getElementById("btn-reset").addEventListener("click", function () {
      if (confirm("Reset the layout to the default Peterson arrangement?")) {
        PET.store.reset();
        PET.toast("Reset to default layout");
      }
    });
    document.getElementById("btn-export").addEventListener("click", function () {
      var url, name;
      if (currentView === "3d") {
        url = PET.view3d.snapshot();
        name = "peterson-3d.png";
      } else {
        url = PET.view2d.renderExport(2);
        name = "peterson-floorplan.png";
      }
      if (!url) return;
      var a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      PET.toast("Exported " + name);
    });
    document.getElementById("btn-2d").addEventListener("click", function () { showView("2d"); });
    document.getElementById("btn-3d").addEventListener("click", function () { showView("3d"); });

    /* 3D floating UI */
    document.getElementById("btn-mode-orbit").addEventListener("click", function () { PET.view3d.orbitMode(); });
    document.getElementById("btn-mode-walk").addEventListener("click", function () { PET.view3d.walkMode(); });
    document.getElementById("btn-top").addEventListener("click", function () { PET.view3d.topView(); });
    document.getElementById("btn-iso").addEventListener("click", function () { PET.view3d.isoView(); });
    document.getElementById("btn-roof").addEventListener("click", function () { PET.view3d.toggleRoof(); });
    document.getElementById("btn-upper").addEventListener("click", function () { PET.view3d.toggleUpper(); });
    var rng = document.getElementById("rng-bright");
    rng.value = PET.view3d.getBrightness();
    rng.addEventListener("input", function () { PET.view3d.setBrightness(parseFloat(rng.value)); });

    /* floor switch */
    var lv = document.querySelectorAll("#levelswitch button");
    for (var i = 0; i < lv.length; i++) {
      (function (b) {
        b.addEventListener("click", function () { setLevel(b.dataset.level); });
      })(lv[i]);
    }
  }

  function setLevel(id) {
    PET.store.setLevel(id);
    var lv = document.querySelectorAll("#levelswitch button");
    for (var i = 0; i < lv.length; i++) lv[i].classList.toggle("active", lv[i].dataset.level === PET.store.level);
    document.getElementById("brand-sub").textContent = PET.store.plan.name + " · exact from PDF · mm";
    buildRoomList();
  }
  PET.setLevel = setLevel;

  /* ---------- store events ---------- */
  function wireStore() {
    PET.store.on(function (what) {
      if (what === "saved") {
        var el = document.getElementById("save-indicator");
        if (el) {
          el.textContent = "✓ Saved";
          el.style.opacity = "1";
          setTimeout(function () { el.style.opacity = ".75"; }, 900);
        }
        return;
      }
      if (what === "reset") {
        buildRoomList();
        buildMaterialList();
      }
      if (what === "level") {
        PET.view2d.render();
        if (view3dInited) PET.view3d.levelChanged();
        return;
      }
      PET.view2d.render();
      if (view3dInited) PET.view3dSchedule();
      var sel = PET.store.selection;
      if (sel && sel.kind === "room") highlightRoomRow(sel.id);
      updateUndoButtons();
    });
  }

  function updateUndoButtons() {
    document.getElementById("btn-undo").disabled = !PET.store.canUndo();
    document.getElementById("btn-redo").disabled = !PET.store.canRedo();
  }

  /* ---------- boot ---------- */
  function boot() {
    PET.store.init(PET_PLAN);
    PET.view2d.init(document.getElementById("canvas2d"));
    buildRoomList();
    buildFurniturePalette();
    buildMaterialList();
    wireToolbar();
    wireStore();
    setActiveTool("select");
    updateUndoButtons();
    window.addEventListener("resize", function () {
      PET.view2d.render();
      if (view3dInited) PET.view3d.resize();
    });
    var spaces = 0;
    PET.store.levels.forEach(function (L) {
      spaces += L.def.rooms.filter(function (r) { return !r.part && !r.void; }).length;
    });
    PET.toast("Peterson plan loaded — 2 floors, " + spaces + " spaces", false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

})(window.PET);
