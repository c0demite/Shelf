const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { scanAll } = require('./src/scanner');
const { norm } = require('./src/util');
const Icons = require('./src/icons');
const I18N = require('./renderer/i18n');
const t = I18N.t;

const argv = process.argv.slice(1);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || true : null;
};

app.setAppUserModelId('io.github.c0demite.shelf');

// Early builds were called "App Hub" and kept data in %APPDATA%\app-hub – carry it over once
(function migrateOldData() {
  const now = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'app-hub');
  if (fs.existsSync(path.join(now, 'state.json')) || !fs.existsSync(path.join(old, 'state.json'))) return;
  try {
    fs.mkdirSync(now, { recursive: true });
    fs.copyFileSync(path.join(old, 'state.json'), path.join(now, 'state.json'));
    if (fs.existsSync(path.join(old, 'icons'))) fs.cpSync(path.join(old, 'icons'), path.join(now, 'icons'), { recursive: true });
  } catch (e) {
    console.error('migration failed', e);
  }
})();

// Debug runs (--dump / --screenshot) use their own profile so they never clash with a running Shelf
if (flag('--dump') || flag('--screenshot')) {
  const real = path.join(app.getPath('userData'), 'state.json');
  const dbg = path.join(app.getPath('temp'), 'app-hub-debug');
  fs.mkdirSync(dbg, { recursive: true });
  // seeded once from the real data; delete the folder to refresh
  if (!fs.existsSync(path.join(dbg, 'state.json'))) {
    try {
      fs.copyFileSync(real, path.join(dbg, 'state.json'));
    } catch {}
  }
  app.setPath('userData', dbg);
}
const userDir = app.getPath('userData');
const STATE_FILE = path.join(userDir, 'state.json');
let state = { items: [], overrides: {}, covers: {}, headers: {}, lastScan: null, drives: [] };
let win = null;
let scanning = false;
let scanText = null; // [translation key, ...args] – translated in the window

// ---------- state ----------
function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    delete state.icons; // old low-quality icon cache
  } catch {}
  I18N.setLang(state.lang || 'en');
}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
      console.error('save failed', e);
    }
  }, 300);
}

const send = (ch, data) =>
  BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.webContents.send(ch, data));

function view(it) {
  const ov = state.overrides[it.id] || {};
  const c = state.covers[norm(it.name)];
  const cover = it.steamAppId || (typeof c === 'string' && !GENERIC_NAMES.has(norm(it.name)) ? c : null);
  return {
    ...it,
    category: ov.category || it.category,
    autoCategory: it.category,
    fav: !!ov.fav,
    hidden: ov.hidden != null ? ov.hidden : !!it.autoHidden,
    launches: ov.launches || 0,
    lastLaunch: Math.max(ov.lastLaunch || 0, it.lastPlayed || 0) || null,
    coverAppId: cover || null,
    coverHeader: (cover && state.headers[cover]) || null,
  };
}

const payload = () => ({
  items: state.items.map(view),
  lastScan: state.lastScan,
  scanning,
  scanText,
  lang: I18N.getLang(),
});

// ---------- scanning ----------
// Shelf should not list itself (installed copy, or Electron when run from source)
const SELF_DIRS = [path.dirname(process.execPath), __dirname].map((d) => d.toLowerCase() + path.sep);
const isSelf = (it) =>
  [it.installDir, it.exe].some((p) => p && SELF_DIRS.some((d) => (p.toLowerCase() + path.sep).startsWith(d)));

async function doScan() {
  if (scanning) return;
  scanning = true;
  const status = (...msg) => {
    scanText = msg;
    send('scan:status', { scanning, text: msg });
  };
  status('scan.start');
  try {
    const res = await scanAll({ shell, progress: status });
    res.items = res.items.filter((it) => !isSelf(it));
    state.items = res.items;
    state.drives = res.drives;
    state.lastScan = Date.now();
    saveState();
    scanning = false;
    status('scan.done', res.items.length, (res.ms / 1000).toFixed(1));
    send('library:items', payload());
    await extractIcons();
    fetchCovers();
  } catch (e) {
    scanning = false;
    status('scan.error', e.message);
  }
}

// ---------- covers (Steam store art, also for non-Steam games) ----------
// Misses are retried after a week (new releases, better matching)
const GENERIC_NAMES = new Set(['launcher', 'game', 'games', 'client', 'app', 'start', 'play', 'setup', 'main', 'bin', 'gierka', 'gra']);
const needsCover = (key) => {
  if (key.length < 4 || GENERIC_NAMES.has(key)) return false;
  const c = state.covers[key];
  return c == null || (typeof c === 'object' && Date.now() - (c.miss || 0) > 7 * 864e5);
};
let coversRunning = false;
async function fetchCovers() {
  if (coversRunning) return;
  coversRunning = true;
  try {
    const todo = state.items
      .map(view)
      .filter((it) => it.category === 'game' && !it.steamAppId && !it.leftover && needsCover(norm(it.name)));
    let changed = 0;
    for (const it of todo) {
      const key = norm(it.name);
      try {
        const r = await fetch(
          `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(it.name)}&l=english&cc=US`,
          { signal: AbortSignal.timeout(8000) }
        );
        const j = await r.json();
        const hit = (j.items || []).find((x) => {
          const n = norm(x.name);
          if (n === key) return true;
          const [a, b] = n.length < key.length ? [n, key] : [key, n];
          if (a.length < 6) return false;
          return (b.startsWith(a) && a.length / b.length >= 0.75) || (b.endsWith(a) && a.length / b.length >= 0.55);
        });
        state.covers[key] = hit ? String(hit.id) : { miss: Date.now() };
        if (hit) changed++;
      } catch {
        // offline – try again next time
      }
      if (changed && changed % 5 === 0) send('library:items', payload());
      await new Promise((r) => setTimeout(r, 200));
    }

    // Real header image URL (newer games use hashed paths the CDN pattern can't guess)
    const ids = [...new Set(state.items.map(view).filter((i) => i.category === 'game' && i.coverAppId).map((i) => i.coverAppId))];
    for (const id of ids.filter((id) => !(id in state.headers))) {
      try {
        const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`, {
          signal: AbortSignal.timeout(8000),
        });
        const j = await r.json();
        state.headers[id] = j?.[id]?.data?.header_image || null;
        if (state.headers[id]) changed++;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    saveState();
    if (changed) send('library:items', payload());
  } finally {
    coversRunning = false;
  }
}

// ---------- launching ----------
function launch(it) {
  return new Promise((resolve, reject) => {
    if (it.uri) return shell.openExternal(it.uri).then(resolve, reject);
    if (it.aumid) {
      spawn('explorer.exe', ['shell:AppsFolder\\' + it.aumid], { detached: true, stdio: 'ignore' }).unref();
      return resolve();
    }
    if (it.lnk && fs.existsSync(it.lnk)) {
      return shell.openPath(it.lnk).then((err) => (err ? reject(new Error(err)) : resolve()));
    }
    if (it.exe && fs.existsSync(it.exe)) {
      const fallback = () => shell.openPath(it.exe).then((err) => (err ? reject(new Error(err)) : resolve()));
      try {
        const child = spawn(it.exe, [], { cwd: it.cwd || path.dirname(it.exe), detached: true, stdio: 'ignore' });
        child.once('error', fallback); // e.g. needs admin rights
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      } catch {
        fallback();
      }
      return;
    }
    reject(new Error('Brak pliku do uruchomienia'));
  });
}

// ---------- IPC ----------
const find = (id) => state.items.find((i) => i.id === id);

ipcMain.handle('library:get', () => payload());
ipcMain.handle('library:scan', () => {
  doScan();
  return true;
});

ipcMain.handle('item:launch', async (_e, id) => {
  const it = find(id);
  if (!it) return { ok: false, error: 'Nie znaleziono' };
  try {
    await launch(it);
    const ov = (state.overrides[id] = state.overrides[id] || {});
    ov.lastLaunch = Date.now();
    ov.launches = (ov.launches || 0) + 1;
    saveState();
    return { ok: true, item: view(it) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('item:override', (_e, id, patch) => {
  const it = find(id);
  if (!it) return null;
  const ov = (state.overrides[id] = { ...(state.overrides[id] || {}), ...patch });
  if (ov.category === it.category) delete ov.category;
  saveState();
  if (patch.category === 'game') fetchCovers();
  return view(it);
});

ipcMain.handle('item:openFolder', (_e, id) => {
  const it = find(id);
  if (!it) return false;
  if (it.installDir && fs.existsSync(it.installDir)) shell.openPath(it.installDir);
  else if (it.exe && fs.existsSync(it.exe)) shell.showItemInFolder(it.exe);
  else return false;
  return true;
});

ipcMain.handle('item:uninstall', (_e, id) => {
  const it = find(id);
  if (it?.source === 'steam') return shell.openExternal('steam://uninstall/' + it.steamAppId).then(() => true);
  // Let Windows handle uninstalling (it shows its own confirmation)
  return shell.openExternal('ms-settings:appsfeatures').then(() => true);
});

// ---------- icons ----------
const ICON_DIR = path.join(userDir, 'icons');
const triedIcons = new Set();
let iconsRunning = null;
async function extractIcons() {
  if (iconsRunning) return iconsRunning;
  const todo = [...new Set(state.items.map(Icons.iconSource).filter(Boolean))].filter(
    (s) => !triedIcons.has(s) && !Icons.hasIcon(ICON_DIR, s)
  );
  if (!todo.length) return;
  iconsRunning = Icons.extractMany(todo, ICON_DIR).then(() => {
    todo.forEach((s) => triedIcons.add(s));
    iconsRunning = null;
    send('icons:ready');
  });
  return iconsRunning;
}

const fallbackIcons = new Map();
ipcMain.handle('icon:get', async (_e, id) => {
  const it = find(id);
  const src = it && Icons.iconSource(it);
  if (!src) return null;
  const url = Icons.readIcon(ICON_DIR, src);
  if (url) return url;
  // Shell could not give an icon – last resort: Electron's own lookup
  const p = it.exe || it.iconPath;
  if (!triedIcons.has(src) || !p) return null;
  if (!fallbackIcons.has(p))
    fallbackIcons.set(p, app.getFileIcon(p, { size: 'large' }).then((img) => (img.isEmpty() ? null : img.toDataURL())).catch(() => null));
  return fallbackIcons.get(p);
});

// ---------- windows ----------
const ICON = path.join(__dirname, 'assets', 'icon.png');
const SHOT = flag('--screenshot');
const webPrefs = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: !SHOT, // debug screenshots run in a hidden window
};
let quitting = false;
let tray = null;
let quick = null;
let hotkey = null;

function lockDown(w) {
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#141210',
    title: 'Shelf',
    icon: ICON,
    show: show && !SHOT,
    webPreferences: webPrefs,
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  lockDown(win);
  // Closing hides to the tray, so the shortcut keeps working
  win.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  if (SHOT && !flag('--quick')) debugCapture(win);
}

function showMain() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Spotlight-style quick launcher
const QUICK_W = 720; // includes room for the panel shadow
function createQuick() {
  quick = new BrowserWindow({
    width: QUICK_W,
    height: 72,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    icon: ICON,
    webPreferences: webPrefs,
  });
  quick.setAlwaysOnTop(true, 'pop-up-menu');
  quick.loadFile(path.join(__dirname, 'renderer', 'quick.html'));
  lockDown(quick);
  quick.on('blur', () => !SHOT && hideQuick());
  quick.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideQuick();
    }
  });
  if (SHOT && flag('--quick')) debugCapture(quick, () => showQuick());
}

function showQuick() {
  if (!quick || quick.isDestroyed()) createQuick();
  // Open on the screen where the mouse is, a bit above the middle
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  quick.setPosition(Math.round(d.x + (d.width - QUICK_W) / 2), Math.round(d.y + d.height * 0.22));
  quick.webContents.send('quick:open');
  quick.show();
  quick.focus();
}
function hideQuick() {
  if (quick && !quick.isDestroyed() && quick.isVisible()) quick.hide();
}
function toggleQuick() {
  if (quick && !quick.isDestroyed() && quick.isVisible() && quick.isFocused()) hideQuick();
  else showQuick();
}

ipcMain.handle('quick:resize', (_e, h) => {
  if (!quick || quick.isDestroyed()) return;
  const [x, y] = quick.getPosition();
  quick.setBounds({ x, y, width: QUICK_W, height: Math.max(100, Math.min(620, Math.round(h))) });
});
ipcMain.handle('quick:hide', () => hideQuick());
ipcMain.handle('quick:openMain', () => {
  hideQuick();
  showMain();
});
ipcMain.handle('app:hotkey', () => hotkey);

// ---------- start with Windows ----------
// Starts hidden in the tray, so the shortcut is ready right after login.
// Running from source, Windows has to start electron.exe with this folder as an argument.
const loginArgs = () => (app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']);
const LOGIN_NAME = 'Shelf';
const getAutostart = () => app.getLoginItemSettings({ path: process.execPath, args: loginArgs(), name: LOGIN_NAME }).openAtLogin;
// The app used to be called App Hub – drop that old Run entry
function dropOldLoginItem() {
  // Electron leaves the old value behind, so remove it directly
  spawn('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'App Hub', '/f'], { windowsHide: true }).on('error', () => {});
}
function setAutostart(on) {
  state.autostart = !!on;
  saveState();
  app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: loginArgs(), name: LOGIN_NAME });
  refreshTrayMenu();
  return getAutostart();
}
ipcMain.handle('autostart:get', () => getAutostart());
ipcMain.handle('autostart:set', (_e, on) => setAutostart(on));

function setLang(l) {
  state.lang = I18N.setLang(l);
  saveState();
  refreshTrayMenu();
  send('lang:changed', state.lang);
  return state.lang;
}
ipcMain.handle('lang:get', () => I18N.getLang());
ipcMain.handle('lang:set', (_e, l) => setLang(l));

// Ctrl+Space can be taken by the keyboard-language switcher – fall back if so
const HOTKEYS = ['Control+Space', 'Control+Alt+Space', 'Alt+Shift+Space'];
function registerHotkey() {
  for (const k of HOTKEYS) {
    try {
      if (globalShortcut.register(k, toggleQuick)) {
        hotkey = k.replace('Control', 'Ctrl');
        console.log('hotkey:', k);
        return;
      }
    } catch {}
  }
  hotkey = null;
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  const menu = () =>
    Menu.buildFromTemplate([
      { label: t('tray.open'), click: showMain },
      { label: t('tray.quick') + (hotkey ? `\t${I18N.keyLabel(hotkey)}` : ''), click: showQuick },
      { label: t('tray.rescan'), click: () => doScan() },
      { type: 'separator' },
      { label: t('tray.auto'), type: 'checkbox', checked: getAutostart(), click: (m) => setAutostart(m.checked) },
      {
        label: t('tray.lang'),
        submenu: I18N.LANGS.map(([code, name]) => ({ label: name, type: 'radio', checked: I18N.getLang() === code, click: () => setLang(code) })),
      },
      { type: 'separator' },
      { label: t('tray.quit'), click: () => { quitting = true; app.quit(); } },
    ]);
  trayMenu = menu;
  refreshTrayMenu();
  tray.on('click', showMain);
}
let trayMenu = null;
function refreshTrayMenu() {
  if (tray && trayMenu) {
    tray.setContextMenu(trayMenu());
    tray.setToolTip(t('tray.tip', hotkey && I18N.keyLabel(hotkey)));
  }
  send('autostart:changed', getAutostart());
}

// debug: electron . --screenshot out.png [--wait ms] [--click "sel,sel"] [--quick] [--query text]
function debugCapture(w, before) {
  w.webContents.on('console-message', (e) => console.log('[renderer]', e.message || e));
  w.webContents.once('did-finish-load', () => {
    if (before) before();
    setTimeout(async () => {
      if (flag('--click')) {
        for (const sel of String(flag('--click')).split(',')) {
          await w.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click()`);
        }
      }
      if (flag('--query')) {
        await w.webContents.executeJavaScript(
          `(() => { const i = document.querySelector('input'); i.value = ${JSON.stringify(String(flag('--query')))}; i.dispatchEvent(new Event('input')); })()`
        );
      }
      await new Promise((r) => setTimeout(r, +flag('--settle') || 800));
      const img = await w.webContents.capturePage();
      fs.writeFileSync(SHOT, img.toPNG());
      quitting = true;
      app.quit();
    }, +flag('--wait') || 2500);
  });
}

// Only one Shelf at a time – starting it again just brings it up
const dumpMode = !!flag('--dump');
if (!dumpMode && !SHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);

  app.whenReady().then(async () => {
    loadState();
    if (flag('--lang')) I18N.setLang(flag('--lang')); // debug screenshots
    if (dumpMode) {
      // Headless scan for debugging: electron . --dump out.json [--covers]
      const res = await scanAll({ shell, progress: (t) => console.log(t) });
      state.items = res.items;
      state.lastScan = Date.now();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
      fs.writeFileSync(flag('--dump'), JSON.stringify(res, null, 1));
      console.log('items:', res.items.length, 'ms:', res.ms);
      if (flag('--covers')) await fetchCovers();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
      app.quit();
      return;
    }
    if (SHOT) {
      await extractIcons();
      if (flag('--quick')) createQuick();
      else createWindow();
      return;
    }
    registerHotkey();
    // Self-heal: if the folder moved, point the Windows entry at the new location
    dropOldLoginItem(); // no-op once it is gone
    if (flag('--enable-autostart') || (state.autostart && !getAutostart())) setAutostart(true);
    createTray();
    createWindow({ show: !process.argv.includes('--hidden') });
    createQuick();
    extractIcons(); // icons for the cached list while the fresh scan runs
    doScan();
  });

  app.on('before-quit', () => (quitting = true));
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
}
