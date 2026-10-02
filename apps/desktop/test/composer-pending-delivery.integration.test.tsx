// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
const dom = composerDOM()
const queued = (operationId: string, runId = 'run-agent-1') => ({operationId, runId, text:'Original '+operationId, status:'queued' as const})
const strip = () => dom.container.querySelector<HTMLElement>('.composer-pending')
const editor = () => dom.container.querySelector('[role="textbox"]')!
async function mount(visible = true) { await dom.render(<AgentSessionComposer sessionId="agent-1" visible={visible} />) }
beforeEach(() => {
  vi.spyOn(api.continuousProgress,'list').mockResolvedValue([])
  useAppStore.setState({agentSteerInFlight:{},agentSteerInFlightPhase:{},timelines:{},noticeReadReceipts:{}})
  Object.defineProperty(HTMLElement.prototype,'showPopover',{configurable:true,value(){ const event=new Event('toggle');Object.defineProperty(event,'newState',{value:'open'});this.dispatchEvent(event) }})
  Object.defineProperty(HTMLElement.prototype,'hidePopover',{configurable:true,value(){ const event=new Event('toggle');Object.defineProperty(event,'newState',{value:'closed'});this.dispatchEvent(event) }})
})
it('retained pending appears outside the original input; empty, confirmed and hidden queues have no slot',async()=>{
  await mount();const original=editor();expect(strip()).toBeNull()
  await act(async()=>useAppStore.setState({agentSteerQueues:{'agent-1':[queued('a')]}}))
  expect(strip()).not.toBeNull();expect(strip()!.closest('.composer')).toBeNull();expect(strip()!.textContent).toContain('排队中');expect(editor()).toBe(original);expect(dom.draft()).toBe('Keep my draft')
  await mount(false);expect(strip()).toBeNull();await mount();expect(strip()).not.toBeNull()
  await act(async()=>useAppStore.setState({timelines:{'agent-1':{agentSessionId:'agent-1',revision:1,items:[{id:'prompt:a',agentSessionId:'agent-1',kind:'user_message',status:'complete',source:'user',content:'Original a',createdAt:1,updatedAt:1}]}}}))
  expect(strip()).toBeNull();expect(editor()).toBe(original)
})
it('direct icon sends the same first actually deliverable operation, never an older Run or the current draft',async()=>{
  const send=vi.spyOn(useAppStore.getState(),'sendQueuedAgentSteer').mockResolvedValue()
  useAppStore.setState({agentSteerQueues:{'agent-1':[queued('old','old-run'),queued('next'),queued('tail')]}})
  await mount();expect(strip()!.dataset.operationId).toBe('next');expect(strip()!.textContent).toContain('Original next');await dom.click('[aria-label="发送这条待发消息"]')
  expect(send).toHaveBeenCalledTimes(1);expect(send).toHaveBeenLastCalledWith('agent-1','next');expect(dom.draft()).toBe('Keep my draft')
})
it('actual later in-flight entry wins the summary, and preparation is not sending; original Outbox actions keep its lock',async()=>{
  useAppStore.setState({agentSteerQueues:{'agent-1':[queued('head'),queued('explicit')]},agentSteerInFlight:{'agent-1':'explicit'},agentSteerInFlightPhase:{'agent-1':'preparing'}})
  await mount();expect(strip()!.dataset.operationId).toBe('explicit');expect(strip()!.textContent).toContain('准备发送');expect(strip()!.textContent).not.toContain('发送中');expect(strip()!.querySelector<HTMLButtonElement>('.composer-pending__send')!.disabled).toBe(true)
  await dom.click('[aria-label="在 Outbox 查看待发消息和操作"]');const panel=dom.container.querySelector('.composer-mailbox')!
  expect(panel.querySelector('[id$="-outbox-tab"]')!.getAttribute('aria-selected')).toBe('true')
  await dom.click('[data-record-key="queue:explicit"].composer-mailbox__row')
  for(const label of ['Move up','Move down','Remove'])expect(panel.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.disabled).toBe(true)
  expect(panel.textContent).toContain('尚未提交');expect(editor().textContent).toBe('Keep my draft')
  await act(async()=>useAppStore.setState({agentSteerInFlightPhase:{'agent-1':'submitting'}}));expect(strip()!.textContent).toContain('发送中');expect(panel.textContent).toContain('等待投递确认')
})
it('pending interaction and changed Run explain waiting while the existing Outbox keeps full text and actions',async()=>{
  useAppStore.setState({sessions:[{...composerSession(),pendingInteraction:{id:'request',kind:'permission',title:'Permission',body:'Confirm',options:[]} as never}],agentSteerQueues:{'agent-1':[queued('a')]}})
  await mount();expect(strip()!.textContent).toContain('等待回答');expect(strip()!.querySelector<HTMLButtonElement>('.composer-pending__send')!.disabled).toBe(true)
  await act(async()=>useAppStore.setState({sessions:[composerSession()],agentSteerQueues:{'agent-1':[queued('old','old-run')]}}))
  expect(strip()!.textContent).toContain('原 Run 不可投递');expect(strip()!.querySelector<HTMLButtonElement>('.composer-pending__send')!.disabled).toBe(true)
})
it('unknown delivery is retained and never gets a fabricated successful state',async()=>{
  useAppStore.setState({agentSteerQueues:{'agent-1':[{...queued('unknown'),status:'deferred',promptCondition:{kind:'test'} as never,error:'Original outcome unknown'}]}})
  await mount();expect(strip()!.textContent).toContain('投递未确认');await dom.click('[aria-label="在 Outbox 查看待发消息和操作"]');await dom.click('[data-record-key="queue:unknown"].composer-mailbox__row')
  expect(dom.container.textContent).toContain('尚未发送，暂无对话位置');expect(dom.container.textContent).toContain('Original unknown')
})
it('a confirmed captured record explains submission separately from CLI acceptance or reply',async()=>{
  useAppStore.setState({timelines:{'agent-1':{agentSessionId:'agent-1',revision:1,items:[{id:'sent',agentSessionId:'agent-1',kind:'user_message',status:'complete',source:'user',content:'Recorded original',createdAt:1,updatedAt:1}]}}})
  await mount();const panel=dom.container.querySelector('.composer-mailbox')!;await act(async()=>{const e=new Event('toggle');Object.defineProperty(e,'newState',{value:'open'});panel.dispatchEvent(e)})
  await dom.click('[data-record-key="timeline:sent"].composer-mailbox__row');await dom.click('[aria-label="Message details"]')
  expect(panel.textContent).toContain('Submission confirmed · CLI acceptance and reply are separate')
})
it('read-only and changed Session surfaces retain their own queue and draft without borrowing an active operation',async()=>{
  useAppStore.setState({sessions:[composerSession(),composerSession('agent-2')],agentComposerDrafts:{'agent-1':'Keep my draft','agent-2':'Other draft'},agentSteerQueues:{'agent-1':[queued('first')],'agent-2':[queued('second','run-agent-2')]},agentSteerInFlight:{'agent-2':'second'},agentSteerInFlightPhase:{'agent-2':'preparing'}})
  await dom.render(<AgentSessionComposer sessionId="agent-1" readOnly />)
  expect(strip()!.dataset.operationId).toBe('first');expect(strip()!.textContent).toContain('排队中');expect(strip()!.querySelector<HTMLButtonElement>('.composer-pending__send')!.disabled).toBe(true)
  expect(strip()!.querySelector<HTMLButtonElement>('.composer-pending__send')!.title).toContain('只读');expect(dom.draft()).toBe('Keep my draft')
  await dom.render(<AgentSessionComposer sessionId="agent-2" />)
  expect(strip()!.dataset.operationId).toBe('second');expect(strip()!.textContent).toContain('准备发送');expect(editor().textContent).toBe('Other draft');expect(dom.draft()).toBe('Keep my draft')
})

it.each([['AGENT_EXECUTION_NOT_REQUESTED','待手动发送'],['AGENT_TURN_END_UNCONFIRMED','等待当轮确认'],['AGENT_PROMPT_SUBMISSION_BUSY','等待前条提交']])('the original deferred reason %s explains the wait without disabling healthy draft input',async(code,label)=>{
  useAppStore.setState({agentSteerQueues:{'agent-1':[{...queued('wait'),status:'deferred',promptCondition:null,errorCode:code,error:'Original recorded reason'}]}})
  await mount();expect(strip()!.textContent).toContain(label);expect(editor().getAttribute('contenteditable')).toBe('true');expect(dom.draft()).toBe('Keep my draft')
})
