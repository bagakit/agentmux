// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
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
  const workspace={id:SCRATCH_WORKSPACE_ID,hostId:'local',path:'/private/native-product/topics',name:'Topics',kind:'folder' as const}
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
  const track={id:'original-track',stop:vi.fn()}
  const stream=new MediaStream()
  Object.defineProperty(stream,'getTracks',{value:()=>[track]})
  const capture=vi.fn(async()=>stream)
  const priorMedia=Object.getOwnPropertyDescriptor(navigator,'mediaDevices')
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getDisplayMedia:capture}})
  const originalRect=HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect=function(){return this.hasAttribute('data-native-browser-stage')||this.classList.contains('workbench-region')
    ? {x:10,y:40,width:640,height:320,left:10,top:40,right:650,bottom:360,toJSON:()=>({})}:originalRect.call(this)}
  const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined)
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
