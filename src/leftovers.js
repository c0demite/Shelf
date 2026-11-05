// Clean-up of leftovers: dead "installed program" entries in the registry and empty Steam folders.
// Registry keys are exported to a .reg backup first; folders go to the Recycle Bin.
const fs = require('fs');
const path = require('path');
const { run, psEncoded } = require('./ps');

const UNINSTALL_KEY_RE =
  /^HKEY_(LOCAL_MACHINE|CURRENT_USER)\\SOFTWARE\\(WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^"\\]+$/i;
const TRASH_LIMIT = 2 * 1024 ** 3; // 2 GB – bigger folders could skip the Recycle Bin and be gone for good

const regExists = async (key) => (await run('reg', ['query', key])).ok;

function dirSize(dir, cap) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (total > cap) return;
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      } catch {}
    }
  };
  try {
    walk(dir);
  } catch {}
  return total;
}

// list: leftover items. backupRoot: where the .reg backups go. trash(dir): moves a folder to the Recycle Bin.
// -> { removed: ids that are gone, tooBig: folders left for the user, backup: backup folder or null }
async function removeLeftovers(list, { backupRoot, trash }) {
  const tooBig = [];
  const backup = path.join(backupRoot, 'leftovers-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  const keys = list.filter((it) => it.regKey && UNINSTALL_KEY_RE.test(it.regKey));
  if (keys.length) {
    fs.mkdirSync(backup, { recursive: true });
    for (const it of keys) await run('reg', ['export', it.regKey, path.join(backup, it.regKey.split('\\').pop().replace(/[^\w.-]+/g, '_') + '.reg'), '/y']);
    // per-user entries need no admin rights
    for (const it of keys.filter((k) => /^HKEY_CURRENT_USER/i.test(k.regKey))) await run('reg', ['delete', it.regKey, '/f']);
    // machine-wide entries: one elevated call, so Windows asks only once
    const machine = keys.filter((k) => /^HKEY_LOCAL_MACHINE/i.test(k.regKey));
    if (machine.length) {
      const cmdLine = '/c ' + machine.map((k) => `reg delete "${k.regKey}" /f`).join(' & ');
      await run('powershell.exe', psEncoded(`Start-Process cmd.exe -ArgumentList '${cmdLine.replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden`));
    }
  }
  const removed = new Set();
  for (const it of list) {
    let ok = true;
    if (it.regKey) ok = UNINSTALL_KEY_RE.test(it.regKey) && !(await regExists(it.regKey));
    // empty Steam folder of an uninstalled game -> Recycle Bin (can be restored)
    if (ok && it.source === 'steam' && it.installDir && /\\steamapps\\common\\[^\\]+\\?$/i.test(it.installDir) && fs.existsSync(it.installDir)) {
      if (dirSize(it.installDir, TRASH_LIMIT) > TRASH_LIMIT) {
        tooBig.push(it.installDir);
        continue;
      }
      try {
        await trash(it.installDir);
      } catch {
        ok = false;
      }
    }
    // a leftover with nothing we know how to remove (old cache entry) just drops off the list
    if (ok) removed.add(it.id);
  }
  return { removed, tooBig, backup: keys.length ? backup : null };
}

module.exports = { removeLeftovers };
