import { beforeAll, describe, expect, it, vi } from "vitest";

import { decode, encode } from "../src/shared/codec.ts";

// ============================================================================
// A page without a browser
// ============================================================================

type Posted = { kind: string; channel: string; payload: string };

const posted: Posted[] = [];
const page_listeners = new Map<string, (event: unknown) => void>();
const handlers: Record<string, (args: unknown[]) => unknown> = {
  "probe:add": ([first, second]) => (first as number) + (second as number),
};

function reply_to(message: Posted): string {
  if (message.kind === "send") return "null";
  const handler = handlers[message.channel];
  if (!handler) return JSON.stringify({ ok: false, error: `Error: No handler registered for '${message.channel}'` });
  return JSON.stringify({ ok: true, payload: encode(handler(decode(message.payload) as unknown[])) });
}

const fake_window = {
  webkit: {
    messageHandlers: {
      x_webview: {
        postMessage: async (text: string) => {
          const message = JSON.parse(text) as Posted;
          posted.push(message);
          return reply_to(message);
        },
      },
    },
  },
  addEventListener: (name: string, listener: (event: unknown) => void) => page_listeners.set(name, listener),
};

const style_nodes: { textContent: string }[] = [];
const fake_document = {
  documentElement: { style: { zoom: "" }, append: () => {} },
  head: { append: (node: { textContent: string }) => style_nodes.push(node) },
  createElement: () => ({ textContent: "" }),
};

let page: typeof import("../src/page/electron.ts");

beforeAll(async () => {
  Object.assign(globalThis, { window: fake_window, document: fake_document });
  page = await import("../src/page/electron.ts");
});

// ============================================================================
// Tests
// ============================================================================

describe("page side", () => {
  it("invokes the main process and words failures as Electron does", async () => {
    expect(await page.ipcRenderer.invoke("probe:add", 2, 3)).toBe(5);
    await expect(page.ipcRenderer.invoke("probe:missing")).rejects.toThrow("Error invoking remote method 'probe:missing': Error: No handler registered for 'probe:missing'");
    expect(() => page.ipcRenderer.sendSync()).toThrow("invoke");
  });

  it("sends messages and hears the main process's", () => {
    const heard = vi.fn();
    const once = vi.fn();
    page.ipcRenderer.on("probe:news", heard);
    page.ipcRenderer.once("probe:news", once);
    const receive = (globalThis as unknown as { __x_webview_receive: (channel: string, payload: string) => void }).__x_webview_receive;

    page.ipcRenderer.send("probe:ping", new Date(0));
    receive("probe:news", encode([{ count: 1 }]));
    receive("probe:news", encode([{ count: 2 }]));
    page.ipcRenderer.removeListener("probe:news", heard);
    receive("probe:news", encode([{ count: 3 }]));

    expect(posted.at(-1)).toMatchObject({ kind: "send", channel: "probe:ping" });
    expect(heard.mock.calls.map((call) => call[1])).toEqual([{ count: 1 }, { count: 2 }]);
    expect(once).toHaveBeenCalledTimes(1);
    expect(page.ipcRenderer.listenerCount("probe:news")).toBe(0);
  });

  it("puts exposed apis on the window, frozen, and once only", () => {
    page.contextBridge.exposeInMainWorld("probe_api", { value: 1 });

    expect((fake_window as unknown as { probe_api: { value: number } }).probe_api.value).toBe(1);
    expect(Object.isFrozen((fake_window as unknown as { probe_api: object }).probe_api)).toBe(true);
    expect(() => page.contextBridge.exposeInIsolatedWorld(1, "probe_api", {})).toThrow("existing property");
  });

  it("keeps the page's uncaught errors and zoom", () => {
    page_listeners.get("error")?.({ message: "boom", filename: "page.js", lineno: 3 });
    page_listeners.get("unhandledrejection")?.({ reason: "nope" });
    page.webFrame.setZoomLevel(1);
    page.webFrame.insertCSS("body { color: red }");

    expect((globalThis as unknown as { __x_webview_errors: string[] }).__x_webview_errors).toEqual(["boom at page.js:3", "unhandled rejection: nope"]);
    expect(page.webFrame.getZoomFactor()).toBeCloseTo(1.2);
    expect(page.webFrame.getZoomLevel()).toBeCloseTo(1);
    expect(style_nodes.at(-1)?.textContent).toBe("body { color: red }");
  });
});
