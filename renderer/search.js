// Quick search ranking. Used by the quick launcher window (as a script) and by the tests (as a module).
(function (root) {
  const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');

  // Higher = better. Prefix > word start > initials > substring. -1 = no match.
  function score(it, q) {
    const n = fold(it.name);
    const words = n.split(/[^a-z0-9ąćęńóśźż]+/).filter(Boolean);
    const initials = words.map((w) => w[0]).join('');
    let s;
    if (n.startsWith(q)) s = 100;
    else if (words.some((w) => w.startsWith(q))) s = 80;
    else if (q.length >= 2 && initials.startsWith(q)) s = 65;
    else if (n.includes(q)) s = 45;
    else if (q.split(/\s+/).every((t) => n.includes(t))) s = 35;
    else return -1;
    if (it.fav) s += 10;
    if (it.lastLaunch) s += Math.max(0, 8 - (Date.now() - it.lastLaunch) / 864e5);
    if (!it.canLaunch) s -= 25;
    if (it.shelf) s += 5; // a shelf named like the query comes first
    return s - n.length / 100;
  }

  // The best 8 entries (items and shelf rows, { shelf: true }) for what was typed
  function search(entries, query) {
    const q = fold(String(query || '').trim());
    if (!q) return [];
    return entries
      .map((it) => [it, score(it, q)])
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([it]) => it);
  }

  const api = { search, fold };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Search = api;
})(this);
