import { settingsWorkbenchWindows, settingsScratchTopics, settingsWorkspaceFiles, prepareSettingsIpcDirectory } from './helpers/settings-ipc-fixture.js'
import { testWorkbenchUserState } from './helpers/workbench-user-state-fixture'
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { testAppDocumentSources } from "./helpers/app-document-fixture"
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL as SourceURL } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult, ExecutionHost } from '@agentmux/core'
const ipc = vi.hoisted(() => ({ root: '', handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  execute: undefined as ((request: AgentMuxControlRequest) => Promise<AgentMuxControlResult>) | undefined,
  choose: vi.fn(), browserSource: null as import('@agentmux/core/control').BrowserAgentWorkspaceSource | null,
  profileOwner: undefined as import('./helpers/settings-ipc-fixture.js').SettingsBrowserProfiles | undefined }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() }, app: { getPath: () => ipc.root || tmpdir(), getAppPath: () => process.cwd() + '/apps/desktop', on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), once: vi.fn() },
  globalShortcut: { register: () => true, unregister: vi.fn(), isRegistered: () => false },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: { showOpenDialog: ipc.choose }, nativeImage: {}, shell: { showItemInFolder: vi.fn() } }))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { constructor(options: { execute: typeof ipc.execute }) { ipc.execute = options.execute } async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', async () => ({ BrowserProfileManager: (await import('./helpers/settings-ipc-fixture.js')).SettingsBrowserProfiles }))
vi.mock('../../../packages/browser/src/browser-operation-journal.ts', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'owned.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../../../packages/browser/src/browser-ref-ledger-store.ts', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', async original => {
 const { BrowserViewManager } = await original<typeof import('../src/main/browser-view-manager.js')>()
 return { BrowserViewManager: class {
  constructor(_window: unknown, readonly profiles: import('./helpers/settings-ipc-fixture.js').SettingsBrowserProfiles) { ipc.profileOwner = profiles }
  setPresentationWindowOwner() {} async release() {} async flushProfileActivity() {} dispose() {}
  agentWorkspaceSource(id: string) { return ipc.browserSource?.browserId === id ? ipc.browserSource : null }
  // The real label owner handles unread display metadata; Native page creation stays isolated.
  profileLabel(id: string) { return BrowserViewManager.prototype.profileLabel.call(this as unknown as InstanceType<typeof BrowserViewManager>, id) }
 } }
})
vi.mock('../src/main/notes-storage-owner.js', () => ({ NotesStorageOwner: class { constructor(_config: unknown, _spatial: unknown, _publish: unknown, readonly storage: unknown) {} async initialize() {} } }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import { AgentMuxMemoryAgentSessionStore, AGENTMUX_CONTROL_SCHEMA_VERSION, LocalExecutionHost } from '@agentmux/core'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { sourceTreeFileLocation } from '../src/shared/source-files.js'
import { shell } from 'electron'
import { ConfigStore, DEFAULT_CONFIG, createWorkspaceInputSchema } from '../src/main/config-store.js'
import { RuntimeController, type RuntimePreparation } from '../src/main/runtime-controller.js'
import { ContinuousProgressLoopManager } from '@agentmux/host/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '@agentmux/host/continuous-progress-loop-store'
import { registerIpc } from '../src/main/ipc.js'
import { CONFIG_CHANGED_CHANNEL, type AppConfig, type WorkspaceRecord } from '../src/shared/contracts.js'
import { registerWorkspace } from '../src/main/settings-workspace-add-control.js'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture.js'

const directories: string[] = []
const envelope = { requestId: 'owned-workspace-add', schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION } as const
async function fixture(files = settingsWorkspaceFiles()) {
  const root = await mkdtemp(join(tmpdir(), 'amux-workspace-add-'));directories.push(root);ipc.root=root
  await prepareSettingsIpcDirectory(root)
  const store = new ConfigStore(join(root, 'config.json'))
  const initial = await store.save({ ...structuredClone(DEFAULT_CONFIG), workspaces: [
    { id: '__scratch__', name: 'Owned Topics', hostId: 'local', path: join(root, 'topics'), kind: 'folder' }] })
  vi.spyOn(store, 'get').mockResolvedValue(initial)
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] }
  const prepare=vi.spyOn(runtime, 'prepare').mockResolvedValue(preparation)
  const executionHost=vi.spyOn(runtime, 'executionHost').mockReturnValue({} as ExecutionHost)
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  const progressLoops=new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(root,'loops.json')),
    async()=> 'unknown', undefined, async()=>{throw new Error('No automatic loop is admitted in the Workspace fixture')})
  const publications: AppConfig[]=[]
  const sender=Object.assign(new EventEmitter(),{id:932,isDestroyed:()=>false,mainFrame:{framesInSubtree:[]},
    send:vi.fn((channel:string,value:unknown)=>{if(channel===CONFIG_CHANGED_CHANNEL)publications.push(value as AppConfig)})})
  const window={setBackgroundColor:vi.fn(),isDestroyed:()=>false,webContents:sender} as unknown as BrowserWindow
  ipc.handlers.clear();ipc.execute=undefined
  const dispose=await registerIpc({ workbenchUserState: testWorkbenchUserState(), appDocumentSources: testAppDocumentSources(sender), initialConfig: await store.get(),window,
    configStore:store,runtime,applicationAccess:{} as never,workbenchWindows:settingsWorkbenchWindows(window),scratchTopics:settingsScratchTopics(),workspaceFiles:files})
  prepare.mockClear();const save=vi.spyOn(store,'save')
  const invoke=async<T>(channel:string,...values:unknown[])=>{
    const handler=ipc.handlers.get(channel);expect(handler).toBeTypeOf('function')
    return await handler!({ senderFrame: Reflect.get(sender as object, 'mainFrame'),sender} as unknown as IpcMainInvokeEvent,...values) as T
  }
  const cli=async(input:Record<string,unknown>)=>{
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
  const contract=ts.createSourceFile('contracts.ts',await readFile(new SourceURL('../src/shared/contracts.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true)
  const type=contract.statements.find(node=>ts.isTypeAliasDeclaration(node)&&node.name.text==='CreateWorkspaceInput')
  expect(type).toBeDefined();if(!type||!ts.isTypeAliasDeclaration(type)||!ts.isTypeLiteralNode(type.type))throw new Error('CreateWorkspaceInput anchor missing')
  const fields=type.type.members.filter(ts.isPropertySignature).map(node=>node.name.getText(contract))
  expect(fields.length).toBeGreaterThan(0)
  expect(Object.keys(createWorkspaceInputSchema.shape).sort()).toEqual(fields.sort())
  const source=ts.createSourceFile('HostProjectsPane.tsx',await readFile(new SourceURL('../src/renderer/src/components/settings/HostProjectsPane.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  const calls:ts.CallExpression[]=[]
  const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(source)==='api.workspaces.add')calls.push(node);ts.forEachChild(node,visit)}
  visit(source);expect(calls).toHaveLength(1)
  let argument=calls[0]!.arguments[0];expect(argument).toBeDefined()
  if(argument&&ts.isIdentifier(argument)){
   const inputName=argument.text,declarations:ts.VariableDeclaration[]=[]
   const find=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===inputName&&node.initializer&&ts.isObjectLiteralExpression(node.initializer))declarations.push(node);ts.forEachChild(node,find)}
   find(source);expect(declarations).toHaveLength(1)
   argument=declarations[0]!.initializer!
  }
  const written=new Set<string>()
  const collect=(node:ts.Node)=>{if(ts.isPropertyAssignment(node)||ts.isShorthandPropertyAssignment(node))written.add(node.name.getText(source));ts.forEachChild(node,collect)}
  collect(argument!);expect(written.size).toBeGreaterThan(0)
  expect([...written].sort()).toEqual(fields.sort())
 })
 it('accepts expectedHost through the actual public settings.workspaces.add chain',async()=>{
  const f=await fixture();try{
   const expectedHost=(await f.current()).hosts.find(host=>host.id==='local')!,path=join(f.root,'public-expected')
   const result=await f.cli({hostId:'local',path,expectedHost})
   expect(result).toMatchObject({operation:'settings.workspaces.add',changed:true,item:{value:{hostId:'local',path,kind:'folder'}}})
   expect(JSON.parse(await f.bytes()).workspaces.some((item:WorkspaceRecord)=>item.hostId==='local'&&item.path===path)).toBe(true)
  }finally{await f.dispose()}
 })
 it('keeps public registration on the original Host after a display rename',async()=>{
  const f=await fixture();try{
   const before=await f.current(),expectedHost=before.hosts.find(host=>host.id==='local')!,path=join(f.root,'renamed-host')
   await f.invoke('config:save',{...before,hosts:before.hosts.map(host=>host.id==='local'?{...host,label:'Renamed display'}:host)},before)
   const result=await f.cli({hostId:'local',path,expectedHost})
   expect(result).toMatchObject({operation:'settings.workspaces.add',changed:true,item:{value:{hostId:'local',path}}})
   expect(JSON.parse(await f.bytes()).workspaces.some((item:WorkspaceRecord)=>item.hostId==='local'&&item.path===path)).toBe(true)
  }finally{await f.dispose()}
 })
 it('registers literal paths/default names and returns the actual original record for UI-first and CLI-first duplicates',async()=>{
  const f=await fixture();try{
   const literal=join(f.root,'~not-expanded ') // no existing directory or creation is required
   const first=await f.cli({hostId:'local',path:literal,name:'   '})
   expect(first.changed).toBe(true);expect(first.item.id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
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
   for(const value of [{hostId:'',path:_hygiene_fixturePath("owned")},{hostId:'local',path:''},{hostId:'local',path:_hygiene_fixturePath("owned"),name:3},{hostId:'local',path:_hygiene_fixturePath("owned"),id:'caller-id'},{hostId:'missing',path:_hygiene_fixturePath("owned")}]){
    await expect(f.invoke('workspaces:add',value)).rejects.toMatchObject({code:'INVALID_SETTING_VALUE'})
   }
   f.executionHost.mockImplementationOnce(()=>{throw new Error('Committed host connection absent')})
   await expect(f.cli({hostId:'local',path:_hygiene_fixturePath("owned")})).rejects.toMatchObject({code:'INVALID_SETTING_VALUE'})
   expect(await f.bytes()).toBe(baseline);expect(f.save).not.toHaveBeenCalled();expect(f.publications).toHaveLength(0);expect(f.prepare).not.toHaveBeenCalled()
   f.save.mockRejectedValueOnce(new Error('Owned write failure'))
   await expect(f.cli({hostId:'local',path:_hygiene_fixturePath("owned")})).rejects.toThrow('Owned write failure')
   expect(await f.bytes()).toBe(baseline);expect(f.publications).toHaveLength(0)
   expect((await f.current()).workspaces).toHaveLength(1)
  }finally{await f.dispose()}
 })
 it('registers against the same Host when only its display name changed',async()=>{
  const f=await configOwnerFixture({hosts:[DEFAULT_CONFIG.hosts[0]!,{id:'remote',kind:'ssh',label:'Owned remote',hostname:'private.invalid'}]})
  const expectedHost=f.owner.current.hosts.find(host=>host.id==='remote')!
  await f.owner.update(current=>({...current,hosts:current.hosts.map(host=>host.id==='remote'?{...host,label:'Renamed display'}:host)}))
  const result=await registerWorkspace({hostId:'remote',path:_hygiene_fixturePath("literal"),expectedHost},f.owner,()=>({}))
  expect(result.workspace.hostId).toBe('remote')
 })
 it('rejects a same-ID Host replacement instead of registering on a different connection',async()=>{
  const f=await configOwnerFixture({hosts:[DEFAULT_CONFIG.hosts[0]!,{id:'remote',kind:'ssh',label:'Owned remote',hostname:'private.invalid'}]})
  const expectedHost=f.owner.current.hosts.find(host=>host.id==='remote')!,executionHost=vi.fn(()=>({}))
  const accepted=await registerWorkspace({hostId:'remote',path:_hygiene_fixturePath("literal"),expectedHost},f.owner,executionHost)
  expect(accepted.workspace.hostId).toBe('remote');expect(executionHost).toHaveBeenCalledOnce();executionHost.mockClear()
  const entered=deferred<void>(),held=deferred<void>(),prepare=vi.mocked(f.runtime.prepare).getMockImplementation()!
  vi.mocked(f.runtime.prepare).mockImplementationOnce(async(...args)=>{entered.resolve();await held.promise;return prepare(...args)})
  const replace=f.owner.update(current=>({...current,hosts:current.hosts.map(host=>host.id==='remote'?{...host,hostname:'replacement.invalid'}:host)}));await entered.promise
  const add=registerWorkspace({hostId:'remote',path:_hygiene_fixturePath("other"),expectedHost},f.owner,executionHost)
  const rejected=expect(add).rejects.toMatchObject({code:'INVALID_SETTING_VALUE',message:/connection changed before folder registration/})
  held.resolve();await replace
  const bytes=await f.bytes(),publications=f.publish.mock.calls.length
  await rejected
  expect(executionHost).not.toHaveBeenCalled();expect(await f.bytes()).toBe(bytes);expect(f.publish).toHaveBeenCalledTimes(publications)
 })
 it('checks the Host in the current updater rather than accepting an old queued Host fact',async()=>{
  const f=await configOwnerFixture({hosts:[DEFAULT_CONFIG.hosts[0]!,{id:'remote',kind:'ssh',label:'Owned remote',hostname:'private.invalid'}]})
  const entered=deferred<void>(),held=deferred<void>(),prepare=vi.mocked(f.runtime.prepare).getMockImplementation()!
  vi.mocked(f.runtime.prepare).mockImplementationOnce(async(...args)=>{entered.resolve();await held.promise;return prepare(...args)})
  const remove=f.owner.update(current=>({...current,hosts:[current.hosts[0]!]}));await entered.promise
  const executionHost=vi.fn(()=>({}))
  const add=registerWorkspace({hostId:'remote',path:_hygiene_fixturePath("literal")},f.owner,executionHost)
  const rejected=expect(add).rejects.toMatchObject({code:'INVALID_SETTING_VALUE'})
  held.resolve();await remove
  const bytes=await f.bytes()
  await rejected
  expect(executionHost).not.toHaveBeenCalled();expect(await f.bytes()).toBe(bytes);expect(f.publish).toHaveBeenCalledTimes(1)
 })
})


describe('survey-directory: actual Main IPC registration', () => {
 it.each(['survey', 'project'] as const)('keeps %s preparation ready through Main GUI/public consumers when Profile labels cannot be read', async scope => {
  const f = await fixture()
  f.executionHost.mockReturnValue(new LocalExecutionHost())
  const profileId = '11111111-1111-4111-8111-111111111111'
  const resource = scope === 'project' ? await f.invoke<WorkspaceRecord>('workspaces:add', { hostId: 'local', path: join(f.root, 'original-project') }) : (await f.current()).workspaces[0]!
  ipc.browserSource = { browserId: 'owned-page', workspaceId: resource.id, mode: 'normal', profileId }
  const source = { ...ipc.browserSource }, expectedPath = scope === 'survey' ? join(f.root, '.agentmux', 'survey', profileId) : resource.path
  const labels = ipc.profileOwner!.listProfiles.mockImplementation(() => { throw new Error('Profile display metadata is unread') })
  try {
   const [gui, result] = await Promise.all([
    f.invoke<import('@agentmux/core/control').BrowserAgentWorkspaceResult>('browser:prepareAgentWorkspace', { browserId: 'owned-page' }),
    ipc.execute!({ ...envelope, operation: 'browser.agent-workspace.prepare', browserId: 'owned-page' })
   ].map(operation => operation.catch(error => ({ error }))))
   const ready = { outcome: 'ready', source, scope: scope === 'survey' ? 'survey-profile' : 'existing', directory: { hostId: 'local', path: expectedPath }, workspace: { hostId: 'local', path: expectedPath } }
   expect(gui).toMatchObject(ready); expect(result).toMatchObject({ operation: 'browser.agent-workspace.prepare', ...ready })
   expect(gui).not.toHaveProperty('profileLabel'); expect(result).not.toHaveProperty('profileLabel')
   expect(labels).toHaveBeenCalledTimes(2); expect(ipc.browserSource).toEqual(source)
   expect(JSON.parse(await f.bytes()).workspaces.filter((item: WorkspaceRecord) => item.path === expectedPath)).toHaveLength(1)
  } finally { ipc.browserSource = null; await f.dispose() }
 })
 it('prepares a Survey Agent directory through the actual Main IPC and public dispatch owner', async () => {
  const f=await fixture()
  f.executionHost.mockReturnValue(new LocalExecutionHost())
  ipc.browserSource={browserId:'owned-page',workspaceId:'__scratch__',mode:'normal',profileId:'11111111-1111-4111-8111-111111111111'}
  try {
   const gui=await f.invoke<import('@agentmux/core/control').BrowserAgentWorkspaceResult>('browser:prepareAgentWorkspace',{browserId:'owned-page'})
   expect(gui.outcome).toBe('ready')
   expect(gui.directory.path).toBe(join(f.root,'.agentmux','survey',ipc.browserSource.profileId!))
   expect(gui.workspace?.id).not.toBe('__scratch__')
   const api=await ipc.execute!({...envelope,operation:'browser.agent-workspace.prepare',browserId:'owned-page'})
   expect(api).toMatchObject({operation:'browser.agent-workspace.prepare',outcome:'ready',workspace:gui.workspace})
   expect((await f.current()).workspaces.filter(item=>item.id===gui.workspace!.id)).toHaveLength(1)
   expect(JSON.parse(await f.bytes()).workspaces.some((item:WorkspaceRecord)=>item.id===gui.workspace!.id&&item.path===gui.directory.path)).toBe(true)
   expect(f.publications.some(config=>config.workspaces.some(item=>item.id===gui.workspace!.id))).toBe(true)
  } finally {ipc.browserSource=null;await f.dispose()}
 })
})


describe('survey-directory: Main actual registration recovery fence',()=>{
 it('confirms the original file and Runtime before publishing a lost-ACK folder without another save',async()=>{
  const f=await fixture(), persist=ConfigStore.prototype.save.bind(f.store)
  f.executionHost.mockReturnValue(new LocalExecutionHost())
  ipc.browserSource={browserId:'owned-page',workspaceId:'__scratch__',mode:'normal',profileId:'11111111-1111-4111-8111-111111111111'}
  const events:string[]=[], reserve=f.runtime.reserveExecutorConfigEdit.bind(f.runtime)
  vi.spyOn(f.runtime,'reserveExecutorConfigEdit').mockImplementation(async(...args)=>{const release=await reserve(...args);events.push('reserved');return()=>{events.push('released');release()}})
  const confirm=vi.spyOn(f.store,'confirmSaved').mockImplementation(async value=>{events.push('confirm');await ConfigStore.prototype.confirmSaved.call(f.store,value)})
  const commit=f.runtime.commit.bind(f.runtime)
  vi.spyOn(f.runtime,'commit').mockImplementation(value=>{events.push('commit');commit(value)})
  f.save.mockImplementationOnce(async next=>{await persist(next);throw new Error('Original config write applied; ACK lost')})
  try{
   const first=await f.invoke<import('@agentmux/core/control').BrowserAgentWorkspaceResult>('browser:prepareAgentWorkspace',{browserId:'owned-page'})
   expect(first.registration).toBe('unconfirmed')
   const written=JSON.parse(await f.bytes()).workspaces.find((item:WorkspaceRecord)=>item.path===first.directory.path)
   const next=await f.invoke<import('@agentmux/core/control').BrowserAgentWorkspaceResult>('browser:prepareAgentWorkspace',{browserId:'owned-page'})
   expect(next.workspace?.id).toBe(written.id);expect(next.outcome).toBe('ready')
   expect(f.save).toHaveBeenCalledOnce();expect(confirm).toHaveBeenCalledOnce()
   expect(events).toEqual(['reserved','released','reserved','confirm','commit','released'])
   expect((await f.current()).workspaces.some(item=>item.id===written.id)).toBe(true)
  }finally{ipc.browserSource=null;await f.dispose()}
 })
})

it('registers the selected Workspace directory and rejects the same name under a different parent', async () => {
  const f = await fixture()
  try {
    const [owner] = (await f.current()).workspaces
    const path = join(owner!.path, 'selected', 'notes')
    const location = { kind: 'workspace', workspaceId: owner!.id, path: 'selected/notes' }
    const before = await f.bytes()
    await expect(f.invoke('workspaces:addFromFile', location, { hostId: owner!.hostId, path: join(owner!.path, 'other', 'notes') })).rejects.toThrow('selected folder moved')
    expect(await f.bytes()).toBe(before)
    const project = await f.invoke<WorkspaceRecord>('workspaces:addFromFile', location, { hostId: owner!.hostId, path })
    expect(project).toMatchObject({ hostId: owner!.hostId, path })
  } finally { await f.dispose() }
})

it('keeps Finder and project registration on the original Source across a late carrier replacement', async () => {
  const files = new WorkspaceFiles(() => new LocalExecutionHost()), f = await fixture(files)
  try {
    const sourceRoot = await realpath(f.root), folder = 'original-folder', path = join(sourceRoot, folder)
    await mkdir(path)
    const zoneId = 'original-zone', reference = { runtimeId: 'original-runtime', spaceId: 'original-space' }
    const resource = { hostId: 'local', workspaceId: 'source-workspace', workspacePath: sourceRoot, zoneId, zonePath: sourceRoot, path: '.' }
    const mount = { hostId: 'local', reference, zoneId, workspaceId: resource.workspaceId }
    const location = sourceTreeFileLocation({ mount, resource }, folder)
    const witness = { device: '1', inode: '2', size: '1', ctimeNs: '1', mtimeNs: '1', birthtimeNs: null }
    const observed = { resource: location.resource, result: { status: 'observed' as const, observation: { root: witness, parent: witness,
      parentPath: '.', entry: { kind: 'directory' as const, witness }, implementation: { platform: 'darwin' as const, stat: 'native' as const, mkdir: 'native-no-replace' as const } } } }
    const reply = { carrierCurrent: true, result: observed }
    const stat = vi.spyOn(f.runtime, 'sourceFilesCall').mockResolvedValue(reply)
    vi.mocked(shell.showItemInFolder).mockClear()
    await f.invoke('files:reveal', { kind: 'source', source: location })
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path)
    expect(stat).toHaveBeenCalledExactlyOnceWith(location.target, 'file.stat', location.query)
    const removed = sourceTreeFileLocation({ mount, resource }, folder + '/deleted')
    stat.mockResolvedValueOnce({ carrierCurrent: true, result: { resource: removed.resource, result: {
      ...observed.result, observation: { ...observed.result.observation, entry: { kind: 'absent' } } } } })
    await f.invoke('files:reveal', { kind: 'source', source: removed })
    expect(shell.showItemInFolder).toHaveBeenNthCalledWith(2, path)
    stat.mockResolvedValueOnce({ carrierCurrent: true, result: { ...observed, resource: { ...observed.resource, zonePath: join(path, 'different') } } })
    await expect(f.invoke('files:reveal', { kind: 'source', source: location })).rejects.toThrow('original Source file location')
    await expect(f.invoke('files:reveal', { kind: 'source', source: { ...location, target: { ...location.target, hostId: 'another-host' } } })).rejects.toThrow('local file manager')
    expect(shell.showItemInFolder).toHaveBeenCalledTimes(2)
    const input = { name: folder, hostId: 'local', path, expectedHost: DEFAULT_CONFIG.hosts[0]! }
    const before = await f.bytes()
    stat.mockImplementationOnce(async () => {
      f.executionHost.mockReturnValue(new LocalExecutionHost())
      return reply
    })
    await expect(f.invoke('workspaces:addFromFile', { kind: 'source', source: location }, input)).rejects.toThrow()
    expect(await f.bytes()).toBe(before)
    const symlink = { carrierCurrent: true, result: { ...observed, result: { ...observed.result, observation: {
      ...observed.result.observation, entry: { kind: 'symlink' as const, witness } } } } }
    stat.mockResolvedValueOnce(symlink).mockResolvedValueOnce({ carrierCurrent: true, result: { resource: location.resource,
      result: { status: 'unknown', code: 'NOT_A_DIRECTORY', message: 'The original link does not open a directory.' } } })
    await expect(f.invoke('workspaces:addFromFile', { kind: 'source', source: location }, input)).rejects.toThrow('confirmed directory')
    expect(await f.bytes()).toBe(before)
    stat.mockResolvedValueOnce(symlink).mockResolvedValueOnce({ carrierCurrent: true, result: { resource: location.resource,
      result: { status: 'directory-listed', entries: [], complete: true, partialReason: null } } })
    const project = await f.invoke<WorkspaceRecord>('workspaces:addFromFile', { kind: 'source', source: location }, input)
    expect(stat).toHaveBeenLastCalledWith(location.target, 'file.list', { ...location.query, mode: 'directory', limit: 1 })
    expect(project).toMatchObject({ name: folder, path, hostId: 'local' })
  } finally { await f.dispose(); await files.dispose() }
})
