import type { Net } from '../net';
import { store } from '../state';
import { h, openModal } from './dom';
import { createdOffice, parseCatalog, setupRequest, type SetupProject, type SetupRequest } from './connected-setup-model';

// Retain an uncertain operation across dialog close and page reload in this tab.
const pendingKey = 'agent-office.connected-setup';
let pending: Readonly<SetupRequest> | undefined;
try {
  const saved = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
  if (saved && typeof saved.requestId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(saved.requestId)) {
    pending = setupRequest(parseCatalog({ projects: [saved] })[0], saved.name, saved.requestId);
  }
} catch { /* Storage may be unavailable; retain requests in memory for this page. */ }
function savePending(value: Readonly<SetupRequest> | undefined) {
  pending = value;
  try {
    if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
    else sessionStorage.removeItem(pendingKey);
  } catch { /* The in-memory request still permits safe retry. */ }
}

export function openConnectedSetup(net: Net): void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let alive = true, busy = false, projects: SetupProject[] = [];
  const name = h('input', { required: true, maxlength: 100, value: pending?.name ?? '', 'aria-label': 'Office name' });
  const connection = h('select', { 'aria-label': 'Connection' });
  const company = h('select', { 'aria-label': 'Company' });
  const project = h('select', { 'aria-label': 'Project' });
  const status = h('p', { role: 'status', 'aria-live': 'polite' }, 'Loading server-approved projects…');
  const submit = h('button.btn.primary', { type: 'submit', disabled: true }, pending ? 'Retry saved request' : 'Create connected office');
  const reload = h('button.btn', { type: 'button' }, 'Reload catalog');
  const close = h('button.btn.close', { type: 'button' }, 'Close');
  const form = h('form.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Connect office', style: 'width:min(620px,100%)' },
    h('header', {}, h('h2', {}, 'Connect Paperclip office'), close),
    h('div.body.connected-office', {}, h('p', {}, 'Choose a server-configured connection. Credentials are managed by your server administrator.'),
      h('div.workflow-fields', {}, h('label', {}, 'Office name', name), h('label', {}, 'Connection', connection), h('label', {}, 'Company', company), h('label', {}, 'Project', project)),
      status, reload), h('footer', {}, submit));
  const setOptions = (select: HTMLSelectElement, values: [string, string][], preferred?: string) => {
    select.replaceChildren(...values.map(([value, label]) => h('option', { value }, label)));
    if (preferred && values.some(([id]) => id === preferred)) select.value = preferred;
  };
  const lock = () => {
    for (const field of [name, connection, company, project]) field.disabled = busy || !!pending;
    reload.disabled = busy;
    submit.disabled = busy || (!pending && !project.value);
    submit.textContent = pending ? 'Retry saved request' : 'Create connected office';
  };
  const projectsChanged = () => {
    setOptions(project, projects.filter(p => p.connectionId === connection.value && p.companyId === company.value).map(p => [p.projectId, p.name]), pending?.projectId);
    lock();
  };
  const companiesChanged = () => {
    setOptions(company, [...new Set(projects.filter(p => p.connectionId === connection.value).map(p => p.companyId))].map(id => [id, id]), pending?.companyId);
    projectsChanged();
  };
  connection.onchange = companiesChanged;
  company.onchange = projectsChanged;
  const load = async () => {
    busy = true; lock();
    try {
      const response = await fetch('/api/paperclip/catalog', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(response.status === 401 ? 'Session expired. Sign in again.' : 'Catalog unavailable. Retry or ask your server administrator.');
      const rows = parseCatalog(await response.json());
      if (!alive) return;
      projects = rows;
      setOptions(connection, [...new Set(rows.map(p => p.connectionId))].map(id => [id, id]), pending?.connectionId);
      companiesChanged();
      status.textContent = pending ? 'A creation outcome is unresolved. Retry the saved request to reconcile; its name and scope are locked.' :
        rows.length ? 'Only currently authorized projects are shown.' : 'No authorized projects available. Ask your server administrator to configure or reconnect a scope.';
    } catch (error) {
      if (alive) status.textContent = error instanceof Error ? error.message : 'Catalog unavailable.';
    } finally { if (alive) { busy = false; lock(); } }
  };
  const off = store.on('floor', () => modal.close());
  const modal = openModal(form, { onClose: () => { alive = false; off(); if (previous?.isConnected) previous.focus(); } });
  close.onclick = () => modal.close();
  reload.onclick = () => { void load(); };
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    try {
      if (!pending) {
        const selected = projects.find(p => p.connectionId === connection.value && p.companyId === company.value && p.projectId === project.value);
        if (!selected) throw new Error('Choose an authorized project.');
        savePending(setupRequest(selected, name.value, crypto.randomUUID()));
      }
      const request = pending!;
      busy = true; lock(); status.textContent = 'Creating or reconciling office…';
      const response = await fetch('/api/paperclip/offices', { method: 'POST', signal: AbortSignal.timeout(30000), credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      if (!response.ok) throw new Error(response.status === 401 ? 'Session expired. Sign in again; the saved request is retained.' :
        response.status === 409 ? 'Scope unavailable or request conflict. Ask your administrator to restore access; retry retains the same request.' :
        'Creation could not be confirmed. Retry the saved request to reconcile.');
      const officeId = createdOffice(await response.json(), request);
      savePending(undefined);
      if (alive) { net.send({ t: 'floor.go', floor: officeId }); modal.close(); }
    } catch (error) {
      if (alive) status.textContent = error instanceof Error ? error.message : 'Outcome unknown. Retry the saved request.';
    } finally { if (alive) { busy = false; lock(); } }
  };
  form.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const fields = [...form.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
    const first = fields[0], last = fields.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  close.focus();
  void load();
}
