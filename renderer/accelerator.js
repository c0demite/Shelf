// Turns a key press into a global shortcut (an Electron accelerator like "Control+Alt+K").
// Used by the settings window while recording a new shortcut (as a script) and by the tests (as a module).
(function (root) {
  const MODIFIER = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
  // Shortcuts every program uses – taking them over would break typing everywhere
  const RESERVED = new Set(['Alt+F4', ...'ACFNOPSVWXYZ'.split('').map((k) => 'Control+' + k)]);

  // Windows matches letters by the keyboard layout, so a letter is the one on the key (e.key).
  // Non-Latin layouts (Cyrillic, Greek) give no Latin letter – then the key position (e.code) decides.
  function keyName(code, key) {
    let m;
    if (/^Key[A-Z]$/.test(code)) return /^[a-z]$/i.test(key || '') ? key.toUpperCase() : code.slice(3);
    if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    if (code === 'Space') return 'Space';
    return null;
  }

  // e: a keydown event (code, key, ctrlKey, altKey, shiftKey, metaKey)
  // -> { accelerator } | { error: 'modifier' | 'windows' | 'key' | 'types' | 'reserved' } | { cancel: true }
  //    | null while only modifiers are held
  function fromKey(e) {
    if (e.code === 'Escape') return { cancel: true };
    if (MODIFIER.test(e.code)) return null;
    if (e.metaKey) return { error: 'windows' };
    const key = keyName(e.code, e.key);
    if (!key) return { error: 'key' };
    if (!e.ctrlKey && !e.altKey) return { error: 'modifier' };
    // Ctrl+Alt is the right Alt key. Taking Ctrl+Alt+A would stop ą working on a Polish keyboard (also when the
    // shortcut is recorded on another layout), and keys that type ą, ę or € on this layout are out too
    const altGr = /^[ACELNOSXZ]$/.test(key) || /^([^\p{L}\p{N}\s]|[\u00c0-\u024f\u1e00-\u1eff])$/u.test(e.key || '');
    if (e.ctrlKey && e.altKey && altGr) return { error: 'types' };
    // Alt + a letter, digit or Space opens menus in programs
    if (e.altKey && !e.ctrlKey && !e.shiftKey && /^([A-Z0-9]|Space)$/.test(key)) return { error: 'reserved' };
    const acc = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
    return RESERVED.has(acc) ? { error: 'reserved' } : { accelerator: acc };
  }

  const api = { fromKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Accelerator = api;
})(this);
