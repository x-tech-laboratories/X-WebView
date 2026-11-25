// The window host: a GJS program that draws the app's windows with WebKitGTK and takes its orders from the Node main process over stdin and stdout.

import Gdk from "gi://Gdk?version=3.0";
import Gio from "gi://Gio";
import GioUnix from "gi://GioUnix";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=3.0";
import JavaScriptCore from "gi://JavaScriptCore?version=4.1";
import WebKit from "gi://WebKit2?version=4.1";

import type { DisplayInfo, HostMessage, HostRequest, MainMessage, WindowCommand, WindowEvent, WindowSettings } from "../shared/protocol.ts";

// ============================================================================
// Main process link
// ============================================================================

const output = new GioUnix.OutputStream({ fd: 1, close_fd: false });
const encoder = new TextEncoder();

function send(message: HostMessage): void {
  output.write_all(encoder.encode(`${JSON.stringify(message)}\n`), null);
}

function send_event(window_id: number, event: WindowEvent): void {
  send({ type: "window_event", window_id, event });
}

function read_messages(): void {
  const input = new Gio.DataInputStream({ base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }) });
  const read_next = () => {
    input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
      let line: string | null;
      try {
        [line] = input.read_line_finish_utf8(result);
      } catch (error) {
        printerr(`x-webview host: ${String(error)}`);
        line = null;
      }
      if (line === null) {
        Gtk.main_quit();
        return;
      }
      if (line.trim()) {
        try {
          handle_message(JSON.parse(line) as MainMessage);
        } catch (error) {
          printerr(`x-webview host: ${String(error)}`);
        }
      }
      read_next();
    });
  };
  read_next();
}

// ============================================================================
// Displays and theme
// ============================================================================

function list_displays(): DisplayInfo[] {
  const display = Gdk.Display.get_default();
  if (!display) return [];
  const displays: DisplayInfo[] = [];
  for (let index = 0; index < display.get_n_monitors(); index += 1) {
    const monitor = display.get_monitor(index);
    if (!monitor) continue;
    const geometry = monitor.get_geometry();
    const work_area = monitor.get_workarea();
    displays.push({
      id: index + 1,
      bounds: { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height },
      work_area: { x: work_area.x, y: work_area.y, width: work_area.width, height: work_area.height },
      scale_factor: monitor.get_scale_factor(),
      is_primary: monitor.is_primary() || index === 0,
    });
  }
  return displays;
}

// The desktop's light or dark choice, from the settings portal that Phosh and GNOME both serve.
function read_system_dark(): boolean {
  try {
    const reply = Gio.DBus.session.call_sync(
      "org.freedesktop.portal.Desktop",
      "/org/freedesktop/portal/desktop",
      "org.freedesktop.portal.Settings",
      "ReadOne",
      new GLib.Variant("(ss)", ["org.freedesktop.appearance", "color-scheme"]),
      null,
      Gio.DBusCallFlags.NONE,
      1000,
      null,
    );
    return (reply.recursiveUnpack() as [unknown])[0] === 1;
  } catch {
    const theme_name = String(Gtk.Settings.get_default()?.gtk_theme_name ?? "");
    return theme_name.toLowerCase().includes("dark");
  }
}

let system_dark = false;
let theme_source: "system" | "light" | "dark" = "system";

function apply_theme(): void {
  const settings = Gtk.Settings.get_default();
  if (settings) settings.gtk_application_prefer_dark_theme = theme_source === "dark" || (theme_source === "system" && system_dark);
}

function follow_system_theme(): void {
  Gio.DBus.session.signal_subscribe(
    "org.freedesktop.portal.Desktop",
    "org.freedesktop.portal.Settings",
    "SettingChanged",
    "/org/freedesktop/portal/desktop",
    null,
    Gio.DBusSignalFlags.NONE,
    (_connection, _sender, _path, _interface, _signal, parameters) => {
      const [namespace, key, value] = parameters.recursiveUnpack() as [string, string, unknown];
      if (namespace !== "org.freedesktop.appearance" || key !== "color-scheme") return;
      system_dark = value === 1;
      apply_theme();
      send({ type: "system_theme", system_dark });
    },
  );
}

// ============================================================================
// Font scale
// ============================================================================

// GNOME's text size, or 1 where its settings are not installed.
function text_scaling_factor(): number {
  const schema = Gio.SettingsSchemaSource.get_default()?.lookup("org.gnome.desktop.interface", true);
  if (!schema?.has_key("text-scaling-factor")) return 1;
  return new Gio.Settings({ schema_id: "org.gnome.desktop.interface" }).get_double("text-scaling-factor") || 1;
}

// WebKit zooms pages by the font DPI over 96, and GTK 3 under Phosh leaves that DPI at -1, which zooms every page by -1/96.
function settle_font_dpi(): void {
  const settings = Gtk.Settings.get_default();
  if (settings && settings.gtk_xft_dpi <= 0) settings.gtk_xft_dpi = Math.round(96 * text_scaling_factor() * 1024);
}

// ============================================================================
// Windows
// ============================================================================

interface HostWindow {
  id: number;
  window: Gtk.Window;
  view: WebKit.WebView;
  shown_ready: boolean;
  // Set by a load the main process asked for, so its own navigation is not put to it again.
  allow_next_navigation: boolean;
  closing: boolean;
}

const windows = new Map<number, HostWindow>();

let next_call_id = 1;
const pending_replies = new Map<number, { reply: WebKit.ScriptMessageReply; context: JavaScriptCore.Context }>();

let next_decision_id = 1;
const pending_decisions = new Map<number, WebKit.PolicyDecision>();

function parse_color(color: string): Gdk.RGBA | null {
  const rgba = new Gdk.RGBA();
  return rgba.parse(color) ? rgba : null;
}

function fits_screen(width: number, height: number): boolean {
  return list_displays().some((display) => display.work_area.width >= width && display.work_area.height >= height);
}

function report_state(host_window: HostWindow): void {
  const state = host_window.window.get_window()?.get_state() ?? 0;
  send_event(host_window.id, {
    kind: "state",
    maximized: (state & Gdk.WindowState.MAXIMIZED) !== 0,
    minimized: (state & Gdk.WindowState.ICONIFIED) !== 0,
    fullscreen: (state & Gdk.WindowState.FULLSCREEN) !== 0,
    visible: host_window.window.get_visible(),
  });
}

function create_window(window_id: number, settings: WindowSettings): void {
  const content_manager = new WebKit.UserContentManager();
  content_manager.register_script_message_handler_with_reply("x_webview", null);
  if (settings.preload_source) {
    content_manager.add_script(WebKit.UserScript.new(settings.preload_source, WebKit.UserContentInjectedFrames.TOP_FRAME, WebKit.UserScriptInjectionTime.START, null, null));
  }

  const view = new WebKit.WebView({ user_content_manager: content_manager });
  const web_settings = view.get_settings();
  web_settings.set_hardware_acceleration_policy(GLib.getenv("X_WEBVIEW_RENDERING") === "software" ? WebKit.HardwareAccelerationPolicy.NEVER : WebKit.HardwareAccelerationPolicy.ALWAYS);
  web_settings.set_allow_file_access_from_file_urls(true);
  web_settings.set_allow_universal_access_from_file_urls(true);
  web_settings.set_enable_developer_extras(settings.developer_tools ?? false);
  web_settings.set_javascript_can_access_clipboard(true);
  if (GLib.getenv("X_WEBVIEW_CONSOLE") === "1") web_settings.set_enable_write_console_messages_to_stdout(true);

  const background = settings.background ? parse_color(settings.background) : null;
  if (background) view.set_background_color(background);

  const window = new Gtk.Window({ title: settings.title });
  window.set_default_size(settings.width, settings.height);
  if (settings.min_width && settings.min_height && fits_screen(settings.min_width, settings.min_height)) window.set_size_request(settings.min_width, settings.min_height);
  if (settings.resizable === false) window.set_resizable(false);
  if (settings.icon) {
    try {
      window.set_icon_from_file(settings.icon);
    } catch {
      // A missing icon leaves the window with the desktop's default one.
    }
  }
  window.add(view);
  view.show();
  // A window the app shows only when ready still needs its surface now, or WebKit lays the page out for a screen of no size.
  window.realize();
  if (settings.fullscreen) window.fullscreen();

  const host_window: HostWindow = { id: window_id, window, view, shown_ready: false, allow_next_navigation: false, closing: false };
  windows.set(window_id, host_window);

  content_manager.connect("script-message-with-reply-received::x_webview", (_manager, value, reply) => {
    handle_page_message(host_window, value, reply);
    return true;
  });

  view.connect("load-changed", (_view, load_event) => {
    if (load_event === WebKit.LoadEvent.COMMITTED) send_event(window_id, { kind: "url", url: view.get_uri() ?? "" });
    if (load_event !== WebKit.LoadEvent.FINISHED) return;
    send_event(window_id, { kind: "did_finish_load", url: view.get_uri() ?? "" });
    if (!host_window.shown_ready) {
      host_window.shown_ready = true;
      send_event(window_id, { kind: "ready_to_show" });
    }
  });
  view.connect("load-failed", (_view, _load_event, failing_uri, error) => {
    send_event(window_id, { kind: "did_fail_load", url: failing_uri, error: error.message });
    if (!host_window.shown_ready) {
      host_window.shown_ready = true;
      send_event(window_id, { kind: "ready_to_show" });
    }
    return false;
  });
  view.connect("notify::title", () => send_event(window_id, { kind: "title", title: view.get_title() ?? "" }));
  view.connect("web-process-terminated", (_view, reason) => send_event(window_id, { kind: "render_process_gone", reason: reason === WebKit.WebProcessTerminationReason.CRASHED ? "crashed" : "killed" }));
  view.connect("decide-policy", (_view, decision, decision_type) => decide_policy(host_window, decision, decision_type));

  window.connect("delete-event", () => {
    if (host_window.closing) return false;
    send_event(window_id, { kind: "close_requested" });
    return true;
  });
  window.connect("destroy", () => {
    windows.delete(window_id);
    send_event(window_id, { kind: "closed" });
  });
  window.connect("configure-event", () => {
    const [x, y] = window.get_position();
    const [width, height] = window.get_size();
    send_event(window_id, { kind: "bounds", bounds: { x, y, width, height } });
    return false;
  });
  window.connect("window-state-event", () => {
    report_state(host_window);
    return false;
  });
  window.connect("focus-in-event", () => {
    send_event(window_id, { kind: "focus", focused: true });
    return false;
  });
  window.connect("focus-out-event", () => {
    send_event(window_id, { kind: "focus", focused: false });
    return false;
  });
}

// ============================================================================
// Navigation
// ============================================================================

function decide_policy(host_window: HostWindow, decision: WebKit.PolicyDecision, decision_type: WebKit.PolicyDecisionType): boolean {
  if (decision_type === WebKit.PolicyDecisionType.RESPONSE) return false;
  const action = (decision as WebKit.NavigationPolicyDecision).get_navigation_action();
  const url = action.get_request().get_uri();

  if (decision_type === WebKit.PolicyDecisionType.NEW_WINDOW_ACTION) {
    const decision_id = next_decision_id++;
    pending_decisions.set(decision_id, decision);
    send({ type: "open_window", window_id: host_window.id, decision_id, url });
    return true;
  }

  const navigation_type = action.get_navigation_type();
  const is_own_load = host_window.allow_next_navigation;
  host_window.allow_next_navigation = false;
  if (is_own_load || navigation_type === WebKit.NavigationType.RELOAD || navigation_type === WebKit.NavigationType.BACK_FORWARD) return false;

  const decision_id = next_decision_id++;
  pending_decisions.set(decision_id, decision);
  send({ type: "will_navigate", window_id: host_window.id, decision_id, url });
  return true;
}

// The main process opens any new window itself, so it always answers a new window's decision with a refusal.
function settle_decision(decision_id: number, allow: boolean): void {
  const decision = pending_decisions.get(decision_id);
  pending_decisions.delete(decision_id);
  if (!decision) return;
  if (allow) decision.use();
  else decision.ignore();
}

// ============================================================================
// Page messages
// ============================================================================

function handle_page_message(host_window: HostWindow, value: JavaScriptCore.Value, reply: WebKit.ScriptMessageReply): void {
  const context = value.get_context();
  let message: { kind: "invoke" | "send"; channel: string; payload: string };
  try {
    message = JSON.parse(value.to_string()) as typeof message;
  } catch {
    reply.return_error_message("X-WebView: unreadable message.");
    return;
  }
  const url = host_window.view.get_uri() ?? "";

  if (message.kind === "send") {
    send({ type: "ipc_send", window_id: host_window.id, channel: message.channel, payload: message.payload, url });
    reply.return_value(JavaScriptCore.Value.new_null(context));
    return;
  }

  const call_id = next_call_id++;
  pending_replies.set(call_id, { reply, context });
  send({ type: "ipc_invoke", window_id: host_window.id, call_id, channel: message.channel, payload: message.payload, url });
}

function answer_page(call_id: number, reply_text: string): void {
  const pending = pending_replies.get(call_id);
  pending_replies.delete(call_id);
  pending?.reply.return_value(JavaScriptCore.Value.new_string(pending.context, reply_text));
}

// ============================================================================
// Window commands
// ============================================================================

function run_javascript(view: WebKit.WebView, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    view.evaluate_javascript(code, -1, null, null, null, (_source, result) => {
      try {
        const value = view.evaluate_javascript_finish(result);
        resolve(value.is_undefined() ? "null" : (value.to_json(0) ?? "null"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function run_window_command(host_window: HostWindow, command: WindowCommand): void {
  const { window, view } = host_window;
  switch (command.kind) {
    case "load_url":
      host_window.allow_next_navigation = true;
      view.load_uri(command.url);
      return;
    case "show":
      window.present();
      report_state(host_window);
      return;
    case "hide":
      window.hide();
      report_state(host_window);
      return;
    case "focus":
      window.present();
      return;
    case "close":
      host_window.closing = true;
      window.close();
      return;
    case "destroy":
      host_window.closing = true;
      window.destroy();
      return;
    case "maximize":
      window.maximize();
      return;
    case "unmaximize":
      window.unmaximize();
      return;
    case "minimize":
      window.iconify();
      return;
    case "restore":
      window.deiconify();
      window.present();
      return;
    case "set_fullscreen":
      if (command.fullscreen) window.fullscreen();
      else window.unfullscreen();
      return;
    case "set_title":
      window.set_title(command.title);
      return;
    case "set_background": {
      const color = parse_color(command.color);
      if (color) view.set_background_color(color);
      return;
    }
    case "set_size":
      window.resize(command.width, command.height);
      return;
    case "set_min_size":
      if (fits_screen(command.width, command.height)) window.set_size_request(command.width, command.height);
      return;
    case "reload":
      view.reload();
      return;
    case "open_developer_tools":
      view.get_settings().set_enable_developer_extras(true);
      view.get_inspector().show();
      return;
    case "send":
      run_javascript(view, `globalThis.__x_webview_receive?.(${JSON.stringify(command.channel)}, ${JSON.stringify(command.payload)})`).catch((error: unknown) => printerr(`x-webview host: ${String(error)}`));
      return;
  }
}

// ============================================================================
// Requests
// ============================================================================

function parent_of(window_id: number | null): Gtk.Window | null {
  return window_id === null ? null : (windows.get(window_id)?.window ?? null);
}

function add_filters(chooser: Gtk.FileChooserNative, filters: { name: string; extensions: string[] }[]): void {
  for (const filter of filters) {
    const file_filter = new Gtk.FileFilter();
    file_filter.set_name(filter.name);
    for (const extension of filter.extensions) file_filter.add_pattern(extension === "*" ? "*" : `*.${extension}`);
    chooser.add_filter(file_filter);
  }
}

function run_chooser(chooser: Gtk.FileChooserNative): Promise<string[] | null> {
  return new Promise((resolve) => {
    chooser.connect("response", (_chooser, response) => {
      const paths = response === Gtk.ResponseType.ACCEPT ? chooser.get_files().map((file) => file.get_path() ?? "").filter(Boolean) : null;
      chooser.destroy();
      resolve(paths);
    });
    chooser.show();
  });
}

const message_types: Record<string, Gtk.MessageType> = {
  info: Gtk.MessageType.INFO,
  warning: Gtk.MessageType.WARNING,
  error: Gtk.MessageType.ERROR,
  question: Gtk.MessageType.QUESTION,
};

function run_message_box(request: Extract<HostRequest, { kind: "message_box" }>): Promise<number> {
  return new Promise((resolve) => {
    const dialog = new Gtk.MessageDialog({
      transient_for: parent_of(request.window_id),
      modal: true,
      message_type: message_types[request.type] ?? Gtk.MessageType.OTHER,
      buttons: Gtk.ButtonsType.NONE,
      text: request.message,
      secondary_text: request.detail ?? "",
      title: request.title ?? "",
    });
    const buttons = request.buttons.length ? request.buttons : ["OK"];
    buttons.forEach((label, index) => dialog.add_button(label, index));
    dialog.set_default_response(request.default_id);
    dialog.connect("response", (_dialog, response) => {
      dialog.destroy();
      resolve(response >= 0 ? response : buttons.length - 1);
    });
    dialog.show();
  });
}

function call_session_bus(name: string, path: string, interface_name: string, method: string, parameters: GLib.Variant): Promise<unknown> {
  return new Promise((resolve, reject) => {
    Gio.DBus.session.call(name, path, interface_name, method, parameters, null, Gio.DBusCallFlags.NONE, 5000, null, (_connection, result) => {
      try {
        resolve(Gio.DBus.session.call_finish(result).recursiveUnpack());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function answer_request(request: HostRequest): Promise<unknown> {
  switch (request.kind) {
    case "execute_javascript": {
      const host_window = windows.get(request.window_id);
      if (!host_window) throw new Error("The window is gone.");
      return JSON.parse(await run_javascript(host_window.view, request.code)) as unknown;
    }
    case "save_dialog": {
      const chooser = Gtk.FileChooserNative.new(request.title ?? "Save", parent_of(request.window_id), Gtk.FileChooserAction.SAVE, null, null);
      chooser.set_do_overwrite_confirmation(true);
      if (request.default_path) {
        const default_file = Gio.File.new_for_path(request.default_path);
        const folder = default_file.get_parent();
        if (folder) chooser.set_current_folder(folder.get_path() ?? "");
        chooser.set_current_name(default_file.get_basename() ?? "");
      }
      add_filters(chooser, request.filters);
      const paths = await run_chooser(chooser);
      return paths?.[0] ?? null;
    }
    case "open_dialog": {
      const action = request.directory ? Gtk.FileChooserAction.SELECT_FOLDER : Gtk.FileChooserAction.OPEN;
      const chooser = Gtk.FileChooserNative.new(request.title ?? "Open", parent_of(request.window_id), action, null, null);
      chooser.set_select_multiple(request.multiple);
      if (request.default_path) chooser.set_current_folder(request.default_path);
      add_filters(chooser, request.filters);
      return await run_chooser(chooser);
    }
    case "message_box":
      return await run_message_box(request);
    case "open_external":
      Gio.AppInfo.launch_default_for_uri(request.url, null);
      return null;
    case "open_path":
      Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(request.path).get_uri(), null);
      return null;
    case "show_item_in_folder": {
      const file = Gio.File.new_for_path(request.path);
      try {
        await call_session_bus("org.freedesktop.FileManager1", "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1", "ShowItems", new GLib.Variant("(ass)", [[file.get_uri()], ""]));
      } catch {
        const folder = file.get_parent();
        if (folder) Gio.AppInfo.launch_default_for_uri(folder.get_uri(), null);
      }
      return null;
    }
    case "trash_item":
      Gio.File.new_for_path(request.path).trash(null);
      return null;
    case "notify":
      return await call_session_bus(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
        "Notify",
        new GLib.Variant("(susssasa{sv}i)", [GLib.get_application_name() ?? "", 0, request.icon ?? "", request.title, request.body, [], {}, -1]),
      );
    case "read_clipboard":
      return await new Promise<string>((resolve) => Gtk.Clipboard.get(Gdk.atom_intern("CLIPBOARD", false)).request_text((_clipboard, text) => resolve(text ?? "")));
    case "write_clipboard":
      Gtk.Clipboard.get(Gdk.atom_intern("CLIPBOARD", false)).set_text(request.text, -1);
      return null;
  }
}

// ============================================================================
// Messages
// ============================================================================

function handle_message(message: MainMessage): void {
  switch (message.type) {
    case "create_window":
      create_window(message.window_id, message.settings);
      return;
    case "window": {
      const host_window = windows.get(message.window_id);
      if (host_window) run_window_command(host_window, message.command);
      return;
    }
    case "request":
      answer_request(message.request).then(
        (result) => send({ type: "response", request_id: message.request_id, ok: true, result }),
        (error: unknown) => send({ type: "response", request_id: message.request_id, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return;
    case "ipc_reply":
      answer_page(message.call_id, message.reply);
      return;
    case "decide":
      settle_decision(message.decision_id, message.allow);
      return;
    case "set_theme":
      theme_source = message.source;
      apply_theme();
      return;
    case "quit":
      for (const host_window of windows.values()) host_window.closing = true;
      Gtk.main_quit();
      return;
  }
}

// ============================================================================
// Start
// ============================================================================

Gtk.init(null);
GLib.set_application_name(GLib.getenv("X_WEBVIEW_APP_NAME") ?? "X-WebView");
GLib.set_prgname(GLib.getenv("X_WEBVIEW_APP_ID") ?? "x-webview");

settle_font_dpi();
system_dark = read_system_dark();
apply_theme();
follow_system_theme();

const display = Gdk.Display.get_default();
display?.connect("monitor-added", () => send({ type: "displays", displays: list_displays() }));
display?.connect("monitor-removed", () => send({ type: "displays", displays: list_displays() }));

read_messages();
send({ type: "ready", displays: list_displays(), system_dark });
Gtk.main();
