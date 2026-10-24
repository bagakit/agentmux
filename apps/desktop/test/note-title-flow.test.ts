import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const { build } = createRequire(resolve('packages/core/package.json'))('esbuild')
import { newNoteDocument, serializeNoteDocument } from '../src/shared/note-document.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, type ExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore, AgentMuxNotesStorage, type NotebookWrite } from '@agentmux/core/notebook-store'
import { readNoteMarkdownHeader, rewriteNoteMarkdownTitle } from '@agentmux/core/note-format'
import { noteTitleEventId, type NoteTitlePort } from '@agentmux/core/note-title'
import { NoteTitleFileWriter } from '@agentmux/host/note-title-file-writer'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
const roots:string[]=[],servers:AgentMuxControlServer[]=[],children:ReturnType<typeof spawn>[]=[],fileOwners:WorkspaceFiles[]=[]
afterEach(async()=>{for(const child of children.splice(0))if(child.exitCode===null)child.kill();for(const server of servers.splice(0))await server.stop();for(const files of fileOwners.splice(0))files.dispose();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
const actor={kind:'user' as const,id:'person'}
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'amx-title-')));roots.push(root)
  const workspace:WorkspaceRecord={id:'notes',hostId:'local',path:root,name:'Private Notes',kind:'folder'},resource={hostId:'local',workspaceId:'notes',workspacePath:root,path:'page.note.md'}
  const files=new WorkspaceFiles(()=>({kind:'local'} as ExecutionHost));fileOwners.push(files)
  let titleWriter!:NoteTitleFileWriter,writes=0
  const title:NoteTitlePort={inspect:id=>titleWriter.inspect(id),write:intent=>{writes++;return titleWriter.write(workspace,intent)},current:(id,r)=>titleWriter.current(workspace,id,r)}
  const store=new AgentMuxNotebookStore(join(root,'catalog.json'),undefined,{title});titleWriter=new NoteTitleFileWriter(files,store)
  const body='\r\n# Heading without ID\r\n\r\nPlain [[Readable query]] without an anchor.  \r\n'
  const raw='\uFEFF---\r\nschema: agentmux.note.md.v1\r\nnote-id: "note"\r\ntitle: "A"\r\n---\r\n'+body
  await writeFile(join(root,resource.path),raw)
  await store.apply({expectedRevision:0,operationId:'register',change:{kind:'register',noteId:'note',title:'A',resource}},actor)
  const input={expectedRevision:1,operationId:'rename-B',change:{kind:'rename-page' as const,noteId:'note',title:'B'}}
  return{root,workspace,resource,files,store,titleWriter,input,body,raw,title,writes:()=>writes}
}
async function titleProcessBundle(root:string):Promise<string>{
  const outfile=join(root,'title-owner.mjs')
  await symlink(resolve('apps/desktop/node_modules'),join(root,'node_modules'),'dir')
  const source=`import {AgentMuxNotebookStore} from '@agentmux/core/notebook-store';
import {WorkspaceFiles} from './apps/desktop/src/main/workspace-files.ts';
import {NoteTitleFileWriter} from './apps/desktop/src/main/note-title-file-writer.ts';
const [catalog,workspaceJSON,inputJSON,actorJSON,paused]=process.argv.slice(2),workspace=JSON.parse(workspaceJSON),files=new WorkspaceFiles(()=>({kind:'local'}));
let writer;const store=new AgentMuxNotebookStore(catalog,undefined,{title:{inspect:id=>writer.inspect(id),current:(id,r)=>writer.current(workspace,id,r),write:async intent=>{if(paused==='yes'){process.send({phase:'writing'});await new Promise(ok=>process.once('message',ok));}return writer.write(workspace,intent);}}});writer=new NoteTitleFileWriter(files,store);
process.send({phase:'ready'});await new Promise(ok=>process.once('message',ok));
try{const state=await store.apply(JSON.parse(inputJSON),JSON.parse(actorJSON)),facts=await store.inspectTitleOperation(JSON.parse(inputJSON).operationId);console.log(JSON.stringify({pid:process.pid,state,facts}));}
catch(e){console.log(JSON.stringify({pid:process.pid,code:e.code,message:e.message,facts:await store.inspectTitleOperation(JSON.parse(inputJSON).operationId)}));process.exitCode=2;}
finally{files.dispose();process.disconnect();}`
  await build({stdin:{contents:source,resolveDir:process.cwd()},outfile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',define:{'import.meta.dirname':JSON.stringify(resolve('apps/desktop/src/main'))},banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}})
  return outfile
}
function startTitleProcess(bundle:string,f:Awaited<ReturnType<typeof fixture>>,input:NotebookWrite=f.input,paused=false){
  const child=spawn(process.execPath,[bundle,f.store.path,JSON.stringify(f.workspace),JSON.stringify(input),JSON.stringify(actor),paused?'yes':'no'],{stdio:['ignore','pipe','pipe','ipc']});children.push(child)
  let stdout='',stderr='',ready!:()=>void,attempted!:()=>void
  const started=new Promise<void>(ok=>{ready=ok}),writing=new Promise<void>(ok=>{attempted=ok})
  child.on('message',(message:any)=>{if(message.phase==='ready')ready();if(message.phase==='writing')attempted()})
  child.stdout!.on('data',chunk=>stdout+=chunk);child.stderr!.on('data',chunk=>stderr+=chunk)
  const result=new Promise<{code:number;value:any;stderr:string}>((ok,fail)=>{child.on('error',fail);child.on('close',code=>{try{ok({code:code??-1,value:JSON.parse(stdout),stderr})}catch{fail(Error(stdout+'\n'+stderr))}})})
  return{child,started,writing,result,start:()=>child.send('start'),release:()=>child.connected&&child.send('release')}
}
const titleOf=(raw:string)=>{const header=readNoteMarkdownHeader(raw);if(header.status!=='valid')throw Error(header.message);return header.title}
describe('file title is authoritative through original Notebook apply',()=>{
  it('renames via actual CLI and original file/history owner, keeps unanchored body exact, and exposes typed operation inspection',async()=>{
    const f=await fixture(),server=new AgentMuxControlServer({socketPath:join(f.root,'rpc.sock'),coreClients:()=>[],notebookStore:f.store});servers.push(server);await server.start()
    const env=objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path})
    const written=await runCompiledObjectCli(['notebook','apply','--revision','1','--operation-id','rename-B','--change-json',JSON.stringify(f.input.change)],env)
    expect(written.code,written.stderr).toBe(0);expect(JSON.parse(written.stdout).result.state.pages.note.title).toBe('B')
    const raw=await readFile(join(f.root,f.resource.path),'utf8'),header=readNoteMarkdownHeader(raw)
    expect(header.status).toBe('valid');if(header.status==='valid')expect(header.body).toBe(f.body)
    expect(raw).not.toContain('^');expect(f.writes()).toBe(1)
    const inspected=await runCompiledObjectCli(['notebook','inspect','--operation-id','rename-B'],env)
    expect(inspected.code,inspected.stderr).toBe(0)
    const facts=JSON.parse(inspected.stdout).result.titleOperation
    expect(facts).toMatchObject({operation:{status:'recorded',intent:{operationId:'rename-B',noteId:'note',title:'B'},history:{eventId:noteTitleEventId('rename-B'),status:'committed'}},file:{status:'read',title:'B'},projection:{status:'projected',title:'B'}})
  })
  it('forwards the real headless Host CLI rename and operation inspection to the original Desktop title owner',async()=>{
    const f=await fixture(),desktop=new AgentMuxControlServer({socketPath:join(f.root,'desktop.sock'),coreClients:()=>[],notebookStore:f.store,forwardControl:async()=>{throw Error('A local title owner must never forward again')}})
    servers.push(desktop);await desktop.start()
    const headless=new AgentMuxNotebookStore(join(f.root,'headless.sqlite')),forwarded:{method:string;principal:unknown;responseId:unknown}[]=[]
    const host=new AgentMuxControlServer({socketPath:join(f.root,'host.sock'),coreClients:()=>[],notebookStore:headless,forwardControl:async(method,params,context)=>{
      forwarded.push({method,principal:context.principal,responseId:context.responseId})
      const client=await connectAgentMuxRpc({endpoint:{transport:'unix',path:desktop.path}})
      try{return await client.call(method,params,context.signal?{signal:context.signal}:{})}finally{await client.dispose()}
    }})
    servers.push(host);await host.start();const env=objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+host.path})
    const renamed=await runCompiledObjectCli(['notebook','apply','--revision','1','--operation-id','rename-B','--change-json',JSON.stringify(f.input.change)],env)
    expect(renamed.code,renamed.stderr).toBe(0);expect(JSON.parse(renamed.stdout).result.state.pages.note.title).toBe('B')
    const inspected=await runCompiledObjectCli(['notebook','inspect','--operation-id','rename-B'],env)
    expect(inspected.code,inspected.stderr).toBe(0);expect(JSON.parse(inspected.stdout).result.titleOperation).toMatchObject({operation:{history:{status:'committed'}},file:{title:'B'},projection:{title:'B'}})
    expect(forwarded.map(item=>item.method)).toEqual(['notebook.apply','notebook.inspect']);expect(forwarded.every(item=>item.principal!==undefined&&item.responseId!==undefined)).toBe(true)
    expect((await headless.read()).pages).toEqual({});expect(titleOf(await readFile(join(f.root,f.resource.path),'utf8'))).toBe('B')
  })
  it('keeps a healthy headless operation inspection available when its original Desktop title observation disconnects',async()=>{
    const f=await fixture(),headless=new AgentMuxNotebookStore(f.store.path)
    const forward=vi.fn(async()=>{throw Error('Original Desktop title connection is unavailable')})
    const host=new AgentMuxControlServer({socketPath:join(f.root,'disconnected-host.sock'),coreClients:()=>[],notebookStore:headless,forwardControl:forward})
    servers.push(host);await host.start();const env=objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+host.path})
    const inspected=await runCompiledObjectCli(['notebook','inspect','--operation-id','register'],env)
    expect(inspected.code,inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout).result).toMatchObject({state:{pages:{note:{title:'A'}}},recordedOperation:{actor},
      titleOperation:{operation:{status:'unavailable',operationId:'register',reason:'Original Desktop title connection is unavailable'},file:null,projection:null}})
    const renamed=await runCompiledObjectCli(['notebook','apply','--revision','1','--operation-id','disconnected-rename','--change-json',JSON.stringify(f.input.change)],env)
    expect(renamed.code).not.toBe(0);expect(forward).toHaveBeenCalledTimes(2)
    expect((await headless.read()).pages.note!.title).toBe('A');expect(await readFile(join(f.root,f.resource.path),'utf8')).toBe(f.raw)
  })
  it('after body B commits but catalog publication fails, an old retry only projects later file C and never rewrites B',async()=>{
    const f=await fixture();await rm(f.store.path+'.previous');await mkdir(f.store.path+'.previous')
    await expect(f.store.apply(f.input,actor)).rejects.toBeDefined()
    expect(titleOf(await readFile(join(f.root,f.resource.path),'utf8'))).toBe('B');expect((await f.store.read()).pages.note!.title).toBe('A')
    await rm(f.store.path+'.previous',{recursive:true})
    const later=await f.titleWriter.write(f.workspace,{operationId:'later-C',noteId:'note',resource:f.resource,title:'C',actor})
    expect(later).toMatchObject({status:'recorded',history:{status:'committed'}})
    await f.store.apply({expectedRevision:(await f.store.read()).revision,operationId:'independent-follow',change:{kind:'follow',noteId:'note'}},actor)
    const restarted=new AgentMuxNotebookStore(f.store.path,undefined,{title:f.title})
    const state=await restarted.apply(f.input,actor)
    expect(state.pages.note!.followers).toHaveLength(1);expect(state.pages.note!.title).toBe('C');expect(titleOf(await readFile(join(f.root,f.resource.path),'utf8'))).toBe('C');expect(f.writes()).toBe(1)
    const inspected=await restarted.inspectTitleOperation('rename-B')
    expect(inspected).toMatchObject({operation:{history:{status:'committed'},intent:{title:'B'}},file:{title:'C'},projection:{status:'projected',title:'C'}})
  })
  it('retries a committed original operation after an actual process restart and projects current C',async()=>{
    const f=await fixture();await f.store.apply(f.input,actor)
    await f.titleWriter.write(f.workspace,{operationId:'later-C',noteId:'note',resource:f.resource,title:'C',actor})
    const bundle=await titleProcessBundle(f.root),first=startTitleProcess(bundle,f);await first.started;first.start()
    const one=await first.result;expect(one.code,JSON.stringify(one.value)+one.stderr).toBe(0);expect(one.value.pid).not.toBe(process.pid)
    expect(one.value.state.pages.note.title).toBe('C');expect(one.value.facts).toMatchObject({operation:{intent:{title:'B'},history:{status:'committed'}},file:{title:'C'},projection:{title:'C'}})
    const second=startTitleProcess(bundle,f);await second.started;second.start();const two=await second.result
    expect(two.code,JSON.stringify(two.value)+two.stderr).toBe(0);expect(two.value.pid).not.toBe(one.value.pid);expect(two.value.state).toEqual(one.value.state)
    expect(titleOf(await readFile(join(f.root,f.resource.path),'utf8'))).toBe('C')
  })
  it('serializes two real explicit-path processes across preflight, title write and catalog publication',async()=>{
    const f=await fixture(),bundle=await titleProcessBundle(f.root),a=startTitleProcess(bundle,f,f.input,true),b=startTitleProcess(bundle,f,{...f.input,operationId:'rename-C',change:{...f.input.change,title:'C'}},true)
    await Promise.all([a.started,b.started]);a.start();b.start()
    const first=await Promise.race([a.writing.then(()=>a),b.writing.then(()=>b)]),other=first===a?b:a
    // Both callers are running. A correct lease prevents the other preflight from
    // reaching its writer; without it both preflight the same revision, then write serially.
    let timer:ReturnType<typeof setTimeout>|undefined
    await Promise.race([other.writing,new Promise<void>(ok=>{timer=setTimeout(ok,250)})]);if(timer)clearTimeout(timer)
    first.release();const winner=await first.result;other.release();const loser=await other.result
    expect(winner.code,JSON.stringify(winner.value)+winner.stderr).toBe(0);expect(loser.code,JSON.stringify(loser.value)+loser.stderr).toBe(2);expect(loser.value.code).toBe('NOTEBOOK_CONFLICT')
    expect(winner.value.pid).not.toBe(loser.value.pid)
    const state=await f.store.read();expect(state.revision).toBe(2);expect(state.pages.note!.title).toBe(winner.value.state.pages.note.title)
    expect(titleOf(await readFile(join(f.root,f.resource.path),'utf8'))).toBe(state.pages.note!.title)
  })
  it.each(['archive','same-operation'] as const)('shares the real process lease with %s and preserves exact original replay',async competing=>{
    const f=await fixture(),bundle=await titleProcessBundle(f.root),a=startTitleProcess(bundle,f,f.input,true)
    const input:NotebookWrite=competing==='archive'?{expectedRevision:1,operationId:'archive',change:{kind:'archive',noteId:'note'}}:f.input
    const b=startTitleProcess(bundle,f,input)
    await Promise.all([a.started,b.started]);a.start();await a.writing;b.start()
    let timer:ReturnType<typeof setTimeout>|undefined
    await Promise.race([b.result,new Promise<void>(ok=>{timer=setTimeout(ok,250)})]);if(timer)clearTimeout(timer)
    a.release();const [one,two]=await Promise.all([a.result,b.result])
    expect(one.code,JSON.stringify(one.value)+one.stderr).toBe(0)
    if(competing==='archive'){expect(two.code,JSON.stringify(two.value)+two.stderr).toBe(2);expect(two.value.code).toBe('NOTEBOOK_CONFLICT');expect((await f.store.read()).pages.note!.archivedAt).toBeUndefined()}
    else{expect(two.code,JSON.stringify(two.value)+two.stderr).toBe(0);expect(two.value.state).toEqual(one.value.state);expect((await f.store.readHistory({noteId:'note',resource:f.resource})).entries).toHaveLength(1)}
    expect((await f.store.read()).revision).toBe(2);expect(titleOf(await readFile(join(f.root,f.resource.path),'utf8'))).toBe('B')
  })
  it('reconciles an original title operation through confirmed relocation and rejects a mismatched file reader',async()=>{
    const f=await fixture();await f.store.apply(f.input,actor)
    const destination=await realpath(await mkdtemp(join(tmpdir(),'amx-title-moved-')));roots.push(destination)
    const storage=new AgentMuxNotesStorage(join(f.root,'location.json'),destination)
    await storage.bootstrap({catalogPath:f.store.path,workspace:f.workspace,destinationWorkspaceId:'notes'})
    const workspace={...f.workspace,path:destination},moved={...f.resource,workspacePath:destination}
    let writer!:NoteTitleFileWriter
    const store=new AgentMuxNotebookStore(undefined,storage,{title:{inspect:id=>writer.inspect(id),current:(id,r)=>writer.current(workspace,id,r),write:intent=>writer.write(workspace,intent)}})
    writer=new NoteTitleFileWriter(f.files,store)
    const replay=await writer.write(workspace,{operationId:'rename-B',noteId:'note',resource:moved,title:'B',actor})
    expect(replay,JSON.stringify(replay)).toMatchObject({status:'recorded',resource:moved,history:{status:'committed'}})
    await writer.write(workspace,{operationId:'later-C',noteId:'note',resource:moved,title:'C',actor})
    expect((await store.apply(f.input,actor)).pages.note).toMatchObject({resource:moved,title:'C'})
    const wrong=new NoteTitleFileWriter({write:f.files.write.bind(f.files),read:async(...args)=>{const read=await f.files.read(...args);return read.status==='read'?{...read,document:{...read.document,path:'other.note.md'}}:read}},store)
    expect(await wrong.current(workspace,'note',moved)).toMatchObject({status:'identity-mismatch'})
    expect(await wrong.write(workspace,{operationId:'wrong-reader',noteId:'note',resource:moved,title:'Wrong',actor})).toMatchObject({status:'unavailable'})
    expect(titleOf(await readFile(join(destination,moved.path),'utf8'))).toBe('C')
    expect(await store.readHistoryOperation(noteTitleEventId('wrong-reader'))).toBeUndefined()
  })
  it('keeps original title intent, history and trusted authors through real file move, relocate and old/new/old replay',async()=>{
    const f=await fixture(),writer=new NoteFileWriter(f.files,undefined,f.store)
    const baseline=await writer.read(f.workspace,f.resource.path);if(baseline.status!=='read')throw Error('missing fixture')
    const saved=await writer.write(f.workspace,{path:f.resource.path,content:serializeNoteDocument(newNoteDocument('Original authored body','note','authored-block','A')),expectedRevision:baseline.document.revision},{actor})
    if(saved.status!=='written')throw Error('fixture authored body failed')
    await f.store.apply(f.input,actor)
    const before=await f.store.readHistory({noteId:'note',resource:f.resource}),original=await f.store.readHistoryOperation(noteTitleEventId('rename-B'))
    const moved={...f.resource,path:'moved.note.md'}
    async function move(from:typeof moved,to:typeof moved,operationId:string){
      expect(await f.files.move(f.workspace,f.workspace,{source:{workspaceId:f.workspace.id,path:from.path},destination:{workspaceId:f.workspace.id,path:to.path}})).toEqual({status:'moved'})
      return f.store.apply({expectedRevision:(await f.store.read()).revision,operationId,change:{kind:'relocate',noteId:'note',from,resource:to}},actor)
    }
    await move(f.resource,moved,'move-forward')
    const newHistory=await f.store.readHistory({noteId:'note',resource:moved})
    expect(newHistory.entries.map(entry=>entry.eventId)).toEqual(before.entries.map(entry=>entry.eventId))
    expect((await f.store.readHistory({noteId:'note',resource:f.resource})).entries).toEqual([])
    expect(await writer.read(f.workspace,moved.path)).toMatchObject({status:'read',document:{noteProvenance:{status:'recorded',blocks:{'authored-block':{created:{actor},lastEdited:{actor}}}}}})
    expect(await f.store.inspectTitleOperation('rename-B')).toMatchObject({operation:{resource:moved,intent:{resource:f.resource},history:{status:'committed'}},file:{resource:moved,title:'B'},projection:{resource:moved,title:'B'}})
    await f.titleWriter.write(f.workspace,{operationId:'source-C-after-move',noteId:'note',resource:moved,title:'C',actor})
    expect((await f.store.apply(f.input,actor)).pages.note).toMatchObject({resource:moved,title:'C'})
    await move(moved,f.resource,'move-back')
    const replay=await f.store.apply(f.input,actor)
    expect(replay.pages.note).toMatchObject({resource:f.resource,title:'C'})
    expect((await f.store.readHistory({noteId:'note',resource:moved})).entries).toEqual([])
    const retained=await f.store.readHistoryOperation(noteTitleEventId('rename-B'))
    expect(retained).toMatchObject({resource:f.resource,originalResource:original!.originalResource,sequence:original!.sequence,requestFingerprint:original!.requestFingerprint,content:original!.content,revision:original!.revision})
    expect(await f.store.inspectTitleOperation('rename-B')).toMatchObject({operation:{resource:f.resource,intent:{title:'B',resource:f.resource}},file:{title:'C'},projection:{title:'C'}})
    expect(await writer.read(f.workspace,f.resource.path)).toMatchObject({status:'read',document:{noteProvenance:{status:'recorded',blocks:{'authored-block':{created:{actor},lastEdited:{actor}}}}}})
  })
  it('does not turn prepared/unknown history into committed by comparing the current file bytes',async()=>{
    const f=await fixture(),originalWrite=f.files.write.bind(f.files)
    const uncertain=new NoteTitleFileWriter({read:f.files.read.bind(f.files),write:async(w,input)=>{await originalWrite(w,input);return{status:'unknown',code:'private-lost-response',message:'Unconfirmed'}}},f.store)
    const outcome=await uncertain.write(f.workspace,{operationId:'rename-B',noteId:'note',resource:f.resource,title:'B',actor})
    expect(outcome).toMatchObject({status:'recorded',history:{status:'unconfirmed'}})
    expect(titleOf(await readFile(join(f.root,f.resource.path),'utf8'))).toBe('B')
    await expect(f.store.apply(f.input,actor)).rejects.toMatchObject({code:'NOTE_TITLE_OPERATION_UNCONFIRMED'})
    expect(f.writes()).toBe(0);expect((await f.store.read()).pages.note!.title).toBe('A')
    expect(await f.store.inspectTitleOperation('rename-B')).toMatchObject({operation:{history:{status:'unconfirmed'}},file:{status:'read',title:'B'},projection:{status:'unconfirmed'}})
  })
  it('keeps ordinary file.write written when title projection fails and refreshes catalog from the actual file',async()=>{
    const f=await fixture(),observation=new NotebookObservationOwner({workspace:()=>f.workspace,files:f.files}),writer=new NoteFileWriter(f.files,{state:()=>f.store.read(),owner:observation},f.store)
    const before=await writer.read(f.workspace,f.resource.path);if(before.status!=='read')throw Error('missing fixture')
    const content=rewriteNoteMarkdownTitle(before.document.content,'Source name')
    const result=await writer.write(f.workspace,{path:f.resource.path,content,expectedRevision:before.document.revision},{actor})
    expect(result.status).toBe('written');expect((await f.store.read()).pages.note!.title).toBe('Source name')
    await mkdir(f.store.path+'.previous').catch(async()=>{await rm(f.store.path+'.previous');await mkdir(f.store.path+'.previous')})
    const saved=await writer.read(f.workspace,f.resource.path);if(saved.status!=='read')throw Error('missing fixture')
    const next=await writer.write(f.workspace,{path:f.resource.path,content:rewriteNoteMarkdownTitle(saved.document.content,'Saved despite projection failure'),expectedRevision:saved.document.revision},{actor})
    expect(next).toMatchObject({status:'written',noteTitleProjection:{status:'unconfirmed'}})
    expect(titleOf(await readFile(join(f.root,f.resource.path),'utf8'))).toBe('Saved despite projection failure')
  })
  it('preserves file title C when an older catalog B and a current-revision body draft omit title',async()=>{
    const f=await fixture()
    await f.store.apply(f.input,actor)
    const later=await f.titleWriter.write(f.workspace,{operationId:'source-title-C',noteId:'note',resource:f.resource,title:'C',actor})
    expect(later).toMatchObject({status:'recorded',history:{status:'committed'}})
    expect((await f.store.read()).pages.note!.title).toBe('B')
    const observation=new NotebookObservationOwner({workspace:()=>f.workspace,files:f.files}),writer=new NoteFileWriter(f.files,{state:()=>f.store.read(),owner:observation},f.store)
    const current=await writer.read(f.workspace,f.resource.path);if(current.status!=='read')throw Error('missing fixture')
    const draft=current.document.content.replace(/^title:.*\r?\n/mu,'').replace('Plain [[Readable query]]','Edited body [[Readable query]]')
    expect(readNoteMarkdownHeader(draft)).toMatchObject({status:'valid'});expect(titleOf(draft)).toBeUndefined()
    const saved=await writer.write(f.workspace,{path:f.resource.path,content:draft,expectedRevision:current.document.revision},{actor})
    expect(saved.status).toBe('written')
    const raw=await readFile(join(f.root,f.resource.path),'utf8')
    expect(titleOf(raw)).toBe('C');expect(raw).toContain('Edited body [[Readable query]]')
    expect((await f.store.read()).pages.note!.title).toBe('C')
  })
  it('preserves confirmed block authors through a title-only rename by another actor',async()=>{
    const f=await fixture(),writer=new NoteFileWriter(f.files,undefined,f.store),agent={kind:'agent' as const,id:'editor-agent'}
    const current=await writer.read(f.workspace,f.resource.path);if(current.status!=='read')throw Error('missing fixture')
    const body=(text:string)=>serializeNoteDocument(newNoteDocument(text,'note','stable-block','A'))
    const created=await writer.write(f.workspace,{path:f.resource.path,content:body('Created'),expectedRevision:current.document.revision},{actor})
    if(created.status!=='written')throw Error('fixture create failed')
    const edited=await writer.write(f.workspace,{path:f.resource.path,content:body('Edited'),expectedRevision:created.revision},{actor:agent})
    if(edited.status!=='written')throw Error('fixture edit failed')
    const before=await writer.read(f.workspace,f.resource.path);if(before.status!=='read')throw Error('missing before rename')
    expect(before.document.noteProvenance).toMatchObject({status:'recorded',blocks:{'stable-block':{created:{actor},lastEdited:{actor:agent}}}})
    await f.store.apply({...f.input,expectedRevision:(await f.store.read()).revision}, {kind:'agent',id:'renamer'})
    const after=await writer.read(f.workspace,f.resource.path);if(after.status!=='read')throw Error('missing after rename')
    expect(after.document.noteProvenance).toMatchObject({status:'recorded',blocks:before.document.noteProvenance!.blocks})
    expect(readNoteMarkdownHeader(after.document.content)).toMatchObject({status:'valid',title:'B'})
    const old=readNoteMarkdownHeader(before.document.content),next=readNoteMarkdownHeader(after.document.content)
    if(old.status==='valid'&&next.status==='valid')expect(next.body).toBe(old.body)
  })
  it('refuses title-only catalog mutation without a Host port while keeping original directory actions available',async()=>{
    const f=await fixture(),headless=new AgentMuxNotebookStore(f.store.path)
    await expect(headless.apply(f.input,actor)).rejects.toMatchObject({code:'NOTE_TITLE_UNAVAILABLE'})
    expect((await headless.read()).pages.note!.title).toBe('A');expect(await readFile(join(f.root,f.resource.path),'utf8')).toBe(f.raw)
    const state=await headless.apply({expectedRevision:1,operationId:'follow',change:{kind:'follow',noteId:'note'}},actor);expect(state.pages.note!.followers).toHaveLength(1)
  })
})
