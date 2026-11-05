const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInspector } = require('../src/inspect');

let dir;
const file = (rel, body = '') => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-inspect-'))));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const noInfo = createInspector({ versionInfo: async () => null });

test('the name comes from the file name, without build suffixes', async () => {
  const info = await noInfo(file('Tools\\My_Cool.App-x64.exe'));
  assert.equal(info.name, 'My Cool App');
  assert.equal(info.category, 'app');
});

test('the exe description is used as the name when it is a real name', async () => {
  const inspect = createInspector({ versionInfo: async () => ({ d: 'Discord®', p: 'Discord' }) });
  assert.equal((await inspect(file('Apps\\Update.exe'))).name, 'Discord');
});

test('generic descriptions like "Launcher" or "Microsoft Windows Operating System" are ignored', async () => {
  const launcher = createInspector({ versionInfo: async () => ({ d: 'Launcher', p: 'Microsoft Windows Operating System' }) });
  assert.equal((await launcher(file('Apps\\hades_launcher.exe'))).name, 'hades launcher');
});

test('an exe inside a games folder is guessed to be a game', async () => {
  const info = await noInfo(file('Games\\Hades\\Hades.exe'));
  assert.equal(info.category, 'game');
  assert.equal(info.dir, path.join(dir, 'Games', 'Hades'));
});

test('a store link (steam://) is a game that launches through its uri', async () => {
  const info = await noInfo(file('Hades.url', '[InternetShortcut]\r\nURL=steam://rungameid/1145360\r\n'));
  assert.equal(info.uri, 'steam://rungameid/1145360');
  assert.equal(info.category, 'game');
  assert.equal(info.name, 'Hades');
});

test('an internet shortcut without a URL cannot be added', async () => {
  assert.equal(await noInfo(file('Empty.url', '[InternetShortcut]\r\n')), null);
});

test('a shortcut keeps its own name and is followed to the program for the folder', async () => {
  const target = file('Programs\\Obsidian\\Obsidian.exe');
  const inspect = createInspector({ versionInfo: async () => ({ d: 'Obsidian.exe' }), readShortcut: () => target });
  const info = await inspect(file('Notes app.lnk'));
  assert.equal(info.name, 'Notes app');
  assert.equal(info.dir, path.dirname(target));
});

test('other file types and missing files are refused', async () => {
  assert.equal(await noInfo(file('readme.txt')), null);
  assert.equal(await noInfo(path.join(dir, 'missing.exe')), null);
  assert.equal(await noInfo(42), null);
});

test('very long names are cut to 80 characters', async () => {
  const info = await noInfo(file('A'.repeat(120) + '.bat'));
  assert.equal(info.name.length, 80);
});
