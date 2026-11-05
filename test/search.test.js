const { test } = require('node:test');
const assert = require('node:assert/strict');
const { search } = require('../renderer/search');

const names = (list) => list.map((i) => i.name);
const app = (name, extra = {}) => ({ name, canLaunch: true, ...extra });

test('a name that starts with the query beats one that only contains it', () => {
  const hits = search([app('Steam'), app('Hades'), app('Discord')], 'd');
  assert.deepEqual(names(hits), ['Discord', 'Hades']);
});

test('word starts and initials find a game', () => {
  assert.deepEqual(names(search([app('Hades'), app('Red Dead Redemption 2')], 'dead')), ['Red Dead Redemption 2']);
  assert.deepEqual(names(search([app('Hades'), app('Red Dead Redemption 2')], 'rdr')), ['Red Dead Redemption 2']);
});

test('accents and Polish letters do not matter', () => {
  assert.deepEqual(names(search([app('Wiedźmin 3'), app('Łódź Simulator')], 'wiedz')), ['Wiedźmin 3']);
  assert.deepEqual(names(search([app('Wiedźmin 3'), app('Łódź Simulator')], 'lodz')), ['Łódź Simulator']);
});

test('the query is trimmed and case does not matter', () => {
  assert.deepEqual(names(search([app('Steam')], '  STE ')), ['Steam']);
});

test('favourites rank above an equal match', () => {
  const hits = search([app('Spotify'), app('Steam', { fav: true })], 's');
  assert.equal(hits[0].name, 'Steam');
});

test('something that cannot be launched drops below things that can', () => {
  const hits = search([app('Chrome', { canLaunch: false }), app('Claude')], 'c');
  assert.equal(hits[0].name, 'Claude');
});

test('a shelf named like the query comes before an app with the same match', () => {
  const hits = search([app('Daily Notes'), { shelf: true, name: 'Daily', canLaunch: true }], 'da');
  assert.equal(hits[0].name, 'Daily');
});

test('a shelf that does not match stays out (the shelf bonus does not rescue a miss)', () => {
  const hits = search([app('Coop game'), { shelf: true, name: 'To finish', canLaunch: true }], 'co');
  assert.deepEqual(names(hits), ['Coop game']);
});

test('at most 8 results', () => {
  const many = Array.from({ length: 12 }, (_, i) => app('Game ' + i));
  assert.equal(search(many, 'game').length, 8);
});

test('no match, no results', () => {
  assert.deepEqual(search([app('Steam')], 'xyz'), []);
});
