import { PaperclipReadProvider } from './reads.js';
import type { ConnectedProviderConfig } from '../orchestration.js';
import { officeBinding, type ProviderScope } from '../../shared/orchestration.js';

export interface SetupScope { connectionId: string; companyId: string; projectId: string }
export function setupScope(value: unknown): SetupScope {
  if (!value || typeof value !== 'object') throw new Error('Invalid setup scope');
  const v = value as Record<string, unknown>;
  const binding = officeBinding({ mode: 'paperclip', connectionId: v.connectionId, companyId: v.companyId, projectId: v.projectId });
  if (binding.mode !== 'paperclip') throw new Error('Invalid setup scope');
  return { connectionId: binding.connectionId, companyId: binding.companyId, projectId: binding.projectId };
}
export function configuredScope(config: ConnectedProviderConfig | undefined, scope: SetupScope): boolean {
  return !!config?.setupScopes?.().some(s => s.connectionId === scope.connectionId && s.companyId === scope.companyId && s.projectId === scope.projectId);
}
/** Fresh resolver + upstream scope validation; no browser origin, credential or permission input. */
export async function validateSetup(config: ConnectedProviderConfig | undefined, scope: SetupScope, officeId: string) {
  if (!config || !configuredScope(config, scope)) throw new Error('Setup scope unavailable');
  const bound: Extract<ProviderScope, { mode: 'paperclip' }> = Object.freeze({ mode: 'paperclip', officeId, ...scope });
  const connection = config.resolveConnection(bound);
  if (!connection) throw new Error('Setup scope unavailable');
  const provider = new PaperclipReadProvider(bound, connection, config.readOptions);
  try {
    const snapshot = await provider.refresh(true);
    if (!snapshot.lastSuccessfulSync || !['connected', 'permission-limited'].includes(snapshot.state)) throw new Error('Setup scope unavailable');
    const project = (await provider.projects()).find(p => p.id === scope.projectId);
    if (!project || !configuredScope(config, scope)) throw new Error('Setup scope unavailable');
    return { provider, project };
  } catch { provider.shutdown(); throw new Error('Setup scope unavailable'); }
}
export async function setupCatalog(config?: ConnectedProviderConfig) {
  const projects: (SetupScope & { name: string })[] = [];
  const scopes = config?.setupScopes?.() ?? [];
  if (scopes.length > 100) throw new Error('Setup catalog unavailable');
  const seen = new Set<string>();
  for (const candidate of scopes) {
    let checked;
    try {
      const scope = setupScope(candidate), key = JSON.stringify(scope);
      if (seen.has(key)) continue;
      seen.add(key);
      checked = await validateSetup(config, scope, 'setup-catalog');
      projects.push({ ...scope, name: checked.project.name });
    } catch { /* Unavailable or revoked scopes are not disclosed. */ }
    finally { checked?.provider.shutdown(); }
  }
  return { projects };
}
