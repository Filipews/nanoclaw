#!/bin/bash
echo "=== NanoClaw Health Check ==="
echo -n "nanoclaw service:    "; systemctl is-active nanoclaw
echo -n "safe-google-mcp:     "; systemctl is-active safe-google-mcp
echo -n "docker:              "; systemctl is-active docker
echo -n "MCP server (3100):   "
curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:3100/health 2>/dev/null \
  || curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:3100/ 2>/dev/null \
  || { nc -z 127.0.0.1 3100 2>/dev/null && echo "200"; }; echo " OK" || echo " FAIL"
echo -n "gws auth:            "; gws auth status 2>&1 | head -1
echo ""
echo "Last 5 cost_log entries:"
sqlite3 ~/nanoclaw/store/messages.db \
  "SELECT timestamp, source, model, printf('\$%.4f', cost_usd) FROM cost_log ORDER BY id DESC LIMIT 5;" \
  2>/dev/null || echo "(no entries yet)"
