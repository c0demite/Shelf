// Which running process belongs to which game or app on the shelf.
// Used for playtime, for skipping apps that are already open, and for bringing an open app to the front.
const path = require('path').win32; // Shelf is Windows-only; keeps the rules the same in tests
const { execFile } = require('child_process');
const { psEncoded, psQuote } = require('./ps');

// Folders shared by many programs: one level below them is not enough to tell whose process it is
const CONTAINERS = new Set(['games', 'game', 'gry', 'program files', 'program files (x86)', 'programdata', 'steam', 'steamlibrary', 'xboxgames', 'epic games', 'gog games', 'gog galaxy', 'riot games', 'ubisoft', 'ea games', 'users', 'windows', 'apps', 'programs', 'programy', 'tools', 'portable', 'downloads', 'pobrane', 'desktop']);

const low = (p) => path.normalize(p).toLowerCase().replace(/[\\/]+$/, '');

// sysRoot: C:\Windows; selfDirs: Shelf's own folders; readShortcut(lnk) -> target path or null
function createProcessRules({ sysRoot, selfDirs, readShortcut = () => null }) {
  const sys = low(sysRoot);
  const self = selfDirs.map((d) => low(d) + path.sep);
  const inSys = (p) => p === sys || p.startsWith(sys + path.sep);
  const isSelf = (it) => [it.installDir, it.exe].some((p) => p && self.some((d) => (low(p) + path.sep).startsWith(d)));

  // The folder whose processes belong to an item (lower case, ends with \) – or null when it's
  // too broad to tell: a whole drive, C:\Windows, a shared container like "D:\Games", or Shelf itself.
  // Games often sit right under a drive ("F:\Satisfactory"), so one level is fine unless it's a container.
  function watchDir(it) {
    const dirs = [it.installDir, it.exe && path.dirname(it.exe)];
    if (!it.installDir && !it.exe && it.lnk) {
      const target = readShortcut(it.lnk);
      if (target) dirs.push(path.dirname(target));
    }
    for (const dir of dirs) {
      if (!dir) continue;
      const d = low(dir);
      if (inSys(d) || self.some((s) => (d + path.sep).startsWith(s))) return null;
      const parts = d.split(path.sep).filter(Boolean);
      if (parts.length >= 3 || (parts.length === 2 && !CONTAINERS.has(parts[1]))) return d + path.sep;
    }
    return null;
  }

  // How to recognise the item's processes: { prefix: folder } or, when the folder is too broad, { exact: exe }
  function runningMatch(it) {
    const dir = watchDir(it);
    if (dir) return { prefix: dir };
    const exe = it.exe && low(it.exe);
    return exe && !inSys(exe) ? { exact: exe } : null;
  }
  const hits = (m, exe) => (m.prefix ? exe.startsWith(m.prefix) : exe === m.exact);

  // exes: lower-case paths of processes that have a window
  const isOpen = (it, exes) => {
    const m = runningMatch(it);
    return !!m && exes.some((e) => hits(m, e));
  };

  // Ids of items that own at least one of these processes. The most specific folder wins,
  // so a game inside the Steam folder doesn't count as Steam. Only apps fall back to their exact exe.
  function owners(items, exes) {
    const ms = [];
    for (const it of items) {
      if (it.leftover || it.hidden || isSelf(it)) continue;
      const m = runningMatch(it);
      if (m && (m.prefix || it.category === 'app')) ms.push({ id: it.id, m, len: m.prefix ? m.prefix.length : Infinity });
    }
    const out = new Set();
    for (const e of exes) {
      let best = null;
      for (const x of ms) if (hits(x.m, e) && (!best || x.len > best.len)) best = x;
      if (best) out.add(best.id);
    }
    return out;
  }

  return { watchDir, runningMatch, isOpen, owners, isSelf };
}

// Running processes: { all, windowed } – lower-case exe paths; null if PowerShell failed
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

// Brings the newest window matching runningMatch() to the front. Resolves true if there was one.
// dllDir: where a small compiled helper is cached between calls.
function focusWindow(m, dllDir) {
  if (!m) return Promise.resolve(false);
  const test = m.prefix ? `$_.Path.ToLower().StartsWith(${psQuote(m.prefix)})` : `$_.Path.ToLower() -eq ${psQuote(m.exact)}`;
  const script = `$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -and (${test}) } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { 'none'; exit }
$dll = ${psQuote(path.join(dllDir, 'shelfwin-1.dll'))}
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

module.exports = { createProcessRules, runningExes, focusWindow };
