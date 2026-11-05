// Starting a game or app: store link, Store app id, shortcut or exe (in that order).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { shell } = require('electron');

function launch(it) {
  return new Promise((resolve, reject) => {
    if (it.uri) return shell.openExternal(it.uri).then(resolve, reject);
    if (it.aumid) {
      spawn('explorer.exe', ['shell:AppsFolder\\' + it.aumid], { detached: true, stdio: 'ignore' }).unref();
      return resolve();
    }
    if (it.lnk && fs.existsSync(it.lnk)) {
      return shell.openPath(it.lnk).then((err) => (err ? reject(new Error(err)) : resolve()));
    }
    if (it.exe && fs.existsSync(it.exe)) {
      const fallback = () => shell.openPath(it.exe).then((err) => (err ? reject(new Error(err)) : resolve()));
      try {
        const child = spawn(it.exe, [], { cwd: it.cwd || path.dirname(it.exe), detached: true, stdio: 'ignore' });
        child.once('error', fallback); // e.g. needs admin rights
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      } catch {
        fallback();
      }
      return;
    }
    reject(new Error('Brak pliku do uruchomienia'));
  });
}

module.exports = { launch };
