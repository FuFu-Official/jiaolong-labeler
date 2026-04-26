#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
APP_MODE="${APP_MODE:-shared}"
LOG_FILE="${LOG_FILE:-jiaolong-labeler.log}"
PID_FILE="${PID_FILE:-jiaolong-labeler.pid}"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Jiaolong Labeler is already running with PID $(cat "$PID_FILE")."
  exit 0
fi

nohup env APP_MODE="$APP_MODE" HOST="$HOST" PORT="$PORT" node server.js >"$LOG_FILE" 2>&1 &
echo "$!" >"$PID_FILE"
echo "Jiaolong Labeler started with PID $(cat "$PID_FILE")."
echo "Log: $LOG_FILE"
