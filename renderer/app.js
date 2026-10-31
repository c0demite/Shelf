'use strict';

const $ = (s) => document.querySelector(s);
const api = window.hub;
const { t } = I18N;

const SOURCES = {
  steam: { label: () => 'Steam', color: '#4c8bf5' },
  epic: { label: () => 'Epic Games', color: '#d0d4dc' },
  gog: { label: () => 'GOG', color: '#a35dd6' },
  ubisoft: { label: () => 'Ubisoft', color: '#2f7bff' },
  xbox: { label: () => 'Xbox', color: '#3cb043' },
  store: { label: () => 'Microsoft Store', color: '#00a4ef' },
  registry: { label: () => t('src.registry'), color: '#8a92a6' },
  shortcut: { label: () => t('src.shortcut'), color: '#e8a33d' },
  folder: { label: () => t('src.folder'), color: '#2fb6a3' },
};
const srcLabel = (s) => (SOURCES[s] ? SOURCES[s].label() : '');

let items = [];
let scanning = false;
let scanText = null; // [key, ...args] from the main process
let lastScan = null;
let hotkey = null;
const view = { cat: 'all', source: null, q: '', sort: 'name', mode: 'grid' };
try {
  const saved = JSON.parse(localStorage.getItem('view') || '{}');
  // always start on tiles + "All"; only the sort order is remembered
  if (saved.sort) view.sort = saved.sort;
} catch {}
const persist = () => {
  try {
    localStorage.setItem('view', JSON.stringify({ sort: view.sort }));
  } catch {}
};

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fold = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l');

function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return (b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i];
}
function fmtAgo(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return t('ago.now');
  if (d < 3600) return t('ago.min', Math.floor(d / 60));
  if (d < 86400) return t('ago.h', Math.floor(d / 3600));
  const days = Math.floor(d / 86400);
  if (days === 1) return t('ago.yesterday');
  if (days < 30) return t('ago.days', days);
  if (days < 365) return t('ago.months', Math.floor(days / 30));
  return t('ago.years', Math.floor(days / 365));
}
const fmtPlay = (m) => (!m ? '' : m < 60 ? t('play.min', m) : t('play.h', Math.round(m / 60)));
const typeLabel = (it) => t(it.category === 'game' ? 'type.game' : 'type.app');

function hue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
const letterHtml = (it, big) =>
  `<div class="letter${big ? ' big-letter' : ''}" style="background:linear-gradient(135deg,hsl(${hue(it.name)} 40% 48%),hsl(${(hue(it.name) + 40) % 360} 45% 34%))">${esc(
    (it.name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase()
  )}</div>`;
const iconSlot = (it, cls = '') => `<img class="${cls}" data-icon="${esc(it.id)}" alt="" hidden>${letterHtml(it)}`;

const headers = {};
function coverUrls(id) {
  return [
    `https://shared.steamstatic.com/store_item_assets/steam/apps/${id}/library_600x900.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`,
    headerUrl(id),
  ];
}
const headerUrl = (id) => headers[id] || `https://shared.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`;
// newer Steam games keep art under hashed URLs – main process looks those up
const remember = (list) => list.forEach((i) => i.coverAppId && i.coverHeader && (headers[i.coverAppId] = i.coverHeader));

// ---------- static text ----------
function applyI18n() {
  document.documentElement.lang = I18N.getLang();
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  $('#lang').innerHTML = I18N.LANGS.map(
    ([code, name]) => `<button data-lang="${code}" class="${I18N.getLang() === code ? 'active' : ''}">${name}</button>`
  ).join('');
  renderHotkey();
  setScanning(scanning);
}

// ---------- filtering ----------
function matches(it) {
  if (view.cat === 'leftover') {
    if (!it.leftover) return false;
  } else if (view.cat === 'hidden') {
    if (!it.hidden || it.leftover) return false;
  } else {
    if (it.hidden) return false;
    if (view.cat === 'game' && it.category !== 'game') return false;
    if (view.cat === 'app' && it.category !== 'app') return false;
    if (view.cat === 'fav' && !it.fav) return false;
    if (view.cat === 'recent' && !it.lastLaunch) return false;
  }
  if (view.source && it.source !== view.source) return false;
  if (view.q) {
    const hay = fold(it.name + ' ' + (it.publisher || '') + ' ' + srcLabel(it.source));
    if (!view.q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

function sorted(list) {
  const byName = (a, b) => a.name.localeCompare(b.name, I18N.getLang(), { sensitivity: 'base' });
  const s = view.cat === 'recent' ? 'recent' : view.sort;
  const fns = {
    name: byName,
    recent: (a, b) => (b.lastLaunch || 0) - (a.lastLaunch || 0) || byName(a, b),
    size: (a, b) => (b.size || 0) - (a.size || 0) || byName(a, b),
    installed: (a, b) => (b.installDate || 0) - (a.installDate || 0) || byName(a, b),
  };
  return [...list].sort(fns[s] || byName);
}

// ---------- rendering ----------
function subLine(it) {
  if (it.leftover) return t(it.missingDir ? 'left.missing' : 'left.empty');
  if (view.sort === 'size' && it.size) return fmtSize(it.size);
  if ((view.sort === 'recent' || view.cat === 'recent') && it.lastLaunch) return fmtAgo(it.lastLaunch);
  if (it.playtime) return fmtPlay(it.playtime);
  return srcLabel(it.source);
}

const PLAY = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#fff" d="M8 5v14l11-7z"/></svg>';

function gameCard(it) {
  const cover = it.coverAppId
    ? `<img class="cover" data-cover="${esc(it.coverAppId)}" data-step="0" src="${coverUrls(it.coverAppId)[0]}" alt="">`
    : '';
  const badge = it.leftover
    ? `<span class="badge warn">${esc(t('badge.leftover'))}</span>`
    : !['steam', 'registry', 'folder', 'shortcut'].includes(it.source)
    ? `<span class="badge">${esc(srcLabel(it.source))}</span>`
    : '';
  return `<div class="card${it.canLaunch ? '' : ' nolaunch'}" tabindex="0" data-id="${esc(it.id)}" title="${esc(it.name)}">
    <div class="art">
      <div class="fallback"><img class="big-ico" data-icon="${esc(it.id)}" alt="" hidden>${letterHtml(it, true)}<div class="fb-name">${esc(it.name)}</div></div>
      ${cover}
      <div class="shade"></div>
      ${badge}
      <button class="star${it.fav ? ' on' : ''}" data-star title="${esc(t('tab.fav'))}">★</button>
      <div class="play">${PLAY}</div>
    </div>
    <div class="title">${esc(it.name)}</div>
    <div class="sub">${esc(subLine(it))}</div>
  </div>`;
}

function appTile(it) {
  return `<div class="tile${it.canLaunch ? '' : ' nolaunch'}" tabindex="0" data-id="${esc(it.id)}" title="${esc(it.name)}${it.publisher ? '\n' + esc(it.publisher) : ''}">
    <div class="ico-wrap">${iconSlot(it)}</div>
    <div class="txt"><div class="t-name">${esc(it.name)}</div><div class="t-sub">${esc(subLine(it))}</div></div>
    <button class="star${it.fav ? ' on' : ''}" data-star title="${esc(t('tab.fav'))}">★</button>
  </div>`;
}

const grid = (list, kind) => (list.length ? `<div class="grid ${kind} sub-grid">${list.map(kind === 'games' ? gameCard : appTile).join('')}</div>` : '');

function section(title, list, kind, opts = {}) {
  if (!list.length) return '';
  const shown = opts.limit ? list.slice(0, opts.limit) : list;
  const more = opts.limit && list.length > opts.limit ? `<button class="more" data-goto="${kind === 'games' ? 'game' : 'app'}">${esc(t('more'))} →</button>` : '';
  const body = kind === 'mixed' ? grid(shown.filter((i) => i.category === 'game'), 'games') + grid(shown.filter((i) => i.category !== 'game'), 'apps') : grid(shown, kind);
  return `<div class="section"><div class="section-head"><h2>${esc(title)}</h2><span class="n">${list.length}</span>${opts.sub ? `<small>${esc(opts.sub)}</small>` : ''}${more}</div>${body}</div>`;
}

function recentCard(it) {
  const img = it.coverAppId;
  const sub = `${fmtAgo(it.lastLaunch)} · ${typeLabel(it).toLowerCase()}`;
  return `<div class="rc${img ? ' img' : ''}" tabindex="0" data-id="${esc(it.id)}">
    ${img ? `<img class="bgimg" data-header src="${headerUrl(img)}" alt="">` : `<div class="halo"><img data-icon="${esc(it.id)}" alt="" hidden></div><div class="big">${iconSlot(it)}</div>`}
    <div class="meta">${img ? `<div class="ico-wrap">${iconSlot(it)}</div>` : ''}<div><div class="nm">${esc(it.name)}</div><div class="sb">${esc(sub)}</div></div></div>
    ${it.canLaunch ? `<div class="play">${PLAY}</div>` : ''}
  </div>`;
}

function greeting() {
  const h = new Date().getHours();
  return t(h < 5 ? 'greet.night' : h < 12 ? 'greet.morning' : h < 18 ? 'greet.afternoon' : 'greet.evening');
}

function renderHello(vis) {
  const home = view.cat === 'all' && !view.q && view.mode === 'grid' && items.length;
  if (!home) return ($('#hello').innerHTML = '');
  const g = vis.filter((i) => i.category === 'game').length;
  $('#hello').innerHTML = `<h1>${esc(greeting())}<i>.</i></h1><p>${esc(t('shelf.count', g, vis.length - g))}</p>`;
}

function listView(list) {
  const rows = list
    .map(
      (it) => `<tr class="row" data-id="${esc(it.id)}">
      <td><div class="nm">${iconSlot(it)}<span>${it.fav ? '<span style="color:var(--star)">★</span> ' : ''}${esc(it.name)}</span></div></td>
      <td><span class="chip ${it.category}">${esc(typeLabel(it))}</span></td>
      <td>${esc(srcLabel(it.source))}</td>
      <td class="num">${fmtSize(it.size)}</td>
      <td class="num">${fmtAgo(it.lastLaunch)}</td>
      <td class="path" title="${esc(it.installDir || it.exe || it.missingDir || '')}">${esc(it.installDir || it.exe || it.missingDir || '')}</td>
    </tr>`
    )
    .join('');
  return `<table class="list"><thead><tr><th>${t('col.name')}</th><th>${t('col.type')}</th><th>${t('col.source')}</th><th style="text-align:right">${t('col.size')}</th><th style="text-align:right">${t('col.launched')}</th><th>${t('col.path')}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const catTitle = (c) => t('tab.' + c);

function render() {
  const content = $('#content');
  const vis = items.filter((i) => !i.hidden);
  const list = sorted(items.filter(matches));
  renderHello(vis);

  if (!items.length) {
    content.innerHTML = scanning
      ? `<div class="empty"><div class="loader"></div><h3>${esc(t('empty.scanning'))}</h3><div class="hint">${esc(t('empty.scanningHint'))}</div></div>`
      : `<div class="empty"><div class="big">∅</div><h3>${esc(t('empty.none'))}</h3><div class="hint">${esc(t('empty.noneHint'))}</div></div>`;
    renderCounts();
    return;
  }

  if (!list.length) {
    const msg =
      view.cat === 'fav'
        ? t('empty.fav')
        : view.cat === 'leftover'
        ? t('empty.leftover')
        : view.q
        ? t('empty.query', $('#search').value.trim())
        : t('empty.view');
    content.innerHTML = `<div class="empty"><div class="big">∅</div><h3>${esc(catTitle(view.cat))}</h3><div class="hint">${esc(msg)}</div></div>`;
    renderCounts();
    return;
  }

  let html = '';
  if (view.mode === 'list') {
    html = listView(list);
  } else if (view.cat === 'all' && !view.q) {
    const recent = list.filter((i) => i.lastLaunch).sort((a, b) => b.lastLaunch - a.lastLaunch).slice(0, 3);
    const favs = list.filter((i) => i.fav);
    html =
      (recent.length
        ? `<div class="section"><div class="section-head"><h2>${esc(t('sec.recent'))}</h2><small>${esc(t('sec.recentSub'))}</small></div><div class="recent">${recent.map(recentCard).join('')}</div></div>`
        : '') +
      section(t('sec.fav'), favs, 'mixed') +
      section(t('sec.games'), list.filter((i) => i.category === 'game' && !i.fav), 'games') +
      section(t('sec.apps'), list.filter((i) => i.category === 'app' && !i.fav), 'apps');
  } else if (view.cat === 'game') {
    html = section(t('sec.games'), list, 'games');
  } else if (view.cat === 'app') {
    html = section(t('sec.apps'), list, 'apps');
  } else {
    const games = list.filter((i) => i.category === 'game');
    const apps = list.filter((i) => i.category === 'app');
    const tGames = view.cat === 'all' ? t('sec.games') : t('sec.ofGames', catTitle(view.cat));
    const tApps = view.cat === 'all' ? t('sec.apps') : t('sec.ofApps', catTitle(view.cat));
    html = section(tGames, games, 'games') + section(tApps, apps, 'apps');
  }
  content.innerHTML = html;
  renderCounts();
  observeIcons();
}

function renderCounts() {
  const vis = items.filter((i) => !i.hidden);
  const c = {
    all: vis.length,
    game: vis.filter((i) => i.category === 'game').length,
    app: vis.filter((i) => i.category === 'app').length,
    fav: vis.filter((i) => i.fav).length,
    recent: vis.filter((i) => i.lastLaunch).length,
    hidden: items.filter((i) => i.hidden && !i.leftover).length,
    leftover: items.filter((i) => i.leftover).length,
  };
  document.querySelectorAll('[data-count]').forEach((el) => (el.textContent = c[el.dataset.count] || ''));
  document.querySelectorAll('#tabs button, #views button').forEach((b) => b.classList.toggle('active', b.dataset.cat === view.cat));
  // leftovers / hidden only show up when there is something in them
  document.querySelectorAll('#views button').forEach((b) => (b.hidden = !c[b.dataset.cat] && view.cat !== b.dataset.cat));

  const per = {};
  for (const it of vis) per[it.source] = (per[it.source] || 0) + 1;
  ddSource.set(
    [{ value: '', label: t('src.all'), count: vis.length }].concat(
      Object.keys(SOURCES)
        .filter((k) => per[k])
        .map((k) => ({ value: k, label: srcLabel(k), count: per[k], color: SOURCES[k].color }))
    ),
    view.source || ''
  );
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === view.mode));
  ddSort.set(['name', 'recent', 'size', 'installed'].map((v) => ({ value: v, label: t('sort.' + v) })), view.sort);
}

// ---------- icons (lazy) ----------
const iconCache = new Map();
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      e.target.querySelectorAll('img[data-icon]').forEach(loadIcon);
    }
  },
  { root: $('#scroll'), rootMargin: '300px' }
);
function observeIcons() {
  document.querySelectorAll('img[data-icon]').forEach((img) => {
    const id = img.dataset.icon;
    if (iconCache.has(id) && !(iconCache.get(id) instanceof Promise)) applyIcon(img, iconCache.get(id));
    else io.observe(img.closest('[data-id]') || img.parentElement); // hidden <img> has no box, so watch its card
  });
}
async function loadIcon(img) {
  const id = img.dataset.icon;
  let p = iconCache.get(id);
  if (p === undefined) {
    p = api.icon(id).catch(() => null);
    iconCache.set(id, p);
    iconCache.set(id, await p);
  }
  applyIcon(img, await p);
}
function applyIcon(img, url) {
  if (!url) return;
  img.src = url;
  img.hidden = false;
  const letter = img.nextElementSibling;
  if (letter && letter.classList.contains('letter')) letter.remove();
}

// cover fallback chain
document.addEventListener(
  'load',
  (e) => {
    if (e.target.matches?.('img.cover')) e.target.classList.add('loaded');
  },
  true
);
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img.matches?.('img[data-header]')) {
      // no header art – fall back to the plain icon card
      const card = img.closest('.rc');
      const it = card && byId(card.dataset.id);
      if (it) {
        card.outerHTML = recentCard({ ...it, coverAppId: null });
        observeIcons();
      }
      return;
    }
    if (!img.matches?.('img.cover')) return;
    const step = +img.dataset.step + 1;
    const urls = coverUrls(img.dataset.cover);
    if (step < urls.length) {
      img.dataset.step = step;
      if (step === urls.length - 1) {
        // landscape header: show it whole over a blurred copy of itself
        img.classList.add('wide');
        img.closest('.art')?.style.setProperty('--wide-bg', `url("${urls[step]}")`);
        img.closest('.art')?.classList.add('wide');
      }
      img.src = urls[step];
    } else img.remove();
  },
  true
);

// ---------- actions ----------
const byId = (id) => items.find((i) => i.id === id);
function replace(updated) {
  const i = items.findIndex((x) => x.id === updated.id);
  if (i >= 0) items[i] = updated;
}

let toastTimer;
function toast(msg, err) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (err ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

async function launch(id) {
  const it = byId(id);
  if (!it) return;
  if (!it.canLaunch) return toast(t('toast.noFile'), true);
  toast(t('toast.launching', it.name));
  const r = await api.launch(id);
  if (!r.ok) toast(t('toast.failed', r.error), true);
  else if (r.item) {
    replace(r.item);
    render();
  }
}

async function setOv(id, patch, msg) {
  const updated = await api.setOverride(id, patch);
  if (updated) replace(updated);
  render();
  if (msg) toast(msg);
}

// ---------- context menu ----------
const menu = $('#menu');
function openMenu(id, x, y) {
  const it = byId(id);
  if (!it) return;
  const isGame = it.category === 'game';
  const btn = (act, ico, label, opts = '') => `<button data-act="${act}" ${opts}><span class="m-ico">${ico}</span>${esc(label)}</button>`;
  menu.innerHTML = `<div class="m-head">${esc(it.name)}${it.note ? ' · ' + esc(t(it.note)) : ''}</div>
    ${btn('launch', '▶', t('menu.launch'), it.canLaunch ? '' : 'disabled')}
    ${btn('fav', '★', t(it.fav ? 'menu.favOff' : 'menu.favOn'))}
    ${btn('cat', isGame ? '▣' : '◆', t(isGame ? 'menu.toApp' : 'menu.toGame'))}
    <div class="sep"></div>
    ${btn('folder', '⌂', t('menu.folder'), it.installDir || it.exe ? '' : 'disabled')}
    ${btn('hide', '◌', t(it.hidden ? 'menu.unhide' : 'menu.hide'))}
    ${it.uninstall || it.source === 'steam' ? `<div class="sep"></div>${btn('uninstall', '✕', t('menu.uninstall'), 'class="danger"')}` : ''}`;
  menu.dataset.id = id;
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
const closeMenu = () => (menu.hidden = true);

menu.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const id = menu.dataset.id;
  const it = byId(id);
  closeMenu();
  switch (b.dataset.act) {
    case 'launch':
      return launch(id);
    case 'fav':
      return setOv(id, { fav: !it.fav }, t(it.fav ? 'toast.favOff' : 'toast.favOn'));
    case 'cat': {
      const c = it.category === 'game' ? 'app' : 'game';
      return setOv(id, { category: c }, t('toast.cat', it.name, c));
    }
    case 'folder':
      if (!(await api.openFolder(id))) toast(t('toast.noFolder'), true);
      return;
    case 'hide':
      return setOv(id, { hidden: !it.hidden }, t(it.hidden ? 'toast.unhidden' : 'toast.hidden'));
    case 'uninstall':
      await api.uninstall(id);
      return toast(t(it.source === 'steam' ? 'toast.steam' : 'toast.settings'));
  }
});

// ---------- dropdowns ----------
// Our own dropdown: the native <select> popup can't be styled on Windows
const openDDs = new Set();
function dropdown(root, onChange) {
  let opts = [];
  let value = null;
  let hi = 0;
  root.innerHTML = '<button class="dd-btn" type="button"><span class="dd-val"></span><svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button><div class="dd-menu" role="listbox" hidden></div>';
  const btn = root.querySelector('.dd-btn');
  const list = root.querySelector('.dd-menu');
  const row = (o, i) =>
    `<div class="dd-opt${o.value === value ? ' on' : ''}${i === hi ? ' hi' : ''}" data-i="${i}" role="option">
      ${o.color ? `<span class="dd-dot" style="background:${o.color}"></span>` : ''}
      <span class="dd-lbl">${esc(o.label)}</span>
      ${o.count != null ? `<span class="dd-n">${o.count}</span>` : ''}
      <svg class="dd-check" width="14" height="14" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>`;
  const draw = () => (list.innerHTML = opts.map(row).join(''));
  const close = () => {
    list.hidden = true;
    root.classList.remove('open');
    openDDs.delete(api);
  };
  const open = () => {
    openDDs.forEach((d) => d.close());
    hi = Math.max(0, opts.findIndex((o) => o.value === value));
    draw();
    list.hidden = false;
    root.classList.add('open');
    openDDs.add(api);
  };
  const pick = (i) => {
    const o = opts[i];
    close();
    btn.focus();
    if (o && o.value !== value) onChange(o.value);
  };
  btn.addEventListener('click', () => (list.hidden ? open() : close()));
  list.addEventListener('mousemove', (e) => {
    const r = e.target.closest('.dd-opt');
    if (r && +r.dataset.i !== hi) {
      hi = +r.dataset.i;
      list.querySelectorAll('.dd-opt').forEach((x) => x.classList.toggle('hi', +x.dataset.i === hi));
    }
  });
  list.addEventListener('click', (e) => {
    const r = e.target.closest('.dd-opt');
    if (r) pick(+r.dataset.i);
  });
  root.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        open();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      draw();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(hi);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.stopPropagation();
      close();
    }
  });
  const api = {
    root,
    close,
    set(o, v) {
      opts = o;
      value = v;
      const cur = opts.find((x) => x.value === v) || opts[0];
      btn.querySelector('.dd-val').textContent = cur ? cur.label : '';
      root.classList.toggle('set', !!v && v !== opts[0]?.value);
      if (!list.hidden) draw();
    },
  };
  return api;
}
const ddSource = dropdown($('#source'), (v) => {
  view.source = v || null;
  render();
});
const ddSort = dropdown($('#sort'), (v) => {
  view.sort = v;
  persist();
  render();
});
document.addEventListener('mousedown', (e) => openDDs.forEach((d) => !d.root.contains(e.target) && d.close()));

// ---------- settings popover ----------
const pop = $('#settings');
const togglePop = (show = pop.hidden) => {
  pop.hidden = !show;
  $('#setBtn').classList.toggle('on', show);
};
$('#setBtn').addEventListener('click', () => togglePop());
$('#lang').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-lang]');
  if (b) await api.setLang(b.dataset.lang); // main broadcasts lang:changed
});

function renderHotkey() {
  $('#hotkeyHint').innerHTML = hotkey
    ? esc(t('set.hotkey', '\u0000')).replace('\u0000', I18N.keyLabel(hotkey).split('+').map((k) => `<kbd>${esc(k)}</kbd>`).join('+'))
    : esc(t('set.hotkeyTaken'));
}

// ---------- events ----------
const content = $('#content');
content.addEventListener('click', (e) => {
  const more = e.target.closest('[data-goto]');
  if (more) return setCat(more.dataset.goto);
  const el = e.target.closest('[data-id]');
  if (!el) return;
  if (e.target.closest('[data-star]')) {
    const it = byId(el.dataset.id);
    return setOv(it.id, { fav: !it.fav });
  }
  launch(el.dataset.id);
});
content.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('[data-id]');
  if (!el) return;
  e.preventDefault();
  openMenu(el.dataset.id, e.clientX, e.clientY);
});
content.addEventListener('keydown', (e) => {
  const el = e.target.closest('[data-id]');
  if (el && e.key === 'Enter') launch(el.dataset.id);
  if (el && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    openMenu(el.dataset.id, r.left + 20, r.top + 20);
  }
});
document.addEventListener('mousedown', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('#setBtn')) togglePop(false);
});
$('#scroll').addEventListener('scroll', () => {
  closeMenu();
  openDDs.forEach((d) => d.close());
  $('.top').classList.toggle('scrolled', $('#scroll').scrollTop > 4);
});

function setCat(cat) {
  view.cat = view.cat === cat && ['recent', 'hidden', 'leftover'].includes(cat) ? 'all' : cat;
  render();
  $('#scroll').scrollTop = 0;
}
for (const sel of ['#tabs', '#views']) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cat]');
    if (b) setCat(b.dataset.cat);
  });
}

$('#mode').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  view.mode = b.dataset.mode;
  render();
});


let qTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    view.q = fold(e.target.value.trim());
    render();
  }, 80);
});

document.addEventListener('keydown', (e) => {
  const s = $('#search');
  if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement !== s)) {
    e.preventDefault();
    s.focus();
    s.select();
    return;
  }
  if (e.key === 'Escape') {
    closeMenu();
    togglePop(false);
    if (document.activeElement === s && s.value) {
      s.value = '';
      view.q = '';
      render();
    } else s.blur();
    return;
  }
  // start typing anywhere = search
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && e.key !== ' ') s.focus();
});

$('#scanBtn').addEventListener('click', () => api.scan());

function setScanning(on, text) {
  scanning = on;
  if (text !== undefined) scanText = text;
  const b = $('#scanBtn');
  b.disabled = on;
  b.classList.toggle('scanning', on);
  b.querySelector('span').textContent = t(on ? 'set.scanning' : 'set.rescan');
  $('#scanDot').hidden = !on;
  const txt = on || !lastScan ? (Array.isArray(scanText) ? t(...scanText) : scanText || '') : t('set.lastScan', fmtAgo(lastScan));
  $('#scanText').textContent = txt;
}

api.on('scan:status', (s) => {
  if (!s.scanning) lastScan = Date.now();
  setScanning(s.scanning, s.text);
  if (!items.length) render();
});
// New icons extracted (e.g. after a scan) – drop everything cached and reload
api.on('icons:ready', () => {
  iconCache.clear();
  observeIcons();
});
api.on('library:items', (p) => {
  items = p.items;
  if (p.lastScan) lastScan = p.lastScan;
  remember(items);
  render();
});
api.on('lang:changed', (l) => {
  I18N.setLang(l);
  applyI18n();
  render();
});

// start-with-Windows switch
const auto = $('#autostart');
api.getAutostart().then((on) => (auto.checked = on));
api.on('autostart:changed', (on) => (auto.checked = on));
auto.addEventListener('change', async () => {
  const on = await api.setAutostart(auto.checked);
  auto.checked = on;
  toast(t(on ? 'toast.autoOn' : 'toast.autoOff'));
});

(async () => {
  const [p, k] = await Promise.all([api.getLibrary(), api.hotkey()]);
  I18N.setLang(p.lang);
  hotkey = k;
  items = p.items;
  lastScan = p.lastScan;
  remember(items);
  scanText = p.scanText;
  applyI18n();
  setScanning(p.scanning);
  if (p.scanning || !items.length) scanning = true;
  render();
})();
