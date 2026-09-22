// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, BrowserEvent, BrowserSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const original = useAppStore.getState()
const config: AppConfig = {
  version: 9, hosts: [{id:'local',kind:'local',label:'Private fixture'}], executors: {},
  workspaces: [{id:'workspace-a',name:'Private fixture',hostId:'local',path:'/private/browser-annotation-recovery',kind:'folder'}],
  appearance: {terminalTheme:'graphite'},
  browser: {toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}
}
function snapshot(id: string): BrowserSnapshot {
  return {id,navigationId:`actual-${id}`,profileId:'default',url:'https://private.example/page',title:`Page ${id}`,
    loading:false,canGoBack:false,canGoForward:false,viewport:'responsive',driving:false,appLinkPrompt:null,error:null}
}
let root: Root | undefined
let container: HTMLDivElement
let dispose: (() => void) | undefined
let initialized: Promise<() => void> | undefined
let releaseFirst: (() => void) | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  useAppStore.setState(original,true)
  vi.spyOn(useAppStore.persist,'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config,'get').mockResolvedValue(config)
  vi.spyOn(api.providers,'list').mockResolvedValue([])
  vi.spyOn(api.sessions,'snapshot').mockResolvedValue({sessions:[],timelines:{},recoveryCandidates:[]})
  container=document.createElement('div');document.body.append(container)
})
afterEach(async () => {
  releaseFirst?.();releaseFirst=undefined
  if (initialized) await act(async()=>{dispose=await initialized!})
  initialized=undefined
  if(root)await act(async()=>root!.unmount())
  root=undefined;dispose?.();dispose=undefined
  container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();useAppStore.setState(original,true)
})
function restoredSplit() {
  const first: BrowserWorkbenchSurface={...snapshot('first'),kind:'browser',regionId:'first-region',browserId:'first',workspaceId:'workspace-a'}
  const second: BrowserWorkbenchSurface={...snapshot('sibling'),kind:'browser',regionId:'sibling-region',browserId:'sibling',workspaceId:'workspace-a'}
  const tab=addWorkbenchRegion(createWorkbenchTab('saved-tab',first),first.regionId,'right',second)
  useAppStore.setState({loading:true,tabs:{},layouts:{},activeWorkspaceId:'workspace-a',
    restoredWorkbench:{tabs:{[tab.id]:tab},layouts:{'workspace-a':createWorkspaceLayout('saved-group',[tab.id])}}})
  return tab
}
function ActualSplit() {
  const tab=useAppStore(state=>state.tabs['saved-tab'])
  return tab?<>{Object.values(tab.regions).map(surface=>surface.kind==='browser'?<BrowserPane key={surface.regionId} tab={surface} visible />:null)}</>:null
}
it('waits for the real sibling owner snapshot during actual cold initialization before synchronizing markers',async()=>{
  const saved=restoredSplit()
  const nativeOwners=new Set<string>()
  let publish!: (event: BrowserEvent) => void
  vi.spyOn(api.browser,'onEvent').mockImplementation(listener=>{publish=listener;return()=>{}})
  const firstPending=new Promise<void>(resolve=>{releaseFirst=resolve})
  const create=vi.spyOn(api.browser,'create').mockImplementation(async(id)=>{
    nativeOwners.add(id) // Main registers the native owner before awaiting its load, not after create resolves.
    const actual=snapshot(id);publish({type:'updated',browser:actual})
    if(id==='first')await firstPending
    return actual
  })
  const markers=vi.spyOn(api.browser,'setAnnotationMarkers').mockImplementation(async(id)=>{
    if(!nativeOwners.has(id))throw new Error(`Unknown browser:${id}`)
  })
  root=createRoot(container)
  await act(async()=>{root!.render(<ActualSplit />);initialized=useAppStore.getState().initialize()})
  await vi.waitFor(()=>expect(create.mock.calls.map(call=>call[0])).toEqual(['first']))
  expect(useAppStore.getState().loading).toBe(false)
  expect(Object.keys(useAppStore.getState().tabs[saved.id]!.regions)).toEqual(['first-region','sibling-region'])
  expect(useAppStore.getState().tabs[saved.id]!.regions['sibling-region']).toMatchObject({browserId:'sibling',navigationId:''})
  expect([...container.querySelectorAll('[data-native-browser-stage]')]).toHaveLength(2)
  expect(useAppStore.getState().error).toBeNull()
  expect(markers.mock.calls.filter(call=>call[0]==='sibling')).toEqual([])
  await act(async()=>{releaseFirst!();dispose=await initialized!})
  expect(create.mock.calls.map(call=>call[0])).toEqual(['first','sibling'])
  expect(markers.mock.calls.filter(call=>call[0]==='sibling')).toEqual([['sibling','actual-sibling',[]]])
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().tabs[saved.id]!.layout).toEqual(saved.layout)
})

async function renderReadySplit() {
  const saved=restoredSplit()
  useAppStore.setState({tabs:{[saved.id]:saved},loading:false,config,restoredWorkbench:null,error:null})
  root=createRoot(container)
  await act(async()=>root!.render(<ActualSplit />))
  return saved
}
function markerRetry(): HTMLButtonElement {
  const buttons=[...container.querySelectorAll('button')].filter(button=>button.textContent==='Retry annotations')
  expect(buttons).toHaveLength(1)
  return buttons[0]!
}
it('keeps real marker failure in its local service window until the exact Retry succeeds, without a global page error',async()=>{
  let attempt=0,resolve!:()=>void
  const retryPending=new Promise<void>(yes=>{resolve=yes})
  const markers=vi.spyOn(api.browser,'setAnnotationMarkers').mockImplementation(async id=>{
    if(id==='sibling'){
      if(++attempt===1)throw new Error('Unknown browser:sibling')
      await retryPending
    }
  })
  const saved=await renderReadySplit()
  expect(container.textContent).toContain('Unknown browser:sibling')
  expect(container.querySelector('.service-window')?.getAttribute('data-kind')).toBe('indeterminate')
  expect(container.textContent).toContain('the page and other Browser work are retained')
  expect(useAppStore.getState().error).toBeNull()
  expect(container.querySelectorAll('[data-native-browser-stage]')).toHaveLength(2)
  await act(async()=>markerRetry().click())
  expect(markers.mock.calls.filter(call=>call[0]==='sibling')).toEqual([['sibling','actual-sibling',[]],['sibling','actual-sibling',[]]])
  expect(container.textContent).toContain('Unknown browser:sibling')
  await act(async()=>resolve())
  expect(container.querySelector('.service-window')).toBeNull()
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().tabs[saved.id]!.layout).toEqual(saved.layout)
  expect(markers.mock.calls.filter(call=>call[0]==='first')).toEqual([['first','actual-first',[]]])
})
it('a late former-navigation completion cannot clear or replace the current marker failure',async()=>{
  let oldReject!: (error: Error)=>void
  const old=new Promise<void>((_yes,no)=>{oldReject=no})
  vi.spyOn(api.browser,'setAnnotationMarkers').mockImplementation(async(id,navigationId)=>{
    if(id!=='sibling')return
    if(navigationId==='actual-sibling')await old
    else throw new Error('Current marker synchronization denied')
  })
  await renderReadySplit()
  await act(async()=>useAppStore.getState().applyBrowserEvent({type:'updated',browser:{...snapshot('sibling'),navigationId:'next-document'}}))
  expect(container.textContent).toContain('Current marker synchronization denied')
  await act(async()=>oldReject(new Error('Old navigation failure')))
  expect(container.textContent).toContain('Current marker synchronization denied')
  expect(container.textContent).not.toContain('Old navigation failure')
  expect(useAppStore.getState().error).toBeNull()
})
it('a parked native owner is not written while its real restore request is pending',async()=>{
  let resolve!: (browser: BrowserSnapshot)=>void
  const pending=new Promise<BrowserSnapshot>(yes=>{resolve=yes})
  vi.spyOn(api.browser,'restore').mockReturnValue(pending)
  const markers=vi.spyOn(api.browser,'setAnnotationMarkers').mockResolvedValue()
  const tab: BrowserWorkbenchSurface={...snapshot('sibling'),kind:'browser',regionId:'sibling-region',browserId:'sibling',workspaceId:'workspace-a'}
  root=createRoot(container)
  await act(async()=>root!.render(<BrowserPane tab={tab} visible released />))
  expect(markers.mock.calls).toEqual([])
  await act(async()=>root!.render(<BrowserPane tab={tab} visible released={false} />))
  expect(container.textContent).toContain('Restoring browser')
  expect(markers.mock.calls).toEqual([])
  await act(async()=>resolve(snapshot('sibling')))
  expect(markers.mock.calls).toEqual([['sibling','actual-sibling',[]]])
})
