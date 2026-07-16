const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__squadflowBrowserPicker", {
  select: (payload) => ipcRenderer.invoke("desktop-browser:element-selected", payload),
});
