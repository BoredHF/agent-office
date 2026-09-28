import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectIssues, validateOrigin, readContract, commandCapability, taskStatuses, taskPriorities } from '../docs/paperclip/contract.ts';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/paperclip/observed.json', import.meta.url), 'utf8'));
const schema = JSON.parse(fs.readFileSync(new URL('./fixtures/paperclip/installed-schema.json', import.meta.url), 'utf8'));
const r = fixture.records;
const sample = r.doneFull.body[0];
const scope = {companyId: sample.companyId, projectId: sample.projectId};
const origin = 'https://paperclip.example.com';
test('observed lists are arrays despite generic OpenAPI object response', () => {
  for (const name of ['agents','projects','all','activity']) assert.ok(Array.isArray(r[name].body));
  assert.equal(schema.paths['/api/companies/{companyId}/issues'].get.responses['200'].content['application/json'].schema.type, 'object');
});
test('installed mutation enums match preserved native states and priorities', () => {
  const p = schema.paths['/api/issues/{id}'].patch.requestBody.content['application/json'].schema.properties;
  assert.deepEqual(new Set(p.status.enum), new Set(taskStatuses));
  assert.deepEqual(p.priority.enum, taskPriorities);
  assert.equal(p.expectedVersion, undefined); // statusVersion is NOT a demonstrated CAS precondition.
});
test('stable completed-record probes demonstrate offset and limit, not a snapshot guarantee', () => {
  assert.deepEqual(r.doneFirst.body, r.doneFull.body.slice(0,1));
  assert.deepEqual(r.doneSecond.body, r.doneFull.body.slice(1,2));
  assert.ok(r.filtered.body.every((x: any) => x.status === 'done'));
  assert.deepEqual(r.empty.body, []);
});
test('valid issue projections and empty lists validate', () => {
  assert.equal(projectIssues(r.doneFull.body,scope).length, r.doneFull.body.length);
  assert.deepEqual(projectIssues([],scope), []);
});
test('foreign company/project records fail closed', () => {
  for (const key of ['companyId','projectId']) assert.throws(()=>projectIssues([{...sample,[key]:'foreign'}],scope));
});
test('malformed envelopes, enums, versions and dates fail closed', () => {
  for (const body of [{items:[]},null,[{...sample,status:'queued'}],[{...sample,statusVersion:-1}],
    [{...sample,statusVersion:1.5}],[{...sample,priority:'urgent'}],[{...sample,updatedAt:'bad'}],[{}]]) assert.throws(()=>projectIssues(body,scope));
});
test('projection omits sensitive unknown fields', () => {
  const projected = projectIssues([{...sample, adapterConfig:{token:'secret'}, env:{password:'secret'}, description:'private'}],scope);
  assert.ok(!JSON.stringify(projected).includes('secret'));
  assert.equal('description' in projected[0], false);
});
test('HTTPS origin allowlist rejects credentials, paths and unapproved origins', () => {
  assert.equal(validateOrigin(origin+'/',[origin]),origin);
  for(const value of ['http://paperclip.example.com',origin+'/api',origin+'?x=1',origin+'#x','https://user:pass@paperclip.example.com','https://evil.example','https://127.0.0.1','invalid']) assert.throws(()=>validateOrigin(value,[origin]));
});
test('authenticated reads forbid redirects and do not expose transport errors', async () => {
  let calls=0;
  const transport = (async (_url: any, options: any) => {calls++;assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer test-secret');throw new Error('secret Location https://evil.example');}) as typeof fetch;
  await assert.rejects(readContract(origin,[origin],'/api/companies/example/issues','test-secret',transport),/^Error: Paperclip read failed$/);
  assert.equal(calls,1);
});
test('redirect HTTP results are rejected without following or echoing the body', async () => {
  for(const status of [301,302,303,307,308,401,403,429,500]) {
    const transport = (async()=>new Response('secret',{status,headers:{Location:'https://evil.example'}})) as typeof fetch;
    await assert.rejects(readContract(origin,[origin],'/api/companies/example/issues','test-secret',transport),new RegExp(`HTTP ${status}$`));
  }
});
test('foreign request paths cannot dispatch credentials', async () => {
  for(const path of ['https://evil.example','//evil.example/api','/api/../x','/api/%2f%2fevil','/api/a\\b']) {
    await assert.rejects(readContract(origin,[origin],path,'test-secret', (async()=>{assert.fail('must not dispatch')}) as typeof fetch));
  }
});
test('capability denial remains per-operation and writes are unverified', () => {
  assert.equal(r.agents.status,200);assert.equal(r.configurations.status,403);
  assert.equal(r.configurations.body.details.reason,'deny_missing_grant');
  assert.equal(r.boardKeys.status,401);assert.equal(r.unauthorized.status,401);
  assert.equal(commandCapability().supported,false);
  assert.ok(schema.paths['/api/agents/{id}/keys'].post);
  assert.ok(schema.paths['/api/agents/{id}/keys/{keyId}'].delete);
  assert.ok(schema.paths['/api/board-api-keys/{keyId}'].delete);
});
