import { app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

const APP_NAME = "OpenOverlay";
app.setName(APP_NAME);
const disableHardwareAccel = ["1", "true", "yes"].includes(String(process.env.OPENOVERLAY_DISABLE_GPU || process.env.OPENOVERLAY_SOFTWARE_RENDER).toLowerCase());
if (disableHardwareAccel) app.disableHardwareAcceleration();
const isWayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.HYPRLAND_INSTANCE_SIGNATURE;
app.commandLine.appendSwitch("ozone-platform-hint", isWayland ? "wayland" : "x11");
app.setPath("userData", path.join(os.homedir(), ".config", APP_NAME));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cfgDir = app.getPath("userData");
const cfgFile = path.join(cfgDir, "config.json");
const welcomeFile = path.join(__dirname, "welcome.html");

const legacyDirs = [
  path.join(os.homedir(), ".config", "tangiaoverlay"),
  path.join(os.homedir(), ".config", "TangiaOpenOverlay"),
  path.join(os.homedir(), ".config", "TangiaOverlay")
];

function migrateOnce() {
  if (fs.existsSync(cfgFile)) return;
  for (const d of legacyDirs) {
    try {
      const f = path.join(d, "config.json");
      if (fs.existsSync(f)) {
        fs.mkdirSync(cfgDir, { recursive: true });
        fs.copyFileSync(f, cfgFile);
        break;
      }
    } catch {}
  }
}

function makeDisplayKey(d) {
  const b = d?.bounds || {};
  return `${b.x||0},${b.y||0},${b.width||0},${b.height||0}`;
}

function sortedDisplays() {
  const all = screen.getAllDisplays();
  return all.slice().sort((a,b)=> (a.bounds.x - b.bounds.x) || (a.bounds.y - b.bounds.y));
}

function readConfig() {
  try {
    migrateOnce();
    const raw = fs.readFileSync(cfgFile, "utf-8");
    const j = JSON.parse(raw || "{}");
    const v = typeof j.url === "string" ? j.url.trim() : "";
    const url = /^https?:\/\//i.test(v) ? v : "";
    const displayKey = typeof j.displayKey === "string" ? j.displayKey : undefined;
    const displayId = typeof j.display === "number" ? j.display : (typeof j.displayId === "number" ? j.displayId : undefined);
    const displayIndex = typeof j.displayIndex === "number" ? j.displayIndex : undefined;
    return { url, displayKey, displayId, displayIndex };
  } catch {
    return { url: "", displayKey: undefined, displayId: undefined, displayIndex: undefined };
  }
}

function writeConfigFields(fields) {
  const cur = readConfig();
  const next = { ...cur, ...fields };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2));
}

let overlayWindows = [];
let tray = null;

function applyClickThrough(w) {
  try { w.setIgnoreMouseEvents(true, { forward: true }); } catch {}
}

function restartOverlay(reason, culprit) {
  const cfg = readConfig();
  const display = resolveSelection(cfg);
  if (culprit) {
    try { culprit.destroy(); } catch {}
  }
  overlayWindows = overlayWindows.filter(x => x && !x.isDestroyed() && x !== culprit);
  createOrMoveOverlay(cfg.url, display);
  if (reason) console.log(`[overlay] restarting overlay after renderer issue: ${reason}`);
}

function attachOverlayGuards(w) {
  w.webContents.on("render-process-gone", (_e, details) => {
    const reason = details?.reason || "unknown";
    restartOverlay(reason, w);
  });
  w.webContents.on("unresponsive", () => {
    restartOverlay("unresponsive", w);
  });
  w.on("closed", () => {
    overlayWindows = overlayWindows.filter(x => x && x !== w);
  });
}

function placeWindow(w, b) {
  const prevTop = w.isAlwaysOnTop();
  try { w.setAlwaysOnTop(false); } catch {}
  try { w.setMovable(true); } catch {}
  try { w.setResizable(true); } catch {}
  try { w.setMinimumSize(0,0); } catch {}
  try { w.setBounds(b, false); } catch {}
  try { w.setPosition(b.x, b.y, false); } catch {}
  try { w.setContentBounds(b, false); } catch {}
  setTimeout(() => { try { w.setBounds(b, false); } catch {} }, 120);
  setTimeout(() => { try { w.setBounds(b, false); } catch {} }, 400);
  setTimeout(() => {
    try { w.setMovable(false); } catch {}
    try { w.setResizable(false); } catch {}
    try { w.setAlwaysOnTop(true, "screen-saver"); } catch {}
    if (!prevTop) try { w.setAlwaysOnTop(false); } catch {}
  }, 520);
}

function currentDisplay(win) {
  try {
    const b = win.getBounds();
    return screen.getDisplayNearestPoint({ x: b.x + 1, y: b.y + 1 }) || null;
  } catch { return null; }
}

function saveDisplay(d) {
  if (!d) return;
  const arr = sortedDisplays();
  const idx = Math.max(0, arr.findIndex(x => x.id === d.id));
  writeConfigFields({ displayKey: makeDisplayKey(d), displayId: d.id, displayIndex: idx < 0 ? 0 : idx });
}

function findByKey(key) {
  if (!key) return null;
  const all = screen.getAllDisplays();
  return all.find(d => makeDisplayKey(d) === key) || null;
}

function findById(id) {
  if (typeof id !== "number") return null;
  const all = screen.getAllDisplays();
  return all.find(d => d.id === id) || null;
}

function findByIndex(idx) {
  if (typeof idx !== "number") return null;
  const arr = sortedDisplays();
  if (!arr.length) return null;
  const i = Math.max(0, Math.min(idx, arr.length - 1));
  return arr[i] || null;
}

function resolveSelection(sel) {
  return findByKey(sel.displayKey) || findById(sel.displayId) || findByIndex(sel.displayIndex) || sortedDisplays()[0] || screen.getPrimaryDisplay() || null;
}

function createOrMoveOverlay(targetUrl, targetDisplay) {
  if (!targetDisplay) return;
  if (overlayWindows[0]) {
    const win = overlayWindows[0];
    const cur = currentDisplay(win);
    const curKey = cur ? makeDisplayKey(cur) : undefined;
    const tgtKey = makeDisplayKey(targetDisplay);
    if (curKey !== tgtKey) {
      placeWindow(win, targetDisplay.bounds);
      setTimeout(() => { const md = currentDisplay(win); if (md) saveDisplay(md); }, 600);
    }
    if (targetUrl) { try { win.loadURL(targetUrl); } catch {} } else { try { win.loadFile(welcomeFile); } catch {} }
    return;
  }
  const d = targetDisplay;
  const w = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    type: "toolbar",
    enableLargerThanScreen: true,
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      autoplayPolicy: "no-user-gesture-required",
      webviewTag: false,
      sandbox: false
    }
  });
  attachOverlayGuards(w);
  w.on("page-title-updated", e => e.preventDefault());
  w.setTitle(APP_NAME);
  w.setAlwaysOnTop(true, "screen-saver");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.webContents.setZoomFactor(1.0);
  if (targetUrl) w.loadURL(targetUrl); else w.loadFile(welcomeFile);
  w.once("ready-to-show", () => {
    placeWindow(w, d.bounds);
    applyClickThrough(w);
    try { w.showInactive(); } catch { w.show(); }
    const md = currentDisplay(w);
    if (md) saveDisplay(md);
    setTimeout(() => { const md2 = currentDisplay(w); if (md2) saveDisplay(md2); }, 650);
  });
  setTimeout(() => applyClickThrough(w), 200);
  setTimeout(() => applyClickThrough(w), 600);
  overlayWindows = [w];
}

function reflowOverlays() {
  const cfg = readConfig();
  const chosen = resolveSelection(cfg);
  createOrMoveOverlay(cfg.url, chosen);
  setTimeout(() => {
    const w = overlayWindows[0];
    if (!w) return;
    const md = currentDisplay(w);
    if (md) saveDisplay(md);
  }, 700);
}

function openUrlPrompt() {
  overlayWindows.forEach(w => { try { w.hide(); } catch {} });
  const current = readConfig().url;
  const win = new BrowserWindow({
    width: 640,
    height: 230,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: true,
    skipTaskbar: false,
    modal: false,
    alwaysOnTop: true,
    backgroundColor: "#121820",
    title: "Overlay URL Setup",
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: false
    }
  });
  win.setMenu(null);
  win.on("page-title-updated", e => e.preventDefault());
  win.setTitle("Overlay URL Setup");
  win.on("closed", () => {
    overlayWindows.forEach(w => { try { w.show(); } catch {} });
  });
  win.loadFile(path.join(__dirname, "url_prompt.html"), { query: { current } });
}

function monitorMenuItems() {
  const cfg = readConfig();
  const selected = resolveSelection(cfg);
  const selKey = selected ? makeDisplayKey(selected) : undefined;
  const displays = sortedDisplays();
  return displays.map((d, i) => {
    const label = `Display ${i + 1} — ${d.bounds.width}×${d.bounds.height} @ (${d.bounds.x},${d.bounds.y})`;
    const key = makeDisplayKey(d);
    return {
      label,
      type: "radio",
      checked: key === selKey,
      click: () => {
        writeConfigFields({ displayKey: key, displayId: d.id, displayIndex: i });
        reflowOverlays();
        refreshTrayMenu();
      }
    };
  });
}

function buildTrayMenu() {
  const base = [
    { label: "Set Overlay URL…", click: () => openUrlPrompt() },
    { label: "Reload Overlay", click: () => reflowOverlays() },
    { type: "separator" },
    ...monitorMenuItems(),
    { type: "separator" },
    { label: "Exit", click: () => { app.quit(); } }
  ];
  return Menu.buildFromTemplate(base);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const iconPng = path.join(__dirname, "icon.png");
  const icon = fs.existsSync(iconPng) ? nativeImage.createFromPath(iconPng) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  refreshTrayMenu();
}

ipcMain.handle("get-current-url", () => readConfig().url);
ipcMain.handle("set-url", (e, newUrl) => {
  const url = String(newUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return false;
  writeConfigFields({ url });
  reflowOverlays();
  return true;
});
ipcMain.handle("close-window", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.close();
  return true;
});

app.whenReady().then(() => {
  const cfg = readConfig();
  createTray();
  createOrMoveOverlay(cfg.url, resolveSelection(cfg));
  screen.on("display-added", () => { refreshTrayMenu(); reflowOverlays(); });
  screen.on("display-removed", () => { refreshTrayMenu(); reflowOverlays(); });
  screen.on("display-metrics-changed", () => { refreshTrayMenu(); reflowOverlays(); });
});

app.on("before-quit", () => {
  const w = overlayWindows[0];
  if (!w) return;
  const d = currentDisplay(w);
  if (d) saveDisplay(d);
});

app.on("window-all-closed", e => { e.preventDefault(); });
