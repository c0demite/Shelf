// Finds installed games and programs: registry, launchers, shortcuts and a light folder scan.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const U = require('./util');

const PS_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$paths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')
$u = foreach ($p in $paths) { Get-ItemProperty $p | Where-Object { $_.DisplayName } | ForEach-Object { [pscustomobject]@{ key=$_.PSChildName; name=$_.DisplayName; publisher=$_.Publisher; dir=$_.InstallLocation; icon=$_.DisplayIcon; uninstall=$_.UninstallString; size=$_.EstimatedSize; date=$_.InstallDate; sys=$_.SystemComponent; parent=$_.ParentKeyName; rel=$_.ReleaseType } } }
$gog = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\GOG.com\Games\*' | ForEach-Object { [pscustomobject]@{ id=$_.gameID; name=$_.gameName; exe=$_.exe; dir=$_.path; workDir=$_.workingDir } }
$ubi = Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs' | ForEach-Object { [pscustomobject]@{ id=$_.PSChildName; dir=(Get-ItemProperty $_.PSPath).InstallDir } }
$start = Get-StartApps | Where-Object { $_.AppID -like '*!*' } | ForEach-Object { [pscustomobject]@{ name=$_.Name; id=$_.AppID } }
$steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam').SteamPath
$drives = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID + '\' }
[pscustomobject]@{ uninstall=@($u); gog=@($gog); ubisoft=@($ubi); start=@($start); steam=$steam; drives=@($drives) } | ConvertTo-Json -Depth 4 -Compress
`;

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        try {
          resolve(JSON.parse(stdout.trim().replace(/^\uFEFF/, '')));
        } catch (e) {
          reject(new Error('Nie udało się odczytać danych systemowych'));
        }
      }
    );
  });
}

// ---------- Steam ----------
const STEAM_SKIP_IDS = new Set(['228980', '1070560', '1391110', '1628350', '1826330', '2180100']);
const STEAM_APP_RE =
  /dedicated server|\bsdk\b|redistributables?|proton|steamworks|steam linux runtime|soundtrack|\bost\b|wallpaper engine|steamvr|aseprite|blender|obs studio|soundpad|lossless scaling|rpg maker|gamemaker|game maker|3dmark|fpsvr|ovr advanced|desktop mate|spacedesk|tool$|tools$|editor$|benchmark/i;

async function readVdf(file) {
  try {
    return U.parseVdf(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function scanSteam(steamPath, drives) {
  const libs = new Map();
  let steamRoot = null;
  if (steamPath) {
    steamRoot = path.normalize(steamPath);
    libs.set(U.normPath(steamRoot), { p: steamRoot, registered: true });
    const lf = await readVdf(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'));
    const folders = lf && (lf.libraryfolders || lf);
    if (folders) {
      for (const v of Object.values(folders)) {
        const p = typeof v === 'string' ? v : v && v.path;
        if (p && U.exists(p)) libs.set(U.normPath(p), { p: path.normalize(p), registered: true });
      }
    }
  }
  // Libraries Steam forgot about (old drives, reinstalls)
  for (const d of drives) {
    for (const sub of ['SteamLibrary', 'Steam', 'Games\\Steam', 'Gry\\Steam', 'Program Files (x86)\\Steam', 'Program Files\\Steam']) {
      const p = path.join(d, sub);
      const key = U.normPath(p);
      if (!libs.has(key) && U.exists(path.join(p, 'steamapps'))) libs.set(key, { p, registered: false });
    }
  }

  // Last played + playtime from all Steam users
  const played = {};
  if (steamRoot) {
    try {
      const users = await fsp.readdir(path.join(steamRoot, 'userdata'));
      for (const uid of users) {
        const cfg = await readVdf(path.join(steamRoot, 'userdata', uid, 'config', 'localconfig.vdf'));
        const apps = cfg?.userlocalconfigstore?.software?.valve?.steam?.apps;
        if (!apps) continue;
        for (const [id, a] of Object.entries(apps)) {
          const lp = +a.lastplayed || 0;
          const pt = +a.playtime || 0;
          const cur = played[id] || { lastPlayed: 0, playtime: 0 };
          played[id] = { lastPlayed: Math.max(cur.lastPlayed, lp), playtime: Math.max(cur.playtime, pt) };
        }
      }
    } catch {}
  }

  const out = new Map();
  for (const lib of [...libs.values()].sort((a, b) => b.registered - a.registered)) {
    const dir = path.join(lib.p, 'steamapps');
    let files = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = await readVdf(path.join(dir, f));
      const st = m && m.appstate;
      if (!st || !st.appid || STEAM_SKIP_IDS.has(st.appid) || out.has(st.appid)) continue;
      const full = path.join(dir, 'common', st.installdir || '');
      if (!st.installdir || !U.exists(full)) continue;
      const item = {
        id: 'steam:' + st.appid,
        source: 'steam',
        name: st.name || st.installdir,
        steamAppId: st.appid,
        installDir: full,
        size: +st.sizeondisk || null,
        category: STEAM_APP_RE.test(st.name || '') ? 'app' : 'game',
        lastPlayed: played[st.appid]?.lastPlayed ? played[st.appid].lastPlayed * 1000 : null,
        playtime: played[st.appid]?.playtime || null,
      };
      if (lib.registered) item.uri = 'steam://rungameid/' + st.appid;
      else {
        item.exe = await U.findMainExe(full, item.name);
        item.note = 'note.steamUnknown';
      }
      out.set(st.appid, item);
    }
  }

  // Game folders without a manifest (e.g. after reinstalling Steam) – still playable directly
  const known = new Set([...out.values()].map((i) => U.normPath(i.installDir)));
  for (const lib of libs.values()) {
    const common = path.join(lib.p, 'steamapps', 'common');
    let subs = [];
    try {
      subs = (await fsp.readdir(common, { withFileTypes: true })).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const s of subs) {
      const dir = path.join(common, s.name);
      if (known.has(U.normPath(dir)) || /^(steamworks shared|steam controller configs|steamvr|steamlinuxruntime.*|proton.*)$/i.test(s.name)) continue;
      const exe = await U.findMainExe(dir, s.name);
      known.add(U.normPath(dir));
      if (!exe) {
        // Uninstalled game whose folder stayed behind
        out.set('dir:' + dir, {
          id: 'steamdir:' + U.normPath(dir),
          source: 'steam',
          name: s.name,
          installDir: dir,
          category: 'game',
          leftover: true,
          autoHidden: true,
          note: 'note.emptySteam',
        });
        continue;
      }
      let appid = null;
      try {
        appid = (await fsp.readFile(path.join(dir, 'steam_appid.txt'), 'utf8')).trim().match(/^\d+/)?.[0] || null;
      } catch {}
      known.add(U.normPath(dir));
      out.set('dir:' + dir, {
        id: 'steamdir:' + U.normPath(dir),
        source: 'steam',
        name: s.name,
        steamAppId: appid,
        installDir: dir,
        exe,
        category: STEAM_APP_RE.test(s.name) ? 'app' : 'game',
        note: 'note.noManifest',
      });
    }
  }
  return [...out.values()];
}

// ---------- Epic ----------
async function scanEpic() {
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  const out = [];
  let files = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.item'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
      if (j.bIsIncompleteInstall || !j.InstallLocation || !U.exists(j.InstallLocation)) continue;
      const cats = j.AppCategories || [];
      if (cats.includes('plugins') || cats.includes('digitalextras')) continue;
      out.push({
        id: 'epic:' + j.AppName,
        source: 'epic',
        name: j.DisplayName,
        installDir: j.InstallLocation,
        exe: j.LaunchExecutable ? path.join(j.InstallLocation, j.LaunchExecutable) : null,
        size: j.InstallSize || null,
        uri: `com.epicgames.launcher://apps/${j.CatalogNamespace}%3A${j.CatalogItemId}%3A${j.AppName}?action=launch&silent=true`,
        category: cats.includes('engines') ? 'app' : 'game',
      });
    } catch {}
  }
  return out;
}

// ---------- GOG / Ubisoft ----------
function gogItems(list) {
  return U.toArr(list)
    .filter((g) => g.id && g.name && U.exists(g.dir))
    .map((g) => ({
      id: 'gog:' + g.id,
      source: 'gog',
      name: g.name,
      installDir: g.dir,
      exe: g.exe && U.exists(g.exe) ? g.exe : null,
      cwd: g.workDir || g.dir,
      category: 'game',
    }));
}

function ubisoftItems(list, uninstall) {
  return U.toArr(list)
    .filter((u) => u.id && U.exists(u.dir))
    .map((u) => {
      const reg = uninstall.find((r) => (r.key || '').toLowerCase() === ('uplay install ' + u.id).toLowerCase());
      return {
        id: 'ubisoft:' + u.id,
        source: 'ubisoft',
        name: reg?.name || path.basename(path.normalize(u.dir)),
        installDir: path.normalize(u.dir),
        uri: `uplay://launch/${u.id}/0`,
        category: 'game',
      };
    });
}

// ---------- Xbox (PC Game Pass) + Microsoft Store ----------
async function scanXbox(drives, start) {
  const out = [];
  const used = new Set();
  for (const d of drives) {
    const root = path.join(d, 'XboxGames');
    let subs = [];
    try {
      subs = (await fsp.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const s of subs) {
      if (/^gamesave/i.test(s.name)) continue;
      const dir = path.join(root, s.name);
      let cfg = '';
      try {
        cfg = await fsp.readFile(path.join(dir, 'Content', 'MicrosoftGame.config'), 'utf8');
      } catch {
        continue;
      }
      const identity = (cfg.match(/<Identity[^>]*\bName="([^"]+)"/i) || [])[1];
      let display = (cfg.match(/DefaultDisplayName="([^"]+)"/i) || [])[1];
      const exeName = (cfg.match(/<Executable[^>]*\bName="([^"]+)"/i) || [])[1];
      const logo = (cfg.match(/Square480x480Logo="([^"]+)"/i) || cfg.match(/Square150x150Logo="([^"]+)"/i) || [])[1];
      const logoPath = logo ? path.join(dir, 'Content', logo) : null;
      const sa = identity && start.find((x) => x.id.toLowerCase().startsWith(identity.toLowerCase() + '_'));
      if (sa) used.add(sa.id);
      if (!display || display.startsWith('ms-resource')) display = sa?.name || s.name;
      out.push({
        id: 'xbox:' + (identity || s.name),
        source: 'xbox',
        name: display,
        installDir: dir,
        aumid: sa?.id || null,
        exe: exeName ? path.join(dir, 'Content', exeName) : null,
        iconPath: logoPath && U.exists(logoPath) ? logoPath : null,
        category: 'game',
      });
    }
  }
  return { items: out, used };
}

const MS_BUILTIN_RE = /^(microsoft|windows\.|microsoftwindows|microsoftcorporationii|clipchamp|msteams|ms-resource|realtek|nvidia|advancedmicrodevices|appup\.intel|dolby|ad2f1837)/i;

function storeItems(start, used) {
  return start
    .filter((s) => !used.has(s.id) && s.name)
    .map((s) => ({
      id: 'store:' + s.id,
      source: 'store',
      name: s.name,
      aumid: s.id,
      category: 'app',
      autoHidden: MS_BUILTIN_RE.test(s.id),
    }));
}

// ---------- Registry (Programs & Features) ----------
const REG_JUNK_RE =
  /(redistributable|runtime|\bsdk\b|\bdrivers?\b|sterownik|webview2|directx|vcredist|visual c\+\+|\.net (framework|desktop|host|core|toolset|targeting|runtime)|microsoft \.net|asp\.net|windows app runtime|update health|microsoft update|security update|hotfix|\(kb\d+\)|language pack|pakiet językowy|bonjour|intel\(r\)|realtek|physx|nvidia (graphics|hd audio|frameview|usbc|install|telemetry|update|virtual|ngx|platform|shadowplay|backend|container|node)|amd (chipset|install manager|settings)|^vs_|icecap|python launcher|java auto updater|prerequisites|easyanticheat|easy anti-cheat|battleye|vulkan run|openal|xna framework|gameinput|pc health|teams machine-wide|click-to-run (extensibility|localization|licensing)|edge update|google update|update helper|universal crt|entity framework|sql server .*(native client|compact|odbc|ole db|setup|vss|lang|t-sql|dacfx|shared|browser|writer)|windows driver package|application verifier|kits configuration|support files|winrt intellisense|msi development|windows subsystem for linux update|\bcodecs? pack\b|\bmodule\b|\bplug-?in\b|\bextension\b|\bcomponents?\b|\btools for\b|\bservice pack\b|\bpatch\b|add-in|compatibility fix|level zero|online services|app shop)/i;

function cleanIconPath(icon) {
  if (!icon) return null;
  let p = String(icon).trim().replace(/^"/, '');
  p = p.replace(/",?.*$/, '').replace(/,\s*-?\d+$/, '').trim();
  return p || null;
}

function parseRegDate(d) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(d || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
}

function registryItems(list) {
  const out = [];
  for (const r of list) {
    if (!r || !r.name) continue;
    const key = String(r.key || '');
    if (+r.sys === 1 || r.parent || /update|hotfix/i.test(r.rel || '')) continue;
    if (/^steam app \d+$/i.test(key) || /^uplay install \d+$/i.test(key)) continue;
    if (REG_JUNK_RE.test(r.name)) continue;
    const icon = cleanIconPath(r.icon);
    const iconOk = icon && /\.(exe|ico)$/i.test(icon) && !/\\windows\\installer\\/i.test(icon) && U.exists(icon);
    let dir = r.dir ? String(r.dir).trim().replace(/^"|"$/g, '') : null;
    // Folder is gone -> leftover entry of something already deleted
    const missing = !!dir && !U.isGenericDir(dir) && !U.exists(dir);
    if (dir && (missing || U.isGenericDir(dir))) dir = null;
    if (!dir && iconOk && /\.exe$/i.test(icon) && !U.isGenericDir(path.dirname(icon))) dir = path.dirname(icon);
    const exe = iconOk && /\.exe$/i.test(icon) && !U.isJunkExe(path.basename(icon, '.exe')) ? icon : null;
    out.push({
      id: 'reg:' + key,
      source: 'registry',
      name: String(r.name).trim(),
      publisher: r.publisher ? String(r.publisher).trim() : null,
      installDir: dir,
      exe,
      iconPath: iconOk ? icon : null,
      size: r.size && !missing ? +r.size * 1024 : null,
      installDate: parseRegDate(r.date),
      uninstall: r.uninstall || null,
      leftover: missing || undefined,
      autoHidden: missing || undefined,
      missingDir: missing ? String(r.dir).trim() : undefined,
    });
  }
  return out;
}

// ---------- Start Menu & Desktop shortcuts ----------
const JUNK_LNK_RE =
  /uninstall|odinstaluj|deinstal|readme|read me|\bhelp\b|pomoc|manual|license|licencja|website|web site|support|documentation|dokumentacja|release notes|changelog|what's new|\bfaq\b|recovery|repair|safe mode|configurator|homepage|strona|register|rejestr|\bmodule\b|\bdebug\b|reload|configuration|stack builder|sql shell|command prompt|wiersz polecenia|console$|\bshell\b|psql|pgadmin.*server/i;

async function walkLnk(dir, depth, acc) {
  let ents;
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 4 && !/^(startup|autostart|administrative tools|narzędzia administracyjne|windows (tools|accessories|system|powershell|ease of access)|system tools|accessibility)$/i.test(e.name))
        await walkLnk(p, depth + 1, acc);
    } else if (/\.lnk$/i.test(e.name)) acc.push(p);
  }
}

async function scanShortcuts(shell) {
  if (!shell || !shell.readShortcutLink) return [];
  const home = os.homedir();
  const roots = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
    path.join(process.env.APPDATA || path.join(home, 'AppData\\Roaming'), 'Microsoft\\Windows\\Start Menu\\Programs'),
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive', 'Pulpit'),
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'),
  ];
  const files = [];
  for (const r of roots) await walkLnk(r, 0, files);
  const out = [];
  const seen = new Set();
  for (const f of files) {
    let l;
    try {
      l = shell.readShortcutLink(f);
    } catch {
      continue;
    }
    const t = l && l.target;
    if (!t || !/\.exe$/i.test(t) || !U.exists(t)) continue;
    if (/^[a-z]:\\windows\\/i.test(t)) continue;
    const name = path.basename(f, path.extname(f));
    if (JUNK_LNK_RE.test(name) || U.isJunkExe(path.basename(t, '.exe'))) continue;
    const key = (t + '|' + (l.args || '')).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: 'lnk:' + key,
      source: 'shortcut',
      name,
      lnk: f,
      exe: t,
      args: l.args || '',
    });
  }
  return out;
}

// ---------- Light disk scan (portable apps, repacks, loose game folders) ----------
const SKIP_ROOT = new Set(
  'windows,users,programdata,recovery,perflogs,$recycle.bin,system volume information,steamlibrary,steam,xboxgames,windowsapps,wpsystem,msocache,intel,amd,nvidia,drivers,boot,config.msi,onedrivetemp,.pnpm-store,node_modules,msys64,cygwin64,android,sdk,dumpstack.log.tmp,inetpub,esd,$windows.~bt,$windows.~ws,$winreagent,epic games,gog games,gog galaxy,ubisoft,ea games,origin games'.split(',')
);
const CONTAINER_RE = /^(games|gry|gierki|portable|programy|aplikacje|apps|program files|program files \(x86\))$/i;
const SYSTEM_CONTAINER_RE = /^(games|gry|gierki|portable)$/i;
const SKIP_IN_PF_RE = /^(common files|windows.*|microsoft.*|internet explorer|modifiablewindowsapps|windowsapps|dotnet|msbuild|reference assemblies|nvidia.*|amd|intel|realtek|uninstall information|packagemanagement|windowspowershell|mozilla maintenance service|iis.*|hyper-v|dolby|installshield.*|package cache)$/i;
const DEV_MARKERS = new Set(
  'package.json,.git,pyproject.toml,requirements.txt,cargo.toml,go.mod,project.godot,.vscode,.idea,tsconfig.json,composer.json,gemfile,node_modules,venv,.venv,docker-compose.yml,dockerfile,cmakelists.txt,setup.py,pom.xml,build.gradle,.gitignore,pnpm-lock.yaml,yarn.lock,next.config.js,vite.config.js,vite.config.ts,manage.py'.split(',')
);

const hasDevMarker = (names) =>
  names.some((n) => {
    const l = n.toLowerCase();
    return DEV_MARKERS.has(l) || l.endsWith('.sln') || l.endsWith('.csproj') || l.endsWith('.uproject');
  });

// A code project (also one nested a level down, e.g. D:\flux\aw-flux)
async function isDevProject(dir) {
  let ents;
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  if (hasDevMarker(ents.map((e) => e.name))) return true;
  const subs = ents.filter((e) => e.isDirectory()).slice(0, 30);
  for (const s of subs) {
    try {
      if (hasDevMarker(await fsp.readdir(path.join(dir, s.name)))) return true;
    } catch {}
  }
  return false;
}

// "lossless" + LosslessCut.exe -> "LosslessCut"
function nameFromExe(folderName, exe) {
  const stem = path.basename(exe, '.exe');
  const a = U.norm(folderName);
  const b = U.norm(stem);
  if (b.length > a.length && b.startsWith(a) && !/[_\d]{3,}|\d+\.\d+|_v\d/i.test(stem)) return stem;
  return folderName;
}

async function scanFolders(drives) {
  const sysDrive = (process.env.SystemDrive || 'C:').toLowerCase();
  const candidates = [];
  for (const d of drives) {
    const isSys = d.toLowerCase().startsWith(sysDrive);
    let ents = [];
    try {
      ents = (await fsp.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const e of ents) {
      const lower = e.name.toLowerCase();
      if (SKIP_ROOT.has(lower) || lower.startsWith('$') || lower.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (isSys ? SYSTEM_CONTAINER_RE.test(e.name) : CONTAINER_RE.test(e.name)) {
        const isGames = /^(games|gry|gierki)$/i.test(e.name);
        let kids = [];
        try {
          kids = (await fsp.readdir(full, { withFileTypes: true })).filter((k) => k.isDirectory());
        } catch {}
        for (const k of kids) {
          if (SKIP_IN_PF_RE.test(k.name) || SKIP_ROOT.has(k.name.toLowerCase())) continue;
          candidates.push({ dir: path.join(full, k.name), gameHint: isGames });
        }
      } else if (!isSys) {
        candidates.push({ dir: full, gameHint: false });
      }
    }
  }
  const out = [];
  await Promise.all(
    candidates.map(async (c) => {
      if (await isDevProject(c.dir)) return;
      const base = path.basename(c.dir);
      const name = U.cleanFolderName(base);
      const exe = await U.findMainExe(c.dir, name);
      if (!exe) return;
      out.push({
        id: 'dir:' + U.normPath(c.dir),
        source: 'folder',
        name: nameFromExe(name, exe),
        installDir: c.dir,
        exe,
        gameHint: c.gameHint,
      });
    })
  );
  return out;
}

// ---------- Merge & classify ----------
const PRIORITY = ['steam', 'epic', 'gog', 'ubisoft', 'xbox', 'registry', 'store', 'shortcut', 'folder'];
const GAME_PUB_RE =
  /electronic arts|ubisoft|blizzard|riot games|rockstar|cd projekt|bethesda|2k games|bandai namco|square enix|\bsega\b|capcom|activision|mojang|paradox|devolver|team17|focus (home )?(interactive|entertainment)|thq|warner bros.*games|wargaming|gaijin|hoyoverse|mihoyo|cognosphere|grinding gear|digital extremes|krafton|nexon|smilegate|innersloth|klei|re-logic|landfall|facepunch|valve corporation|techland|11 bit|people can fly|fromsoftware|remedy|io interactive|deep silver|koei tecmo|konami|nintendo|gearbox|frontier developments|curve games|tinybuild|raw fury|annapurna|hello games|ccp games|jagex|bungie|respawn|roblox/i;
const LAUNCHER_RE =
  /(battle\.net|gog galaxy|ubisoft connect|uplay|\bea app\b|^origin$|epic games launcher|riot client|riot vanguard|anti-?cheat|^steam$|rockstar games launcher|bethesda\.net launcher|amazon games|itch|playnite|overwolf|modrinth|curseforge|prism launcher|heroic|lutris|geforce|radeon|msi afterburner|discord|xbox$|wallpaper engine)/i;

const MERGE_KEYS = ['publisher', 'size', 'installDate', 'uninstall', 'installDir', 'exe', 'lnk', 'iconPath'];
function absorb(into, from) {
  for (const k of MERGE_KEYS) if (into[k] == null && from[k] != null) into[k] = from[k];
}

function merge(all) {
  all.sort((a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source));
  const out = [];
  const byName = new Map();
  const add = (it) => {
    out.push(it);
    const n = U.norm(it.name);
    if (n && !byName.has(n)) byName.set(n, it);
  };
  const withDir = () => out.filter((o) => o.installDir);

  const shortcuts = [];
  const folders = [];
  for (const it of all) {
    if (it.source === 'shortcut') { shortcuts.push(it); continue; }
    if (it.source === 'folder') { folders.push(it); continue; }
    const nd = U.normPath(it.installDir);
    let dup = byName.get(U.norm(it.name));
    if (!dup && nd)
      dup = withDir().find((o) => {
        const od = U.normPath(o.installDir);
        return U.isInside(nd, od) || (U.isInside(od, nd) && U.sim(o.name, it.name) >= 0.6);
      });
    if (dup && (dup.source !== it.source || dup.source === 'registry')) { absorb(dup, it); continue; }
    add(it);
  }

  // Shortcuts: 1) obvious matches, 2) give a launch target to registry entries without one, 3) the rest stay separate
  const pending = [];
  for (const s of shortcuts) {
    const t = U.normPath(s.exe);
    const sameExe = !s.args && out.find((o) => o.exe && U.normPath(o.exe) === t);
    if (sameExe) { if (!sameExe.lnk) sameExe.lnk = s.lnk; continue; }
    const container = withDir().find((o) => U.isInside(t, U.normPath(o.installDir)) && U.sim(o.name, s.name) >= 0.6);
    if (container) { if (!container.exe) { container.exe = s.exe; container.lnk = s.lnk; } continue; }
    if (byName.has(U.norm(s.name))) { const o = byName.get(U.norm(s.name)); if (!o.exe && !o.uri && !o.aumid) { o.exe = s.exe; o.lnk = s.lnk; } continue; }
    pending.push(s);
  }
  const rest = [];
  for (const s of pending) {
    const t = U.normPath(s.exe);
    const c = out.find((o) => o.source === 'registry' && !o.exe && o.installDir && U.isInside(t, U.normPath(o.installDir)));
    if (c) { c.exe = s.exe; c.lnk = s.lnk; continue; }
    rest.push(s);
  }
  for (const s of rest) {
    s.installDir = null;
    add(s);
  }

  for (const f of folders) {
    const fd = U.normPath(f.installDir);
    const dup =
      withDir().find((o) => { const od = U.normPath(o.installDir); return U.isInside(fd, od) || U.isInside(od, fd); }) ||
      out.find((o) => o.exe && U.isInside(U.normPath(o.exe), fd)) ||
      byName.get(U.norm(f.name));
    if (dup) { if (!dup.exe && !dup.uri && !dup.aumid) dup.exe = f.exe; continue; }
    add(f);
  }

  // Same program found twice under slightly different names (e.g. "Roblox" / "Roblox Player for X")
  const GENERIC_EXE = /^(launcher|game|start|play|app|main|client|setup|run)\.exe$/i;
  const drop = new Set();
  out.forEach((a, i) => {
    if (drop.has(a)) return;
    for (let j = i + 1; j < out.length; j++) {
      const b = out[j];
      if (drop.has(b) || a.leftover || b.leftover) continue;
      const sameExe = a.exe && b.exe && path.basename(a.exe).toLowerCase() === path.basename(b.exe).toLowerCase() && !GENERIC_EXE.test(path.basename(a.exe));
      const bDead = !b.exe && !b.uri && !b.aumid;
      if ((sameExe && U.sim(a.name, b.name) >= 0.6) || (bDead && U.sim(a.name, b.name) >= 0.8)) {
        absorb(a, b);
        drop.add(b);
      }
    }
  });
  return out.filter((o) => !drop.has(o));
}

async function classify(it) {
  if (it.category) return;
  if (it.source === 'registry' && LAUNCHER_RE.test(it.name)) { it.category = /minecraft/i.test(it.name) ? 'game' : 'app'; return; }
  if (LAUNCHER_RE.test(it.name)) { it.category = 'app'; return; }
  if (it.gameHint) { it.category = 'game'; return; }
  if (it.publisher && GAME_PUB_RE.test(it.publisher)) { it.category = 'game'; return; }
  const where = (it.installDir || it.exe || it.missingDir || '').toLowerCase();
  if (/\\(games|gry|gierki|steamapps|xboxgames|gog games|epic games\\(?!launcher))\\/.test(where)) { it.category = 'game'; return; }
  const dir = it.installDir || (it.exe ? path.dirname(it.exe) : null);
  const exeDir = it.exe ? path.dirname(it.exe) : null;
  const game = (await U.looksLikeGame(dir)) || (exeDir && exeDir !== dir && (await U.looksLikeGame(exeDir)));
  it.category = game ? 'game' : 'app';
}

async function scanAll({ shell, progress = () => {} } = {}) {
  const t0 = Date.now();
  progress('scan.registry');
  const sys = await runPowerShell(PS_SCRIPT);
  const drives = U.toArr(sys.drives).length ? U.toArr(sys.drives) : ['C:\\'];
  const uninstall = U.toArr(sys.uninstall);
  const start = U.toArr(sys.start).filter((s) => s && s.id);

  progress('scan.launchers');
  const [steam, epic, xbox, shortcuts, folders] = await Promise.all([
    scanSteam(sys.steam, drives),
    scanEpic(),
    scanXbox(drives, start),
    scanShortcuts(shell),
    scanFolders(drives),
  ]);

  progress('scan.merge');
  const items = merge([
    ...steam,
    ...epic,
    ...gogItems(sys.gog),
    ...ubisoftItems(sys.ubisoft, uninstall),
    ...xbox.items,
    ...registryItems(uninstall),
    ...storeItems(start, xbox.used),
    ...shortcuts,
    ...folders,
  ]);

  // Folder names can be vague ("Launcher") – the exe's own product name is better
  const vague = items.filter((i) => i.source === 'folder' || (i.source === 'shortcut' && /^[\w-]+$/.test(i.name)));
  if (vague.length) {
    try {
      const list = vague.map((i) => "'" + i.exe.replace(/'/g, "''") + "'").join(',');
      const info = U.toArr(
        await runPowerShell(
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(${list}) | ForEach-Object { $v=(Get-Item -LiteralPath $_).VersionInfo; [pscustomobject]@{p=$_; n=$v.ProductName; d=$v.FileDescription} } | ConvertTo-Json -Compress`
        )
      );
      for (const it of vague) {
        const v = info.find((x) => x && x.p === it.exe);
        const cand = [v?.n, v?.d].map((s) => (s || '').trim()).find((s) => s && s.length >= 3 && s.length <= 48 && !/^(launcher|game|application|app|main|unity|godot engine|electron|chromium|google chrome|bootstrapper)$/i.test(s));
        if (cand && U.norm(cand) !== U.norm(it.name)) {
          // keep a good folder name for games ("Moon Sweepers"), replace vague ones
          if (U.norm(it.name).length < 9 || U.sim(cand, it.name) >= 0.5) it.name = cand;
        }
      }
    } catch {}
  }

  progress('scan.classify');
  await Promise.all(
    items.map(async (it) => {
      if (!it.exe && !it.uri && !it.aumid && it.installDir) it.exe = await U.findMainExe(it.installDir, it.name, 2);
      await classify(it);
      delete it.gameHint;
    })
  );
  items.forEach((it) => (it.canLaunch = !!(it.uri || it.aumid || it.lnk || it.exe)));
  return { items, drives, ms: Date.now() - t0 };
}

module.exports = { scanAll };
