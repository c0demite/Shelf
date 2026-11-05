const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, globalShortcut, nativeTheme, dialog, protocol, net, clipboard, screen } = require('electron');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const fs = require('fs');
const { spawn } = require('child_process');
const { scanAll } = require('./src/scanner');
const Icons = require('./src/icons');
const { createProcessRules, runningExes, focusWindow } = require('./src/processes');
const { createPlaytime } = require('./src/playtime');
const { createInspector } = require('./src/inspect');
const { updateCovers, storeSearch } = require('./src/covers');
const { createLibrary } = require('./src/library');
const { removeLeftovers } = require('./src/leftovers');
const { createUpdates } = require('./src/updates');
const { createQuickWindow } = require('./src/quick-window');
const { launch } = require('./src/launch');
const { diagnosticsReport } = require('./src/diagnostics');
const { createHotkey } = require('./src/hotkey');
const I18N = require('./renderer/i18n');
const t = I18N.t;

const argv = process.argv.slice(1);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || true : null;
};

app.setAppUserModelId('io.github.c0demite.shelf');
protocol.registerSchemesAsPrivileged([{ scheme: 'shelf', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

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
const COVER_DIR = path.join(userDir, 'covers');
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
  library.replaceScan(state.items);
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

// what the scan found + what the user changed; playtime is defined below and only asked later
const library = createLibrary({ state: () => state, isPlaying: (id) => playtime.isPlaying(id) });
const { find } = library;
const payload = () => ({
  items: library.views(),
  lastScan: state.lastScan,
  scanning,
  scanText,
  lang: I18N.getLang(),
  theme: state.theme || 'dark',
  shelves: state.shelves || [],
});
const pushItems = () => send('library:items', payload());
// ---------- running processes and playtime ----------
const readShortcut = (lnk) => {
  try {
    return shell.readShortcutLink(lnk).target || null;
  } catch {
    return null;
  }
};
// Shelf should not list or watch itself (installed copy, or Electron when run from source)
const rules = createProcessRules({
  sysRoot: process.env.SystemRoot || 'C:\\Windows',
  selfDirs: [path.dirname(process.execPath), __dirname],
  readShortcut,
});
const playtime = createPlaytime(rules);
const PLAY_TICK = 60e3;
// Once a minute. Apps started outside Shelf (Start menu, taskbar) get no playtime, only "last launched".
async function trackPlaytime() {
  const procs = await runningExes();
  if (!procs) return;
  const { played, started, changed } = playtime.tick(library.views(), procs);
  library.played(played);
  library.opened(started);
  if (played.length || started.length) saveState();
  if (changed || played.length || started.length) pushItems();
}

// ---------- scanning ----------
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
    res.items = res.items.filter((it) => !rules.isSelf(it));
    library.replaceScan(res.items);
    state.drives = res.drives;
    state.lastScan = Date.now();
    saveState();
    scanning = false;
    status('scan.done', res.items.length, (res.ms / 1000).toFixed(1));
    pushItems();
    await extractIcons();
    fetchCovers();
  } catch (e) {
    scanning = false;
    status('scan.error', e.message);
  }
}

// ---------- covers (Steam store art, also for non-Steam games) ----------
let coversRunning = false;
async function fetchCovers() {
  if (coversRunning) return;
  coversRunning = true;
  try {
    const changed = await updateCovers({
      games: () => library.views().filter((i) => i.category === 'game'),
      covers: state.covers,
      headers: state.headers,
      onChange: pushItems,
    });
    saveState();
    if (changed) pushItems();
  } finally {
    coversRunning = false;
  }
}

// ---------- launching ----------
ipcMain.handle('library:get', () => payload());
ipcMain.handle('library:scan', () => {
  doScan();
  return true;
});

// Starting an app that is already open often does nothing visible (its window stays
// behind others or minimized). If one of its processes has a window, show that instead.
const focusRunning = (it) => focusWindow(rules.runningMatch(it), userDir);

ipcMain.handle('item:launch', async (_e, id) => {
  const it = find(id);
  if (!it) return { ok: false, error: 'Nie znaleziono' };
  try {
    const focused = await focusRunning(it);
    if (!focused) await launch(it);
    library.launched(id);
    saveState();
    pushItems(); // keep every window's "Recent" in sync
    return { ok: true, item: library.view(it), focused };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// A whole shelf, one by one. Apps that already have a window are skipped.
async function launchShelf(sid) {
  const list = library.views().filter((i) => (i.shelves || []).includes(sid) && !i.leftover && i.canLaunch);
  const res = { total: list.length, launched: 0, running: 0, failed: 0 };
  if (!list.length) return res;
  const procs = await runningExes();
  for (const it of list) {
    if (procs && rules.isOpen(it, procs.windowed)) {
      res.running++;
      continue;
    }
    try {
      if (res.launched) await new Promise((r) => setTimeout(r, 500)); // don't start everything in the same instant
      await launch(find(it.id));
      library.launched(it.id);
      res.launched++;
    } catch {
      res.failed++;
    }
  }
  saveState();
  pushItems();
  return res;
}
ipcMain.handle('shelf:launch', (_e, sid) => launchShelf(String(sid)));

ipcMain.handle('item:override', (_e, id, patch) => {
  const v = library.override(id, patch);
  if (!v) return null;
  saveState();
  if (patch.category === 'game') fetchCovers();
  return v;
});

// Custom shelves (collections): the window sends the whole list, [{ id, name }]
ipcMain.handle('shelves:save', (_e, list) => {
  const shelves = library.saveShelves(list);
  saveState();
  pushItems();
  return shelves;
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

// ---------- added by hand ----------
const inspectFile = createInspector({ readShortcut });
async function addManual({ path: file, name, category }) {
  const info = await inspectFile(file);
  if (!info) return { error: 'file' };
  const ext = path.extname(file).toLowerCase();
  const exe = ext === '.exe' || ext === '.bat' || ext === '.cmd' ? file : null;
  const res = library.addManual({
    id: 'manual:' + crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 12),
    name: String(name || info.name).trim().slice(0, 80) || info.name,
    category: category === 'game' ? 'game' : 'app',
    source: 'manual',
    manual: true,
    exe: exe || undefined,
    lnk: ext === '.lnk' ? file : undefined,
    uri: info.uri || undefined,
    iconPath: info.iconPath || undefined,
    installDir: info.dir || undefined,
    installDate: Date.now(),
    canLaunch: true,
  });
  saveState();
  pushItems();
  if (res.exists) return res; // already on the shelf – now visible again
  extractIcons();
  if (res.item.category === 'game') fetchCovers();
  return res;
}

const ADD_FILTERS = () => [{ name: t('add.filter'), extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }];
ipcMain.handle('add:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: t('add.title'), properties: ['openFile'], filters: ADD_FILTERS() });
  return r.canceled || !r.filePaths[0] ? null : inspectFile(r.filePaths[0]);
});
ipcMain.handle('add:inspect', (_e, file) => inspectFile(file));
ipcMain.handle('add:save', (_e, data) => (data && typeof data === 'object' ? addManual(data) : { error: 'file' }));
ipcMain.handle('item:remove', (_e, id) => {
  const { removed, unusedFile } = library.removeManual(id);
  if (!removed) return false;
  dropCoverFile(unusedFile);
  saveState();
  pushItems();
  return true;
});

// ---------- custom covers ----------
// Pick any Steam store entry, or a picture from disk (copied into %APPDATA%\Shelf\covers)
ipcMain.handle('cover:search', async (_e, q) => {
  q = String(q || '').trim().slice(0, 80);
  if (!q) return [];
  try {
    return (await storeSearch(q)).slice(0, 12).map((x) => ({ id: String(x.id), name: x.name }));
  } catch {
    return null; // offline
  }
});
const dropCoverFile = (f) => f && fs.rm(path.join(COVER_DIR, path.basename(f)), () => {});
function setCover(id, patch) {
  const res = library.setCover(id, patch);
  if (!res) return null;
  dropCoverFile(res.unusedFile);
  saveState();
  if (patch.coverAppId) fetchCovers(); // header art for the "Recent" card
  pushItems();
  return res.view;
}
ipcMain.handle('cover:set', async (_e, id, choice) => {
  if (!find(id)) return null;
  if (choice === 'reset') return setCover(id, {});
  if (choice === 'file') {
    const r = await dialog.showOpenDialog(win, {
      title: t('cover.file'),
      properties: ['openFile'],
      filters: [{ name: t('cover.images'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    });
    const src = !r.canceled && r.filePaths[0];
    if (!src) return null;
    if (fs.statSync(src).size > 20 * 1024 ** 2) return { error: 'big' };
    fs.mkdirSync(COVER_DIR, { recursive: true });
    const name = crypto.createHash('sha1').update(id).digest('hex').slice(0, 12) + '-' + Date.now().toString(36) + path.extname(src).toLowerCase();
    fs.copyFileSync(src, path.join(COVER_DIR, name));
    return setCover(id, { coverFile: name });
  }
  if (/^\d{1,10}$/.test(String(choice))) return setCover(id, { coverAppId: String(choice) });
  return null;
});

// ---------- leftovers clean-up ----------
const BACKUP_DIR = path.join(userDir, 'backups');
ipcMain.handle('leftover:remove', async (_e, ids) => {
  const list = (Array.isArray(ids) ? ids.map(String) : []).map(find).filter((it) => it && it.leftover);
  const res = await removeLeftovers(list, { backupRoot: BACKUP_DIR, trash: (d) => shell.trashItem(d) });
  library.remove(res.removed);
  saveState();
  pushItems();
  res.tooBig.forEach((d) => shell.openPath(d)); // too big for the Recycle Bin – left to the user
  return { removed: res.removed.size, total: list.length, tooBig: res.tooBig.length, backup: res.backup };
});
ipcMain.handle('app:openPath', (_e, p) => {
  // only our own backup folders
  if (typeof p === 'string' && path.resolve(p).startsWith(BACKUP_DIR)) shell.openPath(p);
});

// ---------- updates ----------
const updates = createUpdates({
  app,
  onStatus: (s) => {
    send('update:status', s);
    if (s.status === 'ready') refreshTrayMenu();
  },
});
function installUpdate() {
  if (!updates.readyVersion()) return;
  quitting = true; // let the windows close instead of hiding to the tray
  updates.install();
}
ipcMain.handle('update:get', () => updates.status());
ipcMain.handle('update:check', () => updates.check());
ipcMain.handle('update:install', () => installUpdate());

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
    backgroundColor: bgColor(),
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
const plainForced = () => !!(flag('--plain-quick') || state.plainQuick); // the user asked for the plain window
const quick = createQuickWindow({
  icon: ICON,
  webPreferences: webPrefs,
  debug: !!SHOT,
  plainForced,
  isDark: () => isDark(),
  isQuitting: () => quitting,
  onCreate: (w) => {
    lockDown(w);
    if (SHOT && flag('--quick')) debugCapture(w, () => quick.show());
  },
});
const plainInfo = () => ({ on: plainForced(), gpu: quick.gpuOn() });
app.on('gpu-info-update', () => {
  quick.gpuReady();
  send('quick:plain', plainInfo()); // the settings show the real GPU state once it is known
});
// Settings switch: some PCs draw the dark box even with a working GPU
ipcMain.handle('quick:plain:get', () => plainInfo());
ipcMain.handle('quick:plain:set', (_e, on) => {
  state.plainQuick = !!on;
  saveState();
  quick.settingChanged();
  return plainInfo();
});
ipcMain.handle('quick:resize', (_e, h) => quick.resize(h));
ipcMain.handle('quick:hide', () => quick.hide());
ipcMain.handle('quick:openMain', () => {
  quick.hide();
  showMain();
});
ipcMain.handle('app:hotkey', () => hotkey.info());

// ---------- bug reports ----------
// Settings: copy info about this PC (no names or paths), or copy it and open the GitHub form
const ISSUE_URL = 'https://github.com/c0demite/Shelf/issues/new?template=bug_report.yml';
function copyDiagnostics() {
  const text = diagnosticsReport({
    version: app.getVersion(),
    packaged: app.isPackaged,
    os: { release: os.release(), arch: process.arch },
    lang: I18N.getLang(),
    theme: state.theme || 'dark',
    gpu: quick.gpuOn(),
    plainSetting: !!state.plainQuick,
    // real pixels, as people know their screens
    displays: screen.getAllDisplays().map((d) => ({ width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor), scaleFactor: d.scaleFactor })),
    items: library.views(),
    lastScan: state.lastScan,
  });
  clipboard.writeText(text);
  return text;
}
ipcMain.handle('diag:copy', () => copyDiagnostics());
ipcMain.handle('diag:report', () => {
  copyDiagnostics();
  return shell.openExternal(ISSUE_URL).then(() => true, () => false);
});

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

// window background behind the page, so there is no dark flash in light mode
const isDark = () => {
  const t = state.theme || 'dark';
  return t === 'system' ? nativeTheme.shouldUseDarkColors : t === 'dark';
};
const bgColor = () => (isDark() ? '#141210' : '#f4f1ea');
function setTheme(t) {
  state.theme = ['dark', 'light', 'system'].includes(t) ? t : 'dark';
  saveState();
  if (win && !win.isDestroyed()) win.setBackgroundColor(bgColor());
  send('theme:changed', state.theme);
  return state.theme;
}
ipcMain.handle('theme:set', (_e, t) => setTheme(t));
ipcMain.handle('lang:set', (_e, l) => setLang(l));

// The quick search shortcut: the user's own, or the first free default
// (Ctrl+Space can be taken by the keyboard-language switcher)
const hotkey = createHotkey({
  register: (k, fn) => globalShortcut.register(k, fn),
  unregister: (k) => globalShortcut.unregister(k),
  defaults: ['Control+Space', 'Control+Alt+Space', 'Alt+Shift+Space'],
  onPress: () => quick.toggle(),
});
const hotkeyLabel = () => {
  const k = hotkey.info().current;
  return k && I18N.keyLabel(k);
};
function hotkeyChanged() {
  refreshTrayMenu();
  send('hotkey:changed', hotkey.info());
}
// Settings: while a new shortcut is being recorded the old one is off.
// If the settings never finish, it comes back by itself after 20 s and the settings are told.
let recordTimer = null;
function stopRecording() {
  clearTimeout(recordTimer);
  recordTimer = null;
  hotkey.resume();
}
ipcMain.handle('hotkey:record', (_e, on) => {
  if (!on) return stopRecording();
  clearTimeout(recordTimer);
  hotkey.pause();
  recordTimer = setTimeout(() => {
    stopRecording();
    send('hotkey:recordEnd');
  }, 20e3);
});
// own: an accelerator ("Control+Alt+K"), or null for the default. { ok, current, chosen, taken }
// A taken shortcut leaves recording on, so the user can press another one.
ipcMain.handle('hotkey:set', (_e, own) => {
  if (own != null && !(typeof own === 'string' && /^[\w+]{1,40}$/.test(own))) return { ok: false, ...hotkey.info() };
  const ok = hotkey.choose(own || null);
  if (!ok) return { ok, ...hotkey.info() };
  if (recordTimer) stopRecording();
  state.hotkey = own || null;
  saveState();
  hotkeyChanged();
  return { ok, ...hotkey.info() };
});

function trayMenu() {
  const ready = updates.readyVersion();
  return Menu.buildFromTemplate([
    ...(ready ? [{ label: t('tray.update', ready), click: installUpdate }, { type: 'separator' }] : []),
    { label: t('tray.open'), click: showMain },
    { label: t('tray.quick') + (hotkeyLabel() ? `\t${hotkeyLabel()}` : ''), click: quick.show },
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
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  refreshTrayMenu();
  tray.on('click', showMain);
}
function refreshTrayMenu() {
  if (tray) {
    tray.setContextMenu(trayMenu());
    tray.setToolTip(t('tray.tip', hotkeyLabel()));
  }
  send('autostart:changed', getAutostart());
}

// debug: electron . --screenshot out.png [--wait ms] [--click "sel,sel"] [--quick] [--query text]
function debugCapture(w, before) {
  w.webContents.on('console-message', (e) => console.log('[renderer]', e.message || e));
  w.webContents.once('did-finish-load', () => {
    if (before) before();
    // transparent quick window has no backdrop in a capture – give it one
    if (flag('--quick')) w.webContents.insertCSS('html { background: #0d0b0a !important; }');
    setTimeout(async () => {
      if (flag('--click')) {
        for (const sel of String(flag('--click')).split(',')) {
          await w.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)})?.click()`);
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (flag('--js')) await w.webContents.executeJavaScript(String(flag('--js'))).catch((e) => console.log('js error', e));
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
    protocol.handle('shelf', (req) => {
      const u = new URL(req.url);
      const f = u.hostname === 'cover' && path.join(COVER_DIR, path.basename(decodeURIComponent(u.pathname)));
      return f && fs.existsSync(f) ? net.fetch(pathToFileURL(f).toString()) : new Response('', { status: 404 });
    });
    loadState();
    if (flag('--lang')) I18N.setLang(flag('--lang')); // debug screenshots
    if (flag('--theme')) state.theme = flag('--theme');
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
      if (flag('--quick')) quick.create();
      else createWindow();
      return;
    }
    hotkey.start(state.hotkey);
    // Self-heal: if the folder moved, point the Windows entry at the new location
    dropOldLoginItem(); // no-op once it is gone
    if (flag('--enable-autostart') || (state.autostart && !getAutostart())) setAutostart(true);
    createTray();
    createWindow({ show: !process.argv.includes('--hidden') });
    quick.create();
    extractIcons(); // icons for the cached list while the fresh scan runs
    doScan();
    updates.start();
    setTimeout(trackPlaytime, 15e3);
    setInterval(trackPlaytime, PLAY_TICK);
  });

  app.on('before-quit', () => (quitting = true));
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
}
