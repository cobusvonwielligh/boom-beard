import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('default deploy validates and deploys ZA before US', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts.deploy, './infra/deploy-both.sh');
  assert.equal(packageJson.scripts['deploy:single'], './infra/deploy.sh');
  assert.equal(packageJson.scripts['deploy:fast'], 'SKIP_TESTS=1 ./infra/deploy-both.sh');

  const wrapperPath = path.join(ROOT, 'infra/deploy-both.sh');
  assert.ok(fs.existsSync(wrapperPath), 'dual-region deployment wrapper exists');
  const wrapper = fs.readFileSync(wrapperPath, 'utf8');
  const zaDeploy = wrapper.indexOf('deploy_region "ZA"');
  const usDeploy = wrapper.indexOf('deploy_region "US"');

  assert.ok(zaDeploy >= 0 && usDeploy > zaDeploy, 'ZA deploy runs before US deploy');
  assert.match(wrapper, /ini deploy ssh_host/);
  assert.match(wrapper, /ini deploy_us ssh_host/);
  assert.match(wrapper, /test -r/);
  assert.match(wrapper, /SSH_HOST="\$host" SSH_USER="\$user" KEY="\$key"/);
  assert.match(read('config.example.ini'), /^\[deploy_us\]$/m);
});
