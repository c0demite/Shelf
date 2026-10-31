const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const norm = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9ąćęłńóśźż]/g, '');

const normPath = (p) => {
  if (!p) return null;
  try {
    return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  } catch {
    return null;
  }
};

const isInside = (child, parent) =>
  !!child && !!parent && (child === parent || child.startsWith(parent + '\\'));

const exists = (p) => {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// 0..1 – how alike two names are
function sim(a, b) {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  return commonPrefix(a, b) / Math.max(a.length, b.length);
}

// Folders that are never a specific program's own install folder
function isGenericDir(p) {
  const n = normPath(p);
  if (!n) return true;
  if (/^[a-z]:$/.test(n)) return true;
  return /^[a-z]:\\(windows|users|programdata|program files|program files \(x86\)|games|gry|xboxgames|steamlibrary)(\\(system32|syswow64|common files|installer))?$/.test(n)
    || /^[a-z]:\\windows\\/.test(n)
    || /^[a-z]:\\programdata\\package cache/.test(n)
    || /^[a-z]:\\users\\[^\\]+(\\appdata(\\(local|roaming|locallow)(\\programs)?)?)?$/.test(n);
}

const JUNK_EXE_RE =
  /^(unins\d*|uninst.*|.*uninstall.*|vc_?redist.*|dxwebsetup|dxsetup|ue\d?prereqsetup.*|.*prereq.*|crashpad_handler|.*crash.*|unitycrashhandler(32|64)?|easyanticheat.*|battleye.*|be_?service.*|cef.*|qtwebengineprocess|pythonw?|node|javaw?|ffmpeg|ffprobe|7z.*|elevate.*|notification_helper|updater?|.*setup.*|.*install.*|.*redist.*|.*helper.*|.*reporter.*|squirrel|createdump|dotnet|.*service|.*daemon|.*_?server|dedicated.*|.*touchup.*|.*cleanup.*|.*repair.*|.*diag.*|.*benchmark.*|.*register.*|.*activation.*|.*patcher.*|winpty.*|conhost|cmd|powershell|.*sandbox.*|.*watchdog.*|.*monitor.*|.*telemetry.*|.*errorreport.*|.*feedback.*|.*bugreport.*|.*driver|.*headless.*|.*tests?|test.*|torch.*|f2py|pip\d*|wheel|.*weblauncher|vsweb.*|chrome_pwa_launcher|chrome_proxy|.*_ui_tests|vsjitdebugger|vsngen.*|.*runner|msedgewebview2|.*proxy|.*agent|.*broker|.*host)$/i;

const isJunkExe = (stem) => JUNK_EXE_RE.test(stem);

const SKIP_SUB_RE =
  /^(node_modules|\.git|__pycache__|_?commonredist|redist|redistributables?|directx|vcredist|dotnet|prereq.*|__installer|installers?|support|crash.*|\.venv|venv|site-packages|lib|libs|locales|resources|swiftshader|logs?|cache|temp|tmp|saves?|screenshots|mods?|shaders?|plugins|content|data|.*_data|engine|thirdparty|third_party|docs?|manual|licenses?|legal|extras?|soundtrack|ost|artbook|movies|videos|sound|audio|music|localization|lang|languages|fonts?|textures?|maps?|assets)$/i;

// Picks the most likely "main" executable inside a folder
async function findMainExe(dir, hint, maxDepth = 3) {
  const hintN = norm(hint);
  let best = null;
  let visited = 0;
  const queue = [[dir, 0]];
  while (queue.length && visited < 250) {
    const [d, depth] = queue.shift();
    visited++;
    let ents;
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_SUB_RE.test(e.name)) queue.push([path.join(d, e.name), depth + 1]);
        continue;
      }
      if (!/\.exe$/i.test(e.name)) continue;
      const stem = e.name.slice(0, -4);
      if (isJunkExe(stem)) continue;
      const full = path.join(d, e.name);
      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch {}
      let s = -depth * 8 + Math.min(20, size / (1024 * 1024) / 5);
      const sn = norm(stem);
      let match = false;
      if (hintN && sn) {
        match = true;
        if (sn === hintN) s += 50;
        else if (Math.min(sn.length, hintN.length) >= 4 && (sn.includes(hintN) || hintN.includes(sn))) s += 30;
        else if (commonPrefix(sn, hintN) >= 4) s += 12;
        else match = false;
      }
      if (/shipping/i.test(stem)) s += 4;
      if (/launcher/i.test(stem)) s += 3;
      if (/^start_protected_game$/i.test(stem)) s += 20;
      if (size < 150 * 1024) s -= 15;
      if (!best || s > best.s) best = { p: full, s, match, depth };
    }
  }
  // A random exe buried deep with an unrelated name is almost never the program itself
  if (!best || (!best.match && best.depth >= 2)) return null;
  return best.p;
}

const GAME_FILE_RE =
  /^(unityplayer\.dll|gameassembly\.dll|steam_api(64)?\.dll|steam_appid\.txt|eossdk-win(32|64)-shipping\.dll|galaxy(64)?\.dll|uplay_r[12].*\.dll|upc_r[12].*\.dll|data\.win|.*\.pck|bink2?w(32|64)\.dll|fmod(_event|studio)?(64|_vc)?\.dll|discord_game_sdk\.dll|physxloader\.dll|physx3.*\.dll|.*\.forge|.*\.rpf|.*\.vpk|.*\.bsa|.*\.ba2|.*\.tiger|.*\.toc|.*\.big|.*\.arc|.*\.wad|xinput1_3\.dll|amd_ags_x64\.dll|nvngx_dlss\.dll|libxess\.dll|sl\.interposer\.dll|ffx_fsr.*\.dll|start_protected_game\.exe)$/i;

const NON_GAME_BIG_RE = /\.(safetensors|ckpt|gguf|bin|onnx|pt|pth|iso|zip|7z|rar|mp4|mkv|vhdx?|db|sqlite|log)$/i;

async function looksLikeGame(dir) {
  if (!dir || isGenericDir(dir)) return false;
  let ents;
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const lower = new Set(ents.map((e) => e.name.toLowerCase()));
  for (const e of ents) {
    const n = e.name.toLowerCase();
    if (e.isFile()) {
      if (GAME_FILE_RE.test(n)) return true;
      if (!NON_GAME_BIG_RE.test(n)) {
        try {
          const st = await fsp.stat(path.join(dir, e.name));
          if (st.size > 1024 ** 3) return true;
        } catch {}
      }
    } else if (e.isDirectory()) {
      if (n.endsWith('_data') && lower.has(n.replace(/_data$/, '') + '.exe')) return true;
      if (n === 'engine') {
        for (const x of ents) {
          if (x.isDirectory() && x.name.toLowerCase() !== 'engine' && exists(path.join(dir, x.name, 'Binaries'))) return true;
        }
      }
    }
  }
  return false;
}

// "Marvels.Spider.Man.2.v2.810.0.0" -> "Marvels Spider Man 2"
function cleanFolderName(name) {
  let s = name.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  s = s.replace(/[._]+/g, ' ');
  s = s.replace(/[- ]+(gog|fitgirl|dodi|elamigos|repack|portable|codex|plaza|skidrow|rune|tenoke|empress|razor1911|flt|cpy|p2p).*$/i, '');
  s = s.replace(/\s+(v|ver|version|build)\s*\d[\d\s.]*.*$/i, '');
  s = s.replace(/\s+\d+(\s\d+){2,}\s*$/, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || name;
}

// Minimal Valve KeyValues (VDF/ACF) parser, keys lowercased
function parseVdf(text) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[2]) tokens.push(m[2]);
    else tokens.push({ s: m[1].replace(/\\(.)/g, '$1') });
  }
  let i = 0;
  function obj() {
    const o = {};
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === '}') return o;
      if (t === '{') continue;
      const key = t.s.toLowerCase();
      const v = tokens[i++];
      if (v === undefined) return o;
      if (v === '{') o[key] = obj();
      else if (v !== '}') o[key] = v.s;
      else return o;
    }
    return o;
  }
  return obj();
}

const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v.filter((x) => x != null) : [v]);

module.exports = {
  norm,
  normPath,
  isInside,
  exists,
  sim,
  isGenericDir,
  isJunkExe,
  findMainExe,
  looksLikeGame,
  cleanFolderName,
  parseVdf,
  toArr,
};
