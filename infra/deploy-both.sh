#!/usr/bin/env bash
# Deploy one working tree to ZA, then US, using the single-instance deployer.
set -euo pipefail

ini() { sed -n "/^\[$1\]/,/^\[/p" config.ini 2>/dev/null | sed -n "s/^ *$2 *= *//p" | head -1; }

ZA_SSH_HOST="${ZA_SSH_HOST:-$(ini deploy ssh_host)}"
ZA_SSH_USER="${ZA_SSH_USER:-$(ini deploy ssh_user)}"
ZA_SSH_KEY="${ZA_SSH_KEY:-$(ini deploy ssh_key)}"
US_SSH_HOST="${US_SSH_HOST:-$(ini deploy_us ssh_host)}"
US_SSH_USER="${US_SSH_USER:-$(ini deploy_us ssh_user)}"
US_SSH_KEY="${US_SSH_KEY:-$(ini deploy_us ssh_key)}"

require_target() {
  local region="$1" host="$2" user="$3" key="$4" resolved_key="$4"
  if [[ -z "$host" || -z "$user" || -z "$key" ]]; then
    echo "$region deployment configuration is incomplete." >&2
    return 1
  fi
  if [[ ${resolved_key:0:2} == "~/" ]]; then
    resolved_key="$HOME/${resolved_key:2}"
  fi
  if ! test -r "$resolved_key"; then
    echo "$region SSH key is not readable: $resolved_key" >&2
    return 1
  fi
}

if [[ "$ZA_SSH_HOST" == "$US_SSH_HOST" ]]; then
  echo "ZA and US deployment hosts must be different." >&2
  exit 1
fi

require_target "ZA" "$ZA_SSH_HOST" "$ZA_SSH_USER" "$ZA_SSH_KEY"
require_target "US" "$US_SSH_HOST" "$US_SSH_USER" "$US_SSH_KEY"

deploy_region() {
  local region="$1" host="$2" user="$3" key="$4"
  printf '\n==> Deploying %s (%s)\n' "$region" "$host"
  SSH_HOST="$host" SSH_USER="$user" KEY="$key" ./infra/deploy.sh
}

deploy_region "ZA" "$ZA_SSH_HOST" "$ZA_SSH_USER" "$ZA_SSH_KEY"
deploy_region "US" "$US_SSH_HOST" "$US_SSH_USER" "$US_SSH_KEY"
