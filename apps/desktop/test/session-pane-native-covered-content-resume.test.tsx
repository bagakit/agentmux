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


describe('Actual native Activity body while History covers its original view', () => {
 it('keeps the same nonempty native message bodies and selected native text until Return', async () => {
  await render(pane('a'))
  const bodies = [...container.querySelectorAll<HTMLElement>('.log-turn__body')]
  expect(bodies).toHaveLength(3)
  expect(bodies.map(body => body.textContent)).toEqual([BODY, BODY, BODY])
  const nativeBody = bodies[0]!
  const text = nativeBody.querySelector('p')!.firstChild!
  const range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 9)
  const selection = window.getSelection()!
  selection.removeAllRanges(); selection.addRange(range)
  expect(selection.toString()).toBe('Identical')
  const trigger = container.querySelector<HTMLButtonElement>('[data-leaf="header"] button')!
  await act(async () => trigger.click())
  expect(container.querySelectorAll('[data-leaf="history"]')).toHaveLength(1)
  expect(nativeBody.isConnected).toBe(true)
  expect([...container.querySelectorAll('.log-turn__body')]).toEqual(bodies)
  expect(selection.toString()).toBe('Identical')
 })
})


describe('Original Activity reading state across History and Return', () => {
 it('preserves native bodies, Range, expanded tools, scroll position and draft in the same Activity instance', async () => {
  const tools = [
   { id: 'tool-alpha', agentSessionId: 'a', kind: 'tool_call' as const, status: 'complete' as const, source: 'native-hook' as const, createdAt: 200, updatedAt: 201, title: 'Read file', toolName: 'read_file', toolInput: 'src/active-file.ts', toolOutput: 'Original file content' },
   { id: 'tool-beta', agentSessionId: 'a', kind: 'tool_call' as const, status: 'complete' as const, source: 'native-hook' as const, createdAt: 210, updatedAt: 211, title: 'Search references', toolName: 'search', toolInput: 'original-reference', toolOutput: 'Original reference result' }
  ]
  await act(async () => useAppStore.setState({ timelines: { a: { ...timeline('a'), items: [...timeline('a').items, ...tools] } } }))
  await render(pane('a'))
  const activity = container.querySelector<HTMLElement>('.activity-feed')!
  const bodies = [...activity.querySelectorAll<HTMLElement>('.log-turn__body')]
  expect(bodies.map(body => body.textContent)).toEqual([BODY, BODY, BODY])
  const fold = activity.querySelector<HTMLButtonElement>('.log-fold')!
  expect(fold).not.toBeNull()
  await act(async () => fold.click())
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  const row = activity.querySelector<HTMLButtonElement>('.log-row[data-expandable]')!
  expect(row).not.toBeNull()
  await act(async () => row.click())
  expect(row.getAttribute('aria-expanded')).toBe('true')
  const output = activity.querySelector('.log-row__output')!
  expect(output?.textContent).toBe('Original file content')
  Object.defineProperty(activity, 'clientHeight', { configurable: true, value: 150 })
  Object.defineProperty(activity, 'scrollHeight', { configurable: true, value: 700 })
  await act(async () => { activity.scrollTop = 550; activity.dispatchEvent(new Event('scroll')) })
  await act(async () => { activity.scrollTop = 219; activity.dispatchEvent(new Event('scroll')) })
  expect(activity.scrollTop).toBe(219)
  const text = bodies[0]!.querySelector('p')!.firstChild!
  const range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 9)
  const selection = window.getSelection()!
  selection.removeAllRanges(); selection.addRange(range)
  expect(selection.toString()).toBe('Identical')
  const reads = read.mock.calls.length
  expect(reads).toBe(1)
  const trigger = container.querySelector<HTMLButtonElement>('[data-leaf="header"] button')!
  await act(async () => trigger.click())
  expect(container.querySelectorAll('[data-leaf="history"]')).toHaveLength(1)
  expect(activity.isConnected).toBe(true)
  expect(bodies.map(body => body.isConnected)).toEqual([true, true, true])
  expect([...activity.querySelectorAll('.log-turn__body')]).toEqual(bodies)
  expect(range.startContainer).toBe(text)
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(row.getAttribute('aria-expanded')).toBe('true')
  expect(activity.querySelector('.log-row__output')).toBe(output)
  expect(activity.scrollTop).toBe(219)
  expect(read.mock.calls.length).toBe(reads)
  const close = container.querySelector<HTMLButtonElement>('[data-leaf="history"] button')!
  await act(async () => close.click())
  await flush()
  expect(container.querySelectorAll('[data-leaf="history"]')).toHaveLength(0)
  expect(container.querySelector('.activity-feed')).toBe(activity)
  expect([...activity.querySelectorAll('.log-turn__body')]).toEqual(bodies)
  expect(selection.toString()).toBe('Identical')
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(row.getAttribute('aria-expanded')).toBe('true')
  expect(activity.querySelector('.log-row__output')).toBe(output)
  expect(activity.scrollTop).toBe(219)
  assertHealthy('a')
 })

 it('does not apply an already pending native page while History covers the original Activity', async () => {
  let resolvePending!: (value: AgentSessionHistoryPage) => void
  const pending = new Promise<AgentSessionHistoryPage>(resolve => { resolvePending = resolve })
  read.mockImplementationOnce(() => pending)
  await render(pane('a'))
  const activity = container.querySelector<HTMLElement>('.activity-feed')!
  const capturedBody = activity.querySelector<HTMLElement>('.log-turn__body')!
  expect(capturedBody.textContent).toBe(BODY)
  expect(activity.querySelectorAll('.log-turn__body')).toHaveLength(1)
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control])
  await act(async () => container.querySelector<HTMLButtonElement>('[data-leaf="header"] button')!.click())
  expect(container.querySelectorAll('[data-leaf="history"]')).toHaveLength(1)
  await act(async () => resolvePending(page('a')))
  await flush()
  expect(container.querySelector('.activity-feed')).toBe(activity)
  expect([...activity.querySelectorAll('.log-turn__body')]).toEqual([capturedBody])
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control])
  await act(async () => container.querySelector<HTMLButtonElement>('[data-leaf="history"] button')!.click())
  await flush()
  expect(container.querySelectorAll('[data-leaf="history"]')).toHaveLength(0)
  expect(container.querySelector('.activity-feed')).toBe(activity)
  expect([...activity.querySelectorAll('.log-turn__body')].map(body => body.textContent)).toEqual([BODY, BODY, BODY])
  expect(read.mock.calls.map(([control]) => control)).toEqual([agent('a').control, agent('a').control])
  expect(capturedBody.isConnected).toBe(true)
  assertHealthy('a')
 })
})
