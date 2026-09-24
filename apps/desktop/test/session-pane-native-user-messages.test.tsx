// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionUserMessage, AgentTimelineSnapshot } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { SessionSnapshot, AppConfig, AgentSessionControl } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { DescribeSpeaker } from '../src/renderer/src/lib/conversation-speaker'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'

// Caller qualification with controlled leaf props and history I/O. Store, hook and projector are real.
// Shared body/axis rendering is covered by conversation-native-user-messages.integration.test.tsx;
// this suite does not claim a Provider writer, physical geometry or a live Run.
type ActivityBoundary = { sessionId?: string; userMessages?: readonly AgentSessionUserMessage[]; items: readonly unknown[]; describeSpeaker?: DescribeSpeaker }
const captured = vi.hoisted(() => ({ activities: [] as ActivityBoundary[], terminalSessions: [] as SessionSnapshot[], histories: [] as AgentSessionControl[], historyResolvers: [] as (DescribeSpeaker | undefined)[], witness: null as ReturnType<typeof useSessionUserMessages> | null }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: (props: ActivityBoundary) => {
  captured.activities.push(props)
  return <div data-leaf="activity" data-session={props.sessionId ?? 'absent'}>{props.userMessages?.map(item => <span key={item.id} data-record-id={item.id}>{item.content}</span>)}</div>
} }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({session}: {session: SessionSnapshot}) => { captured.terminalSessions.push(session);return <div data-leaf="terminal" /> } }))
vi.mock('../src/renderer/src/components/SessionHistoryView', () => ({ SessionHistoryView: ({control, describeSpeaker, onClose, visible}: {control: AgentSessionControl;describeSpeaker?:DescribeSpeaker;onClose?:()=>void;visible:boolean}) => { captured.histories.push(control);captured.historyResolvers.push(describeSpeaker);return visible ? <div data-leaf="history"><button type="button" onClick={onClose}>Return</button></div> : null } }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({sessionId,disabled=false}: {sessionId:string;disabled?:boolean}) => <div data-leaf="composer" data-session={sessionId} data-disabled={String(disabled)} /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({sessionId,onHistory}: {sessionId:string;onHistory?:()=>void}) => <header data-leaf="header" data-session={sessionId}>{onHistory ? <button type="button" onClick={onHistory}>History</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => <div data-leaf="connecting" /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => <div data-leaf="interaction" /> }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const BODY='Identical prompt from two sources'
const config: AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Private typed host'}],executors:{codex:{label:'Private typed Codex',providerId:'codex',command:'codex',args:[],env:{},injectAgentMuxGuide:true}},workspaces:[{id:'ws',name:'Private typed project',hostId:'local',path:'/fixture',kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
function agent(id:string,runId=`run-${id}`): Extract<SessionSnapshot,{kind:'agent'}>{return {id,kind:'agent',hostId:'local',workspacePath:'/fixture',label:id,providerId:'codex',executorId:'codex',agentSessionUpdatedAt:1,promptSubmissionPredecessor:null,createdAt:1,updatedAt:1,processState:'running',status:{state:'running',source:'run-process',observedAt:1},latestOutputBytes:0,capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control:{kind:'agent',hostId:'local',agentSessionId:id,run:{runId}}}}
function page(id:string): AgentSessionHistoryPage{return {agentSessionId:id,source:{providerId:'codex',nativeSessionId:`native-${id}`},items:[{id:'record-1',kind:'user-message',startedAt:100,contentParts:[{kind:'text',text:BODY}]},{id:'record-2',kind:'user-message',contentParts:[{kind:'text',text:BODY}]}],nextCursor:null}}
function timeline(id:string): AgentTimelineSnapshot{return {agentSessionId:id,revision:1,items:[{id:`submission-${id}`,agentSessionId:id,kind:'user_message',status:'complete',source:'user',createdAt:100,updatedAt:100,title:'Recorded prompt',content:BODY,authorAgentSessionId:'known-sender'}]}}
function expected(id:string){return projectSessionUserMessages({agentSessionId:id,historyPage:page(id),timeline:timeline(id)})}
function pane(id:string,{visible=true,readOnly=false,surfaceKind='agent'}:{visible?:boolean;readOnly?:boolean;surfaceKind?:'agent'|'terminal'}={}) {return <SessionPane sessionId={id} surfaceKind={surfaceKind} interactiveResize={false} visible={visible} readOnly={readOnly} linkOrigin={{workspaceId:'ws',tabGroupId:'group',tabId:'tab',regionId:'region'}} />}
function Witness({control,enabled=true}:{control:AgentSessionControl;enabled?:boolean}){const result=useSessionUserMessages(control,{enabled});captured.witness=result;return <div data-witness="hook">{result.messages.map(item=><span key={item.id} data-record-id={item.id}>{item.content}</span>)}</div>}
const initial=useAppStore.getState();let container:HTMLDivElement;let root:Root;let read:MockInstance<typeof api.sessions.historyPage>
async function flush(){await act(async()=>{for(let n=0;n<10;n++)await Promise.resolve()})}
async function render(node:ReactNode){await act(async()=>root.render(node));await flush()}
function seed(session:SessionSnapshot,mode:'activity'|'terminal'='activity'){useAppStore.setState({config,sessions:[session],pendingAgentLaunches:{},recoveryCandidates:[],runtimeOwnershipWarnings:[],viewModes:{[session.id]:mode},timelines:{[session.id]:timeline(session.id)},agentNames:{},agentComposerDrafts:{[session.id]:'UNSENT_REAL_STORE_DRAFT'},agentSteerQueues:{}})}
function currentActivity(){expect(captured.activities.length).toBeGreaterThan(0);const props=captured.activities.at(-1);expect(props).toBeDefined();return props!}
function assertHealthy(id:string){expect(useAppStore.getState().sessions.map(s=>[s.id,s.control,s.processState])).toEqual([[id,agent(id).control,'running']]);expect(useAppStore.getState().agentComposerDrafts[id]).toBe('UNSENT_REAL_STORE_DRAFT');expect(container.querySelector('[data-leaf="composer"]')?.getAttribute('data-disabled')).toBe('false')}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();container=document.createElement('div');document.body.append(container);root=createRoot(container);captured.activities=[];captured.terminalSessions=[];captured.histories=[];captured.historyResolvers=[];captured.witness=null;read=vi.spyOn(api.sessions,'historyPage').mockImplementation(async control=>page(control.agentSessionId));seed(agent('a'))})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();localStorage.clear()})

describe('Shared-hook and public-projector positive witnesses',()=>{
 it('passes native and captured same-body distinct IDs, original source/actor/time without fabricated speaker',async()=>{const a=agent('a');await render(<Witness control={a.control}/>);expect(read.mock.calls).toEqual([[a.control,{limit:30}]]);expect(captured.witness?.messages).toEqual(expected('a'));expect(captured.witness?.messages.map(m=>[m.rawId,m.source.kind,m.author.kind,m.recordedAt])).toEqual([['record-1','native','unknown',100],['record-2','native','unknown',undefined],['submission-a','captured','agent',100]]);expect(container.querySelectorAll('[data-record-id]')).toHaveLength(3)})
 it('drops late previous-Session page while exact new control remains visible',async()=>{let resolveOld:((page:AgentSessionHistoryPage)=>void)|undefined;const old=new Promise<AgentSessionHistoryPage>(resolve=>{resolveOld=resolve});read.mockImplementation(control=>control.agentSessionId==='a'?old:Promise.resolve(page(control.agentSessionId)));await render(<Witness control={agent('a').control}/>);await act(async()=>seed(agent('b')));await render(<Witness control={agent('b').control}/>);expect(read.mock.calls.map(([control])=>control)).toEqual([agent('a').control,agent('b').control]);expect(captured.witness?.messages).toEqual(expected('b'));await act(async()=>resolveOld?.(page('a')));await flush();expect(captured.witness?.messages).toEqual(expected('b'));expect(container.querySelectorAll('[data-record-id]')).toHaveLength(3)})
 it('keeps already read records on explicit read failure with real Store draft and healthy Run projection',async()=>{await render(<Witness control={agent('a').control}/>);expect(captured.witness?.messages).toEqual(expected('a'));read.mockRejectedValueOnce(new Error('controlled history transport failure'));await act(async()=>captured.witness?.refresh());await flush();expect(captured.witness?.messages).toEqual(expected('a'));expect(captured.witness?.error?.message).toBe('controlled history transport failure');expect(useAppStore.getState().sessions.map(s=>[s.id,s.control.run.runId,s.processState])).toEqual([['a','run-a','running']]);expect(useAppStore.getState().agentComposerDrafts.a).toBe('UNSENT_REAL_STORE_DRAFT')})
})

describe('SessionPane public native-message caller',()=>{
 it('visible Agent Activity reads exactly its real Store host/session/run control',async()=>{const a=agent('a');await render(pane(a.id));expect(container.querySelectorAll('[data-leaf="activity"]')).toHaveLength(1);expect(currentActivity().items).toEqual(timeline('a').items);assertHealthy('a');expect(read.mock.calls).toEqual([[a.control,{limit:30}]])})
 it('actual Activity receives exact Session ID and all nonempty native/captured DTOs',async()=>{const expectedItems=expected('a');expect(expectedItems).toHaveLength(3);expect(expectedItems.map(m=>m.id)).toEqual(['native:codex:native-a:record-1','native:codex:native-a:record-2','captured:submission-a']);await render(pane('a'));const props=currentActivity();expect({sessionId:props.sessionId,messages:props.userMessages}).toEqual({sessionId:'a',messages:expectedItems})})
 it('read-only visible Activity still reads its original control while preserving input prohibition',async()=>{await render(pane('a',{readOnly:true}));expect(container.querySelectorAll('[data-leaf="activity"]')).toHaveLength(1);expect(container.querySelectorAll('[data-leaf="composer"]')).toHaveLength(0);expect(useAppStore.getState().sessions.map(s=>s.control)).toEqual([agent('a').control]);expect(read.mock.calls).toEqual([[agent('a').control,{limit:30}]])})
})

describe('SessionPane native-message demand boundaries',()=>{
 it('Agent Terminal renders real control without Activity reader I/O',async()=>{seed(agent('a'),'terminal');await render(pane('a'));expect([...new Set(captured.terminalSessions)]).toEqual([agent('a')]);expect(container.querySelectorAll('[data-leaf="terminal"]')).toHaveLength(1);expect(read.mock.calls).toEqual([]);assertHealthy('a')})
 it('ordinary shell Terminal never manufactures Agent control or composer',async()=>{const shell:Extract<SessionSnapshot,{kind:'terminal'}>={id:'shell',kind:'terminal',hostId:'local',workspacePath:'/fixture',label:'Shell',createdAt:1,updatedAt:1,processState:'running',status:{state:'running',source:'run-process',observedAt:1},latestOutputBytes:0,providerId:null,control:{kind:'terminal',hostId:'local',runId:'shell-run',run:{runId:'shell-run'}}};seed(shell);await render(pane('shell',{surfaceKind:'terminal'}));expect([...new Set(captured.terminalSessions)]).toEqual([shell]);expect(container.querySelectorAll('[data-leaf="composer"]')).toHaveLength(0);expect(read.mock.calls).toEqual([])})
 it('hidden actual Pane still has the original Activity projection but makes zero reads',async()=>{await render(pane('a',{visible:false}));expect(container.querySelectorAll('[data-leaf="activity"]')).toHaveLength(1);expect(currentActivity().items).toEqual(timeline('a').items);expect(read.mock.calls).toEqual([]);assertHealthy('a')})
 it('cold over-day inline History uses exact original control and no new Activity reader/resume',async()=>{const cold:Extract<SessionSnapshot,{kind:'agent'}>={...agent('a'),processState:'exited',semanticStatus:{state:'done',source:'native-hook',observedAt:1,stateEnteredAt:1}};seed(cold);const recover=vi.spyOn(useAppStore.getState(),'recoverSession');const refresh=vi.spyOn(useAppStore.getState(),'refreshSession');await render(pane('a'));expect([...new Set(captured.histories)]).toEqual([cold.control]);expect(container.querySelectorAll('[data-leaf="history"]')).toHaveLength(1);expect(container.querySelectorAll('[data-leaf="activity"]')).toHaveLength(0);expect(read.mock.calls).toEqual([]);expect(recover.mock.calls).toEqual([]);expect(refresh.mock.calls).toEqual([])})
 it('missing Session keeps connecting and disabled Composer without a read',async()=>{useAppStore.setState({sessions:[],pendingAgentLaunches:{},timelines:{}});await render(pane('missing'));expect(container.querySelectorAll('[data-leaf="connecting"]')).toHaveLength(1);expect(container.querySelector('[data-leaf="composer"]')?.getAttribute('data-disabled')).toBe('true');expect(read.mock.calls).toEqual([])})
})

describe('SessionPane identity, generations and related-consumer cost', () => {
 it('resolves trusted sender and recipient separately and leaves unknown input unnamed', async () => {
  const peer = { ...agent('known-sender'), label: 'Design peer', providerId: 'claude' as const }
  await act(async () => useAppStore.setState({ sessions: [agent('a'), peer] }))
  await render(pane('a'))
  const describe = currentActivity().describeSpeaker
  expect(describe).toBeTypeOf('function')
  expect(describe?.({ role: 'agent', id: 'known-sender' })).toEqual({ name: 'Design peer', providerId: 'claude' })
  expect(describe?.({ role: 'agent', id: 'a' })).toEqual({ name: 'a', providerId: 'codex' })
  expect(describe?.({ role: 'agent', id: 'missing-sender' })).toEqual({ name: 'missing-sender' })
  expect(describe?.({ role: 'unknown', id: 'unknown' })).toEqual({ name: 'Input' })
  const trigger = container.querySelector<HTMLButtonElement>('[data-leaf="header"] button')
  expect(trigger).not.toBeNull()
  await act(async () => trigger?.click())
  expect(container.querySelectorAll('[data-leaf="history"]')).toHaveLength(1)
  expect(captured.historyResolvers.at(-1)).toBe(describe)
  expect(captured.historyResolvers.at(-1)?.({ role: 'agent', id: 'known-sender' })).toEqual({ name: 'Design peer', providerId: 'claude' })
 })

 it('retains current records without duplicate Activity reads while History covers it and on Return', async () => {
  await render(pane('a'))
  expect(currentActivity().userMessages).toEqual(expected('a'))
  const before = read.mock.calls.length
  expect(before).toBe(1)
  const trigger = container.querySelector<HTMLButtonElement>('[data-leaf="header"] button')!
  await act(async () => trigger.click())
  expect(container.querySelectorAll('[data-leaf="history"]')).toHaveLength(1)
  expect(currentActivity().userMessages).toEqual(expected('a'))
  await act(async () => useAppStore.setState({ timelines: { a: { ...timeline('a'), revision: 2 } } }))
  await flush()
  expect(read.mock.calls.length).toBe(before)
  const close = container.querySelector<HTMLButtonElement>('[data-leaf="history"] button')!
  await act(async () => close.click())
  await flush()
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control])
  expect(currentActivity().userMessages).toEqual(expected('a'))
  assertHealthy('a')
 })

 it('discards the old Session page after a real Pane switches Session', async () => {
  let resolveOld!: (value: AgentSessionHistoryPage) => void
  const old = new Promise<AgentSessionHistoryPage>((resolve) => { resolveOld = resolve })
  read.mockImplementation((control) => control.agentSessionId === 'a' ? old : Promise.resolve(page('b')))
  await render(pane('a'))
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control])
  await act(async () => seed(agent('b')))
  await render(pane('b'))
  expect(currentActivity().sessionId).toBe('b')
  expect(currentActivity().userMessages).toEqual(expected('b'))
  await act(async () => resolveOld(page('a')))
  await flush()
  expect(currentActivity().userMessages).toEqual(expected('b'))
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control, agent('b').control])
 })

 it('uses the replacement Run generation and rejects its late predecessor page', async () => {
  let resolveOld!: (value: AgentSessionHistoryPage) => void
  const old = new Promise<AgentSessionHistoryPage>((resolve) => { resolveOld = resolve })
  const current = agent('a', 'replacement-run')
  const replacementPage = { ...page('a'), items: [{ id: 'replacement-record', kind: 'user-message' as const, contentParts: [{ kind: 'text' as const, text: 'Replacement input' }] }] }
  read.mockImplementation((control) => control.run.runId === 'run-a' ? old : Promise.resolve(replacementPage))
  await render(pane('a'))
  await act(async () => seed(current))
  await flush()
  const replacementMessages = projectSessionUserMessages({ agentSessionId: 'a', historyPage: replacementPage, timeline: timeline('a') })
  expect(currentActivity().userMessages).toEqual(replacementMessages)
  expect(replacementMessages.map((message) => message.rawId)).toEqual(['replacement-record', 'submission-a'])
  await act(async () => resolveOld(page('a')))
  await flush()
  expect(currentActivity().userMessages).toEqual(replacementMessages)
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control, current.control])
  expect(useAppStore.getState().sessions.map((session) => session.control)).toEqual([current.control])
 })

 it('pauses hidden Activity demand and retains the same original messages until return', async () => {
  await render(pane('a'))
  expect(currentActivity().userMessages).toEqual(expected('a'))
  await render(pane('a', { visible: false }))
  expect(currentActivity().userMessages).toEqual(expected('a'))
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control])
  await render(pane('a'))
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control])
  expect(currentActivity().userMessages).toEqual(expected('a'))
  assertHealthy('a')
 })

 it('has positive native reads but unrelated Session output causes no additional read or Activity render', async () => {
  await render(pane('a'))
  expect(currentActivity().userMessages).toEqual(expected('a'))
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control])
  const renderCount = captured.activities.length
  await act(async () => useAppStore.setState({ timelines: { a: timeline('a'), unrelated: timeline('unrelated') } }))
  const afterSeed = captured.activities.length
  expect(afterSeed).toBeGreaterThanOrEqual(renderCount)
  const ownTimeline = useAppStore.getState().timelines.a
  expect(ownTimeline).toBeDefined()
  await act(async () => useAppStore.setState({ timelines: { a: ownTimeline!, unrelated: { ...timeline('unrelated'), revision: 2 } } }))
  await flush()
  expect(captured.activities.length).toBe(afterSeed)
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control])
  expect(currentActivity().userMessages).toEqual(expected('a'))
 })
})
