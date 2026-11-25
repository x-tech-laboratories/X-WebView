import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { host_environment, HostLink, rendering_mode } from "../src/node/host_link.ts";

const fake_host = fileURLToPath(new URL("./support/fake_host.mjs", import.meta.url));

describe("rendering", () => {
  it("defaults to hybrid", () => {
    expect(rendering_mode(undefined)).toBe("hybrid");
    expect(rendering_mode("nonsense")).toBe("hybrid");
    expect(rendering_mode("gpu")).toBe("gpu");
  });

  it("draws on the CPU and composites with GLES in hybrid mode", () => {
    const environment = host_environment({ WEBKIT_DISABLE_COMPOSITING_MODE: "1" }, "hybrid", "app");

    expect(environment.WEBKIT_DISABLE_COMPOSITING_MODE).toBeUndefined();
    expect(environment.WEBKIT_SKIA_ENABLE_CPU_RENDERING).toBe("1");
    expect(environment.GDK_GL).toBe("gles");
    expect(environment.X_WEBVIEW_APP_NAME).toBe("app");
  });

  it("keeps a GL choice already made and draws on the GPU in gpu mode", () => {
    const environment = host_environment({ GDK_GL: "disable" }, "gpu", "app");

    expect(environment.GDK_GL).toBe("disable");
    expect(environment.WEBKIT_SKIA_ENABLE_CPU_RENDERING).toBe("0");
  });

  it("turns compositing off in software mode", () => {
    expect(host_environment({}, "software", "app").WEBKIT_DISABLE_COMPOSITING_MODE).toBe("1");
  });
});

describe("HostLink", () => {
  it("waits for the host, answers requests and passes the failure's words on", async () => {
    const link = new HostLink({ gjs: fake_host, environment: process.env });

    const ready = await link.ready;
    const answer = await link.request<number>({ kind: "message_box", window_id: null, type: "info", message: "Hi", buttons: [], default_id: 0 });
    const failure = link.request({ kind: "open_path", path: "/missing" });

    expect(ready.system_dark).toBe(true);
    expect(answer).toBe(1);
    await expect(failure).rejects.toThrow("No such file");
    link.stop();
  });

  it("explains a host that stops before it is ready", async () => {
    const link = new HostLink({ gjs: process.execPath, environment: process.env });

    await expect(link.ready).rejects.toThrow("stopped before it was ready");
  });
});
