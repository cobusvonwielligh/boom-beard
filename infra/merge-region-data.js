import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../server/config.js';
import { createSharedDataClient } from '../server/shared-data-client.js';
import { createLeaderboard } from '../server/leaderboard.js';

export async function createMigrationPayload({
  dataDir,
  sourceId = 'us-initial-import-v1',
  now = Date.now(),
}) {
  const accountFile = path.join(dataDir, 'accounts.json');
  const leaderboardFile = path.join(dataDir, 'leaderboard.json');
  const suffix = `.pre-shared-${now}`;
  const accountBackup = `${accountFile}${suffix}`;
  const leaderboardBackup = `${leaderboardFile}${suffix}`;

  fs.copyFileSync(accountFile, accountBackup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(accountBackup, 0o600);
  try {
    fs.copyFileSync(leaderboardFile, leaderboardBackup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(leaderboardBackup, 0o600);
  } catch (error) {
    fs.rmSync(accountBackup, { force: true });
    throw error;
  }

  const accountData = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  const leaderboardData = JSON.parse(fs.readFileSync(leaderboardFile, 'utf8'));
  if (accountData?.version !== 1 || !accountData.accounts
    || typeof accountData.accounts !== 'object' || Array.isArray(accountData.accounts)
    || leaderboardData?.version !== 1 || !leaderboardData.players
    || typeof leaderboardData.players !== 'object' || Array.isArray(leaderboardData.players)) {
    throw new Error('regional account or leaderboard data has an unsupported format');
  }
  if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 128) {
    throw new TypeError('a stable source ID is required');
  }
  const normalizeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-region-migration-'));
  fs.copyFileSync(leaderboardFile, path.join(normalizeDir, 'leaderboard.json'));
  let localLeaderboard;
  let players;
  try {
    localLeaderboard = createLeaderboard({ dataDir: normalizeDir });
    players = localLeaderboard.sharedSnapshot().players;
  } finally {
    if (localLeaderboard) await localLeaderboard.stop();
    fs.rmSync(normalizeDir, { recursive: true, force: true });
  }
  return {
    migrationId: sourceId,
    accounts: accountData.accounts,
    players,
    backups: [accountBackup, leaderboardBackup],
  };
}

async function main() {
  if (config.regionId !== 'us') throw new Error('run the migration utility on the US game server');
  const payload = await createMigrationPayload({ dataDir: config.dataDir });
  const client = createSharedDataClient({
    host: config.sharedDataHost,
    servername: config.sharedDataServername,
    token: config.sharedDataToken,
  });
  const { backups, ...requestPayload } = payload;
  const result = await client.request('migration.import', requestPayload);
  console.log(`Shared-data import ${result.accounts.applied ? 'completed' : 'already applied'}: ` +
    `${result.accounts.accounts} accounts, ${result.careers.players} human careers.`);
  console.log(`${backups.length} original regional files were retained in mode-0600 backups.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`shared-data migration failed (${error.message})`);
    process.exitCode = 1;
  });
}
