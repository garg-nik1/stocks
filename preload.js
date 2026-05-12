const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stockAPI', {
  fetchQuotes: (symbols) => ipcRenderer.invoke('fetch-quotes', symbols),
  search:      (query)   => ipcRenderer.invoke('search', query),
  fetchMovers: (region, scrId, count) => ipcRenderer.invoke('fetch-movers', region, scrId, count),
});
