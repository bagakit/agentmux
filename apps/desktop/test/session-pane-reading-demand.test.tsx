const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { beforeEach, afterEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionUserMessage, AgentTimelineSnapshot } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { SessionSnapshot, AppConfig, AgentSessionControl } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'

// Caller qualification with controlled leaf props and history I/O. Store, hook and projector are real.
// Shared body/axis rendering is covered by conversation-native-user-messages.integration.test.tsx;
// this suite does not claim a Provider writer, physical geometry or a live Run.
type ActivityBoundary = { conversationReading?: { reference: import('../src/shared/contracts').SessionHistoryReference; enabled: boolean; nativeSourceFacts?: import('../src/shared/agent-native-source').AgentNativeSourceFacts; opened?: boolean; onClose?: () => void }; sessionId?: string; userMessages?: readonly AgentSessionUserMessage[]; items: readonly unknown[]; describeSpeaker?: DescribeSpeaker }
const captured = vi.hoisted(() => ({ activities: [] as ActivityBoundary[], terminalSessions: [] as SessionSnapshot[], witness: null as ReturnType<typeof useSessionUserMessages> | null }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: (props: ActivityBoundary) => {
  captured.activities.push(props)
  return <div data-leaf="activity" data-session={props.sessionId ?? 'absent'}>{props.conversationReading?.opened ? <nav data-leaf="reading"><button type="button" onClick={props.conversationReading.onClose}>Return</button></nav> : null}{props.userMessages?.map(item => <span key={item.id} data-record-id={item.id}>{item.content}</span>)}</div>
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

const BODY='Identical prompt from two sources'
const config: AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Private typed host'}],executors:{codex:{label:'Private typed Codex',providerId:'codex',command:'codex',args:[],env:{},injectAgentMuxGuide:true}},workspaces:[{id:'ws',name:'Private typed project',hostId:'local',path:_hygiene_fixturePath("fixture"),kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
function agent(id:string,runId=`run-${id}`): Extract<SessionSnapshot,{kind:'agent'}>{return {id,kind:'agent',hostId:'local',workspacePath:_hygiene_fixturePath("fixture"),label:id,providerId:'codex',executorId:'codex',agentSessionUpdatedAt:1,promptSubmissionPredecessor:null,createdAt:1,updatedAt:1,processState:'running',status:{state:'running',source:'run-process',observedAt:1},latestOutputBytes:0,capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control:{kind:'agent',hostId:'local',agentSessionId:id,run:{runId}}}}
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
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();container=document.createElement('div');document.body.append(container);root=createRoot(container);captured.activities=[];captured.terminalSessions=[];captured.witness=null;read=vi.spyOn(api.sessions,'historyPage').mockImplementation(async control=>page(control.agentSessionId));seed(agent('a'))})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();localStorage.clear()})

it('actual SessionPane keeps native source facts stable across status-only clones and forwards a real replacement while hidden', async () => {
 const original = { ...agent('a'), nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'native-a', transcriptPath: _hygiene_fixturePath("fixture/source-a") } }
 seed(original); await render(pane('a'))
 const before = currentActivity().conversationReading!.nativeSourceFacts
 expect(before).toBeDefined(); expect(before?.nativeHandle).toBe(original.nativeHandle)
 await render(pane('a', { visible: false }))
 await act(async () => useAppStore.setState({ sessions: [{ ...original, updatedAt: 9, status: { ...original.status, observedAt: 9 } }] }))
 expect(currentActivity().conversationReading?.enabled).toBe(false)
 expect(currentActivity().conversationReading?.nativeSourceFacts).toBe(before)
 const replacement = { ...original, nativeHandle: { ...original.nativeHandle, sessionId: 'native-b' } }
 await act(async () => useAppStore.setState({ sessions: [replacement] }))
 const after = currentActivity().conversationReading!.nativeSourceFacts
 expect(after).not.toBe(before); expect(after?.nativeHandle).toBe(replacement.nativeHandle)
 expect(useAppStore.getState().agentComposerDrafts.a).toBe('UNSENT_REAL_STORE_DRAFT')
 expect(useAppStore.getState().sessions[0]?.control).toEqual(original.control)
})
