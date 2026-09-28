import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicJson, backupLegacy } from './persistence.js';
import type { OfficeRole, TaskOptions, TaskUpdate } from '../shared/protocol.js';
import { compareTaskPriority, isAgentEffort, isAgentProvider, isClaudeModel, type AgentEffort, type AgentProvider, type GhPull, type QueueState, type QueueTask, type WorkerInfo, type WorkerStatus } from '../shared/protocol.js';
import { DESK_BY_ID, SEATS, nextFreeSeat } from '../shared/layout.js';
import { isValidOpenCodeModel, validateWorkerEffort, validateWorkerModel } from './agents.js';

/** What the queue needs from the worker manager. Narrow on purpose, so a smoke test can fake it. */
export interface QueueWorkers {
  readonly defaultProvider: AgentProvider;
  list(): WorkerInfo[];
  deskOccupied(deskId: string): boolean;
  spawn(deskId: string, by: string, prompt: string, worktree: boolean, kind: 'agent', provider: AgentProvider, model?: string, effort?: AgentEffort): WorkerInfo | string;
  holdRecovery?(id: string): void;
  prompt?(id: string, text: string, by: string): string | undefined;
  /** Resolves with a line about what became of the worker's worktree. */
  kill(id: string): Promise<{ note?: string; error?: string }>;
}

export interface QueueEvents {
  update(state: QueueState): void;
  toast(text: string, level: 'info' | 'warn' | 'error'): void;
  /** Mark the issue as taken on GitHub, so the board moves it to In progress. Resolves to an error message when it can't. */
  claimIssue(issue: number): Promise<string | undefined>;
  /** Ask GitHub for fresh pull requests, to pick up the one a worker just opened. */
  refreshGitHub(): void;
  /** Why no workers may be hired right now (today's budget is spent), if that's so. */
  hiringPaused(): string | undefined;
  /** How many more workers the office has room for under its worker limit (Infinity without one). */
  room?(): number;
  /** The last task on the queue just finished, done: nothing is left queued or running. */
  emptied(): void;
}

export const DEFAULT_MAX_WORKERS = 3;
const MAX_TASKS = 100;
const PUMP_MS = 10_000;
/** A worker in one of these states holds a slot under the worker limit. */
const BUSY = new Set<WorkerStatus>(['starting', 'idle', 'working', 'needs_input']);
/** A worker in one of these states is finished with its task (and can make room for the next one). */
const FINISHED = new Set<WorkerStatus>(['done', 'exited', 'offline']);

const WORKTREE_NOTE = "\n\nYou're in your own git worktree, on a fresh branch made for this task. Commit there, push it, and open the pull request from it.";

/**
 * The 📋 task queue. Tasks (GitHub issues or free text) wait in order; whenever a desk is free and
 * fewer than `maxWorkers` workers are busy, the next one is seated as a worktree worker. A running
 * task finishes when its worker ends its turn, stops, or is sent home. Finished workers stay at
 * their desks to be looked at, until the queue needs the desk for the next task.
 */
export class TaskQueue {
  private tasks: QueueTask[] = [];
  private roles: OfficeRole[] = [];
  private assignments: Record<string, string> = {};
  private storageError?: string;
  private ready = true;
  private maxWorkers = DEFAULT_MAX_WORKERS;
  private statePath: string;
  private timer: NodeJS.Timeout;
  private pumping = false;
  private again = false;
  /** Set on shutdown: the workers' exit events must not seat anyone into a dying office. */
  private stopped = false;
  private lastStatus = new Map<string, WorkerStatus>();

  constructor(
    dataDir: string,
    private workers: QueueWorkers,
    /** Seat workers in their own git worktree (only when the project is a git repo). */
    private useWorktree: boolean,
    private events: QueueEvents,
    deferStart = false,
  ) {
    this.statePath = path.join(dataDir, 'queue.json');
    this.ready = !deferStart;
    this.restore();
    this.timer = setInterval(() => this.pump(), PUMP_MS);
  }

  state(): QueueState {
    return structuredClone({ tasks: this.tasks, maxWorkers: this.maxWorkers, roles: this.roles, assignments: this.assignments, error: this.storageError });
  }

  start() { this.ready = true; this.pump(); }

  private record(t: QueueTask, by: string, note: string) {
    t.version = (t.version ?? 0) + 1;
    t.updatedAt = Date.now();
    t.lastUpdate = note;
    (t.history ??= []).push({ at: t.updatedAt, by, note, ...(t.attemptId ? { attemptId: t.attemptId } : {}), ...(note === 'Starting attempt' && t.roleSnapshot ? { roleSnapshot: structuredClone(t.roleSnapshot) } : {}) });
  }

  private validateOptions(options: TaskOptions): string | undefined {
    if (options.priority !== undefined && !['urgent', 'high', 'medium', 'low'].includes(options.priority)) return 'Unknown priority';
    if (options.roleId !== undefined && typeof options.roleId !== 'string') return 'Invalid role';
    if (options.assigneeId !== undefined && typeof options.assigneeId !== 'string') return 'Invalid assignee';
    if (options.roleId && !this.roles.some((r) => r.id === options.roleId)) return 'No such role in this office';
    if (options.assigneeId && !this.workers.list().some((w) => w.id === options.assigneeId && w.kind === 'agent')) return 'No such agent in this office';
  }

  saveRole(input: Omit<OfficeRole, 'version'>, version?: number): string | undefined {
    if (this.storageError) return this.storageError;
    if (!input || typeof input.name !== 'string' || !input.name.trim() || typeof input.responsibilities !== 'string' || typeof input.instructions !== 'string') return 'Role name, responsibilities and instructions are required';
    const old = this.roles.find((r) => r.id === input.id);
    if (input.id && !old) return 'No such role';
    if (old && old.version !== version) return 'Role changed; reopen it before saving';
    const role: OfficeRole = { id: old?.id ?? randomBytes(6).toString('hex'), name: input.name.trim().slice(0, 100), responsibilities: input.responsibilities.slice(0, 10000), instructions: input.instructions.slice(0, 20000), version: (old?.version ?? 0) + 1 };
    if (old) this.roles[this.roles.indexOf(old)] = role; else this.roles.push(role);
    return this.changed() ? undefined : this.storageError;
  }

  assignRole(workerId: string, roleId: string): string | undefined {
    if (this.storageError) return this.storageError;
    const err = this.validateOptions({ assigneeId: workerId, roleId });
    if (err) return err;
    if (roleId) this.assignments[workerId] = roleId; else delete this.assignments[workerId];
    return this.changed() ? undefined : this.storageError;
  }

  update(taskId: string, version: number, update: TaskUpdate, by: string): string | undefined {
    if (this.storageError) return this.storageError;
    if (update.note !== undefined && typeof update.note !== 'string') return 'Invalid progress note';
    const t = this.tasks.find((task) => task.id === taskId);
    if (!t) return 'No such task in this office';
    if (t.version !== version) return 'Task changed; reopen it before saving';
    const error = this.validateOptions(update);
    if (error) return error;
    if (t.status === 'done' && update.status === 'blocked') return 'Requeue an accepted task before blocking it';
    if (t.status === 'running' && (update.status || update.assigneeId !== undefined || update.roleId !== undefined)) return 'Stop the active worker before changing its assignment';
    if (update.status && !['queued', 'blocked', 'done'].includes(update.status)) return 'Invalid task transition';
    if (update.status === 'done' && t.status !== 'review') return 'Only a reviewed result can be accepted';
    if (update.status === 'blocked' && !update.note?.trim()) return 'Describe the blocker and next action';
    if (update.status === 'queued' && t.workerId && this.workers.list().some((w) => w.id === t.workerId && BUSY.has(w.status))) return 'Previous attempt is still active';
    for (const key of ['priority', 'roleId', 'assigneeId'] as const) {
      if (update[key] !== undefined) Object.assign(t, { [key]: update[key] });
    }
    if (update.status) {
      t.status = update.status;
      if (update.status === 'done') t.reviewedBy = by;
      if (update.status === 'queued') { t.workerId = undefined; t.outcome = undefined; t.error = undefined; }
    }
    this.record(t, by, update.note?.trim().slice(0, 5000) || (update.status === 'done' ? 'Result accepted' : 'Task assignment or priority updated'));
    if (!this.changed()) return this.storageError;
    this.pump();
  }

  get limit(): number {
    return this.maxWorkers;
  }

  add(prompt: string, by: string, title?: string, issue?: number, provider: AgentProvider = this.workers.defaultProvider, model?: string, effort?: AgentEffort, options: TaskOptions = {}): string | undefined {
    if (this.storageError) return this.storageError;
    const optionError = this.validateOptions(options);
    if (optionError) return optionError;
    if (!isAgentProvider(provider) || (provider === 'custom' && this.workers.defaultProvider !== 'custom')) return 'Unknown agent provider';
    const modelError = validateWorkerModel('agent', provider, model);
    if (modelError) return modelError;
    const effortError = validateWorkerEffort('agent', provider, effort);
    if (effortError) return effortError;
    const clean = prompt.replace(/\r\n?/g, '\n').trim();
    if (!clean) return 'Empty task';
    if (issue !== undefined && this.tasks.some((t) => t.issue === issue && t.status !== 'done')) return `Issue #${issue} is already on the queue`;
    if (this.tasks.filter((t) => t.status !== 'done').length >= MAX_TASKS) return `The queue is full (${MAX_TASKS} tasks)`;
    const task: QueueTask = {
      id: randomBytes(6).toString('hex'),
      provider,
      model: provider === 'opencode' || provider === 'claude' ? model : undefined,
      effort: provider === 'claude' ? effort : undefined,
      issue,
      title: (title?.trim() || firstLine(clean)).slice(0, 120),
      prompt: clean,
      addedBy: by,
      addedAt: Date.now(),
      status: 'queued',
      roleId: options.roleId,
      assigneeId: options.assigneeId,
      priority: options.priority ?? 'medium',
      version: 1,
      history: [{ at: Date.now(), by, note: 'Created task' }],
    };
    this.tasks.push(task);
    if (!this.changed()) return this.storageError;
    this.pump();
    return undefined;
  }

  remove(taskId: string): string | undefined {
    if (this.storageError) return this.storageError;
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return 'No such task';
    if (t.status === 'running') return `${t.workerName ?? 'Its worker'} is on it — send the worker home to stop it`;
    this.tasks.splice(this.tasks.indexOf(t), 1);
    if (!this.changed()) return this.storageError;
    this.pump();
    return undefined;
  }

  /** Takes a closed issue's waiting task off the queue (a running one carries on). Returns whether there was one. */
  dropIssue(issue: number): boolean {
    if (this.storageError) return false;
    const i = this.tasks.findIndex((t) => t.issue === issue && t.status === 'queued');
    if (i < 0) return false;
    this.tasks.splice(i, 1);
    this.changed();
    return true;
  }

  /** Moves a queued task one place up (-1) or down (+1) among the queued tasks. */
  move(taskId: string, delta: -1 | 1) {
    if (this.storageError) return;
    const queued = this.tasks.filter((t) => t.status === 'queued').sort(compareTaskPriority);
    const i = queued.findIndex((t) => t.id === taskId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= queued.length || queued[i].priority !== queued[j].priority) return;
    const a = this.tasks.indexOf(queued[i]);
    const b = this.tasks.indexOf(queued[j]);
    [this.tasks[a], this.tasks[b]] = [this.tasks[b], this.tasks[a]];
    this.changed();
    this.pump();
  }

  /** Puts a finished task back at the end of the queue. */
  retry(taskId: string): string | undefined {
    if (this.storageError) return this.storageError;
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return 'No such task';
    if (!['done', 'blocked', 'review'].includes(t.status)) return 'That task is still on the queue';
    if (t.workerId && this.workers.list().some((w) => w.id === t.workerId && BUSY.has(w.status))) return 'The previous worker is still active';
    if (t.issue !== undefined && this.tasks.some((x) => x !== t && x.issue === t.issue && x.status !== 'done')) return `Issue #${t.issue} is already on the queue`;
    this.tasks.splice(this.tasks.indexOf(t), 1);
    const fresh: QueueTask = { priority: t.priority, roleId: t.roleId, assigneeId: t.assigneeId, history: t.history, version: (t.version ?? 0) + 1, id: t.id, provider: t.provider, model: t.model, effort: t.effort, issue: t.issue, title: t.title, prompt: t.prompt, addedBy: t.addedBy, addedAt: Date.now(), status: 'queued' };
    this.record(fresh, 'queue', 'Requeued for another attempt');
    this.tasks.push(fresh);
    if (!this.changed()) return this.storageError;
    this.pump();
    return undefined;
  }

  /** Forgets the finished tasks. */
  clear() {
    if (this.storageError) return;
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.status !== 'done');
    if (this.tasks.length !== before) this.changed();
  }

  setLimit(n: number) {
    if (this.storageError) return;
    const v = Math.max(0, Math.min(SEATS.length, Math.floor(n)));
    if (!Number.isFinite(v) || v === this.maxWorkers) return;
    this.maxWorkers = v;
    this.changed();
    this.pump();
  }

  /** A worker changed. Cheap unless its status moved, which can free a slot or finish a task. */
  onWorker(info: WorkerInfo) {
    if (!this.ready || this.storageError) return;
    const task = this.tasks.find((t) => t.workerId === info.id && t.status === 'running');
    if (task && info.activity && task.lastUpdate !== info.activity) {
      task.lastUpdate = info.activity; task.updatedAt = Date.now(); this.changed();
    }
    if (this.lastStatus.get(info.id) === info.status) return;
    this.lastStatus.set(info.id, info.status);
    this.pump();
  }

  onWorkerGone(workerId: string) {
    this.lastStatus.delete(workerId);
    this.pump();
  }

  /** Fresh pull requests from GitHub: link each task to the PR that closes its issue (or came from its branch). */
  onPulls(pulls: GhPull[]) {
    if (this.storageError) return;
    let changed = false;
    for (const t of this.tasks) {
      if (t.status === 'queued') continue;
      const since = (t.startedAt ?? t.addedAt) - 60_000;
      const match = pulls
        .filter((p) => (t.branch && p.headRefName === t.branch) || (t.issue !== undefined && p.closes.includes(t.issue) && Date.parse(p.createdAt) >= since))
        .sort((a, b) => Number(b.headRefName === t.branch) - Number(a.headRefName === t.branch) || b.createdAt.localeCompare(a.createdAt))[0];
      if (!match) continue;
      const pr = { number: match.number, url: match.url, state: match.isDraft ? 'DRAFT' : match.state, title: match.title };
      if (t.pr && t.pr.number === pr.number && t.pr.state === pr.state && t.pr.title === pr.title) continue;
      t.pr = pr;
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Finishes tasks whose worker stopped, then seats queued tasks while there's room. */
  pump() {
    if (this.stopped || !this.ready || this.storageError) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        this.reconcile();
        this.seat();
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  shutdown() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  // ---------------------------------------------------------------------------

  private reconcile() {
    const byId = new Map(this.workers.list().map((w) => [w.id, w]));
    let changed = false;
    let done = false;
    for (const t of this.tasks) {
      if (t.status !== 'running') continue;
      if (!t.workerId) { this.finish(t, 'failed'); t.error = 'Running attempt has no worker; inspect before retrying'; changed = true; continue; }
      const w = byId.get(t.workerId);
      if (!w) this.finish(t, 'killed');
      else if (FINISHED.has(w.status)) done = this.finish(t, w.status === 'done' ? 'done' : 'exited') || done;
      else continue;
      changed = true;
    }
    if (!changed) return;
    this.changed();
    // A task finishing is what empties the queue; removing or clearing tasks doesn't count.
    if (done && this.tasks.every((t) => t.status === 'done' || t.status === 'review')) this.events.emptied();
  }

  /** Returns whether the task got done (rather than stopping short). */
  private finish(t: QueueTask, outcome: NonNullable<QueueTask['outcome']>): boolean {
    t.status = outcome === 'done' ? 'review' : 'blocked';
    t.outcome = outcome;
    t.finishedAt = Date.now();
    this.record(t, t.workerName ?? 'worker', outcome === 'done' ? 'Work finished; awaiting review' : `Attempt stopped: ${outcome}`);
    const who = t.workerName ?? 'Its worker';
    if (outcome === 'done') {
      this.events.toast(`📋 ${who} finished ${label(t)}`, 'info');
      // The worker most likely just opened the PR; go and link it.
      this.events.refreshGitHub();
    } else if (outcome === 'exited') this.events.toast(`📋 ${who} stopped before finishing ${label(t)} — requeue it from the queue board`, 'warn');
    return outcome === 'done';
  }

  /** Agents holding a slot. The board agents don't (they stand by their boards), nor do meetings (they have their own limits). */
  private busy(): number {
    return this.workers.list().filter((w) => w.kind === 'agent' && BUSY.has(w.status) && !DESK_BY_ID.get(w.deskId)?.station && !DESK_BY_ID.get(w.deskId)?.room).length;
  }

  /** A free desk, else a free bean bag. */
  private freeDesk(): string | undefined {
    return nextFreeSeat((id) => this.workers.deskOccupied(id))?.id;
  }

  /**
   * No desk or bean bag is free: send home a worker the queue hired whose task is finished (nobody
   * is looking at its terminal), and return its seat. Workers with a linked PR go first — their work
   * is delivered.
   */
  private recycleDesk(): string | undefined {
    const byId = new Map(this.workers.list().map((w) => [w.id, w]));
    const candidates = this.tasks
      .filter((t) => ['done', 'review', 'blocked'].includes(t.status) && !Object.hasOwn(this.assignments, t.workerId ?? '') && t.workerId && byId.has(t.workerId))
      .map((t) => ({ t, w: byId.get(t.workerId!)! }))
      .filter(({ w }) => FINISHED.has(w.status) && w.viewers.length === 0)
      .sort((a, b) => Number(!!b.t.pr) - Number(!!a.t.pr) || (a.t.finishedAt ?? 0) - (b.t.finishedAt ?? 0));
    const pick = candidates[0];
    if (!pick) return undefined;
    const done = this.workers.kill(pick.w.id);
    this.events.toast(`📋 ${pick.w.name} went home after ${label(pick.t)} to make room for the next task`, 'info');
    void done.then(({ note, error }) => {
      if (note) this.events.toast(note, 'info');
      if (error) this.events.toast(error, 'warn');
    });
    return pick.w.deskId;
  }

  private seat() {
    if (this.storageError) return;
    let changed = false;
    const waiting = this.tasks.filter((t) => t.status === 'queued').sort(compareTaskPriority);
    for (const t of waiting) {
      if (this.maxWorkers === 0) break;
      // A spent budget holds the queue instead of failing every task; the pump seats them once hiring resumes.
      if (this.events.hiringPaused()) break;
      // So does an office at its worker limit (--max-workers), unless one of the queue's own finished
      // workers going home makes room. Over the limit (it was just lowered), it waits for people to send some home.
      const assigned = t.assigneeId ? this.workers.list().find((w) => w.id === t.assigneeId) : undefined;
      if (t.assigneeId && (!assigned || assigned.kind !== 'agent')) {
        t.status = 'blocked'; t.error = 'Assigned agent is missing';
        this.record(t, 'queue', t.error); changed = true; continue;
      }
      if (assigned && (this.tasks.some((other) => other !== t && other.status === 'running' && other.workerId === assigned.id)
        || !['idle', 'done'].includes(assigned.status))) continue;
      if (this.busy() - (assigned?.status === 'idle' ? 1 : 0) >= this.maxWorkers) continue;
      const room = assigned ? Infinity : this.events.room?.() ?? Infinity;
      if (room < 0) break;
      const desk = assigned?.deskId ?? ((room > 0 ? this.freeDesk() : undefined) ?? this.recycleDesk());
      if (!desk) break;
      const roleId = t.roleId || (assigned && this.assignments[assigned.id]);
      t.roleSnapshot = structuredClone(this.roles.find((role) => role.id === roleId));
      t.attemptId = randomBytes(8).toString('hex');
      // Persist intent before touching a PTY. A crash in this window requires explicit recovery.
      t.status = 'blocked';
      t.error = 'Dispatch interrupted; inspect the worker before retrying';
      this.record(t, 'queue', 'Starting attempt');
      if (!this.changed()) return;
      const role = t.roleSnapshot;
      const prompt = (role ? 'Role: ' + role.name + '\nResponsibilities: ' + role.responsibilities + '\nInstructions: ' + role.instructions + '\n\n' : '') + t.prompt;
      const promptError = assigned ? (this.workers.prompt ? this.workers.prompt(assigned.id, prompt, t.addedBy) : 'This worker cannot receive tasks') : undefined;
      const r = assigned ? (promptError ?? assigned) : this.workers.spawn(desk, `${t.addedBy} (queue)`, prompt + (this.useWorktree ? WORKTREE_NOTE : ''), this.useWorktree, 'agent', t.provider ?? this.workers.defaultProvider, t.model, t.effort);
      changed = true;
      if (typeof r === 'string') {
        t.status = 'blocked';
        t.outcome = 'failed';
        t.error = r;
        this.record(t, 'queue', 'Attempt failed: ' + r);
        t.finishedAt = Date.now();
        this.events.toast(`📋 Couldn't start ${label(t)}: ${r}`, 'error');
        continue;
      }
      this.workers.holdRecovery?.(r.id);
      t.status = 'running';
      this.record(t, r.name, 'Attempt running');
      t.workerId = r.id;
      t.workerName = r.name;
      t.branch = r.worktree?.branch;
      t.startedAt = Date.now();
      t.error = undefined;
      this.lastStatus.set(r.id, r.status);
      this.events.toast(`📋 ${r.name} sat down at ${DESK_BY_ID.get(desk)?.label ?? 'a desk'} to work on ${label(t)}`, 'info');
      if (t.issue !== undefined) {
        const issue = t.issue;
        void this.events.claimIssue(issue).then((err) => {
          if (err) this.events.toast(`Couldn't assign issue #${issue} on GitHub: ${err}`, 'warn');
        });
      }
    }
    if (changed) this.changed();
  }

  private changed(): boolean {
    try { this.persist(); }
    catch (err) {
      this.storageError = 'Task storage failed; dispatch stopped: ' + (err as Error).message;
      this.events.toast(this.storageError, 'error');
    }
    this.events.update(this.state());
    return !this.storageError;
  }

  private persist() {
    if (this.storageError) throw new Error(this.storageError);
    atomicJson(this.statePath, { version: 1, maxWorkers: this.maxWorkers, tasks: this.tasks, roles: this.roles, assignments: this.assignments });
  }

  private restore() {
    if (!existsSync(this.statePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as { version?: number; maxWorkers?: number; tasks?: Partial<QueueTask>[]; roles?: OfficeRole[]; assignments?: Record<string, string> };
      if (saved.version !== undefined && saved.version !== 1) throw new Error('Unsupported task store version');
      if (!Array.isArray(saved.tasks)) throw new Error('Invalid task store');
      this.roles = saved.roles ?? [];
      this.assignments = saved.assignments ?? {};
      if (!Array.isArray(this.roles) || this.roles.some((r) => !r || typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.instructions !== 'string' || typeof r.responsibilities !== 'string')) throw new Error('Invalid role store');
      if (typeof saved.maxWorkers === 'number' && Number.isFinite(saved.maxWorkers)) this.maxWorkers = Math.max(0, Math.min(SEATS.length, Math.floor(saved.maxWorkers)));
      if (!this.assignments || Array.isArray(this.assignments) || typeof this.assignments !== 'object'
        || Object.values(this.assignments).some((id) => typeof id !== 'string' || !this.roles.some((r) => r.id === id))) throw new Error('Invalid role assignments');
      const taskIds = new Set<string>();
      for (const s of saved.tasks ?? []) {
        if (typeof s.id !== 'string' || typeof s.prompt !== 'string' || typeof s.title !== 'string') throw new Error('Invalid saved task');
        if (taskIds.has(s.id) || (s.status !== undefined && !['queued', 'running', 'blocked', 'review', 'done'].includes(s.status))
          || (s.priority !== undefined && !['urgent', 'high', 'medium', 'low'].includes(s.priority))
          || (s.history !== undefined && (!Array.isArray(s.history) || s.history.some((e) => !e || typeof e.note !== 'string' || typeof e.by !== 'string' || !Number.isFinite(e.at))))) throw new Error('Invalid saved task lifecycle');
        taskIds.add(s.id);
        const provider = isAgentProvider(s.provider) ? s.provider : this.workers.defaultProvider;
        const t: QueueTask = {
          ...s,
          id: s.id,
          provider,
          model: provider === 'opencode' && isValidOpenCodeModel(s.model) ? s.model : provider === 'claude' && isClaudeModel(s.model) ? s.model : undefined,
          effort: provider === 'claude' && isAgentEffort(s.effort) ? s.effort : undefined,
          issue: typeof s.issue === 'number' ? s.issue : undefined,
          title: s.title,
          prompt: s.prompt,
          addedBy: s.addedBy ?? '?',
          addedAt: s.addedAt ?? Date.now(),
          status: ['running', 'done', 'blocked', 'review', 'queued'].includes(s.status ?? '') ? s.status! : 'queued',
          priority: s.priority ?? 'medium',
          version: s.version ?? 1,
          history: s.history ?? [],
          workerId: s.workerId,
          workerName: s.workerName,
          branch: s.branch,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
          outcome: s.outcome,
          error: s.error,
          pr: s.pr,
        };
        if (saved.version === undefined && t.status === 'done') {
          t.status = t.outcome === 'done' ? 'review' : 'blocked';
          this.record(t, 'migration', 'Legacy completion requires review or recovery');
        }
        this.tasks.push(t);
      }
      if (saved.version === undefined) { backupLegacy(this.statePath); this.persist(); }
    } catch (err) {
      // Never overwrite malformed authoritative state with an empty queue.
      this.storageError = 'Task storage could not be read: ' + (err as Error).message;
      this.events.toast(this.storageError, 'error');
    }
  }
}

function label(t: QueueTask): string {
  return t.issue !== undefined ? `#${t.issue}` : `“${t.title.length > 40 ? `${t.title.slice(0, 39)}…` : t.title}”`;
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim();
}
