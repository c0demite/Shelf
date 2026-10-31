'use strict';
// Quick launcher (Ctrl+Space): type, arrows, Enter.

const api = window.hub;
const { t } = I18N;
const $ = (s) => document.querySelector(s);
const input = $('#q');
const results = $('#results');

const SRC = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG', ubisoft: 'Ubisoft', xbox: 'Xbox', store: 'Microsoft Store' };
const srcLabel = (s) => SRC[s] || (s ? t('src.' + s) : '');

function applyI18n() {
  document.documentElement.lang = I18N.getLang();
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
}

let items = [];
let shown = [];
let sel = 0;
let msg = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);

function ago(ts) {
  const d = (Date.now() - ts) / 86400000;
  if (d < 1 / 24) return t('ago.now');
  if (d < 1) return t('ago.h', Math.floor(d * 24));
  if (d < 2) return t('ago.yesterday');
  return t('ago.days', Math.floor(d));
}

// Higher = better. Prefix > word start > initials > substring.
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
  return s - n.length / 100;
}

function compute() {
  const q = fold(input.value.trim());
  const pool = items.filter((i) => !i.hidden && !i.leftover);
  if (!q) {
    const recent = pool.filter((i) => i.lastLaunch).sort((a, b) => b.lastLaunch - a.lastLaunch).slice(0, 5);
    const favs = pool.filter((i) => i.fav && !recent.includes(i)).slice(0, 8 - recent.length);
    const groups = [];
    if (recent.length) groups.push([t('q.recent'), recent]);
    if (favs.length) groups.push([t('q.fav'), favs]);
    if (!groups.length) groups.push([t('q.games'), pool.filter((i) => i.category === 'game').slice(0, 8)]);
    return groups;
  }
  const hits = pool
    .map((i) => [i, score(i, q)])
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([i]) => i);
  return [[null, hits]];
}

function highlight(name, q) {
  if (!q) return esc(name);
  const i = fold(name).indexOf(q);
  if (i < 0) return esc(name);
  return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
}

const icons = new Map();
function render() {
  const q = fold(input.value.trim());
  const groups = compute();
  shown = groups.flatMap(([, l]) => l);
  if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
  let html = '';
  let idx = 0;
  for (const [label, list] of groups) {
    if (label && list.length) html += `<div class="label">${label}</div>`;
    for (const it of list) {
      const sub = [t(it.category === 'game' ? 'type.game' : 'type.app'), srcLabel(it.source), it.lastLaunch ? ago(it.lastLaunch) : null]
        .filter(Boolean)
        .join(' · ');
      const ic = icons.get(it.id);
      const letter = `<div class="letter" style="background:linear-gradient(135deg,hsl(${hue(it.name)} 40% 48%),hsl(${(hue(it.name) + 40) % 360} 45% 34%))">${esc((it.name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}</div>`;
      html += `<div class="row${idx === sel ? ' sel' : ''}${it.canLaunch ? '' : ' dead'}" data-i="${idx}">
        <div class="ic" data-icon="${esc(it.id)}">${ic ? `<img src="${ic}" alt="">` : letter}</div>
        <div class="txt"><div class="nm">${highlight(it.name, q)}</div><div class="sb">${esc(sub)}</div></div>
        <div class="go">${it.canLaunch ? 'Enter ↵' : esc(t('q.noFile'))}</div>
      </div>`;
      idx++;
    }
  }
  if (q && !shown.length) html = `<div class="none">${esc(t('q.none', input.value.trim()))}</div>`;
  results.innerHTML = html;
  $('#panel').querySelector('.msg')?.remove();
  if (msg) $('#foot').insertAdjacentHTML('beforebegin', `<div class="msg">${esc(msg)}</div>`);
  loadIcons();
  fit();
}

function loadIcons() {
  for (const el of results.querySelectorAll('[data-icon]')) {
    const id = el.dataset.icon;
    if (icons.has(id)) continue;
    icons.set(id, null);
    api.icon(id).then((url) => {
      icons.set(id, url);
      if (url) {
        const box = results.querySelector(`[data-icon="${CSS.escape(id)}"]`);
        if (box) box.innerHTML = `<img src="${url}" alt="">`;
      }
    });
  }
}

function fit() {
  requestAnimationFrame(() => api.quickResize($('#panel').getBoundingClientRect().height + 52));
}

function move(d) {
  if (!shown.length) return;
  sel = (sel + d + shown.length) % shown.length;
  results.querySelectorAll('.row').forEach((r) => r.classList.toggle('sel', +r.dataset.i === sel));
  results.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}

async function activate(folder) {
  const it = shown[sel];
  if (!it) return;
  if (folder) {
    await api.openFolder(it.id);
    return api.quickHide();
  }
  if (!it.canLaunch) {
    msg = t('q.noFileMsg');
    return render();
  }
  const r = await api.launch(it.id);
  if (r.ok) {
    if (r.item) items = items.map((x) => (x.id === r.item.id ? r.item : x));
    api.quickHide();
  } else {
    msg = t('toast.failed', r.error);
    render();
  }
}

input.addEventListener('input', () => {
  sel = 0;
  msg = '';
  render();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); activate(e.shiftKey || e.ctrlKey); }
  else if (e.key === 'Escape') {
    if (input.value) { input.value = ''; sel = 0; msg = ''; render(); }
    else api.quickHide();
  } else if (document.activeElement !== input) input.focus();
});
results.addEventListener('mousemove', (e) => {
  const r = e.target.closest('.row');
  if (r && +r.dataset.i !== sel) { sel = +r.dataset.i; move(0); }
});
results.addEventListener('click', (e) => {
  const r = e.target.closest('.row');
  if (r) { sel = +r.dataset.i; activate(e.shiftKey); }
});
$('#openMain').addEventListener('click', () => api.openMain());

api.on('library:items', (p) => { items = p.items; render(); });
api.on('theme:changed', (m) => Theme.set(m));
api.on('lang:changed', (l) => { I18N.setLang(l); applyI18n(); render(); });
api.on('icons:ready', () => { icons.clear(); render(); });
api.on('quick:open', async () => {
  input.value = '';
  sel = 0;
  msg = '';
  const p = await api.getLibrary();
  items = p.items;
  I18N.setLang(p.lang);
  Theme.set(p.theme);
  applyI18n();
  render();
  input.focus();
});

(async () => {
  const p = await api.getLibrary();
  items = p.items;
  I18N.setLang(p.lang);
  Theme.set(p.theme);
  applyI18n();
  render();
  input.focus();
})();
