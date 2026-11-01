const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, globalShortcut, screen, nativeTheme, dialog, protocol, net } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
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
  state.items = withManual(state.items);
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
  const auto = it.steamAppId || (typeof c === 'string' && !GENERIC_NAMES.has(norm(it.name)) ? c : null);
  const cover = ov.coverFile ? null : ov.coverAppId || auto;
  return {
    ...it,
    category: ov.category || it.category,
    autoCategory: it.category,
    fav: !!ov.fav,
    hidden: ov.hidden != null ? ov.hidden : !!it.autoHidden,
    launches: ov.launches || 0,
    // Steam counts its own games; everything else is timed by Shelf
    playtime: it.source === 'steam' ? it.playtime || null : ov.played || it.playtime || null,
    playing: playing.has(it.id),
    shelves: (ov.shelves || []).filter((s) => (state.shelves || []).some((x) => x.id === s)),
    lastLaunch: Math.max(ov.lastLaunch || 0, it.lastPlayed || 0) || null,
    coverAppId: cover || null,
    coverHeader: (cover && state.headers[cover]) || null,
    coverFile: ov.coverFile ? 'shelf://cover/' + encodeURIComponent(ov.coverFile) : null,
    customCover: !!(ov.coverFile || ov.coverAppId),
  };
}

const payload = () => ({
  items: state.items.map(view),
  lastScan: state.lastScan,
  scanning,
  scanText,
  lang: I18N.getLang(),
  theme: state.theme || 'dark',
  shelves: state.shelves || [],
});

// ---------- playtime ----------
// Once a minute: which games have a running process inside their install folder?
// Works no matter how the game was started (Shelf, launcher, desktop shortcut).
let playing = new Set();
const PLAY_TICK = 60e3;
// The folder whose processes belong to an item – or null when it's too broad to tell:
// a whole drive, C:\Windows, a shared container like "D:\Games", or Shelf itself.
// Games often sit right under a drive ("F:\Satisfactory"), so one level is fine unless it's a container.
const CONTAINERS = new Set(['games', 'game', 'gry', 'program files', 'program files (x86)', 'programdata', 'steam', 'steamlibrary', 'xboxgames', 'epic games', 'gog games', 'gog galaxy', 'riot games', 'ubisoft', 'ea games', 'users', 'windows', 'apps', 'programs', 'programy', 'tools', 'portable', 'downloads', 'pobrane', 'desktop']);
const SYS_ROOT = path.normalize(process.env.SystemRoot || 'C:\\Windows').toLowerCase();
function watchDir(it) {
  const dirs = [it.installDir, it.exe && path.dirname(it.exe)];
  if (!it.installDir && !it.exe && it.lnk) {
    try {
      const target = shell.readShortcutLink(it.lnk).target;
      if (target) dirs.push(path.dirname(target));
    } catch {}
  }
  for (const dir of dirs) {
    if (!dir) continue;
    const d = path.normalize(dir).toLowerCase().replace(/[\\/]+$/, '');
    if (d === SYS_ROOT || d.startsWith(SYS_ROOT + path.sep)) return null; // system tools share one folder
    if (SELF_DIRS.some((s) => (d + path.sep).startsWith(s))) return null;
    const parts = d.split(path.sep).filter(Boolean);
    if (parts.length >= 3 || (parts.length === 2 && !CONTAINERS.has(parts[1]))) return d + path.sep;
  }
  return null;
}
function gameDirs() {
  return state.items
    .map(view)
    .filter((i) => i.category === 'game' && !i.leftover && !i.hidden)
    .map((i) => ({ id: i.id, dir: watchDir(i) }))
    .filter((g) => g.dir);
}
function runningExes() {
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      // "1|path" for processes with a visible main window, "0|path" for the rest
      ['-NoProfile', '-NonInteractive', '-Command', "Get-Process | Where-Object Path | ForEach-Object { [int]($_.MainWindowHandle -ne 0), $_.Path -join '|' }"],
      { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 },
      (err, out) => {
        if (err) return resolve(null);
        const lines = out.split(/\r?\n/).filter((s) => s[1] === '|');
        resolve({ all: lines.map((s) => s.slice(2).toLowerCase()), windowed: lines.filter((s) => s[0] === '1').map((s) => s.slice(2).toLowerCase()) });
      }
    )
  );
}
// Apps started outside Shelf (Start menu, taskbar): no playtime, only "last launched"
// when a window from the app's folder shows up that wasn't there on the last tick.
// Windowless helpers (updaters, git.exe calls, tray daemons) are ignored.
let appsKnown = null; // app ids checked on the last tick (null = no tick yet)
let appsRunning = new Set();
function appMatchers() {
  const out = [];
  for (const i of state.items.map(view)) {
    if (i.leftover || i.hidden || isSelf(i)) continue;
    const d = watchDir(i);
    if (d) out.push({ id: i.id, app: i.category === 'app', dir: d });
    else if (i.exe && i.category === 'app' && !path.normalize(i.exe).toLowerCase().startsWith(SYS_ROOT + path.sep))
      out.push({ id: i.id, app: true, exe: path.normalize(i.exe).toLowerCase() });
  }
  return out;
}
function runningApps(exes) {
  const ms = appMatchers();
  const now = new Set();
  for (const e of exes) {
    // most specific match wins, so a game inside the Steam folder doesn't count as Steam
    let best = null;
    for (const m of ms) {
      if (m.exe ? e === m.exe : e.startsWith(m.dir)) {
        const len = m.exe ? Infinity : m.dir.length;
        if (!best || len > best.len) best = { m, len };
      }
    }
    if (best && best.m.app) now.add(best.m.id);
  }
  return { now, known: new Set(ms.filter((m) => m.app).map((m) => m.id)) };
}

async function trackPlaytime() {
  const games = gameDirs();
  const exes = await runningExes();
  if (!exes) return;
  const now = new Set(games.filter((g) => exes.all.some((e) => e.startsWith(g.dir))).map((g) => g.id));
  for (const id of now) {
    const ov = (state.overrides[id] ||= {});
    ov.played = (ov.played || 0) + 1;
    ov.lastLaunch = Date.now();
  }
  const changed = now.size !== playing.size || [...now].some((id) => !playing.has(id));
  playing = now;

  // apps: first tick is only a baseline; later, newly started ones get a timestamp
  const apps = runningApps(exes.windowed);
  let started = 0;
  if (appsKnown) {
    for (const id of apps.now) {
      if (appsKnown.has(id) && !appsRunning.has(id)) {
        (state.overrides[id] ||= {}).lastLaunch = Date.now();
        started++;
      }
    }
  }
  appsKnown = apps.known;
  appsRunning = apps.now;

  if (now.size || started) saveState();
  if (changed || now.size || started) send('library:items', payload());
}

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
    state.items = withManual(res.items);
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

// ---------- already running? bring it to the front ----------
// Starting an app that is already open often does nothing visible (its window stays
// behind others or minimized). If one of its processes has a window, show that instead.
function runningMatch(it) {
  const dir = watchDir(it);
  if (dir) return { prefix: dir };
  // folder too broad (e.g. "D:\Tools") – then only the exact exe counts
  const exe = it.exe && path.normalize(it.exe).toLowerCase();
  return exe && !exe.startsWith(SYS_ROOT + path.sep) ? { exact: exe } : null;
}
function focusRunning(it) {
  const m = runningMatch(it);
  if (!m) return Promise.resolve(false);
  const test = m.prefix ? `$_.Path.ToLower().StartsWith(${psQuote(m.prefix)})` : `$_.Path.ToLower() -eq ${psQuote(m.exact)}`;
  const script = `$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -and (${test}) } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { 'none'; exit }
$dll = ${psQuote(path.join(userDir, 'shelfwin-1.dll'))}
if (-not (Test-Path -LiteralPath $dll)) { Add-Type -OutputAssembly $dll -OutputType Library -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ShelfWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
}
'@ }
Add-Type -LiteralPath $dll
$h = $p.MainWindowHandle
if ([ShelfWin]::IsIconic($h)) { [void][ShelfWin]::ShowWindow($h, 9) }
[ShelfWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [ShelfWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][ShelfWin]::SetForegroundWindow($h)
'ok'`;
  return new Promise((resolve) =>
    execFile('powershell.exe', psEncoded(script), { windowsHide: true, timeout: 8000 }, (err, out) => resolve(!err && /ok/.test(String(out))))
  );
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
    const focused = await focusRunning(it);
    if (!focused) await launch(it);
    const ov = (state.overrides[id] = state.overrides[id] || {});
    ov.lastLaunch = Date.now();
    ov.launches = (ov.launches || 0) + 1;
    saveState();
    send('library:items', payload()); // keep every window's "Recent" in sync
    return { ok: true, item: view(it), focused };
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

// Custom shelves (collections): the window sends the whole list, [{ id, name }]
ipcMain.handle('shelves:save', (_e, list) => {
  state.shelves = (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string')
    .map((s) => ({ id: s.id.slice(0, 40), name: s.name.trim().slice(0, 60) }))
    .filter((s) => s.name);
  saveState();
  send('library:items', payload());
  return state.shelves;
});

// ---------- added by hand ----------
// Games and apps Shelf didn't find: an .exe, a shortcut (.lnk) or an internet shortcut (.url, e.g. steam://)
const ADD_EXT = /\.(exe|lnk|url|bat|cmd)$/i;
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function withManual(list) {
  const manual = (state.manual || []).filter((m) => !list.some((i) => i.id === m.id || (m.exe && samePath(i.exe, m.exe))));
  return [...list, ...manual];
}
const psJson = (script) =>
  new Promise((resolve) =>
    execFile('powershell.exe', psEncoded(script), { windowsHide: true, timeout: 15e3 }, (err, out) => {
      try {
        resolve(err ? null : JSON.parse(String(out)));
      } catch {
        resolve(null);
      }
    })
  );
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const prettyName = (file) =>
  path
    .basename(file, path.extname(file))
    .replace(/[_.]+/g, ' ')
    .replace(/(-|\s)(x64|x86|win64|win32|shipping)$/i, '')
    .trim();

// What would we add for this file? Name, launch target, folder, a guess at game vs app.
async function inspectFile(file) {
  if (typeof file !== 'string' || !ADD_EXT.test(file) || !fs.existsSync(file)) return null;
  file = path.normalize(file);
  const ext = path.extname(file).toLowerCase();
  const info = { path: file, name: prettyName(file), category: 'app' };
  let target = file;
  if (ext === '.lnk') {
    try {
      target = shell.readShortcutLink(file).target || file;
    } catch {}
  } else if (ext === '.url') {
    const txt = fs.readFileSync(file, 'utf8');
    info.uri = (txt.match(/^URL=(.+)$/m) || [])[1]?.trim() || null;
    if (!info.uri) return null;
    const ico = (txt.match(/^IconFile=(.+)$/m) || [])[1]?.trim();
    if (ico && fs.existsSync(ico)) info.iconPath = ico;
    if (/^(steam|com\.epicgames\.launcher|uplay|goggalaxy|heroic|battlenet):/i.test(info.uri)) info.category = 'game';
  }
  if (/\.exe$/i.test(target) && fs.existsSync(target)) {
    const v = await psJson(`$v=(Get-Item -LiteralPath ${psQuote(target)}).VersionInfo; @{p=$v.ProductName;d=$v.FileDescription} | ConvertTo-Json -Compress`);
    // file description is usually the app's own name; product name can be the whole suite (e.g. 'Microsoft Windows')
    const nice = [v?.d, v?.p]
      .map((s) => String(s || '').replace(/[®™©]/g, '').trim())
      .find((s) => s.length > 1 && !/^(launcher|game|application)$|operating system|system operacyjny/i.test(s));
    if (nice && ext !== '.lnk') info.name = nice;
    info.dir = path.dirname(target);
    if (/\\(games?|steamapps|epic games|gog galaxy|riot games|ubisoft)\\/i.test(target)) info.category = 'game';
  }
  info.name = info.name.slice(0, 80);
  return info;
}

async function addManual({ path: file, name, category }) {
  const info = await inspectFile(file);
  if (!info) return { error: 'file' };
  const ext = path.extname(file).toLowerCase();
  const exe = ext === '.exe' || ext === '.bat' || ext === '.cmd' ? file : null;
  const dup = exe && state.items.find((i) => samePath(i.exe, exe) && !i.leftover);
  if (dup) {
    // already on the shelf – just make sure it is visible
    const ov = (state.overrides[dup.id] ||= {});
    if (ov.hidden || dup.autoHidden) ov.hidden = false;
    saveState();
    send('library:items', payload());
    return { exists: true, item: view(dup) };
  }
  const it = {
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
  };
  state.manual = [...(state.manual || []).filter((m) => m.id !== it.id), it];
  state.items = withManual(state.items.filter((i) => i.id !== it.id));
  saveState();
  send('library:items', payload());
  extractIcons();
  if (it.category === 'game') fetchCovers();
  return { item: view(it) };
}

const ADD_FILTERS = () => [{ name: t('add.filter'), extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }];
ipcMain.handle('add:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: t('add.title'), properties: ['openFile'], filters: ADD_FILTERS() });
  return r.canceled || !r.filePaths[0] ? null : inspectFile(r.filePaths[0]);
});
ipcMain.handle('add:inspect', (_e, file) => inspectFile(file));
ipcMain.handle('add:save', (_e, data) => (data && typeof data === 'object' ? addManual(data) : { error: 'file' }));
ipcMain.handle('item:remove', (_e, id) => {
  if (!String(id).startsWith('manual:')) return false;
  state.manual = (state.manual || []).filter((m) => m.id !== id);
  state.items = state.items.filter((i) => i.id !== id);
  const f = state.overrides[id]?.coverFile;
  if (f) fs.rm(path.join(COVER_DIR, f), () => {});
  delete state.overrides[id];
  saveState();
  send('library:items', payload());
  return true;
});

// ---------- custom covers ----------
// Pick any Steam store entry, or a picture from disk (copied into %APPDATA%\Shelf\covers)
ipcMain.handle('cover:search', async (_e, q) => {
  q = String(q || '').trim().slice(0, 80);
  if (!q) return [];
  try {
    const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=US`, {
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    return (j.items || []).slice(0, 12).map((x) => ({ id: String(x.id), name: x.name }));
  } catch {
    return null; // offline
  }
});
function setCover(id, patch) {
  const it = find(id);
  if (!it) return null;
  const ov = (state.overrides[id] ||= {});
  if (ov.coverFile && patch.coverFile !== ov.coverFile) fs.rm(path.join(COVER_DIR, ov.coverFile), () => {});
  delete ov.coverFile;
  delete ov.coverAppId;
  Object.assign(ov, patch);
  saveState();
  if (ov.coverAppId) fetchCovers(); // header art for the "Recent" card
  send('library:items', payload());
  return view(it);
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
// Removes dead "installed program" entries (registry) and moves empty Steam
// folders to the Recycle Bin. Registry keys are exported to a .reg backup first.
const UNINSTALL_KEY_RE =
  /^HKEY_(LOCAL_MACHINE|CURRENT_USER)\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^"\\]+$/i;
const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 120e3 }, (err, out) => resolve({ ok: !err, out: String(out || '') })));
const regExists = async (key) => (await run('reg', ['query', key])).ok;
const psEncoded = (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

const TRASH_LIMIT = 2 * 1024 ** 3; // 2 GB
function dirSize(dir, cap) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (total > cap) return;
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      } catch {}
    }
  };
  try {
    walk(dir);
  } catch {}
  return total;
}

async function removeLeftovers(ids) {
  const list = ids.map(find).filter((it) => it && it.leftover);
  const tooBig = [];
  const backupDir = path.join(userDir, 'backups', 'leftovers-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  const keys = list.filter((it) => it.regKey && UNINSTALL_KEY_RE.test(it.regKey));
  if (keys.length) {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const it of keys) await run('reg', ['export', it.regKey, path.join(backupDir, it.regKey.split('\\').pop().replace(/[^\w.-]+/g, '_') + '.reg'), '/y']);
    // per-user entries need no admin rights
    for (const it of keys.filter((k) => /^HKEY_CURRENT_USER/i.test(k.regKey))) await run('reg', ['delete', it.regKey, '/f']);
    // machine-wide entries: one elevated call, so Windows asks only once
    const machine = keys.filter((k) => /^HKEY_LOCAL_MACHINE/i.test(k.regKey));
    if (machine.length) {
      const cmdLine = '/c ' + machine.map((k) => `reg delete "${k.regKey}" /f`).join(' & ');
      await run('powershell.exe', psEncoded(`Start-Process cmd.exe -ArgumentList '${cmdLine.replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden`));
    }
  }
  const removed = new Set();
  for (const it of list) {
    let ok = true;
    if (it.regKey) ok = UNINSTALL_KEY_RE.test(it.regKey) && !(await regExists(it.regKey));
    // empty Steam folder of an uninstalled game -> Recycle Bin (can be restored)
    if (ok && it.source === 'steam' && it.installDir && /\\steamapps\\common\\[^\\]+\\?$/i.test(it.installDir) && fs.existsSync(it.installDir)) {
      // a huge folder could skip the Recycle Bin and be gone for good – leave those to the user
      if (dirSize(it.installDir, TRASH_LIMIT) > TRASH_LIMIT) {
        tooBig.push(it.installDir);
        continue;
      }
      try {
        await shell.trashItem(it.installDir);
      } catch {
        ok = false;
      }
    }
    // a leftover with nothing we know how to remove (old cache entry) just drops off the list
    if (ok) removed.add(it.id);
  }
  state.items = state.items.filter((i) => !removed.has(i.id));
  saveState();
  send('library:items', payload());
  tooBig.forEach((d) => shell.openPath(d));
  return { removed: removed.size, total: list.length, tooBig: tooBig.length, backup: keys.length ? backupDir : null };
}
ipcMain.handle('leftover:remove', (_e, ids) => removeLeftovers(Array.isArray(ids) ? ids.map(String) : []));
ipcMain.handle('app:openPath', (_e, p) => {
  // only our own backup folders
  if (typeof p === 'string' && path.resolve(p).startsWith(path.join(userDir, 'backups'))) shell.openPath(p);
});

// ---------- updates ----------
// Installed builds check GitHub releases, download in the background and install on restart.
let updateState = { status: 'idle' };
let updater = null;
const setUpdate = (patch) => {
  updateState = { ...updateState, ...patch };
  send('update:status', updateStatus());
};
const updateStatus = () => ({ ...updateState, current: app.getVersion(), enabled: app.isPackaged });
function initUpdates() {
  if (!app.isPackaged || updater) return;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => setUpdate({ status: 'checking', error: null }));
  updater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  updater.on('update-not-available', () => setUpdate({ status: 'latest' }));
  updater.on('download-progress', (p) => setUpdate({ percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => {
    setUpdate({ status: 'ready', version: i.version });
    refreshTrayMenu();
  });
  updater.on('error', (e) => setUpdate({ status: 'error', error: String((e && e.message) || e).slice(0, 200) }));
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 10e3);
  setInterval(check, 6 * 3600e3);
}
function installUpdate() {
  if (!updater || updateState.status !== 'ready') return;
  quitting = true;
  updater.quitAndInstall(true, true); // silent, start Shelf again afterwards
}
ipcMain.handle('update:get', () => updateStatus());
ipcMain.handle('update:check', () => (updater ? updater.checkForUpdates().catch(() => {}) && true : false));
ipcMain.handle('update:install', () => installUpdate());

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

// window background behind the page, so there is no dark flash in light mode
const bgColor = () => {
  const t = state.theme || 'dark';
  return (t === 'system' ? nativeTheme.shouldUseDarkColors : t === 'dark') ? '#141210' : '#f4f1ea';
};
function setTheme(t) {
  state.theme = ['dark', 'light', 'system'].includes(t) ? t : 'dark';
  saveState();
  if (win && !win.isDestroyed()) win.setBackgroundColor(bgColor());
  send('theme:changed', state.theme);
  return state.theme;
}
ipcMain.handle('theme:set', (_e, t) => setTheme(t));
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
      ...(updateState.status === 'ready' ? [{ label: t('tray.update', updateState.version), click: installUpdate }, { type: 'separator' }] : []),
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
    initUpdates();
    setTimeout(trackPlaytime, 15e3);
    setInterval(trackPlaytime, PLAY_TICK);
  });

  app.on('before-quit', () => (quitting = true));
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
}
