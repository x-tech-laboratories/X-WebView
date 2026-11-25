// The messages the Node main process and the GJS window host send each other, one JSON object per line.

// ============================================================================
// Shapes
// ============================================================================

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  bounds: Rectangle;
  work_area: Rectangle;
  scale_factor: number;
  is_primary: boolean;
}

export interface WindowSettings {
  title: string;
  width: number;
  height: number;
  min_width?: number;
  min_height?: number;
  icon?: string;
  background?: string;
  fullscreen?: boolean;
  resizable?: boolean;
  // The bundled preload, run in the page before any of its own scripts.
  preload_source?: string;
  developer_tools?: boolean;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

// ============================================================================
// Main process to host
// ============================================================================

export type WindowCommand =
  | { kind: "load_url"; url: string }
  | { kind: "show" }
  | { kind: "hide" }
  | { kind: "focus" }
  | { kind: "close" }
  | { kind: "destroy" }
  | { kind: "maximize" }
  | { kind: "unmaximize" }
  | { kind: "minimize" }
  | { kind: "restore" }
  | { kind: "set_fullscreen"; fullscreen: boolean }
  | { kind: "set_title"; title: string }
  | { kind: "set_background"; color: string }
  | { kind: "set_size"; width: number; height: number }
  | { kind: "set_min_size"; width: number; height: number }
  | { kind: "reload" }
  | { kind: "open_developer_tools" }
  // An IPC message for the page's ipcRenderer listeners, its arguments encoded by the codec.
  | { kind: "send"; channel: string; payload: string };

export type HostRequest =
  | { kind: "execute_javascript"; window_id: number; code: string }
  | { kind: "save_dialog"; window_id: number | null; title?: string; default_path?: string; filters: FileFilter[] }
  | { kind: "open_dialog"; window_id: number | null; title?: string; default_path?: string; filters: FileFilter[]; directory: boolean; multiple: boolean }
  | { kind: "message_box"; window_id: number | null; type: string; title?: string; message: string; detail?: string; buttons: string[]; default_id: number }
  | { kind: "open_external"; url: string }
  | { kind: "open_path"; path: string }
  | { kind: "show_item_in_folder"; path: string }
  | { kind: "trash_item"; path: string }
  | { kind: "notify"; title: string; body: string; icon?: string }
  | { kind: "read_clipboard" }
  | { kind: "write_clipboard"; text: string };

export type MainMessage =
  | { type: "create_window"; window_id: number; settings: WindowSettings }
  | { type: "window"; window_id: number; command: WindowCommand }
  | { type: "request"; request_id: number; request: HostRequest }
  | { type: "ipc_reply"; call_id: number; reply: string }
  | { type: "decide"; decision_id: number; allow: boolean }
  | { type: "set_theme"; source: "system" | "light" | "dark" }
  | { type: "quit" };

// ============================================================================
// Host to main process
// ============================================================================

export type WindowEvent =
  | { kind: "ready_to_show" }
  | { kind: "did_finish_load"; url: string }
  | { kind: "did_fail_load"; url: string; error: string }
  | { kind: "title"; title: string }
  | { kind: "url"; url: string }
  | { kind: "close_requested" }
  | { kind: "closed" }
  | { kind: "focus"; focused: boolean }
  | { kind: "bounds"; bounds: Rectangle }
  | { kind: "state"; maximized: boolean; minimized: boolean; fullscreen: boolean; visible: boolean }
  | { kind: "render_process_gone"; reason: string };

export type HostMessage =
  | { type: "ready"; displays: DisplayInfo[]; system_dark: boolean }
  | { type: "window_event"; window_id: number; event: WindowEvent }
  | { type: "response"; request_id: number; ok: boolean; result?: unknown; error?: string }
  // A call from the page's ipcRenderer.invoke; the main process answers with ipc_reply.
  | { type: "ipc_invoke"; window_id: number; call_id: number; channel: string; payload: string; url: string }
  | { type: "ipc_send"; window_id: number; channel: string; payload: string; url: string }
  // A navigation or new window the main process allows or refuses with decide.
  | { type: "will_navigate"; window_id: number; decision_id: number; url: string }
  | { type: "open_window"; window_id: number; decision_id: number; url: string }
  | { type: "displays"; displays: DisplayInfo[] }
  | { type: "system_theme"; system_dark: boolean };

// The reply to an ipc_invoke, as the page reads it.
export type IpcReply = { ok: true; payload: string } | { ok: false; error: string };
