#!/usr/bin/env bash
# Starts the Oil & Gas Dashboard: one Node process serving the static app
# and relaying the third-party APIs that don't send CORS headers.
#
# Safe to run from anywhere — cd's to its own location first.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Dashboard: http://localhost:${PORT:-3000}"
node server.js
