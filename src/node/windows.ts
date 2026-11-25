// BrowserWindow, its webContents and ipcMain, each window drawn by the GJS host and mirrored here so Electron's synchronous getters answer at once.

import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { decode, encode } from "../shared/codec.ts";
import type { HostMessage, IpcReply, Rectangle, WindowCommand, WindowEvent } from "../shared/protocol.ts";
import { cached_preload } from "./preload.ts";
import { app_info, host, mark, runtime_events } from "./runtime.ts";

// ============================================================================
// Events
// ============================================================================

// An Electron event object: listeners may call preventDefault, and the emitter reads defaultPrevented afterwards.
export interface PreventableEvent {
  defaultPrevented: boolean;
  preventDefault(): void;
  [key: string]: unknown;
}

export function preventable(extra: Record<string, unknown> = {}): PreventableEvent {
  const event: PreventableEvent = {
    ...extra,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

// ============================================================================
// ipcMain
// ============================================================================

// Handlers name their own argument types, as Electron lets them.
type InvokeHandler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown;

export interface IpcMainInvokeEvent {
  sender: WebContents;
  senderFrame: { url: string; routingId: number; processId: number };
  frameId: number;
  processId: number;
  type: "frame";
}

export interface IpcMainEvent extends IpcMainInvokeEvent {
  returnValue: unknown;
  reply(channel: string, ...args: unknown[]): void;
}

export class IpcMain extends EventEmitter {
  #handlers = new Map<string, InvokeHandler>();

  handle(channel: string, handler: InvokeHandler): void {
    if (this.#handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.#handlers.set(channel, handler);
  }

  handleOnce(channel: string, handler: InvokeHandler): void {
    this.handle(channel, (event, ...args) => {
      this.removeHandler(channel);
      return handler(event, ...args);
    });
  }

  removeHandler(channel: string): void {
    this.#handlers.delete(channel);
  }

  handler(channel: string): InvokeHandler | undefined {
    return this.#handlers.get(channel);
  }
}

export const ipcMain = new IpcMain();

function invoke_event(contents: WebContents, url: string): IpcMainInvokeEvent {
  return { sender: contents, senderFrame: { url, routingId: 1, processId: 1 }, frameId: 1, processId: 1, type: "frame" };
}

// Runs one ipcRenderer.invoke and gives back the page's reply, with a failure's words as Electron words them.
export async function answer_invoke(contents: WebContents, channel: string, payload: string, url: string): Promise<IpcReply> {
  const handler = ipcMain.handler(channel);
  if (!handler) return { ok: false, error: `Error: No handler registered for '${channel}'` };
  try {
    const result = await handler(invoke_event(contents, url), ...(decode(payload) as never[]));
    return { ok: true, payload: encode(result) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

function deliver_send(contents: WebContents, channel: string, payload: string, url: string): void {
  const args = decode(payload) as unknown[];
  const event: IpcMainEvent = { ...invoke_event(contents, url), returnValue: undefined, reply: (reply_channel, ...reply_args) => contents.send(reply_channel, ...reply_args) };
  contents.emit("ipc-message", event, channel, ...args);
  ipcMain.emit(channel, event, ...args);
}

// ============================================================================
// webContents
// ============================================================================

type OpenHandlerResult = { action: "deny" } | { action: "allow"; overrideBrowserWindowOptions?: BrowserWindowOptions };
type OpenHandler = (details: { url: string; frameName: string; features: string; disposition: string; referrer: { url: string; policy: string } }) => OpenHandlerResult;

export class WebContents extends EventEmitter {
  readonly id: number;
  readonly session = { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {}, clearCache: async () => {}, clearStorageData: async () => {} };
  #window: BrowserWindow;
  #url = "";
  #title = "";
  #open_handler: OpenHandler | null = null;
  #developer_tools_open = false;

  constructor(window: BrowserWindow) {
    super();
    this.id = window.id;
    this.#window = window;
  }

  get window(): BrowserWindow {
    return this.#window;
  }

  update_url(url: string): void {
    this.#url = url;
  }

  update_title(title: string): void {
    this.#title = title;
  }

  open_handler(): OpenHandler | null {
    return this.#open_handler;
  }

  send(channel: string, ...args: unknown[]): void {
    this.#window.command({ kind: "send", channel, payload: encode(args) });
  }

  async loadURL(url: string): Promise<void> {
    const finished = new Promise<void>((resolve_load, reject_load) => {
      const on_finish = () => {
        this.off("did-fail-load", on_fail);
        resolve_load();
      };
      const on_fail = (_event: unknown, code: number, description: string, failed_url: string) => {
        this.off("did-finish-load", on_finish);
        reject_load(Object.assign(new Error(`${description} (${code}) loading '${failed_url}'`), { code, url: failed_url }));
      };
      this.once("did-finish-load", on_finish);
      this.once("did-fail-load", on_fail);
    });
    this.#window.command({ kind: "load_url", url });
    return finished;
  }

  loadFile(path: string, options: { query?: Record<string, string>; search?: string; hash?: string } = {}): Promise<void> {
    const url = pathToFileURL(resolve(app_info.app_path, path));
    if (options.query) for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
    if (options.search) url.search = options.search;
    if (options.hash) url.hash = options.hash;
    return this.loadURL(url.href);
  }

  getURL(): string {
    return this.#url;
  }

  getTitle(): string {
    return this.#title;
  }

  isLoading(): boolean {
    return false;
  }

  isDestroyed(): boolean {
    return this.#window.isDestroyed();
  }

  isCrashed(): boolean {
    return false;
  }

  reload(): void {
    this.#window.command({ kind: "reload" });
  }

  executeJavaScript(code: string): Promise<unknown> {
    return host().request({ kind: "execute_javascript", window_id: this.id, code });
  }

  insertCSS(css: string): Promise<string> {
    return this.executeJavaScript(`(() => { const style = document.createElement("style"); style.textContent = ${JSON.stringify(css)}; document.head.append(style); return ""; })()`) as Promise<string>;
  }

  setZoomFactor(factor: number): void {
    void this.executeJavaScript(`document.documentElement.style.zoom = ${JSON.stringify(String(factor))}`);
  }

  setWindowOpenHandler(handler: OpenHandler): void {
    this.#open_handler = handler;
  }

  openDevTools(): void {
    this.#developer_tools_open = true;
    this.#window.command({ kind: "open_developer_tools" });
  }

  closeDevTools(): void {
    this.#developer_tools_open = false;
  }

  toggleDevTools(): void {
    if (this.#developer_tools_open) this.closeDevTools();
    else this.openDevTools();
  }

  isDevToolsOpened(): boolean {
    return this.#developer_tools_open;
  }

  focus(): void {
    this.#window.focus();
  }

  getOSProcessId(): number {
    return 0;
  }

  setBackgroundThrottling(): void {}

  setAudioMuted(): void {}

  setUserAgent(): void {}
}

// ============================================================================
// BrowserWindow
// ============================================================================

export interface BrowserWindowOptions {
  title?: string;
  icon?: string | { toPNG?(): unknown; path?: string };
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  show?: boolean;
  fullscreen?: boolean;
  resizable?: boolean;
  backgroundColor?: string;
  webPreferences?: { preload?: string; devTools?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

interface WindowMirror {
  bounds: Rectangle;
  normal_bounds: Rectangle;
  maximized: boolean;
  minimized: boolean;
  fullscreen: boolean;
  visible: boolean;
  focused: boolean;
  destroyed: boolean;
  title: string;
  background: string;
}

const all_windows = new Map<number, BrowserWindow>();
let next_window_id = 1;
let focused_window: BrowserWindow | null = null;

function focus_moved(window: BrowserWindow, focused: boolean): void {
  if (focused) focused_window = window;
  else if (focused_window === window) focused_window = null;
}

function icon_path(icon: BrowserWindowOptions["icon"]): string | undefined {
  if (typeof icon === "string") return icon;
  return icon?.path;
}

export class BrowserWindow extends EventEmitter {
  readonly id: number;
  readonly webContents: WebContents;
  #mirror: WindowMirror;
  #created: Promise<void>;

  constructor(options: BrowserWindowOptions = {}) {
    super();
    this.id = next_window_id++;
    this.webContents = new WebContents(this);
    const bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 800, height: options.height ?? 600 };
    this.#mirror = {
      bounds,
      normal_bounds: bounds,
      maximized: false,
      minimized: false,
      fullscreen: options.fullscreen ?? false,
      visible: false,
      focused: false,
      destroyed: false,
      title: options.title ?? app_info.name,
      background: options.backgroundColor ?? "#ffffff",
    };
    all_windows.set(this.id, this);
    mark(`window ${this.id} requested`);
    this.#created = this.#create(options);
    if (options.show !== false) this.show();
    runtime_events.emit("window_created", this);
  }

  async #create(options: BrowserWindowOptions): Promise<void> {
    const link = host();
    let preload_source: string | undefined;
    const preload = options.webPreferences?.preload;
    if (preload) {
      try {
        preload_source = await cached_preload(preload);
        mark(`window ${this.id} preload ready`);
      } catch (error) {
        console.error(`X-WebView could not bundle the preload ${preload}:`, error);
      }
    }
    await link.ready;
    mark(`window ${this.id} created`);
    link.send({
      type: "create_window",
      window_id: this.id,
      settings: {
        title: this.#mirror.title,
        width: this.#mirror.bounds.width,
        height: this.#mirror.bounds.height,
        min_width: options.minWidth,
        min_height: options.minHeight,
        icon: icon_path(options.icon),
        background: options.backgroundColor,
        fullscreen: options.fullscreen,
        resizable: options.resizable,
        preload_source,
        developer_tools: options.webPreferences?.devTools !== false,
      },
    });
  }

  // Sends one order to the host once the window exists there, keeping the order they were given in.
  command(command: WindowCommand): void {
    if (this.#mirror.destroyed) return;
    void this.#created.then(() => host().send({ type: "window", window_id: this.id, command }), (error: unknown) => console.error(error));
  }

  // ── Host events ─────────────────────────────────────────────────────────────

  host_event(event: WindowEvent): void {
    const mirror = this.#mirror;
    switch (event.kind) {
      case "ready_to_show":
        mark(`window ${this.id} ready to show`);
        this.emit("ready-to-show");
        return;
      case "did_finish_load":
        mark(`window ${this.id} finished loading`);
        this.#report_page_timing();
        this.webContents.update_url(event.url);
        this.webContents.emit("dom-ready");
        this.webContents.emit("did-finish-load");
        return;
      case "did_fail_load":
        this.webContents.emit("did-fail-load", preventable(), -2, event.error, event.url, true);
        return;
      case "url":
        this.webContents.update_url(event.url);
        this.webContents.emit("did-navigate", preventable(), event.url);
        return;
      case "title": {
        this.webContents.update_title(event.title);
        const title_event = preventable();
        this.emit("page-title-updated", title_event, event.title);
        this.webContents.emit("page-title-updated", title_event, event.title);
        if (!title_event.defaultPrevented && event.title) this.setTitle(event.title);
        return;
      }
      case "close_requested":
        this.close();
        return;
      case "closed":
        this.#mark_closed();
        return;
      case "focus":
        mirror.focused = event.focused;
        focus_moved(this, event.focused);
        this.emit(event.focused ? "focus" : "blur");
        runtime_events.emit(event.focused ? "window_focus" : "window_blur", this);
        return;
      case "bounds": {
        const moved = event.bounds.x !== mirror.bounds.x || event.bounds.y !== mirror.bounds.y;
        const resized = event.bounds.width !== mirror.bounds.width || event.bounds.height !== mirror.bounds.height;
        mirror.bounds = event.bounds;
        if (!mirror.maximized && !mirror.fullscreen) mirror.normal_bounds = event.bounds;
        if (resized) this.emit("resize");
        if (moved) this.emit("move");
        return;
      }
      case "state": {
        const before = { ...mirror };
        Object.assign(mirror, { maximized: event.maximized, minimized: event.minimized, fullscreen: event.fullscreen, visible: event.visible });
        if (event.maximized !== before.maximized) this.emit(event.maximized ? "maximize" : "unmaximize");
        if (event.minimized !== before.minimized) this.emit(event.minimized ? "minimize" : "restore");
        if (event.fullscreen !== before.fullscreen) this.emit(event.fullscreen ? "enter-full-screen" : "leave-full-screen");
        if (event.visible !== before.visible) this.emit(event.visible ? "show" : "hide");
        return;
      }
      case "render_process_gone":
        this.webContents.emit("render-process-gone", preventable(), { reason: event.reason, exitCode: 0 });
        return;
    }
  }

  // The page's own clock, read once it has loaded, for X_WEBVIEW_TIMING.
  #report_page_timing(): void {
    if (process.env.X_WEBVIEW_TIMING !== "1") return;
    const read = `(() => { const n = performance.getEntriesByType("navigation")[0]; const paint = performance.getEntriesByName("first-contentful-paint")[0]; return { dom_ready: n?.domContentLoadedEventEnd, loaded: n?.loadEventEnd, first_paint: paint?.startTime, elements: document.querySelectorAll("*").length, text: document.body?.innerText.slice(0, 120), errors: globalThis.__x_webview_errors ?? [], viewport: [innerWidth, innerHeight, devicePixelRatio] }; })()`;
    setTimeout(() => void this.webContents.executeJavaScript(read).then((times) => console.error(`[x-webview] page clock for window ${this.id}: ${JSON.stringify(times)} ms after its navigation began`), () => undefined), 3000);
  }

  #mark_closed(): void {
    if (this.#mirror.destroyed) return;
    this.#mirror.destroyed = true;
    all_windows.delete(this.id);
    if (focused_window === this) focused_window = null;
    this.emit("closed");
    this.webContents.emit("destroyed");
    runtime_events.emit("window_closed", this);
  }

  // ── Static ──────────────────────────────────────────────────────────────────

  static getAllWindows(): BrowserWindow[] {
    return [...all_windows.values()];
  }

  static getFocusedWindow(): BrowserWindow | null {
    return focused_window;
  }

  static fromId(id: number): BrowserWindow | null {
    return all_windows.get(id) ?? null;
  }

  static fromWebContents(contents: WebContents): BrowserWindow | null {
    return contents.window.isDestroyed() ? null : contents.window;
  }

  // ── Showing ─────────────────────────────────────────────────────────────────

  show(): void {
    this.#mirror.visible = true;
    this.command({ kind: "show" });
  }

  showInactive(): void {
    this.show();
  }

  hide(): void {
    this.#mirror.visible = false;
    this.command({ kind: "hide" });
  }

  focus(): void {
    this.command({ kind: "focus" });
  }

  blur(): void {}

  // Asks the listeners first, as Electron does, and closes unless one of them prevents it.
  close(): void {
    if (this.#mirror.destroyed) return;
    const event = preventable();
    this.emit("close", event);
    if (!event.defaultPrevented) this.destroy();
  }

  destroy(): void {
    if (this.#mirror.destroyed) return;
    this.command({ kind: "destroy" });
    this.#mark_closed();
  }

  isDestroyed(): boolean {
    return this.#mirror.destroyed;
  }

  isVisible(): boolean {
    return this.#mirror.visible;
  }

  isFocused(): boolean {
    return this.#mirror.focused;
  }

  // ── State ───────────────────────────────────────────────────────────────────

  maximize(): void {
    this.command({ kind: "maximize" });
  }

  unmaximize(): void {
    this.command({ kind: "unmaximize" });
  }

  isMaximized(): boolean {
    return this.#mirror.maximized;
  }

  minimize(): void {
    this.command({ kind: "minimize" });
  }

  restore(): void {
    this.command({ kind: "restore" });
  }

  isMinimized(): boolean {
    return this.#mirror.minimized;
  }

  setFullScreen(fullscreen: boolean): void {
    this.command({ kind: "set_fullscreen", fullscreen });
  }

  isFullScreen(): boolean {
    return this.#mirror.fullscreen;
  }

  // ── Looks ───────────────────────────────────────────────────────────────────

  setTitle(title: string): void {
    this.#mirror.title = title;
    this.command({ kind: "set_title", title });
  }

  getTitle(): string {
    return this.#mirror.title;
  }

  setBackgroundColor(color: string): void {
    this.#mirror.background = color;
    this.command({ kind: "set_background", color });
  }

  getBackgroundColor(): string {
    return this.#mirror.background;
  }

  // ── Size and place ──────────────────────────────────────────────────────────

  getBounds(): Rectangle {
    return { ...this.#mirror.bounds };
  }

  getContentBounds(): Rectangle {
    return this.getBounds();
  }

  getNormalBounds(): Rectangle {
    return { ...this.#mirror.normal_bounds };
  }

  getSize(): [number, number] {
    return [this.#mirror.bounds.width, this.#mirror.bounds.height];
  }

  getContentSize(): [number, number] {
    return this.getSize();
  }

  getPosition(): [number, number] {
    return [this.#mirror.bounds.x, this.#mirror.bounds.y];
  }

  setSize(width: number, height: number): void {
    this.command({ kind: "set_size", width, height });
  }

  setContentSize(width: number, height: number): void {
    this.setSize(width, height);
  }

  setBounds(bounds: Partial<Rectangle>): void {
    this.setSize(bounds.width ?? this.#mirror.bounds.width, bounds.height ?? this.#mirror.bounds.height);
  }

  setMinimumSize(width: number, height: number): void {
    this.command({ kind: "set_min_size", width, height });
  }

  // Wayland leaves placing windows to the compositor, so these keep only Electron's shape.
  setPosition(): void {}

  center(): void {}

  // ── Pages ───────────────────────────────────────────────────────────────────

  loadURL(url: string): Promise<void> {
    return this.webContents.loadURL(url);
  }

  loadFile(path: string, options?: Parameters<WebContents["loadFile"]>[1]): Promise<void> {
    return this.webContents.loadFile(path, options);
  }

  reload(): void {
    this.webContents.reload();
  }

  // ── Parts a phone or a Wayland window does not have ────────────────────────

  removeMenu(): void {}

  setMenu(): void {}

  setMenuBarVisibility(): void {}

  setAutoHideMenuBar(): void {}

  setIcon(): void {}

  setAlwaysOnTop(): void {}

  isAlwaysOnTop(): boolean {
    return false;
  }

  setSkipTaskbar(): void {}

  setProgressBar(): void {}

  flashFrame(): void {}

  setOverlayIcon(): void {}

  setResizable(): void {}

  isResizable(): boolean {
    return true;
  }

  setClosable(): void {}

  getParentWindow(): BrowserWindow | null {
    return null;
  }

  getChildWindows(): BrowserWindow[] {
    return [];
  }

  getNativeWindowHandle(): Buffer {
    return Buffer.alloc(0);
  }
}

// ============================================================================
// Host messages
// ============================================================================

function respond_to_host(message: HostMessage): void {
  switch (message.type) {
    case "window_event":
      all_windows.get(message.window_id)?.host_event(message.event);
      return;
    case "ipc_invoke": {
      const window = all_windows.get(message.window_id);
      if (!window) return;
      void answer_invoke(window.webContents, message.channel, message.payload, message.url).then((reply) => host().send({ type: "ipc_reply", call_id: message.call_id, reply: JSON.stringify(reply) }));
      return;
    }
    case "ipc_send": {
      const window = all_windows.get(message.window_id);
      if (window) deliver_send(window.webContents, message.channel, message.payload, message.url);
      return;
    }
    case "will_navigate": {
      const window = all_windows.get(message.window_id);
      const event = preventable({ url: message.url });
      window?.webContents.emit("will-navigate", event, message.url);
      host().send({ type: "decide", decision_id: message.decision_id, allow: Boolean(window) && !event.defaultPrevented });
      return;
    }
    case "open_window": {
      host().send({ type: "decide", decision_id: message.decision_id, allow: false });
      const window = all_windows.get(message.window_id);
      const handler = window?.webContents.open_handler();
      const result = handler ? handler({ url: message.url, frameName: "", features: "", disposition: "foreground-tab", referrer: { url: window?.webContents.getURL() ?? "", policy: "default" } }) : { action: "allow" as const };
      if (result.action === "allow") {
        const opened = new BrowserWindow(result.overrideBrowserWindowOptions ?? {});
        void opened.loadURL(message.url).catch(() => undefined);
        window?.webContents.emit("did-create-window", opened, { url: message.url });
      }
      return;
    }
    default:
      return;
  }
}

runtime_events.on("host_message", respond_to_host);
