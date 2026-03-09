#!/bin/bash
# Run on a new machine after rsyncing files from old machine
set -e
echo "=== NanoClaw Migration ==="

cd ~/nanoclaw && npm install && npm run build
cd ~/safe-google-mcp && npm install && npm run build
docker build -t nanoclaw-agent ~/nanoclaw/container

sudo cp ~/nanoclaw/scripts/nanoclaw-logrotate.conf /etc/logrotate.d/nanoclaw
sudo systemctl daemon-reload
sudo systemctl enable nanoclaw safe-google-mcp
sudo systemctl start nanoclaw safe-google-mcp

echo "Done. Check: sudo journalctl -u nanoclaw -f"
