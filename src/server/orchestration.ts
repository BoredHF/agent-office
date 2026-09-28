import { NO_PROVIDER_CAPABILITIES, officeBinding, sameProviderScope, type OfficeBinding, type ProviderCommand, type ProviderCommandResult, type ProviderScope, type ProviderSnapshot } from '../shared/orchestration.js';
import { PaperclipReadProvider, type PaperclipConnection, type ReadOptions } from './paperclip/reads.js';
import type { WorkerManager } from './workers.js';
import type { TaskQueue } from './queue.js';
import type { MeetingRoom } from './meetings.js';

/** The only execution-producing resources; never construct this bundle for a connected office. */
export interface LocalRuntime { workers: WorkerManager; queue: TaskQueue; meetings: MeetingRoom }
export interface OrchestrationProvider {
  readonly scope: ProviderScope;
  snapshot(): ProviderSnapshot;
  refresh?(visible: boolean): Promise<ProviderSnapshot>;
  command(command: ProviderCommand): Promise<ProviderCommandResult>;
  disconnect(): void;
  shutdown(keep?: boolean): void;
}
export class LocalOrchestrationProvider implements OrchestrationProvider {
  readonly ready: Promise<void>;
  constructor(readonly scope: ProviderScope, readonly runtime: LocalRuntime) {
    this.ready = runtime.workers.start(runtime.queue.state().tasks.flatMap((t) => t.workerId ? [t.workerId] : []))
      .then(() => runtime.queue.start());
  }
  snapshot(): ProviderSnapshot {
    const q = this.runtime.queue.state();
    return {
      schemaVersion: 1, scope: this.scope, state: 'local', lastSuccessfulSync: null,
      // Generic commands await the existing controls adapter; legacy local routes remain available.
      capabilities: { ...NO_PROVIDER_CAPABILITIES, terminal: true, meetings: true },
      agents: this.runtime.workers.list().map((w) => ({ source: { id: w.id }, name: w.name, nativeStatus: w.status, activeTaskIds: q.tasks.filter((t) => t.workerId === w.id && t.status === 'running').map((t) => t.id) })),
      tasks: q.tasks.map((t) => ({ source: { id: t.id, version: String(t.version ?? 0) }, title: t.title, description: t.prompt, nativeStatus: t.status, displayStatus: t.status, priority: t.priority, assigneeId: t.assigneeId, attemptId: t.attemptId })),
      activity: q.tasks.flatMap((t) => (t.history ?? []).map((h, i) => ({ source: { id: `${t.id}:${i}` }, taskId: t.id, at: new Date(h.at).toISOString(), text: h.note }))),
    };
  }
  async command(c: ProviderCommand): Promise<ProviderCommandResult> {
    return { operationId: c.operationId, outcome: 'rejected', message: sameProviderScope(c.scope, this.scope) ? 'Use the acknowledged local controls endpoint' : 'Office context changed' };
  }
  disconnect() { /* Local execution has no remote connection. */ }
  shutdown(keep = false) { this.runtime.queue.shutdown(); this.runtime.meetings.shutdown(); this.runtime.workers.shutdown(keep); }
}
/** Safe placeholder until package C installs an authenticated connector. Never falls back to local. */
export class DisconnectedOrchestrationProvider implements OrchestrationProvider {
  constructor(readonly scope: ProviderScope) {}
  snapshot(): ProviderSnapshot {
    return { schemaVersion: 1, scope: this.scope, capabilities: { ...NO_PROVIDER_CAPABILITIES }, state: 'disconnected', lastSuccessfulSync: null, error: 'Paperclip connector is not configured', agents: [], tasks: [], activity: [] };
  }
  async command(c: ProviderCommand): Promise<ProviderCommandResult> {
    return { operationId: c.operationId, outcome: 'rejected', message: sameProviderScope(c.scope, this.scope) ? 'Paperclip connector is disconnected' : 'Office context changed' };
  }
  disconnect() {}
  shutdown() {}
}
export interface ConnectedProviderConfig {
  /** Trusted server registry only; office scope must be authorized by the resolver. */
  resolveConnection(scope: Extract<ProviderScope, { mode: 'paperclip' }>): PaperclipConnection | undefined;
  /** Explicit server-authorized setup bindings. Absent means an empty setup catalog. */
  setupScopes?: () => readonly import('./paperclip/setup.js').SetupScope[];
  readOptions?: ReadOptions;
}
/** Factory is deliberately lazy: validation and mode selection precede every local constructor. */
export function createOrchestrationProvider(officeId: string, binding: OfficeBinding | undefined, local: () => LocalRuntime, connected?: ConnectedProviderConfig): OrchestrationProvider {
  const scope: ProviderScope = Object.freeze({ ...officeBinding(binding), officeId });
  if (scope.mode === 'local') return new LocalOrchestrationProvider(scope, local());
  const connection = connected?.resolveConnection(scope);
  return connection ? new PaperclipReadProvider(scope, connection, connected?.readOptions) : new DisconnectedOrchestrationProvider(scope);
}
