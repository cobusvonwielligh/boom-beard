import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('bootstrap preserves and writes the configured regional identity', async () => {
  const script = await readFile(path.join(ROOT, 'infra/bootstrap.sh'), 'utf8');

  assert.match(script, /REGION_ID="\$\{REGION_ID:-\}"/);
  assert.match(script, /region_id\s+=\s+\$REGION_ID/);
  assert.match(script, /REGION_ID must be za or us/);
  assert.match(script, /ADMIN_KEY=\$\(\s*openssl rand -hex 16\s*\)/);
  assert.doesNotMatch(script, /ADMIN_KEY="\$\{ADMIN_KEY:-\}"/);
  assert.match(script, /SKIP_TLS.*DASHBOARD_PASSWORD/);
});

test('bootstrap requests short-lived IP certificates and renews them daily', async () => {
  const script = await readFile(path.join(ROOT, 'infra/bootstrap.sh'), 'utf8');

  assert.match(script, /--preferred-profile shortlived/);
  assert.match(script, /--ip-address "\$HOST"/);
  assert.match(script, /-d "\$HOST"/);
  assert.match(script, /OnCalendar=daily/);
});

test('bootstrap validates IP certificate arguments before stopping the service', async () => {
  const script = await readFile(path.join(ROOT, 'infra/bootstrap.sh'), 'utf8');
  const validation = script.indexOf('ALT_HOSTS cannot be used with an IP certificate');
  const stop = script.indexOf('sudo systemctl stop boom-beard', script.indexOf('echo "==> certbot"'));

  assert.ok(validation >= 0 && stop >= 0 && validation < stop);
});

test('a failed certificate request restores the running game service', async () => {
  const script = await readFile(path.join(ROOT, 'infra/bootstrap.sh'), 'utf8');
  const request = script.indexOf('if ! sudo "$CERTBOT_HOME/bin/certbot" certonly');
  const recovery = script.indexOf('sudo systemctl start boom-beard', request);

  assert.ok(request >= 0 && recovery > request);
  assert.match(script.slice(request, recovery), /^if ! sudo "\$CERTBOT_HOME\/bin\/certbot" certonly/);
});

test('US bootstrap is IP-only and does not require the ZA dashboard password', async () => {
  const script = await readFile(path.join(ROOT, 'infra/bootstrap.sh'), 'utf8');
  const hostValidation = script.indexOf('REGION_ID=us requires HOST to be an IP address');
  const skipTls = script.indexOf('if [ "$SKIP_TLS" = 1 ]');

  assert.ok(hostValidation >= 0 && skipTls >= 0 && hostValidation < skipTls);
  assert.match(script, /if \[ "\$REGION_ID" = za \] && \[ "\$SKIP_TLS" != 1 \]/);
  assert.match(script, /US game server is game-only/);
});

test('bootstrap can register without a contact email when none exists', async () => {
  const script = await readFile(path.join(ROOT, 'infra/bootstrap.sh'), 'utf8');

  assert.match(script, /--register-unsafely-without-email/);
  assert.match(script, /CERTBOT_ACCOUNT_ARGS=\(-m "\$EMAIL"\)/);
});

test('IP bootstrap installs Certbot on Python 3.11 and checks IP-certificate support', async () => {
  const script = await readFile(path.join(ROOT, 'infra/bootstrap.sh'), 'utf8');

  assert.match(script, /CERTBOT_HOME=\/opt\/certbot311/);
  assert.match(script, /python3\.11 -m venv "\$CERTBOT_HOME"/);
  assert.match(script, /CERTBOT_HELP=\$\("\$CERTBOT_HOME\/bin\/certbot" certonly --help all/);
  assert.match(script, /--ip-address/);
});
