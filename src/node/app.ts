// Electron's app: its paths, its life from ready to quit, and the lock that keeps one copy running.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { app_info, has_host, host, host_state, runtime_events, stop_host } from "./runtime.ts";
import { BrowserWindow, preventable } from "./windows.ts";

// ============================================================================
// Paths
// ============================================================================

const user_folder_keys: Record<string, string> = {
  desktop: "XDG_DESKTOP_DIR",
  documents: "XDG_DOCUMENTS_DIR",
  downloads: "XDG_DOWNLOAD_DIR",
  music: "XDG_MUSIC_DIR",
  pictures: "XDG_PICTURES_DIR",
  videos: "XDG_VIDEOS_DIR",
};

const user_folder_defaults: Record<string, string> = {
  desktop: "Desktop",
  documents: "Documents",
  downloads: "Downloads",
  music: "Music",
  pictures: "Pictures",
  videos: "Videos",
};

// The desktop's own folder names from user-dirs.dirs, such as a translated Downloads.
export function read_user_folder(name: string, config_folder: string, home: string): string {
  const key = user_folder_keys[name];
  try {
    const text = readFileSync(join(config_folder, "user-dirs.dirs"), "utf8");
    const match = new RegExp(`^${key}="([^"]*)"`, "m").exec(text);
    if (match?.[1]) return match[1].replace("$HOME", home);
  } catch {
    // Without the file the usual English names stand.
  }
  return join(home, user_folder_defaults[name] ?? name);
}

const overridden_paths = new Map<string, string>();

function config_folder(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

function get_path(name: string): string {
  const overridden = overridden_paths.get(name);
  if (overridden) return overridden;
  const home = homedir();
  switch (name) {
    case "home":
      return home;
    case "appData":
      return config_folder();
    case "userData":
    case "sessionData":
      return overridden_paths.get("userData") ?? join(config_folder(), app_info.name);
    case "temp":
      return tmpdir();
    case "exe":
    case "module":
      return process.execPath;
    case "logs":
      return join(get_path("userData"), "logs");
    case "crashDumps":
      return join(get_path("userData"), "Crashpad");
    case "recent":
      return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "recently-used.xbel");
    default:
      if (name in user_folder_keys) return read_user_folder(name, config_folder(), home);
      throw new Error(`Failed to get '${name}' path`);
  }
}

// ============================================================================
// One copy
// ============================================================================

let lock_server: Server | null = null;
let lock_file: string | null = null;
let pending_handoff: Promise<void> | null = null;

function lock_paths(): { lock_file: string; socket: string } {
  const user_data = get_path("userData");
  return { lock_file: join(user_data, "X-WebViewLock"), socket: join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "x-webview", `${Buffer.from(user_data).toString("base64url").slice(-80)}.sock`) };
}

function is_running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Hands this launch's command line to the copy already running, which quits wait for.
function hand_over(socket: string, argv: string[], additional_data: unknown): void {
  pending_handoff = new Promise((resolve_handoff) => {
    const connection = createConnection(socket, () => connection.end(JSON.stringify({ argv, cwd: process.cwd(), additional_data })));
    connection.on("close", () => resolve_handoff());
    connection.on("error", () => resolve_handoff());
  });
}

function listen_for_launches(socket: string): void {
  mkdirSync(dirname(socket), { recursive: true });
  rmSync(socket, { force: true });
  lock_server = createServer((connection) => {
    let text = "";
    connection.on("data", (chunk) => (text += chunk.toString()));
    connection.on("end", () => {
      try {
        const launch = JSON.parse(text) as { argv: string[]; cwd: string; additional_data: unknown };
        app.emit("second-instance", preventable(), launch.argv, launch.cwd, launch.additional_data);
      } catch {
        // A garbled handoff is dropped.
      }
    });
  });
  lock_server.listen(socket);
  lock_server.unref();
}

function request_single_instance_lock(additional_data?: unknown): boolean {
  if (lock_file) return true;
  const paths = lock_paths();
  mkdirSync(dirname(paths.lock_file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(paths.lock_file, String(process.pid), { flag: "wx" });
      lock_file = paths.lock_file;
      listen_for_launches(paths.socket);
      process.on("exit", release_single_instance_lock);
      return true;
    } catch {
      const holder = Number(readFileSync(paths.lock_file, "utf8"));
      if (holder && holder !== process.pid && is_running(holder)) {
        hand_over(paths.socket, process.argv, additional_data);
        return false;
      }
      rmSync(paths.lock_file, { force: true });
    }
  }
  return false;
}

function release_single_instance_lock(): void {
  if (lock_file) rmSync(lock_file, { force: true });
  lock_file = null;
  lock_server?.close();
  lock_server = null;
}

// ============================================================================
// Life
// ============================================================================

let is_ready = false;
let is_quitting = false;
let ready_promise: Promise<void> | null = null;

// Starts the window host and says ready once it is, the moment anything waits for ready.
function start(): Promise<void> {
  ready_promise ??= host().ready.then(
    () => {
      is_ready = true;
      app.emit("ready", preventable(), {});
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
  return ready_promise;
}

function finish(code: number): void {
  release_single_instance_lock();
  if (has_host()) stop_host();
  void (pending_handoff ?? Promise.resolve()).then(() => process.exit(code));
}

function quit(): void {
  if (is_quitting) return;
  const before = preventable();
  app.emit("before-quit", before);
  if (before.defaultPrevented) return;
  is_quitting = true;
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  const will_quit = preventable();
  app.emit("will-quit", will_quit);
  if (will_quit.defaultPrevented) {
    is_quitting = false;
    return;
  }
  app.emit("quit", preventable(), 0);
  finish(0);
}

function exit(code = 0): void {
  is_quitting = true;
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  finish(code);
}

runtime_events.on("window_closed", () => {
  if (is_quitting || BrowserWindow.getAllWindows().length > 0) return;
  if (app.listenerCount("window-all-closed") === 0) quit();
  else app.emit("window-all-closed");
});
runtime_events.on("window_created", (window: BrowserWindow) => app.emit("browser-window-created", preventable(), window));
runtime_events.on("window_focus", (window: BrowserWindow) => app.emit("browser-window-focus", preventable(), window));
runtime_events.on("window_blur", (window: BrowserWindow) => app.emit("browser-window-blur", preventable(), window));
runtime_events.on("host_exit", () => {
  if (!is_quitting) exit(0);
});

// ============================================================================
// app
// ============================================================================

type Listener = Parameters<EventEmitter["on"]>[1];

export class App extends EventEmitter {
  readonly commandLine = {
    appendSwitch: () => {},
    appendArgument: () => {},
    hasSwitch: () => false,
    getSwitchValue: () => "",
    removeSwitch: () => {},
  };
  accessibilitySupportEnabled = false;
  userAgentFallback = "Mozilla/5.0 (X11; Linux) AppleWebKit/605.1.15 (KHTML, like Gecko) X-WebView";
  #name = app_info.name;

  get name(): string {
    return this.#name;
  }

  set name(name: string) {
    this.#name = name;
  }

  get isPackaged(): boolean {
    return process.env.X_WEBVIEW_PACKAGED === "1";
  }

  override on(event: string | symbol, listener: Listener): this {
    super.on(event, listener);
    if (event === "ready") void start();
    return this;
  }

  override once(event: string | symbol, listener: Listener): this {
    super.once(event, listener);
    if (event === "ready") void start();
    return this;
  }

  whenReady(): Promise<void> {
    return start();
  }

  isReady(): boolean {
    return is_ready;
  }

  quit(): void {
    quit();
  }

  exit(code?: number): void {
    exit(code);
  }

  relaunch(options: { args?: string[]; execPath?: string } = {}): void {
    const command = options.execPath ?? process.execPath;
    const args = options.args ?? process.argv.slice(1);
    process.once("exit", () => spawn(command, args, { detached: true, stdio: "ignore" }).unref());
  }

  focus(): void {
    BrowserWindow.getAllWindows()[0]?.focus();
  }

  hide(): void {}

  show(): void {}

  getName(): string {
    return this.#name;
  }

  setName(name: string): void {
    this.#name = name;
  }

  getVersion(): string {
    return app_info.version;
  }

  getAppPath(): string {
    return app_info.app_path;
  }

  getPath(name: string): string {
    return get_path(name);
  }

  setPath(name: string, path: string): void {
    overridden_paths.set(name, path);
  }

  getLocale(): string {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  }

  getSystemLocale(): string {
    return this.getLocale();
  }

  getPreferredSystemLanguages(): string[] {
    return [this.getLocale()];
  }

  getLocaleCountryCode(): string {
    return this.getLocale().split("-")[1] ?? "";
  }

  requestSingleInstanceLock(additional_data?: unknown): boolean {
    return request_single_instance_lock(additional_data);
  }

  hasSingleInstanceLock(): boolean {
    return lock_file !== null;
  }

  releaseSingleInstanceLock(): void {
    release_single_instance_lock();
  }

  // Turns the GPU off for this run's windows, as Electron does when called before ready.
  disableHardwareAcceleration(): void {
    if (!has_host()) host_state.rendering = "software";
  }

  isHardwareAccelerationEnabled(): boolean {
    return host_state.rendering !== "software";
  }

  setAppUserModelId(): void {}

  setAsDefaultProtocolClient(): boolean {
    return false;
  }

  isDefaultProtocolClient(): boolean {
    return false;
  }

  removeAsDefaultProtocolClient(): boolean {
    return false;
  }

  setLoginItemSettings(): void {}

  getLoginItemSettings(): { openAtLogin: boolean } {
    return { openAtLogin: false };
  }

  setBadgeCount(): boolean {
    return false;
  }

  getBadgeCount(): number {
    return 0;
  }

  enableSandbox(): void {}

  getGPUFeatureStatus(): Record<string, string> {
    return { gpu_compositing: host_state.rendering === "software" ? "disabled_software" : "enabled" };
  }

  getAppMetrics(): unknown[] {
    return [];
  }

  setAboutPanelOptions(): void {}

  addRecentDocument(): void {}

  clearRecentDocuments(): void {}
}

export const app = new App();
