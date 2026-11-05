const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProcessRules } = require('../src/processes');

const rules = createProcessRules({
  sysRoot: 'C:\\Windows',
  selfDirs: ['C:\\Users\\me\\AppData\\Local\\Programs\\Shelf'],
  readShortcut: (lnk) => ({ 'C:\\Start\\Hades.lnk': 'E:\\Hades\\Hades.exe' })[lnk] || null,
});

test('a game folder right under a drive is watched', () => {
  assert.equal(rules.watchDir({ exe: 'F:\\Satisfactory\\FactoryGame.exe' }), 'f:\\satisfactory\\');
});

test('a game inside a library folder is watched by its own folder', () => {
  assert.equal(rules.watchDir({ installDir: 'D:\\Games\\Hades II' }), 'd:\\games\\hades ii\\');
  assert.equal(rules.watchDir({ installDir: 'D:\\SteamLibrary\\steamapps\\common\\Hades\\' }), 'd:\\steamlibrary\\steamapps\\common\\hades\\');
});

test('a shared folder like D:\\Games is too broad to tell whose process it is', () => {
  assert.equal(rules.watchDir({ exe: 'D:\\Games\\launcher.exe' }), null);
  assert.equal(rules.watchDir({ exe: 'D:\\Tools\\tool.exe' }), null);
  assert.equal(rules.watchDir({ installDir: 'E:\\' }), null);
});

test('Windows tools and Shelf itself are never watched', () => {
  assert.equal(rules.watchDir({ exe: 'C:\\Windows\\System32\\notepad.exe' }), null);
  assert.equal(rules.watchDir({ installDir: 'C:\\Users\\me\\AppData\\Local\\Programs\\Shelf' }), null);
});

test('a shortcut without a folder is followed to its target', () => {
  assert.equal(rules.watchDir({ lnk: 'C:\\Start\\Hades.lnk' }), 'e:\\hades\\');
});

test('an app is open when a windowed process runs from its folder', () => {
  const discord = { exe: 'C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0\\Discord.exe', installDir: 'C:\\Users\\me\\AppData\\Local\\Discord' };
  assert.equal(rules.isOpen(discord, ['c:\\users\\me\\appdata\\local\\discord\\app-1.0\\discord.exe']), true);
  assert.equal(rules.isOpen(discord, ['c:\\program files\\steam\\steam.exe']), false);
});

test('an app in a broad folder only counts as open by its exact exe', () => {
  const tool = { exe: 'D:\\Tools\\tool.exe' };
  assert.equal(rules.isOpen(tool, ['d:\\tools\\tool.exe']), true);
  assert.equal(rules.isOpen(tool, ['d:\\tools\\other.exe']), false);
});

test('something with no folder or exe to check is never open', () => {
  assert.equal(rules.isOpen({ uri: 'steam://run/1' }, ['c:\\x.exe']), false);
});

test('a running game inside the Steam folder belongs to the game, not to Steam', () => {
  const items = [
    { id: 'steam', category: 'app', installDir: 'C:\\Program Files (x86)\\Steam' },
    { id: 'hades', category: 'game', installDir: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hades' },
  ];
  const owners = rules.owners(items, ['c:\\program files (x86)\\steam\\steamapps\\common\\hades\\hades.exe']);
  assert.deepEqual([...owners], ['hades']);
});

test('hidden, leftover and Shelf entries own no processes', () => {
  const items = [
    { id: 'a', category: 'app', exe: 'E:\\Apps\\A\\a.exe', hidden: true },
    { id: 'b', category: 'app', exe: 'E:\\Apps\\B\\b.exe', leftover: true },
    { id: 'c', category: 'app', exe: 'C:\\Users\\me\\AppData\\Local\\Programs\\Shelf\\Shelf.exe' },
  ];
  assert.equal(rules.owners(items, ['e:\\apps\\a\\a.exe', 'e:\\apps\\b\\b.exe', 'c:\\users\\me\\appdata\\local\\programs\\shelf\\shelf.exe']).size, 0);
});
