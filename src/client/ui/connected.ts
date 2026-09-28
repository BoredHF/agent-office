import type { Net } from '../net';
import { store } from '../state';
import { h, openModal } from './dom';
import { canonicalUrl, connectionSummary, taskGroups } from './connected-model';

export function isConnectedOffice(): boolean {
  return store.orchestration?.scope.mode === 'paperclip' || store.floors.find(f => f.id === store.floor)?.orchestration?.mode === 'paperclip';
}

function link(label: string, url?: string): HTMLElement {
  const safe = canonicalUrl(url);
  return safe ? h('a.btn', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, label) : h('span', {}, label);
}

/** Remote records remain projections; local queue and worker commands never act on them. */
export function openConnectedOffice(net?: Net): void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const officeId = store.floor;
  const refresh = h('button.btn', { type: 'button', onclick: () => net?.send({ t: 'orchestration.refresh', officeId, visible: !document.hidden }) }, 'Refresh');
  const reconnect = h('button.btn', { type: 'button', onclick: () => net?.send({ t: 'orchestration.reconnect', officeId, visible: !document.hidden }) }, 'Reconnect');
  const body = h('div.body.connected-office');
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close connected office' }, 'Close');
  const dialog = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Connected office', style: 'width:min(900px,100%)' },
    h('header', {}, h('h2', {}, 'Paperclip office'), refresh, reconnect, close), body);
  const render = () => {
    refresh.disabled = reconnect.disabled = !net?.up;
    const snapshot = store.orchestration;
    if (!snapshot || snapshot.scope.mode !== 'paperclip') {
      body.replaceChildren(h('p', { role: 'status' }, 'Waiting for the server connection snapshot.'));
      return;
    }
    const active = document.activeElement;
    const focusUrl = active instanceof HTMLAnchorElement && body.contains(active) ? active.href : undefined;
    const agents = new Map(snapshot.agents.map(a => [a.source.id, a]));
    body.replaceChildren(h('div', {},
      h('p', { role: 'status', 'aria-live': 'polite' }, connectionSummary(snapshot)),
      h('p', {}, `Connection: ${snapshot.scope.connectionId} · Company: ${snapshot.scope.companyId} · Project: ${snapshot.scope.projectId}`),
      snapshot.error ? h('p', { role: 'alert' }, snapshot.error) : null,
      snapshot.state === 'disconnected' || snapshot.state === 'permission-limited'
        ? h('p', {}, 'Ask the server administrator to verify this server-held connection, then use Reconnect. Remote records may be unavailable.') : null,
      snapshot.state === 'stale' ? h('p', {}, 'Showing the last available snapshot. Remote records may have changed.') : null,
      h('p', {}, 'Approvals, budgets, configuration and audit remain in Paperclip. Open a canonical record below to continue there.'),
      h('details', {}, h('summary', {}, 'Controls and availability'),
        h('p', {}, 'Use Paperclip for remote actions. Controls unavailable in this office are listed below.'),
        ...Object.entries(snapshot.capabilities).map(([action, supported]) => h('p', {},
          h('button.btn', { disabled: true }, action), ` ${supported ? 'Available from the provider; unavailable in this office' : 'Unsupported by this connection'}`))),
      h('h3', {}, 'Tasks'), snapshot.tasks.length ? null : h('p', {}, 'No tasks in this snapshot.'),
      ...taskGroups(snapshot.tasks).map(([status, tasks]) => h('section', { 'aria-label': status },
        h('h4', {}, `${status} (${tasks.length})`),
        ...tasks.map(task => h('article.connected-card', {}, link(task.title, task.source.url),
          h('p', {}, `${task.nativeStatus} · ${task.priority ?? 'No priority'} · ${agents.get(task.assigneeId ?? '')?.name ?? task.assigneeId ?? 'Unassigned'}`),
          task.description ? h('details', {}, h('summary', {}, 'Description'), h('pre.workflow-text', {}, task.description)) : null)))),
      h('h3', {}, 'Agents'), h('p', {}, 'Presence describes project activity, not desk ownership.'),
      snapshot.agents.length ? null : h('p', {}, 'No agents in this snapshot.'),
      ...snapshot.agents.map(agent => h('article.connected-card', {}, link(agent.name, agent.source.url),
        h('p', {}, `${agent.nativeStatus} · ${agent.activeTaskIds.filter(id => snapshot.tasks.some(t => t.source.id === id)).length} project tasks`))),
      h('h3', {}, 'Activity'), snapshot.activity.length ? null : h('p', {}, 'No project activity available.'),
      ...snapshot.activity.map(item => h('p', {}, link(item.text, item.source.url), ` · ${item.at}`)),
      h('p', {}, 'A run ending does not mark its task done. Native Paperclip task status is authoritative.'),
    ));
    if (focusUrl) {
      const replacement = [...body.querySelectorAll('a')].find(a => a.href === focusUrl);
      (replacement ?? close).focus();
    } else if (active instanceof HTMLElement && !active.isConnected) close.focus();
  };
  const offs = [store.on('orchestration', render), store.on('floor', () => modal.close())];
  const modal = openModal(dialog, { onClose: () => { offs.forEach(off => off()); previous?.isConnected && previous.focus(); } });
  close.onclick = () => modal.close();
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary')];
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  net?.send({ t: 'orchestration.refresh', officeId, visible: !document.hidden });
  render();
  close.focus();
}
