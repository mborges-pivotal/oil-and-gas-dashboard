#!/usr/bin/env bash
# Starts the Oil & Gas Dashboard: one Node process serving the static app
# and relaying the third-party APIs that don't send CORS headers.
#
# API keys (EIA_API_KEY, FRED_API_KEY) and other settings are picked up
# automatically from a local .env file if present — copy .env.example to
# .env and fill it in. No .env needed at all if you don't want those tabs.
#
# Safe to run from anywhere — cd's to its own location first.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Dashboard: http://localhost:${PORT:-3000}"
node server.js
