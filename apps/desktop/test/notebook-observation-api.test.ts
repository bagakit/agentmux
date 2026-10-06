import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, type ExecutionHost, type NotebookObservationPort } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import { createNotebookObservationServices, NotebookObservationRequests } from '../src/main/notebook-observation-requests'
import { assertSenderTrusted, senderTrust, type PrivilegedChannel } from '../src/main/ipc-sender-trust'
import { createPreloadNotebookObservation } from '../src/preload/notebook-observation'
import { createRendererNotebookObservation } from '../src/renderer/src/lib/notebook-observation-api'
import { noteContentMatchesGraph, type NotebookObservationPreloadApi } from '../src/shared/notebook-observation'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
const roots:string[] = [], servers:AgentMuxControlServer[] = []
afterEach(async()=>{for(const server of servers.splice(0))await server.stop();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
class Sender extends EventEmitter { destroyed=false; isDestroyed(){return this.destroyed} }
function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve} }
const body=(id:string,extra:import('@tiptap/core').JSONContent[]=[])=>serializeNoteDocument({schema:'agentmux.note.v1',noteId:id,content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:id+'-block'},content:[{type:'text',text:id}]},...extra]}})
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'amx-note-gui-')));roots.push(root)
  const workspace:WorkspaceRecord={id:'notes',hostId:'local',path:root,name:'Notes',kind:'folder'}, files=new WorkspaceFiles(()=>({kind:'local'} as ExecutionHost)),store=new AgentMuxNotebookStore(join(root,'notebooks.json'))
  for(const id of ['target','source']) {
    await writeFile(join(root,id+'.note.md'),body(id,id==='source'?[{type:'blockReference',attrs:{blockId:'ref-block',referenceId:'ref-one',mode:'reference',target:{noteId:'target',blockId:'target-block'}}}]:[]))
    await store.apply({expectedRevision:(await store.read()).revision,operationId:'register-'+id,change:{kind:'register',noteId:id,title:'Original '+id,resource:{hostId:'local',workspaceId:workspace.id,workspacePath:root,path:id+'.note.md'}}},{kind:'user',id:'test-user'})
  }
  const services=createNotebookObservationServices(store,{files,workspace:()=>workspace})
  return {root,workspace,files,store,services}
}
/** The same plain preload transport and Main request owner that production wires to trusted IPC. */
function gui(requests:NotebookObservationRequests,sender=new Sender(),trusted=sender) {
  const calls:{channel:string;args:unknown[]}[]=[]
  const preload=createPreloadNotebookObservation(async(channel,...args)=>{
    calls.push({channel,args:structuredClone(args)})
    assertSenderTrusted(senderTrust(channel as PrivilegedChannel,sender,trusted))
    const data=structuredClone(args[0])
    if(channel==='notebook:graph')return structuredClone(await requests.graph(sender,data))
    if(channel==='notebook:content')return structuredClone(await requests.content(sender,data))
    if(channel==='notebook:cancelObservation'){requests.cancel(sender,data);return}
    throw new Error('Unexpected observation channel')
  })
  return {api:createRendererNotebookObservation(preload),calls,sender}
}

describe('Note graph original owner through Renderer, preload and scoped Main observation',()=>{
  it('uses one original reader for actual GUI and shipping CLI, including closed Note incoming references',async()=>{
    const f=await fixture(),desktop=gui(f.services.requests), server=new AgentMuxControlServer({socketPath:join(f.root,'rpc.sock'),coreClients:()=>[],notebookStore:f.store,notebookObservation:f.services.owner});servers.push(server);await server.start()
    const snapshot=await desktop.api.graph({}),content=await desktop.api.content('target')
    expect(snapshot.catalog.revision).toBe(snapshot.graph.catalogRevision);expect(snapshot.catalog.pages.target!.title).toBe('Original target');expect(snapshot.graph.references).toHaveLength(1)
    expect(snapshot.graph.references[0]).toMatchObject({source:{noteId:'source',blockId:'ref-block'},target:{noteId:'target',blockId:'target-block'},resolution:'resolved'})
    expect(noteContentMatchesGraph(snapshot,content)).toBe(true)
    const env=objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path})
    const cliGraph=await runCompiledObjectCli(['notebook','graph','--all'],env), cliContent=await runCompiledObjectCli(['notebook','inspect','--note','target','--content'],env)
    expect(cliGraph.code,cliGraph.stderr).toBe(0);expect(JSON.parse(cliGraph.stdout).result).toEqual(snapshot.graph)
    expect(cliContent.code,cliContent.stderr).toBe(0);expect(JSON.parse(cliContent.stdout).result.content).toEqual(content)
    expect(desktop.calls.map(c=>c.channel)).toEqual(['notebook:graph','notebook:content']);expect(desktop.calls.every(c=>!('signal' in (c.args[0] as object)))).toBe(true)
    expect(desktop.sender.listenerCount('destroyed')).toBe(0)
  })
  it('binds graph labels and resources to its one captured directory, even while the catalog changes during file reads',async()=>{
    const f=await fixture(),original=f.services.owner.graph.bind(f.services.owner)
    f.services.owner.graph=async(state,params,options)=>{
      await f.store.apply({expectedRevision:state.revision,operationId:'rename-later',change:{kind:'rename-page',noteId:'target',title:'Later title'}},{kind:'user',id:'test-user'})
      return original(state,params,options)
    }
    const snapshot=await gui(f.services.requests).api.graph({})
    expect(snapshot.catalog.pages.target!.title).toBe('Original target');expect(snapshot.catalog.revision).toBe(snapshot.graph.catalogRevision)
    expect((await f.store.read()).pages.target!.title).toBe('Later title');expect((await f.store.read()).revision).toBeGreaterThan(snapshot.catalog.revision)
  })
  it('keeps later, missing, mismatched and unavailable saved bodies out of an earlier card snapshot',async()=>{
    const f=await fixture(),desktop=gui(f.services.requests),snapshot=await desktop.api.graph({})
    await writeFile(join(f.root,'target.note.md'),body('target',[{type:'paragraph',attrs:{blockId:'later-block'},content:[{type:'text',text:'Later saved body'}]}]))
    const later=await desktop.api.content('target');expect(later.status).toBe('read');expect(noteContentMatchesGraph(snapshot,later)).toBe(false)
    if(later.status!=='read')throw new Error('Expected original saved bytes')
    expect(noteContentMatchesGraph(snapshot,{...later,revision:snapshot.graph.observations[0]!.status==='read'?snapshot.graph.observations[0]!.revision:'unexpected',resource:{...later.resource,path:'another.note.md'}})).toBe(false)
    await writeFile(join(f.root,'target.note.md'),body('another-identity'));const mismatch=await desktop.api.content('target');expect(mismatch.status).toBe('identity-mismatch');expect(noteContentMatchesGraph(snapshot,mismatch)).toBe(false)
    await rm(join(f.root,'target.note.md'));expect((await desktop.api.content('target')).status).toBe('missing')
    await mkdir(join(f.root,'target.note.md'));expect((await desktop.api.content('target')).status).toBe('unknown')
    expect((await f.store.read()).pages.target!.resource.path).toBe('target.note.md')
  })
  it('cancels the exact sender/request before another original file is read and restores the Renderer abort reason',async()=>{
    const f=await fixture(),entered=deferred<AbortSignal>(), reason=new Error('Canvas hidden'),reads:string[]=[]
    const services=createNotebookObservationServices(f.store,{workspace:()=>f.workspace,files:{read:async(workspace,path,budget)=>{
      reads.push(path)
      if(reads.length===2){const signal=budget!.signal!;entered.resolve(signal);await new Promise<void>((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})}
      return f.files.read(workspace,path,budget)
    }}})
    const desktop=gui(services.requests),controller=new AbortController(),pending=desktop.api.graph({},{signal:controller.signal});void pending.catch(()=>{});const signal=await entered.promise
    const wire=desktop.calls[0]!.args[0] as {requestId:string}
    try {
      services.requests.cancel(new Sender(),wire.requestId);services.requests.cancel(desktop.sender,'wrong-request');expect(signal.aborted).toBe(false)
      controller.abort(reason);expect(signal.aborted).toBe(true);await expect(pending).rejects.toBe(reason)
      expect(desktop.calls.at(-1)!.channel).toBe('notebook:cancelObservation');expect(desktop.calls.at(-1)!.args).toEqual([wire.requestId]);expect(reads).toEqual(['target.note.md','source.note.md'])
      expect(readNoteDocument(await readFile(join(f.root,'source.note.md'),'utf8'))).toMatchObject({status:'valid',note:{content:{content:expect.arrayContaining([expect.objectContaining({attrs:expect.objectContaining({referenceId:'ref-one'})})])}}});expect((await f.store.read()).pages.source).toBeDefined();expect(desktop.sender.listenerCount('destroyed')).toBe(0)
    }finally{services.requests.dispose();await pending.catch(()=>{})}
    expect((await desktop.api.content('target')).status).toBe('read')
  })
  it('ends a reader on owner navigation/destruction and never cancels a sibling observation',async()=>{
    const state=emptyNotebookState(),signals=new Map<string,AbortSignal>(),entered=deferred<void>()
    const owner:NotebookObservationPort={resolve:vi.fn(),graph:async()=>{throw new Error('No graph requested')},content:async(_state,noteId,options)=>{
      const signal=options!.signal!;signals.set(noteId,signal);if(signals.size===2)entered.resolve()
      await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));throw new Error('Unreachable')
    }}
    const requests=new NotebookObservationRequests({read:async()=>state},owner),a=new Sender(),b=new Sender()
    const first=requests.content(a,{requestId:'same',noteId:'a'}),second=requests.content(b,{requestId:'same',noteId:'b'});const firstResult=first.catch(e=>e),secondResult=second.catch(e=>e)
    await entered.promise;requests.cancel(a,'same');await firstResult;expect(signals.get('b')!.aborted).toBe(false)
    b.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false});expect(signals.get('b')!.aborted).toBe(false)
    b.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});await secondResult;expect(signals.get('b')!.aborted).toBe(true)
    expect(a.listenerCount('did-start-navigation')).toBe(0);expect(b.listenerCount('destroyed')).toBe(0)
    const c=new Sender(),third=requests.content(c,{requestId:'third',noteId:'c'}).catch(e=>e);while(!signals.has('c'))await Promise.resolve();c.emit('destroyed');await third;expect(signals.get('c')!.aborted).toBe(true)
  })
  it('cancels a pending catalog read before invoking the original scanner, and rejects duplicate active request IDs',async()=>{
    const captured=deferred<ReturnType<typeof emptyNotebookState>>(),entered=deferred<void>(),graph=vi.fn()
    const requests=new NotebookObservationRequests({read:()=>{entered.resolve();return captured.promise}},{resolve:vi.fn(),graph,content:vi.fn()}),sender=new Sender()
    const pending=requests.graph(sender,{requestId:'original',params:{}});const result=pending.catch(e=>e);await entered.promise
    await expect(requests.graph(sender,{requestId:'original',params:{}})).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
    requests.cancel(sender,'original');captured.resolve(emptyNotebookState());expect((await result).name).toBe('AbortError');expect(graph).not.toHaveBeenCalled();expect(sender.listenerCount('destroyed')).toBe(0)
  })
  it('refuses untrusted calls before reading and validates malformed or misaddressed replies at the actual Renderer facade',async()=>{
    const f=await fixture(),read=vi.spyOn(f.services.owner,'graph'),untrusted=gui(f.services.requests,new Sender(),new Sender())
    await expect(untrusted.api.graph({})).rejects.toThrow('Untrusted original Note graph observation sender');expect(read).not.toHaveBeenCalled()
    const good=await gui(f.services.requests).api.graph({}),content=await f.services.owner.content(good.catalog,'target')
    const base:NotebookObservationPreloadApi={resolve:vi.fn(),graph:async()=>({...good,graph:{...good.graph,catalogRevision:good.graph.catalogRevision+1}}),content:async()=>({...content,noteId:'different'}),cancelObservation:async()=>{}}
    await expect(createRendererNotebookObservation(base).graph({})).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
    await expect(createRendererNotebookObservation(base).content('target')).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
    f.services.owner.content=async()=>({...content,resource:{...content.resource,path:'another.note.md'}})
    await expect(gui(f.services.requests).api.content('target')).rejects.toMatchObject({code:'CONTROL_PROTOCOL_ERROR'})
    const controller=new AbortController();controller.abort(new Error('Already hidden'));const graph=vi.fn(base.graph);await expect(createRendererNotebookObservation({...base,graph}).graph({},{signal:controller.signal})).rejects.toThrow('Already hidden');expect(graph).not.toHaveBeenCalled()
  })
})
