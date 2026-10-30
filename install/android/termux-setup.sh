#!/data/data/com.termux/files/usr/bin/sh
# Run an AUREN node on an Android phone or tablet using the free Termux app (install Termux from F-Droid).
#   1) Copy the AUREN folder (or download the .tar.gz) into Termux, then:   sh install/android/termux-setup.sh
# This installs Node.js inside Termux and starts a node on the testnet. It is not an APK: Android apps need
# the Android SDK and a signing key, which this project does not ship yet.
set -e
cd "$(dirname "$0")/../.."
if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js inside Termux..."
  pkg update -y && pkg install -y nodejs
fi
NET="${1:-testnet}"
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true   # keep the node alive with the screen off
echo "Joining the AUREN $NET. Leave Termux open (or pinned in the notification) to keep the node running."
exec node bin/auren.js join "$NET"
