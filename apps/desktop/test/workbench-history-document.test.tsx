const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { beforeEach, afterEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot, AppConfig, AgentSessionControl } from '../src/shared/contracts'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'

// Actual Store, hook, public projector, Activity and History; typed page transport and
// PTY/composer/chrome leaves are controlled. No Provider writer or physical Run claim.
const captured = vi.hoisted(() => ({ witness: null as ReturnType<typeof useSessionUserMessages> | null }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({session}: {session: SessionSnapshot}) => { return <div data-leaf="terminal" /> } }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({sessionId,disabled=false}: {sessionId:string;disabled?:boolean}) => <div data-leaf="composer" data-session={sessionId} data-disabled={String(disabled)} /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({sessionId,onHistory}: {sessionId:string;onHistory?:()=>void}) => <header data-leaf="header" data-session={sessionId}><button type="button" className="agent-region-header__more" onClick={onHistory}>History</button></header> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => <div data-leaf="connecting" /> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('@agentmux/client-ui/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => <div data-leaf="interaction" /> }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const BODY='Identical prompt from two sources'
const config: AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Private typed host'}],executors:{codex:{label:'Private typed Codex',providerId:'codex',command:'codex',args:[],env:{},injectAgentMuxGuide:true}},workspaces:[{id:'ws',name:'Private typed project',hostId:'local',path:_hygiene_fixturePath("fixture"),kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
function agent(id:string,runId=`run-${id}`): Extract<SessionSnapshot,{kind:'agent'}>{return {id,kind:'agent',hostId:'local',workspacePath:_hygiene_fixturePath("fixture"),label:id,providerId:'codex',executorId:'codex',agentSessionUpdatedAt:_historyFixtureEpoch(0, 0, 1),promptSubmissionPredecessor:null,createdAt:_historyFixtureEpoch(0, 0, 1),updatedAt:_historyFixtureEpoch(0, 0, 1),processState:'running',status:{state:'running',source:'run-process',observedAt:_historyFixtureEpoch(0, 0, 1)},latestOutputBytes:0,capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control:{kind:'agent',hostId:'local',agentSessionId:id,run:{runId}}}}
function page(id:string): AgentSessionHistoryPage{return {agentSessionId:id,source:{providerId:'codex',nativeSessionId:`native-${id}`},items:[{id:'record-1',kind:'user-message',startedAt:_historyFixtureEpoch(0, 0, 100),contentParts:[{kind:'text',text:BODY}]},{id:'record-2',kind:'user-message',contentParts:[{kind:'text',text:BODY}]}],nextCursor:null}}
function timeline(id:string): AgentTimelineSnapshot{return {agentSessionId:id,revision:1,items:[{id:`submission-${id}`,agentSessionId:id,kind:'user_message',status:'complete',source:'user',createdAt:_historyFixtureEpoch(0, 0, 100),updatedAt:_historyFixtureEpoch(0, 0, 100),title:'Recorded prompt',content:BODY,authorAgentSessionId:'known-sender'}]}}
function pane(id:string,{visible=true,readOnly=false,surfaceKind='agent'}:{visible?:boolean;readOnly?:boolean;surfaceKind?:'agent'|'terminal'}={}) {return <SessionPane sessionId={id} surfaceKind={surfaceKind} interactiveResize={false} visible={visible} readOnly={readOnly} linkOrigin={{workspaceId:'ws',tabGroupId:'group',tabId:'tab',regionId:'region'}} />}
function Witness({control,enabled=true}:{control:AgentSessionControl;enabled?:boolean}){const result=useSessionUserMessages(control,{enabled});captured.witness=result;return <div data-witness="hook">{result.messages.map(item=><span key={item.id} data-record-id={item.id}>{item.content}</span>)}</div>}
const initial=useAppStore.getState();let container:HTMLDivElement;let root:Root;let read:MockInstance<typeof api.sessions.historyPage>;let controlWrites:MockInstance[]=[]
async function flush(){await act(async()=>{for(let n=0;n<10;n++)await Promise.resolve()})}
async function render(node:ReactNode){await act(async()=>root.render(node));await flush()}
function seed(session:SessionSnapshot,mode:'activity'|'terminal'='activity'){useAppStore.setState({config,sessions:[session],pendingAgentLaunches:{},recoveryCandidates:[],runtimeOwnershipWarnings:[],viewModes:{[session.id]:mode},timelines:{[session.id]:timeline(session.id)},agentNames:{},agentComposerDrafts:{[session.id]:'UNSENT_REAL_STORE_DRAFT'},agentSteerQueues:{}})}
function assertHealthy(id:string){expect(useAppStore.getState().sessions.map(s=>[s.id,s.control,s.processState])).toEqual([[id,agent(id).control,'running']]);expect(useAppStore.getState().agentComposerDrafts[id]).toBe('UNSENT_REAL_STORE_DRAFT');expect(container.querySelector('[data-leaf="composer"]')?.getAttribute('data-disabled')).toBe('false')}
beforeEach(()=>{controlWrites=[vi.spyOn(api.sessions,'submitPrompt'),vi.spyOn(api.sessions,'write'),vi.spyOn(api.sessions,'resume'),vi.spyOn(api.sessions,'recover'),vi.spyOn(api.sessions,'stop')];vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();container=document.createElement('div');document.body.append(container);root=createRoot(container);captured.witness=null;read=vi.spyOn(api.sessions,'historyPage').mockImplementation(async control=>page(control.agentSessionId));seed(agent('a'))})
afterEach(async()=>{for(const writer of controlWrites)expect(writer).toHaveBeenCalledTimes(0);await act(async()=>root.unmount());container.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();localStorage.clear()})


// Store, public projector, native-message hook, Activity and History are actual product modules.
// Only PTY/composer/chrome leaves and typed page transport are controlled; no writer/Run proof.
function button(label:string,scope:ParentNode=container){const found=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent?.trim()===label);expect(found,`button ${label}`).toBeDefined();return found!}
async function click(node:HTMLButtonElement){await act(async()=>{node.focus();node.click()});await flush()}
async function frame(...schedulers: Array<typeof requestAnimationFrame>){await act(async()=>{await Promise.all(schedulers.map(schedule=>new Promise<void>(resolve=>schedule(()=>resolve()))))});await flush()}
function latestWindow(id:string):AgentSessionHistoryPage{return {agentSessionId:id,source:{providerId:'codex',nativeSessionId:`native-${id}`},items:Array.from({length:30},(_,i)=>({id:`assistant-${i}`,kind:'assistant-message' as const,contentParts:[{kind:'text' as const,text:`Assistant record ${i}`}]})),nextCursor:'opaque-earlier-records'}}
function older(id:string):AgentSessionHistoryPage{return {agentSessionId:id,source:latestWindow(id).source,items:[{id:'older-input-original-id',kind:'user-message',startedAt:_historyFixtureEpoch(0, 0, 10),contentParts:[{kind:'text',text:'Original earlier human-shaped input; author unrecorded'}]}],nextCursor:null}}
function hook(){expect(captured.witness).not.toBeNull();return captured.witness!}
function feed(){const el=container.querySelector<HTMLElement>('.activity-feed');expect(el).not.toBeNull();return el!}
function notice(){return feed().querySelector<HTMLElement>('.activity-feed__read-notice')}
function emptyTimeline(){useAppStore.setState({timelines:{a:{agentSessionId:'a',revision:1,items:[]}}})}


import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

it.each(['trigger', 'later child caret'])('routes original History return to its child workface without taking a later main caret: %s',async mode=>{
 const frameElement=document.createElement('iframe'), mainCaret=document.createElement('input');document.body.append(frameElement,mainCaret);const child=frameElement.contentDocument!;child.body.append(child.adoptNode(container));
 try{
  read.mockImplementation(async control=>({...page(control.agentSessionId),nextCursor:'opaque-earlier-records'}));
  await render(<WorkbenchDocumentContext.Provider value={{document:child,window:null}}>{pane('a')}</WorkbenchDocumentContext.Provider>);
  const target=container.querySelector<HTMLButtonElement>('.agent-region-header__more')!;
  await click(button('History'));const history=feed();expect(history.querySelector('[aria-label="Return to Activity"]')).not.toBeNull();
  await act(async()=>mainCaret.focus());expect(document.activeElement).toBe(mainCaret);
  // Drain both actual document queues, including a wrongly selected Main queue.
  // Capture the original functions before observing the child's product scheduling.
  const mainFrame=document.defaultView!.requestAnimationFrame.bind(document.defaultView),childFrame=child.defaultView!.requestAnimationFrame.bind(child.defaultView);
  const schedule=vi.spyOn(child.defaultView!,'requestAnimationFrame');const close=history.querySelector<HTMLButtonElement>('[aria-label="Return to Activity"]')!;const laterCaret=child.createElement('input');child.body.append(laterCaret);await act(async()=>{close.focus();close.click();if(mode==='later child caret')laterCaret.focus()});await frame(mainFrame,childFrame);
  expect(history.querySelector('[aria-label="Return to Activity"]')).toBeNull();expect(child.activeElement).toBe(mode==='later child caret'?laterCaret:target);expect(document.activeElement).toBe(mainCaret);
  expect(schedule).toHaveBeenCalledOnce();laterCaret.remove();assertHealthy('a');
 }finally{await act(async()=>root.render(null));frameElement.remove();mainCaret.remove()}
})
