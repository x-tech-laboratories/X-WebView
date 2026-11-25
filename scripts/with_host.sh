#!/usr/bin/env bash
# Runs a command with gjs and the GTK 3 and WebKitGTK typelibs from nixpkgs, as the Nix package's wrapper does.
set -euo pipefail

packages=$(nix build --no-link --print-out-paths nixpkgs#gjs nixpkgs#webkitgtk_4_1)
typelib_folders=""
for path in $(nix-store -qR $packages); do
    if [ -d "$path/lib/girepository-1.0" ]; then typelib_folders="$typelib_folders:$path/lib/girepository-1.0"; fi
done

GI_TYPELIB_PATH="${typelib_folders#:}" X_WEBVIEW_GJS="$(echo "$packages" | grep gjs | head -1)/bin/gjs" "$@"
