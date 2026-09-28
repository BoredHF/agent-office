import { NO_PROVIDER_CAPABILITIES, officeBinding, sameProviderScope, type ProviderScope, type ProviderSnapshot, type ProviderTask, type ProviderCommand, type ProviderCommandResult } from '../../shared/orchestration.js';
import type { OrchestrationProvider } from '../orchestration.js';

type ConnectedScope = Extract<ProviderScope, { mode: 'paperclip' }>;
type Row = Record<string, unknown>;
export interface PaperclipConnection {
  connectionId: string; companyId: string; origin: string; approvedOrigins: readonly string[];
  /** Server secret resolver. Never use a heartbeat JWT as the deployed credential. */
  credential: () => Promise<string>;
  /** Verified company UI prefix, e.g. AGE. Server configuration only. */
  companyPrefix: string;
}
export interface ReadOptions {
  transport?: typeof fetch; now?: () => number; random?: () => number;
  pageSize?: number; maxPages?: number; maxBytes?: number; timeoutMs?: number;
}
export interface PaperclipProject { id: string; name: string; nativeStatus: string; url: string }
class ReadError extends Error {
  constructor(readonly kind: 'invalid' | 'scope' | 'incomplete' | 'transport' | 'http', readonly status = 0, readonly retryMs = 0) {
    super(kind === 'http' ? `Paperclip HTTP ${status}` : `Paperclip ${kind} response`);
  }
}
const invalid = (): never => { throw new ReadError('invalid'); };
function row(v: unknown): Row { if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid(); return v as Row; }
function str(v: unknown): string { if (typeof v !== 'string' || !v || v.length > 20_000) return invalid(); return v; }
function id(v: unknown): string { const s = str(v); if (!/^[a-zA-Z0-9_-]{1,200}$/.test(s)) return invalid(); return s; }
function date(v: unknown): string { const s = str(v); if (!Number.isFinite(Date.parse(s))) return invalid(); return s; }
function bound(v: number | undefined, fallback: number, max: number): number {
  const n = v ?? fallback; if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('Invalid Paperclip read bound'); return n;
}
const statuses = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']);
const priorities = new Set(['critical', 'high', 'medium', 'low']);

/** One instance per immutable office/connection/company/project binding. No global caches or timers. */
export class PaperclipReadProvider implements OrchestrationProvider {
  readonly scope: ConnectedScope;
  #connection: PaperclipConnection;
  #origin: string;
  #transport: typeof fetch;
  #now: () => number;
  #random: () => number;
  #pageSize: number; #maxPages: number; #maxBytes: number; #timeoutMs: number;
  #value: ProviderSnapshot;
  #projectsValue: PaperclipProject[] = [];
  #pending?: Promise<ProviderSnapshot>;
  #controller?: AbortController;
  #generation = 0; #stopped = false; #failures = 0; #nextRead = 0;
  constructor(scope: ConnectedScope, connection: PaperclipConnection, options: ReadOptions = {}) {
    const { officeId, ...binding } = scope;
    officeBinding(binding); id(officeId);
    if (scope.connectionId !== connection.connectionId || scope.companyId !== connection.companyId) throw new ReadError('scope');
    let origin: URL;
    try { origin = new URL(connection.origin); } catch { throw new Error('Invalid Paperclip origin'); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !connection.approvedOrigins.includes(origin.origin)) throw new Error('Invalid Paperclip origin');
    id(connection.companyPrefix);
    this.scope = Object.freeze({ ...scope }); this.#connection = { ...connection, approvedOrigins: [...connection.approvedOrigins] };
    this.#origin = origin.origin; this.#transport = options.transport ?? fetch;
    this.#now = options.now ?? Date.now; this.#random = options.random ?? Math.random;
    this.#pageSize = bound(options.pageSize, 100, 500); this.#maxPages = bound(options.maxPages, 20, 100);
    this.#maxBytes = bound(options.maxBytes, 2_000_000, 10_000_000); this.#timeoutMs = bound(options.timeoutMs, 10_000, 30_000);
    this.#value = { schemaVersion: 1, scope: this.scope, capabilities: { ...NO_PROVIDER_CAPABILITIES }, state: 'disconnected', lastSuccessfulSync: null, agents: [], tasks: [], activity: [] };
  }
  snapshot(): ProviderSnapshot {
    const result = structuredClone(this.#value);
    if (result.state === 'connected' && result.lastSuccessfulSync && this.#now() - Date.parse(result.lastSuccessfulSync) > 60_000) {
      result.state = 'stale'; result.error = 'Paperclip refresh is overdue';
    }
    return result;
  }
  #url(kind: 'issues' | 'agents' | 'projects', sourceId: string) {
    return `${this.#origin}/${encodeURIComponent(this.#connection.companyPrefix)}/${kind}/${encodeURIComponent(sourceId)}`;
  }
  #scoped(value: unknown, project = false): Row {
    const r = row(value); id(r.id);
    if (r.companyId !== this.scope.companyId || (project && r.projectId !== this.scope.projectId)) throw new ReadError('scope');
    return r;
  }
  async #get(path: string, signal: AbortSignal): Promise<unknown[]> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    // Race the entire read, including secret resolution and body consumption, against the deadline.
    const work = async () => {
      const credential = await this.#connection.credential();
      if (combined.aborted) throw new ReadError('transport');
      if (!credential || /[\r\n]/.test(credential)) throw new ReadError('http', 401);
      const response = await this.#transport(this.#origin + path, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${credential}` }, signal: combined });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.#now()) : 0;
        await response.body?.cancel();
        throw new ReadError('http', response.status, Number.isFinite(retryMs) ? Math.max(0, Math.min(retryMs, 300_000)) : 0);
      }
      if (Number(response.headers.get('content-length')) > this.#maxBytes) { await response.body?.cancel(); throw new ReadError('incomplete'); }
      const reader = response.body?.getReader(); if (!reader) return invalid();
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > this.#maxBytes) { await reader.cancel(); throw new ReadError('incomplete'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return invalid(); }
      if (!Array.isArray(data)) return invalid(); return data;
    };
    let onAbort: () => void = () => {};
    const abort = new Promise<never>((_, reject) => { onAbort = () => reject(new ReadError('transport')); combined.addEventListener('abort', onAbort, { once: true }); if (combined.aborted) onAbort(); });
    try { return await Promise.race([work(), abort]); }
    catch (e) { throw e instanceof ReadError ? e : new ReadError('transport'); }
    finally { combined.removeEventListener('abort', onAbort); }
  }
  #collection = () => `/api/companies/${encodeURIComponent(this.scope.companyId)}`;
  /** Discovery is company-scoped; selecting a project requires a fresh immutable provider binding. */
  async projects(): Promise<PaperclipProject[]> {
    await this.refresh();
    return structuredClone(this.#projectsValue);
  }
  async #projects(signal: AbortSignal): Promise<PaperclipProject[]> {
    const rows = await this.#get(`${this.#collection()}/projects`, signal);
    if (rows.length >= 2000) throw new ReadError('incomplete');
    const seen = new Set<string>();
    return rows.map(v => { const r = this.#scoped(v); const key = id(r.id); if (seen.has(key)) return invalid(); seen.add(key);
      return { id: key, name: str(r.name), nativeStatus: str(r.status), url: this.#url('projects', key) }; });
  }
  async #tasks(signal: AbortSignal): Promise<ProviderTask[]> {
    const tasks = new Map<string, ProviderTask>();
    for (let page = 0; page < this.#maxPages; page++) {
      const rows = await this.#get(`${this.#collection()}/issues?projectId=${encodeURIComponent(this.scope.projectId)}&includeRoutineExecutions=true&limit=${this.#pageSize}&offset=${page * this.#pageSize}`, signal);
      if (rows.length > this.#pageSize) throw new ReadError('incomplete');
      for (const v of rows) {
        const r = this.#scoped(v, true); const key = id(r.id);
        // Offset drift cannot be silently presented as a complete snapshot.
        if (tasks.has(key)) throw new ReadError('incomplete');
        if (!statuses.has(str(r.status)) || !priorities.has(str(r.priority)) || !Number.isSafeInteger(r.statusVersion) || (r.statusVersion as number) < 0) return invalid();
        date(r.updatedAt);
        tasks.set(key, { source: { id: key, url: this.#url('issues', key), version: String(r.statusVersion) }, title: str(r.title), nativeStatus: str(r.status), displayStatus: str(r.status), priority: str(r.priority), ...(r.assigneeAgentId == null ? {} : { assigneeId: id(r.assigneeAgentId) }) });
      }
      if (rows.length < this.#pageSize) return [...tasks.values()];
    }
    throw new ReadError('incomplete');
  }
  /** Caller-driven bounded polling. Concurrent callers share one read; inactive calls use 30s cadence. */
  refresh(visible = true): Promise<ProviderSnapshot> {
    if (this.#pending) return this.#pending;
    if (this.#stopped || this.#now() < this.#nextRead) return Promise.resolve(this.snapshot());
    const generation = this.#generation;
    const controller = new AbortController(); this.#controller = controller;
    this.#pending = this.#refresh(controller.signal, generation, visible).finally(() => { this.#pending = undefined; this.#controller = undefined; });
    return this.#pending;
  }
  async #refresh(signal: AbortSignal, generation: number, visible: boolean): Promise<ProviderSnapshot> {
    try {
      const projects = await this.#projects(signal);
      if (!projects.some(p => p.id === this.scope.projectId)) throw new ReadError('scope');
      const tasks = await this.#tasks(signal);
      let permissionLimited = false;
      const optional = async (path: string) => {
        try { return await this.#get(path, signal); }
        catch (e) { if (e instanceof ReadError && e.status === 403) { permissionLimited = true; return []; } throw e; }
      };
      const agentRows = await optional(`${this.#collection()}/agents`);
      if (agentRows.length >= 2000) throw new ReadError('incomplete');
      const agentIds = new Set<string>();
      const agents = agentRows.map(v => {
        const r = this.#scoped(v); const key = id(r.id); if (agentIds.has(key)) return invalid(); agentIds.add(key);
        return { source: { id: key, url: this.#url('agents', key) }, name: str(r.name), nativeStatus: str(r.status), activeTaskIds: tasks.filter(t => t.assigneeId === key && t.nativeStatus === 'in_progress').map(t => t.source.id) };
      });
      const taskIds = new Set(tasks.map(t => t.source.id));
      const activityRows = await optional(`${this.#collection()}/activity?limit=100`);
      if (activityRows.length > 100) throw new ReadError('incomplete');
      const activityIds = new Set<string>();
      const activity = activityRows.flatMap(v => {
        const r = this.#scoped(v); const key = id(r.id); if (activityIds.has(key)) return invalid(); activityIds.add(key);
        // Company events are never projected until resolved against a validated project task.
        if (r.entityType !== 'issue' || typeof r.entityId !== 'string' || !taskIds.has(r.entityId)) return [];
        return [{ source: { id: key, url: this.#url('issues', r.entityId) }, taskId: r.entityId, at: date(r.createdAt), text: str(r.action) }];
      });
      if (generation !== this.#generation) return this.snapshot();
      this.#failures = 0;
      this.#projectsValue = projects;
      this.#value = { schemaVersion: 1, scope: this.scope, capabilities: { ...NO_PROVIDER_CAPABILITIES }, state: permissionLimited ? 'permission-limited' : 'connected', lastSuccessfulSync: new Date(this.#now()).toISOString(), ...(permissionLimited ? { error: 'Paperclip denied optional agents or activity reads' } : {}), tasks, agents, activity };
      this.#nextRead = this.#now() + (visible ? 5000 : 30_000) * (1 + this.#jitter());
    } catch (e) {
      if (generation !== this.#generation) return this.snapshot();
      const error = e instanceof ReadError ? e : new ReadError('transport');
      this.#failures++;
      if (error.status === 401 || error.kind === 'scope') {
        this.#stopped = true;
        this.#projectsValue = [];
        this.#value = { ...this.#value, tasks: [], agents: [], activity: [], state: 'disconnected', error: error.status === 401 ? 'Paperclip authentication failed; reconnect required' : 'Paperclip scope validation failed; reconnect required' };
      } else {
        if (error.status === 403) {
          this.#projectsValue = [];
          this.#value = { ...this.#value, tasks: [], agents: [], activity: [] };
        }
        this.#value = { ...this.#value, state: error.status === 403 ? 'permission-limited' : this.#value.lastSuccessfulSync ? 'stale' : 'disconnected', error: error.message };
        this.#nextRead = this.#now() + Math.max(error.retryMs, Math.min(300_000, 5000 * 2 ** Math.min(this.#failures - 1, 6) * (1 + this.#jitter())));
      }
    }
    return this.snapshot();
  }
  #jitter() { return Math.max(0, Math.min(1, this.#random())) * 0.2; }
  reconnect(): void {
    this.disconnect(); this.#stopped = false; this.#failures = 0; this.#nextRead = 0;
  }
  disconnect(): void {
    this.#generation++; this.#stopped = true; this.#controller?.abort(); this.#projectsValue = [];
    this.#value = { ...this.#value, state: 'disconnected', error: 'Paperclip disconnected', tasks: [], agents: [], activity: [] };
  }
  shutdown(): void { this.disconnect(); }
  async command(c: ProviderCommand): Promise<ProviderCommandResult> {
    return { operationId: c.operationId, outcome: 'rejected', message: sameProviderScope(c.scope, this.scope) ? 'Paperclip commands are not verified; open the canonical record' : 'Office context changed' };
  }
}
