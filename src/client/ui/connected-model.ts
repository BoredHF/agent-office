import type { ProviderSnapshot, ProviderTask } from '../../shared/orchestration';

/** Canonical navigation is never an executable URL or a credential-bearing URL. */
export function canonicalUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function taskGroups(tasks: ProviderTask[]): [string, ProviderTask[]][] {
  const groups = new Map<string, ProviderTask[]>(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'].map(s => [s, []]));
  for (const task of tasks) {
    if (!groups.has(task.nativeStatus)) groups.set(task.nativeStatus, []);
    groups.get(task.nativeStatus)!.push(task);
  }
  return [...groups];
}

export function connectionSummary(snapshot: ProviderSnapshot): string {
  const sync = snapshot.lastSuccessfulSync;
  const at = sync && Number.isFinite(Date.parse(sync)) ? new Date(sync).toLocaleString() : 'Never';
  return `${snapshot.state} · Last successful sync: ${at}`;
}
