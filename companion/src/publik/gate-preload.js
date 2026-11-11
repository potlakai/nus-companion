'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('publikGate', {
  onScreen: (fn) => ipcRenderer.on('publik-gate:screen', (_e, v) => fn(v)),
  press: (action) => ipcRenderer.send('publik-gate:press', String(action)),
});
