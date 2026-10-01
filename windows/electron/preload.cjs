const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'resolve', 'list', 'cloud', 'link', 'download', 'downloadFolder', 'downloadUrl', 'pause', 'resume', 'remove', 'openFile', 'showFile', 'login', 'saveCredential', 'logout', 'chooseDirectory', 'settings', 'clipboard', 'bookmark', 'removeBookmark', 'exportAuth', 'importAuth', 'xunleiSms', 'xunleiPassword', 'xunleiCode']);
contextBridge.exposeInMainWorld('yunx', {
  invoke: async (operation, payload = {}) => {
    if (!allowed.has(operation)) throw new Error('不支持的操作');
    const response = await ipcRenderer.invoke('yunx:invoke', operation, payload);
    if (response.error) throw new Error(response.error);
    return response.result;
  },
  onEvent: callback => {
    const listener = (_event, type, data) => callback(type, data);
    ipcRenderer.on('yunx:event', listener);
    return () => ipcRenderer.removeListener('yunx:event', listener);
  }
});
