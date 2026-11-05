// "Add by hand": what would Shelf add for a file the user picked?
// An .exe, a shortcut (.lnk) or an internet shortcut (.url, e.g. steam://), plus .bat/.cmd.
const fs = require('fs');
const path = require('path');
const { psJson, psQuote } = require('./ps');

const ADD_EXT = /\.(exe|lnk|url|bat|cmd)$/i;

const prettyName = (file) =>
  path
    .basename(file, path.extname(file))
    .replace(/[_.]+/g, ' ')
    .replace(/(-|\s)(x64|x86|win64|win32|shipping)$/i, '')
    .trim();

// File description and product name of an exe: { d, p }
const exeVersionInfo = (exe) =>
  psJson(`$v=(Get-Item -LiteralPath ${psQuote(exe)}).VersionInfo; @{p=$v.ProductName;d=$v.FileDescription} | ConvertTo-Json -Compress`);

// readShortcut(lnk) -> target path or null; versionInfo(exe) -> { d, p } or null
// The returned function resolves to { path, name, category, uri?, iconPath?, dir? } or null if the file can't be added.
function createInspector({ readShortcut = () => null, versionInfo = exeVersionInfo } = {}) {
  return async function inspectFile(file) {
    if (typeof file !== 'string' || !ADD_EXT.test(file) || !fs.existsSync(file)) return null;
    file = path.normalize(file);
    const ext = path.extname(file).toLowerCase();
    const info = { path: file, name: prettyName(file), category: 'app' };
    let target = file;
    if (ext === '.lnk') {
      target = readShortcut(file) || file;
    } else if (ext === '.url') {
      const txt = fs.readFileSync(file, 'utf8');
      info.uri = (txt.match(/^URL=(.+)$/m) || [])[1]?.trim() || null;
      if (!info.uri) return null;
      const ico = (txt.match(/^IconFile=(.+)$/m) || [])[1]?.trim();
      if (ico && fs.existsSync(ico)) info.iconPath = ico;
      if (/^(steam|com\.epicgames\.launcher|uplay|goggalaxy|heroic|battlenet):/i.test(info.uri)) info.category = 'game';
    }
    if (/\.exe$/i.test(target) && fs.existsSync(target)) {
      const v = await versionInfo(target);
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
  };
}

module.exports = { createInspector };
