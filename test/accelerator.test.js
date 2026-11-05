const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromKey } = require('../renderer/accelerator');

const press = (code, mods = {}) => fromKey({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('a modifier with a letter, digit, F-key or Space makes a shortcut', () => {
  assert.deepEqual(press('KeyK', { ctrlKey: true, altKey: true }), { accelerator: 'Control+Alt+K' });
  assert.deepEqual(press('Digit1', { ctrlKey: true, shiftKey: true }), { accelerator: 'Control+Shift+1' });
  assert.deepEqual(press('Space', { ctrlKey: true, shiftKey: true }), { accelerator: 'Control+Shift+Space' });
  assert.deepEqual(press('F9', { ctrlKey: true }), { accelerator: 'Control+F9' });
});

test('a letter is the one printed on the key, as Windows matches shortcuts by layout', () => {
  // German keyboard: the key in the Y position types z
  assert.deepEqual(press('KeyY', { ctrlKey: true, shiftKey: true, key: 'z' }), { accelerator: 'Control+Shift+Z' });
});

test('on a non-Latin layout the letter comes from the key position', () => {
  assert.deepEqual(press('KeyK', { ctrlKey: true, altKey: true, key: 'л' }), { accelerator: 'Control+Alt+K' });
});

test('while only modifiers are held there is no shortcut yet', () => {
  assert.equal(press('ControlLeft', { ctrlKey: true }), null);
  assert.equal(press('AltRight', { altKey: true, ctrlKey: true }), null);
  assert.equal(press('ShiftLeft', { shiftKey: true }), null);
});

test('a key without Ctrl or Alt is refused, so typing never triggers it', () => {
  assert.deepEqual(press('KeyK'), { error: 'modifier' });
  assert.deepEqual(press('KeyK', { shiftKey: true }), { error: 'modifier' });
});

test('the Windows key is refused (Windows keeps those shortcuts for itself)', () => {
  assert.deepEqual(press('KeyK', { metaKey: true, ctrlKey: true }), { error: 'windows' });
});

test('keys that cannot be a shortcut are refused', () => {
  assert.deepEqual(press('Enter', { ctrlKey: true }), { error: 'key' });
  assert.deepEqual(press('Semicolon', { ctrlKey: true }), { error: 'key' });
});

test('shortcuts Windows already uses are refused', () => {
  assert.deepEqual(press('Tab', { altKey: true }), { error: 'key' });
  assert.deepEqual(press('F4', { altKey: true }), { error: 'reserved' });
  assert.deepEqual(press('Delete', { ctrlKey: true, altKey: true }), { error: 'key' });
  assert.deepEqual(press('KeyC', { ctrlKey: true }), { error: 'reserved' });
  assert.deepEqual(press('KeyV', { ctrlKey: true }), { error: 'reserved' });
});

test('Ctrl+Alt with a key that types a letter (right Alt on Polish or German keyboards) is refused', () => {
  assert.deepEqual(press('KeyA', { ctrlKey: true, altKey: true, key: 'ą' }), { error: 'types' });
  assert.deepEqual(press('KeyE', { ctrlKey: true, altKey: true, key: '€' }), { error: 'types' });
  assert.deepEqual(press('KeyL', { ctrlKey: true, altKey: true, shiftKey: true, key: 'Ł' }), { error: 'types' });
});

test('Ctrl+Alt on a Polish letter key is refused even when recorded on another layout', () => {
  for (const k of 'ACELNOSXZ') assert.deepEqual(press('Key' + k, { ctrlKey: true, altKey: true, key: k.toLowerCase() }), { error: 'types' }, k);
  assert.deepEqual(press('KeyK', { ctrlKey: true, altKey: true, key: 'k' }), { accelerator: 'Control+Alt+K' });
});

test('Alt with just a letter, digit or Space is refused: programs use those for their menus', () => {
  assert.deepEqual(press('KeyF', { altKey: true }), { error: 'reserved' });
  assert.deepEqual(press('Digit1', { altKey: true }), { error: 'reserved' });
  assert.deepEqual(press('Space', { altKey: true }), { error: 'reserved' });
  assert.deepEqual(press('KeyF', { altKey: true, shiftKey: true }), { accelerator: 'Alt+Shift+F' });
  assert.deepEqual(press('F9', { altKey: true }), { accelerator: 'Alt+F9' });
});

test('Escape cancels', () => {
  assert.deepEqual(press('Escape'), { cancel: true });
});
