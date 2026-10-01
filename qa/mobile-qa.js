/* Phone QA: emulated iPhone with real multi-touch through the DevTools protocol.
   Checks one-finger orbit, pinch zoom, the walk joystick, drag-to-look, and
   2D pan, pinch, and tap. Run from peterson-interior/:  node qa/mobile-qa.js */
const puppeteer = require(process.env.PUPPETEER_PATH || "puppeteer-core");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--no-sandbox","--enable-unsafe-swiftshader","--use-angle=swiftshader"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  await page.goto("file://" + require("path").resolve(__dirname, "..", "index.html"), { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: "load" });
  await sleep(3000);
  await page.screenshot({ path: require("path").join(require("os").tmpdir(), "peterson-m1_load.png") });
  const cdp = await page.target().createCDPSession();
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i })) });
  const out = {};
  const tapEl = async (sel) => {
    const b = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; }, sel);
    if (!b.w) throw new Error("not visible: " + sel);
    await touch("touchStart", [[b.x, b.y, 9]]); await touch("touchEnd", []);
  };
  // one-finger orbit
  const th0 = await page.evaluate(() => PET.view3d.debugOrbit ? 0 : 0);
  const cam = () => page.evaluate(() => { const c = document.querySelector("#three-container canvas"); return PET.view3d.getCam(); });
  const c0 = await cam();
  await touch("touchStart", [[200, 400]]); for (let i = 1; i <= 8; i++) await touch("touchMove", [[200 + i * 12, 400]]); await touch("touchEnd", []);
  const c1 = await cam();
  // pinch out (zoom in)
  await touch("touchStart", [[160, 420, 1], [230, 420, 2]]);
  for (let i = 1; i <= 8; i++) await touch("touchMove", [[160 - i * 8, 420, 1], [230 + i * 8, 420, 2]]);
  await touch("touchEnd", []);
  const c2 = await cam();
  out.orbit = { rotated: Math.abs(c1.theta - c0.theta) > 0.1, zoomedIn: c2.dist < c1.dist * 0.8 };
  // menu + panels
  await tapEl("#btn-menu"); await sleep(400); await page.screenshot({ path: require("path").join(require("os").tmpdir(), "peterson-m2_menu.png") });
  await tapEl("#btn-panels"); await sleep(400); await page.screenshot({ path: require("path").join(require("os").tmpdir(), "peterson-m3_panels.png") });
  await tapEl("#btn-drawer-close"); await sleep(300);
  // walk with joystick
  await tapEl("#btn-mode-walk"); await sleep(700);
  const joyVisible = await page.evaluate(() => !document.getElementById("touch-walk").classList.contains("hidden"));
  const before = await page.evaluate(() => PET.view3d.getCam());
  const jb = await page.evaluate(() => { const r = document.getElementById("joy").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await touch("touchStart", [[jb.x, jb.y, 5]]); await touch("touchMove", [[jb.x, jb.y - 45, 5]]);
  await sleep(900);
  await page.screenshot({ path: require("path").join(require("os").tmpdir(), "peterson-m4_walk.png") });
  // look with second finger while walking
  const yaw0 = (await page.evaluate(() => PET.view3d.getCam())).yaw;
  await touch("touchMove", [[jb.x, jb.y - 45, 5], [300, 400, 6]]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [[jb.x, jb.y - 45, 5], [300 - i * 15, 400, 6]]);
  await touch("touchEnd", []);
  await sleep(200);
  const after = await page.evaluate(() => PET.view3d.getCam());
  out.walk = { joystickShown: joyVisible, moved: Math.hypot(after.x - before.x, after.z - before.z) > 500, turned: Math.abs(after.yaw - yaw0) > 0.1, stickReset: after.stick };
  // 2D pan + pinch
  await tapEl("#btn-mode-orbit"); await tapEl("#btn-2d"); await sleep(500);
  const v0 = await page.evaluate(() => Object.assign({}, PET.view2d.getView()));
  await touch("touchStart", [[200, 500]]); for (let i = 1; i <= 6; i++) await touch("touchMove", [[200 + i * 10, 500 + i * 10]]); await touch("touchEnd", []);
  const v1 = await page.evaluate(() => Object.assign({}, PET.view2d.getView()));
  await touch("touchStart", [[170, 450, 1], [230, 450, 2]]); for (let i = 1; i <= 6; i++) await touch("touchMove", [[170 - i * 10, 450, 1], [230 + i * 10, 450, 2]]); await touch("touchEnd", []);
  const v2 = await page.evaluate(() => Object.assign({}, PET.view2d.getView()));
  await touch("touchStart", [[195, 450]]); await touch("touchEnd", []); await sleep(200);
  out.plan2d = { panned: Math.abs(v1.cx - v0.cx) > 100, zoomed: v2.scale > v1.scale * 1.3, tapSelected: await page.evaluate(() => PET.store.selection && PET.store.selection.kind) };
  await page.screenshot({ path: require("path").join(require("os").tmpdir(), "peterson-m5_2d.png") });
  console.log(JSON.stringify({ out, errors }, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
