const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  scan: () => ipcRenderer.invoke('library:scan'),
  launch: (id) => ipcRenderer.invoke('item:launch', id),
  setOverride: (id, patch) => ipcRenderer.invoke('item:override', id, patch),
  openFolder: (id) => ipcRenderer.invoke('item:openFolder', id),
  uninstall: (id) => ipcRenderer.invoke('item:uninstall', id),
  icon: (id) => ipcRenderer.invoke('icon:get', id),
  hotkey: () => ipcRenderer.invoke('app:hotkey'),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  getLang: () => ipcRenderer.invoke('lang:get'),
  setLang: (l) => ipcRenderer.invoke('lang:set', l),
  saveShelves: (list) => ipcRenderer.invoke('shelves:save', list),
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
