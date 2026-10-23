// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError, connectAgentMuxRpc, defaultAgentMuxMessageQueuePath, DurableAgentMuxMessageQueue, type AgentMuxRpcClient } from '@agentmux/core'
import type { AgentSessionHistoryPage, AgentSessionUserMessage } from '@agentmux/core'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { readStyleSheet } from './helpers/styles'
import * as readingDiagnostics from '../src/renderer/src/lib/reading-diagnostic-publication'

// Real host, composer, mailbox, Activity and shared readers. Only terminal rendering is a leaf
// witness here; exact xterm geometry/input is qualified separately by the finite Native command.
const terminals = vi.hoisted(() => ({ mounted: 0, disposed: 0 }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ visible, autoFocus }: { visible: boolean; autoFocus: boolean }) => {
  useEffect(() => { ++terminals.mounted; return () => { ++terminals.disposed } }, [])
  return <div data-terminal-witness data-visible={visible} data-auto-focus={autoFocus} />
} }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

let originalReading: Awaited<ReturnType<typeof conversationPagePortFixture>> | undefined
let originalRpc: AgentMuxRpcClient | undefined
let originalControlCalls: unknown[][][] = []
type OriginalReading = Awaited<ReturnType<typeof conversationPagePortFixture>>
let originalMetadata: Awaited<ReturnType<OriginalReading['store']['loadMetadata']>> | undefined
let originalCaptured: Pick<Awaited<ReturnType<OriginalReading['store']['readCapturedHistory']>>, 'stream' | 'records'> | undefined
let originalDirectory: string | undefined
type ConversationInput = Parameters<typeof api.conversation.readAgentConversation>[0]
type ConversationPage = Awaited<ReturnType<typeof api.conversation.readAgentConversation>>
let originalReads: Array<{ input: ConversationInput; page?: ConversationPage; error?: unknown }> = []
type OriginalResponseHold = { receipt?: (typeof originalReads)[number]; pending: Promise<void>; done: Promise<void>; release(): void; finish(): void }
let originalResponseHold: OriginalResponseHold | undefined
// composerDOM registers later: its original root unmounts before these private sources close.
afterEach(async () => {
  try {
    originalResponseHold?.release()
    if (originalReading) {
      expect(originalControlCalls.map(calls => calls.length)).toEqual([0, 0, 0, 0, 0, 0])
      if (originalMetadata) expect(await originalReading.store.loadMetadata()).toEqual(originalMetadata)
      if (originalCaptured) {
        const captured = await originalReading.store.readCapturedHistory('agent-1', { limit: 1 })
        expect({ stream: captured.stream, records: captured.records }).toEqual(originalCaptured)
      }
    }
  } finally {
    try { await originalRpc?.dispose() } finally {
      await originalReading?.close()
      originalReading = undefined; originalRpc = undefined
      vi.unstubAllGlobals(); vi.unstubAllEnvs()
    }
  }
})
const dom = composerDOM()
afterEach(async context => {
  if (!process.env.AGENTMUX_MAILBOX_NAVIGATION_FACTS) return
  await appendFile(process.env.AGENTMUX_MAILBOX_NAVIGATION_FACTS, JSON.stringify({ test: context.task.name,
    state: context.task.result?.state, sourceDirectory: originalDirectory, viewMode: useAppStore.getState().viewModes['agent-1'],
    ui: dom.container.innerHTML, controls: originalControlCalls.map(calls => calls.length),
    reads: originalReads.map(receipt => ({ input: receipt.input, window: receipt.page?.window,
      originals: receipt.page?.items.flatMap(entry => entry.kind === 'item' ? entry.item.records.map(record => ({ original: record.original, reference: record.reference })) : []),
      error: receipt.error instanceof Error ? { name: receipt.error.name, message: receipt.error.message,
        code: 'code' in receipt.error && typeof receipt.error.code === 'string' ? receipt.error.code : null } : receipt.error })) }) + '\n')
})
const body = 'Identical recorded text from distinct sources'
const originalMessageId = 'mailbox-navigation-original-message'
const page = (nativeSessionId = 'native-a', providerId = 'codex'): AgentSessionHistoryPage => ({
  agentSessionId: 'agent-1', source: { providerId, nativeSessionId }, nextCursor: null,
  items: [{ id: 'same', kind: 'user-message', contentParts: [{ kind: 'text', text: body }] }]
})
const incoming = { id: 'same', agentSessionId: 'agent-1', kind: 'user_message' as const, status: 'complete' as const,
  source: 'user' as const, title: 'Recorded input', content: body, authorAgentSessionId: 'declared-peer', createdAt: 1, updatedAt: 1 }
let witness: ReturnType<typeof useSessionUserMessages> | null = null
const revealSource = { kind: 'native' as const, providerId: 'codex', nativeSessionId: 'native-a', recordId: 'missing' }
function Witness() { witness = useSessionUserMessages(originalControl()); return null }
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
function originalControl() {
  const session = useAppStore.getState().sessions.find(session => session.id === 'agent-1')
  if (session?.kind !== 'agent') throw new Error('The original mounted Agent control is missing')
  return session.control
}
const pane = (id = 'agent-1', parked = false) => <SessionPane sessionId={id} surfaceKind="agent" interactiveResize={false} visible parked={parked}
  linkOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} />
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }); await act(async () => new Promise(resolve => setTimeout(resolve, 25))) }
async function open(folder = 'inbox', content = panel()) {
  // happy-dom omits native popover presentation. Supply only those browser
  // methods/events, following session-mailbox's existing finite DOM fixture.
  const matches = content.matches.bind(content)
  // Vite does not mount the application stylesheet in this DOM fixture. Consume
  // the original timing tokens so the actual motion owner receives finite inputs.
  const motionTokens = readStyleSheet('./tokens.css')
  for (const name of ['--dur-enter', '--ease-enter']) {
    const value = new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(motionTokens)?.[1]?.trim()
    expect(value, name).toBeTruthy(); content.style.setProperty(name, value!)
  }
  let nativeOpen = false
  vi.spyOn(content, 'matches').mockImplementation(selector => selector === ':popover-open' ? nativeOpen : matches(selector))
  const state = (newState: 'open' | 'closed') => {
    const before = new Event('beforetoggle'); Object.defineProperty(before, 'newState', { value: newState }); content.dispatchEvent(before)
    nativeOpen = newState === 'open'
    const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: newState }); content.dispatchEvent(event)
  }
  Object.defineProperties(content, { showPopover: { configurable: true, value: () => state('open') },
    hidePopover: { configurable: true, value: () => state('closed') } })
  await act(async () => content.showPopover()); await flush()
  const tab = async (selector: string) => {
    const button = content.querySelector<HTMLButtonElement>(selector)
    expect(button, selector).not.toBeNull(); await act(async () => button!.click())
  }
  if (folder === 'inbox' || folder === 'outbox') await tab('[id$="-agents-tab"]')
  await tab(`[role="tab"][id$="-${folder}-tab"]`)
}
async function navigate(key: string, detail = false, content = panel()) {
  let row: HTMLButtonElement | undefined
  await vi.waitFor(() => {
    row = [...content.querySelectorAll<HTMLButtonElement>('.composer-mailbox__row')].find(node => node.dataset.recordKey === key)
    expect(row, key).toBeDefined()
  }, { timeout: 8000 })
  if (detail) {
    await act(async () => { row!.focus(); row!.click() })
    await vi.waitFor(() => expect(content.querySelectorAll('.log-turn__body')).toHaveLength(1), { timeout: 8000 })
  }
  const action = detail ? content.querySelector<HTMLButtonElement>('.composer-mailbox__detail .log-turn__actions .composer-mailbox__reveal') : row!.parentElement!.querySelector<HTMLButtonElement>('.composer-mailbox__reveal')
  expect(action).not.toBeNull(); expect(action!.closest('button button')).toBeNull()
  await act(async () => { action!.focus(); action!.click() }); await flush()
}
async function nativeActionReady() {
  await vi.waitFor(() => expect(panel().querySelector('[data-record-key="native:native:codex:native-a:same"]')).not.toBeNull(), { timeout: 8000 })
}
async function replaceOriginalNativeSource(source: AgentSessionHistoryPage['source']) {
  const original = originalReading!
  const before = await original.store.readMetadata('agent-1')
  if (!before) throw new Error('The original durable Session is missing')
  const next = { ...before, providerId: source.providerId, executorId: source.providerId,
    nativeHandle: { kind: 'provider' as const, providerId: source.providerId, sessionId: source.nativeSessionId } }
  await original.store.compareAndSwap(before, next)
  expect(await original.client.readAgentSession('agent-1')).toMatchObject({
    providerId: source.providerId, run: before.run, nativeHandle: next.nativeHandle
  })
  const checkpoint = { agentSessionId: 'agent-1', source, cursor: 'replacement-native-cut' }
  original.nativeRead.mockImplementation(async () => ({ ...page(source.nativeSessionId, source.providerId), changesCursor: checkpoint.cursor }))
  original.nativeCheckpoint.mockResolvedValue({ hostId: 'local', agentSessionId: 'agent-1', source,
    items: [], checkpoint, more: false })
  original.nativeChanges.mockResolvedValue({ hostId: 'local', agentSessionId: 'agent-1', source,
    items: [], checkpoint, more: false })
  vi.mocked(original.client.observeSessionHistory).mockResolvedValue({ source, dispose() {} })
  // This deliberate durable source replacement is the input, not a navigation
  // side effect. Further reads must preserve precisely this metadata.
  originalMetadata = await original.store.loadMetadata()
}
function holdNextOriginalResponse(): OriginalResponseHold {
  expect(originalResponseHold).toBeUndefined()
  let release!: () => void, finish!: () => void
  const pending = new Promise<void>(resolve => { release = resolve }), done = new Promise<void>(resolve => { finish = resolve })
  return originalResponseHold = { pending, done, release, finish }
}
async function heldResponse(hold: OriginalResponseHold) {
  await vi.waitFor(() => {
    expect(hold.receipt?.input).toMatchObject({ hostId: 'local', agentSessionId: 'agent-1' })
    expect(hold.receipt?.page?.window.complete).toBe(true)
    const originals = hold.receipt!.page!.items.flatMap(entry => entry.kind === 'item' ? entry.item.records.map(record => record.reference) : [])
    expect(originals).toHaveLength(2)
    expect(originals).toEqual(expect.arrayContaining([
      { hostId: 'local', agentSessionId: 'agent-1', source: { kind: 'native', providerId: 'codex', nativeSessionId: 'native-a', recordId: 'same' } },
      { hostId: 'local', agentSessionId: 'agent-1', source: { kind: 'captured', recordId: 'same' } }
    ]))
  }, { timeout: 8000 })
}
async function releaseResponse(hold: OriginalResponseHold) {
  await act(async () => { hold.release(); await hold.done }); await flush()
}
async function located(source: AgentSessionUserMessage['source']) {
  const key = conversationMessageSourceKey('agent-1', source)
  let actual: HTMLElement[] = []
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    actual = [...dom.container.querySelectorAll<HTMLElement>('.activity-feed .log-turn')].filter(node => node.dataset.messageSourceKey === key)
    expect(actual).toHaveLength(1); expect(actual[0]!.dataset.messageLocated).toBe('true')
    expect(actual[0]!.textContent).toContain('已定位此消息'); expect(document.activeElement).toBe(actual[0])
  }, { timeout: 8000 })
  return actual[0]!
}
beforeEach(async () => {
  witness = null; terminals.mounted = 0; terminals.disposed = 0
  originalDirectory = undefined; originalMetadata = undefined; originalCaptured = undefined; originalReads = []; originalResponseHold = undefined
  localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: this.classList.contains('activity-feed') ? 300 : 20,
      width: 600, height: this.classList.contains('activity-feed') ? 300 : 20, toJSON() {} }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  vi.spyOn(api.sessions, 'historyPage')
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', '')
  originalReading = await conversationPagePortFixture({ hostId: 'local', agentSessionId: 'agent-1' }, page().source, async () => page())
  originalControlCalls = originalReading.controls.map(control => control.mock.calls)
  const originalSession = await originalReading.client.readAgentSession('agent-1')
  if (!originalSession) throw new Error('The original mailbox fixture Session metadata was not found')
  originalDirectory = originalSession.workspacePath
  const journal = new DurableAgentMuxMessageQueue(defaultAgentMuxMessageQueuePath(join(originalDirectory, 'sessions.json'), ''))
  await journal.append({ messageId: originalMessageId, operationId: 'mailbox-navigation-original-operation', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'declared-peer' }, recipient: { kind: 'agent-session', agentSessionId: 'agent-1' },
    senderSessionId: 'declared-peer', senderRunId: null, recipientSessionId: 'agent-1', recipientRunId: originalSession.run.runId,
    threadId: 'original-mailbox-thread', correlationId: 'original-mailbox-correlation', replyTo: null, workspaceId: null, body })
  const capturedIncoming = { ...incoming, publicContent: 'confirmed' as const, inputRef: { kind: 'message' as const, agentSessionId: 'agent-1',
    messageId: originalMessageId, expectedRun: originalSession.run } }
  await originalReading.publishCaptured([capturedIncoming])
  expect((await originalReading.store.readCapturedHistory('agent-1', { limit: 1 })).records.map(record => record.item))
    .toMatchObject([capturedIncoming])
  expect((await originalReading.client.readMessage({ messageId: originalMessageId }))?.envelope).toMatchObject({
    messageId: originalMessageId, senderSessionId: incoming.authorAgentSessionId, recipientSessionId: incoming.agentSessionId, body })
  const originalTimeline = await originalReading.client.sessionTimeline('agent-1')
  expect(originalTimeline).toMatchObject({ agentSessionId: 'agent-1', sourceHostId: originalSession.hostId })
  expect(originalTimeline.items).toMatchObject([capturedIncoming])
  // The SQLite container can also hold legitimate Reader bookkeeping. Guard the
  // original durable Session and immutable captured versions themselves.
  const captured = await originalReading.store.readCapturedHistory('agent-1', { limit: 1 })
  originalCaptured = { stream: captured.stream, records: captured.records }
  originalMetadata = await originalReading.store.loadMetadata()
  expect(originalMetadata).toHaveLength(1); expect(captured.records).toHaveLength(1)
  expect((await readFile(originalReading.store.path)).subarray(0, 16).toString()).toBe('SQLite format 3\0')
  originalRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(originalDirectory, 'conversation.sock') } })
  const publicRead = vi.mocked(api.conversation.readAgentConversation).getMockImplementation()!
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (...args) => {
    const receipt: (typeof originalReads)[number] = { input: args[0] }; originalReads.push(receipt)
    try {
      receipt.page = await publicRead(...args)
      const hold = originalResponseHold
      if (hold && !hold.receipt) {
        hold.receipt = receipt
        try { await hold.pending } finally { hold.finish() }
      }
      return receipt.page
    } catch (error) { receipt.error = error; throw error }
  })
  vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, input, context) => originalRpc!.call('agent.history',
    { ...input, ...reference }, context?.signal ? { signal: context.signal } : {}))
  vi.spyOn(api.sessions, 'inputMailbox').mockImplementation((reference, input = {}) => originalRpc!.call('agent.input.ls', { ...input, ...reference }))
  vi.spyOn(api.sessions, 'listMessages').mockImplementation((reference, input) => originalRpc!.call('message.ls',
    { ...input, hostId: reference.hostId, participantSessionId: reference.agentSessionId }))
  vi.spyOn(api.sessions, 'readMessage').mockImplementation((reference, messageId) => originalRpc!.call('message.read', { hostId: reference.hostId, messageId }))
  useAppStore.setState({ sessions: [{ ...composerSession(), workspacePath: originalSession.workspacePath,
    control: { ...composerSession().control, run: originalSession.run } }, composerSession('other')], viewModes: { 'agent-1': 'terminal', other: 'terminal' },
    timelines: { 'agent-1': originalTimeline },
    noticeReadReceipts: {}, agentSteerQueues: {}, agentSteerInFlight: {} })
})

it.each([false, true])('real Inbox captured action (detail=%s) locates receiving conversation rather than declared sender or duplicate native raw id', async detail => {
  const send = vi.spyOn(api.sessions, 'write')
  await dom.render(pane()); await open(); await navigate(`a2a:${originalMessageId}`, detail)
  const target = await located({ kind: 'captured', submissionId: 'same' })
  const duplicate = [...dom.container.querySelectorAll<HTMLElement>('.activity-feed .log-turn')].find(node => node.dataset.messageSourceKey === conversationMessageSourceKey('agent-1', page().source ? { ...page().source, kind: 'native', recordId: 'same' } : undefined))
  expect(duplicate).toBeDefined(); expect(duplicate).not.toBe(target); expect(duplicate!.dataset.messageLocated).toBeUndefined()
  expect(useAppStore.getState().viewModes).toEqual({ 'agent-1': 'activity', other: 'terminal' })
  expect(dom.draft()).toBe('Keep my draft'); expect(terminals.mounted).toBe(1); expect(terminals.disposed).toBe(0)
  expect(dom.container.querySelector('[data-terminal-witness]')?.getAttribute('data-visible')).toBe('false')
  expect(dom.container.querySelector('[data-terminal-witness]')?.getAttribute('data-auto-focus')).toBe('false')
  expect(panel().dataset.state).toBe('closed'); expect(send).not.toHaveBeenCalled()
})

it.each([false, true])('real Inputs native action (detail=%s) selects complete provider/session/record namespace with stable projection and handoff', async detail => {
  await dom.render(pane()); await open('user'); await navigate('native:native:codex:native-a:same', detail)
  const target = await located({ kind: 'native', providerId: 'codex', nativeSessionId: 'native-a', recordId: 'same' })
  expect(target.dataset.messageId).toBe('native:codex:native-a:same')
  // These are key comparisons beside an actual accepted/rendered source. They
  // do not fabricate a second Provider's history inside this original window.
  expect(target.dataset.messageSourceKey).not.toBe(conversationMessageSourceKey('agent-1', { kind: 'native', providerId: 'claude', nativeSessionId: 'native-a', recordId: 'same' }))
  expect(target.dataset.messageSourceKey).not.toBe(conversationMessageSourceKey('agent-1', { kind: 'native', providerId: 'codex', nativeSessionId: 'native-b', recordId: 'same' }))
  expect(target.dataset.messageSourceKey).not.toBe(conversationMessageSourceKey('other', { kind: 'native', providerId: 'codex', nativeSessionId: 'native-a', recordId: 'same' }))
  expect(api.sessions.historyPage).not.toHaveBeenCalled()
  expect(originalReading!.nativeRead).toHaveBeenCalled()
  expect(panel().dataset.state).toBe('closed'); expect(document.activeElement).toBe(target)
})

it('an original queued unsent message keeps Send and shared body/Copy without inventing a conversation location or dispatch', async () => {
  const send = vi.spyOn(api.sessions, 'write'), steer = vi.spyOn(useAppStore.getState(), 'enqueueAgentSteer')
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined), run = originalControl().run
  const queue = [{ operationId: 'pending', text: 'Exact unsent full text', status: 'queued' as const, runId: run.runId }]
  useAppStore.setState({ agentSteerQueues: { 'agent-1': queue } })
  await dom.render(pane()); await open('user')
  const row = panel().querySelector<HTMLButtonElement>('[data-record-key="queue:pending"]')!
  expect(row).not.toBeNull()
  const record = row.closest('.composer-mailbox__record')!
  expect(record.querySelector('[aria-label="在对话中查看"]')).toBeNull()
  const sendAction = record.querySelector<HTMLButtonElement>('.composer-outbox__send')!
  expect(sendAction).not.toBeNull(); expect(sendAction.disabled).toBe(false)
  const listCopy = record.querySelector<HTMLButtonElement>('[aria-label="复制这条待发消息"]')!
  expect(listCopy).not.toBeNull(); await act(async () => listCopy.click())
  await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1)); expect(copy).toHaveBeenLastCalledWith(queue[0]!.text)
  await act(async () => row.click())
  const detail = panel().querySelector<HTMLElement>('.composer-outbox__inline[data-record-key="queue:pending"]')!
  expect(detail).not.toBeNull(); expect(detail.querySelector('.log-turn__body')!.textContent).toBe(queue[0]!.text)
  expect(detail.querySelector('[aria-label="在对话中查看"]')).toBeNull()
  const detailCopy = detail.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!
  expect(detailCopy).not.toBeNull(); await act(async () => detailCopy.click())
  await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(2)); expect(copy).toHaveBeenLastCalledWith(queue[0]!.text)
  const info = detail.querySelector<HTMLButtonElement>('button[aria-label="Message details"]')!
  expect(info).not.toBeNull(); await act(async () => info.click())
  const delivery = [...detail.querySelectorAll('dt')].find(node => node.textContent === 'Delivery')!.nextElementSibling!
  // This exact original queue record is known unsent; no claim is made about
  // uncertain, submitted or confirmed delivery without a corresponding record.
  expect(delivery.textContent).toContain('尚未发送')
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual(queue)
  expect(originalControl().run).toEqual(run); expect(dom.draft()).toBe('Keep my draft')
  expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(dom.container.querySelector('[data-message-located]')).toBeNull()
  expect(send).not.toHaveBeenCalled(); expect(steer).not.toHaveBeenCalled()
})

it.each([{ providerId: 'claude', nativeSessionId: 'native-a' }, { providerId: 'codex', nativeSessionId: 'native-b' }])('a latest original read with no accepted Pane window rejects the old native tuple after source replacement %s', async source => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined), run = originalControl().run
  await dom.render(pane()); await open('user'); await nativeActionReady()
  expect(dom.container.querySelector('.activity-feed')).toBeNull()
  await replaceOriginalNativeSource(source)
  const reads = originalReads.length
  await navigate('native:native:codex:native-a:same', true)
  await vi.waitFor(() => expect(panel().querySelector('.composer-mailbox__navigation-feedback')?.textContent).toContain('原生来源已变化'), { timeout: 8000 })
  const returned = originalReads.slice(reads).flatMap(receipt => receipt.page ? [receipt.page] : [])
  expect(returned.length).toBeGreaterThan(0)
  expect(returned.every(page => page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : [])
    .filter(record => record.reference.source.kind === 'native').every(record => record.reference.source.kind === 'native' &&
      record.reference.source.providerId === source.providerId && record.reference.source.nativeSessionId === source.nativeSessionId))).toBe(true)
  expect(panel().textContent).not.toContain('当前有界对话窗口中没有这条记录')
  expect(panel().querySelector('.log-turn__body')!.textContent).toBe(body)
  const action = panel().querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!
  expect(action).not.toBeNull(); await act(async () => action.click()); await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(body))
  expect(panel().dataset.state).toBe('open'); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(dom.container.querySelector('[data-message-located]')).toBeNull()
  expect(originalControl().run).toEqual(run); expect(dom.draft()).toBe('Keep my draft')
})

it('a changed public Session provider in the same Host/Session/Run cannot use the previously loaded native source', async () => {
  await dom.render(pane()); await open('user'); await nativeActionReady()
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'agent-1' && session.kind === 'agent'
    ? { ...session, providerId: 'claude' } : session) })))
  await navigate('native:native:codex:native-a:same', true)
  expect(panel().textContent).toContain('原生来源已变化'); expect(panel().querySelector('.log-turn__body')!.textContent).toBe(body)
  expect(originalReading!.nativeRead).toHaveBeenCalled(); expect(api.sessions.historyPage).not.toHaveBeenCalled()
  expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(dom.container.querySelector('[data-message-located]')).toBeNull()
})

it.each(['focus', 'mode', 'run', 'hidden'])('late native result is isolated from later %s intent or scope', async change => {
  await dom.render(pane()); await open('user'); await nativeActionReady()
  const hold = holdNextOriginalResponse(), run = originalControl().run
  const external = document.createElement('button'); document.body.append(external)
  try {
    await navigate('native:native:codex:native-a:same'); await heldResponse(hold)
    expect(originalControl().run).toEqual(run)
    await act(async () => {
      if (change === 'focus') external.focus()
      if (change === 'mode') useAppStore.getState().setViewMode('agent-1', 'activity', { focus: false })
      if (change === 'run') useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'agent-1' && session.kind === 'agent'
        ? { ...session, control: { ...session.control, run: { runId: 'new-run' } } } : session) }))
      if (change === 'hidden') await dom.render(<SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible={false} linkOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} />)
    })
    await releaseResponse(hold)
    expect(dom.container.querySelector('[data-message-located]')).toBeNull()
    if (change === 'focus') expect(document.activeElement).toBe(external)
    expect(useAppStore.getState().viewModes['agent-1']).toBe(change === 'mode' ? 'activity' : 'terminal')
    expect(originalControl().run).toEqual(change === 'run' ? { runId: 'new-run' } : run)
    expect(dom.draft()).toBe('Keep my draft')
  } finally { hold.release(); external.remove() }
})

it('later user wheel alone cancels the pending exact-node reveal without stealing its current focus', async () => {
  await dom.render(pane()); await open('user'); await nativeActionReady()
  const hold = holdNextOriginalResponse()
  try {
    await navigate('native:native:codex:native-a:same'); await heldResponse(hold)
    const focused = document.activeElement, terminal = dom.container.querySelector('[data-terminal-witness]')!
    expect(terminal).not.toBeNull()
    await act(async () => terminal.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 })))
    await releaseResponse(hold)
    expect(document.activeElement).toBe(focused); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
    expect(dom.container.querySelector('[data-message-located]')).toBeNull(); expect(panel().dataset.state).toBe('open')
  } finally { hold.release() }
})

it('same-control native reader performs at most one bounded request, or joins inflight without queueing refresh', async () => {
  const original = originalReading!, before = original.nativeRead.mock.calls.length
  let entered = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  original.nativeRead.mockImplementation(async (id, input) => {
    expect(id).toBe('agent-1')
    if (!input?.cursor) return { ...page(), nextCursor: 'finite-native-older-one', changesCursor: 'original-page-cut' }
    if (input.cursor === 'finite-native-older-one') {
      const produced: AgentSessionHistoryPage = { ...page(), items: [{ id: 'missing', kind: 'user-message',
        contentParts: [{ kind: 'text', text: 'Exact older input' }] }], nextCursor: 'finite-native-older-two', changesCursor: 'original-page-cut' }
      entered = true; await gate; return produced
    }
    expect(input.cursor).toBe('finite-native-older-two')
    throw new Error('finite history read unavailable')
  })
  try {
    await dom.render(<Witness />)
    await vi.waitFor(() => {
      expect(witness?.nativeHistoryPage?.items.map(item => item.id)).toEqual(['same'])
      expect(witness?.conversation.inspect()).toMatchObject({ loading: false, inFlight: false })
    }, { timeout: 8000 })
    expect(original.nativeRead).toHaveBeenCalledTimes(before + 1)
    const window = witness!.conversation.snapshot!.window.id, reads = originalReads.length
    const frame = witness!.conversation.snapshot!
    if (!frame.sourceHostId) throw new Error('The original accepted frame has no source Host')
    const record = (source: typeof revealSource) => ({ hostId: frame.sourceHostId!, agentSessionId: frame.agentSessionId, source })
    let earlier!: Promise<unknown>, reveal!: ReturnType<NonNullable<typeof witness>['readForReveal']>
    await act(async () => { earlier = witness!.loadEarlier(); reveal = witness!.readForReveal(record(revealSource)) })
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 8000 })
    expect(originalReads).toHaveLength(reads + 1); expect(original.nativeRead).toHaveBeenCalledTimes(before + 2)
    await act(async () => { release(); await earlier; await reveal })
    const accepted = await reveal
    expect(accepted.cancelled).toBe(false); expect(accepted.error).toBeNull()
    expect(accepted.records.filter(record => record.source.kind === 'native').map(record => record.rawId).sort()).toEqual(['missing', 'same'])
    expect(witness!.conversation.snapshot!.window.id).toBe(window)
    expect(originalReads).toHaveLength(reads + 1); expect(original.nativeRead).toHaveBeenCalledTimes(before + 2)
    let failedRead!: Promise<unknown>, failedReveal!: ReturnType<NonNullable<typeof witness>['readForReveal']>
    await act(async () => {
      failedRead = witness!.loadEarlier()
      failedReveal = witness!.readForReveal(record({ ...revealSource, recordId: 'same' }))
    })
    await act(async () => { await failedRead; await failedReveal })
    const failed = await failedReveal
    expect(original.nativeRead).toHaveBeenCalledTimes(before + 3); expect(originalReads).toHaveLength(reads + 2)
    expect(failed.cancelled).toBe(false); expect(failed.error).toMatchObject({ code: 'AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE' })
    expect(failed.error!.message).toContain('finite history read unavailable')
    expect(failed.records.filter(record => record.source.kind === 'native').map(record => record.rawId).sort()).toEqual(['missing', 'same'])
    expect(witness!.conversation.snapshot!.window.id).toBe(window)
    expect(api.sessions.historyPage).not.toHaveBeenCalled(); expect(dom.draft()).toBe('Keep my draft')
  } finally { release() }
})

it.each([{ providerId: 'claude', nativeSessionId: 'native-a' }, { providerId: 'codex', nativeSessionId: 'native-b' }])('an accepted original view still locates its original record after durable source replacement %s without granting the new source', async source => {
  const diagnostics = vi.spyOn(readingDiagnostics, 'publishReadingDiagnostic')
  useAppStore.setState({ viewModes: { 'agent-1': 'activity', other: 'terminal' } })
  const originalSource = { kind: 'native' as const, providerId: 'codex', nativeSessionId: 'native-a', recordId: 'same' }, run = originalControl().run
  await dom.render(pane())
  const key = conversationMessageSourceKey('agent-1', originalSource)
  let target: HTMLElement | null = null
  await vi.waitFor(() => {
    target = dom.container.querySelector(`.activity-feed [data-message-source-key='${key}']`)
    expect(target).not.toBeNull()
  }, { timeout: 8000 })
  // Activity rendering does not prove that this Pane's separate input reader
  // has admitted its original window before being hidden and parked.
  await vi.waitFor(() => {
    const records = diagnostics.mock.calls.map(([record]) => record).filter(record =>
      record.scope.hostId === 'local' && record.scope.agentSessionId === 'agent-1' &&
      record.scope.runId === run.runId && record.scope.consumerKind === 'input-summary')
    const consumers = new Set(records.map(record => record.scope.consumerId))
    expect(consumers.size).toBe(1)
    const events = records.flatMap(record => record.events)
    expect(events.some(event => event.phase === 'consumer-ended')).toBe(false)
    const accepted = events.find(event => event.phase === 'admission-accepted')
    expect(accepted?.windowId).toBeTruthy()
    expect(events.some(event => event.phase === 'read-ended' && event.attemptId === accepted?.attemptId)).toBe(true)
    const page = originalReads.find(receipt => receipt.page?.window.id === accepted?.windowId)?.page
    expect(page?.window.complete).toBe(true)
    expect(page?.items.flatMap(entry => entry.kind === 'item' ? entry.item.records.map(record => record.reference) : []))
      .toContainEqual({ hostId: 'local', agentSessionId: 'agent-1', source: originalSource })
  }, { timeout: 8000 })
  const acceptedIds = new Set(originalReads.flatMap(receipt => receipt.page?.window.complete ? [receipt.page.window.id] : []))
  expect(acceptedIds.size).toBeGreaterThan(0)
  await act(async () => useAppStore.getState().setViewMode('agent-1', 'terminal', { focus: false }))
  await open('user'); await nativeActionReady(); await replaceOriginalNativeSource(source)
  const reads = originalReads.length, physicalReads = originalReading!.nativeRead.mock.calls.length
  await navigate('native:native:codex:native-a:same', true)
  expect(await located(originalSource)).toBe(target)
  const replayed = originalReads.slice(reads).flatMap(receipt => receipt.page ? [receipt.page] : [])
  expect(replayed.length).toBeGreaterThan(0)
  expect(replayed.every(page => acceptedIds.has(page.window.id))).toBe(true)
  expect(replayed.flatMap(page => page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : []))
    .filter(record => record.reference.source.kind === 'native').every(record => record.reference.source.kind === 'native' &&
      record.reference.source.providerId === originalSource.providerId && record.reference.source.nativeSessionId === originalSource.nativeSessionId)).toBe(true)
  expect(originalReading!.nativeRead).toHaveBeenCalledTimes(physicalReads)
  expect(target!.dataset.messageSourceKey).not.toBe(conversationMessageSourceKey('agent-1', { kind: 'native', ...source, recordId: 'same' }))
  expect(panel().dataset.state).toBe('closed'); expect(originalControl().run).toEqual(run); expect(dom.draft()).toBe('Keep my draft')
})

it('an already loaded native target joins current revalidation (failed) before declaring a location', async () => {
  useAppStore.setState({ viewModes: { 'agent-1': 'activity', other: 'terminal' } })
  await dom.render(pane())
  const key = conversationMessageSourceKey('agent-1', { kind: 'native', providerId: 'codex', nativeSessionId: 'native-a', recordId: 'same' })
  await vi.waitFor(() => expect(dom.container.querySelector(`.activity-feed [data-message-source-key='${key}']`)).not.toBeNull(), { timeout: 8000 })
  await act(async () => useAppStore.getState().setViewMode('agent-1', 'terminal', { focus: false }))
  await open('user'); await nativeActionReady()
  const run = originalControl().run, knownViews = originalReads.flatMap(receipt => receipt.page?.window.view ? [receipt.page.window.view] : [])
  const knownFrameIds = originalReads.flatMap(receipt => receipt.page ? [receipt.page.window.id] : [])
  expect(knownViews.length).toBeGreaterThan(0)
  const original = originalReading!.client.readAgentConversation.bind(originalReading!.client)
  let requested: Parameters<typeof original>[0] | undefined, produced: Awaited<ReturnType<typeof original>> | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined), send = vi.spyOn(api.sessions, 'write')
  vi.spyOn(originalReading!.client, 'readAgentConversation').mockImplementationOnce(async (...args) => {
    requested = args[0]
    produced = await original(...args)
    // The real Core response exists; this exact RPC invocation stays pending,
    // then reports its controlled transport failure through Main and preload.
    await gate
    throw new AgentMuxError('Original revalidation read unavailable', 'CONTROL_UNAVAILABLE')
  })
  try {
    await navigate('native:native:codex:native-a:same', true)
    await vi.waitFor(() => {
      expect(requested).toMatchObject({ hostId: 'local', agentSessionId: 'agent-1' })
      expect(produced?.window.complete).toBe(true)
      expect(produced?.window.itemCount).toBe(2)
      expect(requested?.view).toBeTruthy(); expect(knownFrameIds).toContain(produced!.window.id)
    }, { timeout: 8000 })
    // Compare opaque tokens only at their original Renderer route boundary;
    // the RPC service may wrap the Core token without changing the view ID.
    const failureReceipt = originalReads.at(-1)!
    expect(failureReceipt.input).toMatchObject({ hostId: 'local', agentSessionId: 'agent-1' })
    expect(knownViews).toContain(failureReceipt.input.view); expect(failureReceipt.page).toBeUndefined(); expect(failureReceipt.error).toBeUndefined()
    const originalBody = panel().querySelector('.log-turn__body')!
    expect(originalBody.textContent).toBe(body); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
    expect(panel().querySelector('.composer-mailbox__navigation-feedback')).toBeNull()
    await act(async () => release())
    await vi.waitFor(() => {
      const feedback = panel().querySelector('.composer-mailbox__navigation-feedback')
      expect(feedback, 'Original revalidation read unavailable must remain visible at the original Mailbox').not.toBeNull()
      expect(feedback!.textContent).toContain('Original revalidation read unavailable')
    }, { timeout: 8000 })
    expect(panel().textContent).not.toContain('当前有界对话窗口中没有这条记录')
    expect(panel().querySelector('.log-turn__body')).toBe(originalBody)
    expect(panel().dataset.state).toBe('open'); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
    expect(dom.container.querySelector('[data-message-located]')).toBeNull()
    expect(failureReceipt.error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    const action = panel().querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!
    expect(action).not.toBeNull(); await act(async () => action.click())
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(body))
    expect(originalControl().run).toEqual(run); expect(dom.draft()).toBe('Keep my draft'); expect(send).not.toHaveBeenCalled()
  } finally { release() }
})

it.each(['mode', 'hidden'])('programmatic %s change removes every pending reveal intent listener while its bounded read is still unresolved', async change => {
  await dom.render(pane()); await open('user'); await nativeActionReady()
  const hold = holdNextOriginalResponse()
  const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener')
  try {
    await navigate('native:native:codex:native-a:same'); await heldResponse(hold)
    let delivered = false; void hold.done.then(() => { delivered = true })
    const registered = add.mock.calls.filter(call => typeof call[1] === 'function' && call[1].name === 'changedIntent')
    expect(registered.map(call => call[0])).toEqual(['pointerdown', 'keydown', 'wheel', 'touchmove', 'focusin'])
    if (change === 'mode') await act(async () => useAppStore.getState().setViewMode('agent-1', 'activity', { focus: false }))
    else await dom.render(<SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible={false}
      linkOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} />)
    expect(delivered).toBe(false)
    for (const call of registered) expect(remove.mock.calls.some(removed => removed[0] === call[0] && removed[1] === call[1] && removed[2] === true)).toBe(true)
    await releaseResponse(hold)
    expect(delivered).toBe(true); expect(dom.container.querySelector('[data-message-located]')).toBeNull()
    expect(useAppStore.getState().viewModes['agent-1']).toBe(change === 'mode' ? 'activity' : 'terminal')
  } finally { hold.release() }
})

it.each(['exited', 'interrupted', 'theme'])('programmatic %s unavailability resolves the pending reveal and removes its intent listeners before its read returns', async change => {
  await dom.render(pane()); await open('user'); await nativeActionReady()
  const hold = holdNextOriginalResponse(), run = originalControl().run
  const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener')
  try {
    await navigate('native:native:codex:native-a:same', true); await heldResponse(hold)
    let delivered = false; void hold.done.then(() => { delivered = true })
    const registered = add.mock.calls.filter(call => typeof call[1] === 'function' && call[1].name === 'changedIntent')
    expect(registered.map(call => call[0])).toEqual(['pointerdown', 'keydown', 'wheel', 'touchmove', 'focusin'])
    await act(async () => {
      if (change === 'theme') useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, terminalTheme: undefined } } }))
      else useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'agent-1'
        ? { ...session, processState: change } : session) }))
    })
    expect(delivered).toBe(false)
    for (const call of registered) expect(remove.mock.calls.some(removed => removed[0] === call[0] && removed[1] === call[1] && removed[2] === true)).toBe(true)
    expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal'); expect(originalControl().run).toEqual(run)
    if (change !== 'theme') {
      expect(panel().textContent).toContain('当前对话位置尚不可用，Session 已保留')
      expect(panel().querySelector('.log-turn__body')!.textContent).toBe(body)
      expect(panel().querySelector('[aria-label="Copy message"]')).not.toBeNull()
    }
    await releaseResponse(hold)
    expect(delivered).toBe(true); expect(dom.container.querySelector('[data-message-located]')).toBeNull()
    expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal'); expect(dom.draft()).toBe('Keep my draft')
  } finally { hold.release() }
})

it('focus on an equal-source message in another display is later intent rather than this reveal handoff', async () => {
  await dom.render(pane()); await open('user'); await nativeActionReady()
  const hold = holdNextOriginalResponse()
  const externalFeed = document.createElement('div'), external = document.createElement('button')
  externalFeed.className = 'activity-feed'; external.dataset.messageSourceKey = conversationMessageSourceKey('agent-1', { kind: 'native', providerId: 'codex', nativeSessionId: 'native-a', recordId: 'same' })
  externalFeed.append(external); document.body.append(externalFeed)
  try {
    await navigate('native:native:codex:native-a:same'); await heldResponse(hold)
    await act(async () => external.focus()); await releaseResponse(hold)
    expect(document.activeElement).toBe(external); expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
    expect(dom.container.querySelector('[data-message-located]')).toBeNull()
  } finally { hold.release(); externalFeed.remove() }
})

it('never mounts a never-opened Terminal in Activity and preserves the original parked release boundary', async () => {
  useAppStore.setState({ viewModes: { 'agent-1': 'activity' } }); await dom.render(pane()); expect(terminals.mounted).toBe(0)
  await act(async () => useAppStore.getState().setViewMode('agent-1', 'terminal', { focus: false })); expect(terminals.mounted).toBe(1)
  await act(async () => useAppStore.getState().setViewMode('agent-1', 'activity', { focus: false })); expect(terminals.disposed).toBe(0)
  await dom.render(pane('agent-1', true)); expect(terminals.disposed).toBe(1)
})

it('a theme/connecting early return does not invent an already-opened Terminal', async () => {
  useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, terminalTheme: undefined } } }))
  await dom.render(pane()); expect(terminals.mounted).toBe(0)
  await act(async () => useAppStore.getState().setViewMode('agent-1', 'activity', { focus: false }))
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, terminalTheme: 'graphite' } } })))
  await dom.render(pane()); expect(terminals.mounted).toBe(0)
})

it('the presented Mailbox reveals only its proven display occurrence, without broadcasting to another projection', async () => {
  const targets: WorkbenchViewTarget[] = ['one', 'two'].map(id => ({ hostId: `display-${id}`, active: true, visible: true,
    reference: { displayWorkspaceId: 'workspace', groupId: `group-${id}`, tabId: `tab-${id}`, regionId: 'region' } }))
  const hosts = targets.map(target => { const host = document.createElement('div'); host.id = workbenchSessionStageHostId(target, 'region'); document.body.append(host); return host })
  try {
    useAppStore.setState({ viewModes: { 'agent-1': 'activity' } })
    await dom.render(<SessionPane sessionId="agent-1" surfaceKind="agent" interactiveResize={false} visible={false} presentations={targets}
      renderPresentationFrame={content => content} linkOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} />)
    await flush()
    const mailbox = hosts[0]!.querySelector<HTMLElement>('.composer-mailbox')!
    expect(mailbox).not.toBeNull()
    await open('inbox', mailbox); await navigate(`a2a:${originalMessageId}`, false, mailbox)
    await vi.waitFor(() => {
      const marker = hosts[0]!.querySelector<HTMLElement>('.activity-feed .log-turn[data-message-located]')
      expect(marker).not.toBeNull(); expect(document.activeElement).toBe(marker)
    }, { timeout: 8000 })
    const marker = hosts[0]!.querySelector<HTMLElement>('.activity-feed .log-turn[data-message-located]')!
    expect(marker.dataset.messageSourceKey).toBe(conversationMessageSourceKey('agent-1', { kind: 'captured', submissionId: 'same' }))
    expect(hosts[1]!.querySelector('[data-message-located]')).toBeNull(); expect(dom.container.querySelector('[data-message-located]')).toBeNull()
    expect(terminals.mounted).toBe(0); expect(dom.draft()).toBe('Keep my draft')
  } finally { hosts.forEach(host => host.remove()) }
})
