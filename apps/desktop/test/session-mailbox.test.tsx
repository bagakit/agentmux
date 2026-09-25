// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AgentSessionUserMessage, ContinuousProgressLoop } from '@agentmux/core'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'

const dom = composerDOM()
let disposeBootstrap: (() => void) | undefined
beforeAll(async () => { disposeBootstrap = await useAppStore.getState().initialize() })
afterAll(() => disposeBootstrap?.())
afterEach(() => vi.useRealTimers())
const session = () => ({ ...composerSession(), terminalPromptDelivery: {
  state: 'unverified' as const, mode: 'degraded' as const, reason: 'screen-evidence-gap' as const,
  submissionId: 'submission-1', run: { runId: 'run-agent-1' }, observedAt: 1
} })
beforeEach(() => useAppStore.setState({ sessions: [session()], noticeReadReceipts: {},
  timelines: { 'agent-1': { agentSessionId: 'agent-1', revision: 0, items: [] } } }))
const trigger = () => dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
const mailbox = () => dom.container.querySelector<HTMLDivElement>('.composer-mailbox')!
const unread = () => trigger().getAttribute('data-unread')
const progressLoop = (status: 'active' | 'paused' = 'active'): ContinuousProgressLoop => ({
  loopId: 'mailbox-loop', hostId: 'local', agentSessionId: 'agent-1', providerId: 'codex', workspacePath: '/repo',
  intervalMs: 60_000, prompt: 'Continue', nextCheckAt: 60_000, status
})
/**
 * 打开之前先把指纹等出来。
 *
 * `useMessageFingerprints` 走异步的 `crypto.subtle.digest`，而**打开时落在哪个文件夹**正是由它
 * 决定的：`openFolder()` 读 `receipts.unread.length`，指纹没算完时它是空的，于是本该停在 Inbox 的
 * 一次打开落到了 System。并行满载下这个微任务经常输、单跑则赢——看着像 flake，其实每一次
 * `toggle('open')` 都在赌同一场竞争。
 *
 * 上一轮我只给其中一条断言补了 `vi.waitFor`，那是打地鼠：这个文件有 15 处 `toggle('open')`。
 * 等待放进 toggle 自己，一次覆盖全部。等的是 digest 自己那些 promise（兄弟文件
 * `session-mailbox-receipts.test.tsx` 用的也是这个），不是数几个微任务——数微任务是赌实现细节。
 *
 * 装在 `beforeEach` 而不是模块顶层：`composerDOM()` 的 `afterEach` 会 `vi.restoreAllMocks()`，
 * 顶层那一枚从第二条用例起就被卸掉了。实测过——16 个打开点上 `digest.mock.calls.length` 全是 0，
 * 于是 `Promise.all([])` 立刻 resolve，这个等待**看着在等，其实一步没等**。
 */
let digest: { mock: { results: { value: unknown }[] } }
beforeEach(() => { digest = vi.spyOn(crypto.subtle, 'digest') })
async function settleFingerprints() {
  await act(async () => { await Promise.all(digest.mock.results.map((result) => result.value)) })
}
// happy-dom has no native popover toggle. Dispatch the browser's state event, not React internals.
async function toggle(state: 'open' | 'closed') {
  if (state === 'open') await settleFingerprints()
  const event = new Event('toggle')
  Object.defineProperty(event, 'newState', { value: state })
  await act(async () => mailbox().dispatchEvent(event))
}
async function folder(name: 'inbox' | 'outbox' | 'system' | 'progress') {
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
  const form = mailbox().querySelector('.continuous-progress-control form')!
  const methods = popoverMethods()
  vi.useFakeTimers()
  await pointer(trigger(), 'pointerover')
  if (surface === 'entry') {
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => trigger().dispatchEvent(click))
    expect(click.defaultPrevented).toBe(true)
  } else {
    await pointer(mailbox().querySelector('[id$="-progress-tab"]')!, 'pointerdown')
    await folder('progress')
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
  const native = (id: string, recordedAt?: number): AgentSessionUserMessage => ({ id, rawId: id, agentSessionId: 'agent-1',
    source: { kind: 'native', providerId: 'codex', nativeSessionId: 'native-session', recordId: id },
    author: { kind: 'unknown' }, content: id, contentParts: [{ kind: 'text', text: id }],
    ...(recordedAt === undefined ? {} : { recordedAt }) })
  const items = [{ ...delivered('old'), createdAt: 10 }, { ...delivered('tie-a'), createdAt: 30 },
    { ...delivered('tie-b'), createdAt: 30 }, { ...delivered('in-old', 'peer'), createdAt: 10 },
    { ...delivered('in-new', 'peer'), createdAt: 50 }]
  let userMessages = [native('missing-a'), native('native-new', 40), native('native-tie', 30), native('missing-b')]
  const queued = [{ id: 'q-a', text: 'First intention', status: 'queued' as const, enqueuedAt: 999 },
    { id: 'q-b', text: 'Second intention', status: 'queued' as const, enqueuedAt: 1 }]
  const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
  const render = () => dom.render(<SessionMailbox system={system} queued={queued}
    timeline={{ agentSessionId: 'agent-1', revision: 1, items }} userMessages={userMessages} />)
  await render()
  const contents = (name: string) => [...mailbox().querySelectorAll(`[id$="-${name}"] .composer-mailbox__messages li > p`)].map(el => el.textContent)
  expect(contents('outbox')).toEqual(['native-new', 'Body tie-a', 'Body tie-b', 'native-tie', 'Body old', 'missing-a', 'missing-b'])
  expect(contents('inbox')).toEqual(['Body in-new', 'Body in-old'])
  expect([...mailbox().querySelectorAll('.composer-outbox li > span:first-child')].map(el => el.textContent)).toEqual(['First intention', 'Second intention'])
  expect(items.map(item => item.content)).toEqual(['Body old', 'Body tie-a', 'Body tie-b', 'Body in-old', 'Body in-new'])
  userMessages = [...userMessages, native('loaded-earlier', 5)]
  await render()
  expect(contents('outbox')).toEqual(['native-new', 'Body tie-a', 'Body tie-b', 'native-tie', 'Body old', 'loaded-earlier', 'missing-a', 'missing-b'])
})

it('uses the selected System owner time, keeps unknown times last, and never makes a time-only update unread', async () => {
  const current = session()
  current.terminalPromptDelivery.observedAt = 30
  current.terminalCapability = { state: 'unknown', mode: 'degraded', reason: 'handshake-timeout', run: current.control.run, observedAt: 20 }
  current.terminalOutputChannel = { state: 'severed', mode: 'degraded', reason: 'reattach-failed', run: current.control.run, observedAt: 1000 }
  current.status = { ...current.status, state: 'disconnected', observedAt: 2000 }
  const queue: AgentSteerQueueEntry[] = [{ operationId: 'unknown-time', text: 'Kept', runId: 'run-agent-1', status: 'failed', enqueuedAt: 9000 }]
  expect(sessionServiceNotices(current, queue).map(item => [item.id, item.observedAt])).toEqual([
    ['connection', 20], ['delivery', 30], ['queue', undefined]])
  await act(async () => useAppStore.setState({ sessions: [current], agentSteerQueues: { 'agent-1': queue } }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const steps = () => [...mailbox().querySelectorAll('.composer-notice .service-window__step')].map(el => el.textContent)
  expect(steps()).toEqual(['Screen confirmation from retained terminal output didn’t complete', 'Checking terminal capabilities didn’t complete', 'A queued message has not been sent'])
  expect([...mailbox().querySelectorAll('.composer-notice__body time')].map(el => el.getAttribute('datetime'))).toEqual([
    new Date(30).toISOString(), new Date(20).toISOString()])
  expect(mailbox().querySelectorAll('.composer-notice__body small')).toHaveLength(1)
  expect(mailbox().querySelector('.composer-notice__body small')!.textContent).toBe('Time not recorded.')
  await toggle('open'); await toggle('closed')
  await act(async () => useAppStore.setState({ sessions: [{ ...current,
    terminalCapability: { ...current.terminalCapability!, observedAt: 40 } }] }))
  expect(unread()).toBe('false')
  expect(steps()).toEqual(['Checking terminal capabilities didn’t complete', 'Screen confirmation from retained terminal output didn’t complete', 'A queued message has not been sent'])
  const output = { ...current, terminalCapability: undefined }
  expect(sessionServiceNotices(output).map(item => [item.id, item.observedAt])).toEqual([['connection', 1000], ['delivery', 30]])
  expect(sessionServiceNotices({ ...output, terminalOutputChannel: undefined }).map(item => [item.id, item.observedAt])).toEqual([['connection', 2000], ['delivery', 30]])
})

it('uses one right Session mailbox, opens incoming notices to clear the red dot, and keeps the Core fact', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(dom.container.querySelectorAll('.composer__mailbox')).toHaveLength(1)
  expect(dom.container.querySelector('.composer__toolbar > div:first-child')?.contains(trigger())).toBe(false)
  expect(dom.container.querySelector('.composer__toolbar > div:last-child')?.contains(trigger())).toBe(true)
  expect(dom.container.querySelectorAll('.composer__notices, .composer__queued')).toHaveLength(0)
  expect(unread()).toBe('true')
  expect(trigger().querySelector('.composer-mailbox__dot')).not.toBeNull()
  expect(document.getElementById(trigger().getAttribute('popovertarget')!)).toBe(mailbox())
  await toggle('open')
  expect(unread()).toBe('false')
  expect(trigger().querySelector('.composer-mailbox__dot')).toBeNull()
  expect(mailbox().querySelectorAll('.composer-notice')).toHaveLength(1)
  expect(mailbox().textContent).toContain('screen confirmation')
  expect(useAppStore.getState().sessions[0]).toMatchObject({ terminalPromptDelivery: session().terminalPromptDelivery })
  const persisted = JSON.parse(JSON.stringify(useAppStore.persist.getOptions().partialize!(useAppStore.getState())))
  expect(persisted.noticeReadReceipts['agent-1'].delivery).toBeTruthy()
  await dom.render(null)
  await act(async () => useAppStore.setState({ noticeReadReceipts: persisted.noticeReadReceipts }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(unread()).toBe('false')
  expect(mailbox().textContent).toContain('screen confirmation')
})

it('prioritizes unread on opening but never switches an open outbox for new notices', async () => {
  useAppStore.setState({ sessions: [composerSession()], agentSteerQueues: { 'agent-1': [
    { operationId: 'q', runId: 'run-agent-1', text: 'pending', status: 'queued' }
  ] } })
  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  expect(mailbox().querySelector('[role="tab"][aria-selected="true"]')?.id).toMatch(/-outbox-tab$/)
  await act(async () => useAppStore.setState({ sessions: [session()] }))
  expect(unread()).toBe('true')
  expect(mailbox().querySelector('[role="tab"][aria-selected="true"]')?.id).toMatch(/-outbox-tab$/)
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
  repeated.terminalPromptDelivery.observedAt = 2
  await act(async () => useAppStore.setState({ sessions: [repeated] }))
  expect(unread()).toBe('false')
  await act(async () => useAppStore.setState({ sessions: [{ ...repeated,
    terminalPromptDelivery: { ...repeated.terminalPromptDelivery, reason: 'prompt-render-timeout' } }] }))
  expect(unread()).toBe('true')
  await toggle('open')
  await toggle('closed')
  await act(async () => useAppStore.setState({ sessions: [composerSession()] }))
  expect(mailbox().textContent).toContain('No current notices.')
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

it('shows ordered outgoing messages and wires retry, copy and removal without sending on read', async () => {
  const queued = [{ operationId: 'queued-1', runId: 'run-agent-1', text: 'First exact words',
    status: 'deferred' as const, error: 'Input confirmation pending. Diagnostic: private-cursor=123' },
  { operationId: 'queued-2', runId: 'run-agent-1', text: 'Second exact words', status: 'queued' as const }]
  useAppStore.setState({ agentSteerQueues: { 'agent-1': queued } })
  const send = vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockResolvedValue()
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  vi.spyOn(useAppStore.getState(), 'flushAgentSteerQueue').mockResolvedValue()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  expect(unread()).toBe('false')
  expect(send).not.toHaveBeenCalled()
  expect(mailbox().querySelectorAll('.composer-notice')).toHaveLength(2)
  expect(mailbox().textContent).not.toContain('private-cursor')
  await dom.click('.composer-notice__body button') // View outbox
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('First exact words')
  expect([...mailbox().querySelectorAll('.composer-outbox li > span:first-child')].map((item) => item.textContent))
    .toEqual(['First exact words', 'Second exact words'])
  const action = async (text: string) => {
    const button = [...mailbox().querySelectorAll<HTMLButtonElement>('.composer-outbox button')].find((item) => item.textContent?.trim() === text)
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  await action('Send queued message')
  expect(send).toHaveBeenCalledExactlyOnceWith('agent-1', 'queued-1')
  await action('Copy all')
  expect(copy).toHaveBeenCalledExactlyOnceWith('First exact words\n\nSecond exact words')
  await action('Remove')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([queued[1]])
  expect(mailbox().querySelectorAll('.composer-notice')).toHaveLength(1)
  expect(trigger().textContent).toBe('1')
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
  await folder('outbox')
  const rows = [...mailbox().querySelectorAll<HTMLLIElement>('.composer-outbox li')]
  expect(rows.map(row => row.querySelector('span:first-child')?.textContent)).toEqual([
    'Exact active request', 'Exact deferred request', 'Exact failed request', 'Exact old Run request'
  ])
  expect(rows.map(row => row.dataset.state)).toEqual([status, 'deferred', 'failed', 'queued'])
  expect(rows[0]!.textContent).toContain(status === 'restoring'
    ? 'Restoring the Agent. This message has not been dispatched.' : 'Sending. Waiting for delivery confirmation.')
  expect(rows[1]!.textContent).toContain('Provider is not ready.')
  expect(rows[2]!.textContent).toContain('Input was refused.')
  expect(rows[3]!.textContent).toContain('Its delivery result is unknown; it will not be replayed on another Run.')
  expect(mailbox().textContent).not.toContain('private-helper')
  expect(mailbox().textContent).not.toContain('private-failure')
  expect(rows[0]!.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
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
  await folder('outbox')
  expect([...mailbox().querySelectorAll('.composer-outbox li > span:first-child')].map(row => row.textContent))
    .toEqual([pending.text, old.text])
  expect(submit).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
  const clickSend = async () => {
    const send = [...mailbox().querySelectorAll<HTMLButtonElement>('.composer-outbox > button')]
      .find(button => button.textContent?.trim() === 'Send queued message')
    expect(send).toBeDefined()
    await act(async () => send!.click())
  }
  await clickSend()
  expect(submit.mock.calls.map(call => [call[0], call[1], call[2]])).toEqual([
    [composerSession().control, pending.text, pending.operationId]
  ])
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([
    { operationId: pending.operationId, runId: pending.runId, promptCondition: pending.promptCondition, text: pending.text, status: 'deferred',
      error: 'Provider is still preparing. Diagnostic: private-helper=93' }, old
  ])
  expect(mailbox().querySelector('.composer-outbox li')?.textContent).toContain('Provider is still preparing.')
  expect(mailbox().textContent).not.toContain('private-helper')
  await clickSend()
  expect(submit.mock.calls.map(call => [call[0], call[1], call[2]])).toEqual([
    [composerSession().control, pending.text, pending.operationId],
    [composerSession().control, pending.text, pending.operationId]
  ])
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([old])
  expect([...mailbox().querySelectorAll('.composer-outbox li > span:first-child')].map(row => row.textContent)).toEqual([old.text])
  expect(mailbox().querySelectorAll('.composer-outbox > button')).toHaveLength(1) // Copy only; no Send to another Run.
  expect(recover).not.toHaveBeenCalled()
})

it('does not confuse a healthy pending count with unread notices and supports keyboard folder switching', async () => {
  useAppStore.setState({ sessions: [composerSession()], agentSteerQueues: { 'agent-1': [
    { operationId: 'q1', runId: 'run-agent-1', text: 'Pending', status: 'queued' }
  ] } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(unread()).toBe('false')
  expect(trigger().textContent).toBe('1')
  await toggle('open')
  expect(mailbox().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Outbox (1)')
  await act(async () => mailbox().querySelector('[role="tab"][aria-selected="true"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  expect(document.activeElement?.textContent).toBe('Inbox (0)')
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toBe('No Agent messages.')
})

it('retains receipts through empty startup snapshots but alerts for a new Run', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  const receipt = useAppStore.getState().noticeReadReceipts['agent-1']
  await dom.render(null)
  await act(async () => useAppStore.setState({ sessions: [] }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(mailbox().textContent).toContain('Waiting for Session status.')
  expect(useAppStore.getState().noticeReadReceipts['agent-1']).toEqual(receipt)
  await act(async () => useAppStore.setState({ sessions: [session()] }))
  expect(unread()).toBe('false')
  const resumed = session()
  resumed.control = { ...resumed.control, run: { runId: 'new-run' } }
  resumed.terminalPromptDelivery.run = { runId: 'new-run' }
  await act(async () => useAppStore.setState({ sessions: [resumed] }))
  expect(unread()).toBe('true')
})

it.each(['copy', 'retry'] as const)('keeps an outbox %s failure in this mailbox and clears it on success', async (kind) => {
  const queued = { operationId: 'q-local', runId: 'run-agent-1', text: 'Keep this pending message', status: 'queued' as const }
  useAppStore.setState({ sessions: [composerSession()], agentSteerQueues: { 'agent-1': [queued] } })
  const action = kind === 'copy'
    ? vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('Clipboard unavailable')).mockResolvedValueOnce()
    : vi.spyOn(useAppStore.getState(), 'sendQueuedAgentSteer').mockRejectedValueOnce(new Error('Retry unavailable')).mockResolvedValueOnce()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  const clickAction = async () => {
    const label = kind === 'copy' ? 'Copy message' : 'Send queued message'
    const button = [...mailbox().querySelectorAll<HTMLButtonElement>('.composer-outbox button')].find((item) => item.textContent?.trim() === label)
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  await clickAction()
  expect(unread()).toBe('true')
  expect(mailbox().querySelector('.composer-notice')?.textContent).toContain('unavailable')
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([queued])
  await clickAction()
  expect(action).toHaveBeenCalledTimes(2)
  expect(mailbox().querySelectorAll('.composer-notice')).toHaveLength(0)
  expect(unread()).toBe('false')
})

function delivered(id: string, authorAgentSessionId?: string) {
  return { id: `prompt:${id}`, agentSessionId: 'agent-1', kind: 'user_message' as const,
    status: 'complete' as const, source: 'user' as const, title: 'Prompt', content: `Body ${id}`, createdAt: 100, updatedAt: 100,
    ...(authorAgentSessionId ? { authorAgentSessionId } : {}) }
}
it('separates actual incoming Agent messages, sent user history and system facts; reading survives restart', async () => {
  const items = [delivered('in', 'reviewer'), delivered('sent')]
  useAppStore.setState({ timelines: { 'agent-1': { agentSessionId: 'agent-1', revision: 2, items } },
    agentSteerQueues: { 'agent-1': [{ operationId: 'sent', runId: 'run-agent-1', text: 'Body sent', status: 'queued' }] } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect([...mailbox().querySelectorAll('[role="tab"]')].map((el) => el.textContent)).toEqual(['Inbox (1)', 'Outbox (1)', 'System (1)', 'Progress'])
  expect(trigger().textContent).toBe('') // Durable sent item is never shown as pending again.
  await toggle('open')
  expect(mailbox().querySelector('[aria-selected="true"]')?.textContent).toBe('Inbox (1)')
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Body in')
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).not.toContain('screen confirmation')
  expect(unread()).toBe('true') // System was not read by opening Inbox.
  await folder('system')
  expect(unread()).toBe('false')
  const persisted = JSON.parse(JSON.stringify(useAppStore.persist.getOptions().partialize!(useAppStore.getState())))
  expect(persisted.noticeReadReceipts['mail:agent-1']['prompt:in']).toBeTruthy()
  expect(persisted.noticeReadReceipts['agent-1'].delivery).toBeTruthy()
  await dom.render(null)
  await act(async () => useAppStore.setState({ noticeReadReceipts: persisted.noticeReadReceipts }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(unread()).toBe('false')
  await toggle('open')
  expect(mailbox().querySelector('[aria-selected="true"]')?.textContent).toBe('Outbox (1)')
  expect(mailbox().querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain('Sent')
  expect(useAppStore.getState().timelines['agent-1']?.items).toEqual(items)
})
it('does not switch folders or consume new incoming messages while reading the Outbox', async () => {
  useAppStore.setState({ sessions: [composerSession()], timelines: { 'agent-1': {
    agentSessionId: 'agent-1', revision: 1, items: [delivered('sent')] } } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await toggle('open')
  await act(async () => useAppStore.setState({ timelines: { 'agent-1': {
    agentSessionId: 'agent-1', revision: 2, items: [delivered('sent'), delivered('new', 'other')] } } }))
  expect(mailbox().querySelector('[aria-selected="true"]')?.textContent).toBe('Outbox (1)')
  // 未读要等指纹算完：`useMessageFingerprints` 走的是异步的 `crypto.subtle.digest`，
  // `setState` 返回时 `receipts.unread` 还是空的。并行跑时这个微任务会输掉竞争，于是这一行
  // 在满载下 2/3 的概率读到 'false'，单跑必绿——看着像 flake，其实是漏了一次等待。
  // 兄弟文件 session-mailbox-receipts.test.tsx 全程用的就是 `vi.waitFor`。
  await vi.waitFor(() => expect(unread()).toBe('true'))
  await toggle('closed')
  await toggle('open')
  expect(mailbox().querySelector('[aria-selected="true"]')?.textContent).toBe('Inbox (1)')
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
  expect(trigger().getAttribute('aria-label')).toContain('1 pending')
  await act(async () => resolveList([]))
  expect(trigger().getAttribute('data-progress-state')).toBe('inactive')
  expect(mailbox().querySelector('[id$="-progress"]')?.textContent).toContain('Not enabled.')
  await toggle('open')
  expect(mailbox().querySelector('[aria-selected="true"]')?.textContent).toBe('Outbox (1)')
  for (const loop of [progressLoop(), progressLoop('paused'), { ...progressLoop('paused'), lastOutcome: 'unknown' as const }]) {
    await act(async () => changed(loop))
    expect(mailbox().querySelector('[aria-selected="true"]')?.textContent).toBe('Outbox (1)')
    expect(trigger().getAttribute('data-progress-state')).toBe(loop.lastOutcome === 'unknown' ? 'unconfirmed' : loop.status)
    expect(unread()).toBe('false')
    expect(trigger().textContent).toBe('1')
  }
  await folder('progress')
  await act(async () => changed({ ...progressLoop(), workspacePath: '/unrelated' }))
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
  const values = ['17', '/tracker', 'f-private', '/reader.sh']
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
