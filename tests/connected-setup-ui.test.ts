import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM for exercising the real form's async handlers without a browser.
class Element {
  children: (Element | string)[] = [];
  attrs: Record<string, string> = {};
  disabled = false;
  className = '';
  textContent = '';
  isConnected = true;
  private currentValue = '';
  onclick?: () => void;
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  constructor(readonly tag: string) {}
  setAttribute(key: string, value: string) {
    this.attrs[key] = value;
    if (key === 'disabled') this.disabled = true;
    if (key === 'value') this.currentValue = value;
  }
  get value(): string { return this.currentValue || (this.tag === 'select' ? (this.children[0] as Element)?.value ?? '' : ''); }
  set value(value: string) { this.currentValue = value; }
  append(...children: (Element | string)[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; this.currentValue = ''; }
  addEventListener() {}
  focus() {}
  remove() { this.isConnected = false; }
  querySelector(selector: string) { return this.all().find(el => selector === '.close' && el.className.includes('close')) ?? null; }
  all(): Element[] { return [this, ...this.children.flatMap(child => child instanceof Element ? child.all() : [])]; }
}

test('catalog reload failures block fresh submissions but preserve immutable pending retries', async t => {
  const root = new Element('root');
  const storage = new Map<string, string>();
  const restore: (() => void)[] = [];
  for (const [key, value] of Object.entries({
    Node: Element, HTMLElement: Element,
    document: { activeElement: null, createElement: (tag: string) => new Element(tag), getElementById: () => root },
    window: { addEventListener() {}, removeEventListener() {} },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    restore.push(() => prior ? Object.defineProperty(globalThis, key, prior) : Reflect.deleteProperty(globalThis, key));
  }
  const { openConnectedSetup } = await import('../src/client/ui/connected-setup.js');
  const { closeAllModals } = await import('../src/client/ui/dom.js');
  t.after(() => { closeAllModals(); restore.forEach(fn => fn()); });
  const rows = [{ connectionId: 'connection', companyId: 'company', projectId: 'project', name: 'Project' }];
  let catalog: () => Promise<Response> = async () => Response.json({ projects: rows });
  const posts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/api/paperclip/catalog') return catalog();
    posts.push(String(init?.body));
    throw new Error('Response lost');
  });
  openConnectedSetup({ send() {} } as never);
  const all = root.all();
  const form = all.find(el => el.tag === 'form')!;
  const submit = all.find(el => el.attrs.type === 'submit')!;
  const reload = all.find(el => el.children.includes('Reload catalog'))!;
  const name = all.find(el => el.attrs['aria-label'] === 'Office name')!;
  const project = all.find(el => el.attrs['aria-label'] === 'Project')!;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const send = () => form.onsubmit!({ preventDefault() {} });
  await settle();
  name.value = 'Office';
  assert.equal(submit.disabled, false);

  const failures = [
    async () => new Response(null, { status: 401 }),
    async () => new Response(null, { status: 403 }),
    async () => Response.json({ projects: [{ name: 'Malformed' }] }),
    async () => { throw new Error('Network unavailable'); },
  ];
  for (const failure of failures) {
    let finish!: (response: Response) => void;
    let fail!: (error: unknown) => void;
    catalog = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    reload.onclick!();
    assert.equal(submit.disabled, true, 'loading invalidates fresh creation');
    await failure().then(finish, fail);
    await settle();
    assert.equal(submit.disabled, true, 'failed catalog must not authorize creation');
    assert.equal(project.value, '', 'stale project options are cleared');
    await send(); // Guard the handler as well as the disabled button.
    assert.equal(posts.length, 0);
    catalog = async () => Response.json({ projects: rows });
    reload.onclick!(); await settle();
    assert.equal(submit.disabled, false, 'successful reload restores fresh creation');
  }

  await send();
  assert.equal(posts.length, 1);
  const saved = storage.get('agent-office.connected-setup');
  for (const failure of failures) {
    catalog = failure;
    reload.onclick!(); await settle();
    assert.equal(submit.disabled, false, 'pending reconciliation remains available');
    assert.equal(name.disabled, true);
    assert.equal(storage.get('agent-office.connected-setup'), saved);
    await send();
    assert.equal(posts.at(-1), posts[0], 'retry uses original request and scope');
  }
});
