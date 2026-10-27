#!/usr/bin/env bash
# Boom Beard - one-time server setup. Amazon Linux 2023. Idempotent: safe to re-run, and
# re-running is exactly how you switch to a new domain.
#
#   scp -i key.pem infra/bootstrap.sh ec2-user@HOST:/tmp/
#   ssh -i key.pem ec2-user@HOST 'HOST=boombeard.co.za \
#                                 ALT_HOSTS="www.boombeard.co.za 15.240.88.189.sslip.io" \
#                                 EMAIL=you@example.com bash /tmp/bootstrap.sh'
#
# HOST is the canonical name or public IP. Everything in ALT_HOSTS is answered and then 301d to
# HOST, so the address bar only ever shows one URL - see the canonical-host block in server/index.js.
#
# Variables:
#   HOST       required. Primary hostname or IP address; it must point/reach this box.
#   ALT_HOSTS  optional. Space-separated extra DNS names for the same certificate (e.g. www).
#   REGION_ID  `za` or `us`; defaults to an existing config value or `za`.
#   SHARED_DATA_TOKEN  server-to-server secret. ZA creates one if absent; US requires the same
#   value supplied securely from ZA.
#   SHARED_DATA_HOST   fixed ZA Elastic IP used by the US internal HTTPS client.
#   SHARED_DATA_SERVERNAME TLS name used to verify the ZA certificate.
#   EMAIL      optional contact for certificate expiry notices. If absent, Certbot registers
#              without email alerts; the daily renewal timer must be monitored.
#   SKIP_TLS=1 provision everything except the certificate; serve plain HTTP on 8080. Use this
#   before DNS or ingress is ready, or behind a load balancer that terminates TLS. The /admin dashboard
#   requires app-level TLS and is unavailable in this mode.
#   IP HOSTs use Let's Encrypt's six-day `shortlived` profile and renew daily.
#   REPO       git remote to clone if /opt/boom-beard is not already a clone.
#
# Note: no apostrophes inside ${VAR:?msg} - bash parses them as a quote and dies at EOF.

set -euo pipefail

HOST="${HOST:?set HOST to the public hostname or IP, e.g. boombeard.co.za}"
ALT_HOSTS="${ALT_HOSTS:-}"
SKIP_TLS="${SKIP_TLS:-0}"
EMAIL="${EMAIL:-}"
REGION_ID="${REGION_ID:-}"
# SSH form, because the repo is private. The box authenticates with a read-only deploy key that
# this script generates; add the printed public key under GitHub > Settings > Deploy keys.
REPO="${REPO:-git@github.com:cobusvonwielligh/boom-beard.git}"

APP_DIR=/opt/boom-beard
DATA_DIR=/var/lib/boom-beard
CERT_DIR="$DATA_DIR/certs"
UNIT=/etc/systemd/system/boom-beard.service

echo "==> packages"
# `npm` pulls in nodejs18 as a dependency and wins the alternatives link, so install 22
# explicitly and then claim the link. Without the --set, `node` is silently 18.
sudo dnf -q -y install nodejs22 nodejs22-npm git rsync python3-pip python3.11
sudo alternatives --set node /usr/bin/node-22
node --version
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "need node >= 20"; exit 1; }

echo "==> sshd"
# Keys only, no root, no X11. Files in sshd_config.d are read before the main config and the first
# value wins, so this overrides the distribution's defaults without editing them. Validated
# before the reload, because a broken sshd config on a box you reach only by SSH is a lockout.
sudo tee /etc/ssh/sshd_config.d/00-boom-beard.conf >/dev/null <<'SSHD'
# Boom Beard hardening. Files here are read before the main config, and the first value wins.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers ec2-user
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
SSHD
sudo chmod 600 /etc/ssh/sshd_config.d/00-boom-beard.conf
if sudo sshd -t; then sudo systemctl reload sshd; else
  sudo rm -f /etc/ssh/sshd_config.d/00-boom-beard.conf; echo "    !! sshd rejected it; left as it was"
fi

echo "==> directories"
sudo mkdir -p "$APP_DIR" "$DATA_DIR" "$CERT_DIR"
sudo chown -R ec2-user:ec2-user "$APP_DIR" "$DATA_DIR"

echo "==> deploy key"
# The key lives under $DATA_DIR, not ~/.ssh, because self-update.sh runs inside the unit's
# sandbox where ProtectHome=true makes /home invisible. See infra/self-update.sh.
SSH_DIR="$DATA_DIR/ssh"
mkdir -p "$SSH_DIR"
if [ ! -f "$SSH_DIR/deploy_key" ]; then
  if [ -f ~/.ssh/boom_beard_deploy ]; then
    # Reuse a key already registered on GitHub rather than making the user add a second one.
    cp ~/.ssh/boom_beard_deploy "$SSH_DIR/deploy_key"
  else
    ssh-keygen -t ed25519 -N "" -C "boom-beard deploy key (read-only)" -f "$SSH_DIR/deploy_key" -q
  fi
fi
chmod 700 "$SSH_DIR"; chmod 600 "$SSH_DIR/deploy_key"
ssh-keygen -y -f "$SSH_DIR/deploy_key" > "$SSH_DIR/deploy_key.pub"
ssh-keyscan -t ed25519,rsa github.com > "$SSH_DIR/known_hosts" 2>/dev/null

# A matching config for interactive git as ec2-user, which is outside the sandbox.
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat > ~/.ssh/config <<SSHCFG
Host github.com
  IdentityFile $SSH_DIR/deploy_key
  IdentitiesOnly yes
  UserKnownHostsFile $SSH_DIR/known_hosts
  StrictHostKeyChecking accept-new
SSHCFG
chmod 600 ~/.ssh/config

echo "==> source"
# A failed clone must not abort the run: TLS, config.ini and the unit still need installing, and
# the tree can arrive by rsync in the meantime. Only the self-update webhook needs git.
GIT_OK=1
if [ ! -d "$APP_DIR/.git" ]; then
  # Clone into a temp dir and move only .git across, because $APP_DIR may already hold an rsync.
  rm -rf /tmp/bv-clone
  if git clone --quiet --depth 50 "$REPO" /tmp/bv-clone; then
    mv /tmp/bv-clone/.git "$APP_DIR/.git"
    rm -rf /tmp/bv-clone
    cd "$APP_DIR" && git reset --hard --quiet origin/main
  else
    GIT_OK=0
    echo "    !! clone failed. Add this public key as a read-only deploy key at"
    echo "       https://github.com/cobusvonwielligh/boom-beard/settings/keys/new"
    echo
    sed 's/^/       /' "$SSH_DIR/deploy_key.pub"
    echo
    echo "    Continuing without git. Push code with 'npm run deploy' until it is added;"
    echo "    re-run this script afterwards to enable CI deploys."
  fi
else
  cd "$APP_DIR" && git fetch --quiet origin main && git reset --hard --quiet origin/main
fi
cd "$APP_DIR"
[ -f package.json ] && npm ci --omit=dev --silent || true

# Used by infra/deploy.sh over SSH. The service itself cannot sudo at all: the unit sets
# NoNewPrivileges, and self-update.sh restarts by signalling the server instead.
echo "==> sudoers for deploys (three exact commands, nothing broader)"
sudo tee /etc/sudoers.d/boom-beard >/dev/null <<SUDO
Cmnd_Alias BOOM_BEARD = /usr/bin/systemctl restart boom-beard, \\
                         /usr/bin/systemctl daemon-reload, \\
                         /usr/bin/cp $APP_DIR/infra/boom-beard.service $UNIT
ec2-user ALL=(root) NOPASSWD: BOOM_BEARD
SUDO
sudo chmod 440 /etc/sudoers.d/boom-beard
sudo visudo -c -f /etc/sudoers.d/boom-beard >/dev/null

# config.ini is never in git and never rsynced, so a deploy cannot clobber it. Preserve existing
# secrets across re-runs - regenerating the deploy token breaks CI, and rotating the dashboard
# password without notice would lock the owner out.
# Guard the file test rather than relying on 2>/dev/null: with `set -o pipefail` a missing file
# makes the whole pipeline fail and takes the script with it.
TOKEN=""
ADMIN_KEY=""
SHARED_DATA_TOKEN="${SHARED_DATA_TOKEN:-}"
SHARED_DATA_HOST="${SHARED_DATA_HOST:-}"
SHARED_DATA_SERVERNAME="${SHARED_DATA_SERVERNAME:-}"
SHARED_DATA_TOKEN_FILE=/tmp/boom-beard-shared-token
DASHBOARD_PASSWORD=${ADMIN_DASHBOARD_PASSWORD:-}
if [ -f "$APP_DIR/config.ini" ]; then
  TOKEN=$(sed -n 's/^ *token *= *//p' "$APP_DIR/config.ini" | head -1 || true)
  ADMIN_KEY=$(sed -n 's/^ *key *= *//p' "$APP_DIR/config.ini" | head -1 || true)
  [ -n "$REGION_ID" ] \
    || REGION_ID=$(sed -n 's/^ *region_id *= *//p' "$APP_DIR/config.ini" | head -1 || true)
  [ -n "$DASHBOARD_PASSWORD" ] \
    || DASHBOARD_PASSWORD=$(sed -n 's/^ *dashboard_password *= *//p' "$APP_DIR/config.ini" | head -1 || true)
  [ -n "$SHARED_DATA_TOKEN" ] \
    || SHARED_DATA_TOKEN=$(sed -n '/^\[shared\]/,/^\[/s/^ *token *= *//p' "$APP_DIR/config.ini" | head -1 || true)
  [ -n "$SHARED_DATA_HOST" ] \
    || SHARED_DATA_HOST=$(sed -n '/^\[shared\]/,/^\[/s/^ *host *= *//p' "$APP_DIR/config.ini" | head -1 || true)
  [ -n "$SHARED_DATA_SERVERNAME" ] \
    || SHARED_DATA_SERVERNAME=$(sed -n '/^\[shared\]/,/^\[/s/^ *servername *= *//p' "$APP_DIR/config.ini" | head -1 || true)
fi
if [ -z "$SHARED_DATA_TOKEN" ] && [ -f "$SHARED_DATA_TOKEN_FILE" ]; then
  chmod 600 "$SHARED_DATA_TOKEN_FILE"
  SHARED_DATA_TOKEN=$(cat "$SHARED_DATA_TOKEN_FILE")
fi
[ -n "$REGION_ID" ] || REGION_ID=za
case "$REGION_ID" in
  za|us) ;;
  *) echo "REGION_ID must be za or us" >&2; exit 1 ;;
esac
HOST_IS_IP=0
if python3 -c 'import ipaddress, sys; ipaddress.ip_address(sys.argv[1])' "$HOST" >/dev/null 2>&1; then
  HOST_IS_IP=1
fi
if [ "$REGION_ID" = us ] && [ "$HOST_IS_IP" != 1 ]; then
  echo "REGION_ID=us requires HOST to be an IP address; no regional hostname is used" >&2
  exit 1
fi
if [ "$REGION_ID" = za ] && [ "$SKIP_TLS" != 1 ] && [ -z "$DASHBOARD_PASSWORD" ]; then
  echo "ADMIN_DASHBOARD_PASSWORD is required for TLS deployments" >&2
  exit 1
fi
[ -n "$TOKEN" ] || TOKEN=$(openssl rand -hex 32)
[ -n "$ADMIN_KEY" ] || ADMIN_KEY=$(openssl rand -hex 16)
[ -n "$SHARED_DATA_HOST" ] || SHARED_DATA_HOST=15.240.88.189
[ -n "$SHARED_DATA_SERVERNAME" ] || SHARED_DATA_SERVERNAME=boombeard.co.za
if [ "$REGION_ID" = za ] && [ -z "$SHARED_DATA_TOKEN" ]; then
  SHARED_DATA_TOKEN=$(openssl rand -hex 32)
fi
if [ "$REGION_ID" = us ] && [ -z "$SHARED_DATA_TOKEN" ]; then
  echo "REGION_ID=us requires SHARED_DATA_TOKEN copied securely from the ZA host" >&2
  exit 1
fi

write_config() {
  cat > "$APP_DIR/config.ini" <<CFG
; Generated by infra/bootstrap.sh on $(date -Is). Not in git.
[server]
port          = $1
redirect_port = $2
public_host   = $HOST
region_id     = $REGION_ID
tls_cert      = $3
tls_key       = $4
data_dir      = $DATA_DIR
max_players   = 16

[deploy]
token = $TOKEN

[shared]
token = $SHARED_DATA_TOKEN
host = $SHARED_DATA_HOST
servername = $SHARED_DATA_SERVERNAME

[admin]
key = $ADMIN_KEY
dashboard_password = $DASHBOARD_PASSWORD

[dev]
lag    = 0
jitter = 0
CFG
  chmod 600 "$APP_DIR/config.ini"
  printf '%s' "$SHARED_DATA_TOKEN" > "$DATA_DIR/shared-data-token"
  chmod 600 "$DATA_DIR/shared-data-token"
  rm -f "$SHARED_DATA_TOKEN_FILE"
}

install_unit() {
  sudo cp "$APP_DIR/infra/boom-beard.service" "$UNIT"
  sudo systemctl daemon-reload
  sudo systemctl enable --now boom-beard
  sudo systemctl restart boom-beard
}

if [ "$SKIP_TLS" = 1 ]; then
  echo "==> SKIP_TLS=1 - plain HTTP on 8080, no certificate"
  write_config 8080 0 "" ""
  install_unit
  echo
  echo "bootstrap done (no TLS). Re-run without SKIP_TLS once the public host and ports 80/443 are reachable."
  if [ "$REGION_ID" = us ]; then
    echo "US game server is game-only; the website and dashboard remain on https://boombeard.co.za"
  fi
  echo "deploy token: $TOKEN"
  exit 0
fi

echo "==> certbot"
CERTBOT_HOME=/opt/certbot311
if [ ! -x "$CERTBOT_HOME/bin/certbot" ]; then
  sudo python3.11 -m venv "$CERTBOT_HOME"
fi
sudo "$CERTBOT_HOME/bin/pip" install -q --upgrade pip certbot
CERTBOT_HELP=$("$CERTBOT_HOME/bin/certbot" certonly --help all 2>&1)
if [ "$HOST_IS_IP" = 1 ] && [[ "$CERTBOT_HELP" != *"--ip-address"* ]]; then
  echo "installed Certbot does not support IP-address certificates" >&2
  exit 1
fi

CERTBOT_ACCOUNT_ARGS=()
if [ -n "$EMAIL" ]; then
  CERTBOT_ACCOUNT_ARGS=(-m "$EMAIL")
else
  CERTBOT_ACCOUNT_ARGS=(--register-unsafely-without-email)
  echo "No certificate contact email; monitor the daily renewal timer."
fi

CERT_IDENTIFIER_ARGS=()
if [ "$HOST_IS_IP" = 1 ]; then
  [ -z "$ALT_HOSTS" ] || { echo "ALT_HOSTS cannot be used with an IP certificate" >&2; exit 1; }
  CERT_IDENTIFIER_ARGS=(--ip-address "$HOST" --preferred-profile shortlived)
else
  CERT_IDENTIFIER_ARGS=(-d "$HOST")
  for h in $ALT_HOSTS; do CERT_IDENTIFIER_ARGS+=(-d "$h"); done
fi

# Certbot standalone binds :80, so the game server must be out of the way for the moment it runs.
sudo systemctl stop boom-beard 2>/dev/null || true

echo "==> certificate for $HOST ${ALT_HOSTS:+(+ $ALT_HOSTS)}"
# --cert-name pins the lineage to $HOST. Without it certbot names the directory after whichever
# domain happened to come first and can fork a second lineage when the list changes, at which
# point the deploy hook below is copying from a path that no longer gets renewed.
if ! sudo "$CERTBOT_HOME/bin/certbot" certonly --standalone --non-interactive --agree-tos \
  --cert-name "$HOST" --keep-until-expiring --expand "${CERTBOT_ACCOUNT_ARGS[@]}" \
  "${CERT_IDENTIFIER_ARGS[@]}"; then
  if ! sudo systemctl start boom-beard; then
    echo "certificate request failed and the game service could not be restarted" >&2
  else
    echo "certificate request failed; the previous game service was restarted" >&2
  fi
  exit 1
fi

# Node runs unprivileged and cannot read /etc/letsencrypt. Copy the pair somewhere it can,
# on issue and on every renewal.
echo "==> certificate deploy hook"
sudo tee /etc/letsencrypt/renewal-hooks/deploy/boom-beard.sh >/dev/null <<HOOK
#!/usr/bin/env bash
set -eu
install -o ec2-user -g ec2-user -m 0644 "/etc/letsencrypt/live/$HOST/fullchain.pem" "$CERT_DIR/fullchain.pem"
install -o ec2-user -g ec2-user -m 0600 "/etc/letsencrypt/live/$HOST/privkey.pem"  "$CERT_DIR/privkey.pem"
systemctl restart boom-beard
HOOK
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/boom-beard.sh
if ! sudo /etc/letsencrypt/renewal-hooks/deploy/boom-beard.sh; then
  if ! sudo systemctl start boom-beard; then
    echo "certificate install failed and the game service could not be restarted" >&2
  else
    echo "certificate install failed; the previous game service was restarted" >&2
  fi
  exit 1
fi

echo "==> daily certificate renewal"
sudo tee /etc/systemd/system/certbot-renew.service >/dev/null <<'UNIT'
[Unit]
Description=Renew TLS certificates
[Service]
Type=oneshot
ExecStart=/opt/certbot311/bin/certbot renew --quiet --standalone --pre-hook "systemctl stop boom-beard" --post-hook "systemctl start boom-beard"
UNIT
sudo tee /etc/systemd/system/certbot-renew.timer >/dev/null <<'UNIT'
[Unit]
Description=Daily certificate renewal
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
UNIT

echo "==> service"
write_config 443 80 "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem"
install_unit
sudo systemctl daemon-reload
sudo systemctl enable --now certbot-renew.timer

echo
echo "bootstrap done: https://$HOST"
echo
echo "GitHub repo secrets to set (Settings > Secrets and variables > Actions):"
echo "  DEPLOY_URL   = https://$HOST/deploy"
echo "  DEPLOY_TOKEN = $TOKEN"
echo
if [ "$REGION_ID" = za ]; then
  echo "Host link, open once in your own browser: https://$HOST/?admin=$ADMIN_KEY"
else
  echo "US game server is game-only; the website and dashboard remain on https://boombeard.co.za"
fi
