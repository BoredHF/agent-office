export interface SetupProject { connectionId: string; companyId: string; projectId: string; name: string }
export interface SetupRequest extends SetupProject { requestId: string }
export function parseCatalog(value: unknown): SetupProject[] {
  const rows = (value as { projects?: unknown })?.projects;
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid connection catalog.');
  return rows.map(row => {
    if (!row || ['connectionId', 'companyId', 'projectId', 'name'].some(key => typeof row[key] !== 'string' || !row[key])) throw new Error('Invalid connection catalog.');
    return { connectionId: row.connectionId, companyId: row.companyId, projectId: row.projectId, name: row.name };
  });
}
/** Preserve this immutable payload until a creation outcome is reconciled. */
export function setupRequest(project: SetupProject, name: string, requestId: string): Readonly<SetupRequest> {
  if (!name.trim() || name.trim().length > 100) throw new Error('Enter an office name (1–100 characters).');
  return Object.freeze({ connectionId: project.connectionId, companyId: project.companyId, projectId: project.projectId, name: name.trim(), requestId });
}
export function createdOffice(value: unknown, request: SetupRequest): string {
  const result = value as { officeId?: string; scope?: Record<string, unknown> };
  if (!result || typeof result.officeId !== 'string' || !result.officeId || result.scope?.mode !== 'paperclip' ||
    result.scope.officeId !== result.officeId || ['connectionId', 'companyId', 'projectId'].some(key => result.scope?.[key] !== request[key as keyof SetupRequest])) {
    throw new Error('Creation response could not be verified. Retry the same request to reconcile.');
  }
  return result.officeId;
}
