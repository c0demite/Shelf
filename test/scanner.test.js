const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFolders, merge, classify } = require('../src/scanner');

// A fake data drive: folders and (empty) files under a temp dir
let drive;
const put = (rel, body = '') => {
  const p = path.join(drive, rel);
  if (rel.endsWith('/')) return fs.mkdirSync(p, { recursive: true }); // an empty folder
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
let found;
const byName = (n) => found.find((i) => i.name === n);

before(async () => {
  drive = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-drive-'));
  process.env.SystemDrive = 'Q:'; // the fake drive is a data drive, not the Windows one
  put('Hollow Knight/hollow_knight.exe');
  put('Hollow Knight/hollow_knight_Data/');
  put('Games/Celeste/Celeste.exe');
  put('lossless/LosslessCut.exe');
  put('Moon.Sweepers.v1.2.3-FitGirl/MoonSweepers.exe');
  put('my-app/package.json', '{}');
  put('my-app/dist/my-app.exe');
  put('Drivers stuff/uninstall.exe');
  put('node_modules/thing/thing.exe');
  put('$Recycle.Bin/old/old.exe');
  found = await scanFolders([drive]);
  for (const it of found) await classify(it);
});
after(() => fs.rmSync(drive, { recursive: true, force: true }));

test('a loose game folder on a data drive is found and recognised as a game by its files', () => {
  const hk = byName('Hollow Knight');
  assert.ok(hk, 'Hollow Knight found');
  assert.equal(path.basename(hk.exe), 'hollow_knight.exe');
  assert.equal(hk.category, 'game');
});

test('everything inside a "Games" folder is a game', () => {
  assert.equal(byName('Celeste')?.category, 'game');
});

test('a short folder name takes the fuller exe name', () => {
  assert.ok(byName('LosslessCut'));
  assert.equal(byName('LosslessCut').category, 'app');
});

test('repack folder names are cleaned up', () => {
  assert.ok(byName('Moon Sweepers'), 'names: ' + found.map((i) => i.name).join(', '));
});

test('code projects, uninstallers, node_modules and the Recycle Bin are not apps', () => {
  assert.deepEqual(found.map((i) => i.name).sort(), ['Celeste', 'Hollow Knight', 'LosslessCut', 'Moon Sweepers']);
});

test('the same game from Steam and from the installed-programs list shows up once, as the Steam one', () => {
  const out = merge([
    { id: 'reg:1', source: 'registry', name: 'Hades', installDir: 'D:\\SteamLibrary\\steamapps\\common\\Hades', publisher: 'Supergiant Games', uninstall: 'x' },
    { id: 'steam:1145360', source: 'steam', name: 'Hades', installDir: 'D:\\SteamLibrary\\steamapps\\common\\Hades', uri: 'steam://rungameid/1145360' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'steam');
  assert.equal(out[0].publisher, 'Supergiant Games'); // details from the other entry are kept
});

test('a Start menu shortcut gives an installed program without an exe something to launch', () => {
  const out = merge([
    { id: 'reg:obs', source: 'registry', name: 'OBS Studio', installDir: 'C:\\Program Files\\obs-studio' },
    { id: 'lnk:obs', source: 'shortcut', name: 'OBS Studio', exe: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', lnk: 'C:\\Start\\OBS Studio.lnk' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].exe, 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe');
});

test('a folder found on disk that belongs to a known program is not added again', () => {
  const out = merge([
    { id: 'steam:1', source: 'steam', name: 'Satisfactory', installDir: 'F:\\Satisfactory' },
    { id: 'dir:f:\\satisfactory', source: 'folder', name: 'FactoryGame', installDir: 'F:\\Satisfactory', exe: 'F:\\Satisfactory\\FactoryGame.exe' },
  ]);
  assert.deepEqual(out.map((i) => i.id), ['steam:1']);
});

test('launchers are apps, even from a game publisher', async () => {
  const discord = { source: 'registry', name: 'Discord', publisher: 'Discord Inc.' };
  const bnet = { source: 'registry', name: 'Battle.net', publisher: 'Blizzard Entertainment' };
  await classify(discord);
  await classify(bnet);
  assert.equal(discord.category, 'app');
  assert.equal(bnet.category, 'app');
});

test('a game publisher or a games folder makes it a game', async () => {
  const cp = { source: 'registry', name: 'Cyberpunk 2077', publisher: 'CD PROJEKT RED' };
  const xbox = { source: 'registry', name: 'Something', installDir: 'E:\\XboxGames\\Something\\Content' };
  await classify(cp);
  await classify(xbox);
  assert.equal(cp.category, 'game');
  assert.equal(xbox.category, 'game');
});
