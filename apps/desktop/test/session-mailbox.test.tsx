import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AgentSessionUserMessage, ContinuousProgressLoop } from '@agentmux/core'
import { composerDOM, composerSession as processSession } from './helpers/composer-dom-fixture'
import { journalMessage, mailboxJournal } from './helpers/mailbox-journal-fixture'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs'
import { reduceAgentMembershipSnapshot } from '../src/renderer/src/lib/session-state'

function composerSession(...args: Parameters<typeof processSession>): ReturnType<typeof processSession> {
  const original = processSession(...args)
  return { ...original, status: { state: 'done' as const, source: 'native-hook' as const, observedAt: _tailFixtureEpoch(0, 0, 1) } }
}
// Install the native input-observation port before composerDOM changes its original draft.
beforeEach(() => { vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue() })
const dom = composerDOM()
let journal: ReturnType<typeof mailboxJournal>
beforeEach(() => {
  journal = mailboxJournal()
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
})
let disposeBootstrap: (() => void) | undefined
beforeAll(async () => { vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(); disposeBootstrap = await useAppStore.getState().initialize() })
afterAll(() => disposeBootstrap?.())
afterEach(() => vi.useRealTimers())
const session = () => ({ ...composerSession(), terminalPromptDelivery: {
  state: 'unverified' as const, mode: 'degraded' as const, reason: 'screen-evidence-gap' as const,
  submissionId: 'submission-1', run: { runId: 'run-agent-1' }, observedAt: _reshape_fixtureEpoch(0, 0, 1)
} })
beforeEach(() => useAppStore.setState({ sessions: [session()], noticeReadReceipts: {},
  timelines: { 'agent-1': { agentSessionId: 'agent-1', revision: 0, items: [] } } }))
const trigger = () => dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
const mailbox = () => dom.container.querySelector<HTMLDivElement>('.composer-mailbox')!
const unread = () => String(Boolean(trigger().querySelector('.composer-mailbox__unread, .composer-mailbox__attention')))
const progressLoop = (status: 'active' | 'paused' = 'active'): ContinuousProgressLoop => ({
  loopId: 'mailbox-loop', hostId: 'local', agentSessionId: 'agent-1', providerId: 'codex', workspacePath: _hygiene_fixturePath("repo"),
  intervalMs: 60_000, prompt: 'Continue', nextCheckAt: _reshape_fixtureEpoch(0, 0, 60_000), status
})

it('retries only the original Session Timeline from its notice and keeps the retained page until success', async () => {
  const current = composerSession()
  const retained = { agentSessionId: current.id, revision: 3, items: [] }
  const observation = { run: current.control.run, code: 'READ_FAILED', message: 'History temporarily unavailable' }
  const tab = createWorkbenchTab('timeline-retry-tab', { kind: 'agent', phase: 'attached', workspaceId: 'workspace-1',
    sessionId: current.id, regionId: initialWorkbenchRegionId('timeline-retry-tab') })
  useAppStore.setState({ sessions: [{ ...current, timelineObservation: observation }], timelines: { [current.id]: retained }, tabs: { [tab.id]: tab } })
  const refreshed = { ...current, label: 'Refreshed current Agent' }
  const readStatus = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(refreshed)
  await useAppStore.getState().refreshSession(current.id)
  expect(readStatus).toHaveBeenCalledWith(current.control)
  expect(useAppStore.getState().sessions[0]?.label).toBe(refreshed.label)
  expect(useAppStore.getState().sessions[0]).toHaveProperty('timelineObservation', observation)
  let complete!: (page: typeof retained) => void
  const retry = vi.spyOn(api.sessions, 'timeline').mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await dom.render(<AgentSessionComposer sessionId={current.id} />)
  await toggle('open'); await folder('system')
  const row = [...mailbox().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Reading work history'))!
  expect(row).toBeDefined()
  await act(async () => row.click())
  const action = [...mailbox().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry work history')!
  expect(action).toBeDefined()
  await act(async () => action.click())
  expect(retry).toHaveBeenCalledWith(current.control)
  expect(useAppStore.getState().timelines[current.id]).toBe(retained)
  expect(useAppStore.getState().sessions[0]).toHaveProperty('timelineObservation', observation)
  await act(async () => complete({ ...retained, revision: 4 }))
  await vi.waitFor(() => expect(useAppStore.getState().sessions[0]).not.toHaveProperty('timelineObservation'))
  expect(useAppStore.getState().timelines[current.id]?.revision).toBe(4)
  expect(dom.draft()).toBe('Keep my draft')
})

it.each(['status', 'live'] as const)('moves Timeline observation ownership from Run A to verified Run B via %s without accepting A’s late recovery', async (source) => {
  const first = composerSession()
  const retained = { agentSessionId: first.id, revision: 3, items: [] }
  const firstFailure = { run: first.control.run, code: 'A_HISTORY_FAILED', message: 'Run A history not observed' }
  const second = { ...first, label: 'Verified Run B', control: { ...first.control, run: { runId: 'run-B' } } }
  const secondFailure = { run: second.control.run, code: 'B_HISTORY_FAILED', message: 'Run B history not observed' }
  const tab = createWorkbenchTab('timeline-run-change-tab', { kind: 'agent', phase: 'attached', workspaceId: 'workspace-1',
    sessionId: first.id, regionId: initialWorkbenchRegionId('timeline-run-change-tab') })
  useAppStore.setState({ sessions: [{ ...first, timelineObservation: firstFailure }],
    timelines: { [first.id]: retained }, tabs: { [tab.id]: tab } })
  let completeA!: (page: typeof retained) => void
  const readTimeline = vi.spyOn(api.sessions, 'timeline')
    .mockImplementationOnce(() => new Promise(resolve => { completeA = resolve }))
    .mockResolvedValueOnce({ ...retained, revision: 5 })
  const pendingA = useAppStore.getState().resyncTimeline(first.id, { observationOnly: true })
  try {
    expect(readTimeline).toHaveBeenNthCalledWith(1, first.control)
    if (source === 'status') {
      vi.spyOn(api.sessions, 'refresh').mockResolvedValue(second)
      await useAppStore.getState().refreshSession(first.id)
      expect(useAppStore.getState().sessions[0]?.label).toBe(second.label)
    } else {
      useAppStore.getState().applyEvent({ type: 'core', hostId: first.hostId, event: { type: 'agent-session', session: {
        kind: 'agent', agentSessionId: first.id, hostId: first.hostId, providerId: first.providerId, executorId: first.executorId,
        workspacePath: first.workspacePath, run: second.control.run, retiredRuns: [first.control.run], createdAt: first.createdAt,
        updatedAt: Math.max(first.updatedAt, first.agentSessionUpdatedAt) + 1
      } } })
    }
    expect(useAppStore.getState().sessions[0]?.control).toEqual(second.control)
    expect(useAppStore.getState().sessions[0]).not.toHaveProperty('timelineObservation')
    expect(useAppStore.getState().timelines[first.id]).toBe(retained)

    // A new failed B observation is separate from A's request still in flight.
    useAppStore.setState(state => reduceAgentMembershipSnapshot(state, {
      sessions: [{ ...second, timelineObservation: secondFailure }], timelines: {}, recoveryCandidates: []
    }))
    completeA({ ...retained, revision: 4 })
    await pendingA
    expect(useAppStore.getState().sessions[0]).toHaveProperty('timelineObservation', secondFailure)
    await useAppStore.getState().resyncTimeline(first.id, { observationOnly: true })
    expect(readTimeline).toHaveBeenNthCalledWith(2, second.control)
    expect(useAppStore.getState().sessions[0]).not.toHaveProperty('timelineObservation')
    expect(useAppStore.getState().timelines[first.id]?.revision).toBe(5)
  } finally {
    // Release the old request even when a mutation trips an earlier assertion.
    completeA({ ...retained, revision: 4 })
    await pendingA
  }
})

it.each([0, 1, 9, 10, 12, 99, 100, 123])('shows %i Inbox unread separately from Notices attention, User Messages pending and Progress', async (count) => {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([progressLoop()])
  useAppStore.setState({ sessions: [session()], timelines: {
    'agent-1': { agentSessionId: 'agent-1', revision: 1, items: Array.from({ length: count }, (_, i) => delivered(`count-${i}`, 'peer')) }
  }, agentSteerQueues: { 'agent-1': [
    { operationId: 'pending-a', runId: 'run-agent-1', text: 'First original pending intent', status: 'queued' },
    { operationId: 'pending-b', runId: 'run-agent-1', text: 'Second original pending intent', status: 'queued' }
  ] } })
  const fresh = Array.from({ length: count }, (_, i) => journalMessage({ id: `count-${i}`, sequence: 1000 + i, sender: 'peer' }))
  journal.set(count > 25 ? fresh.map((record, index) => journalMessage({ id: `prior-${index}`, sequence: index + 1, sender: 'peer' })) : fresh)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  if (count > 25) {
    await toggle('open')
    for (let page = 1; page < Math.ceil(count / 25); ++page) {
      const earlier = [...mailbox().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Read earlier messages')!
      expect(earlier).toBeDefined(); await act(async () => earlier.click())
    }
    await toggle('closed'); await journal.publish(fresh)
  }
  const label = `Mailbox: A2A Inbox ${count} unread in loaded messages, User Messages 2 pending, Notices 1 need attention. Continuous progress: active`
  await vi.waitFor(() => {
    expect(trigger().dataset.progressState).toBe('active')
    expect(trigger().getAttribute('aria-label')).toBe(label)
  })
  const badge = trigger().querySelector('.composer-mailbox__unread')
  if (count === 0) expect(badge).toBeNull()
  else { expect(badge).not.toBeNull(); expect(badge!.textContent).toBe(count > 99 ? '99+' : String(count)) }
  expect(trigger().title).toBe(label)
  expect(trigger().querySelector('.composer-mailbox__attention')).not.toBeNull()
  expect(trigger().querySelector('.composer-mailbox__progress')).not.toBeNull()
  expect(trigger().querySelector(':scope > span:not([class])')).toBeNull()
  expect(mailbox().querySelector('[id$="-user-tab"]')!.getAttribute('aria-label')).toBe('User Messages: 2 pending')
  expect(mailbox().querySelector('[id$="-user-tab"] .composer-mailbox__count')!.textContent).toBe('2')
  expect(useAppStore.getState().agentSteerQueues['agent-1']!.map(entry => entry.text)).toEqual(['First original pending intent', 'Second original pending intent'])
  const read = useAppStore.getState().noticeReadReceipts['mail:agent-1'] ?? {}
  expect(Object.keys(read).every(key => key.includes('prior-'))).toBe(true)
  expect(dom.draft()).toBe('Keep my draft')
})
// happy-dom has no native popover toggle. Dispatch the browser's state event, not React internals.
async function toggle(state: 'open' | 'closed') {
  const event = new Event('toggle')
  Object.defineProperty(event, 'newState', { value: state })
  await act(async () => mailbox().dispatchEvent(event))
}
async function readRecord(key: string) {
  const row = [...mailbox().querySelectorAll<HTMLButtonElement>('button[data-record-key]')].find(row => row.dataset.recordKey === key)
  expect(row).toBeDefined(); await act(async () => row!.click())
}
async function backToRows() { const button = mailbox().querySelector<HTMLButtonElement>('.composer-mailbox__back button'); expect(button).not.toBeNull(); await act(async () => button!.click()) }
async function folder(name: 'inbox' | 'outbox' | 'user' | 'system' | 'progress') {
  await dom.click(`[role="tab"][id$="-${name}-tab"]`)
}

// Only the absent browser methods are supplied here. Native source/focus/light-dismiss are
// verified separately by trusted Electron input; these tests own the React disclosure/read paths.
function popoverMethods() {
  const content = mailbox()
  function state(newState: 'open' | 'closed') {
    const event = new Event('toggle')
    Object.defineProperty(event, 'newState', { value: newState })
    content.dispatchEvent(event)
  }
  const show = vi.fn((_options: { source: HTMLButtonElement }) => state('open'))
  const hide = vi.fn(() => state('closed'))
  Object.defineProperties(content, { showPopover: { configurable: true, value: show }, hidePopover: { configurable: true, value: hide } })
  return { show, hide }
}
async function pointer(target: Element, type: string, pointerType = 'mouse', buttons = 0) {
  await act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType, buttons })))
}

it('hover previews without reading or moving the current editor, allows crossing the gap, and reads only after entering content', async () => {
  const create = vi.spyOn(api.continuousProgress, 'create')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const editor = dom.container.querySelector<HTMLElement>('.ProseMirror')!
  const text = editor.querySelector('p')!.firstChild!
  editor.focus()
  const range = document.createRange(); range.setStart(text, 5); range.collapse(true)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  await act(async () => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' })))
  const methods = popoverMethods()
  vi.useFakeTimers()
  await pointer(trigger(), 'pointerover', 'touch')
  await pointer(trigger(), 'pointerover', 'mouse', 1)
  expect(methods.show).not.toHaveBeenCalled()
  await pointer(trigger(), 'pointerover')
  expect(methods.show).toHaveBeenCalledExactlyOnceWith({ source: trigger() })
  expect(mailbox().dataset.state).toBe('open')
  expect(unread()).toBe('true')
  expect(document.activeElement).toBe(editor)
  expect(document.getSelection()!.anchorNode).toBe(text)
  expect(document.getSelection()!.anchorOffset).toBe(5)
  expect(dom.draft()).toBe('Keep my draft')
  await pointer(trigger(), 'pointerout')
  await act(async () => vi.advanceTimersByTime(100))
  expect(methods.hide).not.toHaveBeenCalled()
  await pointer(mailbox(), 'pointerover')
  await act(async () => vi.advanceTimersByTime(300))
  expect(methods.hide).not.toHaveBeenCalled()
  expect(unread()).toBe('false')
  expect(document.activeElement).toBe(editor)
  await pointer(mailbox(), 'pointerout')
  await act(async () => vi.advanceTimersByTime(200))
  expect(methods.hide).toHaveBeenCalledTimes(1)
  expect(mailbox().dataset.state).toBe('closed')
  expect(dom.draft()).toBe('Keep my draft')
  expect(create).not.toHaveBeenCalled()
  await pointer(trigger(), 'pointerover')
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', isComposing: true })))
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', keyCode: 229 })))
  expect(methods.hide).toHaveBeenCalledTimes(1)
  await act(async () => editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })))
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })))
  expect(methods.hide).toHaveBeenCalledTimes(2)
  expect(document.activeElement).toBe(editor)
  expect(document.getSelection()!.anchorNode).toBe(text)
  expect(document.getSelection()!.anchorOffset).toBe(5)
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  expect(methods.hide).toHaveBeenCalledTimes(2) // Closed Mailbox has no keyboard owner.
})

it.each(['entry', 'content'] as const)('pins the hover preview through %s interaction and keeps the Progress form and observer', async (surface) => {
  const list = vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  const observe = vi.spyOn(api.continuousProgress, 'onChanged')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const methods = popoverMethods()
  vi.useFakeTimers()
  await pointer(trigger(), 'pointerover')
  if (surface === 'entry') {
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => trigger().dispatchEvent(click))
    expect(click.defaultPrevented).toBe(true)
  } else {
    await pointer(mailbox().querySelector('[id$="-progress-tab"]')!, 'pointerdown')
  }
  await folder('progress')
  const form = mailbox().querySelector('.continuous-progress-control form')!
  expect(form).not.toBeNull()
  if (surface === 'content') {
    const input = form.querySelector<HTMLInputElement>('input[type="number"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '17')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(input.value).toBe('17')
  }
  await pointer(trigger(), 'pointerout'); await pointer(mailbox(), 'pointerout')
  await act(async () => vi.advanceTimersByTime(400))
  expect(methods.hide).not.toHaveBeenCalled()
  expect(mailbox().dataset.state).toBe('open')
  await act(async () => mailbox().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })))
  expect(mailbox().dataset.state).toBe('closed')
  expect(document.activeElement).toBe(trigger())
  await pointer(trigger(), 'pointerover'); await folder('progress')
  expect(mailbox().querySelector('.continuous-progress-control form')).toBe(form)
  if (surface === 'content') expect(form.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('17')
  expect(list).toHaveBeenCalledTimes(1)
  expect(observe).toHaveBeenCalledTimes(1)
})

it('orders mixed recorded and captured history by original time, keeping equal/missing times stable and queue order untouched', async () => {
  journal.set([journalMessage({ id: 'in-old', sender: 'peer', body: 'Body in-old', sequence: 1 }), journalMessage({ id: 'in-new', sender: 'peer', body: 'Body in-new', sequence: 2 })])
  const native = (id: string, recordedAt?: number): AgentSessionUserMessage => ({ id, rawId: id, agentSessionId: 'agent-1',
    source: { kind: 'native', providerId: 'codex', nativeSessionId: 'native-session', recordId: id },
    author: { kind: 'unknown' }, content: id, contentParts: [{ kind: 'text', text: id }],
    ...(recordedAt === undefined ? {} : { recordedAt }) })
  const items = [{ ...delivered('old'), createdAt: _reshape_fixtureEpoch(0, 0, 10) }, { ...delivered('tie-a'), createdAt: _reshape_fixtureEpoch(0, 0, 30) },
    { ...delivered('tie-b'), createdAt: _reshape_fixtureEpoch(0, 0, 30) }, { ...delivered('in-old', 'peer'), createdAt: _reshape_fixtureEpoch(0, 0, 10) },
    { ...delivered('in-new', 'peer'), createdAt: _reshape_fixtureEpoch(0, 0, 50) }]
  let userMessages = [native('missing-a'), native('native-new', _reshape_fixtureEpoch(0, 0, 40)), native('native-tie', _reshape_fixtureEpoch(0, 0, 30)), native('missing-b')]
  const queued = [{ id: 'q-a', text: 'First intention', status: 'queued' as const, deliverable: false, enqueuedAt: _reshape_fixtureEpoch(0, 0, 999) },
    { id: 'q-b', text: 'Second intention', status: 'queued' as const, deliverable: false, enqueuedAt: _reshape_fixtureEpoch(0, 0, 1) }]
  const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
  const render = () => dom.render(<SessionMailbox system={system} queued={queued}
    timeline={{ agentSessionId: 'agent-1', revision: 1, items }} userMessages={userMessages} />)
  await render(); await toggle('open'); await folder('user')
  const contents = (name: string) => [...mailbox().querySelectorAll<HTMLButtonElement>(`[id$="-${name}"] .composer-mailbox__row`)].filter(row => !row.dataset.recordKey?.startsWith('queue:')).map(row => row.querySelector('.composer-mailbox__preview')!.textContent)
  expect(contents('user')).toEqual(['native-new', 'Body tie-a', 'Body tie-b', 'native-tie', 'Body old', 'missing-a', 'missing-b'])
  await folder('inbox')
  expect(contents('inbox')).toEqual(['Body in-new', 'Body in-old'])
  await folder('user')
  expect([...mailbox().querySelectorAll('.composer-outbox .composer-mailbox__preview')].map(el => el.textContent)).toEqual(['First intention', 'Second intention'])
  expect(items.map(item => item.content)).toEqual(['Body old', 'Body tie-a', 'Body tie-b', 'Body in-old', 'Body in-new'])
  userMessages = [...userMessages, native('loaded-earlier', _reshape_fixtureEpoch(0, 0, 5))]
  await render()
  expect(contents('user')).toEqual(['native-new', 'Body tie-a', 'Body tie-b', 'native-tie', 'Body old', 'loaded-earlier', 'missing-a', 'missing-b'])
})

it('uses the selected System owner time, keeps unknown times last, and never makes a time-only update unread', async () => {
  const current = session()
  current.terminalPromptDelivery.observedAt = _tailFixtureEpoch(0, 0, 30)
  current.terminalCapability = { state: 'unknown', mode: 'degraded', reason: 'handshake-timeout', run: current.control.run, observedAt: _reshape_fixtureEpoch(0, 0, 20) }
  current.terminalOutputChannel = { state: 'severed', mode: 'degraded', reason: 'reattach-failed', run: current.control.run, observedAt: _reshape_fixtureEpoch(0, 0, 1000) }
  current.status = { ...current.status, state: 'disconnected', observedAt: _reshape_fixtureEpoch(0, 0, 2000) }
  const queue: AgentSteerQueueEntry[] = [{ operationId: 'unknown-time', text: 'Kept', runId: 'run-agent-1', status: 'failed', enqueuedAt: _reshape_fixtureEpoch(0, 0, 9000) }]
  expect(sessionServiceNotices(current, queue).map(item => [item.id, item.observedAt])).toEqual([
    ['activity-observation', undefined], ['connection', _tailFixtureEpoch(0, 0, 20)], ['delivery', _tailFixtureEpoch(0, 0, 30)], ['queue', undefined]])
  await act(async () => useAppStore.setState({ sessions: [current], agentSteerQueues: { 'agent-1': queue } }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open'); await folder('system')
  const steps = () => [...mailbox().querySelectorAll('.composer-notice .composer-mailbox__row strong')].map(el => el.textContent)
  expect(steps()).toEqual(['Screen confirmation from retained terminal output didn’t complete', 'Checking terminal capabilities didn’t complete', 'Activity not confirmed', 'The original message delivery is still unconfirmed'])
  expect([...mailbox().querySelectorAll('.composer-notice time')].map(el => el.getAttribute('datetime'))).toEqual([
    new Date(_reshape_fixtureEpoch(0, 0, 30)).toISOString(), new Date(_reshape_fixtureEpoch(0, 0, 20)).toISOString()])
  await dom.click('[data-record-key^="notice:queue:"]');expect(mailbox().textContent).toContain('Time not recorded');await backToRows()
  await toggle('open'); await toggle('closed')
  await act(async () => useAppStore.setState({ sessions: [{ ...current,
    terminalCapability: { ...current.terminalCapability!, observedAt: _reshape_fixtureEpoch(0, 0, 40) } }] }))
  expect(unread()).toBe('false')
  await toggle('open'); await folder('system')
  expect(steps()).toEqual(['Checking terminal capabilities didn’t complete', 'Screen confirmation from retained terminal output didn’t complete', 'Activity not confirmed', 'The original message delivery is still unconfirmed'])
  const { terminalCapability: _capability, ...output } = current
  expect(sessionServiceNotices(output).map(item => [item.id, item.observedAt])).toEqual([['activity-observation', undefined], ['connection', _tailFixtureEpoch(0, 0, 1000)], ['delivery', _tailFixtureEpoch(0, 0, 30)]])
  const { terminalOutputChannel: _channel, ...withoutChannel } = output
  expect(sessionServiceNotices(withoutChannel).map(item => [item.id, item.observedAt])).toEqual([['activity-observation', undefined], ['connection', _tailFixtureEpoch(0, 0, 2000)], ['delivery', _tailFixtureEpoch(0, 0, 30)]])
})

it('uses one right Session mailbox, clears Notices attention on read and keeps the Core fact', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(dom.container.querySelectorAll('.composer__mailbox')).toHaveLength(1)
  expect(dom.container.querySelector('.composer__toolbar > div:first-child')?.contains(trigger())).toBe(false)
  expect(dom.container.querySelector('.composer__toolbar > div:last-child')?.contains(trigger())).toBe(true)
  expect(dom.container.querySelectorAll('.composer__notices, .composer__queued')).toHaveLength(0)
  expect(unread()).toBe('true')
  expect(trigger().querySelector('.composer-mailbox__unread')).toBeNull()
  expect(trigger().querySelector('.composer-mailbox__attention')).not.toBeNull()
  expect(document.getElementById(trigger().getAttribute('popovertarget')!)).toBe(mailbox())
  await toggle('open')
  expect(unread()).toBe('false')
  expect(trigger().querySelector('.composer-mailbox__unread')).toBeNull()
  expect(trigger().querySelector('.composer-mailbox__attention')).toBeNull()
  expect(trigger().title).toBe('Mailbox: A2A Inbox 0 unread in loaded messages, User Messages 0 pending, Notices 0 need attention. Continuous progress: inactive (not enabled)')
  expect(trigger().getAttribute('aria-label')).toBe(trigger().title)
  expect(mailbox().querySelectorAll('.composer-notice')).toHaveLength(1)
  expect(mailbox().textContent).toContain('screen confirmation')
  expect(useAppStore.getState().sessions[0]).toMatchObject({ terminalPromptDelivery: session().terminalPromptDelivery })
  const persisted = JSON.parse(JSON.stringify(useAppStore.persist.getOptions().partialize!(useAppStore.getState())))
  expect(persisted.noticeReadReceipts['agent-1'].delivery).toBeTruthy()
  await dom.render(null)
  await act(async () => useAppStore.setState({ noticeReadReceipts: persisted.noticeReadReceipts }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(unread()).toBe('false')
  await toggle('open'); await folder('system')
  expect(mailbox().textContent).toContain('screen confirmation')
})

it('prioritizes unread on opening but never switches an open User Messages for new notices', async () => {
  useAppStore.setState({ sessions: [composerSession()], agentSteerQueues: { 'agent-1': [
    { operationId: 'q', runId: 'run-agent-1', text: 'pending', status: 'queued' }
  ] } })
  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue('submitted')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  expect(mailbox().querySelector('[role="tab"][aria-selected="true"]')?.id).toMatch(/-user-tab$/)
  await act(async () => useAppStore.setState({ sessions: [session()] }))
  expect(unread()).toBe('true')
  expect(mailbox().querySelector('[role="tab"][aria-selected="true"]')?.id).toMatch(/-user-tab$/)
  await toggle('closed')
  await toggle('open')
  expect(mailbox().querySelector('[role="tab"][aria-selected="true"]')?.id).toMatch(/-system-tab$/)
  expect(unread()).toBe('false')
  expect(send).not.toHaveBeenCalled()
})

it('coalesces repetitions but marks changed causes and a recurrence after recovery as unread', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  await toggle('closed')
  const repeated = session()
  repeated.terminalPromptDelivery.submissionId = 'submission-2'
  repeated.terminalPromptDelivery.observedAt = _tailFixtureEpoch(0, 0, 2)
  await act(async () => useAppStore.setState({ sessions: [repeated] }))
  expect(unread()).toBe('false')
  await act(async () => useAppStore.setState({ sessions: [{ ...repeated,
    terminalPromptDelivery: { ...repeated.terminalPromptDelivery, reason: 'prompt-render-timeout' } }] }))
  expect(unread()).toBe('true')
  await toggle('open')
  await toggle('closed')
  await act(async () => useAppStore.setState({ sessions: [composerSession()] }))
  await toggle('open'); await folder('system')
  expect(mailbox().textContent).toContain('No current notices')
  await toggle('closed')
  expect(useAppStore.getState().noticeReadReceipts['agent-1']).toBeUndefined()
  await act(async () => useAppStore.setState({ sessions: [session()] }))
  expect(unread()).toBe('true')
})

it('remains accessible in every mode with input disabled and scopes read receipts by Session', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" disabled />)
  for (const mode of ['collapsed', 'current', 'expanded']) {
    expect(dom.container.querySelector('.composer-tools')?.getAttribute('data-mode')).toBe(mode)
    expect(trigger().disabled).toBe(false)
    expect(dom.container.querySelectorAll('.composer__mailbox')).toHaveLength(1)
    await dom.click('.composer-tool--mode')
  }
  await toggle('open')
  await act(async () => useAppStore.setState({ sessions: [session(), { ...session(), id: 'other' }] }))
  await dom.render(<AgentSessionComposer key="other" sessionId="other" />)
  expect(unread()).toBe('true')
  expect(useAppStore.getState().noticeReadReceipts['agent-1']?.delivery).toBeTruthy()
})

it('shows ordered User Messages and wires retry, exact Copy and archive without sending on read', async () => {
  const queued = [{ operationId: 'queued-1', runId: 'run-agent-1', text: 'First exact words',
    status: 'deferred' as const, error: 'Input confirmation pending. Diagnostic: private-cursor=123' },
  { operationId: 'queued-2', runId: 'run-agent-1', text: 'Second exact words', status: 'queued' as const }]
  useAppStore.setState({ agentSteerQueues: { 'agent-1': queued } })
  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue('submitted')
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  vi.spyOn(useAppStore.getState(), 'flushAgentSteerQueue').mockResolvedValue()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  expect(unread()).toBe('false')
  expect(send).not.toHaveBeenCalled()
  expect(mailbox().querySelectorAll('.composer-notice')).toHaveLength(2)
  expect(mailbox().textContent).not.toContain('private-cursor')
  await dom.click('[data-record-key^="notice:queue:"]') // Read the queue notice.
  await dom.click('.composer-notice__body button') // View User Messages
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('First exact words')
  expect([...mailbox().querySelectorAll('.composer-outbox .composer-mailbox__preview')].map((item) => item.textContent))
    .toEqual(['First exact words', 'Second exact words'])
  const action = async (text: string) => {
    const button = [...mailbox().querySelectorAll<HTMLButtonElement>('.composer-outbox button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === text)
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  await action('Send queued message')
  expect(send).toHaveBeenCalledExactlyOnceWith('agent-1', 'queued-1')
  const copies = [...mailbox().querySelectorAll<HTMLButtonElement>('.composer-outbox__actions [aria-label="复制这条待发消息"]')]
  expect(copies).toHaveLength(2)
  for (const button of copies) await act(async () => button.click())
  expect(copy.mock.calls).toEqual([['First exact words'], ['Second exact words']])
  await readRecord('queue:queued-1'); await action('归档这条待发消息')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([{ ...queued[0], archived: true }, queued[1]])
  expect(mailbox().querySelector('li[data-operation-id="queued-1"] [aria-label="恢复为待发"]')).not.toBeNull()
  await folder('system'); expect(mailbox().querySelectorAll('.composer-notice')).toHaveLength(1)
  expect(trigger().textContent).toBe('')
    expect(mailbox().querySelector('[id$="-user-tab"] .composer-mailbox__count')!.textContent).toBe('1')
})

it.each(['queued', 'restoring'] as const)('shows exact nonempty %s, deferred, failed and old-Run facts without executing on read', async (status) => {
  const queued: AgentSteerQueueEntry[] = [
    { operationId: 'in-flight', runId: 'run-agent-1', text: 'Exact active request', status },
    { operationId: 'deferred', runId: 'run-agent-1', text: 'Exact deferred request', status: 'deferred',
      error: 'Provider is not ready. Diagnostic: private-helper=91' },
    { operationId: 'failed', runId: 'run-agent-1', text: 'Exact failed request', status: 'failed',
      error: 'Input was refused. Diagnostic: private-failure=92' },
    { operationId: 'old', runId: 'old-run', text: 'Exact old Run request', status: 'queued' }
  ]
  useAppStore.setState({ sessions: [composerSession()], agentSteerQueues: { 'agent-1': queued },
    agentSteerInFlight: { 'agent-1': 'in-flight' } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  const recover = vi.spyOn(api.sessions, 'recover')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  await folder('user')
  const rows = [...mailbox().querySelectorAll<HTMLLIElement>('.composer-outbox li')]
  expect(rows.map(row => row.querySelector('.composer-mailbox__preview')?.textContent)).toEqual([
    'Exact active request', 'Exact deferred request', 'Exact failed request', 'Exact old Run request'
  ])
  expect(rows.map(row => row.dataset.state)).toEqual([status, 'deferred', 'failed', 'queued'])
  const explanations = ['正在准备本次发送',
    'Provider is not ready.', 'Input was refused.', '绑定的 Run 不可用或已改变']
  for (let index = 0; index < queued.length; index++) {
    await readRecord(`queue:${queued[index]!.operationId}`)
    await dom.click('[aria-label="Message details"]')
    const detail = mailbox().querySelector<HTMLElement>(`li[data-operation-id="${queued[index]!.operationId}"]`)!
    expect(detail.textContent).toContain(explanations[index])
    if (queued[index]!.error) {
      const failure = detail.querySelector<HTMLElement>('.message-delivery-failure')!
      expect(failure.querySelector('.message-delivery-failure__heading')!.textContent).not.toMatch(/private-helper|private-failure/)
      expect(failure.querySelector<HTMLDetailsElement>('.message-delivery-failure__details')!.open).toBe(false)
      expect(failure.querySelector('.message-delivery-failure__details')!.textContent).toContain(queued[index]!.error)
    }
    if (index === 0) {
      const controls = ['Move up', 'Move down', '归档这条待发消息', 'Send queued message']
      for (const label of controls) {
        const button = detail.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
        expect(button, label).not.toBeNull(); expect(button.disabled, label).toBe(true)
      }
    }
    expect(mailbox().querySelectorAll('.composer-outbox > ol > li')).toHaveLength(4)
    expect(mailbox().querySelector('.composer-mailbox__back')).toBeNull()
  }
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual(queued)
  expect(submit).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
})

it('explicit mailbox Send retries the real Store with the same exact operation and Run while keeping old work paused', async () => {
  const pending: AgentSteerQueueEntry = { operationId: 'restored-intent', runId: 'run-agent-1',
    promptCondition: { expectedRun: composerSession().control.run, afterSubmissionId: null },
    text: 'Keep the exact restored request', status: 'deferred', errorCode: 'AGENT_EXECUTION_NOT_REQUESTED',
    error: 'Queued before restart. Choose Send to execute this message.' }
  const old: AgentSteerQueueEntry = { operationId: 'old-intent', runId: 'old-run',
    text: 'Keep the unavailable old request', status: 'queued' }
  useAppStore.setState({ sessions: [composerSession()], agentSteerQueues: { 'agent-1': [pending, old] } })
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
    .mockRejectedValueOnce(new Error('Provider is still preparing. Diagnostic: private-helper=93'))
    .mockResolvedValueOnce()
  const recover = vi.spyOn(api.sessions, 'recover')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  await folder('user')
  expect([...mailbox().querySelectorAll('.composer-outbox .composer-mailbox__preview')].map(row => row.textContent))
    .toEqual([pending.text, old.text])
  expect(submit).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
  const clickSend = async () => {
    const send = [...mailbox().querySelectorAll<HTMLButtonElement>('.composer-outbox button')]
      .find(button => button.getAttribute('aria-label') === 'Send queued message')
    expect(send).toBeDefined()
    await act(async () => send!.click())
  }
  await clickSend()
  expect(submit.mock.calls.map(call => [call[0], call[1], call[2]])).toEqual([
    [composerSession().control, pending.text, pending.operationId]
  ])
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([
    { operationId: pending.operationId, runId: pending.runId, promptCondition: pending.promptCondition, text: pending.text, status: 'deferred',
      awaitingExplicitSend: true, logId: expect.any(String), error: 'Provider is still preparing. Diagnostic: private-helper=93' }, old
  ])
  await readRecord('queue:restored-intent')
  await dom.click('[aria-label="Message details"]')
  expect(mailbox().querySelector('.composer-outbox')?.textContent).toContain('Provider is still preparing.')
  expect(mailbox().querySelector('.composer-mailbox__back')).toBeNull()
  expect([...mailbox().querySelectorAll('.composer-mailbox__preview, .message-delivery-failure__heading')].map(element => element.textContent).join(' ')).not.toContain('private-helper')
  await clickSend()
  expect(submit.mock.calls.map(call => [call[0], call[1], call[2]])).toEqual([
    [composerSession().control, pending.text, pending.operationId],
    [composerSession().control, pending.text, pending.operationId]
  ])
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([old])
  expect([...mailbox().querySelectorAll('.composer-outbox .composer-mailbox__preview')].map(row => row.textContent)).toEqual([old.text])
  expect(useAppStore.getState().agentSteerQueues['agent-1']![0]).toEqual(old)
  expect(submit).toHaveBeenCalledTimes(2) // Reading retained old work never submits it or changes its Run.
  expect(recover).not.toHaveBeenCalled()
})

it('does not confuse a healthy pending count with unread notices and supports keyboard folder switching', async () => {
  useAppStore.setState({ sessions: [composerSession()], agentSteerQueues: { 'agent-1': [
    { operationId: 'q1', runId: 'run-agent-1', text: 'Pending', status: 'queued' }
  ] } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(unread()).toBe('false')
  expect(trigger().textContent).toBe('')
    expect(mailbox().querySelector('[id$="-user-tab"] .composer-mailbox__count')!.textContent).toBe('1')
  await toggle('open')
  expect(mailbox().querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label')).toBe('User Messages: 1 pending')
  await act(async () => mailbox().querySelector('[role="tab"][aria-selected="true"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  expect(document.activeElement?.getAttribute('aria-label')).toBe('A2A Inbox: 0 unread in loaded messages')
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('No A2A messages received')
})

it('retains receipts through empty startup snapshots but alerts for a new Run', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  const receipt = useAppStore.getState().noticeReadReceipts['agent-1']
  await dom.render(null)
  await act(async () => useAppStore.setState({ sessions: [] }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open'); await folder('system')
  expect(mailbox().textContent).toContain('Waiting for Session status')
  expect(useAppStore.getState().noticeReadReceipts['agent-1']).toEqual(receipt)
  await act(async () => useAppStore.setState({ sessions: [session()] }))
  expect(unread()).toBe('false')
  await toggle('closed') // Observe the next Run without acknowledging an open System folder.
  const resumed = session()
  resumed.control = { ...resumed.control, run: { runId: 'new-run' } }
  resumed.terminalPromptDelivery.run = { runId: 'new-run' }
  await act(async () => useAppStore.setState({ sessions: [resumed] }))
  expect(unread()).toBe('true')
})

it.each(['copy', 'retry'] as const)('keeps a User Messages %s failure in this mailbox and clears it on success', async (kind) => {
  const queued = { operationId: 'q-local', runId: 'run-agent-1', text: 'Keep this pending message', status: 'queued' as const }
  useAppStore.setState({ sessions: [composerSession()], agentSteerQueues: { 'agent-1': [queued] } })
  const action = kind === 'copy'
    ? vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('Clipboard unavailable')).mockResolvedValueOnce()
    : vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockRejectedValueOnce(new Error('Retry unavailable')).mockResolvedValueOnce('submitted')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  const clickAction = async () => {
    const label = kind === 'copy' ? '复制这条待发消息' : 'Send queued message'
    const button = [...mailbox().querySelectorAll<HTMLButtonElement>('.composer-outbox button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label)
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  await clickAction()
  expect(unread()).toBe('true')
  await folder('system'); await dom.click('.composer-notice .composer-mailbox__row')
  expect(mailbox().querySelector('.composer-notice')?.textContent).toContain('unavailable')
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([queued])
  await folder('user'); await clickAction()
  await folder('system')
  expect(action).toHaveBeenCalledTimes(2)
  expect(mailbox().querySelectorAll('.composer-notice')).toHaveLength(0)
  expect(unread()).toBe('false')
})

function delivered(id: string, authorAgentSessionId?: string) {
  return { id: `prompt:${id}`, agentSessionId: 'agent-1', kind: 'user_message' as const,
    status: 'complete' as const, source: 'user' as const, title: 'Prompt', content: `Body ${id}`, createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 100),
    ...(authorAgentSessionId ? { authorAgentSessionId } : {}) }
}
it('separates actual incoming Agent messages, sent user history and system facts; reading survives restart', async () => {
  journal.set([journalMessage({ id: 'in', sender: 'reviewer', body: 'Body in' })])
  const items = [delivered('in', 'reviewer'), delivered('sent')]
  useAppStore.setState({ timelines: { 'agent-1': { agentSessionId: 'agent-1', revision: 2, items } },
    agentSteerQueues: { 'agent-1': [{ operationId: 'sent', runId: 'run-agent-1', text: 'Body sent', status: 'queued' }] } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect([...mailbox().querySelectorAll('[role="tab"]')].map((el) => el.getAttribute('aria-label'))).toEqual(['A2A Inbox: 1 unread in loaded messages', 'A2A Outbox', 'User Messages: 0 pending', 'Notices: 1 unread', 'Supervised collaboration', 'Continuous progress: inactive (not enabled)'])
  expect(trigger().querySelector(':scope > span:not([class])')).toBeNull() // Durable sent item is never shown as pending again; unread is separate.
  await toggle('open')
  expect(mailbox().querySelector('[aria-selected="true"]')?.textContent).toBe('A2A Inbox')
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Body in')
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).not.toContain('screen confirmation')
  expect(unread()).toBe('true') // System was not read by opening Inbox.
  await folder('system')
  expect(unread()).toBe('false')
  const persisted = JSON.parse(JSON.stringify(useAppStore.persist.getOptions().partialize!(useAppStore.getState())))
  expect(persisted.noticeReadReceipts['mail:agent-1'][JSON.stringify(['local','in'])]).toBeTruthy()
  expect(persisted.noticeReadReceipts['agent-1'].delivery).toBeTruthy()
  await dom.render(null)
  await act(async () => useAppStore.setState({ noticeReadReceipts: persisted.noticeReadReceipts }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(unread()).toBe('false')
  await toggle('open')
  expect(mailbox().querySelector('[aria-selected="true"]')?.getAttribute('aria-label')).toBe('User Messages: 0 pending')
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Body sent')
  expect(useAppStore.getState().timelines['agent-1']?.items).toEqual(items)
})
it('does not switch folders or consume new incoming messages while reading User Messages', async () => {
  useAppStore.setState({ sessions: [composerSession()], timelines: { 'agent-1': {
    agentSessionId: 'agent-1', revision: 1, items: [delivered('sent')] } } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  const arrival = journalMessage({ id: 'new', sender: 'other', body: 'Body new', sequence: 2 })
  journal.set([arrival]); await journal.changed(arrival)
  expect(mailbox().querySelector('[aria-selected="true"]')?.getAttribute('aria-label')).toBe('User Messages: 0 pending')
  await vi.waitFor(() => expect(unread()).toBe('true'))
  await toggle('closed')
  await toggle('open')
  expect(mailbox().querySelector('[aria-selected="true"]')?.textContent).toBe('A2A Inbox')
  expect(unread()).toBe('false')
  const receipt = useAppStore.getState().noticeReadReceipts['mail:agent-1']
  await dom.render(null)
  await act(async () => useAppStore.setState({ timelines: {} }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(useAppStore.getState().noticeReadReceipts['mail:agent-1']).toEqual(receipt)
})

it('keeps unconfirmed initial input visible and copyable without calling it Sent', async () => {
  useAppStore.setState({ sessions: [composerSession()], timelines: { 'agent-1': {
    agentSessionId: 'agent-1', revision: 1, items: [{ ...delivered('initial'), status: 'failed' }] } } })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  const visible = mailbox().querySelector('[role="tabpanel"]:not([hidden])')!
  expect(visible.textContent).toContain('Body initial')
  expect(visible.textContent).toContain('Delivery not confirmed')
  expect(visible.querySelector('.composer-mailbox__messages strong')?.textContent).not.toBe('Sent')
  await dom.click('.composer-mailbox__messages button')
  await dom.click('.composer-mailbox__detail .log-turn__action')
  expect(copy).toHaveBeenCalledExactlyOnceWith('Body initial')
})

it('projects loop status without adding unread or pending mail, switching pages, or treating a pending list as inactive', async () => {
  let resolveList!: (loops: ContinuousProgressLoop[]) => void
  let changed!: (loop: ContinuousProgressLoop) => void
  vi.spyOn(api.continuousProgress, 'list').mockImplementation(() => new Promise(resolve => { resolveList = resolve }))
  const dispose = vi.fn()
  vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(listener => { changed = listener; return dispose })
  useAppStore.setState({ sessions: [composerSession()], agentSteerQueues: { 'agent-1': [
    { operationId: 'manual', runId: 'run-agent-1', text: 'Manual pending', status: 'queued' }
  ] } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(trigger().getAttribute('data-progress-state')).toBe('unconfirmed')
  expect(trigger().getAttribute('aria-label')).toContain('0 unread')
  expect(trigger().getAttribute('aria-label')).toContain('User Messages 1 pending')
  await act(async () => resolveList([]))
  expect(trigger().getAttribute('data-progress-state')).toBe('inactive')
  expect(trigger().title).toContain('Continuous progress: inactive (not enabled)')
  expect(trigger().getAttribute('aria-label')).toBe(trigger().title)
  await toggle('open')
  expect(mailbox().querySelector('[aria-selected="true"]')?.getAttribute('aria-label')).toBe('User Messages: 1 pending')
  for (const loop of [progressLoop(), progressLoop('paused'), { ...progressLoop('paused'), lastOutcome: 'unknown' as const }]) {
    await act(async () => changed(loop))
    expect(mailbox().querySelector('[aria-selected="true"]')?.getAttribute('aria-label')).toBe('User Messages: 1 pending')
    expect(trigger().getAttribute('data-progress-state')).toBe(loop.lastOutcome === 'unknown' ? 'unconfirmed' : loop.status)
    expect(unread()).toBe('false')
    expect(trigger().textContent).toBe('')
    expect(mailbox().querySelector('[id$="-user-tab"] .composer-mailbox__count')!.textContent).toBe('1')
  }
  await folder('progress')
  await act(async () => changed({ ...progressLoop(), workspacePath: _hygiene_fixturePath("unrelated") }))
  expect(trigger().getAttribute('data-progress-state')).toBe('unconfirmed')
  expect(mailbox().querySelector('[aria-selected="true"]')?.textContent).toBe('Progress')
  await dom.render(null)
  expect(dispose).toHaveBeenCalledTimes(1)
})

it('retains every progress field and unconfirmed composition through page, close and Composer mode changes with one observer', async () => {
  const list = vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  const observe = vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(() => vi.fn())
  const create = vi.spyOn(api.continuousProgress, 'create')
  const action = vi.spyOn(api.continuousProgress, 'action')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const mainDrafts = structuredClone(useAppStore.getState().agentComposerDrafts)
  const mainQueues = structuredClone(useAppStore.getState().agentSteerQueues)
  await toggle('open'); await folder('progress')
  const form = mailbox().querySelector<HTMLFormElement>('.continuous-progress-control form')!
  expect(form).not.toBeNull()
  await act(async () => form.querySelector<HTMLInputElement>('[type="checkbox"]')!.click())
  const fields = [form.querySelector<HTMLInputElement>('[type="number"]')!,
    ...['Tracker root', 'Feature ID', 'Public Tracker script'].map(label => form.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!)]
  expect(fields).toHaveLength(4)
  const values = ['17', _hygiene_fixturePath("tracker"), 'f-private', _hygiene_fixturePath("reader.sh")]
  await act(async () => fields.forEach((field, index) => {
    expect(field).not.toBeNull()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, values[index])
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }))
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '未确认续行候选')
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '未确认续行候选' }))
  })
  await folder('inbox'); await toggle('closed'); await toggle('open'); await folder('progress')
  for (let index = 0; index < 3; index++) await dom.click('.composer-tool--mode')
  expect(mailbox().querySelector('.continuous-progress-control form')).toBe(form)
  expect(form.querySelector('textarea')).toBe(textarea)
  expect(textarea.value).toBe('未确认续行候选')
  expect(fields.map(field => field.value)).toEqual(values)
  expect(form.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(true)
  expect(list).toHaveBeenCalledTimes(1)
  expect(observe).toHaveBeenCalledTimes(1)
  expect(create).not.toHaveBeenCalled()
  expect(action).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts).toEqual(mainDrafts)
  expect(useAppStore.getState().agentSteerQueues).toEqual(mainQueues)
})
