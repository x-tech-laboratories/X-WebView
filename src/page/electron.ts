// The page's side of Electron: ipcRenderer, contextBridge and webFrame, bundled into each preload in place of the electron module.

import { decode, encode } from "../shared/codec.ts";

// ============================================================================
// Host link
// ============================================================================

interface MessageHandler {
  postMessage(message: string): Promise<unknown>;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: Record<string, MessageHandler | undefined> };
  }
}

type Listener = (event: IpcRendererEvent, ...args: unknown[]) => void;

export interface IpcRendererEvent {
  sender: typeof ipcRenderer;
  senderId: number;
  ports: unknown[];
}

function host(): MessageHandler {
  const handler = window.webkit?.messageHandlers?.x_webview;
  if (!handler) throw new Error("X-WebView: this page has no link to its window host.");
  return handler;
}

async function post(message: { kind: "invoke" | "send"; channel: string; payload: string }): Promise<string> {
  return String(await host().postMessage(JSON.stringify(message)));
}

// ============================================================================
// ipcRenderer
// ============================================================================

const listeners = new Map<string, Listener[]>();

function add_listener(channel: string, listener: Listener): void {
  listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
}

function remove_listener(channel: string, listener: Listener): void {
  const remaining = (listeners.get(channel) ?? []).filter((entry) => entry !== listener && (entry as { original?: Listener }).original !== listener);
  if (remaining.length) listeners.set(channel, remaining);
  else listeners.delete(channel);
}

export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const reply = JSON.parse(await post({ kind: "invoke", channel, payload: encode(args) })) as { ok: true; payload: string } | { ok: false; error: string };
    if (!reply.ok) throw new Error(`Error invoking remote method '${channel}': ${reply.error}`);
    return decode(reply.payload);
  },
  send(channel: string, ...args: unknown[]): void {
    void post({ kind: "send", channel, payload: encode(args) });
  },
  sendSync(): never {
    throw new Error("X-WebView has no ipcRenderer.sendSync; use ipcRenderer.invoke.");
  },
  postMessage(channel: string, message: unknown): void {
    ipcRenderer.send(channel, message);
  },
  on(channel: string, listener: Listener) {
    add_listener(channel, listener);
    return ipcRenderer;
  },
  addListener(channel: string, listener: Listener) {
    return ipcRenderer.on(channel, listener);
  },
  once(channel: string, listener: Listener) {
    const once_listener: Listener & { original?: Listener } = (event, ...args) => {
      remove_listener(channel, once_listener);
      listener(event, ...args);
    };
    once_listener.original = listener;
    add_listener(channel, once_listener);
    return ipcRenderer;
  },
  off(channel: string, listener: Listener) {
    remove_listener(channel, listener);
    return ipcRenderer;
  },
  removeListener(channel: string, listener: Listener) {
    return ipcRenderer.off(channel, listener);
  },
  removeAllListeners(channel?: string) {
    if (channel === undefined) listeners.clear();
    else listeners.delete(channel);
    return ipcRenderer;
  },
  listenerCount(channel: string): number {
    return listeners.get(channel)?.length ?? 0;
  },
};

// The host calls this with each message the main process sends to the page.
function receive(channel: string, payload: string): void {
  const args = decode(payload) as unknown[];
  const event: IpcRendererEvent = { sender: ipcRenderer, senderId: 0, ports: [] };
  for (const listener of listeners.get(channel) ?? []) {
    try {
      listener(event, ...args);
    } catch (error) {
      console.error(error);
    }
  }
}

Object.defineProperty(globalThis, "__x_webview_receive", { value: receive, configurable: false, enumerable: false, writable: false });

// ============================================================================
// Errors
// ============================================================================

// The page's last uncaught errors, which X_WEBVIEW_TIMING reports, since WebKit shows them only in its inspector.
const page_errors: string[] = [];

function keep_error(text: string): void {
  page_errors.push(text);
  if (page_errors.length > 20) page_errors.shift();
}

window.addEventListener("error", (event) => keep_error(`${event.message} at ${event.filename}:${event.lineno}`));
window.addEventListener("unhandledrejection", (event) => keep_error(`unhandled rejection: ${event.reason instanceof Error ? `${event.reason.message}\n${event.reason.stack ?? ""}` : String(event.reason)}`));
Object.defineProperty(globalThis, "__x_webview_errors", { value: page_errors, configurable: false, enumerable: false });

// ============================================================================
// contextBridge
// ============================================================================

// The preload runs in the page's own world, so an exposed api goes straight onto window, frozen as Electron's copy would be.
function expose(api_key: string, api: unknown): void {
  if (api_key in window) throw new Error(`Cannot bind an API on top of an existing property on the window object: ${api_key}`);
  Object.defineProperty(window, api_key, { value: Object.freeze(api), configurable: false, enumerable: true, writable: false });
}

export const contextBridge = {
  exposeInMainWorld: expose,
  exposeInIsolatedWorld: (_world_id: number, api_key: string, api: unknown) => expose(api_key, api),
};

// ============================================================================
// webFrame and webUtils
// ============================================================================

let zoom_factor = 1;

export const webFrame = {
  getZoomFactor: () => zoom_factor,
  setZoomFactor(factor: number) {
    zoom_factor = factor;
    document.documentElement.style.zoom = String(factor);
  },
  getZoomLevel: () => Math.log(zoom_factor) / Math.log(1.2),
  setZoomLevel: (level: number) => webFrame.setZoomFactor(1.2 ** level),
  setVisualZoomLevelLimits: () => Promise.resolve(),
  insertCSS(css: string): string {
    const style = document.createElement("style");
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);
    return String(Date.now());
  },
};

export const webUtils = {
  getPathForFile: (file: File): string => (file as File & { path?: string }).path ?? "",
};

export default { ipcRenderer, contextBridge, webFrame, webUtils };
