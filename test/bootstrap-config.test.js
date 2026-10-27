import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('bootstrap preserves and writes the configured regional identity', async () => {
  const script = await readFile(path.join(ROOT, 'infra/bootstrap.sh'), 'utf8');

  assert.match(script, /REGION_ID="\$\{REGION_ID:-\}"/);
  assert.match(script, /ADMIN_KEY="\$\{ADMIN_KEY:-\}"/);
  assert.match(script, /region_id\s+=\s+\$REGION_ID/);
  assert.match(script, /REGION_ID must be za or us/);
});
