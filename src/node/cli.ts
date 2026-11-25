#!/usr/bin/env node
// The x-webview command, which stands where the electron binary would: `x-webview <app>` runs an app, and with ELECTRON_RUN_AS_NODE it runs a plain script.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The Electron release whose API this version follows.
export const ELECTRON_VERSION = "45.0.0";

// ============================================================================
// Finding the app
// ============================================================================

export interface AppEntry {
  app_path: string;
  main: string;
}

// An app folder starts at its package.json's main, and a file given directly is the main itself.
export function find_app(target: string): AppEntry {
  const path = resolve(target);
  if (existsSync(path) && statSync(path).isFile()) return { app_path: dirname(path), main: path };
  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { main?: string };
  const main = resolve(path, manifest.main ?? "index.js");
  return { app_path: path, main: existsSync(main) && statSync(main).isDirectory() ? join(main, "index.js") : main };
}

// ============================================================================
// Running
// ============================================================================

async function run_as_node(arguments_given: string[]): Promise<void> {
  const [script, ...rest] = arguments_given;
  if (!script) throw new Error("usage: ELECTRON_RUN_AS_NODE=1 x-webview <script> [arguments]");
  const script_path = resolve(script);
  process.argv = [process.execPath, script_path, ...rest];
  await import(pathToFileURL(script_path).href);
}

async function run_app(arguments_given: string[]): Promise<void> {
  const [target = ".", ...rest] = arguments_given;
  const entry = find_app(target);
  const launcher = process.env.X_WEBVIEW_LAUNCHER ?? fileURLToPath(import.meta.url);

  process.env.X_WEBVIEW_APP_PATH = entry.app_path;
  process.env.X_WEBVIEW_NODE = process.execPath;
  process.argv = [launcher, target, ...rest];
  process.execPath = launcher;
  (process.versions as Record<string, string>).electron = ELECTRON_VERSION;
  Object.assign(process, { type: "browser", resourcesPath: entry.app_path });

  const { mark } = await import("./runtime.ts");
  mark("launcher started");
  await import("./register.ts");
  await import(pathToFileURL(entry.main).href);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const arguments_given = process.argv.slice(2);
  const run = process.env.ELECTRON_RUN_AS_NODE ? run_as_node(arguments_given) : run_app(arguments_given);
  run.catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
