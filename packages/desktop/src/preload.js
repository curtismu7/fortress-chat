const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: (payload) => ipcRenderer.send('fc:postMessage', payload),
  setState: () => {},
  getState: () => null,
}));

ipcRenderer.on('fc:message', (_event, payload) => {
  window.dispatchEvent(new MessageEvent('message', { data: payload }));
});

contextBridge.exposeInMainWorld('fortressAuth', {
  beginLogin: () => ipcRenderer.invoke('fc:auth-begin'),
  onStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('fc:auth-status', listener);
    return () => ipcRenderer.removeListener('fc:auth-status', listener);
  },
});
