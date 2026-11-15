#!/usr/bin/env bash
# Install status-agent as a macOS LaunchAgent so it keeps running after login.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/.local/share/status-agent"
CONFIG="$HOME/.config/status-agent/config.json"
PLIST="$HOME/Library/LaunchAgents/com.lambeta.status-agent.plist"
LOG_DIR="$HOME/Library/Logs"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "找不到 node，请先安装 Node.js >= 22" >&2
  exit 1
fi

mkdir -p "$APP_DIR" "$(dirname "$CONFIG")" "$LOG_DIR" "$(dirname "$PLIST")"

rsync -a --delete --exclude node_modules --exclude .git "$HERE/" "$APP_DIR/"

if [ ! -f "$CONFIG" ]; then
  cp "$APP_DIR/config.example.json" "$CONFIG"
  echo "已生成配置文件：$CONFIG"
  echo "先填好 apps / feishu 再启动；改完执行：launchctl kickstart -k gui/$(id -u)/com.lambeta.status-agent"
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.lambeta.status-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/agent.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/status-agent.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/status-agent.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.lambeta.status-agent"

echo "已安装并启动。看板：http://127.0.0.1:8787/  日志：$LOG_DIR/status-agent.log"
