import { fixtureIso as _hygiene_fixtureIso } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentPromptCondition, AgentMuxFileAgentSessionStore, type AgentTimelineItem } from '@agentmux/core'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { hostedTestOwner, hostedTestFence } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { DeviceAuthority } from '../../host/src/device-authority'
import { reactionPublicClientFixture } from './helpers/reaction-public-client-fixture'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal"/> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-leaf="composer"/> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => <div data-leaf="header"/> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('@agentmux/client-ui/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
vi.mock('../src/renderer/src/components/WindowOverlayHost', async original => ({...await original<typeof import('../src/renderer/src/components/WindowOverlayHost')>(),WindowOverlayPortal:({children}:{children:import('react').ReactNode})=>children}))
vi.mock('@floating-ui/dom',()=>({autoUpdate:()=>()=>{},computePosition:async()=>({x:0,y:0}),offset:()=>({}),shift:()=>({}),size:()=>({})}))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const dom = composerDOM(), ID = 'private-agent', BODY = 'writeAgent · 已提交'
let flow: Awaited<ReturnType<typeof reactionPublicClientFixture>>
let native: Awaited<ReturnType<typeof nativeHistoryFixture>>
let service: AgentMuxHostedRuntimeService
let subscription: Awaited<ReturnType<AgentMuxHostedRuntimeService['subscribe']>>
let authority: DeviceAuthority
const diagnostics = (id: string): AgentTimelineItem => ({id,agentSessionId:ID,kind:'system_message',source:'agentmux',status:'complete',title:'设备操作',content:BODY,createdAt:1,updatedAt:1})
const realSystem = (): AgentTimelineItem => ({...diagnostics('original-system'),content:'Original system remains readable.'})
async function seed(items: AgentTimelineItem[]) {
 for (const item of items) await flow.store.applyTimelineMutation({type:'append',agentSessionId:ID,item})
 return await flow.client.sessionTimeline(ID)
}
const context = () => ({sourceDevice:authority.operationSource({kind:'device',id:authority.hostId+':'+authority.devices()[0]!.deviceId})!,recordDeviceOperation:authority.recordOperation.bind(authority)})
const invoke = (method:string,args:unknown[], ctx=context()) => service.call('runtime.invoke',{fence:hostedTestFence,consumerId:'reading-device',invocation:{method,args}},ctx)
beforeEach(async()=>{
 flow=await reactionPublicClientFixture(ID,'run-'+ID)
 authority=await DeviceAuthority.open(join(flow.store.path,'..','devices.json'))
 await authority.authorizeKey(Buffer.alloc(32,4).toString('base64'))
 const device=authority.devices()[0]!;await authority.hello(device.deviceId,'Tablet')
 service=new AgentMuxHostedRuntimeService(flow.client,flow.store.path,()=>hostedTestOwner(flow.client))
 subscription=await service.subscribe('runtime.events',{fence:hostedTestFence,consumerId:'reading-device'},()=>{});await subscription.start?.()
 native=await nativeHistoryFixture('claude',jsonl([
  {sessionId:'native-main',uuid:'device-operation:native-opaque',type:'user',message:{role:'user',content:BODY},timestamp:_hygiene_fixtureIso(24138000000, "second")},
  {sessionId:'native-main',uuid:'native-answer',type:'assistant',message:{role:'assistant',content:'The actual native reply remains readable.'},timestamp:_hygiene_fixtureIso(24138001000, "second")}
 ]))
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}})
 vi.stubGlobal('IntersectionObserver',class{observe(){}unobserve(){}disconnect(){}})
})
afterEach(async()=>{
 expect(native.controls.map(v=>v.mock.calls.length)).toEqual([0,0,0,0,0,0])
 await subscription.dispose();await service.dispose();await native.close();await flow.close()
})

describe('Device operations remain Host audit facts outside conversation',()=>{
 it('preserves real Hosted input provenance and durable Host operation audit without chat duplication',async()=>{
  const condition=agentPromptCondition(flow.client.agentSession(ID)), source=context().sourceDevice
  await invoke('submitAgentPrompt',[{agentSessionId:ID,operationId:'prompt-operation',prompt:'A normal user request.',...condition,authorHuman:true,sourceChannel:'message-tool'}])
  await invoke('writeAgent',[{agentSessionId:ID,expectedRun:{runId:'run-'+ID},data:'x',source:'user'}])
  const reloaded=new AgentMuxFileAgentSessionStore(flow.store.path), timeline=await reloaded.loadTimeline(ID)
  const prompt=timeline.items.find(item=>item.kind==='user_message')!
  expect(prompt,'Nonempty actual accepted durable prompt').toBeDefined();expect(prompt.content).toBe('A normal user request.')
  expect(prompt.sourceDevice).toEqual(source);expect(prompt.sourceChannel).toBe('message-tool')
  expect(flow.writes).toHaveLength(2);expect(flow.writes[1]).toBe('x')
  expect(timeline.items.filter(item=>item.id.startsWith('device-operation:'))).toEqual([])
  const reopened=await DeviceAuthority.open(join(flow.store.path,'..','devices.json'))
  expect(reopened.devices()[0]!.operations).toHaveLength(2)
  expect(reopened.devices()[0]!.operations!.map(op=>[op.method,op.result])).toEqual([['submitAgentPrompt','confirmed'],['writeAgent','confirmed']])
 })
 it('keeps successful healthy input when Host audit saving is unconfirmed and rejects wire provenance independently',async()=>{
  const ctx={...context(),recordDeviceOperation:async()=>{throw new Error('Controlled Host audit save failure')}}
  await invoke('writeAgent',[{agentSessionId:ID,expectedRun:{runId:'run-'+ID},data:'x',source:'user'}],ctx)
  expect(flow.writes).toEqual(['x']);expect(flow.client.agentSession(ID).run.runId).toBe('run-'+ID)
  await expect(invoke('writeAgent',[{agentSessionId:ID,expectedRun:{runId:'run-'+ID},data:'evil',source:'user',sourceDevice:{hostId:'forged',deviceId:'forged',name:'Forged'}}])).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
  expect(flow.writes).toEqual(['x']);expect((await flow.client.sessionTimeline(ID)).items).toEqual([])
 })
 it('keeps original raw timeline bytes while filtering only the exact Core diagnostic namespace from both presentation paths',async()=>{
  const legacy=diagnostics('device-operation:legacy'),user={...diagnostics('device-operation:user'),kind:'user_message' as const,source:'user' as const,authorHuman:true}
  const agent={...diagnostics('agent-input'),kind:'user_message' as const,source:'user' as const,authorAgentSessionId:'sender-agent'}
  const otherSource={...diagnostics('device-operation:foreign'),source:'native-hook' as const}
  const timeline=await seed([legacy,user,agent,otherSource,realSystem()]),directory=join(flow.store.path,'..','agent-timelines')
  const files=(await readdir(directory)).filter(name=>name.endsWith('.jsonl'));expect(files).toHaveLength(1)
  const rawPath=join(directory,files[0]!),before=await readFile(rawPath);expect(before.byteLength).toBeGreaterThan(0)
  await dom.render(<ActivityView items={timeline.items} sessionId={ID} capability="complete-events" executionHostId="local"/>)
  expect(dom.container.querySelector('[data-message-id="device-operation:legacy"]')).toBeNull()
  expect(dom.container.querySelector('[data-message-id="device-operation:user"]')).not.toBeNull();expect(dom.container.querySelector('[data-message-id="agent-input"]')).not.toBeNull()
  expect(dom.container.textContent).toContain('Original system remains readable.');expect(dom.container.querySelector('[data-segment-key="device-operation:foreign"]')).not.toBeNull()
  const raw=await flow.client.sessionTimeline(ID);expect(raw.items).toEqual(timeline.items);expect(raw.items.find(item=>item.id===legacy.id)).toEqual(legacy)
  expect(await readFile(rawPath)).toEqual(before)
 })
 it('leaves no chat axis or log toolbar for an otherwise empty diagnostics-only surface',async()=>{
  const timeline=await seed([diagnostics('device-operation:only')])
  await dom.render(<ActivityView items={timeline.items} sessionId={ID} capability="complete-events" displayState="done"/>)
  expect(dom.container.querySelector('.log-turn')).toBeNull();expect(dom.container.querySelector('.activity-ruler')).toBeNull()
  expect(dom.container.querySelector('.activity-log')).toBeNull();expect(dom.container.textContent).toContain('No structured activity yet')
 })
 it('keeps actual SessionPane native opaque IDs, Message Tool origin Info, body Range and hidden Return without unrelated IO',async()=>{
  await invoke('submitAgentPrompt',[{agentSessionId:ID,operationId:'message-tool',prompt:'Original Message Tool body.',...agentPromptCondition(flow.client.agentSession(ID)),authorHuman:true,sourceChannel:'message-tool'}])
  const timeline=await seed([diagnostics('device-operation:legacy'),realSystem()])
  const session={...composerSession(ID,'claude'),control:{kind:'agent' as const,hostId:'local',agentSessionId:ID,run:{runId:'run-'+ID}}}
  useAppStore.setState({config:composerConfig,sessions:[session],viewModes:{[ID]:'activity'},timelines:{[ID]:timeline},agentComposerDrafts:{[ID]:'Original unsent draft.'},pendingAgentLaunches:{},recoveryCandidates:[],runtimeOwnershipWarnings:[]})
  const reads=vi.spyOn(api.sessions,'historyPage').mockImplementation((c,options)=>native.client.sessionHistoryPage(c.agentSessionId,options))
  vi.spyOn(api.sessions,'observeHistory').mockImplementation((c,listener,options)=>native.client.observeSessionHistory(c.agentSessionId,listener,options))
  const pane=(visible=true)=><SessionPane sessionId={ID} visible={visible} interactiveResize={false} surfaceKind="agent" linkOrigin={{workspaceId:"workspace",tabId:"original-tab",regionId:"original-region"}}/>
  await dom.render(pane());await vi.waitFor(()=>expect(dom.container.querySelector('[data-native-record-id="native-answer"]')).not.toBeNull())
  expect(dom.container.querySelector('[data-native-record-id="device-operation:native-opaque"]')).not.toBeNull();expect(dom.container.querySelector('[data-message-id="device-operation:legacy"]')).toBeNull()
  const card=dom.container.querySelector('[data-message-id="captured:prompt:message-tool"]')!;expect(card,'Nonempty actual Message Tool card').not.toBeNull()
  await act(async()=>card.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!.click())
  expect(card.textContent).toContain('Message Tool');expect(card.textContent).toContain('Tablet');expect(card.textContent).toContain(context().sourceDevice.hostId)
  const body=dom.container.querySelector('[data-native-record-id="device-operation:native-opaque"] .log-turn__body p')!,text=body.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,5)
  window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);expect(window.getSelection()!.toString()).toBe('write')
  await dom.render(pane(false));const count=reads.mock.calls.length
  await act(async()=>useAppStore.setState(state=>({agentNames:{...state.agentNames,'unrelated-agent':'Unrelated rename'}})))
  expect(reads).toHaveBeenCalledTimes(count);expect(body.isConnected).toBe(true);expect(window.getSelection()!.toString()).toBe('write')
  await dom.render(pane());expect(dom.container.querySelector('[data-native-record-id="device-operation:native-opaque"] .log-turn__body p')).toBe(body)
  expect(useAppStore.getState().agentComposerDrafts[ID]).toBe('Original unsent draft.');expect(session.control.run.runId).toBe('run-'+ID)
 })
})
