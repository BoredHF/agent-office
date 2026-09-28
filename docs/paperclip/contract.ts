/** Executable package-A reference contract. Not wired into the application.
 * B owns shared protocol; C owns adoption in the server connector.
 */
export const taskStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'] as const;
export const taskPriorities = ['critical', 'high', 'medium', 'low'] as const;
export type Scope = { companyId: string; projectId: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(): never { throw new Error('Invalid Paperclip response'); }
export function projectIssues(body: unknown, scope: Scope) {
  if (!Array.isArray(body)) invalid();
  return body.map((row: unknown) => {
    if (!object(row) || typeof row.id !== 'string' || !row.id ||
      row.companyId !== scope.companyId || row.projectId !== scope.projectId ||
      !taskStatuses.includes(row.status as any) || !taskPriorities.includes(row.priority as any) ||
      !Number.isSafeInteger(row.statusVersion) || (row.statusVersion as number) < 0 ||
      typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) invalid();
    // Explicit projection: never spread raw agent/project/issue responses into browser DTOs.
    return { id: row.id, companyId: scope.companyId, projectId: scope.projectId,
      status: row.status as typeof taskStatuses[number], priority: row.priority as typeof taskPriorities[number],
      statusVersion: row.statusVersion as number, updatedAt: row.updatedAt };
  });
}
export function validateOrigin(value: string, approvedOrigins: readonly string[]) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Paperclip origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || !approvedOrigins.includes(url.origin)) throw new Error('Invalid Paperclip origin');
  return url.origin;
}
/** Approved origins are trusted server configuration, never supplied by a browser.
 * Network/DNS egress enforcement remains a deployment requirement.
 */
export async function readContract(origin: string, approvedOrigins: readonly string[], path: string,
  credential: string, transport: typeof fetch = fetch): Promise<unknown> {
  const base = validateOrigin(origin, approvedOrigins);
  if (!/^\/api\/[a-zA-Z0-9/?=&_.%-]+$/.test(path) || /%2f|%5c|\.\./i.test(path)) throw new Error('Invalid Paperclip path');
  let response: Response;
  try { response = await transport(base + path, { method: 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error('Paperclip read failed'); }
  if (!response.ok) throw new Error(`Paperclip HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new Error('Invalid Paperclip response'); }
}
/** Schema presence and a successful read do not authorize a command. */
export function commandCapability() {
  return { supported: false as const, reason: 'Deployment identity, attribution and command semantics require verification' };
}
