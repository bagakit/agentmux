// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, it, expect, vi, type MockInstance } from 'vitest'
import type { AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot, AppConfig, AgentSessionControl } from '../src/shared/contracts'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import * as activityDiff from '../src/renderer/src/lib/activity-diff'
import { WorkflowCard } from '../src/renderer/src/components/workflow/WorkflowCard'
import { WorkflowToolRow } from '../src/renderer/src/components/workflow/WorkflowToolRow'
import { writeFile } from 'node:fs/promises'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-leaf="terminal" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({sessionId}: {sessionId:string}) => <div data-leaf="composer" data-session={sessionId} /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({onHistory}: {onHistory?:()=>void}) => <header data-leaf="header">{onHistory ? <button onClick={onHistory}>History</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionConnectingSurface', () => ({ SessionConnectingSurface: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

const ID='private-agent',DRAFT='Keep the original unsent draft.'
const start=new Date(2026,9,4,9,31,15).getTime(),at=(seconds:number)=>start+seconds*1000
const control:AgentSessionControl={kind:'agent',hostId:'local',agentSessionId:ID,run:{runId:'unchanged-private-run'}}
const config:AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Private host'}],executors:{claude:{label:'Claude',providerId:'claude',command:'claude',args:[],env:{},injectAgentMuxGuide:true}},workspaces:[{id:'ws',name:'Private project',hostId:'local',path:'/fixture',kind:'folder'}],appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
const session:Extract<SessionSnapshot,{kind:'agent'}>={id:ID,kind:'agent',hostId:'local',workspacePath:'/fixture',label:'Execution Agent',providerId:'claude',executorId:'claude',agentSessionUpdatedAt:1,promptSubmissionPredecessor:null,createdAt:1,updatedAt:1,processState:'running',status:{state:'done',source:'native-hook',observedAt:1},latestOutputBytes:0,capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control}
function step(id:string,overrides:Partial<AgentTimelineItem>={}):AgentTimelineItem{return {id,agentSessionId:ID,kind:'tool_call',source:'native-hook',status:'complete',createdAt:at(1),updatedAt:at(1),title:'Read',toolName:'Read',toolInput:'{"file":"/fixture/src/main.ts"}',...overrides}}
function prompt():AgentTimelineItem{const item=step('prompt',{kind:'user_message',source:'user',authorHuman:true,title:'User prompt',content:'Keep this actual prompt readable.',createdAt:start,updatedAt:start});delete item.toolName;delete item.toolInput;return item}
// Controlled legal FileStore records → actual public Client.sessionTimeline → actual renderer Store.
// PTY/composer/chrome are isolated leaves; no Provider execution or user Runtime is claimed.
let fixture:Awaited<ReturnType<typeof nativeHistoryFixture>>,host:HTMLDivElement,root:Root,writes:MockInstance[],diff:MockInstance<typeof activityDiff.toolCallToDiff>
const initial=useAppStore.getState()
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('IntersectionObserver',class{observe(){}disconnect(){}})
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 fixture=await nativeHistoryFixture('claude',jsonl([]))
 vi.spyOn(api.sessions,'historyPage').mockImplementation((c,o)=>fixture.client.sessionHistoryPage(c.agentSessionId,o))
 writes=['submitPrompt','write','resume','recover','stop'].map(name=>vi.spyOn(api.sessions,name as 'write'))
 diff=vi.spyOn(activityDiff,'toolCallToDiff')
 useAppStore.setState({config,sessions:[session],pendingAgentLaunches:{},recoveryCandidates:[],runtimeOwnershipWarnings:[],viewModes:{[ID]:'activity'},timelines:{},agentNames:{},agentComposerDrafts:{[ID]:DRAFT},agentSteerQueues:{}})
})
afterEach(async()=>{
 await act(async()=>root.unmount());host.remove()
 expect(fixture.controls.map(x=>x.mock.calls.length)).toEqual([0,0,0,0,0,0]);expect(writes.map(x=>x.mock.calls.length)).toEqual([0,0,0,0,0])
 expect(useAppStore.getState().sessions.map(x=>[x.id,x.control,x.processState])).toEqual([[ID,control,'running']]);expect(useAppStore.getState().agentComposerDrafts[ID]).toBe(DRAFT)
 await fixture.close();useAppStore.setState(initial,true);vi.restoreAllMocks()
})
async function record(items:AgentTimelineItem[]):Promise<AgentTimelineSnapshot>{expect(items.length).toBeGreaterThan(0);for(const item of items)await fixture.store.applyTimelineMutation({type:'upsert',agentSessionId:ID,item});const snapshot=await fixture.client.sessionTimeline(ID);expect(snapshot.items.map(x=>x.id)).toEqual(items.map(x=>x.id));return snapshot}
async function render(node:ReactNode){await act(async()=>root.render(node))}
function pane(){return <SessionPane sessionId={ID} surfaceKind="agent" interactiveResize={false} visible linkOrigin={{workspaceId:'ws',tabGroupId:'group',tabId:'tab',regionId:'region'}}/>}
async function mount(items:AgentTimelineItem[]){const snapshot=await record(items);useAppStore.setState({timelines:{[ID]:snapshot}});await render(pane())}
async function publish(items:AgentTimelineItem[]){const snapshot=await record(items);await act(async()=>useAppStore.setState({timelines:{[ID]:snapshot}}))}
function group(){const node=host.querySelector<HTMLButtonElement>('.wf-card--observation > .log-fold');expect(node).not.toBeNull();return node!}
function row(id:string){const node=host.querySelector<HTMLElement>(`[data-observation-step-id="${id}"]`);expect(node).not.toBeNull();return node!}
async function click(node:HTMLElement){await act(async()=>node.click())}
function select(el:Element){const text=el.firstChild!;const range=document.createRange();range.setStart(text,0);range.setEnd(text,4);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);expect(selection.toString()).toBe('Keep');return {text,range,selection}}
function equalSteps(){return [prompt(),step('one',{toolOutput:'Original result one.'}),step('two',{toolOutput:'Distinct result two.',createdAt:at(2),updatedAt:at(300)}),step('three',{status:'streaming',createdAt:at(3),updatedAt:at(4)})]}

describe('actual conversation Workflow observation components',()=>{
 it('uses public Timeline/FileStore→Store→SessionPane→Activity→actual Card and ToolRow over every raw member',async()=>{
  await mount(equalSteps())
  expect(host.querySelectorAll('.wf-card--observation')).toHaveLength(1);expect(group().textContent).toContain('3 steps')
  expect(group().querySelector('.log-fold__time')?.textContent).toBe('09:31:16–09:36:15');expect(group().getAttribute('aria-description')).toContain('from start')
  expect(group().textContent).toContain('Streaming');expect(host.querySelectorAll('[data-observation-step-id]')).toHaveLength(0)
  expect(host.querySelectorAll('.wf-phase,.wf-rail,[data-workflow-id]')).toHaveLength(0);expect(group().textContent).not.toMatch(/agents|tokens|%|unique/)
  const message=host.querySelector('.log-turn__body')!;expect(message.textContent).toBe('Keep this actual prompt readable.')
  await click(group());expect([...host.querySelectorAll('.wf-tool-row--observation')].map(x=>x.getAttribute('data-observation-step-id'))).toEqual(['one','two','three'])
  expect(row('three').dataset.status).toBe('streaming');expect(row('three').querySelector('.log-row__chip')?.textContent).toBe('Streaming')
  expect(host.querySelector('.log-turn__body')).toBe(message)
 })
 it('keeps equal text/input with distinct raw IDs and distinct original results independently readable',async()=>{
  await mount(equalSteps());await click(group());await click(row('one'));await click(row('two'))
  expect([...host.querySelectorAll('[data-observation-step-id]')].map(x=>x.getAttribute('data-observation-step-id'))).toEqual(['one','two','three'])
  expect([...host.querySelectorAll('.log-row__output')].map(x=>x.textContent)).toEqual(['Original result one.','Distinct result two.'])
  expect([...host.querySelectorAll('.log-row__payload')].map(x=>x.textContent)).toEqual(['{"file":"/fixture/src/main.ts"}','{"file":"/fixture/src/main.ts"}'])
 })
 it('keeps a long group bounded, failures visible and all original IDs reachable through one accurate disclosure without losing a read row',async()=>{
  const tools=Array.from({length:14},(_,index)=>step(`long-${index+1}`,{status:index===1?'failed':index===5?'streaming':'complete',createdAt:at(index+1),updatedAt:at(index+2),toolOutput:`Original output ${index+1}.`}))
  await mount([prompt(),...tools]);expect(group().querySelector('.log-fold__steps')?.textContent).toBe('14 steps');expect(group().querySelector('.log-fold__time')?.textContent).toBe('09:31:16–09:31:30')
  expect(host.querySelector('.wf-observation__summary')?.textContent).toContain('12 complete');expect(host.querySelector('.wf-observation__summary')?.textContent).toContain('1 failed')
  await click(group());expect([...host.querySelectorAll('[data-observation-step-id]')].map(x=>x.getAttribute('data-observation-step-id'))).toEqual(['long-2','long-6','long-9','long-10','long-11','long-12','long-13','long-14'])
  const more=host.querySelector<HTMLButtonElement>('.wf-observation__more')!;expect(more.textContent).toContain('Show 6 more recorded steps')
  const readerCalls=vi.mocked(api.sessions.historyPage).mock.calls.length,original=row('long-6');await click(original)
  const payload=original.nextElementSibling!,text=payload.firstChild!,range=document.createRange();range.setStart(text,0);range.setEnd(text,7);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);expect(selection.toString()).toBe('{"file"')
  await publish([prompt(),...tools.map(item=>item.id==='long-6'?{...item,status:'complete' as const}:item)])
  expect(row('long-6')).toBe(original);expect(original.nextElementSibling).toBe(payload);expect(selection.toString()).toBe('{"file"')
  await click(more);expect([...host.querySelectorAll('[data-observation-step-id]')].map(x=>x.getAttribute('data-observation-step-id'))).toEqual(tools.map(item=>item.id));expect(host.querySelector('.wf-observation__more')).toBeNull()
  expect(row('long-6')).toBe(original);expect(selection.toString()).toBe('{"file"');expect(vi.mocked(api.sessions.historyPage).mock.calls.length).toBe(readerCalls)
 })
 it('exposes exact declared tool categories and exports only actual public controlled records for the visual consumer',async()=>{
  const tools=Array.from({length:18},(_,index)=>{
    const name=index===15?'Edit':index===16?'Read':index===17?'Bash':index===3?'Search':'Bash'
    return step(`visual-${index+1}`,{toolName:name,title:name,status:index===3?'failed':index===17?'streaming':'complete',createdAt:at(index*5+1),updatedAt:at(index*5+3),toolInput:name==='Edit'?'{"file_path":"/fixture/src/main.ts","old_string":"old","new_string":"new"}':name==='Read'?'{"file":"/fixture/src/main.ts"}':name==='Search'?'{"query":"missing config"}':JSON.stringify({command:index===17?'pnpm test --filter observed-steps':`rg -n "record-${index+1}" src`}),...(index===17?{}:{toolOutput:index===3?'Search failed: declared directory does not exist.':`Actual captured output ${index+1}.\n${'result line\n'.repeat(32)}`})})
  })
  const snapshot=await record([prompt(),...tools]);useAppStore.setState({timelines:{[ID]:snapshot}});await render(pane());await click(group())
  expect(row('visual-16').querySelector('.lucide-pencil')).not.toBeNull();expect(row('visual-17').querySelector('.lucide-file-text')).not.toBeNull();expect(row('visual-18').querySelector('.lucide-terminal')).not.toBeNull();expect(row('visual-4').querySelector('.lucide-search')).not.toBeNull()
  const target=process.env.AGENTMUX_WORKFLOW_OBSERVATION_PUBLIC_SAMPLE;if(target)await writeFile(target,JSON.stringify({schema:'agentmux.controlled-public-timeline.v1',boundary:'Actual public Client / private FileStore legal controlled records; not vendor Writer or Runtime.',snapshot},null,2)+'\n')
 })
 it('reuses ToolRow for a single streaming step and keeps its original payload lazy',async()=>{
  await mount([prompt(),step('single',{status:'streaming',source:'acp'})]);expect(host.querySelectorAll('.wf-card--observation')).toHaveLength(0)
  expect(row('single').classList.contains('wf-tool-row--observation')).toBe(true);expect(row('single').dataset.status).toBe('streaming')
  expect(row('single').querySelector('.log-row__chip')?.textContent).toBe('Streaming');expect(host.querySelectorAll('.log-row__payload')).toHaveLength(0)
  await click(row('single'));expect(host.querySelector('.log-row__payload')?.textContent).toBe('{"file":"/fixture/src/main.ts"}')
 })
 it('keeps source updates, failure details and selected original message nodes without changing manual disclosure',async()=>{
  const items=[prompt(),step('updating',{status:'streaming',source:'acp'})];await mount(items)
  const message=host.querySelector('.log-turn__text p')!,selected=select(message),button=row('updating');await click(button)
  await publish([items[0]!,{...items[1]!,status:'failed',updatedAt:at(9),toolOutput:'Actual observed failure output.'}])
  expect(row('updating')).toBe(button);expect(row('updating').getAttribute('aria-expanded')).toBe('true');expect(row('updating').dataset.status).toBe('failed')
  expect(row('updating').querySelector('.log-row__chip--failed')?.textContent).toBe('Failed');expect(host.querySelector('.log-row__output')?.textContent).toBe('Actual observed failure output.')
  expect(host.querySelector('.log-turn__text p')).toBe(message);expect(selected.range.startContainer).toBe(selected.text);expect(selected.selection.toString()).toBe('Keep')
 })
 it('retains nested payload/selected nodes through group collapse and reopening without mounting before first read',async()=>{
  await mount(equalSteps());expect(host.querySelectorAll('[data-observation-step-id]')).toHaveLength(0);await click(group());await click(row('one'))
  const original=row('one'),payload=host.querySelector('.log-row__payload')!,message=host.querySelector('.log-turn__text p')!,selected=select(message)
  await click(group());const body=host.querySelector<HTMLElement>('.wf-observation__body')!;expect(body.hidden).toBe(true);expect(body.hasAttribute('inert')).toBe(true);expect(original.isConnected).toBe(true)
  await click(group());expect(row('one')).toBe(original);expect(host.querySelector('.log-row__payload')).toBe(payload);expect(row('one').getAttribute('aria-expanded')).toBe('true');expect(selected.selection.toString()).toBe('Keep')
 })
 it('does not parse or mount a Diff until the individual tool payload is opened',async()=>{
  await mount([prompt(),step('edit',{title:'Edit',toolName:'Edit',source:'acp',toolInput:'{"file_path":"/fixture/src/main.ts","old_string":"old","new_string":"new"}'})])
  expect(diff.mock.calls.length).toBe(0);expect(host.querySelectorAll('.log-diff')).toHaveLength(0);await click(row('edit'));expect(diff.mock.calls.length).toBe(1)
  expect([...host.querySelectorAll('.log-diff__line')].map(x=>x.textContent)).toEqual(['-old','+new'])
 })
 it('makes a no-payload failed record honest without an empty disclosure shell',async()=>{
  const item=step('no-payload',{source:'acp',status:'failed'});delete item.toolInput;await mount([prompt(),item])
  expect(row('no-payload').tagName).toBe('DIV');expect(row('no-payload').hasAttribute('aria-expanded')).toBe(false);expect(row('no-payload').querySelector('.log-row__chip--failed')?.textContent).toBe('Failed')
  expect(host.querySelectorAll('.log-row__payload,.log-row__output')).toHaveLength(0)
 })
 it('does no unrelated C output work and preserves the exact original group/step disclosure',async()=>{
  await mount(equalSteps());await click(group());await click(row('one'));const card=host.querySelector('.wf-card--observation'),original=row('one'),payload=host.querySelector('.log-row__payload')!,count=diff.mock.calls.length
  await act(async()=>useAppStore.setState({timelines:{...useAppStore.getState().timelines,other:{agentSessionId:'other',revision:1,items:[step('other',{agentSessionId:'other'})]}}}))
  expect(host.querySelector('.wf-card--observation')).toBe(card);expect(row('one')).toBe(original);expect(host.querySelector('.log-row__payload')).toBe(payload);expect(diff.mock.calls.length).toBe(count)
 })
 it('keeps unknown component status unknown and provides no empty group shell or invented statistics',async()=>{
  const recordedTime={from:'Unknown time',to:'Unknown time',offset:'Offset not recorded'}
  await render(<><WorkflowCard observation={{id:'empty',stepCount:0,recordedTime}} expanded={false} onExpandedChange={()=>{}}>{null}</WorkflowCard><WorkflowToolRow observation={{id:'unknown',title:'Unclassified observed record',recordedTime,source:'declared-observation',persistentSource:true}} className="log-row" icon={null}/></>)
  expect(host.querySelectorAll('.wf-card')).toHaveLength(0);expect(row('unknown').dataset.status).toBeUndefined();expect(row('unknown').textContent).toContain('Status not recorded');expect(row('unknown').querySelector('.wf-ico--completed')).toBeNull()
 })
})
