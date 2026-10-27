import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const MODE = 0o600;

export function createSharedDataOutbox({ dataDir }) {
  const file = path.join(dataDir, 'shared-outbox.json');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let operations = [];
  let sequence = 0;
  let chain = Promise.resolve();

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.version !== VERSION || !Array.isArray(saved.operations)) {
      throw new Error('shared outbox has an invalid shape');
    }
    if (saved.operations.some(operation =>
      !operation || typeof operation !== 'object'
      || typeof operation.operationId !== 'string' || !operation.operationId)) {
      throw new Error('shared outbox contains an invalid operation');
    }
    operations = saved.operations;
    fs.chmodSync(file, MODE);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`cannot load shared outbox: ${error.message}`);
  }

  function persist() {
    const temporary = `${file}.${process.pid}.${++sequence}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'w', MODE);
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: VERSION, operations }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      fs.chmodSync(file, MODE);
      const dir = fs.openSync(dataDir, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          throw new AggregateError([error, cleanupError], 'could not persist or clean shared outbox');
        }
      }
      throw error;
    }
  }

  function enqueue(operation) {
    if (!operation || typeof operation !== 'object'
      || typeof operation.operationId !== 'string' || !operation.operationId) {
      throw new TypeError('a shared operation requires an operationId');
    }
    if (operations.some(existing => existing.operationId === operation.operationId)) return false;
    operations.push(structuredClone(operation));
    persist();
    return true;
  }

  function acknowledge(operationId) {
    const next = operations.filter(operation => operation.operationId !== operationId);
    if (next.length === operations.length) return false;
    operations = next;
    persist();
    return true;
  }

  function flush(send) {
    if (typeof send !== 'function') throw new TypeError('send must be a function');
    const run = chain.catch(() => {}).then(async () => {
      for (const operation of [...operations]) {
        const ack = await send(structuredClone(operation));
        if (ack?.operationId !== operation.operationId) {
          throw new Error('shared-data acknowledgement did not match the queued operation');
        }
        acknowledge(operation.operationId);
      }
    });
    chain = run;
    return run;
  }

  return Object.freeze({
    enqueue,
    acknowledge,
    flush,
    pending: () => structuredClone(operations),
    get pendingCount() { return operations.length; },
    get file() { return file; },
  });
}
