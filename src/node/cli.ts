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

// A packaged app's launcher names its app in X_WEBVIEW_PACKAGED_APP and passes only the app's own arguments, as a packaged Electron app's binary does.
async function run_app(arguments_given: string[]): Promise<void> {
  const packaged_app = process.env.X_WEBVIEW_PACKAGED_APP;
  const [target = ".", ...rest] = packaged_app ? [packaged_app, ...arguments_given] : arguments_given;
  const entry = find_app(target);
  const launcher = process.env.X_WEBVIEW_LAUNCHER ?? fileURLToPath(import.meta.url);

  process.env.X_WEBVIEW_APP_PATH = entry.app_path;
  process.env.X_WEBVIEW_NODE = process.execPath;
  process.argv = packaged_app ? [launcher, ...rest] : [launcher, target, ...rest];
  process.execPath = launcher;
  (process.versions as Record<string, string>).electron = ELECTRON_VERSION;
  Object.assign(process, { type: "browser", resourcesPath: entry.app_path });

  const { mark } = await import("./runtime.ts");
  mark("launcher started");
  await import("./register.ts");
  await import(pathToFileURL(entry.main).href);
}

// `x-webview --bundle <app or preload>...` bundles preloads at build time beside each preload, so a phone never bundles at startup;
// `--bundle-into <folder>` puts them in a folder of their own instead, for a package that cannot write beside the app.
async function bundle_preloads(targets: string[], into?: string): Promise<void> {
  const { find_preloads, write_into, write_prebuilt } = await import("./preload.ts");
  for (const target of targets.length ? targets : ["."]) {
    const path = resolve(target);
    const preloads = statSync(path).isDirectory() ? await find_preloads(path) : [path];
    for (const preload of preloads) console.log(into ? await write_into(into, preload) : await write_prebuilt(preload));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const arguments_given = process.argv.slice(2);
  const run = process.env.ELECTRON_RUN_AS_NODE
    ? run_as_node(arguments_given)
    : arguments_given[0] === "--bundle"
      ? bundle_preloads(arguments_given.slice(1))
      : arguments_given[0] === "--bundle-into"
        ? bundle_preloads(arguments_given.slice(2), arguments_given[1])
        : run_app(arguments_given);
  run.catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
