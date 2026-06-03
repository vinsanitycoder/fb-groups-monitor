#!/bin/bash
# Creates the "FB Monitor Login" shortcut on the Desktop.
# Run this once during setup from inside the project folder:
#   bash scripts/setup-shortcut.sh

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHORTCUT="$HOME/Desktop/FB Monitor Login.command"

cat > "$SHORTCUT" << SCRIPT
#!/bin/bash
cd "$PROJECT_DIR"

echo ""
echo "=================================================="
echo "  FB Monitor — Re-login"
echo "=================================================="
echo ""
echo "Step 1: Logging into Facebook..."
echo "A browser window will open. Log in manually, then"
echo "come back here. This window will close on its own."
echo ""

node scripts/login.js

if [ \$? -ne 0 ]; then
  echo ""
  echo "Login did not complete. Please try again."
  read -p "Press Enter to close..."
  exit 1
fi

echo ""
echo "Step 2: Restarting the monitor..."
pm2 delete fb-monitor fb-watchdog 2>/dev/null
pm2 start "$PROJECT_DIR/ecosystem.config.js"
pm2 save

echo ""
echo "=================================================="
echo "  Done! Monitor is running again."
echo "=================================================="
echo ""
read -p "Press Enter to close this window..."
SCRIPT

chmod +x "$SHORTCUT"
echo ""
echo "✓ Shortcut created: $SHORTCUT"
echo "  Double-click 'FB Monitor Login' on your Desktop to re-login anytime."
echo ""
