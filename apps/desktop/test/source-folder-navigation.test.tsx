// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { SourceFolderNavigation, useSourceFolderNavigation, sourceFolderMatchesWorkspace } from '../src/renderer/src/components/SourceFolderNavigation'
import { originalSourceEntryForSelection, originalSourceGroupProjectionId, originalSourceRegionProjectionId, originalSourceTabProjectionId, originalSourceWorkspaceId } from '../src/renderer/src/lib/original-space-navigation'
import { restoreWorkbenchSpaceSelection } from '../src/renderer/src/lib/desktop-focus-navigation'
import * as store from '../src/renderer/src/store'
import { useAppStore } from '../src/renderer/src/store'
import { initialMountedSpaceView, openSourceFolderInput, mountedSpaceInput } from '../src/renderer/src/lib/space-mount-view'
import { desktopBindingsFromSpatial, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { hydratePersistedTab } from '../src/renderer/src/lib/workbench-persistence'
import { spaceMountKey } from '../src/shared/space-mount'
import { createWorkbenchViewLayout, createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { composerDOM, composerConfig } from './helpers/composer-dom-fixture'
import { sourceFolderFixture } from '../../../packages/core/test/helpers/space-folder-directory-fixture'
import { readSpaceSnapshot } from '../../../packages/core/src/space-authority-stream'
import { folderDirectoryFacts } from '@agentmux/core/space-folder-resources'

const dom=composerDOM(), cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function source(regions = ['original-region']) {
  const f=await sourceFolderFixture(cleanup), observed=await f.rpc.call('space.folder.inspect',{runtimeId:f.source.runtimeId,path:f.directory})
  const saved=await f.rpc.call('space.folder.register',{runtimeId:f.source.runtimeId,directory:observed.resource!})
  const before=(await f.spatial.read())!, graph=structuredClone(before.graph), tabId='original-tab'
  graph.tabs.push({tabId,zoneId:saved.zoneId,workspaceId:saved.workspaceId,name:'Original exact work',regionIds:regions})
  for(const regionId of regions) {
    graph.regions.push({regionId,tabId,kind:'launcher',agentSessionId:null,runId:null,execution:{hostId:'local',cwd:f.directory,runtimeId:f.source.runtimeId}})
    graph.resources[`region:${regionId}`]={}
  }
  graph.resources[`tab:${tabId}`]={}
  graph.layouts[saved.workspaceId]=createWorkspaceLayout('original-group',[tabId])
  graph.tabLayouts[tabId]=regions.reduce((layout,regionId,index)=>index===0?layout:splitWorkbenchRegion(layout,layout.activeRegionId,'right',regionId),createWorkbenchViewLayout(regions[0]!))
  const committed=await f.spatial.commit({expectedRevision:before.revision,graph})
  const target={hostId:'local',reference:saved.reference,zoneId:saved.zoneId,workspaceId:saved.workspaceId}, key=spaceMountKey(saved.reference)
  const config={...composerConfig,workspaces:[]}, restored=desktopWorkbenchFromSpatial(committed.graph)
  // The external leaf is the accepted Core graph read. All graph data comes from the real Source owner above.
  vi.spyOn(store,'currentCoreSpatialGraph').mockReturnValue(committed.graph)
  useAppStore.setState({config,mountedSpaceInputs:{},collapsedProjectGroups:{},activeWorkspaceId:null,
    tabs:Object.fromEntries(Object.entries(restored.tabs).map(([id,tab])=>[id,hydratePersistedTab(tab)])),layouts:restored.layouts,spaceZoneBindings:desktopBindingsFromSpatial(committed.graph,config),workbenchSpaceSelection:null})
  const snapshot=await readSpaceSnapshot(f.rpc,saved.reference)
  return {...f,saved,graph:committed.graph,target,key,tabId,regions,snapshot}
}
function Navigation(){const navigation=useSourceFolderNavigation('');return <SourceFolderNavigation navigation={navigation}/>}
const exactSelection=(f:Awaited<ReturnType<typeof source>>,regionId=f.regions[0]!)=>({spaceId:f.saved.reference.spaceId,zoneId:f.saved.zoneId,workspaceId:originalSourceWorkspaceId(f.target),
  groupId:originalSourceGroupProjectionId(f.target,'original-group'),tabId:originalSourceTabProjectionId(f.target,f.tabId),regionId:originalSourceRegionProjectionId(f.target,regionId)})


it('a new Source Folder reaches the ordinary Sidebar without config injection, and its explicit click selects the unique original Region',async()=>{
  const f=await source(), before=useAppStore.getState(), originalInput=before.mountedSpaceInputs, config=before.config
  const disk=await readFile(f.configurationPath,'utf8')
  await dom.render(<WorkspaceSidebar/>)
  expect(dom.container.querySelector('[data-folder-host="local"] [aria-label="Source Folder projects"]')?.textContent).toContain('selected-folder')
  expect(dom.container.textContent).not.toContain('Open a folder to get started.')
  expect(useAppStore.getState().mountedSpaceInputs).toBe(originalInput)
  expect(useAppStore.getState().config).toBe(config)
  await dom.click('[aria-label="Source Folder projects"] button')
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  const current=useAppStore.getState()
  expect(Object.hasOwn(current,'selectedSpaceMount')).toBe(false)
  expect(current.activeWorkspaceId).toBe(originalSourceWorkspaceId(f.target))
  expect(current.workbenchSpaceSelection).toMatchObject(exactSelection(f))
  expect(mountedSpaceInput(current.mountedSpaceInputs,f.key)).toMatchObject({target:f.target,drafts:{}})
  expect(current.tabs[f.tabId]).toBe(before.tabs[f.tabId]);for(const [id,layout] of Object.entries(before.layouts))expect(current.layouts[id]).toBe(layout)
  expect(current.config!.workspaces).toEqual([]);expect(await readFile(f.configurationPath,'utf8')).toBe(disk)
  const file=await f.rpc.call('file.read',{zoneId:f.saved.zoneId,path:'hello.txt',expectedResource:{hostId:'local',workspaceId:f.saved.workspaceId,workspacePath:f.directory}})
  expect(file.result).toMatchObject({status:'read',document:{content:'Source original file\n'}})
})


it('an existing explicit mount stays in the original Folder partition once and preserves drafts, member operations and opaque neighbours without a private view',async()=>{
  const f=await source(), member={kind:'space-member-input',target:f.target,view:initialMountedSpaceView(f.snapshot),drafts:{original:'Keep original draft'},memberInputs:{original:{operationId:'original-input-OP',text:'Keep bytes'}},opaque:{future:[1,2]}}
  const neighbour={kind:'future-version',bytes:'unaltered'}, pending={kind:'agent-open',operationId:'unresolved-original-OP',opaque:{keep:true}}
  useAppStore.setState({mountedSpaceInputs:{[f.key]:member,neighbour,'pending-operation':pending}})
  await dom.render(<Navigation/>)
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button')).toHaveLength(1)
  expect(dom.container.querySelectorAll('[data-mounted-space-nav]')).toHaveLength(0)
  await dom.click('[aria-label="Source Folder projects"] button')
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  const current=useAppStore.getState(), result=current.mountedSpaceInputs as Record<string,unknown>
  const {kind: _kind, view: _view, ...retainedMember}=member
  expect(result[f.key]).toMatchObject(retainedMember)
  expect((result[f.key] as {kind?:unknown}).kind).toBeUndefined()
  expect(result.neighbour).toBe(neighbour);expect(result['pending-operation']).toBe(pending)
  expect(mountedSpaceInput(result,f.key)?.view).toBeUndefined()
  expect(Object.hasOwn(current,'selectedSpaceMount')).toBe(false)
  expect(current.workbenchSpaceSelection).toMatchObject({...exactSelection(f),groupId:current.layouts[originalSourceWorkspaceId(f.target)]!.activeGroupId})
  expect(dom.container.querySelector('[aria-label="Mounted Spaces"]')).toBeNull()
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button')).toHaveLength(1)
  await act(async()=>useAppStore.setState({mountedSpaceInputs:{[f.key]:{target:f.target,drafts:{original:'Retained'}}}}))
  expect(dom.container.querySelectorAll('[data-mounted-space-nav]')).toHaveLength(0)
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button')).toHaveLength(1)
})


it('a configured resource reuses its original project row and that row opens the exact Source occurrence without config writes',async()=>{
  const f=await source(), configured={id:f.saved.workspaceId,name:'Configured original',hostId:'local',path:f.directory,kind:'folder' as const}
  const config={...composerConfig,workspaces:[configured]}
  useAppStore.setState({config,spaceZoneBindings:desktopBindingsFromSpatial(f.graph,config)})
  const disk=await readFile(f.configurationPath,'utf8')
  await dom.render(<WorkspaceSidebar/>)
  expect(dom.container.querySelectorAll('[aria-label="Source Folder projects"] button')).toHaveLength(0)
  expect(dom.container.querySelectorAll('[data-mounted-space-nav]')).toHaveLength(0)
  const row=dom.container.querySelector<HTMLButtonElement>(`[data-workspace-id="${f.saved.workspaceId}"]`)!
  expect(row.textContent).toContain('Configured original')
  await act(async()=>row.click())
  useAppStore.getState().observeSpaceMount(f.target,{snapshot:f.snapshot,reading:false})
  expect(useAppStore.getState().activeWorkspaceId).toBe(originalSourceWorkspaceId(f.target))
  expect(Object.hasOwn(useAppStore.getState(),'selectedSpaceMount')).toBe(false)
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject(exactSelection(f))
  expect(useAppStore.getState().config!.workspaces).toEqual([configured])
  expect(await readFile(f.configurationPath,'utf8')).toBe(disk)
  const opaque={[f.key]:{kind:'unknown-future',target:f.target,drafts:{keep:'unchanged'}}}
  expect(()=>openSourceFolderInput(opaque,f.target)).toThrow('unreadable')
  expect(opaque[f.key]!.drafts.keep).toBe('unchanged')
  const futureDecoration={[f.key]:{target:f.target,navigation:'future-style',drafts:{keep:'original input'},memberInputs:{original:{operationId:'retained-OP'}}}}
  expect(mountedSpaceInput(futureDecoration,f.key)?.drafts.keep).toBe('original input')
  expect(futureDecoration[f.key]!.memberInputs.original.operationId).toBe('retained-OP')
})


it('a Folder with several original Regions selects its Zone without guessing the first Region',async()=>{
  const f=await source(['first-region','second-region'])
  await dom.render(<WorkspaceSidebar/>)
  await dom.click('[aria-label="Source Folder projects"] button')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({spaceId:f.saved.reference.spaceId,zoneId:f.saved.zoneId,workspaceId:originalSourceWorkspaceId(f.target),tabId:null,groupId:null,regionId:null})
  expect(Object.hasOwn(useAppStore.getState(),'selectedSpaceMount')).toBe(false)
})

it('Source ownership never accepts a different carrier merely because both resources use the Core-local host alias',async()=>{
  const f=await source(),workspace={id:f.saved.workspaceId,hostId:'local',path:f.directory,repoPath:undefined}
  const fact={runtimeId:f.target.reference.runtimeId,spaceId:f.target.reference.spaceId,zoneId:f.target.zoneId,
    resource:{id:f.saved.workspaceId,hostId:'local',path:f.directory,name:'Original Source',kind:'folder' as const},carrierHostId:'another-carrier'}
  expect(sourceFolderMatchesWorkspace(fact,workspace)).toBe(false)
  expect(sourceFolderMatchesWorkspace({...fact,carrierHostId:'local'},workspace)).toBe(true)
})

it('multiple legal Sources remain explicitly selectable and the chosen Runtime survives persistence without borrowing an ordinary occurrence',async()=>{
  const f=await source(),resource={id:f.saved.workspaceId,hostId:'local',path:f.directory,name:'Original Source',kind:'folder' as const}
  const configured={id:f.saved.workspaceId,name:'Configured original',hostId:'local',path:f.directory,kind:'folder' as const}
  const other={hostId:'local',reference:{runtimeId:'other-source-runtime',spaceId:f.target.reference.spaceId},zoneId:f.target.zoneId,workspaceId:f.target.workspaceId},otherKey=spaceMountKey(other.reference)
  expect(folderDirectoryFacts(f.graph).folders.some(fact=>fact.runtimeId===other.reference.runtimeId)).toBe(false)
  const config={...composerConfig,workspaces:[configured]}
  useAppStore.setState({config,spaceZoneBindings:desktopBindingsFromSpatial(f.graph,config),mountedSpaceInputs:{
    [f.key]:{target:f.target,resource,drafts:{}},[otherKey]:{target:other,resource,drafts:{}}}})
  await dom.render(<WorkspaceSidebar/>)
  const choices=dom.container.querySelectorAll<HTMLButtonElement>(`[aria-label="Original Source occurrences for Configured original"] button`)
  expect(choices,dom.container.textContent??'').toHaveLength(2)
  const selected=Array.from(choices).find(button=>button.textContent?.includes('other-source-runtime'))!
  await act(async()=>selected.click())
  const current=useAppStore.getState()
  expect(current.workbenchSpaceSelection).toMatchObject({sourceRuntimeId:'other-source-runtime',spaceId:other.reference.spaceId,zoneId:other.zoneId,workspaceId:originalSourceWorkspaceId(other),tabId:null,regionId:null})
  expect(originalSourceEntryForSelection(current)?.target).toEqual(other)
  expect(current.tabs[f.tabId]?.layout.activeRegionId).toBe('original-region')
  const restored=restoreWorkbenchSpaceSelection(useAppStore.persist.getOptions().partialize!(current).workbenchSpaceSelection)
  expect(restored).toMatchObject({sourceRuntimeId:'other-source-runtime',spaceId:other.reference.spaceId,zoneId:other.zoneId,workspaceId:originalSourceWorkspaceId(other)})
})
