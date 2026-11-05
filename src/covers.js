// Cover art from the Steam store, also for games that aren't from Steam.
const { norm } = require('./util');

// Names too generic to look up ("Launcher", "Game")
const GENERIC_NAMES = new Set(['launcher', 'game', 'games', 'client', 'app', 'start', 'play', 'setup', 'main', 'bin', 'gierka', 'gra']);
const MISS_RETRY = 7 * 864e5; // misses are retried after a week (new releases, better matching)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The store search result that is this game, or null.
// Same name, or a store title that starts/ends with it ("Satisfactory Demo", "Marvel's Spider-Man 2").
function storeMatch(name, hits) {
  const key = norm(name);
  return (
    (hits || []).find((x) => {
      const n = norm(x.name);
      if (n === key) return true;
      const [a, b] = n.length < key.length ? [n, key] : [key, n];
      if (a.length < 6) return false;
      return (b.startsWith(a) && a.length / b.length >= 0.75) || (b.endsWith(a) && a.length / b.length >= 0.55);
    }) || null
  );
}

// covers: { [norm(name)]: appId | { miss: time } } – the cache kept in the state file
function needsCover(covers, name) {
  const key = norm(name);
  if (key.length < 4 || GENERIC_NAMES.has(key)) return false;
  const c = covers[key];
  return c == null || (typeof c === 'object' && Date.now() - (c.miss || 0) > MISS_RETRY);
}

async function storeSearch(q) {
  const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=US`, {
    signal: AbortSignal.timeout(8000),
  });
  return (await r.json()).items || [];
}

// Fills the covers and headers caches (both are changed in place).
// games(): the current games, each { name, steamAppId, coverAppId } – asked again after the first pass,
// because new covers give new app ids. onChange(count) is called as covers come in.
async function updateCovers({ games, covers, headers, onChange }) {
  let changed = 0;
  for (const it of games().filter((g) => !g.steamAppId && !g.leftover && needsCover(covers, g.name))) {
    try {
      const hit = storeMatch(it.name, await storeSearch(it.name));
      covers[norm(it.name)] = hit ? String(hit.id) : { miss: Date.now() };
      if (hit) changed++;
    } catch {
      // offline – try again next time
    }
    if (changed && changed % 5 === 0) onChange(changed);
    await wait(200);
  }

  // Real header image URL (newer games use hashed paths the CDN pattern can't guess)
  const ids = [...new Set(games().filter((g) => g.coverAppId).map((g) => g.coverAppId))];
  for (const id of ids.filter((id) => !(id in headers))) {
    try {
      const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      headers[id] = j?.[id]?.data?.header_image || null;
      if (headers[id]) changed++;
    } catch {}
    await wait(200);
  }
  return changed;
}

module.exports = { storeMatch, updateCovers, storeSearch, GENERIC_NAMES };
