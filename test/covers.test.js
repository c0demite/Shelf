const { test } = require('node:test');
const assert = require('node:assert/strict');
const { storeMatch } = require('../src/covers');

const hits = (...names) => names.map((name, i) => ({ id: 100 + i, name }));

test('the same name, ignoring symbols and case, is a match', () => {
  assert.equal(storeMatch('Hades™', hits('Hades II', 'HADES'))?.id, 101);
});

test('a longer store title that starts with the game name is a match', () => {
  assert.equal(storeMatch('Satisfactory', hits('Satisfactory - Soundtrack', 'Satisfactory Demo'))?.id, 101);
});

test('the edition at the front of a store title still matches', () => {
  assert.equal(storeMatch('Spider-Man 2', hits("Marvel's Spider-Man 2"))?.id, 100);
});

test('short names only match exactly, so "Doom" does not pick "Doomsday Vault"', () => {
  assert.equal(storeMatch('Doom', hits('Doomsday Vault')), null);
});

test('a name that only shares a beginning is not a match', () => {
  assert.equal(storeMatch('Portal Knights', hits('Portal 2')), null);
});
