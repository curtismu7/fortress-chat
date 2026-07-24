const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: (payload) => ipcRenderer.send('fc:postMessage', payload),
  setState: () => {},
  getState: () => null,
}));

ipcRenderer.on('fc:message', (_event, payload) => {
  window.dispatchEvent(new MessageEvent('message', { data: payload }));
});
