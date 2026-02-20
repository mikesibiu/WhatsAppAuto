#!/bin/bash
set -e

cd "$(dirname "$0")"

# If already running, stop it first (queue is safe — persisted in queue.json)
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  echo "Stopping running server (PID $(cat server.pid))..."
  kill -SIGUSR1 "$(cat server.pid)"
  for i in $(seq 1 10); do
    sleep 0.5
    kill -0 "$(cat server.pid)" 2>/dev/null || { echo "Stopped."; break; }
  done
  if kill -0 "$(cat server.pid)" 2>/dev/null; then
    echo "Error: server (PID $(cat server.pid)) did not stop within 5 seconds. Aborting."
    echo "Force-stop with: kill -9 $(cat server.pid)"
    exit 1
  fi
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting WhatsApp Scheduler (daemon)..."

nohup node server.js >> server.log 2>&1 &
NODE_PID=$!
echo $NODE_PID > server.pid

nohup caffeinate -s -w $NODE_PID > /dev/null 2>&1 &
disown $NODE_PID
disown $!

echo "Started  PID $NODE_PID"
echo "Logs:    $(pwd)/server.log"
echo "Stop:    kill \$(cat server.pid)"
