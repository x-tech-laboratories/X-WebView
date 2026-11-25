#!/usr/bin/env bash
# Runs the sample app on a private Xvfb display and D-Bus, so nothing reaches the desktop, and prints the app's report.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
display=":$(( 100 + RANDOM % 800 ))"

Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp &
xvfb_pid=$!
trap 'kill $xvfb_pid 2>/dev/null || true' EXIT
sleep 1

DISPLAY="$display" GDK_BACKEND=x11 WAYLAND_DISPLAY="" XDG_CACHE_HOME="$(mktemp -d)" \
    "$root/scripts/with_host.sh" dbus-run-session -- timeout 60 node "$root/dist/node/cli.js" "${1:-$root/tests/fixtures/sample_app}"
