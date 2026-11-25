import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { find_app } from "../src/node/cli.ts";

const run = promisify(execFile);
const cli = new URL("../src/node/cli.ts", import.meta.url).pathname;

describe("find_app", () => {
  it("starts a folder at its main, a folder main at its index, and a file at itself", async () => {
    const folder = await mkdtemp(join(tmpdir(), "x-webview-app-"));
    await writeFile(join(folder, "package.json"), JSON.stringify({ main: "out/main" }));
    await mkdir(join(folder, "out", "main"), { recursive: true });

    expect(find_app(folder)).toEqual({ app_path: folder, main: join(folder, "out", "main", "index.js") });
    expect(find_app(join(folder, "package.json"))).toEqual({ app_path: folder, main: join(folder, "package.json") });
  });
});

describe("x-webview command", () => {
  it("runs a plain script when asked to run as node", async () => {
    const folder = await mkdtemp(join(tmpdir(), "x-webview-node-"));
    const script = join(folder, "script.mjs");
    await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)))");

    const { stdout } = await run(process.execPath, [cli, script, "one"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });

    expect(JSON.parse(stdout)).toEqual(["one"]);
  });

  it("runs an app's main with electron answered by X-WebView", async () => {
    const folder = await mkdtemp(join(tmpdir(), "x-webview-main-"));
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: "probe", version: "2.0.0", main: "main.mjs" }));
    await writeFile(join(folder, "main.mjs"), 'import { app } from "electron"; console.log(JSON.stringify([app.getName(), app.getVersion(), process.versions.electron, process.type])); app.exit(0);');

    const { stdout } = await run(process.execPath, [cli, folder]);

    expect(JSON.parse(stdout)).toEqual(["probe", "2.0.0", "45.0.0", "browser"]);
  });

  it("bundles an app's preloads at build time", async () => {
    const folder = await mkdtemp(join(tmpdir(), "x-webview-bundle-"));
    await mkdir(join(folder, "out", "preload"), { recursive: true });
    await writeFile(join(folder, "out", "preload", "index.mjs"), 'import { contextBridge } from "electron"; contextBridge.exposeInMainWorld("probe", {});');

    const { stdout } = await run(process.execPath, [cli, "--bundle", folder]);

    expect(stdout.trim()).toBe(join(folder, "out", "preload", "index.mjs.x-webview.js"));
    expect(await readFile(stdout.trim(), "utf8")).toContain("exposeInMainWorld");
  });
});

describe("x-webview --bundle-into", () => {
  it("bundles an app's preloads into a folder named by content", async () => {
    const folder = await mkdtemp(join(tmpdir(), "x-webview-into-"));
    await writeFile(join(folder, "preload.js"), 'import { ipcRenderer } from "electron"; globalThis.probe = ipcRenderer;');

    const { stdout } = await run(process.execPath, [cli, "--bundle-into", join(folder, "bundles"), join(folder, "preload.js")]);

    expect(stdout.trim()).toMatch(new RegExp(`^${join(folder, "bundles")}/[0-9a-f]{64}\\.js$`));
  });

  it("runs a packaged app named by its launcher, with only the app's own arguments", async () => {
    const folder = await mkdtemp(join(tmpdir(), "x-webview-packaged-"));
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: "packaged", main: "main.mjs" }));
    await writeFile(join(folder, "main.mjs"), 'import { app } from "electron"; console.log(JSON.stringify([app.isPackaged, process.argv.slice(1)])); app.exit(0);');

    const { stdout } = await run(process.execPath, [cli, "--open"], { env: { ...process.env, X_WEBVIEW_PACKAGED_APP: folder } });

    expect(JSON.parse(stdout)).toEqual([true, ["--open"]]);
  });
});
