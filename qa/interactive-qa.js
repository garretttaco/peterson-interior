/* Interactive QA for the Peterson interior tool.
   Drives headless Chrome via puppeteer-core: real mouse drags, clicks, key presses. */
/* Interactive QA — real mouse/keyboard in headless Chrome.
   Needs: npm install --no-save puppeteer-core   (run from peterson-interior/)
   Chrome path override: CHROME_PATH=/path/to/chrome node qa/interactive-qa.js
   Run from peterson-interior/:  node qa/interactive-qa.js                  */
const puppeteer = require(process.env.PUPPETEER_PATH || "puppeteer-core");
const path = require("path");
const FILE = "file://" + path.resolve(__dirname, "..", "index.html");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader", "--window-size=1600,1000"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  const errors = [];
  const out0 = {};
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

  await page.goto(FILE, { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  /* the app opens on the 3D view with the roof and upstairs showing */
  await new Promise((r) => setTimeout(r, 1500));
  out0.default3d = await page.evaluate(() => ({
    view3d: !document.getElementById("view3d").classList.contains("hidden"),
    roof: PET.view3d.getView().roof, upper: PET.view3d.getView().upper,
  }));
  await page.click("#btn-2d");
  await page.waitForFunction("window.PET && PET.store && PET.store.walls.length > 0");
  await new Promise((r) => setTimeout(r, 600));

  const out = { errors, steps: out0 };

  /* helper: world -> screen coordinates inside the canvas */
  const w2s = async (x, y) => await page.evaluate((x, y) => {
    const v = PET.view2d.getView();
    const c = document.getElementById("canvas2d");
    const r = c.getBoundingClientRect();
    return { x: r.left + (x - v.cx) * v.scale + r.width / 2, y: r.top + r.height / 2 - (y - v.cy) * v.scale };
  }, x, y);

  const getFurn = async (id) => await page.evaluate((id) => {
    const f = PET.store.furniture.find((i) => i.id === id);
    return f ? { x: f.x, y: f.y, rot: f.rot, w: f.w, h: f.h } : null;
  }, id);

  /* ---- 1. select + drag a furniture item ---- */
  const target = await page.evaluate(() => {
    const f = PET.store.furniture.find((i) => i.type === "island");
    return { id: f.id, x: f.x, y: f.y };
  });
  let p = await w2s(target.x, target.y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 40, p.y + 10, { steps: 5 });
  const midState = await page.evaluate(() => ({
    sel: PET.store.selection && PET.store.selection.kind,
    info: document.getElementById("st-info").textContent.slice(0, 40),
  }));
  // drag the island 1.2 m north
  let p2 = await w2s(target.x, target.y + 1200);
  await page.mouse.move(p2.x, p2.y, { steps: 10 });
  await page.mouse.up();
  const afterDrag = await getFurn(target.id);
  out.steps.drag = {
    selected: midState.sel === "furniture",
    info: midState.info,
    moved: Math.abs(afterDrag.y - target.y) > 500,
    pos: [Math.round(afterDrag.x), Math.round(afterDrag.y)],
  };
  // undo the drag
  await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
  const afterUndo = await getFurn(target.id);
  out.steps.undoDrag = { back: Math.abs(afterUndo.y - target.y) < 5 };

  /* ---- 2. rotate via R and via wheel+shift ---- */
  await page.keyboard.press("r");
  const rot1 = (await getFurn(target.id)).rot;
  await page.keyboard.press("]");
  const rot2 = (await getFurn(target.id)).rot;
  out.steps.rotate = { rKey: rot1 === 90, bracket: rot2 === 95 };
  await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
  await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");

  /* ---- 3. resize via corner handle ---- */
  const f3 = await getFurn(target.id);
  const corner = await w2s(f3.x + f3.w / 2, f3.y + f3.h / 2); // se corner (rot 0)
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 30, corner.y - 20, { steps: 6 });  // right + up = grow
  await page.mouse.up();
  const f3b = await getFurn(target.id);
  out.steps.resize = { grew: f3b.w > f3.w + 50 && f3b.h > f3.h + 30, wh: [Math.round(f3b.w), Math.round(f3b.h)] };
  await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");

  /* ---- 4. measure tool ---- */
  await page.keyboard.press("m");
  const m1 = await w2s(3000, 20000);
  const m2 = await w2s(9000, 20000);
  await page.mouse.click(m1.x, m1.y);
  await page.mouse.click(m2.x, m2.y);
  const meas = await page.evaluate(() => PET.store.measurements.length);
  out.steps.measure = { count: meas >= 1, value: await page.evaluate(() => {
      const m = PET.store.measurements[PET.store.measurements.length - 1];
      return Math.round(Math.hypot(m.x2 - m.x1, m.y2 - m.y1));
    }) };
  await page.evaluate(() => { PET.store.measurements = []; });
  await page.keyboard.press("v");

  /* ---- 5. demolish a partition wall ---- */
  const partWall = await page.evaluate(() => {
    const w = PET.store.walls.find((w) => !w.load && w.kind === "wall" && w.o !== "d" && w.b - w.a > 1500);
    return { id: w.id, x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 };
  });
  await page.keyboard.press("d");
  p = await w2s(partWall.x, partWall.y);
  await page.mouse.click(p.x, p.y);
  const demo1 = await page.evaluate((id) => !!PET.store.demolished[id], partWall.id);
  // try to demolish a load-bearing wall — should refuse
  const loadWall = await page.evaluate(() => {
    const w = PET.store.walls.find((w) => w.load && w.kind === "wall" && w.o !== "d" && w.b - w.a > 1500);
    return { id: w.id, x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 };
  });
  p = await w2s(loadWall.x, loadWall.y);
  await page.mouse.click(p.x, p.y);
  const demo2 = await page.evaluate((id) => !!PET.store.demolished[id], loadWall.id);
  const toastTxt = await page.evaluate(() => document.getElementById("toast").textContent);
  out.steps.demolish = { partitionRemoved: demo1, loadRefused: !demo2, toast: toastTxt };
  await page.evaluate((id) => { delete PET.store.demolished[id]; PET.store.commit("cleanup"); }, partWall.id);
  await page.keyboard.press("v");

  /* ---- 6. material change on a room ---- */
  const lb = await page.evaluate(() => PET.roomBounds(PET.store.plan.rooms, "living"));
  const matSel = await w2s((lb.x1 + lb.x2) / 2, (lb.y1 + lb.y2) / 2 - 900); // living room, clear of furniture
  await page.keyboard.press("f");
  await page.evaluate(() => { PET.store.activeMaterial = "tile-mar"; });
  await page.mouse.click(matSel.x, matSel.y);
  const matNow = await page.evaluate(() => PET.store.materials["living"]);
  out.steps.material = { applied: matNow === "tile-mar", value: matNow };

  /* ---- 7. snap check: put the island 40 mm off a long wall face, expect flush ---- */
  const snapTest = await page.evaluate(() => {
    const f = PET.store.furniture.find((i) => i.type === "island");
    const wall = PET.store.walls.filter((w) => w.o === "h" && w.kind === "wall" && w.b - w.a > 3000)[0];
    if (!wall) return { err: "no long wall" };
    const cand = { x: (wall.a + wall.b) / 2, y: 0, w: f.w, h: f.h, rot: 0 };
    cand.y = wall.at - wall.thick / 2 - f.h / 2 - 40;   // 40mm gap below the face
    const sn = PET.snapFurniture(cand, PET.store.walls, PET.store.furniture, f.id);
    if (!sn) return { err: "no snap" };
    // after snapping, the item must be flush or at least not overlap the wall rect
    const b = { x1: sn.x - f.w / 2, y1: sn.y - f.h / 2, x2: sn.x + f.w / 2, y2: sn.y + f.h / 2 };
    const r = { x1: wall.a, y1: wall.at - wall.thick / 2, x2: wall.b, y2: wall.at + wall.thick / 2 };
    const overlap = Math.min(b.x2, r.x2) - Math.max(b.x1, r.x1) > 1 &&
                    Math.min(b.y2, r.y2) - Math.max(b.y1, r.y1) > 1;
    return { ok: !overlap && sn.snappedY && Math.abs(b.y2 - (wall.at - wall.thick / 2)) < 1, snapped: sn.snappedY, top: Math.round(b.y2), face: wall.at - wall.thick / 2 };
  });
  out.steps.snap = snapTest;

  /* ---- 8. add furniture from palette + delete ---- */
  const before = await page.evaluate(() => PET.store.furniture.length);
  await page.click(".fitem");   // first catalog item
  const afterAdd = await page.evaluate(() => PET.store.furniture.length);
  await page.keyboard.press("Delete");
  const afterDel = await page.evaluate(() => PET.store.furniture.length);
  out.steps.palette = { added: afterAdd === before + 1, deleted: afterDel === before };

  /* ---- 9. localStorage round-trip ---- */
  await page.evaluate(() => PET.store.saveNow());
  const saved = await page.evaluate(() => localStorage.getItem("peterson-interior-v1").length > 100);
  out.steps.persist = { saved };

  /* ---- 10. switch to 3D and back ---- */
  await page.click("#btn-3d");
  await new Promise((r) => setTimeout(r, 1800));
  out.steps.view3d = await page.evaluate(() => {
    const c = document.querySelector("#three-container canvas");
    return { canvas: !!c && c.width > 100, visible: !document.getElementById("view3d").classList.contains("hidden") };
  });
  await page.click("#btn-mode-walk");
  await new Promise((r) => setTimeout(r, 800));
  const walked = await page.evaluate(() => PET.view3d.getMode());
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  await page.click("#btn-top");
  await new Promise((r) => setTimeout(r, 500));
  out.steps.walk = { entered: walked === "walk", exited: (await page.evaluate(() => PET.view3d.getMode())) === "orbit" };
  await page.click("#btn-2d");
  await new Promise((r) => setTimeout(r, 500));
  out.steps.back2d = await page.evaluate(() => !document.getElementById("canvas2d").classList.contains("hidden"));

  /* ---- 11. 3D interaction sanity: orbit drag on the three canvas ---- */
  await page.click("#btn-3d");
  await new Promise((r) => setTimeout(r, 900));
  const camBefore = await page.evaluate(() => {
    const c = document.querySelector("#three-container canvas");
    return c ? { w: c.width, h: c.height } : null;
  });
  await page.mouse.move(800, 500);
  await page.mouse.down();
  await page.mouse.move(950, 560, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  out.steps.orbitDrag = { canvasOk: !!camBefore && camBefore.w > 100 };

  /* ---- 12. floor switch: upstairs plan, furniture filtered per floor ---- */
  await page.click("#btn-2d");
  await new Promise((r) => setTimeout(r, 400));
  await page.click("#btn-level-bonus");
  await new Promise((r) => setTimeout(r, 300));
  out.steps.levelSwitch = await page.evaluate(() => ({
    level: PET.store.level,
    rooms: PET.store.plan.rooms.length,
    onlyBonusFurniture: PET.store.levelFurniture().every((f) => f.level === "bonus"),
    bonusPieces: PET.store.levelFurniture().length,
    listShowsBonus: !!Array.from(document.querySelectorAll("#room-list li")).find((li) => li.textContent.includes("Bonus Room")),
  }));
  await page.click("#btn-level-main");

  /* ---- 13-15. walk mode: doorways, stairs, chairs ---- */
  await page.click("#btn-3d");
  await new Promise((r) => setTimeout(r, 1500));
  out.steps.walk3 = await page.evaluate(() => {
    const W = PET.view3d.debug;
    PET.view3d.walkMode();
    /* forward direction in plan coords for yaw: (-sin yaw, +cos yaw) */
    const yawFor = (dx, dy) => Math.atan2(-dx, dy);
    const res = { doorways: 0, failed: [] };
    PET.store.levels.forEach((L) => {
      const feet = L.def.elev;
      L.openings.forEach((op) => {
        if (!["door", "door2", "opening"].includes(op.type)) return;
        [1, -1].forEach((dir) => {
          const n = op.o === "h" ? [0, dir] : [dir, 0];
          /* skip doors into closets too narrow to stand in */
          const mid0 = (op.a + op.b) / 2;
          const far = op.o === "h" ? [mid0, op.at + dir * 500] : [op.at + dir * 500, mid0];
          const room = PET.roomAt(L.def, far[0], far[1]);
          if (room && Math.min(room.x2 - room.x1, room.y2 - room.y1) < 700) return;
          /* a body fits through if it passes at any of three lateral positions */
          let best = -1e9;
          [(op.a + op.b) / 2, op.a + 220, op.b - 220].forEach((m) => {
            if (best >= 250) return;
            const c = op.o === "h" ? [m, op.at] : [op.at, m];
            W.walkTo(c[0] - n[0] * 450, c[1] - n[1] * 450, feet);
            const end = W.step({ KeyW: true }, 0.34, yawFor(n[0], n[1]));
            best = Math.max(best, (end.x - c[0]) * n[0] + (end.y - c[1]) * n[1]);
          });
          res.doorways++;
          if (best < 250) res.failed.push(op.id + (dir > 0 ? "+" : "-") + " " + Math.round(best));
        });
      });
    });
    /* stairs: north run west, landing, south run east, into the bonus room */
    const st = PET.store.levelById("main").def.stair;
    const first = st.treads[0], land = st.treads.find((t) => t.landing), lastT = st.treads[st.treads.length - 1];
    const ny = (first.y1 + first.y2) / 2, sy = (lastT.y1 + lastT.y2) / 2;
    W.walkTo(first.x2 + 400, ny, 0);
    let p = W.step({ KeyW: true }, 1.0, yawFor(-1, 0));                     // up the north run
    const atLanding = p.feet;
    W.walkTo((land.x1 + land.x2) / 2, ny, atLanding);
    p = W.step({ KeyW: true }, 0.28, yawFor(0, -1));                         // across the landing
    W.walkTo(land.x2 - 150, sy, p.feet);
    p = W.step({ KeyW: true }, 2.2, yawFor(1, 0));                           // up the south run
    const bonusRoom = PET.roomAt(PET.store.levelById("bonus").def, p.x, p.y);
    const climbed = { landing: Math.round(atLanding), top: Math.round(p.feet), room: bonusRoom && bonusRoom.id };
    p = W.step({ KeyS: true }, 3.0, yawFor(1, 0));                           // back down, walking backward
    climbed.backDown = Math.round(p.feet);
    /* chairs: walk straight through the dining chairs — they must not block */
    const chair = PET.store.furniture.find((f) => f.type === "chair" && f.level === "main" && f.y < 15000);
    W.walkTo(chair.x - 700, chair.y, 0);
    p = W.step({ KeyW: true }, 0.5, yawFor(1, 0));
    const chairs = { start: chair.x - 700, end: Math.round(p.x), passed: p.x > chair.x + 300 };
    PET.view3d.orbitMode();
    return { doorways: res.doorways, failed: res.failed, stairs: climbed, chairs };
  });

  out.errors = errors;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error("QA FAILED:", e.message); process.exit(1); });
