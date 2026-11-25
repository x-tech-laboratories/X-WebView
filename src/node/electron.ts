// The electron module as an app's main process imports it, answered by X-WebView's parts.

import { app } from "./app.ts";
import { clipboard, dialog, nativeTheme, Notification, powerMonitor, screen, shell } from "./system.ts";
import { autoUpdater, contentTracing, crashReporter, globalShortcut, inAppPurchase, Menu, MenuItem, nativeImage, NativeImage, protocol, safeStorage, session, systemPreferences, Tray } from "./stubs.ts";
import { BrowserWindow, ipcMain, WebContents } from "./windows.ts";

export { app, autoUpdater, BrowserWindow, clipboard, contentTracing, crashReporter, dialog, globalShortcut, inAppPurchase, ipcMain, Menu, MenuItem, nativeImage, NativeImage, nativeTheme, Notification, powerMonitor, protocol, safeStorage, screen, session, shell, systemPreferences, Tray, WebContents };

export const webContents = {
  getAllWebContents: (): WebContents[] => BrowserWindow.getAllWindows().map((window) => window.webContents),
  getFocusedWebContents: (): WebContents | null => BrowserWindow.getFocusedWindow()?.webContents ?? null,
  fromId: (id: number): WebContents | undefined => BrowserWindow.fromId(id)?.webContents,
};

export default {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  contentTracing,
  crashReporter,
  dialog,
  globalShortcut,
  inAppPurchase,
  ipcMain,
  Menu,
  MenuItem,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  webContents,
};
