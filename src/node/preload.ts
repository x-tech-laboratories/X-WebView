// Bundles an app's preload into one script the page runs before its own, with the electron module swapped for the page's side of X-WebView.

import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const page_electron = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../page/electron.ts" : "../page/electron.js", import.meta.url));
const electron_names = new Set(["electron", "electron/renderer", "electron/common"]);
const node_names = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export function cache_folder(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "x-webview", "preload");
}

// ============================================================================
// Bundling
// ============================================================================

// esbuild-wasm starts a node found by name, so the Node that runs X-WebView is put first on the path while it starts.
function with_own_node_on_path<Result>(start: () => Result): Result {
  const own_node = process.env.X_WEBVIEW_NODE ?? process.execPath;
  const saved_path = process.env.PATH;
  process.env.PATH = [dirname(own_node), saved_path].filter(Boolean).join(delimiter);
  try {
    return start();
  } finally {
    process.env.PATH = saved_path;
  }
}

export async function bundle_preload(preload_path: string): Promise<string> {
  const esbuild = await import("esbuild-wasm");
  const result = await with_own_node_on_path(() => esbuild.build({
    entryPoints: [preload_path],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    plugins: [
      {
        name: "x-webview-electron",
        setup(build) {
          build.onResolve({ filter: /^electron(\/.*)?$/ }, (args) => (electron_names.has(args.path) ? { path: page_electron } : undefined));
          build.onResolve({ filter: /.*/ }, (args) => (node_names.has(args.path) ? { path: args.path, external: true } : undefined));
        },
      },
    ],
  }));
  // The bundler's helper process holds hundreds of megabytes, which a phone needs back.
  await esbuild.stop();
  return result.outputFiles[0]?.text ?? "";
}

// ============================================================================
// Cache
// ============================================================================

// The bundle `x-webview --bundle` writes beside a preload at build time.
export function prebuilt_path(preload_path: string): string {
  return `${preload_path}.x-webview.js`;
}

export async function write_prebuilt(preload_path: string): Promise<string> {
  const output = prebuilt_path(preload_path);
  await writeFile(output, await bundle_preload(preload_path));
  return output;
}

// A packaged app's preloads cannot have files beside them, so its package keeps their bundles in a folder of their own, named by content.
export function content_name(source: string): string {
  return `${createHash("sha256").update(source).digest("hex")}.js`;
}

export async function write_into(folder: string, preload_path: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  const output = join(folder, content_name(await readFile(preload_path, "utf8")));
  await writeFile(output, await bundle_preload(preload_path));
  return output;
}

// The preloads of an app folder: electron-vite's out/preload when there is one, otherwise the scripts in the folder itself.
export async function find_preloads(folder: string): Promise<string[]> {
  const preload_folder = join(folder, "out", "preload");
  const searched = await stat(preload_folder).then((details) => (details.isDirectory() ? preload_folder : folder), () => folder);
  const names = await readdir(searched);
  return names.filter((name) => /\.(c|m)?js$/.test(name) && !name.endsWith(".x-webview.js")).map((name) => join(searched, name));
}

// Bundling is slow on a phone, so a build-time bundle is used when it is current, and otherwise each bundle is cached by the preload's path, size and change time.
export async function cached_preload(preload_path: string, cache = cache_folder()): Promise<string> {
  const details = await stat(preload_path);
  const prebuilt = await stat(prebuilt_path(preload_path)).catch(() => null);
  if (prebuilt && prebuilt.mtimeMs >= details.mtimeMs) return readFile(prebuilt_path(preload_path), "utf8");
  const packaged_folder = process.env.X_WEBVIEW_PRELOADS;
  if (packaged_folder) {
    const packaged = await readFile(join(packaged_folder, content_name(await readFile(preload_path, "utf8"))), "utf8").catch(() => null);
    if (packaged !== null) return packaged;
  }
  const runtime = await stat(page_electron);
  const key = createHash("sha256").update(`${preload_path}\n${details.size}\n${details.mtimeMs}\n${runtime.mtimeMs}`).digest("hex");
  const cache_file = join(cache, `${key}.js`);
  try {
    return await readFile(cache_file, "utf8");
  } catch {
    const source = await bundle_preload(preload_path);
    try {
      await mkdir(cache, { recursive: true });
      await writeFile(cache_file, source);
    } catch {
      // An unwritable cache only means bundling again next time.
    }
    return source;
  }
}
