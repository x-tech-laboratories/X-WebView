import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sample", {
  add: (first, second) => ipcRenderer.invoke("sample:add", first, second),
  date: (date) => ipcRenderer.invoke("sample:date", date),
  fail: () => ipcRenderer.invoke("sample:fail"),
  on_hello: (listener) => ipcRenderer.on("sample:hello", (_event, message) => listener(message)),
  done: (report) => ipcRenderer.send("sample:done", report),
});
