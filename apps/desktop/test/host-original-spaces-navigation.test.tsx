// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HostOriginalSpaces } from '../src/renderer/src/components/settings/HostOriginalSpaces'
import { SourceLauncherRequest } from '../src/renderer/src/components/SourceLauncherRequest'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import * as storeModule from '../src/renderer/src/store'
import { useAppStore } from '../src/renderer/src/store'
import { desktopBindingsFromSpatial, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { initialMountedSpaceView, mountedSpaceInput } from '../src/renderer/src/lib/space-mount-view'
import type { MountedAgentOpenInput } from '../src/renderer/src/lib/space-mount-launch'
import { readSpaceSnapshot } from '../../../packages/core/src/space-authority-stream'
import { sourceFolderFixture } from '../../../packages/core/test/helpers/space-folder-directory-fixture'
import { sourceCreationFixture } from '../../../packages/core/test/helpers/source-creation-fixture'
import { createWorkbenchViewLayout, createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { spaceMountKey } from '../src/shared/space-mount'
import { spaceMountTransport, spaceMountFixture } from './helpers/space-mount-fixture'
import { sourceFilesIpcBridge } from './helpers/source-files-ipc-bridge'
import { RuntimeController } from '../src/main/runtime-controller'
import { originalSpaceWorkspace, originalSourceFileWorkspaceId, originalSourceGroupProjectionId, originalSourceRegionProjectionId, originalSourceTabProjectionId, originalSourceWorkspaceId } from '../src/renderer/src/lib/original-space-navigation'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { emptySourceFilesInputs } from '../src/renderer/src/lib/source-files-workbench'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom=composerDOM(),cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks()})
const configured=(id:string,path:string,name='Configured original')=>({id,name,hostId:'local',path,kind:'folder' as const})

async function settingsFixture(clientConfigured:boolean,carrierHostId='local') {
  const f=await sourceFolderFixture(cleanup)
  const original=configured('original-settings-project',f.directory,'Original Settings project')
  await writeFile(f.configurationPath,JSON.stringify({hosts:[{id:'local',kind:'local',label:'Original B'}],workspaces:[original],executors:{},appearance:{}}))
  const observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})
  const before=(await f.spatial.read())!,graph=structuredClone(before.graph),tabId='settings-original-tab',regionId='settings-original-region'
  graph.tabs.push({tabId,zoneId:saved.zoneId,workspaceId:saved.workspaceId,name:'Settings original work',regionIds:[regionId]})
  graph.regions.push({regionId,tabId,kind:'launcher',agentSessionId:null,runId:null,execution:{hostId:'local',cwd:f.directory,runtimeId:f.source.runtimeId}})
  graph.resources[`tab:${tabId}`]={};graph.resources[`region:${regionId}`]={}
  graph.layouts[saved.workspaceId]=createWorkspaceLayout('settings-original-group',[tabId]);graph.tabLayouts[tabId]=createWorkbenchViewLayout(regionId)
  const committed=await f.spatial.commit({expectedRevision:before.revision,graph})
  const target={hostId:carrierHostId,reference:saved.reference,zoneId:saved.zoneId,workspaceId:saved.workspaceId},key=spaceMountKey(saved.reference)
  const config={...composerConfig,hosts:[...composerConfig.hosts,...(carrierHostId==='local'?[]:[{id:carrierHostId,kind:'ssh' as const,label:'Original remote B',hostname:'source.invalid'}])],workspaces:clientConfigured?[configured(saved.workspaceId,f.directory)]:[]},restored=desktopWorkbenchFromSpatial(committed.graph)
  vi.spyOn(storeModule,'currentCoreSpatialGraph').mockReturnValue(committed.graph)
  const snapshot=await readSpaceSnapshot(f.rpc,saved.reference),view=initialMountedSpaceView(snapshot),pending={kind:'agent-open',operationId:'settings-unresolved-OP',retain:{bytes:[1,2]}}
  const inputs={[key]:{target,view,drafts:{original:'Settings unsent draft'},memberInputs:{original:{operationId:'settings-member-OP'}}},'settings-pending':pending}
  useAppStore.setState({config,mountedSpaceInputs:inputs,mountedSpaceObservations:{[key]:{snapshot,reading:false}},
    activeWorkspaceId:null,tabs:Object.fromEntries(Object.entries(restored.tabs).map(([id,tab])=>[id,hydratePersistedTab(tab)])),layouts:restored.layouts,spaceZoneBindings:desktopBindingsFromSpatial(committed.graph,config),workbenchSpaceSelection:null,collapsedProjectGroups:{}})
  const transport=spaceMountTransport(cleanup,[{id:carrierHostId,carrier:{forwardRpc:async(method,params,context,fence)=>f.rpc.call(method as never,params as never,{...context as object,...(fence?{runtimeFence:fence}:{})} as never),subscribeRpc:f.rpc.subscribe.bind(f.rpc)}}])
  vi.spyOn(api.spaceMounts,'call').mockImplementation(transport.api.call)
  vi.spyOn(storeModule,'checkpointMountedSpaceInputs').mockResolvedValue(undefined)
  return {...f,saved,target,key,tabId,regionId,config,view,pending,inputs,snapshot}
}


it.each([false,true])('Settings Open original Space selects the original project occurrence once (client configured=%s)',async clientConfigured=>{
  const f=await settingsFixture(clientConfigured),disk=await readFile(f.configurationPath,'utf8'),onClose=vi.fn(),observer=useAppStore.getState().mountedSpaceObservations[f.key]
  await dom.render(<><HostOriginalSpaces host={{id:'local',kind:'local',label:'Original local Core'}} active onClose={onClose}/><WorkspaceSidebar/></>)
  await vi.waitFor(async()=>{await act(async()=>{});expect(Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Open original Space'),dom.container.textContent).toBeDefined()})
  const open=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Open original Space')!
  await act(async()=>{open.click();await vi.waitFor(()=>expect(onClose).toHaveBeenCalledOnce())})
  const current=useAppStore.getState()
  expect(current.activeWorkspaceId).toBe(f.saved.workspaceId);expect(Object.hasOwn(current,'selectedSpaceMount')).toBe(false)
  expect(current.workbenchSpaceSelection).toMatchObject({spaceId:f.saved.reference.spaceId,zoneId:f.saved.zoneId,workspaceId:f.saved.workspaceId,groupId:'settings-original-group',tabId:f.tabId,regionId:f.regionId})
  expect(current.config).toBe(f.config);expect(current.config!.workspaces).toHaveLength(clientConfigured?1:0)
  expect(mountedSpaceInput(current.mountedSpaceInputs,f.key)?.view).toBe(f.view)
  expect(mountedSpaceInput(current.mountedSpaceInputs,f.key)?.drafts.original).toBe('Settings unsent draft')
  expect(mountedSpaceInput(current.mountedSpaceInputs,f.key)?.memberInputs).toEqual({original:{operationId:'settings-member-OP'}})
  expect((current.mountedSpaceInputs as Record<string,unknown>)['settings-pending']).toBe(f.pending)
  expect(current.mountedSpaceObservations[f.key]).toBe(observer)
  expect(dom.container.querySelectorAll('[data-mounted-space-nav]')).toHaveLength(0)
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button'),dom.container.textContent ?? '').toHaveLength(clientConfigured?0:1)
  expect(dom.container.querySelector('[aria-current="page"]')?.textContent).toContain(clientConfigured?'Configured original':'Original Settings project')
  expect(await readFile(f.configurationPath,'utf8')).toBe(disk)
})


it.each([false,true])('Launcher Open original work selects its receipt Region in the original project (client configured=%s)',async clientConfigured=>{
  const source=await sourceCreationFixture(cleanup)
  await source.spatial.registerDirectory({runtimeId:'runtime-b',directory:{hostId:'local',workspacePath:'/b/project',projectRootPath:'/b/project',witness:{realPath:'/b/project',device:'controlled',inode:'controlled'}},workspaceId:'b-workspace'},
    async()=>[{id:'b-workspace',hostId:'local',path:'/b/project',name:'B project',kind:'folder'}],async()=>{})
  const receipt=await source.rpc.call('agent.open',source.input),address=receipt.to!,committed=(await source.spatial.read())!
  const snapshot=await readSpaceSnapshot(source.rpc,{runtimeId:'runtime-b',spaceId:source.folder.spaceId})
  const target={hostId:'local',reference:{runtimeId:'runtime-b',spaceId:source.folder.spaceId},workspaceId:address.workspaceId,zoneId:source.folder.zoneId},key=spaceMountKey(target.reference)
  const config={...composerConfig,workspaces:clientConfigured?[configured('b-workspace','/b/project','B configured project')]:[]},restored=desktopWorkbenchFromSpatial(committed.graph)
  vi.spyOn(storeModule,'currentCoreSpatialGraph').mockReturnValue(committed.graph)
  const pending={kind:'agent-open',operationId:'launcher-unresolved-OP',retain:{bytes:[3,4]}},view=initialMountedSpaceView(snapshot)
  useAppStore.setState({config,mountedSpaceInputs:{[key]:{target,view,drafts:{original:'Launcher unsent draft'},memberInputs:{original:{operationId:'launcher-member-OP'}}},'launcher-pending':pending},mountedSpaceObservations:{},
    activeWorkspaceId:null,tabs:Object.fromEntries(Object.entries(restored.tabs).map(([id,tab])=>[id,hydratePersistedTab(tab)])),layouts:restored.layouts,spaceZoneBindings:desktopBindingsFromSpatial(committed.graph,config),workbenchSpaceSelection:null,collapsedProjectGroups:{}})
  const transport=spaceMountTransport(cleanup,[{id:'local',carrier:{forwardRpc:async(method,params,context,fence)=>source.rpc.call(method as never,params as never,{...context as object,...(fence?{runtimeFence:fence}:{})} as never),subscribeRpc:source.rpc.subscribe.bind(source.rpc)}}])
  vi.spyOn(api.spaceMounts,'call').mockImplementation(transport.api.call)
  const input:MountedAgentOpenInput={kind:'agent-open',target,slot:{kind:'new-work',zoneId:source.folder.zoneId},request:source.input,submitted:true,receipt}
  const observerTabs=useAppStore.getState().tabs,observerLayouts=useAppStore.getState().layouts,observerSessions=useAppStore.getState().sessions,sourceRevision=(await source.spatial.read())!.revision
  await dom.render(<><SourceLauncherRequest input={input} busy={false} onContinue={vi.fn()}/><WorkspaceSidebar/></>)
  const open=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Open original work')!
  expect(open).toBeDefined();await act(async()=>open.click())
  await vi.waitFor(()=>expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(address.regionId))
  const current=useAppStore.getState()
  expect(Object.hasOwn(current,'selectedSpaceMount')).toBe(false);expect(current.activeWorkspaceId).toBe('b-workspace')
  expect(current.workbenchSpaceSelection).toMatchObject({spaceId:source.folder.spaceId,zoneId:source.folder.zoneId,workspaceId:address.workspaceId,groupId:address.groupId,tabId:address.tabId,regionId:address.regionId})
  for(const [id,tab] of Object.entries(observerTabs))expect(current.tabs[id]).toBe(tab)
  for(const [id,layout] of Object.entries(observerLayouts))expect(current.layouts[id]).toBe(layout)
  expect(current.sessions).toBe(observerSessions);expect(current.config).toBe(config)
  expect((current.mountedSpaceInputs as Record<string,unknown>)['launcher-pending']).toBe(pending)
  expect(mountedSpaceInput(current.mountedSpaceInputs,key)?.drafts.original).toBe('Launcher unsent draft')
  expect(mountedSpaceInput(current.mountedSpaceInputs,key)?.memberInputs).toEqual({original:{operationId:'launcher-member-OP'}})
  expect(mountedSpaceInput(current.mountedSpaceInputs,key)?.view).toBeUndefined()
  expect(current.mountedSpaceObservations[key]?.snapshot?.reference).toEqual(target.reference)
  expect(dom.container.querySelectorAll('[data-mounted-space-nav]')).toHaveLength(0)
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button'),dom.container.textContent ?? '').toHaveLength(clientConfigured?0:1)
  expect((await source.spatial.read())!.revision).toBe(sourceRevision)
  expect(source.client.writeAgent).not.toHaveBeenCalled();expect(source.agentInput).not.toHaveBeenCalled()
})

it('an unavailable Source stays unknown inside its ordinary owning Workspace, without a Mounted destination or data loss',async()=>{
  const fixture=await spaceMountFixture(cleanup),b=fixture.cores[1]!
  vi.spyOn(api.spaceMounts,'call').mockImplementation(fixture.api.call)
  vi.spyOn(api.spaceMounts,'watch').mockRejectedValue(Error('Original Source unavailable for this proof'))
  const resources=await api.spaceMounts.call('resources',{hostId:b.id}),project=resources.workspaces[0]!
  const registered=await api.spaceMounts.call('register',{hostId:b.id,registration:{runtimeId:resources.runtimeId,workspaceId:project.workspaceId,expectedResource:{hostId:project.hostId,workspacePath:project.path,projectRootPath:project.repoPath??project.path}}})
  const target={hostId:b.id,reference:registered.reference,zoneId:registered.zoneId,workspaceId:registered.workspaceId},key=spaceMountKey(target.reference)
  const snapshot=await fixture.api.call('snapshot',{hostId:b.id,reference:target.reference}),view=initialMountedSpaceView(snapshot)
  const inputs={[key]:{target,view,drafts:{original:'Unknown Source unsent draft'},memberInputs:{original:{operationId:'unknown-source-member-OP'}}},'unknown-source-pending':{kind:'agent-open',operationId:'unknown-source-OP'}}
  const config={...composerConfig,workspaces:[{id:project.workspaceId,name:project.name,hostId:b.id,path:project.path,kind:'folder' as const}]}
  useAppStore.setState({config,mountedSpaceInputs:inputs,mountedSpaceObservations:{[key]:{error:'Original Source unavailable for this proof',reading:false}},
    activeWorkspaceId:project.workspaceId,workbenchSpaceSelection:{spaceId:target.reference.spaceId,zoneId:target.zoneId,workspaceId:target.workspaceId,topicId:null,tabId:null,groupId:null,regionId:null},tabs:{},layouts:{},spaceZoneBindings:{}})
  await dom.render(<WorkspaceWorkbench workspaceId={project.workspaceId} visible/>)
  expect(dom.container.querySelector('.workspace-workbench')).not.toBeNull()
  expect(dom.container.textContent).toContain('Original Space observation unavailable')
  expect(dom.container.textContent).toContain('Original Source unavailable for this proof')
  expect(dom.container.querySelectorAll('[data-mounted-space-nav],[data-mounted-space]')).toHaveLength(0)
  expect(Object.hasOwn(useAppStore.getState(),'selectedSpaceMount')).toBe(false);expect(useAppStore.getState().activeWorkspaceId).toBe(project.workspaceId)
  expect(useAppStore.getState().mountedSpaceInputs).toBe(inputs);expect(useAppStore.getState().config).toBe(config)
})

async function sourceFileFixture() {
  const f=await sourceFolderFixture(cleanup),observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!}),before=(await f.spatial.read())!,graph=structuredClone(before.graph)
  const tabId='source-file-tab',regionId='source-file-region'
  graph.tabs.push({tabId,zoneId:saved.zoneId,workspaceId:saved.workspaceId,name:'Source file Tab',regionIds:[regionId]})
  graph.regions.push({regionId,tabId,kind:'file',file:{workspaceId:saved.workspaceId,path:'hello.txt'},agentSessionId:null,runId:null,execution:{hostId:'local',cwd:f.directory,runtimeId:f.source.runtimeId}})
  graph.resources[`tab:${tabId}`]={};graph.resources[`region:${regionId}`]={path:'hello.txt'}
  graph.layouts[saved.workspaceId]=createWorkspaceLayout('source-file-group',[tabId]);graph.tabLayouts[tabId]=createWorkbenchViewLayout(regionId)
  const committed=await f.spatial.commit({expectedRevision:before.revision,graph}),target={hostId:'local',reference:saved.reference,zoneId:saved.zoneId,workspaceId:saved.workspaceId}
  const transport=spaceMountTransport(cleanup,[{id:'local',carrier:{forwardRpc:async(method,params,context,fence)=>f.rpc.call(method as never,params as never,{...context as object,...(fence?{runtimeFence:fence}:{})} as never),subscribeRpc:f.rpc.subscribe.bind(f.rpc)}}])
  vi.spyOn(api.spaceMounts,'call').mockImplementation(transport.api.call)
  const runtime=Object.assign(Object.create(RuntimeController.prototype),{hosts:transport.routes,hostReconfigurationReservations:new Map()}) as RuntimeController
  const bridge=sourceFilesIpcBridge(runtime,cleanup)
  vi.spyOn(api.sourceFiles,'call').mockImplementation(bridge.files.call)
  vi.spyOn(api.sourceFiles,'resolve').mockImplementation(bridge.files.resolve)
  vi.spyOn(storeModule,'currentCoreSpatialGraph').mockReturnValue(committed.graph)
  const snapshot=await readSpaceSnapshot(f.rpc,saved.reference)
  return {...f,saved,target,key:spaceMountKey(saved.reference),tabId,regionId,snapshot}
}

it('Source files read, edit and save through their own authority without colliding with same-ID local resources',async()=>{
  const f=await sourceFileFixture(),collision={id:f.saved.workspaceId,name:'Wrong local resource',hostId:'wrong-local',path:'/wrong/local',kind:'folder' as const}
  const localDocument={content:'LOCAL collision buffer\n',path:'hello.txt',revision:'local-revision'}
  useAppStore.setState({config:{...composerConfig,workspaces:[collision]},mountedSpaceInputs:{},mountedSpaceObservations:{},sourceFilesInputs:emptySourceFilesInputs(),
    documents:{[documentKey(f.saved.workspaceId,'hello.txt')]:localDocument},activeWorkspaceId:null,workbenchSpaceSelection:null,tabs:{},layouts:{},spaceZoneBindings:{}})
  useAppStore.getState().mountSpace(f.target)
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  await dom.render(<WorkspaceWorkbench workspaceId={originalSourceWorkspaceId(f.target)} visible/>)
  const sourceWorkspaceId=originalSourceFileWorkspaceId(f.target,f.saved.workspaceId)
  const sourceKey=documentKey(sourceWorkspaceId,'hello.txt'),displayTabId=originalSourceTabProjectionId(f.target,f.tabId),displayRegionId=originalSourceRegionProjectionId(f.target,f.regionId)
  await vi.waitFor(()=>expect(useAppStore.getState().documents[sourceKey]?.content,dom.container.textContent??'').toBe('Source original file\n'))
  expect(originalSpaceWorkspace(useAppStore.getState(),f.saved.workspaceId)).toMatchObject({id:f.saved.workspaceId,hostId:'local',path:f.directory})
  expect(useAppStore.getState().documents[documentKey(f.saved.workspaceId,'hello.txt')]).toBe(localDocument)
  await act(async()=>useAppStore.getState().updateDocument(displayTabId,'Source edited file\n',displayRegionId))
  expect(useAppStore.getState().documents[sourceKey]?.content).toBe('Source edited file\n')
  expect(useAppStore.getState().documents[documentKey(f.saved.workspaceId,'hello.txt')]).toBe(localDocument)
  await act(async()=>{await useAppStore.getState().saveDocument(displayTabId,displayRegionId)})
  expect(useAppStore.getState().documents[documentKey(f.saved.workspaceId,'hello.txt')]).toBe(localDocument)
  const observed=await f.rpc.call('file.read',{zoneId:f.saved.zoneId,path:'hello.txt',expectedResource:{hostId:'local',workspaceId:f.saved.workspaceId,workspacePath:f.directory}})
  expect(observed.result).toMatchObject({status:'read',document:{content:'Source edited file\n'}})
})

it('an unavailable Source file read stays unknown and never falls back to the local file authority',async()=>{
  const f=await sourceFileFixture()
  useAppStore.setState({config:{...composerConfig,workspaces:[]},mountedSpaceInputs:{},mountedSpaceObservations:{},sourceFilesInputs:emptySourceFilesInputs(),documents:{},activeWorkspaceId:null,workbenchSpaceSelection:null,tabs:{},layouts:{},spaceZoneBindings:{}})
  useAppStore.getState().mountSpace(f.target)
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  const sourceCall=vi.mocked(api.sourceFiles.call),originalCall=sourceCall.getMockImplementation()!
  sourceCall.mockImplementation(async(...args)=>args[1]==='file.read'?Promise.reject(new Error('Original Source read unavailable')):originalCall(...args))
  const localRead=vi.spyOn(api.files,'read').mockResolvedValue({status:'read',document:{path:'hello.txt',content:'LOCAL substitute\n',revision:'local-substitute'}})
  await dom.render(<WorkspaceWorkbench workspaceId={originalSourceWorkspaceId(f.target)} visible/>)
  const sourceKey=documentKey(originalSourceFileWorkspaceId(f.target,f.saved.workspaceId),'hello.txt')
  await vi.waitFor(()=>{const state=useAppStore.getState();expect(Boolean(state.documents[sourceKey]||state.documentIssues[sourceKey])).toBe(true)})
  expect(useAppStore.getState().documentIssues[sourceKey]).toMatchObject({kind:'read-error',code:'WORKSPACE_FILE_READ_FAILED',message:expect.stringContaining('Original Source read unavailable')})
  expect(useAppStore.getState().documents[sourceKey]).toBeUndefined()
  expect(localRead).not.toHaveBeenCalled()
})

it('an unconfirmed Source locator never falls back to the local file authority',async()=>{
  const f=await sourceFileFixture()
  useAppStore.setState({config:{...composerConfig,workspaces:[]},mountedSpaceInputs:{},mountedSpaceObservations:{},sourceFilesInputs:emptySourceFilesInputs(),documents:{},activeWorkspaceId:null,workbenchSpaceSelection:null,tabs:{},layouts:{},spaceZoneBindings:{}})
  useAppStore.getState().mountSpace(f.target)
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  vi.mocked(api.sourceFiles.resolve).mockResolvedValue({status:'unconfirmed',issue:{code:'SOURCE_LOCATOR_UNCONFIRMED',message:'Original Source locator unavailable'}} as never)
  const localRead=vi.spyOn(api.files,'read').mockResolvedValue({status:'read',document:{path:'hello.txt',content:'LOCAL substitute\n',revision:'local-substitute'}})
  await dom.render(<WorkspaceWorkbench workspaceId={originalSourceWorkspaceId(f.target)} visible/>)
  const sourceKey=documentKey(originalSourceFileWorkspaceId(f.target,f.saved.workspaceId),'hello.txt')
  await vi.waitFor(()=>{const state=useAppStore.getState();expect(Boolean(state.documents[sourceKey]||state.documentIssues[sourceKey])).toBe(true)})
  expect(useAppStore.getState().documentIssues[sourceKey]).toMatchObject({kind:'read-error',code:'FILE_SOURCE_UNAVAILABLE'})
  expect(useAppStore.getState().documents[sourceKey]).toBeUndefined()
  expect(localRead).not.toHaveBeenCalled()
})

it('a selected Zone renders only its own Source occurrences and not sibling Zone members',async()=>{
  const f=await sourceFolderFixture(cleanup),observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const first=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!}),secondPath=join(f.root,'second-folder')
  await mkdir(secondPath)
  const second=await f.spatial.registerDirectory({runtimeId:f.source.runtimeId,directory:{hostId:'local',workspacePath:secondPath,projectRootPath:f.directory,witness:{realPath:secondPath,device:'controlled',inode:'controlled'}}},async()=>[],async()=>{})
  expect(second.spaceId).toBe(first.reference.spaceId)
  const before=(await f.spatial.read())!,graph=structuredClone(before.graph)
  graph.tabs.push({tabId:'first-zone-tab',zoneId:first.zoneId,workspaceId:first.workspaceId,name:'First Zone work',regionIds:['first-zone-region']})
  graph.regions.push({regionId:'first-zone-region',tabId:'first-zone-tab',kind:'launcher',agentSessionId:null,runId:null,execution:{hostId:'local',cwd:f.directory,runtimeId:f.source.runtimeId}})
  graph.tabs.push({tabId:'second-zone-tab',zoneId:second.zoneId,workspaceId:second.workspaceId,name:'Second Zone work',regionIds:['second-zone-region']})
  graph.regions.push({regionId:'second-zone-region',tabId:'second-zone-tab',kind:'launcher',agentSessionId:null,runId:null,execution:{hostId:'local',cwd:secondPath,runtimeId:f.source.runtimeId}})
  for(const tabId of ['first-zone-tab','second-zone-tab'])graph.resources[`tab:${tabId}`]={}
  for(const regionId of ['first-zone-region','second-zone-region'])graph.resources[`region:${regionId}`]={}
  graph.layouts[first.workspaceId]=createWorkspaceLayout('first-zone-group',['first-zone-tab']);graph.tabLayouts['first-zone-tab']=createWorkbenchViewLayout('first-zone-region')
  graph.layouts[second.workspaceId]=createWorkspaceLayout('second-zone-group',['second-zone-tab']);graph.tabLayouts['second-zone-tab']=createWorkbenchViewLayout('second-zone-region')
  const committed=await f.spatial.commit({expectedRevision:before.revision,graph}),target={hostId:'local',reference:first.reference,zoneId:first.zoneId,workspaceId:first.workspaceId}
  const snapshot=await readSpaceSnapshot(f.rpc,first.reference)
  vi.spyOn(storeModule,'currentCoreSpatialGraph').mockReturnValue(committed.graph)
  useAppStore.setState({config:{...composerConfig,workspaces:[]},mountedSpaceInputs:{},mountedSpaceObservations:{},activeWorkspaceId:null,workbenchSpaceSelection:null,tabs:{},layouts:{},spaceZoneBindings:{}})
  useAppStore.getState().mountSpace(target)
  useAppStore.getState().observeSpaceMount(target,{snapshot,reading:false})
  await dom.render(<WorkspaceWorkbench workspaceId={originalSourceWorkspaceId(target)} visible/>)
  const firstTabId=originalSourceTabProjectionId(target,'first-zone-tab'),secondTabId=originalSourceTabProjectionId(target,'second-zone-tab')
  const firstRegionId=originalSourceRegionProjectionId(target,'first-zone-region'),secondRegionId=originalSourceRegionProjectionId(target,'second-zone-region')
  const tab=(id:string)=>[...dom.container.querySelectorAll<HTMLElement>('[data-workbench-tab-id]')].find(element=>element.dataset.workbenchTabId===id)
  const region=(id:string)=>[...dom.container.querySelectorAll<HTMLElement>('[data-workbench-region-id]')].find(element=>element.dataset.workbenchRegionId===id)
  await vi.waitFor(()=>expect(tab(firstTabId)).toBeDefined())
  expect(tab(secondTabId)).toBeUndefined()
  expect(region(firstRegionId)?.closest('[inert]')).toBeNull()
  expect(region(secondRegionId)).toBeUndefined()
})

it('Source structural actions refuse local ownership instead of silently mutating an unrelated local graph',async()=>{
  const f=await sourceFileFixture(),store=useAppStore.getState()
  useAppStore.setState({config:{...composerConfig,workspaces:[]},mountedSpaceInputs:{},mountedSpaceObservations:{},activeWorkspaceId:null,workbenchSpaceSelection:null,tabs:{},layouts:{},spaceZoneBindings:{}})
  useAppStore.getState().mountSpace(f.target)
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  const before=useAppStore.getState(),report=vi.spyOn(before,'reportError')
  await expect(store.prepareWorkbenchClose({target:{kind:'tab-occurrence',displayWorkspaceId:f.saved.workspaceId,groupId:'source-file-group',tabId:f.tabId},keepAgentSessions:false})).rejects.toThrow(/Source/)
  store.splitRegion(f.saved.workspaceId,f.tabId,f.regionId,'right')
  store.moveTabToNewGroup(f.saved.workspaceId,f.tabId,'source-file-group','source-file-group','right')
  await expect(store.renameTab(f.tabId,'Wrong local rename')).resolves.toBe(false)
  await expect(store.renameAgent('original-agent','Wrong local Agent rename')).resolves.toBe(false)
  expect(report).toHaveBeenCalledWith(expect.objectContaining({message:expect.stringMatching(/Source/)}))
  const after=useAppStore.getState()
  expect(after.tabs).toBe(before.tabs);expect(after.layouts).toBe(before.layouts);expect(after.config).toBe(before.config)
  expect(Object.hasOwn(after,'selectedSpaceMount')).toBe(false)
})

it('Source split ratios use only ordinary projected layouts and never create private view inputs',async()=>{
  const f=await sourceFileFixture()
  useAppStore.setState({config:{...composerConfig,workspaces:[]},mountedSpaceInputs:{},mountedSpaceObservations:{},activeWorkspaceId:null,workbenchSpaceSelection:null,tabs:{},layouts:{},spaceZoneBindings:{}})
  useAppStore.getState().mountSpace(f.target)
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  const workspaceId=originalSourceWorkspaceId(f.target),tabId=originalSourceTabProjectionId(f.target,f.tabId),regionId=originalSourceRegionProjectionId(f.target,f.regionId)
  const projected=useAppStore.getState(),composition=projected.layouts[workspaceId]!,tabLayout=projected.tabs[tabId]!.layout,secondGroupId=originalSourceGroupProjectionId(f.target,'second-source-group')
  useAppStore.setState(state=>({layouts:{...state.layouts,[workspaceId]:{...composition,
    root:{type:'split',direction:'horizontal',ratio:.67,first:composition.root,second:{type:'leaf',groupId:secondGroupId}},
    groups:[...composition.groups,{id:secondGroupId,tabOrder:[],activeTabId:null,recentTabIds:[]}]}},
    tabs:{...state.tabs,[tabId]:{...state.tabs[tabId]!,layout:splitWorkbenchRegion(tabLayout,regionId,'right',originalSourceRegionProjectionId(f.target,'retained-region'))}}}))
  const before=useAppStore.getState(),privateInputs=before.mountedSpaceInputs
  expect(mountedSpaceInput(privateInputs,f.key)?.view).toBeUndefined()
  await act(async()=>{
    useAppStore.getState().updateSplitRatio(workspaceId,'',.32)
    useAppStore.getState().updateRegionSplitRatio(workspaceId,tabId,'',.41)
  })
  const after=useAppStore.getState()
  expect(after.layouts[workspaceId]!.root).toMatchObject({type:'split',ratio:.32})
  expect(after.tabs[tabId]!.layout.root).toMatchObject({type:'split',ratio:.41})
  expect(after.mountedSpaceInputs).toBe(privateInputs)
  expect(mountedSpaceInput(after.mountedSpaceInputs,f.key)?.view).toBeUndefined()
  const persisted=useAppStore.persist.getOptions().partialize!(after)
  expect(persisted.mountedSpaceInputs).toBe(after.mountedSpaceInputs)
  expect(after.config).toBe(before.config)
})

it('unknown and null Source observations retain the last confirmed ordinary projection and private inputs',async()=>{
  const f=await sourceFileFixture()
  useAppStore.setState({config:{...composerConfig,workspaces:[]},mountedSpaceInputs:{},mountedSpaceObservations:{},activeWorkspaceId:null,workbenchSpaceSelection:null,tabs:{},layouts:{},spaceZoneBindings:{}})
  useAppStore.getState().mountSpace(f.target)
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  const confirmed=useAppStore.getState(),tabs=confirmed.tabs,layouts=confirmed.layouts,inputs=confirmed.mountedSpaceInputs,sessions=confirmed.sessions,sourceRevision=(await f.spatial.read())!.revision
  expect(Object.keys(tabs)).not.toHaveLength(0);expect(layouts[originalSourceWorkspaceId(f.target)]).toBeDefined()
  useAppStore.getState().observeSpaceMount(f.target,{error:'Source observation unknown',reading:false})
  expect(useAppStore.getState().tabs).toBe(tabs);expect(useAppStore.getState().layouts).toBe(layouts)
  const unavailable=structuredClone(f.snapshot)
  unavailable.scope={...unavailable.scope,space:null,tabs:[],regions:[]}
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:unavailable,error:'Source observation null',reading:false})
  const current=useAppStore.getState()
  expect(current.tabs).toBe(tabs);expect(current.layouts).toBe(layouts);expect(current.mountedSpaceInputs).toBe(inputs);expect(current.sessions).toBe(sessions)
  expect(current.mountedSpaceObservations[f.key]?.snapshot?.scope.space).toBeNull()
  expect(current.mountedSpaceObservations[f.key]?.lastPresentSnapshot).toBe(f.snapshot)
  expect(current.mountedSpaceObservations[f.key]?.error).toBe('Source observation null')
  expect((await f.spatial.read())!.revision).toBe(sourceRevision)
})

it('implicit Source viewing and auxiliary actions never prewarm or create local Terminal, Agent, Browser, Note or Launcher substitutes',async()=>{
  const f=await settingsFixture(false,'source-B')
  const launchTerminal=vi.spyOn(api.sessions,'launchTerminal').mockRejectedValue(Error('Local Terminal must not be created'))
  const prewarmTerminal=vi.spyOn(useAppStore.getState(),'prewarmTerminal')
  const launchAgent=vi.spyOn(api.sessions,'launchAgent').mockRejectedValue(Error('Local Agent must not be created'))
  const localLaunchAgent=vi.spyOn(useAppStore.getState(),'launchAgent').mockRejectedValue(Error('Local Agent action must not be attempted'))
  const openLauncher=vi.spyOn(useAppStore.getState(),'openLauncher')
  const createBrowser=vi.spyOn(useAppStore.getState(),'createBrowser').mockRejectedValue(Error('Local Browser must not be created'))
  const createNote=vi.spyOn(useAppStore.getState(),'createNote').mockRejectedValue(Error('Local Note must not be created'))
  const openScratchTopic=vi.spyOn(useAppStore.getState(),'openScratchTopic').mockResolvedValue(true)
  vi.spyOn(useAppStore.getState(),'refreshScratchTopics').mockResolvedValue(undefined)
  const ensureMote=vi.spyOn(api.scratch,'ensureMote').mockResolvedValue({} as never)
  useAppStore.getState().mountSpace(f.target)
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  const workspaceId=useAppStore.getState().activeWorkspaceId!,draftRegionId=originalSourceRegionProjectionId(f.target,f.regionId),heldDraft='Original Source unsent Mote draft'
  const mote={...createWorkbenchTab('implicit-source-mote',{regionId:'implicit-source-mote-region',kind:'launcher',workspaceId:SCRATCH_WORKSPACE_ID}),topicId:PMO_TEAMS_TOPIC_ID}
  const scratch={id:SCRATCH_WORKSPACE_ID,name:'Scratch',path:'/original-source-scratch',hostId:'local',kind:'folder' as const}
  useAppStore.setState(state=>({config:{...state.config!,workspaces:[...state.config!.workspaces,scratch]},tabs:{...state.tabs,[mote.id]:mote},
    layouts:{...state.layouts,[SCRATCH_WORKSPACE_ID]:createWorkspaceLayout('implicit-source-mote-group',[mote.id])},agentComposerDrafts:{...state.agentComposerDrafts,[draftRegionId]:heldDraft}}))
  useLauncherState.getState().setSection(workspaceId,'terminal','expanded')
  useLauncherState.getState().setSection(workspaceId,'browser','expanded')
  useLauncherState.getState().setSection(workspaceId,'note','expanded')
  await dom.render(<WorkspaceWorkbench workspaceId={workspaceId} visible/>)
  await vi.waitFor(async()=>{await act(async()=>{});expect(dom.container.querySelector('[aria-label="Original Space task draft"]')).not.toBeNull()})
  expect(prewarmTerminal).not.toHaveBeenCalled()
  expect(launchTerminal).not.toHaveBeenCalled()
  expect(launchAgent).not.toHaveBeenCalled()
  expect(localLaunchAgent).not.toHaveBeenCalled()
  expect(openLauncher).not.toHaveBeenCalled()
  expect(createBrowser).not.toHaveBeenCalled()
  expect(createNote).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('unavailable')
  const browserSubmit=dom.container.querySelector<HTMLButtonElement>('[aria-label="Go to Browser address or search"]')
  expect(browserSubmit?.disabled).toBe(true)
  await act(async()=>browserSubmit?.click())
  for(const label of ['Open Terminal','Create blank note']) {
    const button=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent===label)
    expect(button,label).toBeDefined();expect(button?.disabled).toBe(true)
    if(button) await act(async()=>button.click())
  }
  expect(launchTerminal).not.toHaveBeenCalled();expect(launchAgent).not.toHaveBeenCalled();expect(openLauncher).not.toHaveBeenCalled()
  expect(createBrowser).not.toHaveBeenCalled();expect(createNote).not.toHaveBeenCalled()
  const moteAction=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent?.includes('Discuss with'))
  expect(moteAction).toBeDefined();expect(moteAction?.getAttribute('title')).toContain('Send this task to')
  await act(async()=>moteAction!.click())
  expect(useAppStore.getState().agentComposerDrafts[draftRegionId]).toBe(heldDraft)
  expect(localLaunchAgent).not.toHaveBeenCalled()
  expect(ensureMote).not.toHaveBeenCalled()
  expect(openScratchTopic).not.toHaveBeenCalled()
  expect(prewarmTerminal).not.toHaveBeenCalled()
  expect(launchTerminal).not.toHaveBeenCalled();expect(launchAgent).not.toHaveBeenCalled();expect(openLauncher).not.toHaveBeenCalled()
  expect(createBrowser).not.toHaveBeenCalled();expect(createNote).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[draftRegionId]).toBe(heldDraft)
})
