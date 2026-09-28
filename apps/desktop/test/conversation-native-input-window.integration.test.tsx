// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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
async function frame(){await act(async()=>{await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))});await flush()}
function latestWindow(id:string):AgentSessionHistoryPage{return {agentSessionId:id,source:{providerId:'codex',nativeSessionId:`native-${id}`},items:Array.from({length:30},(_,i)=>({id:`assistant-${i}`,kind:'assistant-message' as const,contentParts:[{kind:'text' as const,text:`Assistant record ${i}`}]})),nextCursor:'opaque-earlier-records'}}
function older(id:string):AgentSessionHistoryPage{return {agentSessionId:id,source:latestWindow(id).source,items:[{id:'older-input-original-id',kind:'user-message',startedAt:10,contentParts:[{kind:'text',text:'Original earlier human-shaped input; author unrecorded'}]}],nextCursor:null}}
function hook(){expect(captured.witness).not.toBeNull();return captured.witness!}
function feed(){const el=container.querySelector<HTMLElement>('.activity-feed');expect(el).not.toBeNull();return el!}
function notice(){return feed().querySelector<HTMLElement>('.activity-feed__read-notice')}
function emptyTimeline(){useAppStore.setState({timelines:{a:{agentSessionId:'a',revision:1,items:[]}}})}

describe('Native input read window in the actual conversation and original History',()=>{
 it('explains an empty latest raw window and reads an original nonempty earlier input through the same History',async()=>{
  emptyTimeline();read.mockImplementation(async(control,options)=>options?.cursor?older(control.agentSessionId):latestWindow(control.agentSessionId))
  await render(pane('a'))
  expect(read.mock.calls.map(([control,options])=>[control,options])).toEqual([[agent('a').control,{limit:30}]])
  expect(feed().querySelectorAll('.log-turn__body')).toHaveLength(0)
  expect(notice()?.textContent ?? '').toContain('Earlier conversation records are available')
  const trigger=button('Read earlier records',feed());await click(trigger)
  const history=container.querySelector<HTMLElement>('.session-history')!;expect(history).not.toBeNull()
  expect([...history.querySelectorAll('[data-history-item-id]')].map(node=>node.getAttribute('data-history-item-id'))).toEqual(Array.from({length:30},(_,i)=>`assistant-${i}`))
  await click(button('Load earlier records',history))
  const original=history.querySelector('[data-history-item-id="older-input-original-id"]')!
  expect(original).not.toBeNull();expect(original.textContent).toContain('Original earlier human-shaped input; author unrecorded')
  expect([...history.querySelectorAll('[data-history-item-id]')].map(node=>node.getAttribute('data-history-item-id'))).toEqual(['older-input-original-id',...Array.from({length:30},(_,i)=>`assistant-${i}`)])
  expect(read.mock.calls.map(([control,options])=>[control,options])).toEqual([[agent('a').control,{limit:30}],[agent('a').control,undefined],[agent('a').control,{cursor:'opaque-earlier-records'}]])
  await click(button('Activity',history));await frame()
  expect(history.hidden).toBe(true);expect(document.activeElement).toBe(trigger);assertHealthy('a')
 })
 it('shows a held initial read without declaring an empty complete conversation',async()=>{
  emptyTimeline();let finish!:(p:AgentSessionHistoryPage)=>void;read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  await render(pane('a'));expect(read).toHaveBeenCalledTimes(1)
  expect(notice()?.textContent ?? '').toContain('Reading native inputs')
  expect(feed().textContent).not.toContain('No structured activity yet')
  await act(async()=>finish(page('a')));await flush()
  expect([...feed().querySelectorAll('.log-turn__body')].map(node=>node.textContent)).toEqual([BODY,BODY]);expect(notice()).toBeNull();assertHealthy('a')
 })
 it('shows an initial read failure and retries the same hook once into real nonempty input records',async()=>{
  emptyTimeline();read.mockRejectedValueOnce(new Error('private read unavailable'))
  await render(pane('a'));expect(notice()?.textContent ?? '').toContain('Native input read failed: private read unavailable')
  expect(feed().textContent).not.toContain('No structured activity yet');const retry=button('Retry',feed())
  let finish!:(p:AgentSessionHistoryPage)=>void;read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  await click(retry);expect(notice()?.textContent ?? '').toContain('Reading native inputs');expect([...feed().querySelectorAll('button')].map(node=>node.textContent?.trim())).not.toContain('Retry');expect(read).toHaveBeenCalledTimes(2)
  await act(async()=>finish(page('a')));await flush()
  expect([...feed().querySelectorAll('.log-turn__body')].map(node=>node.textContent)).toEqual([BODY,BODY]);expect(notice()).toBeNull();assertHealthy('a')
 })
 it('keeps existing body nodes and Range while a refresh fails and while History covers its original Activity',async()=>{
  read.mockImplementation(async control=>({...page(control.agentSessionId),nextCursor:'opaque-earlier-records'}))
  await render(<>{pane('a')}<Witness control={agent('a').control}/></>)
  const activity=feed();const bodies=[...activity.querySelectorAll<HTMLElement>('.log-turn__body')];expect(bodies.map(node=>node.textContent)).toEqual([BODY,BODY,BODY])
  const text=bodies[0]!.querySelector('p')!.firstChild!;const range=document.createRange();range.setStart(text,0);range.setEnd(text,9);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);expect(selection.toString()).toBe('Identical')
  read.mockRejectedValueOnce(new Error('refresh temporarily unavailable'));await act(async()=>{await hook().refresh()});await flush()
  expect(notice()?.textContent ?? '').toContain('refresh temporarily unavailable');expect([...activity.querySelectorAll('.log-turn__body')]).toEqual(bodies);expect(selection.toString()).toBe('Identical')
  // Leave only the actual SessionPane observer, so covered Activity itself cannot fetch.
  await render(pane('a'));const trigger=button('Read earlier records',activity);const before=read.mock.calls.length;await click(trigger)
  expect(activity.parentElement?.inert).toBe(true);expect([...activity.querySelectorAll('.log-turn__body')]).toEqual(bodies)
  expect(selection.toString()).toBe('Identical');expect(read.mock.calls.length).toBe(before+1)
  const search=document.createElement('input');document.body.append(search);const history=container.querySelector<HTMLElement>('.session-history')!;const close=button('Activity',history)
  await act(async()=>{close.click();search.focus()});await frame();expect(document.activeElement).toBe(search);search.remove();assertHealthy('a')
 })
 it('does not start a native input read in a hidden or Terminal pane',async()=>{
  await render(pane('a',{visible:false}));expect(read).toHaveBeenCalledTimes(0)
  seed(agent('b'),'terminal');await render(pane('b'));expect(read).toHaveBeenCalledTimes(0);assertHealthy('b')
 })
})
