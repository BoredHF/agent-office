import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { atomicJson } from '../persistence.js';

export interface Scope { officeId: string; connectionId: string; companyId: string; projectId: string }
type RecordData = Record<string, unknown>;
export interface Source { tasks: RecordData[]; roles?: unknown[]; assignments?: RecordData; [key: string]: unknown }
export interface Mapping { localId: string; sourceVersion: string; operationId: string; status: 'backlog' | 'done'; unsupported: string[] }
export interface Report { scope: Scope; sourceVersion: string; counts: { tasks: number; eligible: number; excluded: number; roles: number; assignments: number }; mappings: Mapping[]; excluded: string[]; unsupported: string[] }
export interface Receipt { remoteId: string; scope: Scope; operationId: string; sourceVersion: string }
interface Checkpoint { version: 1; report: Report; entries: Record<string, { state: 'pending' | 'imported'; receipt?: Receipt }>; phase: 'importing' | 'imported' | 'connected' | 'rollback_pending' | 'rolled_back' }
/** Implement only in trusted server code. Never treat a browser assertion as an idle proof. */
export interface MigrationPort {
  /** Hold an exclusive office maintenance lease across the complete callback, including restart recovery. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /** Must check queue intents, workers, detached PTYs and meetings, not just task status. */
  localIdle(): Promise<boolean>;
  /** Read by exact scope + provenance. null means unresolved, never permission to replay. */
  reconcile(scope: Scope, mapping: Mapping): Promise<Receipt | null>;
  /** Create unassigned inert records only. Must retain provenance; never create/wake agents. */
  create(scope: Scope, mapping: Mapping, task: { title: string; description: string }): Promise<Receipt>;
  disableWrites(scope: Scope): Promise<void>;
  /** Complete remote reconciliation under a lease preventing new remote work. */
  remoteQuiescent(scope: Scope, receipts: Receipt[]): Promise<boolean>;
  /** Atomically persist connected binding while local dispatch stays disabled. Idempotent. */
  connect(scope: Scope): Promise<void>;
  /** Restore only with imported local IDs permanently excluded from dispatch. Idempotent. */
  restoreLocal(scope: Scope, excludedLocalIds: string[]): Promise<void>;
}
function hash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function validateScope(scope: Scope) {
  if (!scope || Object.keys(scope).sort().join() !== 'companyId,connectionId,officeId,projectId' || Object.values(scope).some(v => typeof v !== 'string' || !v.trim())) throw new Error('Invalid migration scope');
}
export function dryRun(source: Source, scope: Scope): Report {
  validateScope(scope);
  if (!source || !Array.isArray(source.tasks) || (source.version !== undefined && source.version !== 1) || (source.roles !== undefined && !Array.isArray(source.roles)) || (source.assignments !== undefined && (!source.assignments || typeof source.assignments !== 'object' || Array.isArray(source.assignments)))) throw new Error('Unsupported source schema');
  const seen = new Set<string>();
  const mappings: Mapping[] = [], excluded: string[] = [];
  for (const task of source.tasks) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id || seen.has(task.id) || typeof task.title !== 'string' || typeof task.prompt !== 'string' || !['queued', 'running', 'review', 'blocked', 'done'].includes(String(task.status))) throw new Error('Invalid or duplicate source task');
    seen.add(task.id);
    // Only completed history or never-attempted queued records may be imported.
    if (task.status !== 'done' && (task.status !== 'queued' || task.attemptId || task.workerId || task.startedAt || task.outcome || (Array.isArray(task.history) && task.history.length))) { excluded.push(task.id); continue; }
    const sourceVersion = hash(task);
    mappings.push({ localId: task.id, sourceVersion, operationId: hash({ scope, localId: task.id, sourceVersion }), status: task.status === 'done' ? 'done' : 'backlog', unsupported: Object.keys(task).filter(k => !['id', 'title', 'prompt', 'status', 'version'].includes(k)).sort() });
  }
  mappings.sort((a, b) => a.localId.localeCompare(b.localId)); excluded.sort();
  return { scope: { ...scope }, sourceVersion: hash(source), counts: { tasks: source.tasks.length, eligible: mappings.length, excluded: excluded.length, roles: source.roles?.length ?? 0, assignments: Object.keys(source.assignments ?? {}).length }, mappings, excluded, unsupported: Object.keys(source).filter(k => !['version', 'tasks'].includes(k)).sort() };
}
function syncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function save(path: string, value: unknown) { atomicJson(path, value); syncDirectory(dirname(path)); }
/** New destination only, private permissions, regular files only; caller must stop office writers first. */
export function backupOffice(sourceDir: string, destination: string): void {
  if (lstatSync(sourceDir).isSymbolicLink()) throw new Error('Backup requires regular files and directories');
  const src = realpathSync(sourceDir), dst = join(realpathSync(dirname(resolve(destination))), basename(destination));
  if (dst === src || dst.startsWith(src + sep) || src.startsWith(dst + sep)) throw new Error('Backup paths overlap');
  const copy = (from: string, to: string) => {
    const stat = lstatSync(from);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Backup requires regular files and directories');
    if (stat.isDirectory()) { mkdirSync(to, { mode: 0o700 }); for (const name of readdirSync(from).sort()) copy(join(from, name), join(to, name)); syncDirectory(to); }
    else { const fd = openSync(to, 'wx', 0o600); try { writeFileSync(fd, readFileSync(from)); fsyncSync(fd); } finally { closeSync(fd); } }
  };
  copy(src, dst);
  syncDirectory(dirname(dst));
}
/** One immutable backup + one checkpoint directory per office migration. Never reuse across scopes. */
export class Migration {
  constructor(private directory: string, private port: MigrationPort) {}
  private path() { return join(this.directory, 'checkpoint.json'); }
  private read(): Checkpoint {
    const value = JSON.parse(readFileSync(this.path(), 'utf8')) as Checkpoint;
    if (value.version !== 1 || !value.report || !value.entries || !['importing', 'imported', 'connected', 'rollback_pending', 'rolled_back'].includes(value.phase)) throw new Error('Invalid checkpoint');
    validateScope(value.report.scope);
    return value;
  }
  private lock<T>(work: () => Promise<T>): Promise<T> {
    return this.port.exclusive(async () => {
      // Exclusive creation prevents concurrent processes sharing the same migration directory.
      const path = join(this.directory, 'lock'); const fd = openSync(path, 'wx', 0o600);
      try { return await work(); } finally { closeSync(fd); unlinkSync(path); }
    });
  }
  async prepare(source: Source, scope: Scope, approvedSourceVersion: string): Promise<Report> {
    const report = dryRun(source, scope);
    if (report.sourceVersion !== approvedSourceVersion) throw new Error('Source changed since approval');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    return this.lock(async () => {
      if (!(await this.port.localIdle())) throw new Error('Local work must be drained or stopped');
      if (existsSync(this.path())) {
        const old = this.read(); if (hash(old.report) !== hash(report)) throw new Error('Migration scope or source changed');
        return old.report;
      }
      // Private immutable source archive retains unsupported history; never sent to the remote adapter.
      const archive = join(this.directory, 'source.json');
      if (existsSync(archive)) {
        if (hash(JSON.parse(readFileSync(archive, 'utf8'))) !== report.sourceVersion) throw new Error('Existing backup differs');
      } else {
        const fd = openSync(archive, 'wx', 0o400); try { writeFileSync(fd, JSON.stringify(source)); fsyncSync(fd); } finally { closeSync(fd); }
      }
      save(this.path(), { version: 1, report, entries: {}, phase: 'importing' } satisfies Checkpoint);
      return report;
    });
  }
  async resume(): Promise<void> {
    await this.lock(async () => {
      const state = this.read();
      if (state.phase === 'imported') return;
      if (state.phase !== 'importing') throw new Error('Import phase closed');
      if (!(await this.port.localIdle())) throw new Error('Local work must remain stopped');
      const source = JSON.parse(readFileSync(join(this.directory, 'source.json'), 'utf8')) as Source;
      if (hash(dryRun(source, state.report.scope)) !== hash(state.report)) throw new Error('Backup changed');
      for (const mapping of state.report.mappings) {
        const entry = state.entries[mapping.operationId];
        if (entry?.state === 'imported') { this.validateReceipt(state, mapping, entry.receipt!); continue; }
        let receipt: Receipt | null;
        if (entry) {
          receipt = await this.port.reconcile(state.report.scope, mapping);
          if (!receipt) throw new Error('Outcome unknown; reconcile remotely before continuing');
        } else {
          state.entries[mapping.operationId] = { state: 'pending' }; save(this.path(), state);
          const task = source.tasks.find(t => t.id === mapping.localId)!;
          receipt = await this.port.create(state.report.scope, mapping, { title: String(task.title), description: String(task.prompt) });
        }
        this.validateReceipt(state, mapping, receipt);
        state.entries[mapping.operationId] = { state: 'imported', receipt }; save(this.path(), state);
      }
      state.phase = 'imported'; save(this.path(), state);
    });
  }
  private validateReceipt(state: Checkpoint, mapping: Mapping, receipt: Receipt) {
    if (!receipt || typeof receipt.remoteId !== 'string' || !receipt.remoteId || hash(receipt.scope) !== hash(state.report.scope) || receipt.operationId !== mapping.operationId || receipt.sourceVersion !== mapping.sourceVersion) throw new Error('Remote provenance mismatch');
    if (Object.entries(state.entries).some(([id, e]) => id !== mapping.operationId && e.receipt?.remoteId === receipt.remoteId)) throw new Error('Duplicate remote mapping');
  }
  async cutover(): Promise<void> {
    await this.lock(async () => {
      const state = this.read();
      if (!['imported', 'connected'].includes(state.phase)) throw new Error('Import incomplete');
      await this.port.disableWrites(state.report.scope);
      if (!(await this.port.localIdle())) throw new Error('Local work must remain stopped');
      await this.port.connect(state.report.scope);
      state.phase = 'connected'; save(this.path(), state);
    });
  }
  async rollback(): Promise<void> {
    await this.lock(async () => {
      const state = this.read();
      // Disable before inspecting remote work; never delete or replay remote records.
      await this.port.disableWrites(state.report.scope);
      if (state.phase === 'rolled_back') return;
      state.phase = 'rollback_pending'; save(this.path(), state);
      for (const mapping of state.report.mappings) {
        const entry = state.entries[mapping.operationId];
        if (entry?.state === 'imported') this.validateReceipt(state, mapping, entry.receipt!);
        if (entry?.state === 'pending') {
          const receipt = await this.port.reconcile(state.report.scope, mapping);
          if (!receipt) throw new Error('Unresolved remote write blocks rollback');
          this.validateReceipt(state, mapping, receipt);
          state.entries[mapping.operationId] = { state: 'imported', receipt }; save(this.path(), state);
        }
      }
      if (!(await this.port.localIdle()) || !(await this.port.remoteQuiescent(state.report.scope, Object.values(state.entries).map(e => e.receipt!)))) throw new Error('Active or uncertain work blocks rollback');
      const excluded = state.report.mappings.filter(m => state.entries[m.operationId]).map(m => m.localId);
      await this.port.restoreLocal(state.report.scope, excluded);
      state.phase = 'rolled_back'; save(this.path(), state);
    });
  }
}
