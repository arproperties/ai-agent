// The one bridge the two small windows get: a handful of asks to the main process. The page
// has no Node and no Electron of its own (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  today: () => ipcRenderer.invoke('today'),
  sendNow: () => ipcRenderer.invoke('send-now'),
  pair: (key) => ipcRenderer.invoke('pair', key),
  onRefresh: (fn) => ipcRenderer.on('refresh', fn),
});
