// Turns IPC arguments into text and back, keeping what Electron's structured clone keeps and JSON would lose.

// ============================================================================
// Tags
// ============================================================================

const TAG = "$x_webview";

type Tagged =
  | { [TAG]: "undefined" }
  | { [TAG]: "date"; value: string }
  | { [TAG]: "bigint"; value: string }
  | { [TAG]: "map"; value: unknown[] }
  | { [TAG]: "set"; value: unknown[] }
  | { [TAG]: "bytes"; value: string }
  | { [TAG]: "error"; value: { name: string; message: string } }
  | { [TAG]: "number"; value: string };

function bytes_to_base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function base64_to_bytes(text: string): Uint8Array {
  const decoded = atob(text);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

// ============================================================================
// Encoding
// ============================================================================

function to_plain(value: unknown): unknown {
  if (value === undefined) return { [TAG]: "undefined" };
  if (typeof value === "bigint") return { [TAG]: "bigint", value: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { [TAG]: "number", value: String(value) };
  if (typeof value === "function" || typeof value === "symbol") return { [TAG]: "undefined" };
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return { [TAG]: "date", value: value.toISOString() };
  if (value instanceof Map) return { [TAG]: "map", value: [...value].map(([key, entry]) => [to_plain(key), to_plain(entry)]) };
  if (value instanceof Set) return { [TAG]: "set", value: [...value].map(to_plain) };
  if (value instanceof ArrayBuffer) return { [TAG]: "bytes", value: bytes_to_base64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) return { [TAG]: "bytes", value: bytes_to_base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (value instanceof Error) return { [TAG]: "error", value: { name: value.name, message: value.message } };
  if (Array.isArray(value)) return value.map(to_plain);
  const plain: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol") plain[key] = to_plain(entry);
  }
  return plain;
}

export function encode(value: unknown): string {
  return JSON.stringify(to_plain(value));
}

// ============================================================================
// Decoding
// ============================================================================

function is_tagged(value: object): value is Tagged {
  return TAG in value && Object.keys(value).length <= 2;
}

function from_plain(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(from_plain);
  if (is_tagged(value)) {
    switch (value[TAG]) {
      case "undefined":
        return undefined;
      case "date":
        return new Date(value.value);
      case "bigint":
        return BigInt(value.value);
      case "number":
        return Number(value.value);
      case "map":
        return new Map((value.value as [unknown, unknown][]).map(([key, entry]) => [from_plain(key), from_plain(entry)]));
      case "set":
        return new Set(value.value.map(from_plain));
      case "bytes":
        return base64_to_bytes(value.value);
      case "error":
        return Object.assign(new Error(value.value.message), { name: value.value.name });
    }
  }
  const plain: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) plain[key] = from_plain(entry);
  return plain;
}

export function decode(text: string): unknown {
  return from_plain(JSON.parse(text));
}
