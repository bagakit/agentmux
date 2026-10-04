import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { previewFrame, previewMedia } from './helpers/browser-preview-media'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('react-resizable-panels',()=>createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import type { BrowserPresentationGeometry, BrowserPresentationOccurrence } from '../src/shared/contracts'
import { installNativePopover } from './fixtures/mote-workface'

it('actual App keeps both exact Browser workfaces on one capture; Settings hides only A and closing Mote removes only B leases', async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  window.localStorage.clear()
  const restorePopover=installNativePopover(),initial=useAppStore.getState()
  const config=await api.config.get()
  const workspace={id:SCRATCH_WORKSPACE_ID,hostId:'local',path:_hygiene_fixturePath("private/native-product/topics"),name:'Topics',kind:'folder' as const}
  const topicId='launcher:product',directoryPath=workspace.path+'/'+scratchTopicDirectoryName(topicId)
  const topic={id:topicId,title:'Original Browser',summary:'',directoryPath,topicPath:directoryPath+'/topic.md',collaborators:[],soul:{path:directoryPath+'/SOUL.md',content:'# Identity',version:'actual-store-fixture'}}
  const list=vi.spyOn(api.scratch,'listTopics').mockResolvedValue([topic])
  const readTopic=vi.spyOn(api.scratch,'readTopic').mockResolvedValue(topic)
  const ensure=vi.spyOn(api.scratch,'ensureMote').mockResolvedValue(topic)
  const browser=await api.browser.create('actual-product-browser','https://example.invalid/page',workspace.id)
  const surface={...browser,kind:'browser' as const,regionId:'actual-product-region',workspaceId:workspace.id,browserId:browser.id}
  const tab={...createWorkbenchTab('actual-product-tab',surface),topicId}
  window.localStorage.setItem('agentmux.leader-topic-floating.v1',JSON.stringify({open:false,targetTopicId:topicId,targetTabId:tab.id,railMode:'avatars'}))
  const held=new Map<string,{occurrence:BrowserPresentationOccurrence;geometry:BrowserPresentationGeometry}>()
  const register=vi.spyOn(api.browser,'registerPresentation').mockImplementation(async request=>{const id='lease-'+held.size;held.set(id,request);return{leaseId:id}})
  const update=vi.spyOn(api.browser,'updatePresentation').mockImplementation(async(id,geometry)=>{const lease=held.get(id)!;held.set(id,{...lease,geometry})})
  const remove=vi.spyOn(api.browser,'removePresentation').mockImplementation(async id=>{held.delete(id)})
  const activate=vi.spyOn(api.browser,'activatePresentation').mockResolvedValue({outcome:'selected'})
  const arm=vi.spyOn(api.browser,'armPresentationCapture').mockResolvedValue({captureId:'original-capture',browserId:browser.id,})
  const ack=vi.spyOn(api.browser,'ackPresentationCapture').mockResolvedValue(undefined)
  const events=vi.spyOn(api.browser,'onPresentationEvent').mockImplementation(()=>()=>{})
  const {track,stream}=previewMedia('original-track')
  const capture=vi.fn(async()=>stream)
  const priorMedia=Object.getOwnPropertyDescriptor(navigator,'mediaDevices')
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getDisplayMedia:capture}})
  const originalRect=HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect=function(){return this.hasAttribute('data-native-browser-stage')||this.classList.contains('workbench-region')
    ? {x:10,y:40,width:640,height:320,left:10,top:40,right:650,bottom:360,toJSON:()=>({})}:originalRect.call(this)}
  const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockImplementation(function () { previewFrame(this); return Promise.resolve() })
  useAppStore.setState({...initial,loading:false,initialize:async()=>()=>{},config:{...config,workspaces:[workspace]},sessions:[],
    activeWorkspaceId:workspace.id,mainSurface:'workbench',tabs:{[tab.id]:tab},layouts:{[workspace.id]:createWorkspaceLayout('original-group',[tab.id])},toolsOpen:false,projectRailOpen:false,
    scratchTopicSnapshots:{[workspace.id]:{scope:scratchTopicsScope(workspace),revision:0,topics:[topic],error:null,reading:false}},
    agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}}},true)
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
  try{
    await act(async()=>root.render(createElement(App)))
    await vi.waitFor(async()=>{await act(async()=>{});expect(register).toHaveBeenCalledTimes(1);expect(capture).toHaveBeenCalledTimes(1)})
    const originalStage=container.querySelector('[data-native-browser-stage]')!
    expect(originalStage).not.toBeNull()
    const button=document.querySelector<HTMLButtonElement>('[data-pmo-teams-topic-launcher] button')!
    expect(button).not.toBeNull()
    const before=useAppStore.getState()
    await act(async()=>button.click())
    await vi.waitFor(async()=>{await act(async()=>{});expect(container.querySelectorAll('[data-native-browser-stage]')).toHaveLength(2);expect(held.size).toBe(2)})
    const stages=[...container.querySelectorAll('[data-native-browser-stage]')]
    expect(stages[0]).toBe(originalStage)
    const sources=stages.map(stage=>(stage.querySelector('video') as HTMLVideoElement).srcObject)
    expect(sources).toEqual([stream,stream])
    expect(capture).toHaveBeenCalledTimes(1);expect(arm).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(register.mock.calls.map(([request])=>request.occurrence.location)).toEqual([
      {displayWorkspaceId:workspace.id,groupId:'original-group',tabId:tab.id,regionId:surface.regionId},
      {displayWorkspaceId:workspace.id,groupId:'original-group',tabId:tab.id,regionId:surface.regionId}])
    const current=useAppStore.getState();expect(current.tabs).toBe(before.tabs);expect(current.layouts).toBe(before.layouts)
    const settings=document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!
    expect(settings).not.toBeNull();await act(async()=>settings.click())
    await vi.waitFor(async()=>{await act(async()=>{});expect([...held.values()].map(value=>[value.occurrence.presentationId.startsWith('mote-'),value.geometry.visible])).toEqual([[false,false],[true,true]])})
    expect(container.querySelector('[data-native-browser-stage]')).toBe(originalStage)
    expect(capture).toHaveBeenCalledTimes(1);expect(activate).toHaveBeenCalledTimes(1)
    await act(async()=>settings.click())
    await vi.waitFor(async()=>{await act(async()=>{});expect([...held.values()].map(value=>value.geometry.visible)).toEqual([true,true])})
    await act(async()=>button.click())
    await vi.waitFor(async()=>{await act(async()=>{});expect(held.size).toBe(1)})
    expect(remove).toHaveBeenCalledTimes(1)
    expect(track.stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  }finally{
    await act(async()=>root.unmount());container.remove();restorePopover()
    HTMLElement.prototype.getBoundingClientRect=originalRect
    if(priorMedia)Object.defineProperty(navigator,'mediaDevices',priorMedia);else delete(navigator as unknown as Record<string,unknown>).mediaDevices
    useAppStore.setState(initial,true)
    for(const spy of [list,readTopic,ensure,register,update,remove,activate,arm,ack,events,play])spy.mockRestore()
    vi.unstubAllGlobals()
  }
})

import { createClientUiRoot } from './helpers/client-ui-render'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection } from '../src/renderer/src/lib/survey-workface'
import { BrowserPresentationStage, useBrowserPresentationCapture, type WorkbenchBrowserPresentation } from '../src/renderer/src/components/BrowserPresentationStage'

it('a fresh Survey Browser selects its exact visible occurrence before capture, keeps failures inside the page and retries the same lease', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), restorePopover = installNativePopover()
  const workspace = { id: 'survey-capture-workspace', hostId: 'local', path: _hygiene_fixturePath("survey-capture"), name: 'Research', kind: 'folder' as const }
  const config = await api.config.get(), page = await api.browser.create('survey-capture-page', 'https://example.invalid/fresh', workspace.id)
  const surface = { ...page, kind: 'browser' as const, regionId: 'survey-capture-region', workspaceId: workspace.id, browserId: page.id }
  const tab = createWorkbenchTab('survey-capture-tab', surface)
  useAppStore.setState({ ...initial, loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [workspace] }, sessions: [],
    activeWorkspaceId: workspace.id, mainSurface: 'survey', tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('survey-capture-group', [tab.id]) },
    toolsOpen: false, projectRailOpen: false, surveyToolsOpen: false, surveyZoneSelection: null, surveyCollectedZones: {}, surveySidebarCollapsed: false }, true)
  const catalog = spatialCatalog(useAppStore.getState(), []), zoneId = catalog.tabs.find(value => value.tabId === tab.id)!.zoneId!
  useAppStore.setState({ surveyCollectedZones: { [zoneId]: true }, surveyZoneSelection: surveyInitialZoneSelection(catalog, zoneId, useAppStore.getState().layouts, useAppStore.getState().tabs, workspace.id) })
  const held = new Map<string, { occurrence: BrowserPresentationOccurrence; geometry: BrowserPresentationGeometry }>(), sequence: string[] = []
  let nextLease = 0
  const register = vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => { const leaseId = `survey-lease-${++nextLease}`; held.set(leaseId, request); return { leaseId } })
  const update = vi.spyOn(api.browser, 'updatePresentation').mockImplementation(async (id, geometry) => { held.set(id, { ...held.get(id)!, geometry }) })
  const remove = vi.spyOn(api.browser, 'removePresentation').mockImplementation(async id => { held.delete(id) })
  const activate = vi.spyOn(api.browser, 'activatePresentation').mockImplementation(async id => { expect(held.get(id)!.geometry.visible).toBe(true); sequence.push('select'); return { outcome: 'selected' } })
  const arm = vi.spyOn(api.browser, 'armPresentationCapture').mockImplementation(async () => { sequence.push('capture'); return { captureId: 'survey-original-capture', browserId: page.id } })
  const ack = vi.spyOn(api.browser, 'ackPresentationCapture').mockResolvedValue(undefined), events = vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => () => {})
  const { stream } = previewMedia('survey-track')
  const capture = vi.fn().mockRejectedValueOnce(new Error('Timeout starting video source')).mockResolvedValue(stream)
  const priorMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: capture } })
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(220, 60, 620, 320))
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () { previewFrame(this); return Promise.resolve() })
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(App)))
    await vi.waitFor(async () => { await act(async () => {}); expect(container.querySelector('.global-survey-surface .browser-presentation-notice .service-disclosure')).not.toBeNull() })
    expect(sequence[0]).toBe('select'); expect(activate).toHaveBeenCalledTimes(1)
    const chosen = held.get(activate.mock.calls[0]![0])!
    expect(chosen.occurrence.presentationId).toContain('survey-workbench')
    expect(chosen.occurrence.location).toEqual({ displayWorkspaceId: workspace.id, groupId: 'survey-capture-group', tabId: tab.id, regionId: surface.regionId })
    const stage = container.querySelector('.global-survey-surface [data-native-browser-stage]')!
    const pane = stage.closest('.browser-surface')!
    const retry = pane.querySelector<HTMLButtonElement>('.browser-presentation-notice > button')!
    expect(retry).not.toBeNull(); expect(stage.closest('.browser-surface')).not.toBeNull()
    await act(async () => retry.click())
    await vi.waitFor(async () => { await act(async () => {}); expect((stage.querySelector('video') as HTMLVideoElement)?.srcObject).toBe(stream) })
    expect(container.querySelector('.global-survey-surface [data-native-browser-stage]')).toBe(stage)
    expect(activate).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
    expect(pane.querySelector('.service-disclosure')).toBeNull()
  } finally {
    await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true)
    if (priorMedia) Object.defineProperty(navigator, 'mediaDevices', priorMedia); else delete (navigator as unknown as Record<string, unknown>).mediaDevices
    for (const spy of [register, update, remove, activate, arm, ack, events, rect, play]) spy.mockRestore()
    vi.unstubAllGlobals()
  }
})

it('hidden registration and unconfirmed selection preserve the next visible activation opportunity', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), restorePopover = installNativePopover()
  const location = { displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'region' }
  const presentation: WorkbenchBrowserPresentation = { occurrence: { presentationId: 'precise-occurrence', location }, stageHostId: 'stage', visible: false, active: true, yieldToFocusRing: false, target: { hostId: 'host', reference: location, surface: 'survey', active: true } }
  const activate = vi.spyOn(api.browser, 'activatePresentation').mockResolvedValueOnce({ outcome: 'input-unconfirmed', reason: 'hidden', message: 'Visibility changed before selection' }).mockResolvedValue({ outcome: 'selected' })
  const register = vi.spyOn(api.browser, 'registerPresentation').mockResolvedValue({ leaseId: 'same-lease' }), update = vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined), remove = vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  const arm = vi.spyOn(api.browser, 'armPresentationCapture').mockResolvedValue({ captureId: 'capture', browserId: 'browser' }), ack = vi.spyOn(api.browser, 'ackPresentationCapture').mockResolvedValue(undefined), events = vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => () => {})
  const { stream } = previewMedia('track')
  const priorMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn(async () => stream) } })
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 320)), play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () { previewFrame(this); return Promise.resolve() })
  function Workface({ visible }: { visible: boolean }) { const media = useBrowserPresentationCapture('browser'); return createElement(BrowserPresentationStage, { browserId: 'browser', navigationId: 'navigation', presentation: { ...presentation, visible }, inputSelected: true, blocked: false, media }) }
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(Workface, { visible: false })))
    await vi.waitFor(async () => { await act(async () => {}); expect(register).toHaveBeenCalledTimes(1) })
    expect(register).toHaveBeenCalledTimes(1); expect(activate).not.toHaveBeenCalled(); expect(arm).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(Workface, { visible: true })))
    await vi.waitFor(async () => { await act(async () => {}); expect(activate).toHaveBeenCalled() })
    const retry = container.querySelector<HTMLButtonElement>('.browser-presentation-notice > button')!
    expect(retry).not.toBeNull(); await act(async () => retry.click())
    expect(activate).toHaveBeenCalledTimes(2); expect(register).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true)
    if (priorMedia) Object.defineProperty(navigator, 'mediaDevices', priorMedia); else delete (navigator as unknown as Record<string, unknown>).mediaDevices
    for (const spy of [activate, register, update, remove, arm, ack, events, rect, play]) spy.mockRestore(); vi.unstubAllGlobals()
  }
})
