const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { beforeEach, afterEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionUserMessage, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot, AppConfig } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

// Caller qualification with controlled leaf props and history I/O. Store, hook and projector are real.
// Shared body/axis rendering is covered by conversation-native-user-messages.integration.test.tsx;
// this suite does not claim a Provider writer, physical geometry or a live Run.
type ActivityBoundary = { conversationReading?: { reference: import('../src/shared/contracts').SessionHistoryReference; enabled: boolean; nativeSourceFacts?: import('../src/shared/agent-native-source').AgentNativeSourceFacts; opened?: boolean; onClose?: () => void }; sessionId?: string; userMessages?: readonly AgentSessionUserMessage[]; items: readonly unknown[]; describeSpeaker?: DescribeSpeaker; readingNotice?: ReactNode; readingAction?: ReactNode; displayState?: string }
const captured = vi.hoisted(() => ({ activities: [] as ActivityBoundary[], terminalSessions: [] as SessionSnapshot[] }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: (props: ActivityBoundary) => {
  captured.activities.push(props)
  return <div data-leaf="activity" data-session={props.sessionId ?? 'absent'}>{props.readingNotice}{props.readingAction}{props.items.map((item:any)=><p key={item.id}>{item.content}</p>)}{props.conversationReading?.opened ? <nav data-leaf="reading"><button type="button" onClick={props.conversationReading.onClose}>Return</button></nav> : null}{props.userMessages?.map(item => <span key={item.id} data-record-id={item.id}>{item.content}</span>)}</div>
} }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({session}: {session: SessionSnapshot}) => { captured.terminalSessions.push(session);return <div data-leaf="terminal" /> } }))

vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({sessionId,disabled=false}: {sessionId:string;disabled?:boolean}) => <div data-leaf="composer" data-session={sessionId} data-disabled={String(disabled)} /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({sessionId,onHistory}: {sessionId:string;onHistory?:()=>void}) => <header data-leaf="header" data-session={sessionId}>{onHistory ? <button type="button" onClick={onHistory}>History</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => <div data-leaf="connecting" /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('@agentmux/client-ui/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => <div data-leaf="interaction" /> }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const BODY='Original retained conversation body'
const config: AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Private typed host'}],executors:{codex:{label:'Private typed Codex',providerId:'codex',command:'codex',args:[],env:{},injectAgentMuxGuide:true}},workspaces:[{id:'ws',name:'Private typed project',hostId:'local',path:_hygiene_fixturePath("fixture"),kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
function agent(id:string,runId=`run-${id}`): Extract<SessionSnapshot,{kind:'agent'}>{return {id,kind:'agent',hostId:'local',workspacePath:_hygiene_fixturePath("fixture"),label:id,providerId:'codex',executorId:'codex',agentSessionUpdatedAt:_historyFixtureEpoch(0, 0, 1),promptSubmissionPredecessor:null,createdAt:_historyFixtureEpoch(0, 0, 1),updatedAt:_historyFixtureEpoch(0, 0, 1),processState:'running',status:{state:'running',source:'run-process',observedAt:_historyFixtureEpoch(0, 0, 1)},latestOutputBytes:0,capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control:{kind:'agent',hostId:'local',agentSessionId:id,run:{runId}}}}
function page(id:string): AgentSessionHistoryPage{return {agentSessionId:id,source:{providerId:'codex',nativeSessionId:`native-${id}`},items:[{id:'record-1',kind:'user-message',startedAt:_historyFixtureEpoch(0, 0, 100),contentParts:[{kind:'text',text:BODY}]},{id:'record-2',kind:'user-message',contentParts:[{kind:'text',text:BODY}]}],nextCursor:null}}
function timeline(id:string): AgentTimelineSnapshot{return {agentSessionId:id,revision:1,items:[{id:`submission-${id}`,agentSessionId:id,kind:'user_message',status:'complete',source:'user',createdAt:_historyFixtureEpoch(0, 0, 100),updatedAt:_historyFixtureEpoch(0, 0, 100),title:'Recorded prompt',content:BODY,authorAgentSessionId:'known-sender'}]}}
function pane(id:string,{visible=true,readOnly=false,surfaceKind='agent'}:{visible?:boolean;readOnly?:boolean;surfaceKind?:'agent'|'terminal'}={}) {return <SessionPane sessionId={id} surfaceKind={surfaceKind} interactiveResize={false} visible={visible} readOnly={readOnly} linkOrigin={{workspaceId:'ws',tabGroupId:'group',tabId:'tab',regionId:'region'}} />}
const initial=useAppStore.getState();let container:HTMLDivElement;let root:Root;let read:MockInstance<typeof api.sessions.historyPage>
async function flush(){await act(async()=>{for(let n=0;n<10;n++)await Promise.resolve()})}
async function render(node:ReactNode){await act(async()=>root.render(node));await flush()}
function seed(session:SessionSnapshot,mode:'activity'|'terminal'='activity'){useAppStore.setState({config,tabs:{tab:createWorkbenchTab('tab',{regionId:'region',workspaceId:'ws',kind:'agent',phase:'attached',sessionId:session.id})},sessions:[session],pendingAgentLaunches:{},recoveryCandidates:[],runtimeOwnershipWarnings:[],viewModes:{[session.id]:mode},timelines:{[session.id]:timeline(session.id)},agentNames:{},agentComposerDrafts:{[session.id]:'UNSENT_REAL_STORE_DRAFT'},agentSteerQueues:{}})}
function currentActivity(){expect(captured.activities.length).toBeGreaterThan(0);const props=captured.activities.at(-1);expect(props).toBeDefined();return props!}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();container=document.createElement('div');document.body.append(container);root=createRoot(container);captured.activities=[];captured.terminalSessions=[];read=vi.spyOn(api.sessions,'historyPage').mockImplementation(async control=>page(control.agentSessionId));seed(agent('a'))})
afterEach(async()=>{try { await act(async()=>root.unmount()) } finally { container.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear() }})

import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

function retained(kind:'pending'|'starting'='pending',reason='active-manual'):Extract<SessionSnapshot,{kind:'agent'}>{const original=agent('a');return {...original,processState:'interrupted',status:{state:'exited',source:'run-process',observedAt:_historyFixtureEpoch(0, 0, 2)},continuity:{operationId:'original-restore',agentSessionId:'a',trigger:'startup',policy:{...DEFAULT_AGENT_CONTINUITY_POLICY},previousRun:original.control.run,admittedAt:_historyFixtureEpoch(0, 0, 2),observedAt:_historyFixtureEpoch(0, 0, 2),rechecks:0,kind,reason,evidence:{kind:'run-ended',state:'interrupted',observedAt:_historyFixtureEpoch(0, 0, 2)}}}}
async function history(){const button=[...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='History');expect(button).toBeDefined();await act(async()=>button!.click());await flush()}
function stage(){const node=container.querySelector('[data-loading-scope="region"]');expect(node).not.toBeNull();return node!}
function notice(){const node=container.querySelector('.activity-feed__read-notice');expect(node).not.toBeNull();return node!}
function unchanged(session:SessionSnapshot){expect(useAppStore.getState().sessions).toEqual([session]);expect(useAppStore.getState().agentComposerDrafts.a).toBe('UNSENT_REAL_STORE_DRAFT')}

describe('actual SessionPane restoration presentation',()=>{
 it('shows exact automatic Core starting in both original stage and retained history without a local recovery request',async()=>{
  const original=retained('starting','interrupted-working');seed(original);const recover=vi.spyOn(useAppStore.getState(),'recoverSession'),reopen=vi.spyOn(useAppStore.getState(),'reopenRetiredSession');await render(pane('a'))
  expect(stage().getAttribute('data-loading-phase')).toBe('recovering');expect(stage().textContent).toContain('Restoring your session');expect(stage().getAttribute('aria-busy')).toBe('true')
  await history();expect(notice().querySelector('strong')?.textContent).toBe('Restoring your session');expect(container.querySelector('[data-leaf="activity"]')?.textContent).toContain(BODY)
  expect(currentActivity().displayState).toBe('exited');expect(recover).not.toHaveBeenCalled();expect(reopen).not.toHaveBeenCalled();unchanged(original)
 })
 it('shows pending, then starting, then healthy at the same mounted Session without changing its draft or invoking recovery',async()=>{
  const pending=retained();seed(pending);const recover=vi.spyOn(useAppStore.getState(),'recoverSession');await render(pane('a'));expect(stage().textContent).toContain('Waiting to restore');expect(stage().getAttribute('data-loading-phase')).toBe('parked')
  await history();expect(notice().textContent).toContain('Automatic recovery of interrupted work is disabled')
  await act(async()=>useAppStore.setState({sessions:[retained('starting','interrupted-working')]}));expect(notice().querySelector('strong')?.textContent).toBe('Restoring your session')
  const live={...agent('a','new-run'),continuity:{...pending.continuity!,kind:'resumed' as const,newRun:{runId:'new-run'}}};await act(async()=>useAppStore.setState({sessions:[live]}));await flush()
  expect(container.querySelector('.activity-feed__read-notice')).toBeNull();expect(currentActivity().displayState).toBe('running');expect(recover).not.toHaveBeenCalled();unchanged(live)
 })
 it.each(['runtime-unverified','provider-unverified','operation-unconfirmed'].flatMap(reason=>['exited','error'].map(state=>({reason,state}))))('keeps $reason with $state status explicitly unknown instead of declaring a restore failure or process exit',async({reason,state})=>{
  const original=retained('pending',reason);original.status={...original.status,state:state as 'exited'|'error'};seed(original);await render(pane('a'));expect(stage().textContent).toContain('Session state unconfirmed');expect(stage().getAttribute('data-loading-phase')).toBe('parked');expect(stage().textContent).not.toContain('Agent process exited')
  await history();expect(notice().querySelector('strong')?.textContent).toBe('Session state unconfirmed');unchanged(original)
 })
 it('keeps an unobserved placeholder unknown even when its local placeholder status is error/exited',async()=>{
  const original={...retained(),continuity:undefined,runUnobserved:true as const,processState:'exited' as const,status:{state:'error' as const,source:'run-process' as const,observedAt:_historyFixtureEpoch(0, 0, 2),detail:'Original Host observation is unavailable.'}};seed(original);await render(pane('a'))
  expect(stage().getAttribute('data-loading-phase')).toBe('parked');expect(stage().textContent).toContain('Session state unconfirmed');await history();expect(notice().textContent).toContain('Session state unconfirmed');unchanged(original)
 })
 it.each(['foreign-session','old-run','wrong-new-run'])('does not apply %s starting to this retained or healthy Run',async mode=>{
  const original=retained('starting','interrupted-working');original.continuity={...original.continuity!,...(mode==='foreign-session'?{agentSessionId:'foreign'}:mode==='old-run'?{previousRun:{runId:'old-run'}}:{newRun:{runId:'different-new-run'}})};seed(original);await render(pane('a'))
  expect(stage().getAttribute('data-loading-phase')).toBe('parked');expect(stage().textContent).not.toContain('Restoring your session');await history();expect(notice().textContent).not.toContain('Restoring your session')
  const healthy={...original,processState:'running' as const,status:agent('a').status};await act(async()=>useAppStore.setState({sessions:[healthy]}));await flush();expect(container.querySelector('.activity-feed__read-notice')).toBeNull();unchanged(healthy)
 })
 it('shows a boundary DTO with current starting and a running process without changing pending/reading/action eligibility',async()=>{
  // Core normally publishes the new Run and resumed atomically; this protects the typed presentation boundary only.
  const original={...retained('starting','interrupted-working'),processState:'running' as const,status:agent('a').status};seed(original);await render(pane('a'))
  expect(notice().querySelector('strong')?.textContent).toBe('Restoring your session');expect(currentActivity().readingAction).toBeUndefined();expect(currentActivity().conversationReading?.enabled).toBe(true);expect(container.querySelector('[data-loading-scope="region"]')).toBeNull();unchanged(original)
 })
 it.each([
  {continuity:'unavailable' as const,continuityReason:'provider-unavailable' as const,title:'Provider unavailable on this Host',disabled:false},
  {continuity:'conflict' as const,continuityConflict:'lifecycle-busy' as const,title:'Another operation is using this Agent',disabled:true},
  {continuity:'conflict' as const,continuityConflict:'session-run-changed' as const,title:'This Agent already moved to a newer Run',disabled:false}
 ])('keeps the original failure/conflict reason and original action for $title',async({title,disabled,...status})=>{
  const original={...retained(),continuity:undefined,status:{state:'error' as const,source:'run-process' as const,observedAt:_historyFixtureEpoch(0, 0, 2),...status}};seed(original);await render(pane('a'))
  expect(stage().getAttribute('data-loading-phase')).toBe('failed');expect(stage().textContent).toContain(title)
  const button=[...stage().querySelectorAll<HTMLButtonElement>('button')].find(button=>/Restore original|Waiting for operation|Re-read original/.test(button.textContent??''));expect(button).toBeDefined();expect(button!.disabled).toBe(disabled)
  await history();expect(notice().querySelector('strong')?.textContent).toBe(title);expect(currentActivity().readingAction).toBeDefined();unchanged(original)
 })
 it('does not present an old continuity failure on a confirmed healthy newer Run',async()=>{
  const original={...agent('a','healthy-new-run'),continuity:{...retained('starting').continuity!,kind:'unavailable' as const},status:{...agent('a').status,continuity:'unavailable' as const,continuityReason:'provider-unavailable' as const}};seed(original);await render(pane('a'))
  expect(container.querySelector('.activity-feed__read-notice')).toBeNull();expect(container.querySelector('[data-loading-scope="region"]')).toBeNull();expect(currentActivity().conversationReading?.enabled).toBe(true);unchanged(original)
 })
 it('distinguishes a confirmed current process exit from Session retirement and keeps its original cause',async()=>{
  const original={...retained(),continuity:undefined,processState:'exited' as const,status:{state:'exited' as const,source:'run-process' as const,observedAt:_historyFixtureEpoch(0, 0, 2),exitReason:'user-stopped' as const}};seed(original);await render(pane('a'))
  expect(stage().textContent).toContain('Agent process exited');expect(stage().textContent).toContain('You stopped this session.');await history();expect(notice().querySelector('strong')?.textContent).toBe('Agent process exited');unchanged(original)
 })
})
