#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PID_FILE="${PID_FILE:-four-keypoint-labeler.pid}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file found."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped Four Keypoint Labeler PID $PID."
else
  echo "Process $PID is not running."
fi

rm -f "$PID_FILE"
