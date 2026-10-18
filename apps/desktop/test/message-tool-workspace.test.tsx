// @vitest-environment happy-dom
import './helpers/mailbox-note-execution-fence'
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseAgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { mailboxJournal, journalMessage } from './helpers/mailbox-journal-fixture'
import { inputPage, visualInputPage, historyPage, journalBody, journalWire, secondJournalBody, capturedBody, nativeBody } from '../scripts/fixtures/message-tool-workspace/data'

// The production Composer, mailbox, both query hooks, shared records and store remain real.
// Only their original Desktop API ports receive bounded fixture records.
const dom = composerDOM(), session = composerSession()
let journal: ReturnType<typeof mailboxJournal>
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const content = () => panel().querySelector<HTMLElement>('.composer-mailbox__content')!
const rows = () => [...panel().querySelectorAll<HTMLButtonElement>('[role="tabpanel"]:not([hidden]) button[data-record-key]')]
const query = () => panel().querySelector<HTMLInputElement>('input[type="search"]')!
const flush = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }) }
async function click(node: HTMLElement | null | undefined) { expect(node).toBeTruthy(); await act(async () => node!.click()); await flush() }
async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function search(value: string) {
  await type(query(), value)
  await act(async () => query().closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await flush()
}
async function open() {
  await dom.render(<AgentSessionComposer sessionId={session.id} />)
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event))
  await flush()
  await click(panel().querySelector('[id$="-user-tab"]'))
}
beforeEach(() => {
  journal = mailboxJournal()
  vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async () => inputPage(session.id, session.control.run))
  vi.spyOn(api.sessions, 'readHistory').mockImplementation(async (reference, input) => historyPage(reference.hostId, reference.agentSessionId, input.source, input.query))
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: session.id,
    source: { providerId: 'codex', nativeSessionId: 'workspace-native' }, items: [], nextCursor: null })
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source: { providerId: 'codex', nativeSessionId: 'workspace-native' }, dispose() {} })
  vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async (reference, query) => notificationEvents(reference, query))
  vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('Reading must not dispatch input'))
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  useAppStore.setState({ timelines: {}, noticeReadReceipts: {}, agentComposerHistory: {}, agentSteerQueues: {},
    agentComposerDrafts: { [session.id]: 'Keep my draft' }, agentSteerInFlight: {}, mailboxNotificationIntents: {}, mailboxNotificationFeedback: {}, mailboxNotificationHistory: {} })
})

it('validates the native scene through the original Core mailbox codec, including its launch receipt', () => {
  const page = visualInputPage(session.id, session.control.run), request = { agentSessionId: session.id, maxBytes: page.budgetBytes }
  expect(parseAgentInputMailboxPage(page, request)).toEqual(page)
  const invalid = structuredClone(page), launch = invalid.items.find(entry => entry.kind === 'item' && entry.item.kind === 'submission')
  if (launch?.kind !== 'item' || launch.item.kind !== 'submission' || !launch.item.record?.launch) throw new Error('The scene requires its original launch record')
  expect(launch.item.record.launch.message.userContent).toBe(secondJournalBody)
  delete launch.item.record.launch.receipt
  expect(() => parseAgentInputMailboxPage(invalid, request)).toThrow('Invalid original continuity launch input')
})

it('searches loaded journal and original history together, clears the same query and preserves the draft', async () => {
  await open()
  expect(rows(), panel().textContent ?? '').toHaveLength(4)
  expect(rows().map(row => row.textContent).join(' ')).toContain(secondJournalBody)
  await search('Mercury')
  expect(rows()).toHaveLength(2)
  expect(rows().every(row => row.textContent?.includes('Mercury'))).toBe(true)
  expect(rows().map(row => row.textContent).join(' ')).not.toContain(nativeBody)
  expect(query().value).toBe('Mercury')
  expect(panel().querySelectorAll('.input-history__search')).toHaveLength(1)
  expect(panel().querySelectorAll('[aria-label="Refresh inputs"]')).toHaveLength(1)
  expect(panel().textContent).toContain('earlier coverage unconfirmed')
  await search('')
  expect(rows()).toHaveLength(4)
  expect(dom.draft()).toBe('Keep my draft')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('refreshes both original readers with the current query and retains known records when one source fails', async () => {
  await open(); await search('Mercury')
  const journalReads = vi.mocked(api.sessions.inputMailbox).mock.calls.length
  const historyReads = vi.mocked(api.sessions.readHistory).mock.calls.length
  vi.mocked(api.sessions.readHistory).mockImplementation(async (reference, input) => {
    if (input.source === 'native') throw new Error('Native source temporarily unavailable')
    return historyPage(reference.hostId, reference.agentSessionId, input.source, input.query)
  })
  await click(panel().querySelector('[aria-label="Refresh inputs"]'))
  expect(api.sessions.inputMailbox).toHaveBeenCalledTimes(journalReads + 1)
  expect(api.sessions.readHistory).toHaveBeenCalledTimes(historyReads + 2)
  expect(vi.mocked(api.sessions.readHistory).mock.calls.slice(-2).map(([, input]) => input.query)).toEqual(['Mercury', 'Mercury'])
  expect(query().value).toBe('Mercury')
  expect(rows()).toHaveLength(2)
  expect(panel().textContent).toContain('Native source temporarily unavailable')
  expect(panel().textContent).not.toContain('Available history checked for this read.')
  expect(dom.draft()).toBe('Keep my draft')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('uses one complete detail and Back flow for journal and history, preserving source, copy, query, scroll and focus', async () => {
  await open(); await search('Mercury')
  for (const [prefix, original, copied] of [['Mercury · 核对', journalBody, journalWire], ['Mercury · 对照', capturedBody, capturedBody]]) {
    const row = rows().find(node => node.textContent?.includes(prefix))!
    const key = row.dataset.recordKey
    content().scrollTop = 31
    await act(async () => row.focus()); await click(row)
    expect(panel().querySelectorAll('.log-turn__body')).toHaveLength(1)
    expect(panel().querySelector('.log-turn__body')?.textContent?.replace(/\s/g, '')).toContain(original.replace(/\s/g, ''))
    expect(panel().querySelectorAll('.composer-mailbox__row')).toHaveLength(0)
    const back = panel().querySelector<HTMLButtonElement>('.composer-mailbox__back button')!
    expect(back).not.toBeNull(); expect(document.activeElement).toBe(back)
    await click(panel().querySelector('[aria-label="Copy message"]'))
    expect(api.ui.writeClipboardText).toHaveBeenLastCalledWith(copied)
    await click(back)
    expect(query().value).toBe('Mercury')
    expect(content().scrollTop).toBe(31)
    expect((document.activeElement as HTMLElement).dataset.recordKey).toBe(key)
  }
  expect(dom.draft()).toBe('Keep my draft')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('keeps unconfirmed records readable with unknown author and original identity', async () => {
  await open()
  const row = rows().find(node => node.textContent?.includes('Mercury · 核对'))!
  expect(row.textContent).toContain('Author unknown')
  await click(row)
  expect(panel().querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('unknown')
  expect(panel().querySelector('.log-turn__body')?.textContent).toContain('原文末尾仍然可读。')
  await click(panel().querySelector('[aria-label="Message details"]'))
  expect(panel().textContent).toContain('journal-0')
  expect(panel().textContent).toContain('unconfirmed')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('edits one retained pending input without dispatching, replacing the composer draft or moving its identity', async () => {
  useAppStore.setState({ agentSteerQueues: { [session.id]: [{ operationId: 'retained-edit', runId: session.control.run.runId,
    text: 'Original pending text', status: 'queued', promptCondition: null, enqueuedAt: 1 },
  { operationId: 'retained-next', runId: session.control.run.runId, text: 'Next pending text', status: 'queued', promptCondition: null, enqueuedAt: 2 }] } })
  await open()
  const edit = panel().querySelector<HTMLButtonElement>('[data-operation-id="retained-edit"] [aria-label="编辑这条待发消息"]')!
  expect(edit.disabled).toBe(false); await click(edit)
  const editor = panel().querySelector<HTMLTextAreaElement>('[aria-label="编辑待发消息"]')!
  await type(editor, 'Edited original pending text')
  await click(panel().querySelector('[aria-label="保存待发消息"]'))
  const queue = useAppStore.getState().agentSteerQueues[session.id]!
  expect(queue.map(item => item.operationId)).toEqual(['retained-edit', 'retained-next'])
  expect(queue[0]).toMatchObject({ text: 'Edited original pending text', runId: session.control.run.runId, enqueuedAt: 1, promptCondition: null })
  expect(dom.draft()).toBe('Keep my draft')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('retains an earlier loaded history record across head refresh and same-scope reopen', async () => {
  vi.mocked(api.sessions.readHistory).mockImplementation(async (reference, input) => {
    const page = historyPage(reference.hostId, reference.agentSessionId, input.source, input.query)
    if (input.source !== 'captured') return page
    return input.cursor ? { ...page, userMessages: page.userMessages!.map(message => ({ ...message,
      id: 'captured:earlier-record', content: 'Mercury · Earlier already-read input', contentParts: [{ kind: 'text', text: 'Mercury · Earlier already-read input' }],
      source: { kind: 'captured', submissionId: 'earlier-record' } })) }
      : { ...page, nextCursor: 'earlier-window', scan: { examined: 1, complete: false } }
  })
  await open(); await search('Mercury')
  const earlier = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '继续查找发送记录')
  await click(earlier)
  expect(rows()).toHaveLength(3)
  expect(rows().map(row => row.textContent).join(' ')).toContain('Earlier already-read input')
  await click(panel().querySelector('[aria-label="Refresh inputs"]'))
  expect(rows()).toHaveLength(3)
  const toggle = async (state: string) => { const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: state }); await act(async () => panel().dispatchEvent(event)); await flush() }
  await toggle('closed'); await toggle('open'); await click(panel().querySelector('[id$="-user-tab"]'))
  expect(query().value).toBe('Mercury')
  expect(rows().map(row => row.textContent).join(' ')).toContain('Earlier already-read input')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('keeps journal detail selected while editing its original local pending item', async () => {
  useAppStore.setState({ agentSteerQueues: { [session.id]: [{ operationId: 'journal-0', runId: session.control.run.runId,
    text: journalBody, status: 'queued', promptCondition: null, enqueuedAt: 1,
    directInputControl: session.control, directInputBinding: { expectedRun: session.control.run, admissionIntent: { kind: 'manual-actor' } } }] } })
  await open(); await click(rows().find(row => row.textContent?.includes('Mercury · 核对')))
  const detailKey = panel().querySelector<HTMLElement>('.composer-mailbox__detail[data-record-key]')!.dataset.recordKey
  const local = [...panel().querySelectorAll<HTMLDetailsElement>('details')].find(node => node.querySelector('summary')?.textContent === '此设备的保留操作')!
  await act(async () => { local.open = true; local.dispatchEvent(new Event('toggle')) })
  await click(local.querySelector('[aria-label="编辑这条待发消息"]'))
  const editor = panel().querySelector<HTMLTextAreaElement>('[aria-label="编辑待发消息"]')!
  expect(editor).not.toBeNull()
  await type(editor, 'Retained journal edit')
  await click(panel().querySelector('[aria-label="保存待发消息"]'))
  expect(panel().querySelector<HTMLElement>('.composer-mailbox__detail[data-record-key]')!.dataset.recordKey).toBe(detailKey)
  expect(useAppStore.getState().agentSteerQueues[session.id]![0]).toMatchObject({ operationId: 'journal-0', text: 'Retained journal edit' })
  expect(dom.draft()).toBe('Keep my draft')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('keeps the three message paths distinct from Automation and retains its unsaved form on return', async () => {
  const observer = vi.spyOn(api.continuousProgress, 'onChanged').mockReturnValue(() => {})
  const create = vi.spyOn(api.continuousProgress, 'create'), action = vi.spyOn(api.continuousProgress, 'action')
  vi.spyOn(api.schedule, 'list').mockRejectedValue(new Error('Calendar source unavailable'))
  await open()
  const labels = () => [...panel().querySelectorAll('.composer-mailbox__folder-label')].map(node => node.textContent)
  expect(labels()).toEqual(['Inputs', 'Agent messages', 'Notices'])
  await click(panel().querySelector('[id$="-agents-tab"]'))
  expect(labels()).toEqual(['Inputs', 'Agent messages', 'Notices', 'Received', 'Sent', 'Collaboration'])
  await click(panel().querySelector('[id$="-outbox-tab"]'))
  expect(panel().querySelector('[aria-label="Automation"] > svg')?.getAttribute('data-semantic-icon')).toBe('object.automation')
  await click(panel().querySelector('[aria-label="Automation"]'))
  expect(panel().querySelector('[role="tablist"]')).toBeNull()
  expect(panel().textContent).toContain('Calendar source unavailable')
  expect(panel().textContent).toContain('Retry arrangements')
  expect(panel().textContent).not.toContain('Reading arrangements…')
  const settings = panel().querySelector<HTMLDetailsElement>('[data-progress-details="interval"]')!
  await act(async () => { settings.open = true; settings.dispatchEvent(new Event('toggle')) })
  const interval = settings.querySelector<HTMLInputElement>('input[type="number"]')!
  await type(interval, '23')
  const count = observer.mock.calls.length
  await click(panel().querySelector('[aria-label="Back to messages"]'))
  expect(panel().querySelector('[id$="-outbox-tab"]')?.getAttribute('aria-selected')).toBe('true')
  await click(panel().querySelector('[id$="-user-tab"]'))
  await click(panel().querySelector('[aria-label="Automation"]'))
  expect(panel().querySelector('[data-progress-details="interval"] input[type="number"]')).toBe(interval)
  expect(interval.value).toBe('23')
  expect(observer).toHaveBeenCalledTimes(count)
  expect(create).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
})

it('keeps the static Automation object distinct from its observed progress status', async () => {
  const observer = vi.spyOn(api.continuousProgress, 'onChanged').mockReturnValue(() => {})
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  await open()
  const entry = panel().querySelector<HTMLButtonElement>('[aria-label="Automation"]')!
  const icon = entry.querySelector('svg')!
  expect(icon.getAttribute('data-semantic-icon')).toBe('object.automation')
  expect(icon.getAttribute('width')).toBe('14'); expect(icon.getAttribute('height')).toBe('14')
  expect(icon.getAttribute('aria-hidden')).toBe('true'); expect(entry.querySelector('[data-icon-animation]')).toBeNull()
  const status = document.getElementById(entry.getAttribute('aria-describedby')!)!
  expect(status.textContent).toBe('Not enabled')
  for (const [state, semantic, label] of [['active', 'action.repeat', 'Running'], ['paused', 'action.pause', 'Paused'], ['unconfirmed', 'status.unknown', 'Status unknown']] as const) {
    await act(async () => observer.mock.calls.at(-1)![0]({ loopId: 'observed-loop', hostId: session.hostId, agentSessionId: session.id,
      providerId: session.providerId, workspacePath: session.workspacePath, intervalMs: 60_000, prompt: 'Keep the original task.', nextCheckAt: 60_000,
      status: state === 'active' ? 'active' : 'paused', ...(state === 'unconfirmed' ? { lastOutcome: 'unknown' as const } : {}) }))
    await flush()
    expect(entry.querySelector('svg')).toBe(icon)
    expect(status.textContent).toBe(label); expect(status.getAttribute('data-status')).toBe(state)
    const progress = dom.container.querySelector('.composer__mailbox .composer-mailbox__progress')!
    expect(progress.getAttribute('data-semantic-icon')).toBe(semantic)
    expect(progress.getAttribute('width')).toBe('10'); expect(progress.getAttribute('height')).toBe('10')
  }
  expect(dom.draft()).toBe('Keep my draft'); expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('stops the calendar display clock when Automation is hidden while retaining both unsaved forms', async () => {
  const started = vi.spyOn(globalThis, 'setInterval'), cleared = vi.spyOn(globalThis, 'clearInterval')
  const displayClocks = () => started.mock.calls.flatMap(([, delay], index) => delay === 1000 ? [started.mock.results[index]!.value] : [])
  const activeClocks = () => displayClocks().filter(timer => !cleared.mock.calls.some(([stopped]) => stopped === timer))
  const disposed = vi.fn(), observer = vi.spyOn(api.schedule, 'onChanged').mockReturnValue(disposed)
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  const create = vi.spyOn(api.schedule, 'create'), startProgress = vi.spyOn(api.continuousProgress, 'create')
  await open()
  expect(activeClocks()).toHaveLength(0)
  await click(panel().querySelector('[aria-label="Automation"]'))
  expect(activeClocks()).toHaveLength(1)
  const firstClock = activeClocks()[0], subscriptions = observer.mock.calls.length
  expect(subscriptions).toBe(1)
  const intervalDetails = panel().querySelector<HTMLDetailsElement>('[data-progress-details="interval"]')!
  const calendarDetails = panel().querySelector<HTMLDetailsElement>('.schedule-create')!
  await act(async () => {
    for (const details of [intervalDetails, calendarDetails]) { details.open = true; details.dispatchEvent(new Event('toggle')) }
  })
  const interval = intervalDetails.querySelector<HTMLInputElement>('input[type="number"]')!
  const message = calendarDetails.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!
  await type(interval, '23'); await type(message, 'Retain this unsaved calendar message')
  const retained = () => {
    expect(panel().querySelector('[data-progress-details="interval"] input[type="number"]')).toBe(interval)
    expect(panel().querySelector('[aria-label="Arranged message"]')).toBe(message)
    expect(interval.value).toBe('23'); expect(message.value).toBe('Retain this unsaved calendar message')
    expect(intervalDetails.open).toBe(true); expect(calendarDetails.open).toBe(true)
  }
  await click(panel().querySelector('[aria-label="Back to messages"]'))
  expect(cleared).toHaveBeenCalledWith(firstClock)
  expect(activeClocks()).toHaveLength(0); retained()
  await click(panel().querySelector('[aria-label="Automation"]'))
  expect(activeClocks()).toHaveLength(1); retained()
  const reopenedClock = activeClocks()[0]
  const toggle = async (state: string) => {
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: state })
    await act(async () => panel().dispatchEvent(event)); await flush()
  }
  await toggle('closed')
  expect(cleared).toHaveBeenCalledWith(reopenedClock)
  expect(activeClocks()).toHaveLength(0); retained()
  await toggle('open')
  expect(activeClocks()).toHaveLength(0)
  await click(panel().querySelector('[aria-label="Automation"]'))
  expect(activeClocks()).toHaveLength(1); retained()
  expect(observer).toHaveBeenCalledTimes(subscriptions); expect(disposed).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled(); expect(startProgress).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
})

it('lets IME own Escape and returns ordinary mailbox Escape to its original trigger', async () => {
  const hide = vi.fn(function (this: HTMLElement) { const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'closed' }); this.dispatchEvent(event) })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: hide })
  await open()
  hide.mockClear()
  await act(async () => query().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })))
  expect(hide).not.toHaveBeenCalled()
  expect(panel().dataset.state).toBe('open')
  await act(async () => query().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(hide).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(dom.container.querySelector('.composer__mailbox'))
  expect(dom.draft()).toBe('Keep my draft')
})

it('returns from Automation to the original journal detail and reading position with a usable focus path', async () => {
  await open(); await click(rows().find(row => row.textContent?.includes('Mercury · 核对')))
  const key = panel().querySelector<HTMLElement>('.composer-mailbox__detail[data-record-key]')!.dataset.recordKey
  content().scrollTop = 47
  const entry = panel().querySelector<HTMLButtonElement>('[aria-label="Automation"]')!
  await act(async () => entry.focus()); await click(entry)
  const back = panel().querySelector<HTMLButtonElement>('[aria-label="Back to messages"]')!
  expect(document.activeElement).toBe(back)
  await click(back)
  expect(panel().querySelector<HTMLElement>('.composer-mailbox__detail[data-record-key]')?.dataset.recordKey).toBe(key)
  expect(panel().querySelector('.log-turn__body')?.textContent).toContain('原文末尾仍然可读。')
  expect(content().scrollTop).toBe(47)
  expect(document.activeElement).toBe(panel().querySelector('[aria-label="Automation"]'))
  expect(dom.draft()).toBe('Keep my draft')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('filters queued rows without changing the original neighbors or movement eligibility', async () => {
  const queue = ['Hidden predecessor', 'Mercury matching pending', 'Hidden successor'].map((text, index) => ({
    operationId: 'ordered-' + index, text, runId: session.control.run.runId, status: 'queued' as const, promptCondition: null, enqueuedAt: index + 1 }))
  useAppStore.setState({ agentSteerQueues: { [session.id]: queue }, agentSteerInFlight: { [session.id]: 'ordered-0' }, agentSteerInFlightPhase: { [session.id]: 'preparing' } })
  await open(); await search('Mercury'); await click(rows().find(row => row.dataset.recordKey === 'queue:ordered-1'))
  const original = () => panel().querySelector<HTMLElement>('[data-operation-id="ordered-1"]')!
  const up = () => original().querySelector<HTMLButtonElement>('[aria-label="Move up"]')!
  const down = () => original().querySelector<HTMLButtonElement>('[aria-label="Move down"]')!
  expect(panel().querySelector('[data-operation-id="ordered-0"]')).toBeNull()
  expect(up().disabled).toBe(true)
  expect(down().disabled).toBe(false)
  expect(down().title).toContain('unfiltered queue')
  await act(async () => useAppStore.setState({ agentSteerInFlight: {}, agentSteerInFlightPhase: {} }))
  expect(up().disabled).toBe(false)
  await click(down())
  expect(useAppStore.getState().agentSteerQueues[session.id]!.map(item => item.operationId)).toEqual(['ordered-0', 'ordered-2', 'ordered-1'])
  expect(dom.draft()).toBe('Keep my draft')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

function notificationOriginal() {
  return { ...journalMessage({ id: 'manual-original', body: 'Original author text remains unchanged', recipient: session.id }),
    deliveryMode: 'reference' as const, notification: { state: 'unconfirmed' as const, notificationId: 'old-automatic-unknown' },
    envelope: { ...journalMessage({ id: 'manual-original', body: 'Original author text remains unchanged', recipient: session.id }).envelope,
      recipientRunId: session.control.run.runId } }
}
const notificationKey = (operationId: string) => ({ kind: 'prompt' as const, agentSessionId: session.id, expectedRun: session.control.run, submissionId: operationId })
function notificationReceipt(operationId: string, state: 'submitted' | 'unconfirmed' | 'not-applied' = 'submitted', run = session.control.run) {
  return { hostId: 'local', notification: { notificationId: operationId, key: { ...notificationKey(operationId), expectedRun: run }, messageIds: ['manual-original'],
    wire: 'Original Core reference notice', condition: { expectedRun: run, afterSubmissionId: null }, mode: 'steer' as const, state }, input: null }
}
async function received(original = notificationOriginal()) {
  journal.set([original])
  await open(); await click(panel().querySelector('[id$="-agents-tab"]')); await click(panel().querySelector('[id$="-inbox-tab"]'))
}

it('manually notifies the original MID through the production Composer and keeps the action across list/detail and folder changes', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockImplementation(async (_reference, _messageId, operationId) => notificationReceipt(operationId))
  await received()
  const original = notificationOriginal()
  expect(panel().textContent).toContain('Notification unconfirmed')
  await click(panel().querySelector('[data-mailbox-notification-action="notify"]'))
  expect(notify).toHaveBeenCalledTimes(1)
  const [reference, mid, operation] = notify.mock.calls[0]!
  expect(reference).toEqual({ hostId: 'local', agentSessionId: session.id }); expect(mid).toBe(original.envelope.messageId)
  expect(operation).toBeTruthy(); expect(operation).not.toBe(original.notification.notificationId)
  expect(panel().textContent).toContain('This notification: submitted'); expect(panel().textContent).toContain('Other notification unconfirmed'); expect(panel().textContent).not.toContain('Agent has read')
  await click(panel().querySelector('[data-record-key="a2a:manual-original"]'))
  expect(panel().querySelector('.log-turn__body')?.textContent).toContain(original.envelope.body)
  expect(panel().querySelector('[data-notification-operation]')?.getAttribute('data-notification-operation')).toBe(operation)
  await click(panel().querySelector('[id$="-user-tab"]')); await click(panel().querySelector('[id$="-agents-tab"]'))
  expect(panel().querySelector('[data-notification-operation]')?.getAttribute('data-notification-operation')).toBe(operation)
  await click(panel().querySelector('[data-mailbox-notification-action="notify"]'))
  expect(notify).toHaveBeenCalledTimes(2); expect(notify.mock.calls[1]![2]).not.toBe(operation)
  expect(dom.draft()).toBe('Keep my draft'); expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(api.ui.writeClipboardText).not.toHaveBeenCalled()
})

it('keeps the original uncertain action and refreshes only its exact input receipt without replay', async () => {
  let resolve!: (value: ReturnType<typeof notificationReceipt>) => void
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockImplementation(() => new Promise(done => { resolve = done }))
  const inspect = vi.spyOn(api.sessions, 'inspectMessageNotification').mockImplementation(async (_reference, _mid, operation) => notificationReceipt(operation))
  await received(); await click(panel().querySelector('[data-mailbox-notification-action="notify"]'))
  const operation = notify.mock.calls[0]![2]
  expect(panel().querySelector<HTMLButtonElement>('[data-mailbox-notification-action="notify"]')?.getAttribute('aria-disabled')).toBe('true')
  await click(panel().querySelector('[data-mailbox-notification-action="notify"]')); expect(notify).toHaveBeenCalledTimes(1)
  await act(async () => resolve(notificationReceipt(operation, 'unconfirmed')))
  await click(panel().querySelector('[aria-label="Refresh receipt"]'))
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: session.id }, 'manual-original', operation)
  expect(notify).toHaveBeenCalledTimes(1); expect(panel().textContent).toContain('This notification: submitted')
  expect(panel().querySelector('[data-notification-operation]')?.getAttribute('data-notification-operation')).toBe(operation)
})

it('retains a lost notification response and refuses a receipt from another input producer', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockRejectedValue(new Error('Original Host response lost'))
  const inspect = vi.spyOn(api.sessions, 'inspectMessageNotification').mockRejectedValue(new Error('Core rejected an unrelated original input producer'))
  await received(); await click(panel().querySelector('[data-mailbox-notification-action="notify"]'))
  const operation = notify.mock.calls[0]![2]
  expect(panel().textContent).toContain('Original Host response lost')
  await click(panel().querySelector('[aria-label="Refresh receipt"]'))
  expect(inspect).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledTimes(1)
  expect(panel().textContent).toContain('This notification: unconfirmed'); expect(panel().textContent).not.toContain('This notification: submitted')
  expect(panel().querySelector('[data-notification-operation]')?.getAttribute('data-notification-operation')).toBe(operation)
  expect(dom.draft()).toBe('Keep my draft')
})

it.each(['host', 'message', 'operation', 'recipient-run', 'recipient-session'] as const)('keeps notification unknown when its returned %s is from another original action', async mismatch => {
  vi.spyOn(api.sessions, 'notifyMessage').mockImplementation(async (_reference, _mid, operationId) => {
    const receipt = notificationReceipt(operationId)
    if (mismatch === 'host') receipt.hostId = 'another-host'
    if (mismatch === 'message') receipt.notification.messageIds = ['another-mid']
    if (mismatch === 'operation') receipt.notification.notificationId = 'another-operation'
    if (mismatch === 'recipient-run') receipt.notification.key.expectedRun = { runId: 'another-run' }
    if (mismatch === 'recipient-session') receipt.notification.key.agentSessionId = 'another-session'
    return receipt
  })
  await received(); await click(panel().querySelector('[data-mailbox-notification-action="notify"]'))
  expect(panel().textContent).toContain('This notification: unconfirmed')
  expect(panel().textContent).toContain('does not match this original notification')
  expect(panel().textContent).not.toContain('This notification: submitted')
  expect(dom.draft()).toBe('Keep my draft')
})

it('accepts the Core current notification Run while preserving the message historical recipient Run', async () => {
  const historicalRun = 'historical-message-run', inputRun = { runId: 'current-notification-run' }
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockImplementation(async (_reference, _mid, operation) => notificationReceipt(operation, 'submitted', inputRun))
  await received({ ...notificationOriginal(), envelope: { ...notificationOriginal().envelope, recipientRunId: historicalRun } })
  await click(notifyAction())
  const operation = notify.mock.calls[0]![2]
  expect(panel().textContent).toContain('This notification: submitted')
  const request = Object.values(Object.values(useAppStore.getState().mailboxNotificationIntents)[0]!)[0]!
  expect(request).toMatchObject({ operationId: operation, recipientRunId: historicalRun })
  const detail = panel().querySelector('[data-notification-operation] > .composer-mailbox__notification-feedback > details')!
  await act(async () => { (detail as HTMLDetailsElement).open = true })
  expect(detail.textContent).toContain('Original message Run ' + historicalRun)
  expect(detail.textContent).toContain('Notification input Run ' + inputRun.runId)
  expect(dom.draft()).toBe('Keep my draft'); expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('finds the frozen notification key by original operation after a lost response and Composer restoration', async () => {
  const inputRun = { runId: 'resumed-input-run' }
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockRejectedValue(new Error('Original response lost after Core froze a different current Run'))
  const inspect = vi.spyOn(api.sessions, 'inspectMessageNotification').mockImplementation(async (_reference, _mid, operation) => notificationReceipt(operation, 'submitted', inputRun))
  await received(); await click(notifyAction()); const operation = notify.mock.calls[0]![2]
  const options = useAppStore.persist.getOptions(), saved = options.partialize!(useAppStore.getState())
  expect(JSON.stringify(saved)).not.toContain(inputRun.runId)
  await dom.render(null)
  useAppStore.setState({ mailboxNotificationIntents: {}, mailboxNotificationFeedback: {}, mailboxNotificationHistory: {} })
  useAppStore.setState(options.merge!(saved, useAppStore.getState()) as ReturnType<typeof useAppStore.getState>)
  await received(); await click(receiptAction(operation))
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: session.id }, 'manual-original', operation)
  expect(panel().textContent).toContain('This notification: submitted')
  const observed = Object.values(Object.values(useAppStore.getState().mailboxNotificationFeedback)[0]!)[0]!
  expect(observed.key?.expectedRun).toEqual(inputRun)
  expect(notify).toHaveBeenCalledTimes(1); expect(dom.draft()).toBe('Keep my draft')
})

it('keeps a previously observed notification Run and exposes a mismatching read reason without replay', async () => {
  const originalRun = { runId: 'original-notification-run' }, laterRun = { runId: 'later-session-run' }
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockImplementation(async (_reference, _mid, operation) => notificationReceipt(operation, 'unconfirmed', originalRun))
  vi.spyOn(api.sessions, 'inspectMessageNotification').mockImplementation(async (_reference, _mid, operation) => notificationReceipt(operation, 'submitted', laterRun))
  await received(); await click(notifyAction()); const operation = notify.mock.calls[0]![2]
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (reference, query) => notificationEvents(reference, query,
    [{ ...notificationEvent(operation, 'unconfirmed'), reason: 'Older event has not observed a receipt' }]))
  await click(receiptAction(operation))
  expect(panel().textContent).toContain('This notification: unconfirmed')
  const visibleReason = panel().querySelector('.composer-mailbox__notification-feedback > .composer-mailbox__notification-reason')!
  expect(visibleReason).toBeTruthy()
  expect(visibleReason.textContent).toContain('does not match this original notification')
  expect(visibleReason.textContent).not.toContain('Older event')
  expect(visibleReason.closest('details')).toBeNull()
  const observed = Object.values(Object.values(useAppStore.getState().mailboxNotificationFeedback)[0]!)[0]!
  expect(observed.key?.expectedRun).toEqual(originalRun)
  expect(notify).toHaveBeenCalledTimes(1)
})

it('uses the Core whole-input refusal fact when refreshing an original notification', async () => {
  vi.spyOn(api.sessions, 'notifyMessage').mockImplementation(async (_reference, _mid, operationId) => notificationReceipt(operationId, 'unconfirmed'))
  vi.spyOn(api.sessions, 'inspectMessageNotification').mockImplementation(async (_reference, _mid, operation) => notificationReceipt(operation, 'not-applied'))
  await received(); await click(panel().querySelector('[data-mailbox-notification-action="notify"]')); await click(panel().querySelector('[aria-label="Refresh receipt"]'))
  expect(panel().textContent).toContain('This notification: not applied')
  expect(api.sessions.notifyMessage).toHaveBeenCalledTimes(1)
})

it('uses a newer receipt for the same notification while keeping an earlier independent notification distinguishable', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockImplementation(async (_reference, _mid, operationId) => notificationReceipt(operationId))
  await received(); await click(panel().querySelector('[data-mailbox-notification-action="notify"]'))
  expect(panel().textContent).toContain('Other notification unconfirmed')
  const operationId = notify.mock.calls[0]![2]
  await journal.publish([{ ...notificationOriginal(), notification: { state: 'unconfirmed', notificationId: operationId, reason: 'Stale observation of the same notification' } }])
  await flush()
  expect(panel().textContent).toContain('This notification: submitted')
  expect(panel().querySelector('.composer-mailbox__record-status')?.textContent ?? '').not.toContain('unconfirmed')
  await click(panel().querySelector('[data-record-key="a2a:manual-original"]'))
  expect(panel().textContent).not.toContain('Stale observation of the same notification')
  expect(panel().querySelector('.composer-mailbox__risk')).toBeNull()
})

it('adopts a later confirmed Core metadata receipt for the same locally unknown notification', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockRejectedValue(new Error('Notification response lost'))
  await received(); await click(panel().querySelector('[data-mailbox-notification-action="notify"]'))
  expect(panel().textContent).toContain('This notification: unconfirmed')
  const operationId = notify.mock.calls[0]![2]
  await journal.publish([{ ...notificationOriginal(), notification: { state: 'submitted', notificationId: operationId, key: notificationKey(operationId) } }]); await flush()
  expect(panel().textContent).toContain('This notification: submitted'); expect(panel().textContent).not.toContain('This notification: unconfirmed')
  expect(panel().textContent).not.toContain('Notification response lost')
  await journal.publish([{ ...notificationOriginal(), notification: { state: 'unconfirmed', notificationId: operationId } }]); await flush()
  expect(panel().textContent).toContain('This notification: submitted')
  expect(notify).toHaveBeenCalledTimes(1)
})

it('keeps an earlier inbox observation without inventing an earlier notification operation', async () => {
  vi.spyOn(api.sessions, 'notifyMessage').mockImplementation(async (_reference, _mid, operationId) => notificationReceipt(operationId))
  await received(); await journal.publish([{ ...notificationOriginal(), notification: { state: 'pending' } }]); await flush()
  await click(panel().querySelector('[data-mailbox-notification-action="notify"]'))
  expect(panel().textContent).toContain('Prior inbox observation: awaiting notification')
  expect(panel().textContent).not.toContain('Other notification')
  expect(panel().textContent).toContain('This notification: submitted')
})


function notificationEvents(reference: { hostId: string; agentSessionId: string }, query: import('../src/shared/contracts').SessionMessageEventsOptions = {},
  events: import('@agentmux/core').AgentMuxMessageEvent[] = []) {
  return { hostId: reference.hostId, participantSessionId: reference.agentSessionId, afterSequence: query.afterSequence ?? 0,
    latest: query.latest ?? false, beforeSequence: query.beforeSequence ?? null, throughSequence: query.throughSequence ?? 100,
    incarnation: query.incarnation ?? 'notification-journal', messageId: query.messageId ?? null, broadcastOperationId: null,
    events, nextAfterSequence: null, nextBeforeSequence: null }
}
function notificationEvent(operationId: string, state: 'submitted' | 'not-applied' | 'unconfirmed', sequence = 40) {
  const e = notificationOriginal().envelope
  return { sequence, kind: 'a2a-notification-result' as const, at: null, notificationId: operationId, state,
    ...(state === 'not-applied' ? { reason: 'Original input refused before admission' } : {}),
    messages: [{ messageId: e.messageId, senderSessionId: e.senderSessionId!, recipientSessionId: e.recipientSessionId!, threadId: e.threadId, replyTo: e.replyTo }] }
}
const notifyAction = () => panel().querySelector<HTMLButtonElement>('[data-mailbox-notification-action="notify"]')!
const receiptAction = (operation: string) => panel().querySelector<HTMLButtonElement>(`[data-notification-operation="${operation}"] [data-mailbox-notification-action="inspect"]`)!

it('persists the original notification request identity and restores its receipt action without replay after a real Composer remount', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockRejectedValue(new Error('Response lost before intake can be confirmed'))
  await received(); await click(notifyAction())
  const operation = notify.mock.calls[0]![2]
  const options = useAppStore.persist.getOptions(), saved = JSON.parse(JSON.stringify(options.partialize!(useAppStore.getState())))
  expect(Object.values(saved.mailboxNotificationIntents)).toHaveLength(1)
  expect(JSON.stringify(saved.mailboxNotificationIntents)).toContain(operation)
  expect(JSON.stringify(saved.mailboxNotificationIntents)).not.toContain(notificationOriginal().envelope.body)
  expect(saved.mailboxNotificationFeedback).toBeUndefined()
  await dom.render(null)
  useAppStore.setState({ mailboxNotificationIntents: {}, mailboxNotificationFeedback: {}, mailboxNotificationHistory: {} })
  const merged = options.merge!(saved, useAppStore.getState()) as ReturnType<typeof useAppStore.getState>
  useAppStore.setState(merged)
  await received()
  expect(receiptAction(operation)).toBeTruthy()
  expect(panel().textContent).toContain('receipt not checked')
  expect(notify).toHaveBeenCalledTimes(1)
  vi.spyOn(api.sessions, 'inspectMessageNotification').mockResolvedValue({ hostId: 'local', notification: null, input: null })
  await click(receiptAction(operation))
  expect(api.sessions.messageEvents).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: session.id }, expect.objectContaining({ messageId: 'manual-original', latest: true, limit: 50 }))
  expect(panel().textContent).not.toContain('not applied')
  expect(receiptAction(operation)).toBeTruthy(); expect(notify).toHaveBeenCalledTimes(1)
})

it('offers an explicit Notify again and retains both unknown operations and their original read-only checks', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockRejectedValue(new Error('Original response lost'))
  const inspect = vi.spyOn(api.sessions, 'inspectMessageNotification').mockResolvedValue({ hostId: 'local', notification: null, input: null })
  await received(); await click(notifyAction()); const first = notify.mock.calls[0]![2]
  expect(notifyAction().textContent).toContain('Notify again')
  expect(receiptAction(first)).toBeTruthy()
  await click(notifyAction()); const second = notify.mock.calls[1]![2]
  expect(first).not.toBe(second)
  expect(panel().querySelectorAll('[data-notification-operation]')).toHaveLength(2)
  expect(receiptAction(first)).toBeTruthy(); expect(receiptAction(second)).toBeTruthy()
  await click(receiptAction(first))
  expect(inspect).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: session.id }, 'manual-original', first)
  expect(notify).toHaveBeenCalledTimes(2); expect(dom.draft()).toBe('Keep my draft')
})

it('settles pending notification UI from its exact Core confirmation and keeps a later action independent of a late old response', async () => {
  let resolve!: (result: ReturnType<typeof notificationReceipt>) => void
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockImplementationOnce(() => new Promise(done => { resolve = done }))
    .mockRejectedValue(new Error('Second action response lost'))
  await received(); await click(notifyAction()); const first = notify.mock.calls[0]![2]
  expect(panel().textContent).toContain('sending')
  await journal.publish([{ ...notificationOriginal(), notification: { state: 'submitted', notificationId: first, key: notificationKey(first) } }]); await flush()
  expect(panel().textContent).toContain('This notification: submitted'); expect(notifyAction().disabled).toBe(false)
  await click(notifyAction()); const second = notify.mock.calls[1]![2]
  await act(async () => resolve(notificationReceipt(first, 'unconfirmed'))); await flush()
  expect(receiptAction(second)).toBeTruthy()
  expect(panel().querySelector(`[data-notification-operation="${first}"]`)?.textContent).toContain('submitted')
  expect(panel().querySelector(`[data-notification-operation="${second}"]`)?.textContent).toContain('unconfirmed')
})

it('reads a Core preclaim not-applied event even when no prompt input record exists', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockRejectedValue(new Error('Input was refused before claim'))
  const inspect = vi.spyOn(api.sessions, 'inspectMessageNotification').mockResolvedValue({ hostId: 'local', notification: null, input: null })
  await received(); await click(notifyAction()); const operation = notify.mock.calls[0]![2]
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (reference, query) => notificationEvents(reference, query, [notificationEvent(operation, 'not-applied')]))
  await click(receiptAction(operation))
  expect(panel().textContent).toContain('This notification: not applied')
  expect(panel().textContent).toContain('Original input refused before admission')
  expect(notify).toHaveBeenCalledTimes(1)
  expect(inspect.mock.results.every(result => result.type === 'return')).toBe(true)
})

it('retains original unknown receipts when a message event page belongs to another Host or MID', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockRejectedValue(new Error('Response lost'))
  vi.spyOn(api.sessions, 'inspectMessageNotification').mockResolvedValue({ hostId: 'local', notification: null, input: null })
  await received(); await click(notifyAction()); const operation = notify.mock.calls[0]![2]
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (reference, query) => ({ ...notificationEvents(reference, query, [notificationEvent(operation, 'submitted')]), hostId: 'another-host' }))
  await click(receiptAction(operation)); expect(panel().textContent).not.toContain('This notification: submitted')
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (reference, query) => ({ ...notificationEvents(reference, query, [notificationEvent(operation, 'submitted')]), messageId: 'another-mid' }))
  await click(receiptAction(operation)); expect(panel().textContent).not.toContain('This notification: submitted')
  expect(receiptAction(operation)).toBeTruthy(); expect(notify).toHaveBeenCalledTimes(1)
})

it('continues earlier notification receipts at the original journal boundary and retains a separate older operation', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockRejectedValue(new Error('Response lost'))
  vi.spyOn(api.sessions, 'inspectMessageNotification').mockResolvedValue({ hostId: 'local', notification: null, input: null })
  await received(); await click(notifyAction()); const operation = notify.mock.calls[0]![2]
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (reference, query = {}) => query.beforeSequence === undefined
    ? { ...notificationEvents(reference, query, [notificationEvent('later-independent-operation', 'unconfirmed', 60)]), nextBeforeSequence: 60 }
    : notificationEvents(reference, query, [notificationEvent(operation, 'not-applied', 40)]))
  await click(receiptAction(operation))
  const earlier = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Read earlier receipts'))
  await click(earlier)
  expect(api.sessions.messageEvents).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: session.id }, expect.objectContaining({ messageId: 'manual-original', beforeSequence: 60, throughSequence: 100, incarnation: 'notification-journal' }))
  expect(panel().querySelector(`[data-notification-operation="${operation}"]`)?.textContent).toContain('not applied')
  expect(notify).toHaveBeenCalledTimes(1)
})

it('shares one in-flight original notification across two mounted consumers of the same Session', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockImplementation(() => new Promise(() => {}))
  journal.set([notificationOriginal()])
  await dom.render(<><AgentSessionComposer sessionId={session.id} /><AgentSessionComposer sessionId={session.id} /></>)
  for (const mailbox of dom.container.querySelectorAll<HTMLElement>('.composer-mailbox')) {
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
    await act(async () => mailbox.dispatchEvent(event)); await flush()
    await click(mailbox.querySelector('[id$="-agents-tab"]')); await click(mailbox.querySelector('[id$="-inbox-tab"]'))
  }
  const buttons = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-mailbox-notification-action="notify"]')]
  expect(buttons).toHaveLength(2)
  await act(async () => { buttons[0]!.click(); buttons[1]!.click() }); await flush()
  expect(notify).toHaveBeenCalledTimes(1)
  const ids = [...dom.container.querySelectorAll<HTMLElement>('[data-notification-operation]')].map(node => node.dataset.notificationOperation)
  expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(1)
})

it('names the original Sent recipient rather than the mailbox owner in the notification action', async () => {
  const message = { ...notificationOriginal(), envelope: { ...notificationOriginal().envelope, senderSessionId: session.id,
    sender: { kind: 'agent-session' as const, agentSessionId: session.id }, recipientSessionId: 'other-recipient', recipientRunId: 'other-original-run',
    recipient: { kind: 'agent-session' as const, agentSessionId: 'other-recipient' } } }
  journal.set([message]); await open(); await click(panel().querySelector('[id$="-agents-tab"]')); await click(panel().querySelector('[id$="-outbox-tab"]'))
  expect(notifyAction().getAttribute('aria-label')).toContain('other-recipient')
  expect(notifyAction().title).toContain('other-recipient')
  await click(panel().querySelector('[data-record-key="a2a:manual-original"]'))
  expect(notifyAction().getAttribute('aria-label')).toContain('other-recipient')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('captures the A2A Fill caret before reading the original body and maps it through later editing', async () => {
  useAppStore.setState({ agentComposerDrafts: { [session.id]: 'left right' } })
  await received()
  const editor = dom.container.querySelector<HTMLElement>('[role="textbox"]')! as HTMLElement & { editor: import('@tiptap/core').Editor }
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.sessions.readMessage).mockImplementationOnce(async (reference, messageId) => { await gate; return { hostId: reference.hostId, message: notificationOriginal() } })
  await act(async () => editor.editor.commands.setTextSelection(5))
  await click(panel().querySelector('[aria-label="填入草稿"]'))
  await act(async () => { editor.editor.commands.setTextSelection(editor.editor.state.doc.content.size - 1); editor.editor.commands.insertContent(' + later edit') })
  expect(dom.draft()).toBe('left right + later edit')
  await act(async () => release()); await flush()
  expect(dom.draft()).toBe('left ' + notificationOriginal().envelope.body + ' right + later edit')
  await act(async () => { expect(editor.editor.commands.undo()).toBe(true) })
  expect(dom.draft()).toBe('left right + later edit')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})


it('discovers earlier journal notifications without inventing a local human request or replaying the original message', async () => {
  await received()
  const history = panel().querySelector<HTMLDetailsElement>('.composer-mailbox__notification-journal')!
  expect(history).toBeTruthy()
  expect(api.sessions.messageEvents).not.toHaveBeenCalled()
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (reference, query) => notificationEvents(reference, query, [
    notificationEvent('earlier-core-notification', 'not-applied', 30), notificationEvent('another-window-notification', 'unconfirmed', 40)
  ]))
  await act(async () => { history.open = true; history.dispatchEvent(new Event('toggle')) }); await flush()
  expect(api.sessions.messageEvents).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: session.id }, expect.objectContaining({ messageId: 'manual-original', latest: true, limit: 50 }))
  expect(history.querySelector('[data-notification-history-operation="earlier-core-notification"]')?.textContent).toContain('not applied')
  expect(history.querySelector('[data-notification-history-operation="another-window-notification"]')?.textContent).toContain('unconfirmed')
  expect(useAppStore.getState().mailboxNotificationIntents).toEqual({})
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
})


it('keeps each operation earlier-receipt boundary when another notification refreshes the shared message history', async () => {
  const notify = vi.spyOn(api.sessions, 'notifyMessage').mockRejectedValue(new Error('Response lost'))
  vi.spyOn(api.sessions, 'inspectMessageNotification').mockResolvedValue({ hostId: 'local', notification: null, input: null })
  await received(); await click(notifyAction()); const first = notify.mock.calls[0]![2]
  await click(notifyAction()); const second = notify.mock.calls[1]![2]
  let latest = 0
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (reference, query = {}) => {
    if (query.beforeSequence !== undefined) return notificationEvents(reference, query, [notificationEvent(first, 'not-applied', 40)])
    latest++
    return { ...notificationEvents(reference, { ...query, throughSequence: latest === 1 ? 100 : 200 }, [notificationEvent('independent-op', 'unconfirmed', latest === 1 ? 60 : 160)]), nextBeforeSequence: latest === 1 ? 60 : 160 }
  })
  await click(receiptAction(first)); await click(receiptAction(second))
  const firstRecord = panel().querySelector(`[data-notification-operation="${first}"]`)!
  await click(firstRecord.querySelector('[data-mailbox-notification-action="earlier"]'))
  expect(api.sessions.messageEvents).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: session.id }, expect.objectContaining({ beforeSequence: 60, throughSequence: 100, incarnation: 'notification-journal' }))
  expect(firstRecord.textContent).toContain('not applied')
  expect(notify).toHaveBeenCalledTimes(2)
})
