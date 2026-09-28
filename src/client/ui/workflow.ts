import { openConnectedSetup } from './connected-setup';
import { openConnectedOffice, isConnectedOffice } from './connected';
import type { OfficeRole, QueueTask, TaskPriority, TaskUpdate } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal } from './dom';
import { confirmDialog, openPrompt } from './prompt';

function select(label: string, options: [string, string][], value = '') {
  const el = h('select', { 'aria-label': label }, ...options.map(([id, name]) => h('option', { value: id }, name)));
  el.value = value;
  return el;
}

export function taskPickers(task?: QueueTask) {
  const priority = select('Priority', ['urgent', 'high', 'medium', 'low'].map((p) => [p, p]), task?.priority ?? 'medium');
  const role = select('Role', [['', 'No role override'], ...(store.queue.roles ?? []).map((r): [string, string] => [r.id, r.name])], task?.roleId);
  const assignee = select('Assign agent', [['', 'New worker'], ...[...store.workers.values()].filter((w) => w.kind === 'agent').map((w): [string, string] => [w.id, w.name])], task?.assigneeId);
  return {
    element: h('div.workflow-fields', {}, h('label', {}, 'Priority', priority), h('label', {}, 'Role', role), h('label', {}, 'Assign agent', assignee)),
    value: () => ({ priority: priority.value as TaskPriority, roleId: role.value, assigneeId: assignee.value }),
  };
}

export function openTask(net: Net, task: QueueTask) {
  const officeId = store.floor;
  const fields = taskPickers(task);
  const note = h('textarea', { rows: 3, 'aria-label': 'Progress or handoff note', placeholder: 'Progress, review feedback, or blocker and next action…' });
  const close = h('button.btn', { type: 'button' }, 'Close');
  const buttons: HTMLElement[] = [];
  const save = (label: string, status?: TaskUpdate['status']) => h('button.btn', { type: 'button', onclick: () => {
    if (status === 'blocked' && !note.value.trim()) { note.focus(); return; }
    net.send({ t: 'task.update', officeId, taskId: task.id, version: task.version ?? 1, update: { ...fields.value(), status, note: note.value } });
    modal.close();
  } }, label);
  if (task.status !== 'running') {
    buttons.push(save('Save assignment / handoff'));
    if (task.status !== 'done') buttons.push(save('Block', 'blocked'));
    if (task.status === 'blocked' || task.status === 'review') buttons.push(save('Queue next attempt', 'queued'));
    if (task.status === 'review') buttons.push(save('Accept result', 'done'));
  } else {
    buttons.push(h('button.btn', { onclick: () => {
      net.send({ t: 'task.update', officeId, taskId: task.id, version: task.version ?? 1, update: { note: note.value } }); modal.close();
    } }, 'Add progress note'));
  }
  const snapshot = task.roleSnapshot;
  const modal = openModal(h('div.modal', { role: 'dialog', 'aria-label': 'Task details' },
    h('header', {}, h('h2', {}, task.title)),
    h('div.body', {}, h('p', {}, `${task.status} · ${task.priority ?? 'medium'} · ${task.workerName ?? 'unassigned'}`),
      h('pre.workflow-text', {}, task.prompt), task.status !== 'running' ? fields.element : null,
      task.error ? h('p', { role: 'alert' }, task.error) : null,
      snapshot ? h('details', {}, h('summary', {}, `Role snapshot: ${snapshot.name} v${snapshot.version}`), h('pre.workflow-text', {}, `${snapshot.responsibilities}\n${snapshot.instructions}`)) : null,
      h('h4', {}, 'History'), h('ol', {}, ...(task.history ?? []).map((e) => h('li', {}, `${new Date(e.at).toLocaleString()} · ${e.by}: ${e.note}`))), note),
    h('footer', {}, close, ...buttons)));
  close.onclick = () => modal.close();
}

function editRole(net: Net, role?: OfficeRole) {
  const officeId = store.floor;
  const name = h('input', { 'aria-label': 'Role name', value: role?.name ?? '', required: true, maxlength: 100 });
  const responsibilities = h('textarea', { rows: 3, 'aria-label': 'Responsibilities', maxlength: 10000 });
  const instructions = h('textarea', { rows: 5, 'aria-label': 'Instructions', maxlength: 20000 });
  responsibilities.value = role?.responsibilities ?? '';
  instructions.value = role?.instructions ?? '';
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const form = h('form.modal', { role: 'dialog', 'aria-label': 'Edit role' }, h('header', {}, h('h2', {}, role ? 'Edit role' : 'Create role')),
    h('div.body.workflow-fields', {}, h('label', {}, 'Name', name), h('label', {}, 'Responsibilities', responsibilities), h('label', {}, 'Instructions', instructions)),
    h('footer', {}, cancel, h('button.btn.primary', { type: 'submit' }, 'Save role')));
  const modal = openModal(form);
  cancel.onclick = () => modal.close();
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!name.value.trim()) return;
    net.send({ t: 'role.save', officeId, role: { id: role?.id ?? '', name: name.value, responsibilities: responsibilities.value, instructions: instructions.value }, version: role?.version });
    modal.close();
  };
}

export function openRoles(net: Net) {
  if (isConnectedOffice()) return openConnectedOffice(net);
  const officeId = store.floor;
  const body = h('div.body');
  const close = h('button.btn', {}, 'Close');
  const render = () => {
    const roles = store.queue.roles ?? [];
    body.replaceChildren(h('p', {}, 'Role edits apply to future attempts. Running tasks keep their instruction snapshot.'),
      ...roles.map((r) => h('p', {}, h('b', {}, r.name), ` · v${r.version} · ${r.responsibilities} `, h('button.btn', { onclick: () => editRole(net, r) }, 'Edit'))),
      h('button.btn', { onclick: () => editRole(net) }, 'Create role'), h('h3', {}, 'Agent roles'),
      ...[...store.workers.values()].filter((w) => w.kind === 'agent').map((w) => {
        const picker = select(`Role for ${w.name}`, [['', 'No role'], ...roles.map((r): [string, string] => [r.id, r.name])], store.queue.assignments?.[w.id]);
        picker.onchange = () => net.send({ t: 'role.assign', officeId, workerId: w.id, roleId: picker.value });
        const task = store.queue.tasks.find((t) => t.workerId === w.id && t.status === 'running');
        return h('p', {}, h('label', {}, w.name, picker), ` ${task?.title ?? w.status} · ${w.activity ?? task?.lastUpdate ?? 'No update yet'}`);
      }));
  };
  const offs = [store.on('floor', () => modal.close()), store.on('queue', render), store.on('workers', render)];
  const modal = openModal(h('div.modal', { role: 'dialog', 'aria-label': 'Office roles' }, h('header', {}, h('h2', {}, 'Roles and agents')), body, h('footer', {}, close)), { onClose: () => offs.forEach((off) => off()) });
  close.onclick = () => modal.close();
  render();
}

export function openOffices(net: Net) {
  const body = h('div.body');
  const close = h('button.btn', {}, 'Close');
  const render = () => body.replaceChildren(
    h('p', {}, 'Each office has its own agents, roles, tasks and activity. Local offices start with an empty workspace; add repository projects through the elevator.'),
    h('button.btn.primary', { onclick: () => openPrompt({ title: 'Create office', placeholder: 'Office name', onSubmit: (name) => net.send({ t: 'office.create', name }) }) }, 'Create office'),
    h('button.btn', { onclick: () => openConnectedSetup(net) }, 'Connect Paperclip office'),
    ...store.floors.filter((f) => !f.cloning).map((f) => h('p.workflow-fields', {}, h('b', {}, f.name),
      h('button.btn', { disabled: !!f.archivedAt || f.id === store.floor, onclick: () => { net.send({ t: 'floor.go', floor: f.id }); modal.close(); } }, f.id === store.floor ? 'Current office' : 'Switch'),
      h('button.btn', { onclick: () => openPrompt({ title: 'Rename office', initial: f.name, onSubmit: (name) => net.send({ t: 'office.rename', officeId: f.id, name }) }) }, 'Rename'),
      h('button.btn', { onclick: () => confirmDialog(f.archivedAt ? 'Restore office?' : 'Archive office?', 'Data is preserved. Archiving requires no active agents or queued/running tasks.', f.archivedAt ? 'Restore' : 'Archive', () => net.send({ t: 'office.archive', officeId: f.id, archived: !f.archivedAt })) }, f.archivedAt ? 'Restore' : 'Archive'))));
  const off = store.on('floors', render);
  const modal = openModal(h('div.modal', { role: 'dialog', 'aria-label': 'Offices' }, h('header', {}, h('h2', {}, 'Offices')), body, h('footer', {}, close)), { onClose: off });
  close.onclick = () => modal.close();
  render();
}
