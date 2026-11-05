// Small helpers for running PowerShell and other Windows tools without a console window
const { execFile } = require('child_process');

const psEncoded = (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// Runs a script that prints JSON; null on any error
const psJson = (script) =>
  new Promise((resolve) =>
    execFile('powershell.exe', psEncoded(script), { windowsHide: true, timeout: 15e3 }, (err, out) => {
      try {
        resolve(err ? null : JSON.parse(String(out)));
      } catch {
        resolve(null);
      }
    })
  );

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 120e3 }, (err, out) => resolve({ ok: !err, out: String(out || '') })));

module.exports = { psEncoded, psQuote, psJson, run };
