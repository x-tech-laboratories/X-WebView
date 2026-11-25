import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { bundle_preload, cache_folder, cached_preload, content_name, find_preloads, prebuilt_path, write_into, write_prebuilt } from "../src/node/preload.ts";

const sample_preload = new URL("./fixtures/sample_app/preload.mjs", import.meta.url).pathname;

describe("preload bundling", () => {
  it("swaps electron for the page's side and leaves no imports", async () => {
    const source = await bundle_preload(sample_preload);

    expect(source).toContain("__x_webview_receive");
    expect(source).toContain("exposeInMainWorld");
    expect(source).not.toMatch(/^import /m);
  });

  it("uses a build-time bundle while it is newer than the preload, and caches otherwise", async () => {
    const folder = await mkdtemp(join(tmpdir(), "x-webview-preload-"));
    const preload = join(folder, "preload.js");
    await writeFile(preload, 'import { ipcRenderer } from "electron"; globalThis.marker = ipcRenderer;');

    const written = await write_prebuilt(preload);
    await writeFile(prebuilt_path(preload), "prebuilt");
    const from_prebuilt = await cached_preload(preload, join(folder, "cache"));
    await utimes(preload, new Date(), new Date(Date.now() + 60_000));
    const from_bundler = await cached_preload(preload, join(folder, "cache"));
    const from_cache = await cached_preload(preload, join(folder, "cache"));

    expect(written).toBe(prebuilt_path(preload));
    expect(from_prebuilt).toBe("prebuilt");
    expect(from_bundler).toContain("marker");
    expect(from_cache).toBe(from_bundler);
  });

  it("finds electron-vite's preloads, or the scripts in a folder", async () => {
    const folder = await mkdtemp(join(tmpdir(), "x-webview-find-"));
    await writeFile(join(folder, "a.mjs"), "");
    await writeFile(join(folder, "a.mjs.x-webview.js"), "");
    await writeFile(join(folder, "notes.txt"), "");

    expect(await find_preloads(folder)).toEqual([join(folder, "a.mjs")]);
    expect(cache_folder({ XDG_CACHE_HOME: "/cache" })).toBe("/cache/x-webview/preload");
    expect(await readFile(join(folder, "a.mjs"), "utf8")).toBe("");
  });
});

describe("packaged preloads", () => {
  it("reads a bundle named by the preload's content from the package's folder", async () => {
    const folder = await mkdtemp(join(tmpdir(), "x-webview-packaged-"));
    const preload = join(folder, "preload.js");
    await writeFile(preload, "globalThis.packaged = 1;");

    const written = await write_into(join(folder, "bundles"), preload);
    await writeFile(written, "from the package");
    process.env.X_WEBVIEW_PRELOADS = join(folder, "bundles");
    const source = await cached_preload(preload, join(folder, "cache"));
    delete process.env.X_WEBVIEW_PRELOADS;

    expect(written).toBe(join(folder, "bundles", content_name("globalThis.packaged = 1;")));
    expect(source).toBe("from the package");
  });
});
