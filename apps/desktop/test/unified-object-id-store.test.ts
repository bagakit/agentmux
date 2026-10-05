import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { composerSession } from './helpers/composer-dom-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { isObjectId } from '@agentmux/core/object-id'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, initialWorkbenchRegionId, sessionTabId } from '../src/renderer/src/lib/workbench-tabs'
const baseline = useAppStore.getState()
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(baseline, true); localStorage.clear() })
it('real Store creates Launcher Tab, Group and split Region with shared opaque IDs and preserves a retained Session view', async () => {
  const config = { ...await api.config.get(), workspaces:[{id:'w',hostId:'local',path:_hygiene_fixturePath("w"),kind:'folder' as const,name:'W'}] }
  const original = createWorkbenchTab('session:old-agent', { kind:'agent', regionId:'region:old-agent', workspaceId:'w', sessionId:'old-agent', phase:'attached' })
  useAppStore.setState({ config, tabs:{[original.id]:original}, layouts:{w:createWorkspaceLayout('old-group',[original.id])}, activeWorkspaceId:'w', sessions:[], closingWorkbenchViews:{}, spaceZoneBindings:{}, spatialRequests:{} })
  const address = useAppStore.getState().openLauncher({workspaceId:'w',tabGroupId:'old-group',reveal:false})
  const opened = Object.values(useAppStore.getState().tabs).find(tab=>tab.id!==original.id)!
  expect(opened).toBeDefined(); expect(isObjectId(opened.id)).toBe(true); expect(isObjectId(opened.titleRegionId)).toBe(true)
  useAppStore.getState().splitRegion('w',opened.id,opened.titleRegionId,'right')
  const split = useAppStore.getState().tabs[opened.id]!
  expect(Object.keys(split.regions)).toHaveLength(2); for(const id of Object.keys(split.regions)) expect(isObjectId(id)).toBe(true)
  expect(useAppStore.getState().tabs[original.id]).toBe(original)
  expect(address).toBeDefined()
})
it('real Store file opening and rename retain the original Tab, Region, references and draft', async () => {
  const config = { ...await api.config.get(), workspaces:[{id:'w',hostId:'local',path:_hygiene_fixturePath("w"),kind:'folder' as const,name:'W'}] }
  const original=createWorkbenchTab('file:w:src/original.ts',{kind:'file',regionId:'region:file:w:src/original.ts',workspaceId:'w',path:'src/original.ts'})
  useAppStore.setState({config,tabs:{[original.id]:original},layouts:{w:createWorkspaceLayout('old-group',[original.id])},activeWorkspaceId:'w',documents:{'w\0src/original.ts':{path:'src/original.ts',content:'held unsaved draft',revision:'disk'}},dirtyDocuments:{'w\0src/original.ts':true},documentGenerations:{},documentObservationGenerations:{},documentIssues:{},savingDocuments:{},fileExplorerStates:{},lastActiveFileByWorkspace:{},closingWorkbenchViews:{},spaceZoneBindings:{},spatialRequests:{}})
  vi.spyOn(api.files,'read').mockImplementation(async (_workspaceId,path)=>({status:'read',document:{path,content:'disk bytes',revision:'disk'}}))
  vi.spyOn(api.files,'observe').mockResolvedValue(undefined)
  await useAppStore.getState().openFile('src/original.ts','old-group',undefined,'w',true)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([original.id])
  expect(useAppStore.getState().tabs[original.id]!.layout.activeRegionId).toBe(original.titleRegionId)
  expect(useAppStore.getState().documents['w\0src/original.ts']?.content).toBe('held unsaved draft')
  const reference={displayWorkspaceId:'w',groupId:'old-group',tabId:original.id,regionId:original.titleRegionId}
  const selection={zoneId:'original-zone',selection:[reference],active:reference}
  useAppStore.setState({surveyZoneSelection:selection,recallZoneSelection:selection})
  const move=vi.spyOn(api.files,'move').mockResolvedValue({status:'moved'})
  await useAppStore.getState().renamePath('src/original.ts','src/renamed.ts','w')
  const renamed=useAppStore.getState()
  expect(move).toHaveBeenCalledWith({source:{workspaceId:'w',path:'src/original.ts'},destination:{workspaceId:'w',path:'src/renamed.ts'}})
  expect(Object.keys(renamed.tabs)).toEqual([original.id]); expect(renamed.tabs[original.id]!.titleRegionId).toBe(original.titleRegionId)
  expect(renamed.tabs[original.id]!.regions[original.titleRegionId]).toMatchObject({path:'src/renamed.ts'})
  expect(renamed.surveyZoneSelection).toBe(selection); expect(renamed.recallZoneSelection).toBe(selection)
  expect(renamed.documents['w\0src/renamed.ts']?.content).toBe('held unsaved draft'); expect(renamed.dirtyDocuments['w\0src/renamed.ts']).toBe(true)
})

it('real selectSession gives A a new identity when its former initial Region now belongs to B', async () => {
  const config = { ...await api.config.get(), workspaces:[{id:'w',hostId:'local',path:_hygiene_fixturePath("w"),kind:'folder' as const,name:'W'}] }
  const tabId = sessionTabId('A'), regionId = initialWorkbenchRegionId(tabId)
  const b = createWorkbenchTab('view:promoted-A-region',{kind:'agent',regionId,workspaceId:'w',sessionId:'B',phase:'attached'})
  const a = {...composerSession('A'),workspacePath:_hygiene_fixturePath("w")}, originalB = {...composerSession('B'),workspacePath:_hygiene_fixturePath("w")}
  useAppStore.setState({config,tabs:{[b.id]:b},layouts:{w:createWorkspaceLayout('original-group',[b.id])},sessions:[a,originalB],activeWorkspaceId:'w',closingWorkbenchViews:{},spaceZoneBindings:{},spatialRequests:{},agentComposerDrafts:{[regionId]:'B retained draft'},displacedAgentSessionIds:[]})
  useAppStore.getState().selectSession('A','original-group')
  const state=useAppStore.getState(), created=Object.values(state.tabs).find(tab=>tab.id!==b.id)!
  expect(state.tabs[b.id]).toBe(b); expect(state.agentComposerDrafts[regionId]).toBe('B retained draft')
  expect(created).toBeDefined(); expect(isObjectId(created.id)).toBe(true); expect(isObjectId(created.titleRegionId)).toBe(true)
  expect(created.id).not.toBe(tabId); expect(created.titleRegionId).not.toBe(regionId)
  expect(created.regions[created.titleRegionId]).toMatchObject({kind:'agent',sessionId:'A'})
  useAppStore.getState().selectSession('A','original-group')
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(Object.keys(state.tabs)); expect(useAppStore.getState().tabs[b.id]).toBe(b)
})
