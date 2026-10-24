#!/usr/bin/env bash
# Boom Beard — undo the last deploy.
#
#   npm run rollback
#
# infra/deploy.sh snapshots the tree to /opt/boom-beard.prev before every sync, using hardlinks,
# so this is a directory swap rather than a transfer. One level deep: rolling back twice returns
# you to where you started.

set -euo pipefail

ini() { sed -n "/^\[$1\]/,/^\[/p" config.ini 2>/dev/null | sed -n "s/^ *$2 *= *//p" | head -1; }
SSH_HOST="${SSH_HOST:-$(ini deploy ssh_host)}"
SSH_USER="${SSH_USER:-$(ini deploy ssh_user)}"
KEY="${KEY:-$(ini deploy ssh_key)}"
: "${SSH_HOST:?set ssh_host in [deploy] of config.ini}"
SSH_USER="${SSH_USER:-ec2-user}"
KEY="${KEY/#\~/$HOME}"

ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$SSH_HOST" bash -s <<'REMOTE'
set -euo pipefail
APP=/opt/boom-beard
PREV=/var/lib/boom-beard/prev
[ -d "$PREV" ] || { echo "no snapshot to roll back to — deploy at least once first"; exit 1; }

# Swap, keeping what we are leaving as the new snapshot, so rollback is its own undo.
SWAP=/var/lib/boom-beard/swap
rm -rf "$SWAP"
rsync -a --delete --exclude node_modules --exclude config.ini --link-dest="$APP/" "$APP/" "$SWAP/"
rsync -a --delete --exclude node_modules --exclude config.ini --exclude .git "$PREV/" "$APP/"
rm -rf "$PREV"
mv "$SWAP" "$PREV"

cd "$APP"
[ -d node_modules ] || npm ci --omit=dev --silent
sudo -n /usr/bin/systemctl restart boom-beard
sleep 1
curl -sfk https://localhost/healthz || curl -sf http://localhost:8080/healthz
echo
echo "rolled back"
REMOTE
