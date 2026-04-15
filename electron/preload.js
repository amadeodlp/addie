/**
 * electron/preload.js
 *
 * Exposes a minimal, safe API from Electron to the renderer (UI).
 * Never expose nodeIntegration — use contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('addie', {
  pickContextFile:      () => ipcRenderer.invoke('pick-context-file'),
  getAppInfo:           () => ipcRenderer.invoke('get-app-info'),
  findAbletonPaths:     () => ipcRenderer.invoke('find-ableton-paths'),
  findUserLibraryPath:  () => ipcRenderer.invoke('find-user-library-path'),
  platform:             process.platform,
});
