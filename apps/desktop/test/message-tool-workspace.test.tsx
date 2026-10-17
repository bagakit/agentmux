// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseAgentInputMailboxPage } from '@agentmux/core/agent-input-mailbox'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { mailboxJournal } from './helpers/mailbox-journal-fixture'
import { inputPage, visualInputPage, historyPage, journalBody, journalWire, secondJournalBody, capturedBody, nativeBody } from '../scripts/fixtures/message-tool-workspace/data'

// The production Composer, mailbox, both query hooks, shared records and store remain real.
// Only their original Desktop API ports receive bounded fixture records.
const dom = composerDOM(), session = composerSession()
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
  mailboxJournal()
  vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async () => inputPage(session.id, session.control.run))
  vi.spyOn(api.sessions, 'readHistory').mockImplementation(async (reference, input) => historyPage(reference.hostId, reference.agentSessionId, input.source, input.query))
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: session.id,
    source: { providerId: 'codex', nativeSessionId: 'workspace-native' }, items: [], nextCursor: null })
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source: { providerId: 'codex', nativeSessionId: 'workspace-native' }, dispose() {} })
  vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('Reading must not dispatch input'))
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  useAppStore.setState({ timelines: {}, noticeReadReceipts: {}, agentComposerHistory: {}, agentSteerQueues: {},
    agentComposerDrafts: { [session.id]: 'Keep my draft' }, agentSteerInFlight: {} })
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
