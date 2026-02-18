#!/bin/bash
set -e

cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting WhatsApp Scheduler..."
caffeinate -s node server.js
