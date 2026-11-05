// The global shortcut that opens quick search.
// The user may choose their own; otherwise the first free one of the defaults is used
// (Ctrl+Space is often taken by the keyboard-language switcher).
// register(accelerator, fn) -> true if it worked; unregister(accelerator). Electron's globalShortcut fits.
function createHotkey({ register, unregister, defaults, onPress }) {
  let current = null; // registered now
  let chosen = null; // the user's own choice, if any
  let taken = false; // the user's choice could not be registered

  const tryKey = (k) => {
    try {
      return !!register(k, onPress);
    } catch {
      return false; // Electron throws on an accelerator it can't parse
    }
  };
  const release = () => {
    if (current) unregister(current);
    current = null;
  };
  function claim() {
    release();
    taken = false;
    if (chosen) {
      if (tryKey(chosen)) return (current = chosen);
      taken = true;
    }
    current = defaults.find(tryKey) || null;
    return current;
  }

  return {
    // own: the saved choice, or null for the defaults
    start(own) {
      chosen = own || null;
      claim();
    },
    // null goes back to the defaults. False if the shortcut is taken; the old one then keeps working.
    choose(own) {
      if (own && own === current) {
        chosen = own;
        taken = false;
        return true;
      }
      if (own) {
        if (!tryKey(own)) return false;
        release();
        current = chosen = own;
        taken = false;
        return true;
      }
      chosen = null;
      claim();
      return true;
    },
    // while a new shortcut is being recorded, so pressing the old one doesn't open the window
    pause: release,
    resume: claim,
    info: () => ({ current, chosen, taken }),
  };
}

module.exports = { createHotkey };
