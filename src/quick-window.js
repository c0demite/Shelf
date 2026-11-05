// The Spotlight-style quick launcher window (Ctrl+Space).
// Without GPU compositing (virtual machines, remote desktop, hardware acceleration off) Windows draws a
// transparent window on a dark box, and some PCs do it even with a GPU. Then the launcher is a plain
// window the size of the panel: automatically, or because the user turned it on in the settings.
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');

const QUICK_W = 720; // includes room for the panel shadow
const PAD = { w: 48, h: 52 }; // that room: body padding around the panel
const MAX_PANEL = 568; // tallest the results panel gets

// opts: icon, webPreferences, debug (screenshot run: never hide on blur, ignore the GPU),
// plainForced() (the user asked for the plain window), isDark(), isQuitting(), onCreate(win)
function createQuickWindow(opts) {
  let win = null;
  let plain = false;
  let gpuKnown = false; // Chromium tells us ~150 ms after start; before that it reads as off

  const alive = () => !!win && !win.isDestroyed();
  const width = () => (plain ? QUICK_W - PAD.w : QUICK_W);
  const panelColor = () => (opts.isDark() ? '#1c1916' : '#fbfaf6'); // --paper in quick.css

  // GPU compositing: true / false, or null while unknown
  function gpuOn() {
    if (!gpuKnown) return null;
    try {
      return String(app.getGPUFeatureStatus().gpu_compositing || '').startsWith('enabled');
    } catch {
      return null;
    }
  }
  function canBeTransparent() {
    if (opts.plainForced()) return false;
    if (opts.debug || process.platform !== 'win32') return true;
    return gpuOn() !== false;
  }

  function create() {
    plain = !canBeTransparent();
    win = new BrowserWindow({
      width: width(),
      height: 72,
      frame: false,
      transparent: !plain,
      ...(plain ? { backgroundColor: panelColor() } : {}),
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      icon: opts.icon,
      webPreferences: opts.webPreferences,
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'quick.html'), plain ? { query: { plain: '1' } } : undefined);
    win.on('blur', () => !opts.debug && hide());
    win.on('close', (e) => {
      if (!opts.isQuitting()) {
        e.preventDefault();
        hide();
      }
    });
    opts.onCreate?.(win);
    return win;
  }
  // Only while hidden, so the user never sees it swap
  function rebuildIfNeeded(force) {
    if (!alive() || win.isVisible()) return;
    if (force || !canBeTransparent() !== plain) {
      win.destroy();
      create();
    }
  }

  function show() {
    if (!opts.debug) rebuildIfNeeded();
    if (!alive()) create();
    // Open on the screen where the mouse is, a bit above the middle
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setPosition(Math.round(d.x + (d.width - width()) / 2), Math.round(d.y + d.height * 0.22));
    if (plain) win.setBackgroundColor(panelColor()); // theme may have changed
    win.webContents.send('quick:open');
    win.show();
    win.focus();
  }
  function hide() {
    if (alive() && win.isVisible()) win.hide();
  }
  function toggle() {
    if (alive() && win.isVisible() && win.isFocused()) hide();
    else show();
  }
  // h = height of the panel itself
  function resize(h) {
    if (!alive()) return;
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width: width(), height: Math.max(48, Math.min(MAX_PANEL, Math.round(h))) + (plain ? 0 : PAD.h) });
  }

  return {
    create,
    show,
    hide,
    toggle,
    resize,
    gpuOn,
    // Chromium reported the real GPU state
    gpuReady() {
      gpuKnown = true;
      if (!opts.debug) rebuildIfNeeded();
    },
    // the plain-window setting changed
    settingChanged: () => rebuildIfNeeded(true),
  };
}

module.exports = { createQuickWindow };
