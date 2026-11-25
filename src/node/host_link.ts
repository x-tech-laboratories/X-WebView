// The main process's line to the GJS window host: starts it, sends it orders and hands its messages on.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { DisplayInfo, HostMessage, HostRequest, MainMessage } from "../shared/protocol.ts";

// ============================================================================
// Rendering
// ============================================================================

export type RenderingMode = "hybrid" | "gpu" | "software";

export function rendering_mode(value: string | undefined): RenderingMode {
  return value === "gpu" || value === "software" ? value : "hybrid";
}

// The host's environment for a rendering mode: hybrid draws pages on the CPU and composites them on the GPU, which measured fastest on GLES 2.0 phones.
export function host_environment(base: NodeJS.ProcessEnv, mode: RenderingMode, app_name: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, X_WEBVIEW_RENDERING: mode, X_WEBVIEW_APP_NAME: app_name, X_WEBVIEW_APP_ID: app_name };
  if (mode === "software") {
    environment.WEBKIT_DISABLE_COMPOSITING_MODE = "1";
    return environment;
  }
  delete environment.WEBKIT_DISABLE_COMPOSITING_MODE;
  environment.GDK_GL ??= "gles";
  environment.WEBKIT_SKIA_ENABLE_CPU_RENDERING = mode === "gpu" ? "0" : "1";
  return environment;
}

// ============================================================================
// Link
// ============================================================================

export interface HostLinkOptions {
  gjs: string;
  environment: NodeJS.ProcessEnv;
  host_script?: string;
}

export interface ReadyInfo {
  displays: DisplayInfo[];
  system_dark: boolean;
}

export class HostLink extends EventEmitter {
  readonly ready: Promise<ReadyInfo>;
  #child: ChildProcessWithoutNullStreams;
  #next_request_id = 1;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #is_ready = false;

  constructor(options: HostLinkOptions) {
    super();
    const host_script = options.host_script ?? fileURLToPath(new URL("../host/main.js", import.meta.url));
    this.#child = spawn(options.gjs, ["-m", host_script], { env: options.environment, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stderr.pipe(process.stderr);

    this.ready = new Promise((resolve, reject) => {
      this.once("host_ready", resolve);
      this.#child.once("error", reject);
      this.#child.once("exit", (code) => {
        if (!this.#is_ready) reject(new Error(`The window host stopped before it was ready (exit code ${code}); is gjs with GTK 3 and WebKitGTK 4.1 installed?`));
      });
    });
    // A start that fails is reported to whoever awaits ready, not as an unhandled rejection.
    this.ready.catch(() => undefined);

    this.#child.once("exit", (code, signal) => {
      for (const pending of this.#pending.values()) pending.reject(new Error("The window host stopped."));
      this.#pending.clear();
      this.emit("exit", code, signal);
    });

    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message: HostMessage;
      try {
        message = JSON.parse(line) as HostMessage;
      } catch {
        process.stdout.write(`${line}\n`);
        return;
      }
      this.#receive(message);
    });
  }

  #receive(message: HostMessage): void {
    if (message.type === "ready") {
      this.#is_ready = true;
      this.emit("host_ready", { displays: message.displays, system_dark: message.system_dark });
      return;
    }
    if (message.type === "response") {
      const pending = this.#pending.get(message.request_id);
      this.#pending.delete(message.request_id);
      if (!pending) return;
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error ?? "The window host refused the request."));
      return;
    }
    this.emit("message", message);
  }

  send(message: MainMessage): void {
    if (this.#child.stdin.writable) this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request<Result>(request: HostRequest): Promise<Result> {
    await this.ready;
    const request_id = this.#next_request_id++;
    const answer = new Promise<unknown>((resolve, reject) => this.#pending.set(request_id, { resolve, reject }));
    this.send({ type: "request", request_id, request });
    return (await answer) as Result;
  }

  stop(): void {
    this.send({ type: "quit" });
    this.#child.stdin.end();
  }
}
