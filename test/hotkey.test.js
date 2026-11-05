const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHotkey } = require('../src/hotkey');

// Stands in for Electron's globalShortcut: some keys are taken by other programs
function fakeShortcuts(taken = []) {
  const held = new Map();
  return {
    held,
    register: (k, fn) => (taken.includes(k) || held.has(k) ? false : (held.set(k, fn), true)),
    unregister: (k) => held.delete(k),
  };
}
const DEFAULTS = ['Control+Space', 'Control+Alt+Space', 'Alt+Shift+Space'];
const make = (taken) => {
  const sc = fakeShortcuts(taken);
  return { sc, hk: createHotkey({ ...sc, defaults: DEFAULTS, onPress: () => {} }) };
};

test('with no choice of its own, the first free default is used', () => {
  const { sc, hk } = make(['Control+Space']);
  hk.start(null);
  assert.deepEqual(hk.info(), { current: 'Control+Alt+Space', chosen: null, taken: false });
  assert.deepEqual([...sc.held.keys()], ['Control+Alt+Space']);
});

test('when every default is taken there is no shortcut', () => {
  const { hk } = make(DEFAULTS);
  hk.start(null);
  assert.deepEqual(hk.info(), { current: null, chosen: null, taken: false });
});

test("the user's own shortcut is used when it is free", () => {
  const { hk } = make();
  hk.start('Control+Alt+K');
  assert.deepEqual(hk.info(), { current: 'Control+Alt+K', chosen: 'Control+Alt+K', taken: false });
});

test("if the user's shortcut got taken, a default is used and the settings can say so", () => {
  const { hk } = make(['Control+Alt+K']);
  hk.start('Control+Alt+K');
  assert.deepEqual(hk.info(), { current: 'Control+Space', chosen: 'Control+Alt+K', taken: true });
});

test('choosing a free shortcut replaces the old one', () => {
  const { sc, hk } = make();
  hk.start(null);
  assert.equal(hk.choose('Alt+Shift+K'), true);
  assert.deepEqual([...sc.held.keys()], ['Alt+Shift+K']);
  assert.equal(hk.info().current, 'Alt+Shift+K');
});

test('choosing a taken shortcut fails and keeps the old one working', () => {
  const { sc, hk } = make(['Control+Alt+X']);
  hk.start(null);
  assert.equal(hk.choose('Control+Alt+X'), false);
  assert.deepEqual([...sc.held.keys()], ['Control+Space']);
  assert.deepEqual(hk.info(), { current: 'Control+Space', chosen: null, taken: false });
});

test('choosing the shortcut already in use is fine', () => {
  const { hk } = make();
  hk.start(null);
  assert.equal(hk.choose('Control+Space'), true);
  assert.equal(hk.info().current, 'Control+Space');
});

test('going back to the default drops the own choice', () => {
  const { hk } = make();
  hk.start('Control+Alt+K');
  hk.choose(null);
  assert.deepEqual(hk.info(), { current: 'Control+Space', chosen: null, taken: false });
});

test('a new shortcut can be chosen while paused; a taken one leaves it paused until resumed', () => {
  const { sc, hk } = make(['Control+Alt+X']);
  hk.start(null);
  hk.pause();
  assert.equal(hk.choose('Control+Alt+X'), false);
  assert.equal(sc.held.size, 0);
  assert.equal(hk.choose('Control+Alt+K'), true);
  assert.deepEqual([...sc.held.keys()], ['Control+Alt+K']);
});

test('paused while recording a new one, so pressing it does not open the window', () => {
  const { sc, hk } = make();
  hk.start(null);
  hk.pause();
  assert.equal(sc.held.size, 0);
  hk.resume();
  assert.deepEqual([...sc.held.keys()], ['Control+Space']);
});
