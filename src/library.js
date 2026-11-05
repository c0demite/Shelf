// The library: what the scan found plus everything the user changed (state.overrides) and added by hand.
// The window only ever sees view(item): the two merged.
const path = require('path').win32;
const { norm } = require('./util');
const { GENERIC_NAMES } = require('./covers');

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// state(): the saved state object (items, overrides, covers, headers, shelves, manual) – read on every call,
// because loading replaces it. isPlaying(id): a game is running right now.
// Changes are made in place; saving and telling the windows is up to the caller.
function createLibrary({ state, isPlaying = () => false }) {
  const ovOf = (id) => (state().overrides[id] ||= {});
  const find = (id) => state().items.find((i) => i.id === id);

  function view(it) {
    const s = state();
    const ov = s.overrides[it.id] || {};
    const c = s.covers[norm(it.name)];
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
      playing: isPlaying(it.id),
      shelves: (ov.shelves || []).filter((x) => (s.shelves || []).some((sh) => sh.id === x)),
      lastLaunch: Math.max(ov.lastLaunch || 0, it.lastPlayed || 0) || null,
      coverAppId: cover || null,
      coverHeader: (cover && s.headers[cover]) || null,
      coverFile: ov.coverFile ? 'shelf://cover/' + encodeURIComponent(ov.coverFile) : null,
      customCover: !!(ov.coverFile || ov.coverAppId),
    };
  }

  // Scan results plus the hand-added items the scan didn't find itself
  function withManual(list) {
    const manual = (state().manual || []).filter((m) => !list.some((i) => i.id === m.id || (m.exe && samePath(i.exe, m.exe))));
    return [...list, ...manual];
  }

  return {
    find,
    view,
    views: () => state().items.map(view),
    replaceScan(items) {
      state().items = withManual(items);
    },
    // ids: items to drop from the list (e.g. cleaned-up leftovers)
    remove(ids) {
      state().items = state().items.filter((i) => !ids.has(i.id));
    },

    // started from Shelf
    launched(id) {
      const ov = ovOf(id);
      ov.lastLaunch = Date.now();
      ov.launches = (ov.launches || 0) + 1;
    },
    // games that ran for another minute
    played(ids) {
      for (const id of ids) {
        const ov = ovOf(id);
        ov.played = (ov.played || 0) + 1;
        ov.lastLaunch = Date.now();
      }
    },
    // apps the user opened some other way: Recent, but not a launch
    opened(ids) {
      for (const id of ids) ovOf(id).lastLaunch = Date.now();
    },

    // fav, hidden, category, shelves... A category equal to the scan's is no override. -> the new view, or null
    override(id, patch) {
      const it = find(id);
      if (!it) return null;
      const ov = (state().overrides[id] = { ...(state().overrides[id] || {}), ...patch });
      if (ov.category === it.category) delete ov.category;
      return view(it);
    },
    // the whole list of custom shelves, [{ id, name }] -> what was kept
    saveShelves(list) {
      state().shelves = (Array.isArray(list) ? list : [])
        .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string')
        .map((s) => ({ id: s.id.slice(0, 40), name: s.name.trim().slice(0, 60) }))
        .filter((s) => s.name);
      return state().shelves;
    },
    // patch: {} (back to automatic), { coverAppId } or { coverFile } -> { view, unusedFile: a picture no longer used }
    setCover(id, patch) {
      const it = find(id);
      if (!it) return null;
      const ov = ovOf(id);
      const unusedFile = ov.coverFile && patch.coverFile !== ov.coverFile ? ov.coverFile : null;
      delete ov.coverFile;
      delete ov.coverAppId;
      Object.assign(ov, patch);
      return { view: view(it), unusedFile };
    },

    // item: a ready "manual:" entry. An exe already on the shelf is only made visible again.
    // -> { item: view } or { exists: true, item: view of the one already there }
    addManual(item) {
      const dup = item.exe && state().items.find((i) => samePath(i.exe, item.exe) && !i.leftover);
      if (dup) {
        const ov = ovOf(dup.id);
        if (ov.hidden || dup.autoHidden) ov.hidden = false;
        return { exists: true, item: view(dup) };
      }
      state().manual = [...(state().manual || []).filter((m) => m.id !== item.id), item];
      state().items = withManual(state().items.filter((i) => i.id !== item.id));
      return { item: view(item) };
    },
    // only hand-added items can be removed -> { removed, unusedFile }
    removeManual(id) {
      if (!String(id).startsWith('manual:')) return { removed: false };
      const s = state();
      s.manual = (s.manual || []).filter((m) => m.id !== id);
      s.items = s.items.filter((i) => i.id !== id);
      const unusedFile = s.overrides[id]?.coverFile || null;
      delete s.overrides[id];
      return { removed: true, unusedFile };
    },
  };
}

module.exports = { createLibrary };
