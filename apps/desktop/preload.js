const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.squadflowDesktop = "true";
});

contextBridge.exposeInMainWorld("squadflowDesktopBrowser", {
  isAvailable: true,
  setLayout: (payload) => ipcRenderer.invoke("desktop-browser:set-layout", payload),
  setVisible: (visible) => ipcRenderer.invoke("desktop-browser:set-visible", Boolean(visible)),
  setBounds: (bounds) => ipcRenderer.invoke("desktop-browser:set-bounds", bounds),
  navigate: (url) => ipcRenderer.invoke("desktop-browser:navigate", url),
  goBack: () => ipcRenderer.invoke("desktop-browser:go-back"),
  goForward: () => ipcRenderer.invoke("desktop-browser:go-forward"),
  reload: () => ipcRenderer.invoke("desktop-browser:reload"),
  captureScreenshot: () => ipcRenderer.invoke("desktop-browser:capture-screenshot"),
  startElementPicker: (markerNumber) => ipcRenderer.invoke("desktop-browser:start-picker", markerNumber),
  stopElementPicker: () => ipcRenderer.invoke("desktop-browser:stop-picker"),
  reset: () => ipcRenderer.invoke("desktop-browser:reset"),
  setConfirmedMarkers: (markers) => ipcRenderer.invoke("desktop-browser:set-confirmed-markers", markers),
  clearElementPickerHover: () => ipcRenderer.invoke("desktop-browser:clear-picker-hover"),
  getState: () => ipcRenderer.invoke("desktop-browser:get-state"),
  reclaimLease: () => ipcRenderer.invoke("desktop-browser:reclaim-lease"),
  onState: (listener) => subscribe("desktop-browser:state", listener),
  onElementSelected: (listener) => subscribe("desktop-browser:selected-element", listener),
});

contextBridge.exposeInMainWorld("squadflowDesktopShell", {
  setTheme: (theme, resolvedTheme) => ipcRenderer.invoke("desktop-shell:set-theme", theme, resolvedTheme),
  toggleWindowZoom: () => ipcRenderer.invoke("desktop-shell:toggle-window-zoom"),
  showItemInFolder: (targetPath, isDirectory) => ipcRenderer.invoke("desktop-shell:show-item-in-folder", targetPath, Boolean(isDirectory)),
});

contextBridge.exposeInMainWorld("squadflowDesktopUpdate", {
  getState: () => ipcRenderer.invoke("desktop-update:get-state"),
  check: () => ipcRenderer.invoke("desktop-update:check"),
  setAutomaticUpdates: (enabled) => ipcRenderer.invoke("desktop-update:set-automatic", Boolean(enabled)),
  install: () => ipcRenderer.invoke("desktop-update:install"),
  onState: (listener) => subscribe("desktop-update:state", listener),
});
