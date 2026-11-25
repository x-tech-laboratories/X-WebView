#!/usr/bin/env node
// Stands in for the GJS window host in tests: answers the protocol from Node and logs every message it gets to FAKE_HOST_LOG.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log_file = process.env.FAKE_HOST_LOG;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const display = { id: 1, bounds: { x: 0, y: 0, width: 720, height: 1440 }, work_area: { x: 0, y: 0, width: 720, height: 1400 }, scale_factor: 2, is_primary: true };

const answers = {
  execute_javascript: 42,
  save_dialog: "/home/someone/Downloads/tasks.csv",
  open_dialog: ["/home/someone/notes.txt"],
  message_box: 1,
  read_clipboard: "copied",
};

send({ type: "ready", displays: [display], system_dark: true });

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (log_file) appendFileSync(log_file, `${line}\n`);
  if (message.type === "quit") process.exit(0);
  if (message.type === "request") {
    const { kind } = message.request;
    if (kind === "open_path" && message.request.path === "/missing") send({ type: "response", request_id: message.request_id, ok: false, error: "No such file" });
    else send({ type: "response", request_id: message.request_id, ok: true, result: answers[kind] ?? null });
  }
  if (message.type === "window" && message.command.kind === "load_url") {
    const window_id = message.window_id;
    if (message.command.url.includes("broken")) send({ type: "window_event", window_id, event: { kind: "did_fail_load", url: message.command.url, error: "Not found" } });
    else send({ type: "window_event", window_id, event: { kind: "did_finish_load", url: message.command.url } });
    send({ type: "window_event", window_id, event: { kind: "ready_to_show" } });
  }
});
