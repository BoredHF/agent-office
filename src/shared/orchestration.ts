/** Browser-safe provider contract v1. Never add credentials or transport configuration here. */
export type OfficeBinding = { mode: 'local' } | {
  mode: 'paperclip'; connectionId: string; companyId: string; projectId: string;
};
export type ProviderScope = OfficeBinding & { officeId: string };
export type ProviderAction = 'task.create' | 'task.comment' | 'task.assign' | 'task.status'
  | 'agent.wake' | 'agent.pause' | 'agent.cancel' | 'agent.hire' | 'agent.instructions'
  | 'terminal' | 'meetings';
export type ProviderCapabilities = Record<ProviderAction, boolean>;
export interface ProviderSource { id: string; url?: string; version?: string }
export interface ProviderAgent {
  source: ProviderSource; name: string; nativeStatus: string;
  /** Project-related activity, not physical desk ownership. */
  activeTaskIds: string[];
}
export type PaperclipTaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export interface ProviderTask {
  source: ProviderSource; title: string; description?: string; nativeStatus: string;
  displayStatus: string; priority?: string; assigneeId?: string; attemptId?: string;
}
export interface ProviderActivity { source: ProviderSource; taskId?: string; agentId?: string; at: string; text: string }
export interface ProviderSnapshot {
  schemaVersion: 1; scope: ProviderScope; capabilities: ProviderCapabilities;
  state: 'local' | 'connected' | 'permission-limited' | 'disconnected' | 'stale';
  lastSuccessfulSync: string | null; error?: string;
  agents: ProviderAgent[]; tasks: ProviderTask[]; activity: ProviderActivity[];
}
/** Preserve operation identity through timeout/reconnect. No automatic write retries. */
export interface ProviderCommand {
  operationId: string; scope: ProviderScope; action: ProviderAction;
  target?: ProviderSource; payload: Readonly<Record<string, unknown>>;
}
export interface ProviderCommandResult {
  operationId: string; outcome: 'applied' | 'rejected' | 'conflict' | 'unknown';
  message?: string; source?: ProviderSource;
}
export const NO_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  'task.create': false, 'task.comment': false, 'task.assign': false, 'task.status': false,
  'agent.wake': false, 'agent.pause': false, 'agent.cancel': false, 'agent.hire': false,
  'agent.instructions': false, terminal: false, meetings: false,
};
/** Missing means legacy local. Malformed/unknown persisted bindings must never become local. */
export function officeBinding(value: unknown): OfficeBinding {
  if (value === undefined) return { mode: 'local' };
  if (!value || typeof value !== 'object') throw new Error('Invalid orchestration binding');
  const b = value as Record<string, unknown>;
  if (b.mode === 'local' && Object.keys(b).length === 1) return { mode: 'local' };
  if (b.mode === 'paperclip' && ['connectionId', 'companyId', 'projectId'].every((k) => typeof b[k] === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(b[k] as string))
    && Object.keys(b).every((k) => ['mode', 'connectionId', 'companyId', 'projectId'].includes(k))) {
    return { mode: 'paperclip', connectionId: b.connectionId as string, companyId: b.companyId as string, projectId: b.projectId as string };
  }
  throw new Error('Invalid orchestration binding');
}
export function sameProviderScope(a: ProviderScope, b: ProviderScope): boolean {
  return a.officeId === b.officeId && a.mode === b.mode && (a.mode === 'local'
    || (b.mode === 'paperclip' && a.connectionId === b.connectionId && a.companyId === b.companyId && a.projectId === b.projectId));
}
/** Legacy execution surfaces stay local, even if connected capabilities eventually allow equivalents. */
export function isLocalExecutionMessage(type: string): boolean {
  return type === 'control' || /^(worker\.|term\.|station\.|queue\.|task\.|role\.|agent\.|meeting\.|command\.|gh\.|changes\.)/.test(type);
}
