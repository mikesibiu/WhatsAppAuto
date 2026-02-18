#!/bin/bash
set -e

cd "$(dirname "$0")"

# --restart: gracefully stop the running instance before starting fresh.
# Pending messages are safe — they're persisted in queue.json.
if [ "$1" = "--restart" ]; then
  if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
    echo "Stopping running server (PID $(cat server.pid))..."
    kill "$(cat server.pid)"          # sends SIGTERM → server saves state and exits cleanly
    for i in $(seq 1 10); do         # wait up to 5 s
      sleep 0.5
      kill -0 "$(cat server.pid)" 2>/dev/null || { echo "Stopped."; break; }
    done
    if kill -0 "$(cat server.pid)" 2>/dev/null; then
      echo "Error: server (PID $(cat server.pid)) did not stop within 5 seconds. Aborting."
      echo "Force-stop with: kill -9 $(cat server.pid)"
      exit 1
    fi
  else
    echo "No running server found, starting fresh."
  fi
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Guard against accidental double-start (without --restart)
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  echo "Already running (PID $(cat server.pid)) — open http://localhost:3000"
  echo "To apply an update, use: ./start.sh --restart"
  exit 0
fi

echo "Starting WhatsApp Scheduler (daemon)..."

# Start Node detached from terminal; log stdout+stderr to server.log
nohup node server.js >> server.log 2>&1 &
NODE_PID=$!
echo $NODE_PID > server.pid

# caffeinate -s  → prevent system sleep
# caffeinate -w  → exit automatically when Node exits (auto-shutdown still works)
caffeinate -s -w $NODE_PID &
disown $NODE_PID
disown $!

echo "Started  PID $NODE_PID"
echo "Logs:    $(pwd)/server.log"
echo "Restart: ./start.sh --restart"
echo "Stop:    kill \$(cat server.pid)"
