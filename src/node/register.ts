// Points every import or require of electron at X-WebView's own module.

import { registerHooks } from "node:module";

export const electron_url = new URL("./electron.js", import.meta.url).href;
const electron_names = new Set(["electron", "electron/main", "electron/common"]);

registerHooks({
  resolve(specifier, context, next) {
    if (electron_names.has(specifier)) return { url: electron_url, format: "module", shortCircuit: true };
    return next(specifier, context);
  },
});
