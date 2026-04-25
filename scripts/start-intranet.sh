#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
LOG_FILE="${LOG_FILE:-four-keypoint-labeler.log}"
PID_FILE="${PID_FILE:-four-keypoint-labeler.pid}"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Four Keypoint Labeler is already running with PID $(cat "$PID_FILE")."
  exit 0
fi

nohup env PORT="$PORT" node server.js >"$LOG_FILE" 2>&1 &
echo "$!" >"$PID_FILE"
echo "Four Keypoint Labeler started with PID $(cat "$PID_FILE")."
echo "Log: $LOG_FILE"
