// @vitest-environment happy-dom
import { writeFileSync } from 'node:fs'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot, AgentTimelineItem } from '@agentmux/core'
import type { SessionSnapshot, AppConfig, AgentSessionControl } from '../src/shared/contracts'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../src/renderer/src/components/ActivityView'

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
const hookStep=(id:string,time:number):AgentTimelineItem=>({id,agentSessionId:ID,kind:'tool_call',source:'native-hook',status:'complete',createdAt:time,updatedAt:time,title:'Read '+id,toolName:'Read',toolInput:id})
const initial=useAppStore.getState();let host:HTMLDivElement;let root:Root;let fixture:Awaited<ReturnType<typeof nativeHistoryFixture>>;let read:MockInstance<typeof api.sessions.historyPage>;let writes:MockInstance[]=[]
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('IntersectionObserver',class{observe(){}disconnect(){}})
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
function recordOrder(){const nodes=[...host.querySelectorAll('[data-native-record-id], .activity-log__segment .log-turn[data-message-id]')];expect(nodes.length).toBeGreaterThan(0);return nodes.map(el=>el.getAttribute('data-native-record-id')??el.getAttribute('data-message-id')!.split(':').at(-1))}
const orderRecords=['u-before','a-before','u-after','a-after']
function orderedData(provider:'claude'|'pi',fixtureRoot:string){
 const values=[['u-before','user','Repeated native input.',5000],['a-before','assistant',[{type:'thinking',thinking:'First recorded thinking.'},{type:'text',text:'### First recorded answer.\n\n[Review the source](https://example.test/context)'}],4000],['u-after','user','Repeated native input.',undefined],['a-after','assistant',[{type:'thinking',thinking:'Second recorded thinking.'},{type:provider==='claude'?'tool_use':'toolCall',id:'call-2',name:'Read',input:{file:'src/second.ts'},arguments:{file:'src/second.ts'}},{type:'text',text:'Second recorded answer.'}],1000]] as const
 return jsonl(provider==='claude'?values.map(([uuid,type,content,time])=>({sessionId:'native-main',uuid,type,message:{role:type,content},...(time===undefined?{}:{timestamp:new Date(time).toISOString()})})):[{type:'session',version:3,id:'native-main',cwd:fixtureRoot},...values.map(([id,role,content,time],index)=>({type:'message',id,parentId:index===0?null:values[index-1]![0],message:{role,content},...(time===undefined?{}:{timestamp:new Date(time).toISOString()})}))])
}
function healthy(){expect(useAppStore.getState().sessions.map(s=>[s.id,s.control,s.processState])).toEqual([[ID,control,'running']]);expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT)}
describe('native record order through actual public readers and SessionPane',()=>{
 for(const provider of ['claude','pi'] as const)it(provider+' retains native user/assistant record order despite reversed or missing timestamps and equal bodies',async()=>{
  await fixture.close();fixture=await nativeHistoryFixture(provider,(fixtureRoot)=>orderedData(provider,fixtureRoot));useAppStore.setState({timelines:{[ID]:{agentSessionId:ID,revision:1,items:[]}}})
  await render(<>{pane()}<Witness/></>);await waitFor(()=>expect(observed.hook!.nativeHistoryPage!.items).toHaveLength(4))
  expect(observed.hook!.nativeHistoryPage!.items.map(x=>x.id)).toEqual(orderRecords)
  if(provider==='claude'&&process.env.AGENTMUX_NATIVE_ORDER_PAGE)writeFileSync(process.env.AGENTMUX_NATIVE_ORDER_PAGE,JSON.stringify(observed.hook!.nativeHistoryPage,null,2)+'\n')
  expect(observed.hook!.messages.map(x=>x.rawId)).toEqual(['u-before','u-after'])
  expect(recordOrder()).toEqual(orderRecords)
  expect(host.querySelector('[role="slider"]')).toBeNull()
  expect(host.textContent).toContain('First recorded answer.');expect(host.textContent).toContain('Second recorded answer.')
  expect(host.querySelectorAll('[data-native-record-id="a-after"] [data-trace-kind]')).toHaveLength(2)
  expect(read.mock.calls.map(([c,o])=>[c,o])).toEqual([[control,{limit:30}]])
  healthy()
 })
 it('keeps timestamped captured input between two Workflow groups, including failed and unverified receipts separately from native input',async()=>{
  const captured:AgentTimelineItem={id:'steer',agentSessionId:ID,kind:'user_message',source:'user',status:'complete',createdAt:3,updatedAt:3,title:'Prompt',content:'A legitimate native prompt.',authorAgentSessionId:'trusted-peer'}
  const failed:AgentTimelineItem={...captured,id:'failed',status:'failed',createdAt:6,updatedAt:6,content:'Failed submitted prompt.'}
  const pending:AgentTimelineItem={...captured,id:'pending',status:'streaming',createdAt:7,updatedAt:7,content:'Unverified submitted prompt.'}
  const {authorAgentSessionId: _peer,...systemBase}=captured
  const system:AgentTimelineItem={...systemBase,id:'system',createdAt:8,updatedAt:8,kind:'system_message',source:'agentmux',content:'Recorded runtime context.'}
  const items=[hookStep('one',1),hookStep('two',2),captured,hookStep('three',4),hookStep('four',5),failed,pending,system]
  useAppStore.setState({timelines:{[ID]:{agentSessionId:ID,revision:1,items}}})
  await render(<>{pane()}<Witness/></>);await waitFor(()=>expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(4))
  const observations=host.querySelector('.activity-log')!;const segments=[...observations.querySelectorAll('.activity-log__segment')]
  expect(segments).toHaveLength(6);expect(segments[0]!.textContent).toContain('2 steps');expect(segments[2]!.textContent).toContain('2 steps')
  expect(segments[1]!.querySelector('.log-turn')?.getAttribute('data-speaker-relation')).toBe('other-agent')
  expect(segments[3]!.querySelector('.log-turn')?.getAttribute('data-status')).toBe('failed')
  expect(segments[4]!.querySelector('.log-turn')?.getAttribute('data-status')).toBe('unverified')
  expect(segments[5]!.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('system')
  expect(host.querySelectorAll('.wf-card--observation')).toHaveLength(2)
  expect(host.querySelector('[role="slider"]')?.getAttribute('aria-label')).toContain('8 events')
  expect(host.querySelectorAll('[data-native-record-id="u"]')).toHaveLength(1)
  expect(observations.querySelector('[data-message-id="captured:steer"]')!.textContent).toContain('A legitimate native prompt.')
  expect(host.querySelector('.activity-feed__observation-source')?.textContent).toContain('Separate recorded source')
  expect(read.mock.calls).toHaveLength(1);healthy()
 })
 it('mounts source/rawID once and keeps every mixed reasoning/text/tool/resource part in source order',async()=>{
  const parts:AgentSessionHistoryPage['items'][number]['contentParts']=[{kind:'reasoning',text:'Repeated thinking.'},{kind:'text',text:'Visible answer.'},{kind:'tool-call',name:'Read',input:'src/file.ts',callId:'native-call'},{kind:'reasoning',text:'Repeated thinking.'},{kind:'resource',resourceType:'file',reference:'src/file.ts'}]
  const one={id:'same-raw',kind:'assistant-message' as const,contentParts:parts};const two={...one,id:'distinct-raw'}
  const page=typedPage(control,[{id:'u1',kind:'user-message',contentParts:[{kind:'text',text:'[Message from Agent declared-peer]\nPeer-declared input.'}]},one,one,{id:'u2',kind:'user-message',contentParts:[{kind:'text',text:'Repeated native input.'}]},two])
  await render(<ActivityView sessionId={ID} items={[]} nativeHistoryPage={page} userMessages={projectSessionUserMessages({agentSessionId:ID,historyPage:page})} capability="complete-events" />)
  expect([...host.querySelectorAll('[data-native-record-id]')].map(el=>el.getAttribute('data-native-record-id'))).toEqual(['u1','same-raw','u2','distinct-raw'])
  const records=[...host.querySelectorAll('[data-native-record-id="same-raw"], [data-native-record-id="distinct-raw"]')]
  expect(records).toHaveLength(2)
  for(const record of records)expect([...record.querySelector('.log-turn__body')!.children].map(el=>el.classList.contains('log-turn__text')?'text':el.classList.contains('log-turn__resource')?'resource':el.getAttribute('data-trace-kind'))).toEqual(['reasoning','text','tool-call','reasoning','resource'])
  expect(host.querySelectorAll('[data-trace-kind="reasoning"]')).toHaveLength(4)
  expect(host.querySelectorAll('.log-turn__trace-body')).toHaveLength(0)
  expect(host.querySelector('[data-native-record-id="u1"] .log-turn')?.getAttribute('data-declared-source')).toBe('Agent declared-peer')
  expect(host.querySelector('[data-native-record-id="u1"] .log-turn')?.getAttribute('data-speaker-relation')).toBeNull()
  expect(read.mock.calls).toHaveLength(0);healthy()
 })
 it('retains native record nodes, expanded prose, Range, scroll and draft across cover/Return and exact-page refresh',async()=>{
  await render(<>{pane()}<Witness/></>);await waitFor(()=>expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(4))
  const detail=host.querySelector<HTMLDetailsElement>('[data-native-record-id="r"] details')!
  await act(async()=>{detail.open=true;detail.dispatchEvent(new Event('toggle'))})
  const text=detail.querySelector('p')!.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,7)
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);expect(selection.toString()).toBe('Exposed')
  const feed=host.querySelector<HTMLElement>('.activity-feed')!;feed.scrollTop=217
  const button=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label)!
  await act(async()=>button('History').click());await waitFor(()=>expect(host.querySelector('.session-history')).not.toBeNull())
  expect(detail.isConnected).toBe(true);expect(selection.toString()).toBe('Exposed')
  await act(async()=>button('Activity').click());await act(async()=>{await observed.hook!.refresh()})
  expect(host.querySelector('[data-native-record-id="r"] details')).toBe(detail);expect(detail.open).toBe(true)
  expect(range.startContainer).toBe(text);expect(selection.toString()).toBe('Exposed');expect(feed.scrollTop).toBe(217);healthy()
 })

 it('keeps already observed native inputs visible when their optional full-page prop has not arrived',async()=>{
  const page=typedPage(control,[{id:'one',kind:'user-message',contentParts:[{kind:'text',text:'Same input.'}]},{id:'two',kind:'user-message',contentParts:[{kind:'text',text:'Same input.'}]}])
  const messages=projectSessionUserMessages({agentSessionId:ID,historyPage:page})
  await render(<ActivityView sessionId={ID} items={[]} userMessages={messages} capability="complete-events" />)
  expect([...host.querySelectorAll('.log-turn__body')].map(el=>el.textContent)).toEqual(['Same input.','Same input.'])
  await render(<ActivityView sessionId={ID} items={[]} userMessages={messages} nativeHistoryPage={page} capability="complete-events" />)
  expect([...host.querySelectorAll('[data-native-record-id]')].map(el=>el.getAttribute('data-native-record-id'))).toEqual(['one','two'])
  expect(host.querySelectorAll('.log-turn__body')).toHaveLength(2)
  expect(host.querySelectorAll('.activity-log .log-turn')).toHaveLength(0)
  expect(read.mock.calls).toHaveLength(0);healthy()
 })

 it('keeps native Continue on the exact source prefix including earlier assistant/tool/resource while excluding future input and redacted text',async()=>{
  const page=typedPage(control,[{id:'before',kind:'assistant-message',contentParts:[{kind:'text',text:'Earlier answer.'},{kind:'tool-call',name:'Read',input:'src/earlier.ts'},{kind:'tool-result',name:'Read',output:'Earlier tool result.'},{kind:'resource',resourceType:'file',label:'File',reference:'src/earlier.ts'},{kind:'reasoning',text:'Concealed reasoning.',redacted:true,signature:'opaque'}]},{id:'selected',kind:'user-message',contentParts:[{kind:'text',text:'Selected input.'}]},{id:'later',kind:'user-message',contentParts:[{kind:'text',text:'Future input.'}]}])
  const onContinue=vi.fn()
  await render(<ActivityView sessionId={ID} items={[]} nativeHistoryPage={page} userMessages={projectSessionUserMessages({agentSessionId:ID,historyPage:page})} capability="complete-events" onContinue={onContinue} />)
  const button=[...host.querySelectorAll<HTMLButtonElement>('[data-native-record-id="selected"] button')].find(el=>el.textContent==='Continue from here');expect(button).toBeDefined()
  await act(async()=>button!.click())
  expect(onContinue.mock.calls).toEqual([['Continue this conversation from the selected point.\n\nAgent: Earlier answer.\nRead\nsrc/earlier.ts\nRead\nEarlier tool result.\nFile\nsrc/earlier.ts\n[Reasoning redacted]\n\nInput: Selected input.']])
  expect(read.mock.calls).toHaveLength(0);healthy()
 })

})
