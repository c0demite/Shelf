const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  scan: () => ipcRenderer.invoke('library:scan'),
  launch: (id) => ipcRenderer.invoke('item:launch', id),
  setOverride: (id, patch) => ipcRenderer.invoke('item:override', id, patch),
  openFolder: (id) => ipcRenderer.invoke('item:openFolder', id),
  uninstall: (id) => ipcRenderer.invoke('item:uninstall', id),
  icon: (id) => ipcRenderer.invoke('icon:get', id),
  hotkey: () => ipcRenderer.invoke('app:hotkey'),
  copyDiagnostics: () => ipcRenderer.invoke('diag:copy'),
  reportProblem: () => ipcRenderer.invoke('diag:report'),
  getPlainQuick: () => ipcRenderer.invoke('quick:plain:get'),
  setPlainQuick: (on) => ipcRenderer.invoke('quick:plain:set', on),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  getLang: () => ipcRenderer.invoke('lang:get'),
  setLang: (l) => ipcRenderer.invoke('lang:set', l),
  launchShelf: (id) => ipcRenderer.invoke('shelf:launch', id),
  saveShelves: (list) => ipcRenderer.invoke('shelves:save', list),
  removeLeftovers: (ids) => ipcRenderer.invoke('leftover:remove', ids),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  pickToAdd: () => ipcRenderer.invoke('add:pick'),
  inspectFile: (f) => ipcRenderer.invoke('add:inspect', f),
  addItem: (data) => ipcRenderer.invoke('add:save', data),
  removeItem: (id) => ipcRenderer.invoke('item:remove', id),
  pathForFile: (file) => webUtils.getPathForFile(file),
  searchCovers: (q) => ipcRenderer.invoke('cover:search', q),
  setCover: (id, choice) => ipcRenderer.invoke('cover:set', id, choice),
  setTheme: (t) => ipcRenderer.invoke('theme:set', t),
  quickResize: (h) => ipcRenderer.invoke('quick:resize', h),
  quickHide: () => ipcRenderer.invoke('quick:hide'),
  openMain: () => ipcRenderer.invoke('quick:openMain'),
  on: (channel, cb) => {
    const f = (_e, d) => cb(d);
    ipcRenderer.on(channel, f);
    return () => ipcRenderer.removeListener(channel, f);
  },
});
