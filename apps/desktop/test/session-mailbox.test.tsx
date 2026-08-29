// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const session = () => ({ ...composerSession(), terminalPromptDelivery: {
  state: 'unverified' as const, mode: 'degraded' as const, reason: 'screen-evidence-gap' as const,
  submissionId: 'submission-1', run: { runId: 'run-agent-1' }, observedAt: 1
} })
beforeEach(() => useAppStore.setState({ sessions: [session()], noticeReadReceipts: {},
  timelines: { 'agent-1': { agentSessionId: 'agent-1', revision: 0, items: [] } } }))
const trigger = () => dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
const mailbox = () => dom.container.querySelector<HTMLDivElement>('.composer-mailbox')!
const unread = () => trigger().getAttribute('data-unread')
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
async function folder(name: 'inbox' | 'outbox' | 'system') {
  await dom.click(`[role="tab"][id$="-${name}-tab"]`)
}

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
  await action('Retry queue')
  expect(send).toHaveBeenCalledExactlyOnceWith('agent-1', 'queued-1')
  await action('Copy all')
  expect(copy).toHaveBeenCalledExactlyOnceWith('First exact words\n\nSecond exact words')
  await action('Remove')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([queued[1]])
  expect(mailbox().querySelectorAll('.composer-notice')).toHaveLength(1)
  expect(trigger().textContent).toBe('1')
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
    const label = kind === 'copy' ? 'Copy message' : 'Retry queue'
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
  expect([...mailbox().querySelectorAll('[role="tab"]')].map((el) => el.textContent)).toEqual(['Inbox (1)', 'Outbox (1)', 'System (1)'])
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
