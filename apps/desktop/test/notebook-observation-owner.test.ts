import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, AgentMuxRpcService, parseNotebookGraph, parseNotebookObservationParams, type ExecutionHost } from '@agentmux/core'
import { inspectNotebook } from '@agentmux/core/notebook-catalog'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { NotebookObservationOwner } from '../src/main/notebook-observation-owner.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { ObjectCliProbe, runCompiledObjectCli, objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
const roots: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const text = (noteId:string,blockId:string,extra:unknown[]=[]) => JSON.stringify({schema:'agentmux.note.v1',noteId,content:{type:'doc',content:[{type:'paragraph',attrs:{blockId},content:[{type:'text',text:noteId}]},...extra]}})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(),'amx-note-graph-'))); roots.push(root)
  const workspace:WorkspaceRecord={id:'notes',hostId:'local',path:root,name:'Notes',kind:'folder'}
  const files = new WorkspaceFiles(() => ({kind:'local'} as ExecutionHost)), store=new AgentMuxNotebookStore(join(root,'notebooks.json'))
  let current:WorkspaceRecord|undefined=workspace
  const owner=new NotebookObservationOwner({workspace:()=>current,files}), resource=(path:string)=>({hostId:'local',workspaceId:'notes',workspacePath:root,path})
  async function add(noteId:string,body:string,path=noteId+'.note.json',parentNoteId:string|null=null) { await writeFile(join(root,path),body); const state=await store.read(); await store.apply({operationId:'register-'+noteId,expectedRevision:state.revision,change:{kind:'register',noteId,title:noteId,resource:resource(path),parentNoteId}},{kind:'user',id:'test'}) }
  await add('target',text('target','target-block'))
  await add('source',text('source','source-block',[{type:'blockReference',attrs:{blockId:'ref-block',referenceId:'ref-one',mode:'embed',target:{noteId:'target',blockId:'target-block'}}}]),undefined,'target')
  return {root,workspace,files,store,owner,add,resource,changeWorkspace:(w:WorkspaceRecord|undefined)=>{current=w}}
}
const run = runCompiledObjectCli

describe('durable Note body and graph public consumer',()=>{
  it('reads closed originals through real Files, service, RPC and actual CLI with incoming source and exact revisions',async()=>{
    const f=await fixture(),server=new AgentMuxControlServer({socketPath:join(f.root,'rpc.sock'),coreClients:()=>[],notebookStore:f.store,notebookObservation:f.owner});servers.push(server);await server.start()
    const env=objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path})
    const inspected=await run(['notebook','inspect','--note','target','--content'],env);expect(inspected.code,inspected.stderr).toBe(0)
    const body=JSON.parse(inspected.stdout).result.content;expect(body).toMatchObject({status:'read',noteId:'target',resource:f.resource('target.note.json'),blockIds:['target-block']});expect(body.content).toBe(await readFile(join(f.root,'target.note.json'),'utf8'))
    const graphed=await run(['notebook','graph','--note','target'],env);expect(graphed.code,graphed.stderr).toBe(0)
    const graph=JSON.parse(graphed.stdout).result;expect(graph.completeness).toBe('complete');expect(graph.observations).toHaveLength(2);expect(graph.observations[0].revision).toBe(body.revision)
    expect(graph.references).toEqual([{source:{noteId:'source',blockId:'ref-block'},sourceResource:f.resource('source.note.json'),target:{noteId:'target',blockId:'target-block'},referenceId:'ref-one',mode:'embed',resolution:'resolved'}]);expect(graph.hierarchy).toEqual([{parentNoteId:'target',noteId:'source'}])
    expect(graph.observations.every((o:any)=>!('content' in o))).toBe(true)
    const all=await run(['notebook','graph','--all'],env);expect(all.code,all.stderr).toBe(0)
    const help=await run(['--skill'],env);expect(help.code,help.stderr).toBe(0);for(const word of ['agentmux.note.v1','notebook graph','file write','canonical content','follow','blockId'])expect(help.stdout).toContain(word)
    expect((await run(['notebook','inspect','--notebook','default','--content'],env)).code).not.toBe(0)
  })
  it('keeps missing, invalid, oversized, unmapped and duplicate originals explicit without manufacturing zero incoming edges',async()=>{
    const f=await fixture();await f.add('duplicate',text('target','duplicate-block'))
    let graph=await f.owner.graph(await f.store.read(),{noteId:'target'});expect(graph.completeness).toBe('partial');expect(graph.duplicateNoteIds).toEqual(['target']);expect(graph.references[0]!.resolution).toBe('ambiguous');expect(graph.observations[2]!.status).toBe('identity-mismatch')
    await rm(join(f.root,'duplicate.note.json'));graph=await f.owner.graph(await f.store.read(),{noteId:'target'});expect(graph.observations[2]!.status).toBe('missing');expect(graph.completeness).toBe('partial')
    await writeFile(join(f.root,'duplicate.note.json'),'{}');graph=await f.owner.graph(await f.store.read(),{});expect(graph.observations[2]!.status).toBe('invalid')
    graph=await f.owner.graph(await f.store.read(),{maxBytes:1});expect(graph.completeness).toBe('unknown');expect(graph.observations.every(o=>o.status==='unknown')).toBe(true)
    f.changeWorkspace({...f.workspace,hostId:'another-host'});graph=await f.owner.graph(await f.store.read(),{});expect(graph.completeness).toBe('unknown');expect(graph.observations.every(o=>o.status==='unknown')).toBe(true)
    expect(()=>parseNotebookGraph({...graph,completeness:'complete'},{})).toThrow();expect(()=>parseNotebookObservationParams({noteId:'target',notebookId:'book'})).toThrow()
  })
  it('keeps external unregistered targets unknown and distinguishes confirmed missing original files',async()=>{
    const f=await fixture()
    await f.add('external-source',text('external-source','outside-block',[{type:'blockReference',attrs:{blockId:'outside-ref',referenceId:'outside',mode:'reference',target:{noteId:'outside-catalog',blockId:'unread-block'}}}]))
    let graph=await f.owner.graph(await f.store.read(),{})
    expect(graph.completeness).toBe('partial');expect(graph.references.find(r=>r.referenceId==='outside')!.resolution).toBe('unknown')
    expect(()=>parseNotebookGraph({...graph,completeness:'complete'},{})).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
    await rm(join(f.root,'target.note.json'));graph=await f.owner.graph(await f.store.read(),{noteId:'target'})
    expect(graph.references.find(r=>r.referenceId==='ref-one')!.resolution).toBe('missing')
  })
  it('never uses a catalog-mismatched body as a source or as a replacement for an unread exact target',async()=>{
    const f=await fixture()
    await writeFile(join(f.root,'target.note.json'),text('source','target-block',[{type:'blockReference',attrs:{blockId:'wrong-ref',referenceId:'wrong-source',mode:'reference',target:{noteId:'source',blockId:'source-block'}}}]))
    await rm(join(f.root,'source.note.json'));await mkdir(join(f.root,'source.note.json'))
    const graph=await f.owner.graph(await f.store.read(),{noteId:'source'})
    expect(graph.observations.map(o=>o.status)).toEqual(['identity-mismatch','unknown'])
    expect(graph.references).toEqual([]);expect(graph.completeness).toBe('unknown')
    await writeFile(join(f.root,'third.note.json'),text('third','third-block',[{type:'blockReference',attrs:{blockId:'third-ref',referenceId:'third-to-source',mode:'reference',target:{noteId:'source',blockId:'target-block'}}}]))
    await f.add('third',await readFile(join(f.root,'third.note.json'),'utf8'))
    const withKnownSource=await f.owner.graph(await f.store.read(),{noteId:'source'})
    expect(withKnownSource.references).toHaveLength(1);expect(withKnownSource.references[0]!.resolution).toBe('unknown')
    expect(withKnownSource.references[0]!.source.noteId).toBe('third')
  })
  it('rejects malformed or misaddressed original-owner replies as protocol failures through the actual CLI client',async()=>{
    const f=await fixture(),state=await f.store.read(),body=await f.owner.content(state,'target'),graph=await f.owner.graph(state,{noteId:'target'})
    const probe=new ObjectCliProbe(request=>request.method==='notebook.inspect'
      ? {...inspectNotebook(state,{noteId:'target'}),content:{...body,resource:f.resource('source.note.json')}}
      : {...graph,observations:graph.observations.map(o=>({...o,status:'unknown',message:'Original read unavailable'}))})
    await probe.start()
    try {
      const env=probe.environment({AGENTMUX_RPC_ENDPOINT:'unix:'+probe.socketPath})
      const wrongBody=await run(['notebook','inspect','--note','target','--content'],env);expect(wrongBody.code).not.toBe(0);expect(wrongBody.stdout+wrongBody.stderr).toContain('CONTROL_PROTOCOL_ERROR')
      const wrongGraph=await run(['notebook','graph','--note','target'],env);expect(wrongGraph.code).not.toBe(0);expect(wrongGraph.stdout+wrongGraph.stderr).toContain('CONTROL_PROTOCOL_ERROR')
    }finally{await probe.stop()}
    expect(()=>parseNotebookGraph({...graph,unexpected:true},{noteId:'target'})).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
  })
  it('directory-only inspect never reads a body; missing Host reader does not remove directory capability',async()=>{
    const f=await fixture();let reads=0
    const service=new AgentMuxRpcService({notebookStore:f.store,coreClients:()=>[],notebookObservation:{content:async(...args)=>{reads++;return f.owner.content(...args)},graph:(...args)=>f.owner.graph(...args)}})
    await service.call('notebook.inspect',{noteId:'target'});expect(reads).toBe(0)
    await service.call('notebook.inspect',{noteId:'target',content:true});expect(reads).toBe(1)
    const headless=new AgentMuxRpcService({notebookStore:f.store,coreClients:()=>[]});await expect(headless.call('notebook.graph',{})).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'});expect((await headless.call('notebook.ls',{})).state.pages.target).toBeDefined()
  })
})
