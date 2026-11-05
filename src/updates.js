// Installed builds check GitHub releases, download in the background and install on restart.
// onStatus(status) gets every change; status = { status, version?, percent?, error?, current, enabled }.
function createUpdates({ app, onStatus }) {
  let state = { status: 'idle' };
  let updater = null;
  const status = () => ({ ...state, current: app.getVersion(), enabled: app.isPackaged });
  const set = (patch) => {
    state = { ...state, ...patch };
    onStatus(status());
  };

  function start() {
    if (!app.isPackaged || updater) return;
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('checking-for-update', () => set({ status: 'checking', error: null }));
    updater.on('update-available', (i) => set({ status: 'downloading', version: i.version, percent: 0 }));
    updater.on('update-not-available', () => set({ status: 'latest' }));
    updater.on('download-progress', (p) => set({ percent: Math.round(p.percent) }));
    updater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version }));
    updater.on('error', (e) => set({ status: 'error', error: String((e && e.message) || e).slice(0, 200) }));
    setTimeout(check, 10e3);
    setInterval(check, 6 * 3600e3);
  }
  // false when updates are off (running from source)
  const check = () => (updater ? updater.checkForUpdates().catch(() => {}) && true : false);
  // Only once an update is downloaded. Quits Shelf, installs silently and starts it again.
  function install() {
    if (!updater || state.status !== 'ready') return false;
    updater.quitAndInstall(true, true);
    return true;
  }

  return { start, check, install, status, readyVersion: () => (state.status === 'ready' ? state.version : null) };
}

module.exports = { createUpdates };
