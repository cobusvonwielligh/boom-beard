import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIni, sameSecret } from '../server/config.js';
import { playerName } from '../server/net.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ini parsing', async t => {
  await t.test('sections, comments, and values with = in them', () => {
    const ini = parseIni(`
      ; a comment
      # another
      [server]
      port = 443
      public_host = boombeard.co.za

      [deploy]
      token = abc=def=
      ssh_key = ~/Downloads/key.pem
    `);
    assert.equal(ini.server.port, '443');
    assert.equal(ini.server.public_host, 'boombeard.co.za');
    assert.equal(ini.deploy.token, 'abc=def=', 'only the first = separates key from value');
    assert.equal(ini.deploy.ssh_key, '~/Downloads/key.pem');
  });

  await t.test('keys are case-insensitive and blank values survive', () => {
    const ini = parseIni('[Server]\nTLS_Cert =\nPort=8080');
    assert.equal(ini.server.tls_cert, '');
    assert.equal(ini.server.port, '8080');
  });

  await t.test('junk does not throw', () => {
    assert.doesNotThrow(() => parseIni('[unclosed\nno-equals-here\n\n[]\n= orphan'));
  });
});

test('secrets compare only when they match exactly, and blank never matches', () => {
  assert.equal(sameSecret('abc', 'abc'), true);
  assert.equal(sameSecret('abd', 'abc'), false);
  assert.equal(sameSecret('abcd', 'abc'), false, 'a longer guess with the right prefix');
  assert.equal(sameSecret(undefined, 'abc'), false);
  assert.equal(sameSecret('', ''), false, 'an unset key would let everybody in');
  assert.equal(sameSecret(undefined, ''), false);
});

test('the admin dashboard password is read from server configuration', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { config } from './server/config.js'; process.stdout.write(config.adminDashboardPassword)",
  ], {
    cwd: ROOT,
    env: { ...process.env, ADMIN_DASHBOARD_PASSWORD: 'admin-secret-for-test' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'admin-secret-for-test');
});

test('region id defaults to za when no region is configured', () => {
  const env = { ...process.env, CONFIG: path.join(ROOT, '.missing-region-config.ini') };
  delete env.REGION_ID;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { config } from './server/config.js'; process.stdout.write(config.regionId)",
  ], { cwd: ROOT, env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'za');
});

test('region id falls back to server.region_id in the INI file', () => {
  const env = { ...process.env, CONFIG: path.join(ROOT, 'config.example.ini') };
  delete env.REGION_ID;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { config } from './server/config.js'; process.stdout.write(config.regionId)",
  ], { cwd: ROOT, env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'za');
});

test('region id is read from the environment and normalized to lowercase', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { config } from './server/config.js'; process.stdout.write(config.regionId)",
  ], {
    cwd: ROOT,
    env: { ...process.env, CONFIG: path.join(ROOT, 'config.example.ini'), REGION_ID: 'US' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'us');
});

test('shared-data client settings are read from server-only environment variables', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { config } from './server/config.js'; process.stdout.write(JSON.stringify([config.sharedDataToken, config.sharedDataHost, config.sharedDataServername]))",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONFIG: path.join(ROOT, '.missing-shared-config.ini'),
      SHARED_DATA_TOKEN: 'internal-test-secret',
      SHARED_DATA_HOST: '15.240.88.189',
      SHARED_DATA_SERVERNAME: 'boombeard.co.za',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),
    ['internal-test-secret', '15.240.88.189', 'boombeard.co.za']);
});

test('US server refuses to start without shared-data credentials', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-us-shared-config-'));
  const env = {
    ...process.env,
    CONFIG: path.join(ROOT, '.missing-us-shared-config.ini'),
    REGION_ID: 'us',
    DATA_DIR: dataDir,
  };
  delete env.SHARED_DATA_TOKEN;
  delete env.SHARED_DATA_HOST;
  delete env.SHARED_DATA_SERVERNAME;
  const result = spawnSync(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 5000,
  });
  fs.rmSync(dataDir, { recursive: true, force: true });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /US region requires shared_data_token/);
});

test('invalid region id rejects configuration with a RangeError', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import './server/config.js'",
  ], {
    cwd: ROOT,
    env: { ...process.env, CONFIG: path.join(ROOT, '.missing-region-config.ini'), REGION_ID: 'moon' },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RangeError: invalid region id: moon/);
});

test('a name cannot pass for the server in chat', () => {
  assert.equal(playerName('SERVER'), 'anon');
  assert.equal(playerName(' server '), 'anon');
  assert.equal(playerName('servers'), 'servers');
});
