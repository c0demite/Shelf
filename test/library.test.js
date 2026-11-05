const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLibrary } = require('../src/library');

// A library over a fresh saved state, like the one in state.json
function make(items = [], extra = {}) {
  const state = { items, overrides: {}, covers: {}, headers: {}, ...extra };
  const playing = new Set();
  const lib = createLibrary({ state: () => state, isPlaying: (id) => playing.has(id) });
  return { state, lib, playing };
}
const hades = () => ({ id: 'steam:1', name: 'Hades', category: 'game', source: 'steam', steamAppId: '1145360', playtime: 120 });
const notes = () => ({ id: 'reg:n', name: 'Notes', category: 'app', source: 'registry', exe: 'C:\\Notes\\notes.exe' });

test('a fresh item shows as found by the scan', () => {
  const { lib } = make([notes()]);
  const v = lib.view(lib.find('reg:n'));
  assert.equal(v.category, 'app');
  assert.equal(v.fav, false);
  assert.equal(v.hidden, false);
  assert.equal(v.launches, 0);
  assert.equal(v.lastLaunch, null);
});

test('marking as a game sticks, and marking back to what the scan said clears the override', () => {
  const { lib, state } = make([notes()]);
  assert.equal(lib.override('reg:n', { category: 'game' }).category, 'game');
  assert.equal(lib.override('reg:n', { category: 'app' }).category, 'app');
  assert.equal(state.overrides['reg:n'].category, undefined);
});

test('things the scan hid stay hidden until the user shows them', () => {
  const { lib } = make([{ ...notes(), autoHidden: true }]);
  assert.equal(lib.view(lib.find('reg:n')).hidden, true);
  assert.equal(lib.override('reg:n', { hidden: false }).hidden, false);
});

test('launching counts and remembers the time', () => {
  const { lib } = make([notes()]);
  lib.launched('reg:n');
  lib.launched('reg:n');
  const v = lib.view(lib.find('reg:n'));
  assert.equal(v.launches, 2);
  assert.ok(Date.now() - v.lastLaunch < 1000);
});

test('Steam games show Steam playtime; others show the minutes Shelf counted', () => {
  const { lib } = make([hades(), { id: 'dir:x', name: 'Celeste', category: 'game', source: 'folder' }]);
  lib.played(['steam:1', 'dir:x']);
  lib.played(['dir:x']);
  assert.equal(lib.view(lib.find('steam:1')).playtime, 120);
  assert.equal(lib.view(lib.find('dir:x')).playtime, 2);
});

test('an app opened outside Shelf moves to Recent without counting as a launch', () => {
  const { lib } = make([notes()]);
  lib.opened(['reg:n']);
  const v = lib.view(lib.find('reg:n'));
  assert.ok(v.lastLaunch);
  assert.equal(v.launches, 0);
});

test('a running game shows as playing', () => {
  const { lib, playing } = make([hades()]);
  playing.add('steam:1');
  assert.equal(lib.view(lib.find('steam:1')).playing, true);
});

test('shelves: names are trimmed, empty ones dropped, and deleted shelves vanish from items', () => {
  const { lib } = make([notes()]);
  lib.saveShelves([{ id: 'a', name: '  Daily  ' }, { id: 'b', name: '   ' }, { id: 'c', name: 'Co-op' }]);
  lib.override('reg:n', { shelves: ['a', 'c'] });
  assert.deepEqual(lib.saveShelves([{ id: 'a', name: 'Daily' }]), [{ id: 'a', name: 'Daily' }]);
  assert.deepEqual(lib.view(lib.find('reg:n')).shelves, ['a']);
});

test('cover: own picture beats own store pick beats the Steam one; reset goes back', () => {
  const { lib } = make([hades()]);
  assert.equal(lib.view(lib.find('steam:1')).coverAppId, '1145360');
  assert.equal(lib.setCover('steam:1', { coverAppId: '42' }).view.coverAppId, '42');
  const pic = lib.setCover('steam:1', { coverFile: 'abc.png' });
  assert.equal(pic.view.coverFile, 'shelf://cover/abc.png');
  assert.equal(pic.view.coverAppId, null);
  const reset = lib.setCover('steam:1', {});
  assert.equal(reset.view.coverAppId, '1145360');
  assert.equal(reset.unusedFile, 'abc.png'); // the old picture can be deleted
});

test('a cover found by name is used, but not for generic names like "Launcher"', () => {
  const { lib } = make(
    [
      { id: 'a', name: 'Celeste', category: 'game', source: 'folder' },
      { id: 'b', name: 'Launcher', category: 'game', source: 'folder' },
    ],
    { covers: { celeste: '504230', launcher: '999' } }
  );
  assert.equal(lib.view(lib.find('a')).coverAppId, '504230');
  assert.equal(lib.view(lib.find('b')).coverAppId, null);
});

test('things added by hand survive a rescan', () => {
  const { lib, state } = make([notes()]);
  lib.addManual({ id: 'manual:1', name: 'Tool', category: 'app', source: 'manual', manual: true, exe: 'D:\\Tool\\tool.exe' });
  lib.replaceScan([notes()]);
  assert.deepEqual(state.items.map((i) => i.id), ['reg:n', 'manual:1']);
});

test('once the scan finds the same exe, the hand-added copy is not shown twice', () => {
  const { lib, state } = make([]);
  lib.addManual({ id: 'manual:1', name: 'Tool', category: 'app', source: 'manual', manual: true, exe: 'D:\\Tool\\tool.exe' });
  lib.replaceScan([{ id: 'dir:tool', name: 'Tool', category: 'app', source: 'folder', exe: 'd:\\tool\\TOOL.exe' }]);
  assert.deepEqual(state.items.map((i) => i.id), ['dir:tool']);
});

test('adding an exe that is already on the shelf just makes it visible again', () => {
  const { lib } = make([{ ...notes(), autoHidden: true }]);
  const r = lib.addManual({ id: 'manual:2', name: 'Notes', category: 'app', source: 'manual', manual: true, exe: 'c:\\notes\\NOTES.exe' });
  assert.equal(r.exists, true);
  assert.equal(r.item.hidden, false);
  assert.equal(lib.find('manual:2'), undefined);
});

test('removing a hand-added item forgets its settings and frees its picture', () => {
  const { lib, state } = make([]);
  lib.addManual({ id: 'manual:1', name: 'Tool', category: 'app', source: 'manual', manual: true, exe: 'D:\\Tool\\tool.exe' });
  lib.setCover('manual:1', { coverFile: 'pic.png' });
  assert.deepEqual(lib.removeManual('manual:1'), { removed: true, unusedFile: 'pic.png' });
  assert.equal(state.overrides['manual:1'], undefined);
  assert.equal(lib.find('manual:1'), undefined);
  assert.deepEqual(lib.removeManual('reg:n'), { removed: false });
});
