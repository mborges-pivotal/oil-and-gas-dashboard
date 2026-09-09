#!/usr/bin/env bash
# Starts the Oil & Gas Dashboard: the local Yahoo Finance CORS relay
# (local-proxy.js) plus a static file server for this directory.
#
# Safe to run from anywhere — cd's to its own location first. Running
# `npx serve .` from the wrong directory (e.g. the parent repo root)
# serves a directory listing instead of the app, and every asset 404s.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

node local-proxy.js &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null' EXIT

echo "Local Yahoo Finance proxy: http://localhost:8787"
echo "Dashboard:                 http://localhost:3000"
echo "(Ctrl-C stops both)"
npx serve . -l 3000
