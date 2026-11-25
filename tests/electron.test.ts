import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

// ============================================================================
// Setup
// ============================================================================

const scratch = await mkdtemp(join(tmpdir(), "x-webview-electron-"));
const host_log = join(scratch, "host.log");
process.env.X_WEBVIEW_GJS = fileURLToPath(new URL("./support/fake_host.mjs", import.meta.url));
process.env.FAKE_HOST_LOG = host_log;
process.env.X_WEBVIEW_APP_PATH = fileURLToPath(new URL("./fixtures/sample_app", import.meta.url));
process.env.XDG_CONFIG_HOME = join(scratch, "config");
process.env.XDG_RUNTIME_DIR = scratch;
process.env.XDG_CACHE_HOME = join(scratch, "cache");

const electron = await import("../src/node/electron.ts");
const { process_control } = await import("../src/node/runtime.ts");
const { answer_invoke } = await import("../src/node/windows.ts");
const { read_user_folder } = await import("../src/node/app.ts");
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, shell, Tray, webContents } = electron;

const exits: number[] = [];
process_control.exit = (code) => void exits.push(code);

async function host_messages(): Promise<{ type: string; [key: string]: unknown }[]> {
  const text = await readFile(host_log, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
}

beforeAll(async () => {
  // Electron quits when the last window closes unless the app listens, as these tests do between windows.
  app.on("window-all-closed", () => {});
  await app.whenReady();
});

// ============================================================================
// app
// ============================================================================

describe("app", () => {
  it("reads the app's identity and paths", () => {
    expect(app.isReady()).toBe(true);
    expect(app.getName()).toBe("sample-app");
    expect(app.getVersion()).toBe("1.2.3");
    expect(app.getPath("userData")).toBe(join(scratch, "config", "sample-app"));
    expect(app.getPath("logs")).toBe(join(scratch, "config", "sample-app", "logs"));
    expect(() => app.getPath("nowhere")).toThrow("Failed to get 'nowhere' path");

    app.setPath("downloads", "/data/downloads");

    expect(app.getPath("downloads")).toBe("/data/downloads");
    expect(app.isPackaged).toBe(false);
    expect(app.isHardwareAccelerationEnabled()).toBe(true);
  });

  it("reads translated user folders and falls back to English names", () => {
    expect(read_user_folder("music", "/nowhere", "/home/someone")).toBe("/home/someone/Music");
  });

  it("holds one copy: a second request in the same process keeps the lock", () => {
    expect(app.requestSingleInstanceLock()).toBe(true);
    expect(app.requestSingleInstanceLock()).toBe(true);
    expect(app.hasSingleInstanceLock()).toBe(true);
  });
});

// ============================================================================
// Windows
// ============================================================================

describe("BrowserWindow", () => {
  it("creates a window with its bundled preload and loads a file", async () => {
    const window = new BrowserWindow({ width: 500, height: 400, show: false, title: "Probe", webPreferences: { preload: fileURLToPath(new URL("./fixtures/sample_app/preload.mjs", import.meta.url)) } });
    const ready = new Promise((resolve) => window.once("ready-to-show", resolve));

    await window.loadFile("page.html");
    await ready;
    const messages = await host_messages();
    const created = messages.find((message) => message.type === "create_window" && message.window_id === window.id) as unknown as { settings: { preload_source: string; title: string } };

    expect(created.settings.title).toBe("Probe");
    expect(created.settings.preload_source).toContain("exposeInMainWorld");
    expect(window.webContents.getURL()).toMatch(/sample_app\/page\.html$/);
    expect(BrowserWindow.getAllWindows()).toContain(window);
    expect(BrowserWindow.fromId(window.id)).toBe(window);
    expect(BrowserWindow.fromWebContents(window.webContents)).toBe(window);
    expect(webContents.fromId(window.id)).toBe(window.webContents);
    window.destroy();
  });

  it("rejects a load that fails", async () => {
    const window = new BrowserWindow({ show: false });

    await expect(window.loadURL("file:///broken.html")).rejects.toThrow("Not found");
    window.destroy();
  });

  it("mirrors the host's reports so its getters answer at once", () => {
    const window = new BrowserWindow({ show: false });
    const seen: string[] = [];
    for (const name of ["resize", "move", "maximize", "unmaximize", "minimize", "restore", "show", "focus", "blur", "enter-full-screen"]) window.on(name, () => seen.push(name));

    window.host_event({ kind: "bounds", bounds: { x: 5, y: 6, width: 700, height: 800 } });
    window.host_event({ kind: "state", maximized: true, minimized: false, fullscreen: false, visible: true });
    window.host_event({ kind: "bounds", bounds: { x: 0, y: 0, width: 720, height: 1400 } });
    window.host_event({ kind: "focus", focused: true });

    expect(window.getBounds()).toEqual({ x: 0, y: 0, width: 720, height: 1400 });
    expect(window.getNormalBounds()).toEqual({ x: 5, y: 6, width: 700, height: 800 });
    expect(window.isMaximized()).toBe(true);
    expect(window.isFocused()).toBe(true);
    expect(BrowserWindow.getFocusedWindow()).toBe(window);

    window.host_event({ kind: "state", maximized: false, minimized: true, fullscreen: true, visible: true });
    window.host_event({ kind: "state", maximized: false, minimized: false, fullscreen: true, visible: true });
    window.host_event({ kind: "focus", focused: false });

    expect(seen).toEqual(["resize", "move", "maximize", "show", "resize", "move", "focus", "unmaximize", "minimize", "enter-full-screen", "restore", "blur"]);
    window.destroy();
  });

  it("titles the window from the page unless a listener prevents it", () => {
    const window = new BrowserWindow({ show: false });

    window.host_event({ kind: "title", title: "Page title" });
    window.once("page-title-updated", (event: { preventDefault(): void }) => event.preventDefault());
    window.host_event({ kind: "title", title: "Ignored" });

    expect(window.getTitle()).toBe("Page title");
    expect(window.webContents.getTitle()).toBe("Ignored");
    window.destroy();
  });

  it("closes unless a close listener prevents it, and says so once", () => {
    const window = new BrowserWindow({ show: false });
    const closed = vi.fn();
    window.on("closed", closed);

    window.once("close", (event: { preventDefault(): void }) => event.preventDefault());
    window.host_event({ kind: "close_requested" });
    const still_open = window.isDestroyed();
    window.close();
    window.host_event({ kind: "closed" });

    expect(still_open).toBe(false);
    expect(window.isDestroyed()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// IPC
// ============================================================================

describe("ipcMain", () => {
  it("answers invokes with Electron's wording for failures and missing handlers", async () => {
    const window = new BrowserWindow({ show: false });
    ipcMain.handle("probe:double", (_event, value: number) => value * 2);
    ipcMain.handleOnce("probe:fail", () => {
      throw new RangeError("too big");
    });

    expect(() => ipcMain.handle("probe:double", () => 0)).toThrow("second handler");
    expect(await answer_invoke(window.webContents, "probe:double", "[21]", "file:///page")).toEqual({ ok: true, payload: "42" });
    expect(await answer_invoke(window.webContents, "probe:fail", "[]", "file:///page")).toEqual({ ok: false, error: "RangeError: too big" });
    expect(await answer_invoke(window.webContents, "probe:fail", "[]", "file:///page")).toEqual({ ok: false, error: "Error: No handler registered for 'probe:fail'" });
    ipcMain.removeHandler("probe:double");
    window.destroy();
  });
});

// ============================================================================
// Desktop
// ============================================================================

describe("dialogs and shell", () => {
  it("passes dialogs to the host and shapes the answers as Electron does", async () => {
    const window = new BrowserWindow({ show: false });

    expect(await dialog.showSaveDialog(window, { defaultPath: "/tmp/tasks.csv" })).toEqual({ canceled: false, filePath: "/home/someone/Downloads/tasks.csv" });
    expect(await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] })).toEqual({ canceled: false, filePaths: ["/home/someone/notes.txt"] });
    expect(await dialog.showMessageBox({ message: "Sure?", buttons: ["No", "Yes"] })).toEqual({ response: 1, checkboxChecked: false });
    expect(() => dialog.showOpenDialogSync()).toThrow("asynchronous");
    expect(await shell.openPath("/missing")).toBe("No such file");
    expect(await shell.openPath("/present")).toBe("");
    await shell.openExternal("https://example.org");
    shell.showItemInFolder("/present");
    window.destroy();
  });
});

describe("theme, screens and the rest", () => {
  it("follows the host's dark setting until the app picks a theme", () => {
    const updated = vi.fn();
    nativeTheme.on("updated", updated);

    const system = nativeTheme.shouldUseDarkColors;
    nativeTheme.themeSource = "light";
    const light = nativeTheme.shouldUseDarkColors;
    nativeTheme.themeSource = "system";

    expect(system).toBe(true);
    expect(light).toBe(false);
    expect(updated).toHaveBeenCalledTimes(2);
  });

  it("answers screen questions from the host's displays", () => {
    expect(screen.getPrimaryDisplay().workArea).toEqual({ x: 0, y: 0, width: 720, height: 1400 });
    expect(screen.getAllDisplays()).toHaveLength(1);
    expect(screen.getDisplayNearestPoint({ x: 10, y: 10 }).scaleFactor).toBe(2);
  });

  it("keeps Electron's shape for parts a phone shell has no place for", async () => {
    const tray = new Tray(nativeImage.createFromPath("/icon.png").resize());
    const menu = Menu.buildFromTemplate([{ label: "Show", click: () => {} }, { type: "separator" }, { label: "More", submenu: [{ label: "Inner" }] }]);
    tray.setContextMenu();
    tray.destroy();
    const notification = new Notification({ title: "Hi", body: "There" });
    const shown = new Promise((resolve) => notification.once("show", resolve));
    notification.show();
    clipboard.writeText("written");

    expect(tray.isDestroyed()).toBe(true);
    expect(menu.items.map((item) => item.label)).toEqual(["Show", "", "More"]);
    expect(menu.items[2]?.submenu?.items[0]?.label).toBe("Inner");
    expect(nativeImage.createEmpty().isEmpty()).toBe(true);
    expect(powerMonitor.getSystemIdleTime()).toBe(0);
    expect(clipboard.readText()).toBe("written");
    expect(Notification.isSupported()).toBe(true);
    await shown;
  });
});

// ============================================================================
// Quitting
// ============================================================================

describe("quitting", () => {
  it("runs before-quit, will-quit and quit, then ends the process", async () => {
    const order: string[] = [];
    app.once("before-quit", () => order.push("before-quit"));
    app.once("will-quit", () => order.push("will-quit"));
    app.once("quit", () => order.push("quit"));
    new BrowserWindow({ show: false });

    app.quit();
    await vi.waitFor(() => expect(exits).toEqual([0]));

    expect(order).toEqual(["before-quit", "will-quit", "quit"]);
    expect(BrowserWindow.getAllWindows()).toEqual([]);
    expect((await host_messages()).at(-1)?.type).toBe("quit");
  });
});

describe("inert parts", () => {
  it("keeps Electron's shape for sessions, protocols, shortcuts, updates and storage", async () => {
    const { autoUpdater, globalShortcut, protocol, safeStorage, session, systemPreferences } = electron;

    expect(globalShortcut.register()).toBe(false);
    expect(protocol.registerFileProtocol()).toBe(false);
    expect(session.fromPartition()).toBe(session.defaultSession);
    await expect(session.defaultSession.clearCache()).resolves.toBeUndefined();
    expect(autoUpdater.getFeedURL()).toBe("");
    expect(systemPreferences.getAnimationSettings().prefersReducedMotion).toBe(false);
    expect(safeStorage.isEncryptionAvailable()).toBe(false);
    expect(() => safeStorage.encryptString()).toThrow("safeStorage");
    expect(app.getLoginItemSettings()).toEqual({ openAtLogin: false });
    expect(app.setAsDefaultProtocolClient()).toBe(false);
    expect(app.getGPUFeatureStatus()).toEqual({ gpu_compositing: "enabled" });
    expect(app.getLocaleCountryCode()).toBeTypeOf("string");
  });

  it("answers window questions a Wayland phone window has fixed answers to", () => {
    const window = new BrowserWindow({ show: false, x: 3, y: 4, width: 300, height: 200 });

    window.setTitle("Fixed");
    window.setBackgroundColor("#123456");
    window.setSize(320, 240);
    window.setBounds({ width: 330 });
    window.setMinimumSize(100, 100);
    window.maximize();
    window.unmaximize();
    window.minimize();
    window.restore();
    window.setFullScreen(true);
    window.hide();

    expect(window.getTitle()).toBe("Fixed");
    expect(window.getBackgroundColor()).toBe("#123456");
    expect(window.getPosition()).toEqual([3, 4]);
    expect(window.getSize()).toEqual([300, 200]);
    expect(window.getContentSize()).toEqual([300, 200]);
    expect(window.getContentBounds()).toEqual({ x: 3, y: 4, width: 300, height: 200 });
    expect(window.isVisible()).toBe(false);
    expect(window.isAlwaysOnTop()).toBe(false);
    expect(window.isResizable()).toBe(true);
    expect(window.getParentWindow()).toBeNull();
    expect(window.getChildWindows()).toEqual([]);
    window.destroy();
  });
});
