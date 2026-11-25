// Bundles an app's preload into one script the page runs before its own, with the electron module swapped for the page's side of X-WebView.

import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const page_electron = fileURLToPath(new URL("../page/electron.js", import.meta.url));
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
  const own_node = process.env.X_WEBVIEW_NODE;
  if (!own_node) return start();
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

// Bundling is slow on a phone, so each preload is kept by its path, size and change time until it changes.
export async function cached_preload(preload_path: string, cache = cache_folder()): Promise<string> {
  const details = await stat(preload_path);
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
