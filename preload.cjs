const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayAPI", {
  getCurrentUrl: () => ipcRenderer.invoke("get-current-url"),
  setUrl: (u) => ipcRenderer.invoke("set-url", u),
  closeWindow: () => ipcRenderer.invoke("close-window")
});
