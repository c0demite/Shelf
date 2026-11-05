const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProcessRules } = require('../src/processes');
const { createPlaytime } = require('../src/playtime');

const rules = createProcessRules({ sysRoot: 'C:\\Windows', selfDirs: ['C:\\Shelf'] });
const hades = { id: 'hades', category: 'game', installDir: 'D:\\Games\\Hades' };
const discord = { id: 'discord', category: 'app', installDir: 'C:\\Users\\me\\AppData\\Local\\Discord' };
const HADES = 'd:\\games\\hades\\hades.exe';
const DISCORD = 'c:\\users\\me\\appdata\\local\\discord\\app-1\\discord.exe';
const procs = (all, windowed = all) => ({ all, windowed });

test('a running game gets a minute of playtime on every tick', () => {
  const pt = createPlaytime(rules);
  assert.deepEqual(pt.tick([hades, discord], procs([HADES])).played, ['hades']);
  assert.deepEqual(pt.tick([hades, discord], procs([HADES])).played, ['hades']);
  assert.equal(pt.isPlaying('hades'), true);
});

test('a game counts even when its process has no window (e.g. still loading)', () => {
  const pt = createPlaytime(rules);
  assert.deepEqual(pt.tick([hades], procs([HADES], [])).played, ['hades']);
});

test('hidden and leftover games are not timed', () => {
  const pt = createPlaytime(rules);
  assert.deepEqual(pt.tick([{ ...hades, hidden: true }], procs([HADES])).played, []);
  assert.deepEqual(pt.tick([{ ...hades, leftover: true }], procs([HADES])).played, []);
});

test('apps already open on the first tick are not counted as started', () => {
  const pt = createPlaytime(rules);
  assert.deepEqual(pt.tick([discord], procs([DISCORD])).started, []);
});

test('an app opened between two ticks counts as started once', () => {
  const pt = createPlaytime(rules);
  pt.tick([discord], procs([]));
  assert.deepEqual(pt.tick([discord], procs([DISCORD])).started, ['discord']);
  assert.deepEqual(pt.tick([discord], procs([DISCORD])).started, []);
});

test('an app without a window (tray helper, updater) does not count as started', () => {
  const pt = createPlaytime(rules);
  pt.tick([discord], procs([]));
  assert.deepEqual(pt.tick([discord], procs([DISCORD], [])).started, []);
});

test('changed tells when the set of running games is different from the last tick', () => {
  const pt = createPlaytime(rules);
  assert.equal(pt.tick([hades], procs([HADES])).changed, true);
  assert.equal(pt.tick([hades], procs([HADES])).changed, false);
  assert.equal(pt.tick([hades], procs([])).changed, true);
  assert.equal(pt.isPlaying('hades'), false);
});
