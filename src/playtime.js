// Playtime and "last launched" for things started outside Shelf.
// Called once a minute with the running processes; works no matter how a game was started
// (Shelf, a launcher, a desktop shortcut).
function createPlaytime(rules) {
  let playing = new Set();
  let appsKnown = null; // app ids checked on the last tick (null = no tick yet)
  let appsOpen = new Set();

  // items: library entries as the window sees them (category, hidden, leftover)
  // procs: { all, windowed } lower-case exe paths of running processes
  // -> played: games that ran this minute; started: apps whose window appeared since the last tick;
  //    changed: the set of running games is different from the last tick
  function tick(items, procs) {
    const active = items.filter((i) => !i.leftover && !i.hidden);
    const now = new Set();
    for (const g of active.filter((i) => i.category === 'game')) {
      const dir = rules.watchDir(g);
      if (dir && procs.all.some((e) => e.startsWith(dir))) now.add(g.id);
    }
    const changed = now.size !== playing.size || [...now].some((id) => !playing.has(id));
    playing = now;

    // Apps: windowless helpers (updaters, tray daemons) are ignored. The first tick is only a baseline.
    const known = new Set(active.filter((i) => i.category === 'app' && !rules.isSelf(i) && rules.runningMatch(i)).map((i) => i.id));
    const open = new Set([...rules.owners(items, procs.windowed)].filter((id) => known.has(id)));
    const started = appsKnown ? [...open].filter((id) => appsKnown.has(id) && !appsOpen.has(id)) : [];
    appsKnown = known;
    appsOpen = open;

    return { played: [...now], started, changed };
  }

  return { tick, isPlaying: (id) => playing.has(id) };
}

module.exports = { createPlaytime };
