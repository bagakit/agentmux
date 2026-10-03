import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { createServer } from 'node:net'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { inspectNotebook, notebookPageArchiveRoot } from '../src/notebook-catalog.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { AgentMuxNotebookStore, DEFAULT_NOTEBOOK_ID, type NotebookChange } from '../src/notebook-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
const directories: string[] = [], servers: AgentMuxControlServer[] = []
const actor = { kind: 'user', id: 'test-user' } as const
const resource = { hostId: 'local', workspaceId: 'resource', workspacePath: upstreamFixturePath("research"), path: 'original.note.json' }
const source = { sourceId: 'original-web-source', url: 'https://example.test/source', title: 'Original page', recordedAt: 100 }
async function fixture() { const dir=await mkdtemp(join(tmpdir(),'amux-notebook-'));directories.push(dir);return {dir,store:new AgentMuxNotebookStore(join(dir,'notebooks.json'))} }
async function apply(store:AgentMuxNotebookStore, operationId:string,change:NotebookChange) { return store.apply({operationId,expectedRevision:(await store.read()).revision,change},actor) }
afterEach(async()=>{for(const server of servers.splice(0))await server.stop();for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true})})
let cli:string,worker:string
beforeAll(async()=>{
  const output=resolve('.tmp/survey-notebook/core-compiled');await mkdir(output,{recursive:true});await symlink('../../../packages/core/node_modules',join(output,'node_modules'),'dir').catch(e=>{if(e.code!=='EEXIST')throw e})
  cli=join(output,'cli.mjs');worker=join(output,'worker.mjs')
  const bundles=[]
  const relay = JSON.parse(await readFile(resolve('packages/relay/package.json'), 'utf8')) as { exports: Record<string, { import: string }> }
  const alias = Object.fromEntries(Object.entries(relay.exports).map(([key, value]) => [key === '.' ? '@agentmux/relay' : '@agentmux/relay/' + key.slice(2), resolve('packages/relay', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))]))
  bundles.push(await build({entryPoints:['packages/core/src/agentmux.ts'],outfile:cli,bundle:true,platform:'node',format:'esm',packages:'external',alias,metafile:true,logLevel:'silent'}))
  bundles.push(await build({stdin:{contents:`import {AgentMuxNotebookStore} from './packages/core/src/notebook-store.ts';const store=new AgentMuxNotebookStore(process.argv[2]);try{const state=process.argv[3]==='write'?await store.apply(JSON.parse(process.argv[4]),{kind:'user',id:'test-user'}):await store.read();console.log(JSON.stringify({pid:process.pid,state}));}catch(e){console.log(JSON.stringify({pid:process.pid,code:e.code,message:e.message}));process.exitCode=2}`,resolveDir:process.cwd()},outfile:worker,bundle:true,platform:'node',format:'esm',packages:'external',alias,metafile:true,logLevel:'silent'}))
  const hashes:Record<string,string>={};for(const b of bundles)for(const file of Object.keys(b.metafile!.inputs)){if(file==='<stdin>')continue;hashes[file]=createHash('sha256').update(await readFile(file)).digest('hex')}
  await writeFile(join(output,'compiled-inputs.json'),JSON.stringify(hashes,null,2)+'\n')
})
function run(file:string,args:string[],env:NodeJS.ProcessEnv={}) { return new Promise<{code:number;result:any;stderr:string}>((ok,fail)=>{
  const child=spawn(process.execPath,[file,...args],{env:{...process.env,AGENTMUX_AGENT_SESSION_ID:undefined,AGENTMUX_AGENT_CAPABILITY:undefined,AGENTMUX_RPC_ENDPOINT:undefined,...env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.on('error',fail);child.on('close',code=>{try{ok({code:code??-1,result:JSON.parse(stdout.trim() || stderr.trim()),stderr})}catch(e){fail(new Error(stdout+'\n'+stderr,{cause:e}))}})
}) }
describe('durable Notebook directory with no App or open Note',()=>{
  it('keeps 随手记 stable and never creates storage merely to list an empty library',async()=>{
    const {store}=await fixture();expect((await store.read()).notebooks[DEFAULT_NOTEBOOK_ID]?.name).toBe('随手记');expect((await store.read()).revision).toBe(0);await expect(readFile(store.path)).rejects.toMatchObject({code:'ENOENT'})
  })
  it('persists exact Note identity, resource, web source and history in two fresh processes',async()=>{
    const {store}=await fixture();await apply(store,'register',{kind:'register',noteId:'note-original',title:'Reading',resource,source})
    const first=await run(worker,[store.path,'read']),second=await run(worker,[store.path,'read']);expect(first.code,first.stderr).toBe(0);expect(second.code,second.stderr).toBe(0);expect(first.result.pid).not.toBe(second.result.pid);expect(first.result.state).toEqual(second.result.state)
    expect(second.result.state.pages['note-original']).toMatchObject({notebookId:DEFAULT_NOTEBOOK_ID,resource,sources:[source]});expect(second.result.state.trail).toMatchObject([{operationId:'register',action:'created',actor}])
    await writeFile(resolve('.tmp/survey-notebook/core-restart-receipt.json'),JSON.stringify({first:first.result,second:second.result},null,2)+'\n')
  })
  it('does not create a second page or success event after a lost registration response',async()=>{
    const {store}=await fixture(),input={operationId:'original-intent',expectedRevision:0,change:{kind:'register',noteId:'note-original',title:'Reading',resource,source} as const};const first=await store.apply(input,actor);const second=await store.apply(input,actor);expect(second).toEqual(first);expect(Object.keys(second.pages)).toEqual(['note-original']);expect(second.trail).toHaveLength(1)
    await expect(store.apply({...input,change:{...input.change,title:'Another intent'}},actor)).rejects.toMatchObject({code:'NOTEBOOK_INPUT_INVALID'});expect(await store.read()).toEqual(first)
  })
  it('retains corrupted bytes and the previous snapshot rather than recreating an empty library',async()=>{
    const {store}=await fixture();await apply(store,'register',{kind:'register',noteId:'note-original',title:'Reading',resource});const first=await store.read();await apply(store,'rename',{kind:'rename-page',noteId:'note-original',title:'New name'});expect(JSON.parse(await readFile(store.path+'.previous','utf8'))).toEqual(first)
    await writeFile(store.path,'{original broken bytes');await expect(store.read()).rejects.toMatchObject({code:'NOTEBOOK_READ_UNCONFIRMED'});await expect(store.apply({expectedRevision:0,operationId:'overwrite',change:{kind:'create',notebookId:'new',name:'New'}},actor)).rejects.toMatchObject({code:'NOTEBOOK_READ_UNCONFIRMED'});expect(await readFile(store.path,'utf8')).toBe('{original broken bytes')
  })
  it('allows one concurrent writer and preserves the winner when a stale caller retries',async()=>{
    const {store}=await fixture();await apply(store,'register',{kind:'register',noteId:'note-original',title:'Reading',resource});const writes=await Promise.all(['A','B'].map(name=>run(worker,[store.path,'write',JSON.stringify({expectedRevision:1,operationId:name,change:{kind:'rename-page',noteId:'note-original',title:name}})])));expect(writes.map(w=>w.code).sort()).toEqual([0,2]);expect(writes.find(w=>w.code===2)!.result.code).toBe('NOTEBOOK_CONFLICT');expect((await store.read()).trail).toHaveLength(2)
  })
  it('keeps the same pages and original web source while moving a subtree between Notebooks',async()=>{
    const {store}=await fixture();await apply(store,'book',{kind:'create',notebookId:'book',name:'Research'});await apply(store,'parent',{kind:'register',noteId:'parent',title:'Parent',resource,source});await apply(store,'child',{kind:'register',noteId:'child',parentNoteId:'parent',title:'Child',resource:{...resource,path:'child.note.json'}})
    const moved=await apply(store,'move',{kind:'move',noteId:'parent',notebookId:'book',parentNoteId:null});expect(moved.pages.parent!.resource).toEqual(resource);expect(moved.pages.parent!.sources).toEqual([source]);expect(moved.pages.child).toMatchObject({notebookId:'book',parentNoteId:'parent'});expect(moved.trail.filter(e=>e.operationId==='move')).toHaveLength(2)
    await expect(apply(store,'cycle',{kind:'move',noteId:'parent',notebookId:'book',parentNoteId:'child'})).rejects.toMatchObject({code:'NOTEBOOK_INPUT_INVALID'});expect(await store.read()).toEqual(moved)
  })
  it('retains multiple original web sources and never overwrites the old URL for a reused source identity',async()=>{
    const {store}=await fixture();await apply(store,'register',{kind:'register',noteId:'note-original',title:'Reading',resource,source});const next=await apply(store,'source',{kind:'source',noteId:'note-original',source:{...source,sourceId:'second',url:'https://example.test/another'}});expect(next.pages['note-original']!.sources.map(s=>s.url)).toEqual([source.url,'https://example.test/another'])
    await expect(apply(store,'overwrite',{kind:'source',noteId:'note-original',source:{...source,url:'https://example.test/changed'}})).rejects.toMatchObject({code:'NOTEBOOK_INPUT_INVALID'});expect(await store.read()).toEqual(next)
  })
  it('runs actual public CLI/RPC against the original durable catalog without a Desktop',async()=>{
    const {dir,store}=await fixture(),server=new AgentMuxControlServer({socketPath:join(dir,'control.sock'),notebookStore:store,coreClients:()=>[]});servers.push(server);await server.start();const env={AGENTMUX_RPC_ENDPOINT:'unix:'+server.path}
    const listed=await run(cli,['notebook','ls'],env);expect(listed.code,listed.stderr).toBe(0);expect(listed.result.result.state.notebooks[DEFAULT_NOTEBOOK_ID].name).toBe('随手记')
    const created=await run(cli,['notebook','apply','--revision','0','--operation-id','book-actual','--change-json',JSON.stringify({kind:'create',notebookId:'research',name:'Research'})],env);expect(created.code,created.stderr).toBe(0);expect(created.result.result.state.notebooks.research.name).toBe('Research')
    const changed=await run(cli,['notebook','apply','--revision','1','--operation-id','create-actual','--change-json',JSON.stringify({kind:'register',noteId:'note-original',notebookId:'research',title:'Reading',resource,source})],env);expect(changed.code,changed.stderr).toBe(0);expect(changed.result.result.state.pages['note-original'].resource).toEqual(resource)
    const note=await run(cli,['notebook','inspect','--note','note-original'],env);expect(note.code,note.stderr).toBe(0);expect(note.result.result.pages[0].sources).toEqual([source]);expect(note.result.result.trail[0].actor.kind).toBe('user')
    const replay=await run(cli,['notebook','apply','--revision','1','--operation-id','create-actual','--change-json',JSON.stringify({kind:'register',noteId:'note-original',notebookId:'research',title:'Reading',resource,source})],env);expect(replay.code,replay.stderr).toBe(0);expect(replay.result.result.state.trail).toHaveLength(1)
    const inspected=await run(cli,['notebook','inspect','--operation-id','create-actual'],env);expect(inspected.code,inspected.stderr).toBe(0);expect(inspected.result.result.recordedOperation.actor.kind).toBe('user')
  })
  it('rejects a response for a different Note through the actual public RPC client', async () => {
    const { dir, store } = await fixture()
    await apply(store, 'register', { kind: 'register', noteId: 'original', title: 'Original', resource })
    const state = await store.read(), path = join(dir, 'wrong-owner.sock')
    const server = createServer(socket => socket.once('data', bytes => {
      const request = JSON.parse(bytes.toString())
      // A valid catalog with another object's scoped answer must still fail this request.
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: inspectNotebook(state, { noteId: 'original' }) }) + '\n')
    }))
    await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(path, ok) })
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
    try { await expect(client.call('notebook.inspect', { noteId: 'different' })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' }) }
    finally { await client.dispose(); await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok())) }
    expect(await store.read()).toEqual(state)
  })
  it('rejects accidental copied bodies and keeps opaque dictionary IDs independent from object prototypes', async () => {
    const { store } = await fixture()
    await expect(apply(store, 'invalid', { kind: 'register', noteId: 'original', title: 'Original', resource, content: 'duplicate body' } as NotebookChange)).rejects.toMatchObject({ code: 'NOTEBOOK_INPUT_INVALID' })
    const registered = await apply(store, 'constructor', { kind: 'register', noteId: '__proto__', title: 'Original', resource })
    expect(Object.keys(registered.pages)).toEqual(['__proto__'])
    expect(inspectNotebook(registered, { notebookId: 'constructor' }).notebook).toBeNull()
    expect((await store.read()).pages['__proto__']?.resource).toEqual(resource)
  })
  it('refuses an unauthenticated write but keeps read access and the healthy original content',async()=>{
    const {store}=await fixture(),service=new AgentMuxRpcService({notebookStore:store,coreClients:()=>[]});await expect(service.call('notebook.apply',{operationId:'bad-author',expectedRevision:0,change:{kind:'create',notebookId:'book',name:'Book'}})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'});expect((await service.call('notebook.ls',{})).state.pages).toEqual({});await service.dispose()
  })
  it('records only real knowledge changes and keeps source, body references and exact replay after no-op requests', async () => {
    const { store } = await fixture()
    await apply(store, 'register', { kind: 'register', noteId: 'original', title: 'Reading', resource, source })
    await apply(store, 'same-title', { kind: 'rename-page', noteId: 'original', title: 'Reading' })
    await apply(store, 'same-place', { kind: 'move', noteId: 'original', notebookId: DEFAULT_NOTEBOOK_ID, parentNoteId: null })
    const first = await apply(store, 'same-resource', { kind: 'relocate', noteId: 'original', resource })
    expect(first.trail).toHaveLength(1)
    expect(first.pages.original).toMatchObject({ resource, sources: [source] })
    expect(await store.apply({ expectedRevision: 0, operationId: 'same-resource', change: { kind: 'relocate', noteId: 'original', resource } }, actor)).toEqual(first)
  })
  it('organizes and inspects a wiki subtree through the shipping CLI without an App or duplicate success events', async () => {
    const { dir, store } = await fixture(), server = new AgentMuxControlServer({ socketPath: join(dir, 'wiki.sock'), notebookStore: store, coreClients: () => [] })
    servers.push(server); await server.start(); const env = { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }
    async function change(operationId: string, value: NotebookChange) {
      const result = await run(cli, ['notebook', 'apply', '--revision', String((await store.read()).revision), '--operation-id', operationId, '--change-json', JSON.stringify(value)], env)
      expect(result.code, result.stderr).toBe(0); return result.result.result.state
    }
    await change('wiki-book', { kind: 'create', notebookId: 'wiki', name: 'Research wiki' })
    await change('wiki-parent', { kind: 'register', noteId: 'parent', title: 'Question', resource, source })
    await change('wiki-child', { kind: 'register', noteId: 'child', parentNoteId: 'parent', title: 'Evidence', resource: { ...resource, path: 'child.note.json' } })
    await change('wiki-rename', { kind: 'rename-page', noteId: 'parent', title: 'A clearer question' })
    const changed = await change('wiki-move', { kind: 'move', noteId: 'parent', notebookId: 'wiki', parentNoteId: null })
    expect(changed.pages.child).toMatchObject({ notebookId: 'wiki', parentNoteId: 'parent' })
    const exact = await run(cli, ['notebook', 'inspect', '--note', 'parent'], env)
    expect(exact.code, exact.stderr).toBe(0)
    expect(exact.result.result.pages[0]).toMatchObject({ noteId: 'parent', title: 'A clearer question', resource, sources: [source] })
    expect(exact.result.result.trail.map((event: { action: string }) => event.action)).toEqual(['created', 'renamed', 'moved'])
    expect(exact.result.result.trail.every((event: { actor: { kind: string } }) => event.actor.kind === 'user')).toBe(true)
    const replay = await change('wiki-move', { kind: 'move', noteId: 'parent', notebookId: 'wiki', parentNoteId: null })
    expect(replay).toEqual(changed)
    const cycle = await run(cli, ['notebook', 'apply', '--revision', String(changed.revision), '--operation-id', 'bad-cycle', '--change-json', JSON.stringify({ kind: 'move', noteId: 'parent', notebookId: 'wiki', parentNoteId: 'child' })], env)
    expect(cycle.code).not.toBe(0); expect(cycle.result.error.code).toBe('NOTEBOOK_INPUT_INVALID'); expect(await store.read()).toEqual(changed)
    await writeFile(resolve('.tmp/survey-notebook/organization-cli-receipt.json'), JSON.stringify({ state: changed, inspected: exact.result.result, replay: replay, cycleRejected: true }, null, 2) + '\n')
  })

})


it('refuses an obsolete confirmed file-move receipt after another resource relocation and keeps foreign ownership', async () => {
  const {store} = await fixture(), actor = {kind:'user' as const,id:'original-user'}
  const original = {hostId:'remote-host',workspaceId:'remote-workspace',workspacePath:upstreamFixturePath("remote/research"),path:'Original.note.json'}
  let state = await store.read()
  state = await store.apply({expectedRevision:state.revision,operationId:'remote-note',change:{kind:'register',noteId:'remote-note',title:'Original',resource:original}},actor)
  const current = {...original,path:'Current.note.json'}
  state = await store.apply({expectedRevision:state.revision,operationId:'current-location',change:{kind:'relocate',noteId:'remote-note',from:original,resource:current}},actor)
  await expect(store.apply({expectedRevision:state.revision,operationId:'obsolete-location',change:{kind:'relocate',noteId:'remote-note',from:original,resource:{...original,path:'Obsolete.note.json'}}},actor)).rejects.toThrow('resource changed')
  expect(await store.read()).toEqual(state)
  expect(state.pages['remote-note']!.resource).toEqual(current)
})


it('queries confirmed Topic and original resource changes through the shipping headless CLI and replays the same receipt', async () => {
  const {dir,store} = await fixture(), server = new AgentMuxControlServer({socketPath:join(dir,'continuity.sock'),notebookStore:store,coreClients:()=>[]})
  servers.push(server); await server.start()
  const env = {AGENTMUX_RPC_ENDPOINT:'unix:'+server.path}
  async function change(operationId:string,value:NotebookChange) {
    const result = await run(cli,['notebook','apply','--revision',String((await store.read()).revision),'--operation-id',operationId,'--change-json',JSON.stringify(value)],env)
    expect(result.code,result.stderr).toBe(0);return result.result.result.state
  }
  await change('original-file',{kind:'register',noteId:'continuous-note',title:'Research',resource,source})
  await change('confirmed-topic',{kind:'organize',noteId:'continuous-note',topic:{spaceId:'topic-space',topicId:'published'}})
  const relocation:NotebookChange = {kind:'relocate',noteId:'continuous-note',from:resource,resource:{...resource,path:'Findings.note.json'}}
  const state = await change('confirmed-file-move',relocation), replay = await change('confirmed-file-move',relocation)
  expect(replay).toEqual(state)
  const inspected = await run(cli,['notebook','inspect','--note','continuous-note'],env)
  expect(inspected.code,inspected.stderr).toBe(0)
  expect(inspected.result.result.pages[0]).toMatchObject({resource:{...resource,path:'Findings.note.json'},sources:[source],topics:[{spaceId:'topic-space',topicId:'published'}]})
  expect(inspected.result.result.trail.map((event:any)=>event.action)).toEqual(['created','organized','relocated'])
  expect(inspected.result.result.trail.every((event:any)=>event.actor.kind==='user')).toBe(true)
  await writeFile(resolve('.tmp/survey-notebook/continuity-cli-receipt.json'),JSON.stringify({state,replay,inspected:inspected.result.result},null,2)+'\n')
})


it('archives and restores through the shipping CLI, preserves independent children and survives a fresh process without an App', async () => {
  const { dir, store } = await fixture()
  await apply(store, 'parent-created', { kind: 'register', noteId: 'parent', title: 'Question', resource, source })
  await apply(store, 'child-created', { kind: 'register', noteId: 'child', parentNoteId: 'parent', title: 'Evidence', resource: { ...resource, path: 'child.note.json' } })
  const server = new AgentMuxControlServer({ socketPath: join(dir, 'archive.sock'), notebookStore: store, coreClients: () => [] })
  servers.push(server); await server.start()
  const env = { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }
  async function change(operationId: string, value: NotebookChange) {
    const result = await run(cli, ['notebook', 'apply', '--revision', String((await store.read()).revision), '--operation-id', operationId, '--change-json', JSON.stringify(value)], env)
    expect(result.code, result.stderr).toBe(0); return result.result.result.state
  }
  const original = await store.read()
  await change('child-archive', { kind: 'archive', noteId: 'child' })
  const archived = await change('parent-archive', { kind: 'archive', noteId: 'parent' })
  expect(archived.pages.parent.archivedAt).toBeTypeOf('number')
  expect(archived.pages.child.archivedAt).toBeTypeOf('number')
  const replay = await change('parent-archive', { kind: 'archive', noteId: 'parent' })
  expect(replay).toEqual(archived)
  const fresh = await run(worker, [join(dir, 'notebooks.json'), 'read'])
  expect(fresh.code, fresh.stderr).toBe(0); expect(fresh.result.pid).not.toBe(process.pid)
  expect(fresh.result.state).toEqual(archived)
  const observed = await run(cli, ['notebook', 'inspect', '--note', 'parent'], env)
  expect(observed.result.result.pages[0].resource).toEqual(resource)
  expect(observed.result.result.pages[0].sources).toEqual([source])
  expect(observed.result.result.trail.at(-1)).toMatchObject({ action: 'archived', actor: { kind: 'user' }, before: { resource }, after: { archivedAt: archived.pages.parent.archivedAt } })
  let restored = await change('parent-restore', { kind: 'restore', noteId: 'parent' })
  expect(restored.pages.parent.archivedAt).toBeUndefined()
  expect(restored.pages.child.archivedAt).toBe(archived.pages.child.archivedAt)
  expect(notebookPageArchiveRoot(restored.pages, 'child')?.noteId).toBe('child')
  restored = await change('child-restore', { kind: 'restore', noteId: 'child' })
  expect(notebookPageArchiveRoot(restored.pages, 'child')).toBeUndefined()
  expect(restored.pages.child.parentNoteId).toBe('parent')
  expect(restored.pages.parent.resource).toEqual(original.pages.parent!.resource)
  expect(restored.pages.parent.sources).toEqual(original.pages.parent!.sources)
  expect(restored.trail.map((event: { action: string }) => event.action)).toEqual(['created', 'created', 'archived', 'archived', 'restored', 'restored'])
  const missing = await run(cli, ['notebook', 'apply', '--revision', String(restored.revision), '--operation-id', 'missing-page', '--change-json', JSON.stringify({ kind: 'archive', noteId: 'missing' })], env)
  expect(missing.code).not.toBe(0); expect(await store.read()).toEqual(restored)
  await writeFile(resolve('.tmp/survey-notebook/archive-cli-receipt.json'), JSON.stringify({ archived, fresh: fresh.result, inspected: observed.result.result, restored, missing: missing.result }, null, 2) + '\n')
})

it('derives inherited archive without rewriting child metadata and accepts old unarchived catalogs', async () => {
  const { store } = await fixture()
  await apply(store, 'parent', { kind: 'register', noteId: 'parent', title: 'Parent', resource })
  await apply(store, 'child', { kind: 'register', noteId: 'child', title: 'Child', resource: { ...resource, path: 'child.note.json' }, parentNoteId: 'parent' })
  const original = await store.read()
  const archived = await apply(store, 'archive', { kind: 'archive', noteId: 'parent' })
  expect(notebookPageArchiveRoot(archived.pages, 'child')?.noteId).toBe('parent')
  expect(archived.pages.child).toEqual(original.pages.child)
  const childArchived = await apply(store, 'child-independent', { kind: 'archive', noteId: 'child' })
  const restored = await apply(store, 'restore', { kind: 'restore', noteId: 'parent' })
  expect(restored.pages.child).toEqual(childArchived.pages.child)
  expect(notebookPageArchiveRoot(restored.pages, 'child')?.noteId).toBe('child')
  expect(restored.trail.at(-1)?.before?.archivedAt).toBe(archived.pages.parent!.archivedAt)
  expect(restored.trail.at(-1)?.after.archivedAt).toBeUndefined()
})
