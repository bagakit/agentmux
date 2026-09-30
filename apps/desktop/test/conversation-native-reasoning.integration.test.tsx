// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot, AppConfig, AgentSessionControl } from '../src/shared/contracts'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { ConversationNativeThread } from '../src/renderer/src/components/ConversationNativeThread'

// Actual public Client/Claude reader/FileStore, hook, Store, SessionPane, Activity,
// History, Message and ReasoningTrace. Only PTY/composer/chrome are controlled leaves.
const observed = vi.hoisted(() => ({ hook: null as ReturnType<typeof useSessionUserMessages> | null }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({sessionId, disabled=false}: {sessionId:string;disabled?:boolean}) => <div data-leaf="composer" data-session={sessionId} data-disabled={String(disabled)} /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({onHistory}: {onHistory?:()=>void}) => <header data-leaf="header">{onHistory ? <button onClick={onHistory}>History</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const ID='private-agent', DRAFT='Keep the original unsent draft.'
const control: AgentSessionControl={kind:'agent',hostId:'local',agentSessionId:ID,run:{runId:'unchanged-private-run'}}
const config:AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Private host'}],executors:{claude:{label:'Claude',providerId:'claude',command:'claude',args:[],env:{},injectAgentMuxGuide:true}},workspaces:[{id:'ws',name:'Private project',hostId:'local',path:'/fixture',kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
function session(c=control):Extract<SessionSnapshot,{kind:'agent'}>{return {id:c.agentSessionId,kind:'agent',hostId:c.hostId,workspacePath:'/fixture',label:'Execution Agent',providerId:'claude',executorId:'claude',agentSessionUpdatedAt:1,promptSubmissionPredecessor:null,createdAt:1,updatedAt:1,processState:'running',status:{state:'done',source:'native-hook',observedAt:1},latestOutputBytes:0,capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control:c}}
function timeline(id=ID):AgentTimelineSnapshot{return {agentSessionId:id,revision:1,items:[{id:'answer-hook',agentSessionId:id,kind:'assistant_message',source:'native-hook',status:'complete',createdAt:100,updatedAt:100,title:'Assistant response',content:'A real answer appears once in the primary conversation.'}]}}
function seed(c=control){useAppStore.setState({config,sessions:[session(c)],pendingAgentLaunches:{},recoveryCandidates:[],runtimeOwnershipWarnings:[],viewModes:{[c.agentSessionId]:'activity'},timelines:{[c.agentSessionId]:timeline(c.agentSessionId)},agentNames:{},agentComposerDrafts:{[c.agentSessionId]:DRAFT},agentSteerQueues:{}})}
function pane(visible=true,c=control){return <SessionPane sessionId={c.agentSessionId} surfaceKind="agent" interactiveResize={false} visible={visible} linkOrigin={{workspaceId:'ws',tabGroupId:'group',tabId:'tab',regionId:'region'}} />}
function Witness({enabled=true,c=control}:{enabled?:boolean;c?:AgentSessionControl}){observed.hook=useSessionUserMessages(c,{enabled});return null}
const record=(uuid:string,type:string,content:unknown)=>({sessionId:'native-main',uuid,type,message:{role:type,content},timestamp:'2026-10-04T00:00:00.000Z'})
const nativeRecords=[
 record('u','user','A legitimate native prompt.'),
 record('r','assistant',[{type:'thinking',thinking:'Exposed reasoning-only record.'}]),
 record('a','assistant',[{type:'thinking',thinking:'**First thought** with a list:\n- Read the actual page.'},{type:'text',text:'A real answer appears once in the primary conversation.'},{type:'tool_use',id:'call-1',name:'Read',input:{file:'src/main.ts'}},{type:'thinking',thinking:'Exposed second thought.'},{type:'image',source:{type:'url',url:'https://example.test/native.png'}}]),
 record('text-only','assistant',[{type:'text',text:'Text-only record stays in full History.'}])
]
function typedPage(c=control,items:AgentSessionHistoryPage['items']=[]):AgentSessionHistoryPage{return {agentSessionId:c.agentSessionId,source:{providerId:'claude',nativeSessionId:'native-'+c.agentSessionId},items,nextCursor:null}}
const initial=useAppStore.getState();let host:HTMLDivElement;let root:Root;let fixture:Awaited<ReturnType<typeof nativeHistoryFixture>>;let read:MockInstance<typeof api.sessions.historyPage>;let writes:MockInstance[]=[]
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('IntersectionObserver',class{observe(){}disconnect(){}})
 localStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host);observed.hook=null
 fixture=await nativeHistoryFixture('claude',jsonl(nativeRecords));seed()
 read=vi.spyOn(api.sessions,'historyPage').mockImplementation((c,options)=>fixture.client.sessionHistoryPage(c.agentSessionId,options))
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
function nativeRegion(){const el=host.querySelector<HTMLElement>('.conversation-native-thread');expect(el).not.toBeNull();return el!}
function detail(id:string,occurrence=0){const nodes=host.querySelectorAll<HTMLDetailsElement>(`[data-native-record-id="${id}"] details[data-trace-kind="reasoning"]`);expect(nodes.length).toBeGreaterThan(occurrence);return nodes[occurrence]!}
async function open(d:HTMLDetailsElement,open=true){await act(async()=>{d.open=open;d.dispatchEvent(new Event('toggle'))})}
function button(text:string,scope:ParentNode=host){const found=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===text);expect(found,`button ${text}`).toBeDefined();return found!}
async function click(b:HTMLButtonElement){await act(async()=>b.click())}
function healthy(){expect(useAppStore.getState().sessions.map(s=>[s.id,s.control,s.processState])).toEqual([[ID,control,'running']]);expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT)}
function selectText(el:Element){const text=el.querySelector('p')!.firstChild!;const range=document.createRange();range.setStart(text,0);range.setEnd(text,7);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);expect(selection.toString()).toBe('Exposed');return {text,range,selection}}

describe('Provider reasoning from the already observed native page',()=>{
 it('turns the real public Claude/FileStore→hook→SessionPane→Activity missing-reasoning counterexample GREEN',async()=>{
  await render(<>{pane()}<Witness /></>);await waitFor(()=>expect(host.querySelectorAll('.conversation-native-thread details[data-trace-kind="reasoning"]')).toHaveLength(3))
  expect(read.mock.calls.map(([c,o])=>[c,o])).toEqual([[control,{limit:30}]])
  expect(observed.hook!.nativeHistoryPage!.items.map(x=>x.id)).toEqual(['u','r','a','text-only'])
  expect(observed.hook!.messages.map(x=>x.rawId)).toEqual(['u'])
  expect(nativeRegion().getAttribute('aria-label')).toBe('Native conversation')
  expect([...nativeRegion().querySelectorAll('[data-native-record-id]')].map(x=>x.getAttribute('data-native-record-id'))).toEqual(['u','r','a','text-only'])
  expect(host.textContent).toContain('A legitimate native prompt.');expect(nativeRegion().textContent).toContain('Text-only record stays in full History.')
  expect(host.querySelectorAll('.log-turn__text')).toHaveLength(4)
  expect(nativeRegion().querySelectorAll('.log-turn__trace-body')).toHaveLength(0)
  await open(detail('r'));expect(nativeRegion().textContent).toContain('Exposed reasoning-only record.');healthy()
 })
 it('uses the same Reasoning component and exact mixed parts while answers stay readable without another read',async()=>{
  await render(pane());await waitFor(()=>expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(4))
  const record=host.querySelector('[data-native-record-id="a"]')!
  expect([...record.querySelector('.log-turn__body')!.children].map(x=>x.classList.contains('log-turn__text')?'text':x.classList.contains('log-turn__resource')?'resource':x.getAttribute('data-trace-kind'))).toEqual(['reasoning','text','tool-call','reasoning','resource'])
  expect(record.textContent).toContain('A real answer appears once in the primary conversation.')
  expect(record.querySelector('.log-turn__trace-body')).toBeNull()
  const before=read.mock.calls.length;await open(detail('a'));expect(detail('a').querySelector('strong')?.textContent).toBe('First thought');expect(detail('a').querySelectorAll('li')).toHaveLength(1)
  await open(detail('a'),false);await open(detail('a'));expect(detail('a').open).toBe(true)
  expect(read.mock.calls.length).toBe(before);healthy()
 })
 it('keeps real empty/redacted summaries readable without signatures or concealed text',async()=>{
  const page=typedPage(control,[{id:'empty',kind:'activity',contentParts:[{kind:'reasoning',text:'',signature:'opaque-signature'}]},{id:'redacted',kind:'activity',contentParts:[{kind:'reasoning',text:'concealed-thought',redacted:true,signature:'opaque-signature'}]}])
  await render(<ConversationNativeThread page={page} sessionId={ID} />)
  expect(host.querySelectorAll('details')).toHaveLength(2)
  await open(detail('empty'));await open(detail('redacted'))
  expect(host.textContent).toContain('No reasoning text recorded.');expect(host.textContent).toContain('Reasoning content redacted.')
  expect(host.textContent).not.toContain('concealed-thought');expect(host.textContent).not.toContain('opaque-signature')
  expect(host.querySelector('[data-native-record-id="redacted"] [title="Copy message"]')).toBeNull()
 })
 it('preserves equal reasoning with distinct raw IDs and all repeated parts without body/time deduplication',async()=>{
  const part={kind:'reasoning' as const,text:'Identical observed thought.'};const page=typedPage(control,[{id:'one',kind:'activity',contentParts:[part,part]},{id:'two',kind:'activity',contentParts:[part]}])
  await render(<ConversationNativeThread page={page} sessionId={ID} />)
  const traces=[...host.querySelectorAll<HTMLDetailsElement>('details')];expect(traces).toHaveLength(3)
  expect(new Set(traces.map(x=>x.dataset.traceId)).size).toBe(3)
  await open(traces[1]!);expect(traces.map(x=>x.open)).toEqual([false,true,false])
 })
 it('renders a genuine reasoning-only latest window instead of an empty feed or fake working state',async()=>{
  const page=typedPage(control,[{id:'only',kind:'activity',contentParts:[{kind:'reasoning',text:'Only recorded thinking.'}]}])
  useAppStore.setState({timelines:{[ID]:{agentSessionId:ID,revision:1,items:[]}}});read.mockResolvedValue(page)
  await render(pane());await waitFor(()=>expect(host.querySelectorAll('[data-native-record-id="only"]')).toHaveLength(1))
  expect(host.querySelector('.activity-feed__empty')).toBeNull();expect(host.querySelector('.activity-working')).toBeNull()
 })
 it('keeps text-only answers visible and adds no section for an empty or foreign page',async()=>{
  const page=typedPage(control,[{id:'plain',kind:'assistant-message',contentParts:[{kind:'text',text:'Text-only native answer.'}]}])
  await render(<ActivityView sessionId={ID} items={timeline().items} nativeHistoryPage={page} capability="complete-events" displayState="done" />)
  expect(nativeRegion().textContent).toContain('Text-only native answer.');expect(host.querySelectorAll('.log-turn')).toHaveLength(2)
  await render(<ConversationNativeThread page={typedPage(control)} sessionId={ID} />);expect(host.textContent).toBe('')
  await render(<ConversationNativeThread page={typedPage({...control,agentSessionId:'other'},[{id:'foreign',kind:'activity',contentParts:[{kind:'reasoning',text:'Foreign thought'}]}])} sessionId={ID} />)
  expect(host.textContent).toBe('')
 })
 it('preserves expanded reasoning nodes, Range, scroll and draft under actual History cover and Return',async()=>{
  await render(pane());await waitFor(()=>expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(4));await open(detail('r'))
  const original=detail('r'),payload=original.querySelector('.log-turn__trace-body')!,selected=selectText(payload),feed=host.querySelector<HTMLElement>('.activity-feed')!
  feed.scrollTop=219;const before=read.mock.calls.length
  await click(button('History',host.querySelector('[data-leaf="header"]')!))
  await waitFor(()=>expect(host.querySelectorAll('.session-history [data-trace-kind="reasoning"]')).toHaveLength(3))
  expect(original.isConnected).toBe(true);expect(selected.selection.toString()).toBe('Exposed');expect(feed.scrollTop).toBe(219)
  await click(button('Activity'))
  expect(detail('r')).toBe(original);expect(detail('r').open).toBe(true);expect(detail('r').querySelector('.log-turn__trace-body')).toBe(payload)
  expect(selected.range.startContainer).toBe(selected.text);expect(selected.selection.toString()).toBe('Exposed');expect(feed.scrollTop).toBe(219)
  expect(read.mock.calls.length).toBe(before+2);healthy()
 })
 it('pauses at the same page reference while hidden and ignores late refresh until a visible observation',async()=>{
  await render(<>{pane()}<Witness /></>);await waitFor(()=>expect(observed.hook!.nativeHistoryPage?.items).toHaveLength(4));await open(detail('r'))
  const page=observed.hook!.nativeHistoryPage!,original=detail('r'),selected=selectText(original.querySelector('.log-turn__trace-body')!)
  let complete!:(value:AgentSessionHistoryPage)=>void;read.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve}))
  await act(async()=>{void observed.hook!.refresh()});const before=read.mock.calls.length
  await render(<>{pane(false)}<Witness enabled={false}/></>);expect(observed.hook!.nativeHistoryPage).toBe(page)
  await act(async()=>complete(typedPage(control,[{id:'late',kind:'activity',contentParts:[{kind:'reasoning',text:'Late unseen page'}]}])))
  expect(observed.hook!.nativeHistoryPage).toBe(page);expect(original.isConnected).toBe(true);expect(selected.selection.toString()).toBe('Exposed')
  expect(host.textContent).not.toContain('Late unseen page');expect(read.mock.calls.length).toBe(before)
  await render(<>{pane()}<Witness/></>);expect(detail('r')).toBe(original);expect(detail('r').open).toBe(true);healthy()
 })
 it('does not reuse a prior native page after changing run/control while the new read is pending',async()=>{
  await render(<Witness/>);await waitFor(()=>expect(observed.hook!.nativeHistoryPage?.items).toHaveLength(4))
  const next={...control,run:{runId:'new-private-run'}};let complete!:(value:AgentSessionHistoryPage)=>void
  read.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve}))
  await render(<Witness c={next}/>);expect(observed.hook!.nativeHistoryPage).toBeNull()
  await act(async()=>complete(typedPage(next,[{id:'next',kind:'activity',contentParts:[{kind:'reasoning',text:'Only next-run observed thought'}]}])))
  expect(observed.hook!.nativeHistoryPage?.items.map(x=>x.id)).toEqual(['next'])
 })
 it('retains same-record disclosure and exact selected node on explicit current-page refresh',async()=>{
  await render(<>{pane()}<Witness /></>);await waitFor(()=>expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(4));await open(detail('r'))
  const original=detail('r'),payload=original.querySelector('.log-turn__trace-body')!,selected=selectText(payload)
  await act(async()=>{await observed.hook!.refresh()})
  expect(detail('r')).toBe(original);expect(detail('r').querySelector('.log-turn__trace-body')).toBe(payload)
  expect(selected.range.startContainer).toBe(selected.text);expect(selected.selection.toString()).toBe('Exposed');healthy()
 })
 it('does no additional page read or reasoning remount on an unrelated Session output publication',async()=>{
  await render(pane());await waitFor(()=>expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(4));const original=detail('r'),before=read.mock.calls.length
  await act(async()=>useAppStore.setState({timelines:{...useAppStore.getState().timelines,other:timeline('other')}}))
  expect(detail('r')).toBe(original);expect(read.mock.calls.length).toBe(before)
 })
})
