// What the electron module's parts share: the app's identity, the window host once started, and what the host last reported.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DisplayInfo, HostMessage } from "../shared/protocol.ts";
import { host_environment, HostLink, rendering_mode, type RenderingMode } from "./host_link.ts";

// ============================================================================
// App identity
// ============================================================================

export interface AppInfo {
  app_path: string;
  name: string;
  version: string;
}

export function read_app_info(app_path: string): AppInfo {
  try {
    const manifest = JSON.parse(readFileSync(join(app_path, "package.json"), "utf8")) as { name?: string; productName?: string; version?: string };
    return { app_path, name: manifest.productName ?? manifest.name ?? "x-webview-app", version: manifest.version ?? "0.0.0" };
  } catch {
    return { app_path, name: "x-webview-app", version: "0.0.0" };
  }
}

export const app_info = read_app_info(process.env.X_WEBVIEW_APP_PATH ?? process.cwd());

// ============================================================================
// Ending the process
// ============================================================================

// How quitting ends the process; tests swap it so a quit does not end the test run.
export const process_control = { exit: (code: number): void => void process.exit(code) };

// ============================================================================
// Startup timing
// ============================================================================

const timing_wanted = process.env.X_WEBVIEW_TIMING === "1";

// With X_WEBVIEW_TIMING=1, logs how long after the process started each step of startup came.
export function mark(step: string): void {
  if (timing_wanted) console.error(`[x-webview] ${performance.now().toFixed(0).padStart(6)} ms  ${step}`);
}

// ============================================================================
// Host
// ============================================================================

// Cross-part news, such as the last window closing, which the app part acts on.
export const runtime_events = new EventEmitter();

export const host_state = {
  displays: [] as DisplayInfo[],
  system_dark: false,
  rendering: rendering_mode(process.env.X_WEBVIEW_RENDERING) as RenderingMode,
};

let link: HostLink | null = null;

export function has_host(): boolean {
  return link !== null;
}

// Starts the window host the first time anything needs a window.
export function host(): HostLink {
  if (link) return link;
  mark("starting the window host");
  link = new HostLink({
    gjs: process.env.X_WEBVIEW_GJS ?? "gjs",
    environment: host_environment(process.env, host_state.rendering, app_info.name),
  });
  link.ready.then(
    (ready) => {
      mark("window host ready");
      host_state.displays = ready.displays;
      host_state.system_dark = ready.system_dark;
    },
    () => undefined,
  );
  link.on("message", (message: HostMessage) => {
    if (message.type === "displays") host_state.displays = message.displays;
    if (message.type === "system_theme") host_state.system_dark = message.system_dark;
    runtime_events.emit("host_message", message);
  });
  link.on("exit", () => runtime_events.emit("host_exit"));
  return link;
}

export function stop_host(): void {
  link?.stop();
}
