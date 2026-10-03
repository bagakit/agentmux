// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
const dom = composerDOM()
const queued = (operationId: string, runId = 'run-agent-1') => ({operationId, runId, text:'Original '+operationId, status:'queued' as const})
const strip = () => document.querySelector<HTMLElement>('.composer-pending:not([hidden])')
const selectedCard = () => [...strip()!.querySelectorAll<HTMLElement>('.composer-pending__card')].find(card => card.dataset.operationId === strip()!.dataset.operationId)!
async function pendingClick(selector: string) {
  const owner = selector === '[aria-label="在 Outbox 查看待发消息和操作"]' ? strip()!.querySelector('.composer-pending__heading')! : selectedCard()
  await act(async () => owner.querySelector<HTMLButtonElement>(selector)!.click())
}
const editor = () => dom.container.querySelector('[role="textbox"]')!
async function mount(visible = true) { await dom.render(<AgentSessionComposer sessionId="agent-1" visible={visible} />) }
beforeEach(() => {
  vi.spyOn(api.continuousProgress,'list').mockResolvedValue([])
  useAppStore.setState({agentSteerInFlight:{},agentSteerInFlightPhase:{},timelines:{},noticeReadReceipts:{}})
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value(){}})
  const originalClick = HTMLButtonElement.prototype.click
  vi.spyOn(HTMLButtonElement.prototype, 'click').mockImplementation(function (this: HTMLButtonElement) {
    originalClick.call(this)
    if (this.getAttribute('popovertargetaction') === 'hide') (document.getElementById(this.getAttribute('popovertarget') ?? '') as HTMLElement | null)?.hidePopover()
  })
  const nativeOpen = new WeakSet<HTMLElement>(), originalMatches = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) { return selector === ':popover-open' ? nativeOpen.has(this) : originalMatches.call(this, selector) })
  Object.defineProperty(HTMLElement.prototype,'showPopover',{configurable:true,value(){ nativeOpen.add(this);const event=new Event('toggle');Object.defineProperty(event,'newState',{value:'open'});this.dispatchEvent(event) }})
  Object.defineProperty(HTMLElement.prototype,'hidePopover',{configurable:true,value(){ nativeOpen.delete(this);const event=new Event('toggle');Object.defineProperty(event,'newState',{value:'closed'});this.dispatchEvent(event) }})
})
it('retained pending appears outside the original input; empty, confirmed and hidden queues have no slot',async()=>{
  await mount();const original=editor();expect(strip()).toBeNull()
  await act(async()=>useAppStore.setState({agentSteerQueues:{'agent-1':[queued('a')]}}))
  expect(strip()).not.toBeNull();expect(strip()!.closest('.composer')).toBeNull();expect(strip()!.textContent).toContain('排队中');expect(editor()).toBe(original);expect(dom.draft()).toBe('Keep my draft')
  await mount(false);expect(strip()).toBeNull();await mount();expect(strip()).not.toBeNull()
  await act(async()=>useAppStore.setState({timelines:{'agent-1':{agentSessionId:'agent-1',revision:1,items:[{id:'prompt:a',agentSessionId:'agent-1',kind:'user_message',status:'complete',source:'user',title:'Recorded input',content:'Original a',createdAt:1,updatedAt:1}]}}}))
  expect(strip()).toBeNull();expect(editor()).toBe(original)
})
it('direct icon sends the same first actually deliverable operation, never an older Run or the current draft',async()=>{
  const send=vi.spyOn(useAppStore.getState(),'sendQueuedAgentSteer').mockResolvedValue('submitted')
  useAppStore.setState({agentSteerQueues:{'agent-1':[queued('old','old-run'),queued('next'),queued('tail')]}})
  await mount();expect(strip()!.dataset.operationId).toBe('next');expect(strip()!.textContent).toContain('Original next');await pendingClick('[aria-label="发送这条待发消息"]')
  expect(send).toHaveBeenCalledTimes(1);expect(send).toHaveBeenLastCalledWith('agent-1','next');expect(dom.draft()).toBe('Keep my draft')
})
it('actual later in-flight entry wins the summary, and preparation is not sending; original Outbox actions keep its lock',async()=>{
  useAppStore.setState({agentSteerQueues:{'agent-1':[queued('head'),queued('explicit')]},agentSteerInFlight:{'agent-1':'explicit'},agentSteerInFlightPhase:{'agent-1':'preparing'}})
  await mount();expect(strip()!.dataset.operationId).toBe('explicit');expect(strip()!.textContent).toContain('准备发送');expect(strip()!.textContent).not.toContain('发送中');expect(strip()!.querySelector<HTMLButtonElement>('.composer-pending__send')!.disabled).toBe(true)
  await pendingClick('[aria-label="在 Outbox 查看待发消息和操作"]');const panel=dom.container.querySelector('.composer-mailbox')!
  expect(panel.querySelector('[id$="-outbox-tab"]')!.getAttribute('aria-selected')).toBe('true')
  expect(panel.querySelector('[data-record-key="queue:explicit"]')).not.toBeNull()
  for(const label of ['Move up','Move down','Remove'])expect(panel.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.disabled).toBe(true)
  expect(panel.textContent).toContain('正在准备本次发送');expect(editor().textContent).toBe('Keep my draft')
  await act(async()=>useAppStore.setState({agentSteerInFlightPhase:{'agent-1':'submitting'}}));expect(strip()).toBeNull();expect(panel.textContent).toContain('等待投递确认');await dom.click('[aria-label="Close mailbox"]');expect(strip()!.textContent).toContain('发送中')
})
it('pending interaction and changed Run explain waiting while the existing Outbox keeps full text and actions',async()=>{
  useAppStore.setState({sessions:[{...composerSession(),pendingInteraction:{id:'request',kind:'permission',title:'Permission',body:'Confirm',options:[]} as never}],agentSteerQueues:{'agent-1':[queued('a')]}})
  await mount();expect(strip()!.textContent).toContain('等待回答');expect(strip()!.querySelector<HTMLButtonElement>('.composer-pending__send')!.disabled).toBe(true)
  await act(async()=>useAppStore.setState({sessions:[composerSession()],agentSteerQueues:{'agent-1':[queued('old','old-run')]}}))
  expect(strip()!.textContent).toContain('原 Run 不可投递');expect(strip()!.querySelector<HTMLButtonElement>('.composer-pending__send')!.disabled).toBe(true)
})
it('unknown delivery is retained and never gets a fabricated successful state',async()=>{
  useAppStore.setState({agentSteerQueues:{'agent-1':[{...queued('unknown'),status:'deferred',promptCondition:{kind:'test'} as never,error:'Original outcome unknown'}]}})
  await mount();expect(strip()!.textContent).toContain('发送结果待核实');await pendingClick('[aria-label="在 Outbox 查看待发消息和操作"]')
  expect(dom.container.textContent).toContain('发送结果待核实，对话位置暂不可用');expect(dom.container.textContent).not.toContain('尚未发送，暂无对话位置');expect(dom.container.textContent).toContain('Original unknown')
})
it('a confirmed captured record explains submission separately from CLI acceptance or reply',async()=>{
  useAppStore.setState({timelines:{'agent-1':{agentSessionId:'agent-1',revision:1,items:[{id:'sent',agentSessionId:'agent-1',kind:'user_message',status:'complete',source:'user',title:'Recorded input',content:'Recorded original',createdAt:1,updatedAt:1}]}}})
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

it.each([[undefined,'待手动发送'],['AGENT_TURN_END_UNCONFIRMED','等待当轮确认'],['AGENT_PROMPT_SUBMISSION_BUSY','等待前条提交']])('the original deferred reason %s explains the wait without disabling healthy draft input',async(code,label)=>{
  useAppStore.setState({agentSteerQueues:{'agent-1':[{...queued('wait'),status:'deferred',promptCondition:null,...(code ? {errorCode:code} : {awaitingExplicitSend:true as const}),error:'Original recorded reason'}]}})
  await mount();expect(strip()!.textContent).toContain(label);expect(editor().getAttribute('contenteditable')).toBe('true');expect(dom.draft()).toBe('Keep my draft')
})

it('historical missing condition remains unknown and cannot be mistaken for an unsent editable draft', async () => {
  useAppStore.setState({agentSteerQueues:{'agent-1':[{...queued('history'),status:'deferred',error:'Original history has no receipt'}]}})
  await mount()
  expect(strip()!.textContent).toContain('发送结果待核实')
  expect(strip()!.querySelector<HTMLButtonElement>('[aria-label="编辑这条待发消息"]')!.disabled).toBe(true)
  await pendingClick('[aria-label="在 Outbox 查看待发消息和操作"]')
  expect(dom.container.textContent).toContain('发送结果待核实，对话位置暂不可用')
  expect(dom.container.textContent).not.toContain('尚未发送，暂无对话位置')
})

it('the per-call preparation explanation retains overall unknown and the separate restart pause', async () => {
  const condition = { expectedRun: { runId:'run-agent-1' }, afterSubmissionId:null }
  const original = {...queued('prepare-failure'),status:'deferred' as const,promptCondition:condition,
    errorCode:'AGENT_PROMPT_PREPARATION_FAILED',error:'Read-only native qualification timed out',awaitingExplicitSend:true as const}
  useAppStore.setState({agentSteerQueues:{'agent-1':[original]}})
  await mount()
  expect(strip()!.textContent).toContain('本次准备未完成')
  await act(async()=>strip()!.querySelector<HTMLElement>('.composer-pending__card')!.dispatchEvent(new PointerEvent('pointermove',{bubbles:true})))
  expect(strip()!.textContent).toContain(original.error)
  expect(strip()!.textContent).toContain('此前是否已提交仍待核实')
  expect(strip()!.textContent).toContain('重启后等待你明确发送')
  expect(strip()!.querySelector<HTMLButtonElement>('[aria-label="编辑这条待发消息"]')!.disabled).toBe(true)
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([original])
  expect(editor().getAttribute('contenteditable')).toBe('true')
})

it('100 distinct cards are discoverable and middle/tail hover, copy, send and More retain their original identity', async () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({ ...queued('message-' + index), text: 'Unique body ' + index + '\nFull original line ' + index }))
  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue('submitted')
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  useAppStore.setState({ agentSteerQueues: { 'agent-1': entries } })
  await mount()
  const originalEditor = editor(), cards = [...strip()!.querySelectorAll<HTMLElement>('.composer-pending__card')]
  expect(cards).toHaveLength(100)
  expect(new Set(cards.map(card => card.dataset.operationId)).size).toBe(100)
  for (const index of [0, 49, 99]) {
    await act(async () => cards[index]!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })))
    expect(strip()!.dataset.operationId).toBe(entries[index]!.operationId)
    expect(strip()!.querySelector('.composer-pending__body')!.textContent).toBe(entries[index]!.text)
    await pendingClick('[aria-label="复制这条待发消息"]')
    expect(clipboard).toHaveBeenLastCalledWith(entries[index]!.text)
  }
  expect(send).not.toHaveBeenCalled()
  expect(editor()).toBe(originalEditor); expect(dom.draft()).toBe('Keep my draft')
  await pendingClick('[aria-label="发送这条待发消息"]')
  expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenLastCalledWith('agent-1', 'message-99')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual(entries)
  await pendingClick('[aria-label="在 Outbox 查看待发消息和操作"]')
  expect(dom.container.querySelector('[data-record-key="queue:message-99"]')).not.toBeNull()
  expect(dom.draft()).toBe('Keep my draft')
})

it('keyboard reaches a long queue tail without submitting, and dismissed cards remain discoverable', async () => {
  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue('submitted')
  useAppStore.setState({ agentSteerQueues: { 'agent-1': Array.from({ length: 25 }, (_, index) => queued('key-' + index)) } })
  await mount()
  await act(async () => { selectedCard().focus(); selectedCard().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
  expect(strip()!.dataset.operationId).toBe('key-24')
  expect(document.activeElement).toBe(selectedCard()); expect(send).not.toHaveBeenCalled()
  await act(async () => strip()!.querySelector<HTMLButtonElement>('[aria-label="收起待发卡片"]')!.click())
  expect(strip()!.querySelector('.composer-pending__cards')).toBeNull()
  expect(strip()!.textContent).toContain('待发 25')
  await act(async () => strip()!.querySelector<HTMLButtonElement>('.composer-pending__restore')!.click())
  expect(strip()!.querySelectorAll('.composer-pending__card')).toHaveLength(25)
  expect(send).not.toHaveBeenCalled(); expect(dom.draft()).toBe('Keep my draft')
})

async function setEditText(text: string) {
  const textarea = strip()!.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  return textarea
}
it('editing a nonhead never-admitted card saves through the original queue owner without sending or changing the composer draft', async () => {
  const entries = [{ ...queued('edit-head'), promptCondition: null, enqueuedAt: 10 }, { ...queued('edit-tail'), promptCondition: null, enqueuedAt: 20 }]
  const save = vi.spyOn(useAppStore.getState(), 'editQueuedAgentSteer')
  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue('submitted')
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  useAppStore.setState({ agentSteerQueues: { 'agent-1': entries } }); await mount()
  await act(async () => strip()!.querySelector('[data-queue-index="1"]')!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })))
  await pendingClick('[aria-label="编辑这条待发消息"]')
  const textarea = await setEditText('Edited tail\nFull second line')
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  expect(strip()!.dataset.operationId).toBe('edit-tail')
  await act(async () => strip()!.querySelector<HTMLButtonElement>('[aria-label="保存待发消息"]')!.click())
  expect(save).toHaveBeenLastCalledWith('agent-1', 'edit-tail', entries[1]!.text, 'Edited tail\nFull second line')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([entries[0], { ...entries[1], text: 'Edited tail\nFull second line' }])
  expect(strip()!.querySelector('textarea')).toBeNull();expect(strip()!.querySelector('.composer-pending__body')!.textContent).toBe('Edited tail\nFull second line')
  expect(send).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();expect(dom.draft()).toBe('Keep my draft')
})
it('a rejected compare-and-swap keeps the local edit draft and original delivery record; IME Escape does not dismiss', async () => {
  const original = { ...queued('edit-race'), promptCondition: null, enqueuedAt: 20 }
  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue('submitted')
  useAppStore.setState({ agentSteerQueues: { 'agent-1': [original] } });await mount();await pendingClick('[aria-label="编辑这条待发消息"]')
  const textarea = await setEditText('My unsaved draft')
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })))
  expect(strip()!.querySelector('textarea')).toBe(textarea)
  await act(async () => useAppStore.setState({ agentSteerQueues: { 'agent-1': [{ ...original, text: 'Independent edit' }] } }))
  await act(async () => strip()!.querySelector<HTMLButtonElement>('[aria-label="保存待发消息"]')!.click())
  expect(textarea.value).toBe('My unsaved draft');expect(strip()!.querySelector('[role="alert"]')).not.toBeNull()
  expect(useAppStore.getState().agentSteerQueues['agent-1']![0]!.text).toBe('Independent edit')
  const receipt = { expectedRun: { runId: original.runId }, afterSubmissionId: null }
  await act(async () => useAppStore.setState({ agentSteerQueues: { 'agent-1': [{ ...original, promptCondition: receipt, status: 'deferred', error: 'Original delivery unknown' }] } }))
  expect(strip()!.querySelector<HTMLButtonElement>('[aria-label="保存待发消息"]')!.disabled).toBe(true)
  expect(textarea.value).toBe('My unsaved draft');expect(useAppStore.getState().agentSteerQueues['agent-1']![0]!.promptCondition).toEqual(receipt)
  expect(send).not.toHaveBeenCalled();expect(dom.draft()).toBe('Keep my draft')
})

it('opening and closing the original Mailbox retains the floating edit draft while suppressing its projection', async () => {
  useAppStore.setState({ agentSteerQueues: { 'agent-1': [{ ...queued('preview-edit'), promptCondition: null }] } });await mount();await pendingClick('[aria-label="编辑这条待发消息"]')
  const textarea = await setEditText('Unsaved local edit survives Mailbox')
  const panel = dom.container.querySelector('.composer-mailbox')!
  await act(async () => (panel as HTMLElement).showPopover())
  expect(strip()).toBeNull();expect(document.querySelector('.composer-pending[hidden] textarea')).toBe(textarea)
  await dom.click('[aria-label="Close mailbox"]')
  expect(strip()!.querySelector('textarea')).toBe(textarea);expect(textarea.value).toBe('Unsaved local edit survives Mailbox');expect(dom.draft()).toBe('Keep my draft')
})

it('compact rows have three original actions, no native full-text tooltip, and one reader and live announcement', async () => {
  useAppStore.setState({agentSteerQueues:{'agent-1':[queued('head'),queued('tail')]}})
  await mount()
  for (const card of strip()!.querySelectorAll('.composer-pending__card')) {
    expect(card.querySelectorAll('.composer-pending__actions button')).toHaveLength(3)
    expect(card.querySelector('.composer-pending__preview')!.hasAttribute('title')).toBe(false)
    expect(card.querySelector('.composer-pending__state')!.getAttribute('aria-label')).toBe('排队中')
    expect(card.querySelector('[role="status"]')).toBeNull()
  }
  await act(async () => strip()!.querySelector('[data-queue-index="1"]')!.dispatchEvent(new PointerEvent('pointermove',{bubbles:true})))
  expect(strip()!.querySelectorAll('.composer-pending__body')).toHaveLength(1)
  expect(strip()!.querySelector('.composer-pending__body')!.textContent).toBe('Original tail')
  expect(strip()!.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(strip()!.querySelector('.composer-pending__reading-state')!.textContent).toContain('排队中')
})

it('copy shows a visible check only after the real clipboard owner accepts the original full body', async () => {
  const write = vi.spyOn(api.ui,'writeClipboardText').mockResolvedValue()
  useAppStore.setState({agentSteerQueues:{'agent-1':[queued('copy')]}})
  await mount(); await pendingClick('[aria-label="复制这条待发消息"]')
  const button = selectedCard().querySelector('.composer-pending__copy')!
  expect(write).toHaveBeenCalledExactlyOnceWith('Original copy')
  expect(button.getAttribute('data-copy-state')).toBe('copied')
  expect(button.querySelector('svg.lucide-check')).not.toBeNull()
  expect(strip()!.querySelector('[role="status"]')!.textContent).toBe('已复制待发消息')
  expect(dom.draft()).toBe('Keep my draft')
})

it('a real clipboard rejection remains failed through the original feedback owner and never shows a success check', async () => {
  vi.spyOn(api.ui,'writeClipboardText').mockRejectedValue(new Error('Clipboard unavailable'))
  useAppStore.setState({agentSteerQueues:{'agent-1':[queued('copy-failed')]}})
  await mount(); await pendingClick('[aria-label="复制这条待发消息"]')
  const button = selectedCard().querySelector('.composer-pending__copy')!
  expect(button.getAttribute('data-copy-state')).toBe('failed')
  expect(button.querySelector('svg.lucide-check')).toBeNull()
  expect(strip()!.querySelector('[role="status"]')!.textContent).not.toContain('已复制')
  await pendingClick('[aria-label="在 Outbox 查看待发消息和操作"]')
  await dom.click('[id$="-system-tab"]')
  await dom.click('[data-record-key^="notice:tool:"]')
  expect(dom.container.textContent).toContain('Clipboard unavailable')
  expect(dom.draft()).toBe('Keep my draft')
})

it('a late clipboard result cannot mark a changed original body or supersede the latest copy operation', async () => {
  let release!: () => void
  const write = vi.spyOn(api.ui,'writeClipboardText').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve })).mockResolvedValue()
  const original = queued('copy-late')
  useAppStore.setState({agentSteerQueues:{'agent-1':[original,queued('copy-next')]}})
  await mount(); await pendingClick('[aria-label="复制这条待发消息"]')
  await act(async () => useAppStore.setState({agentSteerQueues:{'agent-1':[{...original,text:'Changed original body'},queued('copy-next')]}}))
  await act(async () => { release() })
  expect(selectedCard().querySelector('.composer-pending__copy')!.getAttribute('data-copy-state')).toBe('idle')
  expect(strip()!.querySelector('[role="status"]')!.textContent).toBe('')
  expect(write).toHaveBeenLastCalledWith('Original copy-late')
  await act(async () => strip()!.querySelector('[data-queue-index="1"]')!.dispatchEvent(new PointerEvent('pointermove',{bubbles:true})))
  await pendingClick('[aria-label="复制这条待发消息"]')
  expect(selectedCard().querySelector('.composer-pending__copy')!.getAttribute('data-copy-state')).toBe('copied')
  expect(write).toHaveBeenLastCalledWith('Original copy-next')
  expect(dom.draft()).toBe('Keep my draft')
})
