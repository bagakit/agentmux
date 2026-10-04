const { fixtureIso: _hygiene_fixtureIso, fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { writeFile } from 'node:fs/promises'
import { act, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { beforeEach, afterEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot, AgentTimelineItem } from '@agentmux/core'
import type { SessionSnapshot, AppConfig, AgentSessionControl } from '../src/shared/contracts'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'

// Actual public Client/Claude reader/FileStore, hook, Store, SessionPane, Activity,
// History, Message and ReasoningTrace. Only PTY/composer/chrome are controlled leaves.
const observed = vi.hoisted(() => ({ hook: null as ReturnType<typeof useSessionUserMessages> | null }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({sessionId, disabled=false}: {sessionId:string;disabled?:boolean}) => <div data-leaf="composer" data-session={sessionId} data-disabled={String(disabled)} /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({onHistory}: {onHistory?:()=>void}) => <header data-leaf="header">{onHistory ? <button onClick={onHistory}>History</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('@agentmux/client-ui/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const ID='private-agent', DRAFT='Keep the original unsent draft.'
const control: AgentSessionControl={kind:'agent',hostId:'local',agentSessionId:ID,run:{runId:'unchanged-private-run'}}
const config:AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Private host'}],executors:{claude:{label:'Claude',providerId:'claude',command:'claude',args:[],env:{},injectAgentMuxGuide:true}},workspaces:[{id:'ws',name:'Private project',hostId:'local',path:_hygiene_fixturePath("fixture"),kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
function session(c=control):Extract<SessionSnapshot,{kind:'agent'}>{return {id:c.agentSessionId,kind:'agent',hostId:c.hostId,workspacePath:_hygiene_fixturePath("fixture"),label:'Execution Agent',providerId:'claude',executorId:'claude',agentSessionUpdatedAt:1,promptSubmissionPredecessor:null,createdAt:1,updatedAt:1,processState:'running',status:{state:'done',source:'native-hook',observedAt:1},latestOutputBytes:0,capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control:c}}
function timeline(id=ID):AgentTimelineSnapshot{return {agentSessionId:id,revision:1,items:[{id:'answer-hook',agentSessionId:id,kind:'assistant_message',source:'native-hook',status:'complete',createdAt:100,updatedAt:100,title:'Assistant response',content:'A real answer appears once in the primary conversation.'}]}}
function seed(c=control){useAppStore.setState({config,sessions:[session(c)],pendingAgentLaunches:{},recoveryCandidates:[],runtimeOwnershipWarnings:[],viewModes:{[c.agentSessionId]:'activity'},timelines:{[c.agentSessionId]:timeline(c.agentSessionId)},agentNames:{},agentComposerDrafts:{[c.agentSessionId]:DRAFT},agentSteerQueues:{}})}
function pane(visible=true,c=control){return <SessionPane sessionId={c.agentSessionId} surfaceKind="agent" interactiveResize={false} visible={visible} linkOrigin={{workspaceId:'ws',tabGroupId:'group',tabId:'tab',regionId:'region'}} />}
function Witness({enabled=true,c=control}:{enabled?:boolean;c?:AgentSessionControl}){observed.hook=useSessionUserMessages(c,{enabled});return null}
const record=(uuid:string,type:string,content:unknown)=>({sessionId:'native-main',uuid,type,message:{role:type,content},timestamp:_hygiene_fixtureIso(23846400000)})
const nativeRecords=[
 record('u','user','A legitimate native prompt.'),
 record('r','assistant',[{type:'thinking',thinking:'Exposed reasoning-only record.'}]),
 record('a','assistant',[{type:'thinking',thinking:'**First thought** with a list:\n- Read the actual page.'},{type:'text',text:'A real answer appears once in the primary conversation.'},{type:'tool_use',id:'call-1',name:'Read',input:{file:'src/main.ts'}},{type:'thinking',thinking:'Exposed second thought.'},{type:'image',source:{type:'url',url:'https://example.test/native.png'}}]),
 record('text-only','assistant',[{type:'text',text:'Text-only record stays in full History.'}])
]
const hookStep=(id:string,time:number):AgentTimelineItem=>({id,agentSessionId:ID,kind:'tool_call',source:'native-hook',status:'complete',createdAt:time,updatedAt:time,title:'Read '+id,toolName:'Read',toolInput:id})
const initial=useAppStore.getState();let host:HTMLDivElement;let root:Root;let fixture:Awaited<ReturnType<typeof nativeHistoryFixture>>;let read:MockInstance<typeof api.sessions.historyPage>;let writes:MockInstance[]=[]
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('IntersectionObserver',class{observe(){}unobserve(){}disconnect(){}})
 localStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host);observed.hook=null
 fixture=await nativeHistoryFixture('claude',jsonl(nativeRecords));seed()
 read=vi.spyOn(api.sessions,'historyPage').mockImplementation((c,options)=>fixture.client.sessionHistoryPage(c.agentSessionId,options))
 vi.spyOn(api.sessions,'observeHistory').mockImplementation((c,listener,options)=>fixture.client.observeSessionHistory(c.agentSessionId,listener,options))
 writes=[vi.spyOn(api.sessions,'submitPrompt'),vi.spyOn(api.sessions,'write'),vi.spyOn(api.sessions,'resume'),vi.spyOn(api.sessions,'recover'),vi.spyOn(api.sessions,'stop')]
})
afterEach(async()=>{
 await act(async()=>root.unmount());host.remove()
 const bytes=await fixture.bytes();expect(bytes.native).toEqual(fixture.before.native);expect(bytes.store).toEqual(fixture.before.store)
 expect(fixture.controls.map(c=>c.mock.calls.length)).toEqual([0,0,0,0,0,0]);expect(writes.map(w=>w.mock.calls.length)).toEqual([0,0,0,0,0])
 await fixture.close();useAppStore.setState(initial,true);vi.restoreAllMocks();localStorage.clear()
})
async function render(node:ReactNode){await act(async()=>root.render(node))}
async function waitFor(check:()=>void){await vi.waitFor(async()=>{await act(async()=>{});check()},{timeout:2000})}
function healthy(){expect(useAppStore.getState().sessions.map(s=>[s.id,s.control,s.processState])).toEqual([[ID,control,'running']]);expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT)}
function capturedSource(): AgentTimelineItem[] {
  const manual: AgentTimelineItem = { id:'manual-original', agentSessionId:ID, kind:'user_message', source:'user',
    status:'complete', createdAt:8, updatedAt:8, title:'Submitted prompt', content:'A legitimate native prompt.',
    authorHuman:true, sourceChannel:'message-tool' }
  return [...Array.from({length:30},(_,i)=>hookStep('observed-'+i,i+1)), manual,
    {...manual,id:'system-original',kind:'system_message',source:'agentmux',title:'Device observation',content:'Original system fact.'},
    {...manual,id:'permission-original',kind:'permission',source:'acp',title:'Confirmation',content:'Original permission request.',status:'failed'}]
}
function geometry(feed:HTMLElement) {
  let height=1400, top=1160
  const writes:number[]=[]
  Object.defineProperties(feed,{
    clientHeight:{configurable:true,get:()=>240},scrollHeight:{configurable:true,get:()=>height},
    scrollTop:{configurable:true,get:()=>top,set:(value:number)=>{top=Math.max(0,Math.min(height-240,value));writes.push(top)}}
  })
  return { writes, grow(next:number){height=next}, scroll(next:number){top=next;feed.dispatchEvent(new Event('scroll'))},
    get top(){return top}, get bottom(){return height-240} }
}
async function replaceNative(values:unknown[]) {
  const data=Buffer.from(jsonl(values));await writeFile(fixture.path,data);fixture.before.native=data
  await act(async()=>{await observed.hook!.refresh()});await waitFor(()=>expect(observed.hook!.loading).toBe(false))
}
function nativeHead(){return host.querySelector<HTMLButtonElement>('.conversation-native-thread .wf-head')!}

describe('native conversation primary reading through the real public reader and caller',()=>{
 it('keeps all submitted/Hook/system/permission facts before the source-ordered native reading tail',async()=>{
  const entries=capturedSource();useAppStore.setState({timelines:{[ID]:{agentSessionId:ID,revision:1,items:entries}}})
  await render(<>{pane()}<Witness/></>);await waitFor(()=>expect(observed.hook!.nativeHistoryPage!.items).toHaveLength(4))
  const native=host.querySelector('.conversation-native-thread')!, observations=host.querySelector('.activity-log')!
  expect(observations.compareDocumentPosition(native)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(observations.textContent).toContain('A legitimate native prompt.');expect(observations.textContent).toContain('Original system fact.')
  expect(observations.textContent).toContain('Original permission request.')
  expect(host.querySelectorAll('[data-message-id="captured:manual-original"]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-native-record-id="u"]')).toHaveLength(1)
  expect(native.textContent).toContain('Text-only record stays in full History.')
  expect(read).toHaveBeenCalledTimes(1);healthy()
 })
 it('initially folds the real process but opens each original reasoning/raw record without changing source order or reads',async()=>{
  await render(<>{pane()}<Witness/></>);await waitFor(()=>expect(observed.hook!.nativeHistoryPage!.items).toHaveLength(4))
  const head=nativeHead();expect(head).not.toBeNull();expect(head.getAttribute('aria-expanded')).toBe('false')
  expect(head.textContent).toContain('1 steps');expect(host.querySelector('[data-native-record-id="r"]')).toBeNull()
  const before=read.mock.calls.length;await act(async()=>head.click())
  const row=host.querySelector<HTMLElement>('[data-native-record-id="r"]')!;expect(row).not.toBeNull()
  const step=row.querySelector<HTMLButtonElement>('[data-observation-step-id="r"]')!;await act(async()=>step.click())
  expect(row.textContent).toContain('Reasoning');const trace=row.querySelector<HTMLDetailsElement>('details')!;expect(trace).not.toBeNull()
  await act(async()=>{trace.open=true;trace.dispatchEvent(new Event('toggle'))});expect(trace.textContent).toContain('Exposed reasoning-only record.')
  const body=trace.querySelector('p')!, text=body.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,7)
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);expect(selection.toString()).toBe('Exposed')
  await act(async()=>head.click());expect(row.isConnected).toBe(true);expect(selection.toString()).toBe('Exposed')
  await act(async()=>head.click());expect(host.querySelector('[data-native-record-id="r"]')).toBe(row);expect(trace.open).toBe(true)
  expect([...host.querySelectorAll<HTMLElement>('[data-native-record-id]')].map(el=>el.dataset.nativeRecordId)).toEqual(['u','r','a','text-only'])
  expect(read.mock.calls.length).toBe(before);healthy()
 })
 it('follows an appended native record and same-ID body growth using the unchanged original scroll controller',async()=>{
  await render(<>{pane()}<Witness/></>);await waitFor(()=>expect(observed.hook!.nativeHistoryPage!.items).toHaveLength(4))
  const feed=host.querySelector<HTMLElement>('.activity-feed')!, g=geometry(feed)
  await act(async()=>g.scroll(g.bottom));const count=g.writes.length
  g.grow(1700);const longer=record('text-only','assistant',[{type:'text',text:'Text-only record stays in full History. Added exact streaming body.'}])
  await replaceNative([...nativeRecords.slice(0,-1),longer]);expect(g.writes.length).toBeGreaterThan(count);expect(g.top).toBe(g.bottom)
  const afterGrowth=g.writes.length;g.grow(2000);await replaceNative([...nativeRecords.slice(0,-1),longer,record('native-terminal-next','user','Next exact terminal message.')])
  await waitFor(()=>expect(host.querySelector('[data-native-record-id="native-terminal-next"]')?.textContent).toContain('Next exact terminal message.'))
  expect(g.writes.length).toBeGreaterThan(afterGrowth);expect(g.top).toBe(g.bottom);healthy()
 })
 it('keeps detached scroll, old body/Range/disclosure and draft through native growth, append and hidden Return; Jump alone resumes following',async()=>{
  await render(<>{pane()}<Witness/></>);await waitFor(()=>expect(observed.hook!.nativeHistoryPage!.items).toHaveLength(4))
  const feed=host.querySelector<HTMLElement>('.activity-feed')!,g=geometry(feed)
  await act(async()=>g.scroll(g.bottom));await act(async()=>g.scroll(217))
  const body=host.querySelector<HTMLElement>('[data-native-record-id="u"] .log-turn__body p')!, text=body.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,12)
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);expect(selection.toString()).toBe('A legitimate')
  const oldWrites=g.writes.length;g.grow(2100);const longer=record('text-only','assistant',[{type:'text',text:'Text-only record stays in full History. More words while the user reads above.'}])
  await replaceNative([...nativeRecords.slice(0,-1),longer]);await replaceNative([...nativeRecords.slice(0,-1),longer,record('native-terminal-next','user','Next exact terminal message.')])
  expect(g.top).toBe(217);expect(g.writes.length).toBe(oldWrites);expect(host.querySelector('[data-native-record-id="u"] .log-turn__body p')).toBe(body)
  expect(selection.toString()).toBe('A legitimate');expect(range.startContainer).toBe(text)
  await render(<>{pane(false)}<Witness enabled={false}/></>);const calls=read.mock.calls.length
  await act(async()=>useAppStore.setState(state=>({agentNames:{...state.agentNames,unrelated:'Actually unrelated publication'}})))
  expect(read.mock.calls.length).toBe(calls);expect(body.isConnected).toBe(true);expect(g.top).toBe(217)
  await render(<>{pane()}<Witness/></>);await waitFor(()=>expect(observed.hook!.loading).toBe(false))
  expect(host.querySelector('[data-native-record-id="u"] .log-turn__body p')).toBe(body);expect(selection.toString()).toBe('A legitimate');expect(g.top).toBe(217)
  const jump=host.querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]')!;expect(jump).not.toBeNull();await act(async()=>jump.click())
  expect(g.top).toBe(g.bottom);expect(host.querySelector('[data-message-tool-control="jump-to-latest"]')).toBeNull();healthy()
 })
})
