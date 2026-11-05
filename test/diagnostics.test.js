const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagnosticsReport } = require('../src/diagnostics');

const base = {
  version: '0.5.2',
  packaged: true,
  os: { release: '10.0.26100', arch: 'x64' },
  lang: 'pl',
  theme: 'dark',
  gpu: true,
  plainSetting: false,
  displays: [{ width: 2560, height: 1440, scaleFactor: 1.25 }],
  items: [],
  lastScan: null,
};
const report = (patch = {}) => diagnosticsReport({ ...base, ...patch });
const line = (text, start) => text.split('\n').find((l) => l.startsWith(start));

test('starts with the Shelf version and how it runs', () => {
  assert.equal(report().split('\n')[0], 'Shelf 0.5.2 (installed)');
  assert.equal(report({ packaged: false }).split('\n')[0], 'Shelf 0.5.2 (from source)');
});

test('names the Windows build, language and theme', () => {
  assert.equal(line(report(), 'Windows:'), 'Windows: 11 (10.0.26100) x64');
  assert.equal(line(report({ os: { release: '10.0.19045', arch: 'x64' } }), 'Windows:'), 'Windows: 10 (10.0.19045) x64');
  assert.equal(line(report(), 'Language:'), 'Language: pl, theme: dark');
});

test('tells which quick search window is used and why', () => {
  assert.equal(line(report(), 'Quick search window:'), 'Quick search window: see-through (GPU compositing: on)');
  assert.equal(line(report({ plainSetting: true }), 'Quick search window:'), 'Quick search window: simple, turned on in settings (GPU compositing: on)');
  assert.equal(line(report({ gpu: false }), 'Quick search window:'), 'Quick search window: simple, no GPU compositing (GPU compositing: off)');
  assert.equal(line(report({ gpu: null }), 'Quick search window:'), 'Quick search window: see-through (GPU compositing: not known yet)');
});

test('lists every screen with its size and scaling', () => {
  const r = report({ displays: [{ width: 2560, height: 1440, scaleFactor: 1.25 }, { width: 1920, height: 1080, scaleFactor: 1 }] });
  assert.equal(line(r, 'Screens:'), 'Screens: 2 – 2560×1440 at 125%, 1920×1080 at 100%');
});

test('counts the library by kind and by source, without names or paths', () => {
  const items = [
    { name: 'Hades', category: 'game', source: 'steam', installDir: 'D:\\Games\\Hades' },
    { name: 'Satisfactory', category: 'game', source: 'epic' },
    { name: 'Portal', category: 'game', source: 'steam' },
    { name: 'Discord', category: 'app', source: 'registry' },
    { name: 'Old thing', category: 'app', source: 'registry', hidden: true },
    { name: 'Gone game', category: 'game', source: 'steam', leftover: true },
  ];
  const r = report({ items });
  assert.equal(line(r, 'Library:'), 'Library: 3 games, 2 apps, 1 hidden, 1 leftover');
  assert.equal(line(r, 'Sources:'), 'Sources: steam 3, registry 2, epic 1');
  for (const secret of ['Hades', 'Discord', 'Games']) assert.ok(!r.includes(secret), secret + ' should not be in the report');
});

test('says when the last scan was, or that there was none', () => {
  assert.equal(line(report(), 'Last scan:'), 'Last scan: never');
  assert.equal(line(report({ lastScan: Date.UTC(2026, 10, 5, 16, 7) }), 'Last scan:'), 'Last scan: 2026-11-05 16:07 UTC');
});
