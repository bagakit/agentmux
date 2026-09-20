import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult, ExecutionHost } from '@agentmux/core'
import type { ScratchTopics } from '../src/main/scratch-topics.js'
import type { WorkspaceFiles } from '../src/main/workspace-files.js'
const ipc = vi.hoisted(() => ({ root: '', handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  execute: undefined as ((request: AgentMuxControlRequest) => Promise<AgentMuxControlResult>) | undefined,
  choose: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => ipc.root || tmpdir() },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: { showOpenDialog: ipc.choose }, nativeImage: {}, shell: {} }))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { constructor(options: { execute: typeof ipc.execute }) { ipc.execute = options.execute } async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'owned.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import { AgentMuxMemoryAgentSessionStore, AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { ConfigStore, DEFAULT_CONFIG, createWorkspaceInputSchema } from '../src/main/config-store.js'
import { RuntimeController, type RuntimePreparation } from '../src/main/runtime-controller.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'
import { registerIpc } from '../src/main/ipc.js'
import { CONFIG_CHANGED_CHANNEL, type AppConfig, type WorkspaceRecord } from '../src/shared/contracts.js'
import { registerWorkspace } from '../src/main/settings-workspace-add-control.js'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture.js'

const directories: string[] = []
const envelope = { requestId: 'owned-workspace-add', schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION } as const
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-workspace-add-'));directories.push(root);ipc.root=root
  const store = new ConfigStore(join(root, 'config.json'))
  const initial = await store.save({ ...structuredClone(DEFAULT_CONFIG), workspaces: [
    { id: '__scratch__', name: 'Owned Topics', hostId: 'local', path: join(root, 'topics'), kind: 'folder' }] })
  vi.spyOn(store, 'get').mockResolvedValue(initial)
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] }
  const prepare=vi.spyOn(runtime, 'prepare').mockResolvedValue(preparation)
  const executionHost=vi.spyOn(runtime, 'executionHost').mockReturnValue({} as ExecutionHost)
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  const progressLoops=new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(root,'loops.json')),
    async()=> 'unknown', undefined, async()=>{throw new Error('No automatic loop is admitted in the Workspace fixture')})
  const publications: AppConfig[]=[]
  const sender=Object.assign(new EventEmitter(),{id:932,isDestroyed:()=>false,mainFrame:{framesInSubtree:[]},
    send:vi.fn((channel:string,value:unknown)=>{if(channel===CONFIG_CHANGED_CHANNEL)publications.push(value as AppConfig)})})
  ipc.handlers.clear();ipc.execute=undefined
  const dispose=await registerIpc({window:{isDestroyed:()=>false,webContents:sender} as unknown as BrowserWindow,
    configStore:store,runtime,progressLoops,scratchTopics:{} as ScratchTopics,workspaceFiles:{dispose:async()=>{}} as unknown as WorkspaceFiles})
  prepare.mockClear();const save=vi.spyOn(store,'save')
  const invoke=async<T>(channel:string,...values:unknown[])=>{
    const handler=ipc.handlers.get(channel);expect(handler).toBeTypeOf('function')
    return await handler!({sender} as unknown as IpcMainInvokeEvent,...values) as T
  }
  const cli=async(input:Record<string,string>)=>{
    expect(ipc.execute).toBeTypeOf('function')
    const result=await ipc.execute!({...envelope,operation:'settings.workspaces.add',input})
    if(result.operation!=='settings.workspaces.add')throw new Error('Wrong Workspace registration receipt')
    return result
  }
  return {root,store,runtime,prepare,executionHost,save,publications,invoke,cli,
    current:()=>invoke<AppConfig>('config:get'),bytes:()=>readFile(store.filePath,'utf8'),
    dispose:async()=>{await dispose();await progressLoops.stop()}}
}
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})))})

describe('Workspace registration owns current Main facts for UI and public CLI',()=>{
 it('derives a nonempty strict input contract from the actual shared type and Settings add fields',async()=>{
  const contract=ts.createSourceFile('contracts.ts',await readFile(new URL('../src/shared/contracts.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true)
  const type=contract.statements.find(node=>ts.isTypeAliasDeclaration(node)&&node.name.text==='CreateWorkspaceInput')
  expect(type).toBeDefined();if(!type||!ts.isTypeAliasDeclaration(type)||!ts.isTypeLiteralNode(type.type))throw new Error('CreateWorkspaceInput anchor missing')
  const fields=type.type.members.filter(ts.isPropertySignature).map(node=>node.name.getText(contract))
  expect(fields.length).toBeGreaterThan(0)
  expect(Object.keys(createWorkspaceInputSchema.shape).sort()).toEqual(fields.sort())
  const source=ts.createSourceFile('WorkspaceSettingsPane.tsx',await readFile(new URL('../src/renderer/src/components/settings/WorkspaceSettingsPane.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  const calls:ts.CallExpression[]=[]
  const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(source)==='api.workspaces.add')calls.push(node);ts.forEachChild(node,visit)}
  visit(source);expect(calls).toHaveLength(1)
  const argument=calls[0]!.arguments[0];expect(argument).toBeDefined()
  const written=new Set<string>()
  const collect=(node:ts.Node)=>{if(ts.isPropertyAssignment(node)||ts.isShorthandPropertyAssignment(node))written.add(node.name.getText(source));ts.forEachChild(node,collect)}
  collect(argument!);expect(written.size).toBeGreaterThan(0)
  expect([...written].sort()).toEqual(fields.sort())
 })
 it('registers literal paths/default names and returns the actual original record for UI-first and CLI-first duplicates',async()=>{
  const f=await fixture();try{
   const literal=join(f.root,'~not-expanded ') // no existing directory or creation is required
   const first=await f.cli({hostId:'local',path:literal,name:'   '})
   expect(first.changed).toBe(true);expect(first.item.id).toMatch(/^[0-9a-f-]{36}$/)
   expect(first.item.value).toEqual({name:'~not-expanded ',hostId:'local',path:literal,kind:'folder'})
   const bytes=await f.bytes(),count=f.publications.length
   const existing=await f.invoke<WorkspaceRecord>('workspaces:add',{hostId:'local',path:literal+'/',name:'Do not rename'})
   expect(existing).toEqual({id:first.item.id,...first.item.value})
   expect(await f.bytes()).toBe(bytes);expect(f.publications).toHaveLength(count);expect(f.prepare).toHaveBeenCalledTimes(1)
   const ui=await f.invoke<WorkspaceRecord>('workspaces:add',{hostId:'local',path:join(f.root,'second'),name:'  Authored name  '})
   const next=await f.cli({hostId:'local',path:ui.path+'/.',name:''})
   expect(next).toEqual({operation:'settings.workspaces.add',item:{id:ui.id,value:{name:'Authored name',hostId:'local',path:ui.path,kind:'folder'}},changed:false})
   expect((await f.current()).workspaces).toHaveLength(3)
  }finally{await f.dispose()}
 })
 it('makes simultaneous UI/CLI same-location adds succeed with one identity and one durable publication, then composes disjoint adds',async()=>{
  const f=await fixture();try{
   const path=join(f.root,'same'),entered=deferred<void>(),held=deferred<void>()
   f.prepare.mockImplementationOnce(async()=>{entered.resolve();await held.promise;return {hosts:[],removedHostIds:[],hostSignatures:new Map(),reservedHostIds:[]}})
   const ui=f.invoke<WorkspaceRecord>('workspaces:add',{hostId:'local',path});await entered.promise
   const cli=f.cli({hostId:'local',path:path+'/'})
   // Readonly current config is available while durable preparation is held.
   expect((await f.current()).workspaces).toHaveLength(1)
   held.resolve();const [a,b]=await Promise.all([ui,cli])
   expect(b.item.id).toBe(a.id);expect(b.changed).toBe(false)
   expect(f.save).toHaveBeenCalledTimes(1);expect(f.prepare).toHaveBeenCalledTimes(1);expect(f.publications).toHaveLength(1)
   const [c,d]=await Promise.all([f.cli({hostId:'local',path:join(f.root,'one')}),f.invoke<WorkspaceRecord>('workspaces:add',{hostId:'local',path:join(f.root,'two')})])
   expect((await f.current()).workspaces.map(item=>item.id)).toEqual(['__scratch__',a.id,c.item.id,d.id])
   expect(f.publications).toHaveLength(3)
  }finally{await f.dispose()}
 })
 it('shares native folder registration, leaves cancelled/duplicate selections unchanged and keeps the dialog outside the owner queue',async()=>{
  const f=await fixture();try{
   ipc.choose.mockResolvedValueOnce({canceled:true,filePaths:[]})
   expect(await f.invoke('workspaces:chooseLocalFolder')).toBeNull();expect(f.save).not.toHaveBeenCalled()
   const dialog=deferred<{canceled:boolean;filePaths:string[]}>();ipc.choose.mockReturnValueOnce(dialog.promise)
   const pending=f.invoke<WorkspaceRecord>('workspaces:chooseLocalFolder')
   const before=await f.cli({hostId:'local',path:join(f.root,'folder')})
   dialog.resolve({canceled:false,filePaths:[join(f.root,'folder')+'/']})
   expect(await pending).toEqual({id:before.item.id,...before.item.value})
   expect(f.save).toHaveBeenCalledTimes(1);expect(f.publications).toHaveLength(1)
  }finally{await f.dispose()}
 })
 it('rejects malformed fields, absent or unavailable Hosts and failed persistence without publishing or changing durable bytes',async()=>{
  const f=await fixture();try{
   const baseline=await f.bytes()
   for(const value of [{hostId:'',path:'/owned'},{hostId:'local',path:''},{hostId:'local',path:'/owned',name:3},{hostId:'local',path:'/owned',id:'caller-id'},{hostId:'missing',path:'/owned'}]){
    await expect(f.invoke('workspaces:add',value)).rejects.toMatchObject({code:'INVALID_SETTING_VALUE'})
   }
   f.executionHost.mockImplementationOnce(()=>{throw new Error('Committed host connection absent')})
   await expect(f.cli({hostId:'local',path:'/owned'})).rejects.toMatchObject({code:'INVALID_SETTING_VALUE'})
   expect(await f.bytes()).toBe(baseline);expect(f.save).not.toHaveBeenCalled();expect(f.publications).toHaveLength(0);expect(f.prepare).not.toHaveBeenCalled()
   f.save.mockRejectedValueOnce(new Error('Owned write failure'))
   await expect(f.cli({hostId:'local',path:'/owned'})).rejects.toThrow('Owned write failure')
   expect(await f.bytes()).toBe(baseline);expect(f.publications).toHaveLength(0)
   expect((await f.current()).workspaces).toHaveLength(1)
  }finally{await f.dispose()}
 })
 it('checks the Host in the current updater rather than accepting an old queued Host fact',async()=>{
  const f=await configOwnerFixture({hosts:[DEFAULT_CONFIG.hosts[0]!,{id:'remote',kind:'ssh',label:'Owned remote',hostname:'private.invalid'}]})
  const entered=deferred<void>(),held=deferred<void>(),prepare=vi.mocked(f.runtime.prepare).getMockImplementation()!
  vi.mocked(f.runtime.prepare).mockImplementationOnce(async(...args)=>{entered.resolve();await held.promise;return prepare(...args)})
  const remove=f.owner.update(current=>({...current,hosts:[current.hosts[0]!]}));await entered.promise
  const executionHost=vi.fn(()=>({}))
  const add=registerWorkspace({hostId:'remote',path:'/literal'},f.owner,executionHost)
  const rejected=expect(add).rejects.toMatchObject({code:'INVALID_SETTING_VALUE'})
  held.resolve();await remove
  const bytes=await f.bytes()
  await rejected
  expect(executionHost).not.toHaveBeenCalled();expect(await f.bytes()).toBe(bytes);expect(f.publish).toHaveBeenCalledTimes(1)
 })
})
