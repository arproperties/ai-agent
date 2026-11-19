// The one bridge the small windows get: a handful of asks to the main process. The pages
// have no Node and no Electron of their own (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  today: () => ipcRenderer.invoke('today'),
  sendNow: () => ipcRenderer.invoke('send-now'),
  pair: (key) => ipcRenderer.invoke('pair', key),
  onRefresh: (fn) => ipcRenderer.on('refresh', fn),
  // Buddy on the desktop: its mood, character and line; a click opens the sheet, a right-click the menu.
  buddyState: () => ipcRenderer.invoke('buddy-state'),
  onBuddy: (fn) => ipcRenderer.on('buddy', (_e, state) => fn(state)),
  buddyClick: () => ipcRenderer.send('buddy-click'),
  buddyMenu: () => ipcRenderer.send('buddy-menu'),
});
