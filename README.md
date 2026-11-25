# X-WebView

Runs Electron apps on the system WebKit instead of a bundled Chromium, so they draw through the GPU on devices Chromium
cannot use, such as the PinePhone's Mali-400 with its OpenGL ES 2.0 driver. An app keeps its main process, preload and
page as they are; `x-webview` stands where the `electron` binary would.

```sh
x-webview path/to/app            # runs the app whose package.json names its main, like `electron path/to/app`
x-webview --bundle path/to/app   # bundles the app's preloads at build time
```

## How it works

| Part             | Electron                         | X-WebView                                                                          |
| ---------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| Main process     | Node inside Electron             | Node 24, with `import ... from "electron"` answered by X-WebView's own module     |
| Windows          | Chromium                         | A GJS program in TypeScript drawing each window with GTK 3 and WebKitGTK 4.1      |
| Preload          | Runs before the page in Chromium | Bundled with `electron` swapped for X-WebView's page side, injected at page start |
| IPC              | Chromium's IPC, structured clone | JSON lines between Node and the window host, keeping dates, maps, sets and bytes  |
| `electron` binary | Electron                        | `x-webview`, which also honours `ELECTRON_RUN_AS_NODE` for an app's own daemons    |

The window host draws pages on the CPU and composites them on the GPU by default, which measured fastest on the
PinePhone. `X_WEBVIEW_RENDERING` picks another mode:

| Mode               | Drawing | Compositing |
| ------------------ | ------- | ----------- |
| `hybrid` (default) | CPU     | GPU         |
| `gpu`              | GPU     | GPU         |
| `software`         | CPU     | CPU         |

Measured on a PinePhone, frames per second:

| Workload                          | `gpu` | `hybrid` | `software` |
| --------------------------------- | ----- | -------- | ---------- |
| CSS transform and opacity animation | 56  | 55       | 19         |
| Text and sizes changing each frame | 7    | 12       | 15         |
| Scrolling a long list             | 48    | 48       | 49         |
| 2D canvas                         | 11    | 10       | 16         |

## Compatibility

| Electron API                                   | State                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `app`                                          | Paths, lifecycle, events, single instance lock, relaunch, locale                        |
| `BrowserWindow`                                | Windows, showing, state, bounds, title, background, events; position is the compositor's |
| `webContents`                                  | Loading, `send`, `executeJavaScript`, window open handler, navigation events, dev tools  |
| `ipcMain`, `ipcRenderer`                       | `handle`, `invoke`, `send`, `on`; no `sendSync`                                          |
| `contextBridge`                                | `exposeInMainWorld`; the preload runs in the page's own world                           |
| `dialog`                                       | Open, save, message and error boxes; no synchronous versions                            |
| `shell`                                        | `openExternal`, `openPath`, `showItemInFolder`, `trashItem`                             |
| `nativeTheme`                                  | `themeSource` and `shouldUseDarkColors`, following the desktop's light or dark setting  |
| `screen`                                       | Displays, work areas and scale factors                                                  |
| `Notification`                                 | Through the desktop's notification service                                              |
| `clipboard`                                    | Text; `readText` answers with the last text known to the app                            |
| `powerMonitor`                                 | Present; idle time reads as 0                                                           |
| `Menu`, `Tray`, `globalShortcut`               | Present and inert, since phone shells have no menu bar or tray                          |
| `session`, `protocol`, `autoUpdater`           | Present and inert                                                                       |
| `safeStorage`                                  | Not available                                                                           |
| Chromium-only web APIs                         | Not available: File System Access, Web Serial, WebUSB, Web Bluetooth                    |

## Packaging with Nix

The flake's `packages.default` is `x-webview` with GJS, GTK 3, WebKitGTK and GStreamer wired in, for `x86_64-linux` and
`aarch64-linux`. `lib.<system>.wrap_app { name; app; share; environment; path; }` turns a built Electron app folder into a launcher that
runs it on X-WebView, with its preloads bundled at build time. `share` names a package whose desktop files and icons come
along, `environment` sets variables for the app and `path` puts tools on its PATH.

## Settings

| Variable              | Effect                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| `X_WEBVIEW_RENDERING` | `hybrid`, `gpu` or `software`                                          |
| `X_WEBVIEW_TIMING`    | `1` logs each step of startup and the page's own load times            |
| `X_WEBVIEW_CONSOLE`   | `1` prints the page's console messages                                 |
| `X_WEBVIEW_GJS`       | The `gjs` to run the window host with                                  |

## Development

`npm run build`, `npm test`, `npm run lint`. `scripts/smoke.sh` runs the sample app in `tests/fixtures/sample_app` on a
private Xvfb display with real GJS and WebKitGTK from nixpkgs.

## License

GPL-3.0-or-later.
