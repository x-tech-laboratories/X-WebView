// The parts of Electron that reach the desktop: dialogs, the shell, the theme, the screens, power, notifications and the clipboard.

import { EventEmitter } from "node:events";

import type { DisplayInfo, FileFilter, Rectangle } from "../shared/protocol.ts";
import { has_host, host, host_state, runtime_events } from "./runtime.ts";
import { BrowserWindow } from "./windows.ts";

// ============================================================================
// dialog
// ============================================================================

export interface DialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
  properties?: string[];
}

export interface MessageBoxOptions {
  message: string;
  type?: string;
  title?: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}

// Electron takes an optional window first; this sorts the window from the options.
function window_and_options<Options>(first: BrowserWindow | Options | undefined, second: Options | undefined): [number | null, Options] {
  if (first instanceof BrowserWindow) return [first.id, second as Options];
  return [null, (first ?? second) as Options];
}

function unsupported(name: string): never {
  throw new Error(`X-WebView has no ${name}; use the asynchronous version.`);
}

export const dialog = {
  async showOpenDialog(first?: BrowserWindow | DialogOptions, second?: DialogOptions): Promise<{ canceled: boolean; filePaths: string[] }> {
    const [window_id, options = {}] = window_and_options(first, second);
    const properties = options.properties ?? ["openFile"];
    const paths = await host().request<string[] | null>({
      kind: "open_dialog",
      window_id,
      title: options.title,
      default_path: options.defaultPath,
      filters: options.filters ?? [],
      directory: properties.includes("openDirectory"),
      multiple: properties.includes("multiSelections"),
    });
    return { canceled: paths === null, filePaths: paths ?? [] };
  },

  async showSaveDialog(first?: BrowserWindow | DialogOptions, second?: DialogOptions): Promise<{ canceled: boolean; filePath: string }> {
    const [window_id, options = {}] = window_and_options(first, second);
    const path = await host().request<string | null>({ kind: "save_dialog", window_id, title: options.title, default_path: options.defaultPath, filters: options.filters ?? [] });
    return { canceled: path === null, filePath: path ?? "" };
  },

  async showMessageBox(first: BrowserWindow | MessageBoxOptions, second?: MessageBoxOptions): Promise<{ response: number; checkboxChecked: boolean }> {
    const [window_id, options] = window_and_options(first, second);
    const response = await host().request<number>({
      kind: "message_box",
      window_id,
      type: options.type ?? "none",
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: options.buttons ?? [],
      default_id: options.defaultId ?? 0,
    });
    return { response, checkboxChecked: false };
  },

  // Electron blocks here; this cannot, so it also prints the error for a process about to exit.
  showErrorBox(title: string, content: string): void {
    console.error(`${title}\n${content}`);
    if (has_host()) void host().request({ kind: "message_box", window_id: null, type: "error", title, message: title, detail: content, buttons: ["OK"], default_id: 0 }).catch(() => undefined);
  },

  showOpenDialogSync: (): never => unsupported("dialog.showOpenDialogSync"),
  showSaveDialogSync: (): never => unsupported("dialog.showSaveDialogSync"),
  showMessageBoxSync: (): never => unsupported("dialog.showMessageBoxSync"),
  showCertificateTrustDialog: async (): Promise<void> => {},
};

// ============================================================================
// shell
// ============================================================================

export const shell = {
  async openExternal(url: string): Promise<void> {
    await host().request({ kind: "open_external", url });
  },

  // Answers with an empty string, or the reason it failed, as Electron does.
  async openPath(path: string): Promise<string> {
    try {
      await host().request({ kind: "open_path", path });
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },

  showItemInFolder(path: string): void {
    void host().request({ kind: "show_item_in_folder", path }).catch(() => undefined);
  },

  async trashItem(path: string): Promise<void> {
    await host().request({ kind: "trash_item", path });
  },

  beep(): void {},

  writeShortcutLink: (): boolean => false,
};

// ============================================================================
// nativeTheme
// ============================================================================

type ThemeSource = "system" | "light" | "dark";

export class NativeTheme extends EventEmitter {
  #source: ThemeSource = "system";
  readonly shouldUseHighContrastColors = false;
  readonly shouldUseInvertedColorScheme = false;
  readonly inForcedColorsMode = false;
  readonly prefersReducedTransparency = false;

  constructor() {
    super();
    runtime_events.on("host_message", (message: { type: string }) => {
      if (message.type === "system_theme" && this.#source === "system") this.emit("updated");
    });
  }

  get themeSource(): ThemeSource {
    return this.#source;
  }

  set themeSource(source: ThemeSource) {
    if (source === this.#source) return;
    this.#source = source;
    if (has_host()) void host().ready.then(() => host().send({ type: "set_theme", source }), () => undefined);
    this.emit("updated");
  }

  get shouldUseDarkColors(): boolean {
    return this.#source === "dark" || (this.#source === "system" && host_state.system_dark);
  }
}

export const nativeTheme = new NativeTheme();

// The source chosen before the host started reaches it once it is ready.
runtime_events.once("window_created", () => {
  if (nativeTheme.themeSource !== "system") void host().ready.then(() => host().send({ type: "set_theme", source: nativeTheme.themeSource }), () => undefined);
});

// ============================================================================
// screen
// ============================================================================

export interface Display {
  id: number;
  label: string;
  bounds: Rectangle;
  workArea: Rectangle;
  size: { width: number; height: number };
  workAreaSize: { width: number; height: number };
  scaleFactor: number;
  rotation: number;
  internal: boolean;
  monochrome: boolean;
  colorDepth: number;
  depthPerComponent: number;
  displayFrequency: number;
  accelerometerSupport: string;
  touchSupport: string;
  detected: boolean;
}

export function to_display(info: DisplayInfo): Display {
  return {
    id: info.id,
    label: `Display ${info.id}`,
    bounds: info.bounds,
    workArea: info.work_area,
    size: { width: info.bounds.width, height: info.bounds.height },
    workAreaSize: { width: info.work_area.width, height: info.work_area.height },
    scaleFactor: info.scale_factor,
    rotation: 0,
    internal: info.is_primary,
    monochrome: false,
    colorDepth: 24,
    depthPerComponent: 8,
    displayFrequency: 60,
    accelerometerSupport: "unknown",
    touchSupport: "unknown",
    detected: true,
  };
}

const fallback_display: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, work_area: { x: 0, y: 0, width: 1280, height: 720 }, scale_factor: 1, is_primary: true };

function displays(): Display[] {
  return (host_state.displays.length ? host_state.displays : [fallback_display]).map(to_display);
}

function overlap_area(first: Rectangle, second: Rectangle): number {
  const width = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
  const height = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
  return width > 0 && height > 0 ? width * height : 0;
}

export class Screen extends EventEmitter {
  constructor() {
    super();
    runtime_events.on("host_message", (message: { type: string }) => {
      if (message.type === "displays") this.emit("display-metrics-changed", {}, this.getPrimaryDisplay(), []);
    });
  }

  getAllDisplays(): Display[] {
    return displays();
  }

  getPrimaryDisplay(): Display {
    const all = displays();
    return all.find((display) => display.internal) ?? (all[0] as Display);
  }

  getDisplayMatching(rectangle: Rectangle): Display {
    const all = displays();
    return all.reduce((best, display) => (overlap_area(display.bounds, rectangle) > overlap_area(best.bounds, rectangle) ? display : best), this.getPrimaryDisplay());
  }

  getDisplayNearestPoint(point: { x: number; y: number }): Display {
    return this.getDisplayMatching({ x: point.x, y: point.y, width: 1, height: 1 });
  }

  getCursorScreenPoint(): { x: number; y: number } {
    return { x: 0, y: 0 };
  }

  screenToDipPoint(point: { x: number; y: number }): { x: number; y: number } {
    return point;
  }

  dipToScreenPoint(point: { x: number; y: number }): { x: number; y: number } {
    return point;
  }
}

export const screen = new Screen();

// ============================================================================
// powerMonitor
// ============================================================================

export class PowerMonitor extends EventEmitter {
  readonly onBatteryPower = false;

  getSystemIdleTime(): number {
    return 0;
  }

  getSystemIdleState(): "active" | "idle" | "locked" | "unknown" {
    return "active";
  }

  isOnBatteryPower(): boolean {
    return false;
  }

  getCurrentThermalState(): string {
    return "unknown";
  }
}

export const powerMonitor = new PowerMonitor();

// ============================================================================
// Notification
// ============================================================================

export class Notification extends EventEmitter {
  readonly title: string;
  readonly body: string;
  readonly icon: string | undefined;

  constructor(options: { title?: string; body?: string; icon?: string } = {}) {
    super();
    this.title = options.title ?? "";
    this.body = options.body ?? "";
    this.icon = typeof options.icon === "string" ? options.icon : undefined;
  }

  static isSupported(): boolean {
    return true;
  }

  show(): void {
    host()
      .request({ kind: "notify", title: this.title, body: this.body, icon: this.icon })
      .then(
        () => this.emit("show"),
        (error: unknown) => this.emit("failed", {}, error instanceof Error ? error.message : String(error)),
      );
  }

  close(): void {
    this.emit("close");
  }
}

// ============================================================================
// clipboard
// ============================================================================

// Electron reads the clipboard synchronously; this answers with the last text written from this app and fetches the rest in the background.
let clipboard_text = "";

export const clipboard = {
  readText(): string {
    if (has_host()) void host().request<string>({ kind: "read_clipboard" }).then((text) => (clipboard_text = text), () => undefined);
    return clipboard_text;
  },
  writeText(text: string): void {
    clipboard_text = text;
    void host().request({ kind: "write_clipboard", text }).catch(() => undefined);
  },
  clear(): void {
    clipboard.writeText("");
  },
  availableFormats: (): string[] => ["text/plain"],
  readHTML: (): string => "",
  writeHTML: (): void => {},
  readImage: (): unknown => null,
  writeImage: (): void => {},
};
