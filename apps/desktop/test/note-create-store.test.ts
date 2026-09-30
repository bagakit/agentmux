import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout, findGroup, moveTabToNewGroup } from '@agentmux/layout'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { readNoteDocument, newNoteDocument } from '../src/shared/note-document'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import type { WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab, addWorkbenchRegion, initialWorkbenchRegionId, documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs'
const initial=useAppStore.getState(), roots:string[]=[]
const config:AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Local'}],executors:{},workspaces:[{id:'r',name:'R',hostId:'local',path:'/resource',kind:'folder'},{id:'d',name:'D',hostId:'local',path:'/display',kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
function fixture(){
  useLauncherState.setState({drafts:{}})
  const tab=createWorkbenchTab('launcher',{regionId:'launcher-region',kind:'launcher',workspaceId:'r'})
  useAppStore.setState({config,activeWorkspaceId:'r',tabs:{[tab.id]:tab},layouts:{r:createWorkspaceLayout('g',[tab.id]),d:createWorkspaceLayout('other')},documents:{},spaceZoneBindings:{},workspaceFileRevisions:{}})
  return{tabId:tab.id,regionId:'launcher-region'}
}
afterEach(async()=>{vi.restoreAllMocks();useAppStore.setState(initial,true);useLauncherState.setState({drafts:{}});await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})))})
describe('original Store Note intent',()=>{
  it('keeps IDs and draft stable across a confirmed collision',async()=>{
    const launcher=fixture(), bodies:string[]=[], paths:string[]=[]
    vi.spyOn(api.files,'write').mockImplementation(async(_workspace,input)=>{bodies.push(input.content);paths.push(input.path);return paths.length===1?{status:'conflict',observedRevision:'occupied'}:{status:'written',revision:'created'}})
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const receipt=await useAppStore.getState().createNote('g',launcher,'a thought')
    expect(receipt.status).toBe('written');expect(receipt.revealed).toBe(true)
    expect(paths).toHaveLength(2);expect(bodies).toEqual([bodies[0],bodies[0]])
    const parsed=readNoteDocument(bodies[0]!);expect(parsed.status).toBe('valid')
    if(parsed.status==='valid'){expect(parsed.note.noteId).toBe(receipt.noteId);expect(parsed.note.content.content?.[0]?.attrs?.blockId).toBe(receipt.blockIds[0])}
    expect(open.mock.calls).toHaveLength(1);expect(receipt.path).toMatch(/-2\.note\.json$/)
  })
  it('retains a typed permission result and does not reveal or replay',async()=>{
    const launcher=fixture(), write=vi.spyOn(api.files,'write').mockResolvedValue({status:'error',code:'EACCES',message:'permission denied'})
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const receipt=await useAppStore.getState().createNote('g',launcher,'keep me')
    expect(receipt.status).toBe('error');expect(receipt.write).toEqual({status:'error',code:'EACCES',message:'permission denied'});expect(receipt.draft).toBe('keep me')
    expect(await useAppStore.getState().createNote('g',launcher,'later input')).toEqual(receipt)
    expect(write).toHaveBeenCalledTimes(1);expect(open).not.toHaveBeenCalled()
  })
  it('retries a known write-before-publication error only on explicit action, keeping the same intent',async()=>{
    const launcher=fixture(), bodies:string[]=[], paths:string[]=[]
    const write=vi.spyOn(api.files,'write').mockImplementation(async(_workspace,input)=>{bodies.push(input.content);paths.push(input.path);return{status:'error',code:'EACCES',message:'permission'}})
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const original=await useAppStore.getState().createNote('g',launcher,'original draft')
    write.mockImplementation(async(_workspace,input)=>{bodies.push(input.content);paths.push(input.path);return{status:'written',revision:'restored'}})
    expect(await useAppStore.getState().createNote('g',launcher,'later edit')).toEqual(original)
    expect(write).toHaveBeenCalledTimes(1)
    const retried=await useAppStore.getState().retryCreatedNote('region:launcher-region')
    expect(retried).toMatchObject({intentId:original.intentId,noteId:original.noteId,blockIds:original.blockIds,draft:'original draft',target:original.target,status:'written',revealed:true})
    expect(paths).toEqual([original.path,original.path]);expect(bodies).toEqual([bodies[0],bodies[0]]);expect(write).toHaveBeenCalledTimes(2)
  })
  it('captures one intent before asynchronous discovery and forbids a second creation',async()=>{
    const launcher=fixture();useAppStore.setState({config:{...config,workspaces:[...config.workspaces,{id:'__scratch__',name:'Scratch',hostId:'local',path:'/scratch',kind:'folder'}]}})
    let resolve!:()=>void;const wait=new Promise<void>(yes=>{resolve=yes})
    vi.spyOn(api.scratch,'listTopics').mockImplementation(async()=>{await wait;return[]})
    const write=vi.spyOn(api.files,'write').mockResolvedValue({status:'written',revision:'created'});useAppStore.setState({openFile:vi.fn(async()=>true)})
    const first=useAppStore.getState().createNote('g',launcher,'first')
    const second=await useAppStore.getState().createNote('g',launcher,'second')
    expect(second.status).toBe('pending');expect(second.draft).toBe('first');expect(write).not.toHaveBeenCalled()
    resolve();const result=await first;expect(result.intentId).toBe(second.intentId);expect(result.noteId).toBe(second.noteId);expect(write).toHaveBeenCalledTimes(1)
  })
  it('reconciles the same unknown target and never writes a second Note',async()=>{
    const launcher=fixture();let content=''
    const write=vi.spyOn(api.files,'write').mockImplementation(async(_workspace,input)=>{content=input.content;throw new Error('IPC receipt missing')})
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const receipt=await useAppStore.getState().createNote('g',launcher,'original')
    expect(receipt.status).toBe('unknown');expect(receipt.write?.status).toBe('unknown');expect(open).not.toHaveBeenCalled()
    const read=vi.spyOn(api.files,'read').mockResolvedValue({status:'read',document:{path:receipt.path,content,revision:'recovered'}})
    const recovered=await useAppStore.getState().revealCreatedNote('region:launcher-region')
    expect(recovered?.noteId).toBe(receipt.noteId);expect(recovered?.path).toBe(receipt.path);expect(recovered?.revealed).toBe(true)
    expect(read).toHaveBeenCalledWith('r',receipt.path);expect(write).toHaveBeenCalledTimes(1)
  })
  it.each(['Tab','Group','Region'] as const)('preserves a later %s in the same Space during recovery read',async choice=>{
    const launcher=fixture(), state=useAppStore.getState()
    let tab=addWorkbenchRegion(state.tabs.launcher!,'launcher-region','right',{kind:'launcher',regionId:'another-region',workspaceId:'r'})
    tab={...tab,layout:{...tab.layout,activeRegionId:'launcher-region'}}
    const other=createWorkbenchTab('other-launcher',{kind:'launcher',regionId:'other-region',workspaceId:'r'})
    let layout=createWorkspaceLayout('g',[tab.id,other.id])
    if(choice==='Group')layout={...moveTabToNewGroup(layout,other.id,'g','g','right','second-group'),activeGroupId:'g'}
    useAppStore.setState({tabs:{launcher:tab,[other.id]:other},layouts:{...state.layouts,r:layout}})
    let content='';vi.spyOn(api.files,'write').mockImplementation(async(_workspace,input)=>{content=input.content;throw new Error('transport')})
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const created=await useAppStore.getState().createNote('g',launcher,'same draft')
    let release!:()=>void;const wait=new Promise<void>(yes=>{release=yes})
    vi.spyOn(api.files,'read').mockImplementation(async()=>{await wait;return{status:'read',document:{path:created.path,content,revision:'confirmed'}}})
    const before=[useAppStore.getState().layouts.r!.activeGroupId,findGroup(useAppStore.getState().layouts.r!,'g')!.activeTabId,useAppStore.getState().tabs.launcher!.layout.activeRegionId]
    const recovering=useAppStore.getState().revealCreatedNote('region:launcher-region')
    if(choice==='Tab')useAppStore.getState().activateTab('r','g',other.id)
    if(choice==='Group')useAppStore.getState().focusTabGroup('r','second-group')
    if(choice==='Region')useAppStore.getState().focusRegion('r',tab.id,'another-region')
    expect([useAppStore.getState().layouts.r!.activeGroupId,findGroup(useAppStore.getState().layouts.r!,'g')!.activeTabId,useAppStore.getState().tabs.launcher!.layout.activeRegionId]).not.toEqual(before)
    const selected=useAppStore.getState().layouts.r, focused=useAppStore.getState().tabs.launcher!.layout.activeRegionId
    release();const result=await recovering
    expect(result).toMatchObject({status:'written',revealed:false,noteId:created.noteId,draft:'same draft',path:created.path})
    expect(open).not.toHaveBeenCalled();expect(useAppStore.getState().layouts.r).toEqual(selected);expect(useAppStore.getState().tabs.launcher!.layout.activeRegionId).toBe(focused)
  })
  it('does not open a different Note found at an unknown candidate',async()=>{
    const launcher=fixture();vi.spyOn(api.files,'write').mockRejectedValue(new Error('transport'));const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const receipt=await useAppStore.getState().createNote('g',launcher,'draft')
    vi.spyOn(api.files,'read').mockResolvedValue({status:'read',document:{path:receipt.path,content:'{"schema":"agentmux.note.v1","noteId":"another","content":{"type":"doc","content":[{"type":"paragraph","attrs":{"blockId":"another-block"}}]}}',revision:'other'}})
    const result=await useAppStore.getState().revealCreatedNote('region:launcher-region')
    expect(result?.status).toBe('unknown');expect(result?.noteId).toBe(receipt.noteId);expect(result?.draft).toBe('draft');expect(open).not.toHaveBeenCalled()
  })
  it('never checks an unknown Note in a changed resource with the same Workspace ID',async()=>{
    const launcher=fixture();vi.spyOn(api.files,'write').mockRejectedValue(new Error('receipt missing'))
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const receipt=await useAppStore.getState().createNote('g',launcher,'original draft')
    const read=vi.spyOn(api.files,'read').mockResolvedValue({status:'deleted'})
    useAppStore.setState({config:{...config,workspaces:config.workspaces.map(workspace=>workspace.id==='r'?{...workspace,path:'/different'}:workspace)}})
    const result=await useAppStore.getState().revealCreatedNote('region:launcher-region')
    expect(result).toMatchObject({status:'unknown',noteId:receipt.noteId,path:receipt.path,draft:'original draft',target:{workspaceId:'r',workspacePath:'/resource'}})
    expect(read).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();expect(result?.issue).toContain('original Note resource')
  })
  it('retains the original Note when its resource changes while its receipt is being checked',async()=>{
    const launcher=fixture();let content=''
    vi.spyOn(api.files,'write').mockImplementation(async(_workspace,input)=>{content=input.content;throw new Error('transport')})
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const receipt=await useAppStore.getState().createNote('g',launcher,'original draft')
    let resolve!:()=>void;const wait=new Promise<void>(yes=>{resolve=yes})
    const read=vi.spyOn(api.files,'read').mockImplementation(async()=>{await wait;return{status:'read',document:{path:receipt.path,content,revision:'read'}}})
    const checking=useAppStore.getState().revealCreatedNote('region:launcher-region')
    useAppStore.setState({config:{...config,workspaces:config.workspaces.map(workspace=>workspace.id==='r'?{...workspace,hostId:'changed-host'}:workspace)}})
    resolve();const result=await checking
    expect(read).toHaveBeenCalledTimes(1);expect(open).not.toHaveBeenCalled()
    expect(result).toMatchObject({status:'unknown',noteId:receipt.noteId,draft:'original draft',path:receipt.path,target:{hostId:'local',workspacePath:'/resource'}})
    expect(result?.issue).toContain('changed while checking')
  })
  it('does not advance a collision candidate after the resource changes during the first write',async()=>{
    const launcher=fixture();let resolve!:()=>void;const wait=new Promise<void>(yes=>{resolve=yes})
    const write=vi.spyOn(api.files,'write').mockImplementation(async()=>{await wait;return{status:'conflict',observedRevision:'other'}})
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const creating=useAppStore.getState().createNote('g',launcher,'captured draft')
    useAppStore.setState({config:{...config,workspaces:config.workspaces.map(workspace=>workspace.id==='r'?{...workspace,path:'/different'}:workspace)}})
    resolve();const result=await creating
    expect(write).toHaveBeenCalledTimes(1);expect(open).not.toHaveBeenCalled()
    expect(result.status).toBe('error');expect(result.write).toMatchObject({code:'NOTE_RESOURCE_CHANGED'})
    expect(result.path).not.toMatch(/-2\.note\.json$/);expect(result.draft).toBe('captured draft');expect(result.target.workspacePath).toBe('/resource')
  })
  it('preserves later navigation and the written result instead of stealing focus',async()=>{
    const launcher=fixture();let resolve!:()=>void;const wait=new Promise<void>(yes=>{resolve=yes})
    vi.spyOn(api.files,'write').mockImplementation(async()=>{await wait;return{status:'written',revision:'written'}})
    const open=vi.fn(async()=>true);useAppStore.setState({openFile:open})
    const creating=useAppStore.getState().createNote('g',launcher,'draft');useAppStore.setState({activeWorkspaceId:'d'});resolve()
    const receipt=await creating;expect(receipt.status).toBe('written');expect(receipt.target.workspaceId).toBe('r');expect(receipt.revealed).toBe(false);expect(open).not.toHaveBeenCalled();expect(useAppStore.getState().activeWorkspaceId).toBe('d')
  })
  it('preserves a later original openFile intent while its read is still pending',async()=>{
    const launcher=fixture(), before=useAppStore.getState().layouts.r
    let content='',releaseWrite!:()=>void,releaseLater!:()=>void
    const writeWait=new Promise<void>(yes=>{releaseWrite=yes}),laterWait=new Promise<void>(yes=>{releaseLater=yes})
    const write=vi.spyOn(api.files,'write').mockImplementation(async(_workspace,input)=>{content=input.content;await writeWait;return{status:'written',revision:'created'}})
    const read=vi.spyOn(api.files,'read').mockImplementation(async(_workspace,path)=>{
      if(path==='later.txt'){await laterWait;return{status:'read',document:{path,content:'later request',revision:'later'}}}
      return{status:'read',document:{path,content,revision:'created'}}
    })
    vi.spyOn(api.files,'observe').mockResolvedValue(undefined);vi.spyOn(api.files,'unobserve').mockResolvedValue(undefined)
    const creating=useAppStore.getState().createNote('g',launcher,'keep original')
    await vi.waitFor(()=>expect(write).toHaveBeenCalledTimes(1))
    const later=useAppStore.getState().openFile('later.txt','g',undefined,'r')
    await vi.waitFor(()=>expect(read).toHaveBeenCalledWith('r','later.txt'))
    expect(useAppStore.getState().layouts.r).toEqual(before)
    releaseWrite();const receipt=await creating
    releaseLater();const laterOpened=await later
    expect(receipt).toMatchObject({status:'written',revealed:false,draft:'keep original'})
    expect(read.mock.calls.map(call=>call[1])).toEqual(['later.txt'])
    expect(laterOpened).toBe(true);expect(findGroup(useAppStore.getState().layouts.r!,'g')?.activeTabId).toBe(fileTabId('r','later.txt'))
    expect(write).toHaveBeenCalledTimes(1)
  })
  it('keeps a written Note after reveal failure and retries only that display',async()=>{
    const launcher=fixture(), write=vi.spyOn(api.files,'write').mockResolvedValue({status:'written',revision:'written'})
    const open=vi.fn(async()=>false);useAppStore.setState({openFile:open})
    const receipt=await useAppStore.getState().createNote('g',launcher,'draft');expect(receipt.status).toBe('written');expect(receipt.revealed).toBe(false)
    expect(await useAppStore.getState().createNote('g',launcher,'later')).toEqual(receipt)
    open.mockResolvedValue(true);const recovered=await useAppStore.getState().revealCreatedNote('region:launcher-region')
    expect(recovered?.path).toBe(receipt.path);expect(recovered?.revealed).toBe(true);expect(write).toHaveBeenCalledTimes(1);expect(open).toHaveBeenCalledTimes(2)
  })
  it.each([true,false])('reveals the original second File Region without a canonical Tab (projection=%s)',async projected=>{
    fixture()
    const sourceSpace=directoryIdentity('local','/resource'),reference={displayWorkspaceId:'d',groupId:'display-g',tabId:'mixed-original',regionId:'source-file'}
    let tab=createWorkbenchTab(reference.tabId,{kind:'launcher',regionId:'first-launcher',workspaceId:'r'})
    tab=addWorkbenchRegion(tab,'first-launcher','right',{kind:'file',regionId:reference.regionId,workspaceId:'r',path:'a.note.json'})
    tab={...tab,space:{spaceId:sourceSpace,zoneId:'source-zone'},layout:{...tab.layout,activeRegionId:'first-launcher'}}
    const resourceLayout=createWorkspaceLayout('resource'),displayLayout=createWorkspaceLayout('display-g',[tab.id])
    useAppStore.setState({tabs:{[tab.id]:tab},layouts:{r:resourceLayout,d:displayLayout},spaceZoneBindings:{'source-zone':{workspaceId:'r',spaceId:sourceSpace,relations:{}}}})
    const content=JSON.stringify(newNoteDocument('source text','source-note','source-block')),onSelect=vi.fn()
    const projection:WorkbenchProjection={entity:{kind:'zone',zoneId:'source-zone'},presentationId:'survey-workbench',displayWorkspaceId:'d',catalog:spatialCatalog(useAppStore.getState(),[]),selection:[{...reference,regionId:'first-launcher'}],onSelect}
    const read=vi.spyOn(api.files,'read').mockResolvedValue({status:'read',document:{path:'a.note.json',content,revision:'source'}})
    vi.spyOn(api.files,'observe').mockResolvedValue(undefined);vi.spyOn(api.files,'unobserve').mockResolvedValue(undefined)
    const before=useAppStore.getState(),location={line:1,noteBlock:{noteId:'source-note',blockId:'source-block'}}
    const opened=await useAppStore.getState().openFile('a.note.json','display-g',location,'r',undefined,{displayWorkspaceId:'d',space:tab.space!,resource:{hostId:'local',path:'/resource'},reference,...(projected?{projection}:{})})
    const after=useAppStore.getState()
    expect(opened).toBe(true);expect(read).toHaveBeenCalledWith('r','a.note.json')
    expect(Object.keys(after.tabs)).toEqual([tab.id]);expect(after.tabs[fileTabId('r','a.note.json')]).toBeUndefined()
    expect(after.documents[documentKey('r','a.note.json')]?.content).toBe(content);expect(after.documentRevealTargets[documentKey('r','a.note.json')]).toEqual(location)
    expect(after.layouts.r).toBe(resourceLayout)
    if(projected){expect(after.tabs).toBe(before.tabs);expect(after.layouts.d).toBe(displayLayout);expect(onSelect).toHaveBeenCalledWith(reference)}
    else{expect(after.activeWorkspaceId).toBe('d');expect(after.tabs[tab.id]?.layout.activeRegionId).toBe('source-file');expect(findGroup(after.layouts.d!,'display-g')?.activeTabId).toBe(tab.id);expect(onSelect).not.toHaveBeenCalled()}
  })
  it('uses the actual Files and Document owners at a foreign display Group',async()=>{
    const root=await mkdtemp(join(tmpdir(),'amx-note-store-files-'));roots.push(root)
    const workspace:WorkspaceRecord={id:'r',name:'R',hostId:'local',path:root,kind:'folder'}
    const launcher=fixture(), state=useAppStore.getState(), tab={...state.tabs.launcher!,space:{spaceId:directoryIdentity('local',root),zoneId:'temporary-zone'}}
    useAppStore.setState({config:{...config,workspaces:[workspace,config.workspaces[1]!]},tabs:{launcher:tab},layouts:{r:createWorkspaceLayout('resource'),d:createWorkspaceLayout('display-g',['launcher'])},spaceZoneBindings:{'temporary-zone':{workspaceId:'r',spaceId:directoryIdentity('local',root),relations:{}}}})
    const files=new WorkspaceFiles(id=>({id,kind:'local',label:'Local',run:vi.fn(),exposeLoopbackPort:async port=>port,dispose:async()=>{}}))
    vi.spyOn(api.files,'write').mockImplementation(async(id,input)=>{expect(id).toBe('r');return await files.write(workspace,input)})
    vi.spyOn(api.files,'read').mockImplementation(async(id,path)=>{expect(id).toBe('r');return await files.read(workspace,path)})
    vi.spyOn(api.files,'observe').mockResolvedValue(undefined);vi.spyOn(api.files,'unobserve').mockResolvedValue(undefined)
    const originalResourceLayout=useAppStore.getState().layouts.r
    const receipt=await useAppStore.getState().createNote('display-g',launcher,'body')
    expect(receipt.status).toBe('written');expect(receipt.revealed).toBe(true);expect(receipt.target.displayWorkspaceId).toBe('d')
    const after=useAppStore.getState(), key=documentKey('r',receipt.path), tabId=fileTabId('r',receipt.path)
    expect(after.documents[key]?.content).toBe(await readFile(join(root,receipt.path),'utf8'));expect(after.tabs[tabId]?.space?.zoneId).toBe('temporary-zone')
    expect(findGroup(after.layouts.d!,'display-g')?.tabOrder).toEqual(['launcher',tabId]);expect(after.layouts.r).toEqual(originalResourceLayout)
  })
})
