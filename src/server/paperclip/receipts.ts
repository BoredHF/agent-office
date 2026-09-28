import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Server-only metadata. No request text, bearer tokens or upstream response bodies. */
export interface CommandIdentity {
  connectionId: string; companyId: string; projectId: string; officeId: string;
  actorId: string; operationId: string;
  action: 'task.create' | 'task.comment' | 'task.assign' | 'task.status';
  /** Digest of canonical validated intent, including target and expected source version. */
  requestDigest: string;
}
export type ReceiptOutcome = 'unknown' | 'applied' | 'rejected' | 'conflict';
export interface Receipt { outcome: ReceiptOutcome }
const actions = ['task.create', 'task.comment', 'task.assign', 'task.status'];
const outcomes = ['applied', 'rejected', 'conflict'];
const invalid = () => new Error('Command receipt unavailable');
function keys(i: CommandIdentity) {
  const ids = [i.connectionId, i.companyId, i.projectId, i.officeId, i.actorId, i.operationId];
  if (ids.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(v)) ||
      !actions.includes(i.action) || !/^[a-f0-9]{64}$/.test(i.requestDigest)) throw invalid();
  // Action and digest deliberately excluded from the slot: reusing an operation ID
  // for different intent must conflict, not allocate another dispatch.
  const slot = createHash('sha256').update(JSON.stringify(ids)).digest('hex');
  const intent = createHash('sha256').update(JSON.stringify([i.action, i.requestDigest])).digest('hex');
  return { slot, intent };
}
async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableFile(path: string, value: unknown) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}

/** Offline scaffolding only: no transport, no authorization and no application wiring.
 * Requires a trusted local directory on a filesystem supporting atomic mkdir/rename
 * and directory fsync. Never garbage collect receipts while IDs can be replayed.
 */
export class CommandReceiptLedger {
  constructor(private readonly root: string) {}

  /** Only the caller receiving dispatch:true may attempt one remote submission.
   * Reservation is synced before that result. An incomplete reservation fails closed.
   */
  async reserve(identity: CommandIdentity): Promise<Receipt & { dispatch: boolean }> {
    try {
      const { slot, intent } = keys(identity);
      // The trusted parent must already exist; sync root creation before reserving.
      try { await mkdir(this.root, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await syncDirectory(dirname(this.root));
      const directory = join(this.root, slot);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return { ...await this.read(identity), dispatch: false };
      }
      await durableFile(join(directory, 'intent.json'), { version: 1, intent });
      await syncDirectory(directory);
      await syncDirectory(this.root);
      return { outcome: 'unknown', dispatch: true };
    } catch { throw invalid(); }
  }

  async read(identity: CommandIdentity): Promise<Receipt> {
    try {
      const { slot, intent } = keys(identity);
      const directory = join(this.root, slot);
      const stored = JSON.parse(await readFile(join(directory, 'intent.json'), 'utf8'));
      if (stored.version !== 1 || stored.intent !== intent) return { outcome: 'conflict' };
      let value: string;
      try { value = await readFile(join(directory, 'outcome.json'), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { outcome: 'unknown' };
        throw error;
      }
      const result = JSON.parse(value);
      if (!outcomes.includes(result.outcome)) throw invalid();
      return { outcome: result.outcome };
    } catch { throw invalid(); }
  }

  /** Trusted adapter only, after conclusive upstream response or operation-specific
   * reconciliation. Similar state/title alone is not proof of application.
   * A timeout stays unknown; no API here releases a slot for retry.
   */
  async resolve(identity: CommandIdentity, outcome: Exclude<ReceiptOutcome, 'unknown'>): Promise<Receipt> {
    try {
      if (!outcomes.includes(outcome)) throw invalid();
      const { slot, intent } = keys(identity);
      const directory = join(this.root, slot);
      const stored = JSON.parse(await readFile(join(directory, 'intent.json'), 'utf8'));
      if (stored.version !== 1 || stored.intent !== intent) throw invalid();
      // A single resolution owner avoids competing terminal outcomes. A crash while
      // holding this marker deliberately requires operator inspection, never resend.
      try { await mkdir(join(directory, 'resolution-lock'), { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return await this.read(identity);
      }
      const temporary = join(directory, `outcome-${randomUUID()}.tmp`);
      await durableFile(temporary, { outcome });
      await rename(temporary, join(directory, 'outcome.json'));
      await syncDirectory(directory);
      return { outcome };
    } catch { throw invalid(); }
  }
}
