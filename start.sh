#!/bin/bash
set -e

cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Guard against double-start
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  echo "Already running (PID $(cat server.pid)) — open http://localhost:3000"
  exit 0
fi

echo "Starting WhatsApp Scheduler (daemon)..."

# Start Node detached from terminal; log stdout+stderr to server.log
nohup node server.js >> server.log 2>&1 &
NODE_PID=$!
echo $NODE_PID > server.pid

# caffeinate -s  → prevent system sleep
# caffeinate -w  → release automatically when Node exits (auto-shutdown still works)
caffeinate -s -w $NODE_PID &
disown $NODE_PID
disown $!

echo "Started  PID $NODE_PID"
echo "Logs:    $(pwd)/server.log"
echo "Stop:    kill \$(cat server.pid)"
