// A small Electron app the smoke test runs: it answers the page's calls and reports what the page saw.
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";

ipcMain.handle("sample:add", (_event, first, second) => first + second);
ipcMain.handle("sample:date", (_event, date) => ({ is_date: date instanceof Date, year: date.getFullYear() }));
ipcMain.handle("sample:fail", () => { throw new Error("planned failure"); });

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { preload: join(import.meta.dirname, "preload.mjs") } });
  window.once("ready-to-show", () => window.show());
  window.webContents.on("did-finish-load", () => window.webContents.send("sample:hello", { greeting: "hi", when: new Date(0) }));
  ipcMain.on("sample:done", async (_event, report) => {
    const title = await window.webContents.executeJavaScript("document.title");
    console.log(JSON.stringify({ report, title, app: { name: app.getName(), version: app.getVersion(), electron: process.versions.electron } }));
    app.quit();
  });
  void window.loadFile("page.html");
});
