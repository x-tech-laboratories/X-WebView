// Electron parts a phone shell has no place for yet: menus, the tray, global shortcuts, sessions and the like keep their shape and do nothing.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

// ============================================================================
// Menus
// ============================================================================

export interface MenuItemOptions {
  label?: string;
  type?: string;
  role?: string;
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  accelerator?: string;
  click?: (...args: unknown[]) => void;
  submenu?: MenuItemOptions[] | Menu;
  [key: string]: unknown;
}

export class MenuItem {
  readonly label: string;
  readonly type: string;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  readonly click: ((...args: unknown[]) => void) | undefined;
  readonly submenu: Menu | undefined;

  constructor(options: MenuItemOptions) {
    this.label = options.label ?? "";
    this.type = options.type ?? "normal";
    this.enabled = options.enabled ?? true;
    this.visible = options.visible ?? true;
    this.checked = options.checked ?? false;
    this.click = options.click;
    this.submenu = options.submenu instanceof Menu ? options.submenu : options.submenu ? Menu.buildFromTemplate(options.submenu) : undefined;
  }
}

export class Menu extends EventEmitter {
  readonly items: MenuItem[] = [];

  static buildFromTemplate(template: (MenuItemOptions | MenuItem)[]): Menu {
    const menu = new Menu();
    for (const entry of template) menu.append(entry instanceof MenuItem ? entry : new MenuItem(entry));
    return menu;
  }

  static setApplicationMenu(): void {}

  static getApplicationMenu(): Menu | null {
    return null;
  }

  static sendActionToFirstResponder(): void {}

  append(item: MenuItem): void {
    this.items.push(item);
  }

  insert(position: number, item: MenuItem): void {
    this.items.splice(position, 0, item);
  }

  getMenuItemById(): MenuItem | null {
    return null;
  }

  popup(): void {}

  closePopup(): void {}
}

// ============================================================================
// Tray
// ============================================================================

// Phosh shows no tray, so the icon exists for the app's sake and never appears.
export class Tray extends EventEmitter {
  #destroyed = false;

  constructor(_image?: unknown) {
    super();
  }

  setImage(): void {}

  setPressedImage(): void {}

  setToolTip(): void {}

  setTitle(): void {}

  setContextMenu(): void {}

  popUpContextMenu(): void {}

  destroy(): void {
    this.#destroyed = true;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }
}

// ============================================================================
// nativeImage
// ============================================================================

export class NativeImage {
  readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
  }

  resize(): NativeImage {
    return this;
  }

  crop(): NativeImage {
    return this;
  }

  isEmpty(): boolean {
    return !this.path;
  }

  getSize(): { width: number; height: number } {
    return { width: 0, height: 0 };
  }

  setTemplateImage(): void {}

  toPNG(): Buffer {
    try {
      return this.path ? readFileSync(this.path) : Buffer.alloc(0);
    } catch {
      return Buffer.alloc(0);
    }
  }

  toDataURL(): string {
    return `data:image/png;base64,${this.toPNG().toString("base64")}`;
  }
}

export const nativeImage = {
  createFromPath: (path: string) => new NativeImage(path),
  createEmpty: () => new NativeImage(),
  createFromBuffer: () => new NativeImage(),
  createFromDataURL: () => new NativeImage(),
};

// ============================================================================
// Others
// ============================================================================

export const globalShortcut = {
  register: (): boolean => false,
  registerAll: (): void => {},
  isRegistered: (): boolean => false,
  unregister: (): void => {},
  unregisterAll: (): void => {},
};

const web_request = { onBeforeRequest: () => {}, onBeforeSendHeaders: () => {}, onHeadersReceived: () => {}, onCompleted: () => {}, onErrorOccurred: () => {} };

const default_session = {
  webRequest: web_request,
  protocol: { handle: () => {}, unhandle: () => {}, isProtocolHandled: () => false },
  setPermissionRequestHandler: () => {},
  setPermissionCheckHandler: () => {},
  setDevicePermissionHandler: () => {},
  setProxy: async () => {},
  clearCache: async () => {},
  clearStorageData: async () => {},
  getUserAgent: () => "X-WebView",
  setUserAgent: () => {},
  setSpellCheckerEnabled: () => {},
  on: () => {},
};

export const session = {
  defaultSession: default_session,
  fromPartition: () => default_session,
};

export const protocol = {
  registerSchemesAsPrivileged: (): void => {},
  handle: (): void => {},
  unhandle: (): void => {},
  registerFileProtocol: (): boolean => false,
  registerStringProtocol: (): boolean => false,
  registerBufferProtocol: (): boolean => false,
  interceptFileProtocol: (): boolean => false,
  isProtocolHandled: (): boolean => false,
};

export const crashReporter = {
  start: (): void => {},
  getLastCrashReport: (): null => null,
  getUploadedReports: (): unknown[] => [],
  addExtraParameter: (): void => {},
};

export const autoUpdater = Object.assign(new EventEmitter(), {
  setFeedURL: (): void => {},
  getFeedURL: (): string => "",
  checkForUpdates: (): void => {},
  quitAndInstall: (): void => {},
});

export const systemPreferences = {
  getAccentColor: (): string => "3584e4ff",
  getColor: (): string => "#000000",
  getMediaAccessStatus: (): string => "granted",
  askForMediaAccess: async (): Promise<boolean> => true,
  getAnimationSettings: () => ({ shouldRenderRichAnimation: true, scrollAnimationsEnabledBySystem: true, prefersReducedMotion: false }),
  on: (): void => {},
};

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): never => {
    throw new Error("X-WebView has no safeStorage.");
  },
  decryptString: (): never => {
    throw new Error("X-WebView has no safeStorage.");
  },
};

export const contentTracing = {};

export const inAppPurchase = {};
