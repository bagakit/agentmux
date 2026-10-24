import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxControlServer, AgentMuxRpcService, fileUploadRevision, parseNoteCorpusParams, parseNoteCorpusResult, type ExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { noteInlineLinkContent } from '@agentmux/client-ui/note/note-wikilinks'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const roots:string[]=[],servers:AgentMuxControlServer[]=[]
afterEach(async()=>{for(const s of servers.splice(0))await s.stop();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
const body=(id:string,title:string,text:string)=>serializeNoteDocument(newNoteDocument(text,id,id+'-block',title))
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'amx-corpus-')));roots.push(root)
  const workspace:WorkspaceRecord={id:'notes',hostId:'local',path:root,name:'Copied files',kind:'folder'}
  const files=new WorkspaceFiles(()=>({kind:'local'} as ExecutionHost)),store=new AgentMuxNotebookStore(join(root,'private-index.json'))
  let current:WorkspaceRecord|undefined=workspace
  const owner=new NotebookObservationOwner({workspace:id=>id===workspace.id?current:undefined,files})
  await mkdir(join(root,'copied'))
  const originals={
    'target.note.md':serializeNoteDocument({schema:'agentmux.note.v1',noteId:'target',title:'Shared title',content:{type:'doc',content:[{type:'heading',attrs:{blockId:'finding',level:2},content:[{type:'text',text:'结论'}]},{type:'paragraph',attrs:{blockId:'evidence'},content:[{type:'text',text:'可靠知识来自原始证据。needle 原文必须可恢复。'}]}]}}),
    'source.note.md':serializeNoteDocument({schema:'agentmux.note.v1',noteId:'source',title:'Research',content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:'source-text'},content:[{type:'text',text:'引用 '},noteInlineLinkContent({referenceId:'to-finding',text:'Shared title #结论',target:{noteId:'target',blockId:'finding'}})]}]}})
  }
  // There is no original App catalog/index in this directory: only original Markdown bytes.
  for(const [path,content] of Object.entries(originals))await writeFile(join(root,'copied',path),content)
  return{root,workspace,files,owner,store,originals,scan:(extra={})=>owner.scan({workspaceId:'notes',path:'copied',...extra}),setWorkspace:(w:WorkspaceRecord|undefined)=>{current=w}}
}

describe('original Markdown corpus public consumer',()=>{
  it('rebuilds nonempty copied files through actual CLI without original index and keeps all bytes/catalog untouched',async()=>{
    const f=await fixture(),before=await f.store.read()
    const server=new AgentMuxControlServer({socketPath:join(f.root,'rpc.sock'),coreClients:()=>[],notebookStore:f.store,notebookObservation:f.owner});servers.push(server);await server.start()
    const result=await runCompiledObjectCli(['notebook','scan','--workspace','notes','--path','copied','--query','needle'],objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path}))
    expect(result.code,result.stderr).toBe(0)
    const corpus=JSON.parse(result.stdout).result
    expect(corpus.scope).toMatchObject({workspaceId:'notes',path:'copied',completeness:'complete',snapshot:'per-file'})
    expect(corpus.pages).toHaveLength(2)
    expect(corpus.pages.find((p:any)=>p.noteId==='target')).toMatchObject({title:'Shared title',blocks:[{blockId:'finding',headingLevel:2,text:'结论'},{blockId:'evidence',text:expect.stringContaining('needle')}]})
    expect(corpus.references).toEqual([expect.objectContaining({source:{noteId:'source',blockId:'source-text'},sourceResource:expect.objectContaining({path:'copied/source.note.md'}),target:{kind:'block',noteId:'target',blockId:'finding'},occurrence:{kind:'stored',referenceId:'to-finding'},resolution:'resolved'})])
    expect(corpus.search.hits).toHaveLength(1)
    expect(corpus.search.hits[0]).toMatchObject({noteId:'target',blockId:'evidence',title:'Shared title',revision:fileUploadRevision(new TextEncoder().encode(f.originals['target.note.md'])),resource:{hostId:'local',workspaceId:'notes',workspacePath:f.root,path:'copied/target.note.md'},excerpt:'可靠知识来自原始证据。needle 原文必须可恢复。'})
    expect(corpus.search.hits[0].excerpt.slice(corpus.search.hits[0].match.from,corpus.search.hits[0].match.to)).toBe('needle')
    expect(await f.store.read()).toEqual(before)
    for(const [path,content]of Object.entries(f.originals))expect(await readFile(join(f.root,'copied',path),'utf8')).toBe(content)
    const help=await runCompiledObjectCli(['notebook','scan','--help'],objectCliEnvironment(f.root));expect(help.stdout).toContain('--max-files')
  })
  it('preserves duplicate titles and exact bound targets, while unbound names remain ambiguous',async()=>{
    const f=await fixture();await writeFile(join(f.root,'copied/other.note.md'),body('other','Shared title','needle second'))
    await writeFile(join(f.root,'copied/query.note.md'),body('query','Query','[[Shared title]]'))
    const result=await f.scan({query:'needle',limit:1})
    expect(result.pages).toHaveLength(4);expect(result.search.total).toBe(2);expect(result.search.hits).toHaveLength(1);expect(result.search.truncated).toBe(true)
    expect(result.references.find(r=>r.source.noteId==='source')!.resolution).toBe('resolved')
    expect(result.references.find(r=>r.source.noteId==='query')).toMatchObject({target:{kind:'unbound',text:'Shared title'},query:'Shared title',resolution:'ambiguous'})
  })
  it('never grants a unique query from an incomplete name or source scope, while keeping its original text',async()=>{
    const f=await fixture()
    await writeFile(join(f.root,'copied/query.note.md'),body('query','Query','[[Shared title]]'))
    await writeFile(join(f.root,'copied/unknown-title.note.md'),serializeNoteDocument(newNoteDocument('legacy title is not carried','legacy','legacy-block')))
    let result=await f.scan()
    expect(result.scope.completeness).toBe('partial')
    expect(result.references.find(r=>r.source.noteId==='query')).toMatchObject({target:{kind:'unbound',text:'Shared title'},resolution:'unknown'})
    // An incomplete title does not undermine a known exact ID if every physical source was read.
    expect(result.references.find(r=>r.source.noteId==='source')!.resolution).toBe('resolved')
    await writeFile(join(f.root,'copied/unknown-title.note.md'),body('legacy','Complete title','legacy'))
    result=await f.scan();expect(result.references.find(r=>r.source.noteId==='query')).toMatchObject({target:{kind:'page',noteId:'target'},resolution:'resolved'})
    const ordered=new NotebookObservationOwner({workspace:()=>f.workspace,files:{read:f.files.read.bind(f.files),readDirectory:async(...args)=>(await f.files.readDirectory(...args)).sort((a,b)=>a.name.localeCompare(b.name))}})
    result=await ordered.scan({workspaceId:'notes',path:'copied',maxFiles:3})
    expect(result.scope.completeness).toBe('partial');expect(result.pages.map(p=>p.noteId)).toEqual(['query','source','target'])
    expect(result.references.find(r=>r.source.noteId==='query')).toMatchObject({target:{kind:'unbound',text:'Shared title'},resolution:'unknown'})
    expect(result.references.find(r=>r.source.noteId==='source')).toMatchObject({target:{kind:'block',noteId:'target',blockId:'finding'},resolution:'unknown'})
    await writeFile(join(f.root,'copied/unknown-title.note.md'),'broken unreadable identity')
    result=await f.scan();expect(result.references.every(r=>r.resolution==='unknown')).toBe(true)
    await writeFile(join(f.root,'copied/known-duplicate-title.note.md'),body('another','Shared title','known second candidate'))
    result=await f.scan();expect(result.references.find(r=>r.source.noteId==='query')!.resolution).toBe('ambiguous')
    expect(result.references.find(r=>r.source.noteId==='source')!.resolution).toBe('unknown')
  })
  it('finds externally added unanchored Markdown through actual CLI without inventing an identity or changing source',async()=>{
    const f=await fixture(),path=join(f.root,'copied/target.note.md')
    const raw=f.originals['target.note.md']+'\nExternal paragraph has unanchored-needle.\n'
    await writeFile(path,raw)
    const server=new AgentMuxControlServer({socketPath:join(f.root,'rpc.sock'),coreClients:()=>[],notebookStore:f.store,notebookObservation:f.owner});servers.push(server);await server.start()
    const result=await runCompiledObjectCli(['notebook','scan','--workspace','notes','--path','copied','--query','unanchored-needle'],objectCliEnvironment(f.root,{AGENTMUX_RPC_ENDPOINT:'unix:'+server.path}))
    expect(result.code,result.stderr).toBe(0)
    const corpus=JSON.parse(result.stdout).result
    expect(corpus.scope.completeness).toBe('partial');expect(corpus.search.hits).toEqual([expect.objectContaining({noteId:'target',blockId:null,revision:fileUploadRevision(new TextEncoder().encode(raw)),resource:expect.objectContaining({path:'copied/target.note.md'}),excerpt:'External paragraph has unanchored-needle.'})])
    expect(corpus.pages.find((p:any)=>p.noteId==='target').unanchoredBlockCount).toBe(1)
    expect(await readFile(path,'utf8')).toBe(raw)
    const forged={...corpus,search:{...corpus.search,hits:corpus.search.hits.map((hit:any)=>({...hit,resource:{...hit.resource,path:'copied/source.note.md'},noteId:'source',title:'Research',revision:corpus.pages.find((p:any)=>p.noteId==='source').revision}))}}
    expect(()=>parseNoteCorpusResult(forged,{workspaceId:'notes',path:'copied',query:'unanchored-needle'})).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
  })
  it('retains duplicate IDs as separate resources and never grants an ambiguous exact target',async()=>{
    const f=await fixture();await writeFile(join(f.root,'copied/duplicate.note.md'),body('target','Other source','needle duplicate'))
    const result=await f.scan({query:'needle'})
    expect(result.scope.completeness).toBe('partial');expect(result.duplicateNoteIds).toEqual(['target']);expect(result.pages.filter(p=>p.noteId==='target')).toHaveLength(2)
    expect(result.references[0]!.resolution).toBe('ambiguous');expect(result.search.hits).toHaveLength(2)
  })
  it('rebuilds source edits with exact fresh revisions and distinguishes missing targets from incomplete scope',async()=>{
    const f=await fixture(),first=await f.scan({query:'needle'}),raw=body('target','Renamed in source','edited source newword')
    await writeFile(join(f.root,'copied/target.note.md'),raw)
    const next=await f.scan({query:'newword'});expect(next.search.hits).toHaveLength(1);expect(next.search.hits[0]!.revision).not.toBe(first.search.hits[0]!.revision);expect(next.pages.find(p=>p.noteId==='target')!.title).toBe('Renamed in source');expect(next.references[0]!.resolution).toBe('missing')
    await rm(join(f.root,'copied/target.note.md'));expect((await f.scan()).references[0]!.resolution).toBe('missing')
    const partial=await f.scan({maxBytes:1});expect(partial.scope.completeness).toBe('unknown');expect(partial.coverage.issues.length).toBeGreaterThan(0);expect(partial.pages).toEqual([])
  })
  it('includes ignored ordinary Markdown, reports symlink boundaries, and never reads outside the exact directory',async()=>{
    const f=await fixture();await writeFile(join(f.root,'.gitignore'),'copied/ignored.note.md\n');await writeFile(join(f.root,'copied/ignored.note.md'),body('ignored','Ignored','needle ignored'))
    await writeFile(join(f.root,'outside.note.md'),body('outside','Outside','needle outside'));await symlink(join(f.root,'outside.note.md'),join(f.root,'copied/link.note.md'))
    const result=await f.scan({query:'needle'});expect(result.pages.map(p=>p.noteId)).toContain('ignored');expect(result.pages.map(p=>p.noteId)).not.toContain('outside');expect(result.scope.completeness).toBe('partial');expect(result.coverage.issues.some(i=>i.kind==='symlink')).toBe(true)
  })
  it('reports bounded scopes and rereads explicitly with a larger budget; does not persist an empty index',async()=>{
    const f=await fixture(),limited=await f.scan({maxFiles:1,query:'needle'})
    expect(limited.coverage.files).toBe(1);expect(limited.coverage.limited).toBe(true);expect(limited.scope.completeness).toBe('partial')
    expect((await f.scan({maxFiles:10})).scope.completeness).toBe('complete')
    await mkdir(join(f.root,'copied/nested'));await writeFile(join(f.root,'copied/nested/nested.note.md'),body('nested','Nested','needle'))
    const dirs=await f.scan({maxDirectories:1});expect(dirs.coverage.directories).toBe(1);expect(dirs.scope.completeness).toBe('partial');expect(dirs.pages).toHaveLength(2)
    expect((await f.scan({maxDirectories:2})).pages).toHaveLength(3)
  })
  it('stops real source reads at this scan budget and leaves unrelated Notes unread',async()=>{
    const f=await fixture(),reads:string[]=[]
    await writeFile(join(f.root,'outside.note.md'),body('outside','Outside','needle'))
    const owner=new NotebookObservationOwner({workspace:()=>f.workspace,files:{readDirectory:f.files.readDirectory.bind(f.files),read:async(...args)=>{reads.push(args[1]);return f.files.read(...args)}}})
    const limited=await owner.scan({workspaceId:'notes',path:'copied',maxFiles:1})
    expect(limited.scope.completeness).toBe('partial');expect(reads).toHaveLength(1);expect(reads[0]).toMatch(/^copied\//u)
    reads.length=0
    const expanded=await owner.scan({workspaceId:'notes',path:'copied',maxBytes:32*1024*1024})
    expect(expanded.scope.completeness).toBe('complete');expect(reads).toHaveLength(2);expect(reads).not.toContain('outside.note.md')
  })
  it('does not fabricate missing title metadata, actors, followers, organization or history',async()=>{
    const f=await fixture();await writeFile(join(f.root,'copied/legacy.note.md'),serializeNoteDocument(newNoteDocument('original','old','old-block')))
    const result=await f.scan();expect(result.scope.completeness).toBe('partial');expect(result.pages.find(p=>p.noteId==='old')!.title).toBeNull()
    expect(await f.store.read()).toEqual(emptyNotebookState())
    for(const p of result.pages)for(const field of ['followers','history','notebookId','actor'])expect(p).not.toHaveProperty(field)
  })
  it('keeps an acknowledged organized/followed catalog and original metadata byte-for-byte while scanning unrelated copied files',async()=>{
    const f=await fixture(),actor={kind:'user' as const,id:'person'}
    let state=await f.store.read()
    state=await f.store.apply({expectedRevision:state.revision,operationId:'register-retained',change:{kind:'register',noteId:'retained',title:'Retained catalog page',resource:{hostId:'local',workspaceId:'notes',workspacePath:f.root,path:'original.note.md'}}},actor)
    state=await f.store.apply({expectedRevision:state.revision,operationId:'follow-retained',change:{kind:'follow',noteId:'retained'}},actor)
    const before=await f.store.read(),scanned=await f.scan({query:'needle'})
    expect(scanned.pages).toHaveLength(2);expect(scanned.pages.some(page=>page.noteId==='retained')).toBe(false)
    expect(await f.store.read()).toEqual(before)
    expect(before.pages.retained!.followers).toEqual([expect.objectContaining({actor})])
  })
  it('does not claim a missing identity when an unreadable or malformed source could contain it',async()=>{
    const f=await fixture();await writeFile(join(f.root,'copied/target.note.md'),'---\nschema: broken\n---\noriginal damaged bytes')
    const result=await f.scan();expect(result.scope.completeness).toBe('partial');expect(result.coverage.issues.some(i=>i.kind==='invalid')).toBe(true)
    expect(result.references[0]!.resolution).toBe('unknown');expect(await readFile(join(f.root,'copied/target.note.md'),'utf8')).toContain('original damaged bytes')
  })
  it('uses the same header codec, preserves title through body edits, and rejects malformed title without touching bytes',()=>{
    const raw=body('stable','A readable title: 知识','continuous document'),read=readNoteDocument(raw);expect(read.status).toBe('valid')
    if(read.status==='valid'){expect(read.note.title).toBe('A readable title: 知识');expect(serializeNoteDocument({...read.note,content:newNoteDocument('new body','stable','stable-block').content})).toContain('title: "A readable title: 知识"')}
    expect(readNoteDocument(raw.replace('title: "A readable title: 知识"','title: [bad]')).status).toBe('invalid')
  })
  it('cancels a pending original directory read promptly and starts no later file read',async()=>{
    const f=await fixture(),controller=new AbortController();let release!:(value:[])=>void,started!:()=>void,reads=0
    const opened=new Promise<void>(resolve=>{started=resolve})
    const owner=new NotebookObservationOwner({workspace:()=>f.workspace,files:{read:async()=>{reads++;throw Error('must not read')},readDirectory:()=>new Promise(resolve=>{release=resolve;started()})}})
    const service=new AgentMuxRpcService({coreClients:()=>[],notebookStore:f.store,notebookObservation:owner})
    const result=service.call('notebook.scan',{workspaceId:'notes',path:'copied'},{signal:controller.signal});await opened;controller.abort(new DOMException('cancel this observation','AbortError'))
    await expect(result).rejects.toMatchObject({name:'AbortError'});release([]);expect(reads).toBe(0);expect(await f.store.read()).toEqual(emptyNotebookState())
  })
  it('keeps unmapped/read-failed/malformed scopes unknown or partial and validates exact result identities',async()=>{
    const f=await fixture(),good=await f.scan({query:'needle'})
    expect(()=>parseNoteCorpusResult({...good,scope:{...good.scope,path:'elsewhere'}},{workspaceId:'notes',path:'copied',query:'needle'})).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
    expect(()=>parseNoteCorpusResult({...good,search:{...good.search,hits:good.search.hits.map(h=>({...h,revision:'wrong'}))}},{workspaceId:'notes',path:'copied',query:'needle'})).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
    const params={workspaceId:'notes',path:'copied',query:'needle'}
    for(const completeness of [['complete'],{toString:()=> 'complete'},true])expect(()=>parseNoteCorpusResult({...good,scope:{...good.scope,completeness}},params)).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
    for(const kind of [['mapping'],{toString:()=> 'mapping'},true])expect(()=>parseNoteCorpusResult({...good,coverage:{...good.coverage,issues:[{path:'copied',kind,message:'unconfirmed'}]}},params)).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
    for(const mode of [['link'],{toString:()=> 'link'},true])expect(()=>parseNoteCorpusResult({...good,references:good.references.map(ref=>({...ref,mode}))},params)).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
    for(const resolution of [['resolved'],{toString:()=> 'resolved'},true])expect(()=>parseNoteCorpusResult({...good,references:good.references.map(ref=>({...ref,resolution}))},params)).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
    expect(()=>parseNoteCorpusResult({...good,pages:good.pages.map(page=>({...page,revision:'not-a-digest'}))},params)).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
    f.setWorkspace(undefined);expect((await f.scan()).scope.completeness).toBe('unknown')
    expect(()=>parseNoteCorpusParams({workspaceId:'notes',path:'../other'})).toThrow();expect(()=>parseNoteCorpusParams({workspaceId:'notes',path:'copied',actor:{kind:'agent',id:'forged'}})).toThrow()
    const service=new AgentMuxRpcService({coreClients:()=>[],notebookStore:f.store});await expect(service.call('notebook.scan',{workspaceId:'notes',path:'copied'})).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'});expect((await service.call('notebook.ls',{})).state.pages).toEqual({})
  })
})
