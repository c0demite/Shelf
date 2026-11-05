// Text for "Copy diagnostic info" (Settings), pasted into bug reports on GitHub.
// Only counts and settings: no program names or paths, so it is safe to post publicly.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad = (n) => String(n).padStart(2, '0');
const utc = (ts) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

// Windows 11 still reports itself as 10.0; builds from 22000 on are 11
const windowsName = (release) => (+String(release).split('.')[2] >= 22000 ? '11' : '10');

// info: version, packaged, os { release, arch }, lang, theme,
// gpu (true / false / null = not known yet), plainSetting, displays [{ width, height, scaleFactor }],
// items (as the window sees them: category, source, hidden, leftover), lastScan
function diagnosticsReport(info) {
  const gpuText = info.gpu == null ? 'not known yet' : info.gpu ? 'on' : 'off';
  const quick = info.plainSetting ? 'simple, turned on in settings' : info.gpu === false ? 'simple, no GPU compositing' : 'see-through';

  const live = info.items.filter((i) => !i.leftover);
  const games = live.filter((i) => i.category === 'game').length;
  const leftovers = info.items.length - live.length;
  const sources = {};
  for (const i of info.items) sources[i.source || 'unknown'] = (sources[i.source || 'unknown'] || 0) + 1;

  return [
    `Shelf ${info.version} (${info.packaged ? 'installed' : 'from source'})`,
    `Windows: ${windowsName(info.os.release)} (${info.os.release}) ${info.os.arch}`,
    `Language: ${info.lang}, theme: ${info.theme}`,
    `Quick search window: ${quick} (GPU compositing: ${gpuText})`,
    `Screens: ${info.displays.length} – ${info.displays.map((d) => `${d.width}×${d.height} at ${Math.round(d.scaleFactor * 100)}%`).join(', ')}`,
    `Library: ${plural(games, 'game')}, ${plural(live.length - games, 'app')}, ${live.filter((i) => i.hidden).length} hidden, ${plural(leftovers, 'leftover')}`,
    `Sources: ${Object.entries(sources).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}`,
    `Last scan: ${info.lastScan ? utc(info.lastScan) : 'never'}`,
  ].join('\n');
}

module.exports = { diagnosticsReport };
