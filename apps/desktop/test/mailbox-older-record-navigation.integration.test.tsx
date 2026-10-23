// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc, type AgentMuxRpcClient, type AgentSessionHistoryPage, type AgentSessionHistoryItem, type AgentProvider } from '@agentmux/core'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { readStyleSheet } from './helpers/styles'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import * as readingDiagnostics from '../src/renderer/src/lib/reading-diagnostic-publication'

const terminal = vi.hoisted(() => ({ mounts: 0, disposals: 0 }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => {
  useEffect(() => { terminal.mounts++; return () => { terminal.disposals++ } }, [])
  return <div data-original-terminal />
} }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'

type NativeFixture = Awaited<ReturnType<typeof nativeHistoryFixture>>
type HistoryPage = Awaited<ReturnType<typeof api.sessions.readHistory>>
type ConversationInput = Parameters<typeof api.conversation.readAgentConversation>[0]
type ConversationPage = Awaited<ReturnType<typeof api.conversation.readAgentConversation>>
const reference = { hostId: 'local', agentSessionId: 'agent-1' }, nativeSessionId = 'original-older-inputs'
const target = { kind: 'native' as const, providerId: 'claude', nativeSessionId, recordId: 'input-0' }
let routeHost: 'local' | 'connected-host' = 'local'
let original: NativeFixture | undefined, rpc: AgentMuxRpcClient | undefined, originalNative: Buffer | undefined
let originalMetadata: Awaited<ReturnType<NativeFixture['store']['loadMetadata']>> | undefined
let nativePages: AgentSessionHistoryPage[] = [], history: HistoryPage[] = []
let frames: Array<{ input: ConversationInput; page?: ConversationPage; error?: string }> = []
let recordReply: ((input: ConversationInput, page: ConversationPage) => Promise<void>) | undefined
let lateReplyProof: Record<string, unknown> | null = null
const closes: Array<() => unknown | Promise<unknown>> = []
// composerDOM's later cleanup unmounts the real host before its source closes.
afterEach(async () => {
  try {
    if (original) {
      expect(original.controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
      // Reader bookkeeping may change its SQLite container. The original
      // Session metadata and Provider transcript remain read-only facts.
      if (originalMetadata) expect(await original.store.loadMetadata()).toEqual(originalMetadata)
      if (originalNative) expect(await readFile(original.path)).toEqual(originalNative)
    }
  } finally {
    try { for (const close of closes.splice(0).reverse()) await close() } finally {
      original = undefined; rpc = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs()
    }
  }
})
const dom = composerDOM()
afterEach(async context => {
  if (process.env.AGENTMUX_MAILBOX_OLDER_FACTS) await appendFile(process.env.AGENTMUX_MAILBOX_OLDER_FACTS,
    JSON.stringify({ test: context.task.name, state: context.task.result?.state, routeHost, sourceDirectory: original?.root,
      originalRun: original?.session.run, nativePages, history, frames, lateReplyProof,
      controls: original?.controls.map(spy => spy.mock.calls.length), viewMode: useAppStore.getState().viewModes['agent-1'],
      ui: dom.container.innerHTML }) + '\n')
})
beforeEach(async () => {
  terminal.mounts = 0; terminal.disposals = 0; nativePages = []; history = []; frames = []
  routeHost = 'local'
  originalMetadata = undefined; originalNative = undefined; recordReply = undefined; lateReplyProof = null
  localStorage.clear(); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', '')
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 600, this.classList.contains('activity-feed') ? 300 : 20)
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  original = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 8 }, (_, index) => ({
    sessionId: nativeSessionId, uuid: `input-${index}`, type: 'user',
    message: { role: 'user', content: `Original recorded input ${index}` }
  }))), { agentSessionId: reference.agentSessionId, nativeSessionId })
  const source = original; closes.push(source.close)
  await source.store.readCapturedHistory(reference.agentSessionId, { limit: 1 })
  originalMetadata = await source.store.loadMetadata()
  originalNative = await readFile(source.path)
  expect(originalMetadata).toHaveLength(1); expect(originalNative.length).toBeGreaterThan(0)
  const nativeRead = source.client['readSessionHistoryPage']
  const nativeReadDescriptor = Object.getOwnPropertyDescriptor(source.client, 'readSessionHistoryPage')
  source.client['readSessionHistoryPage'] = async (id, input, originalSource) => {
    // The built-in Provider still produces every record, version and physical
    // cursor. A small page exercises the actual boundary with only eight originals.
    const page = await nativeRead.call(source.client, id, { ...input, limit: Math.min(input.limit ?? 2, 2) }, originalSource)
    nativePages.push(page); return page
  }
  closes.push(() => {
    if (nativeReadDescriptor) Object.defineProperty(source.client, 'readSessionHistoryPage', nativeReadDescriptor)
    else Reflect.deleteProperty(source.client, 'readSessionHistoryPage')
  })
  const reader = await desktopConversationReadBridge(source, closes, () => [{ hostId: routeHost, client: source.client }])
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (...args) => {
    const receipt: (typeof frames)[number] = { input: args[0] }; frames.push(receipt)
    try {
      const page = await reader.readAgentConversation(...args); receipt.page = page
      if (recordReply && args[0].record) await recordReply(args[0], page)
      return page
    }
    catch (error) { receipt.error = error instanceof Error ? error.message : String(error); throw error }
  })
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(source.root, 'conversation.sock') } })
  const transport = rpc; closes.push(() => transport.dispose())
  vi.spyOn(api.sessions, 'readHistory').mockImplementation(async (current, input, context) => {
    const page = await transport.call('agent.history', { ...input, ...current }, context?.signal ? { signal: context.signal } : {})
    history.push(page); return page
  })
  vi.spyOn(api.sessions, 'inputMailbox').mockImplementation((current, input = {}) => transport.call('agent.input.ls', { ...input, ...current }))
  vi.spyOn(api.sessions, 'listMessages').mockImplementation((current, input) => transport.call('message.ls', {
    ...input, hostId: current.hostId, participantSessionId: current.agentSessionId }))
  const session = composerSession(reference.agentSessionId, source.session.providerId)
  useAppStore.setState({ sessions: [{ ...session, workspacePath: source.root, nativeHandle: source.session.nativeHandle,
    control: { ...session.control, run: source.session.run } }], viewModes: { 'agent-1': 'terminal' },
    timelines: {}, noticeReadReceipts: {}, agentSteerQueues: {}, agentSteerInFlight: {} })
})

async function originalInputs() {
  await dom.render(<SessionPane sessionId={reference.agentSessionId} surfaceKind="agent" interactiveResize={false} visible
    linkOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} />)
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  expect(panel).not.toBeNull()
  const css = readStyleSheet('./tokens.css')
  for (const name of ['--dur-enter', '--ease-enter']) {
    const value = new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(css)?.[1]?.trim()
    expect(value, name).toBeTruthy(); panel.style.setProperty(name, value!)
  }
  const matches = panel.matches.bind(panel); let open = false
  vi.spyOn(panel, 'matches').mockImplementation(selector => selector === ':popover-open' ? open : matches(selector))
  Object.defineProperties(panel, {
    showPopover: { configurable: true, value: () => {
      const before = new Event('beforetoggle'); Object.defineProperty(before, 'newState', { value: 'open' }); panel.dispatchEvent(before)
      open = true; const after = new Event('toggle'); Object.defineProperty(after, 'newState', { value: 'open' }); panel.dispatchEvent(after)
    } },
    hidePopover: { configurable: true, value: () => {
      const before = new Event('beforetoggle'); Object.defineProperty(before, 'newState', { value: 'closed' }); panel.dispatchEvent(before)
      open = false; const after = new Event('toggle'); Object.defineProperty(after, 'newState', { value: 'closed' }); panel.dispatchEvent(after)
    } }
  })
  await act(async () => panel.showPopover())
  const inputs = panel.querySelector<HTMLButtonElement>('[role="tab"][id$="-user-tab"]')!
  expect(inputs).not.toBeNull(); await act(async () => inputs.click())
  let row: HTMLButtonElement | null = null
  await vi.waitFor(() => {
    const confirmed = history.flatMap(page => page.userMessages ?? []).filter(message => message.source.kind === 'native' &&
      message.source.providerId === target.providerId && message.source.nativeSessionId === target.nativeSessionId && message.source.recordId === target.recordId)
    expect(confirmed).toHaveLength(1); expect(confirmed[0]!.agentSessionId).toBe(reference.agentSessionId)
    expect(confirmed[0]!.content).toBe('Original recorded input 0')
    expect(confirmed[0]!.sourceRecord?.record).toEqual({ ...reference, source: target })
    const receipt = history.find(page => page.userMessages?.includes(confirmed[0]!))!
    expect(receipt).toMatchObject({ hostId: routeHost, sourceHostId: reference.hostId, agentSessionId: reference.agentSessionId })
    row = panel.querySelector(`[data-record-key="native:native:claude:${nativeSessionId}:input-0"]`)
    expect(row).not.toBeNull()
  }, { timeout: 8000 })
  await vi.waitFor(() => expect(frames.some(receipt => receipt.page?.window.complete)).toBe(true), { timeout: 8000 })
  expect(frames.flatMap(receipt => receipt.page?.items.flatMap(entry => entry.kind === 'item'
    ? entry.item.records.map(record => record.reference.source.recordId) : []) ?? [])).not.toContain(target.recordId)
  expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
  expect(dom.container.querySelector('.activity-feed')).toBeNull()
  return { panel, row: row! }
}

it.each(['local', 'connected-host'] as const)('an Inputs record read from the original older Provider pages locates its exact record beyond the Pane recent window through %s', async route => {
  routeHost = route
  useAppStore.setState(state => ({
    config: { ...state.config!, hosts: route === 'local' ? state.config!.hosts : [...state.config!.hosts,
      { id: route, kind: 'ssh', hostname: 'unused.invalid', label: 'Original semantic Host route' }] },
    sessions: state.sessions.map(session => session.kind === 'agent' && session.id === reference.agentSessionId
      ? { ...session, hostId: route, control: { ...session.control, hostId: route } } : session)
  }))
  const send = vi.spyOn(api.sessions, 'write'), run = original!.session.run
  const { panel, row } = await originalInputs()
  const action = row!.closest('.composer-mailbox__record')!.querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
  expect(action).not.toBeNull(); expect(action.disabled).toBe(false)
  await act(async () => { action.focus(); action.click() })
  const key = conversationMessageSourceKey(reference.agentSessionId, target)
  let located: HTMLElement | null = null
  await vi.waitFor(() => {
    located = dom.container.querySelector(`.activity-feed [data-message-source-key='${key}'][data-message-located]`)
    expect(located).not.toBeNull(); expect(located!.textContent).toContain('Original recorded input 0')
    expect(document.activeElement).toBe(located)
  }, { timeout: 8000 })
  expect(panel.dataset.state).toBe('closed'); expect(useAppStore.getState().viewModes['agent-1']).toBe('activity')
  const exactReads = frames.filter(receipt => receipt.input.record)
  const recordStarts = exactReads.filter(receipt => !receipt.input.cursor)
  expect(recordStarts, 'Only the target Activity may start an exact record navigation').toHaveLength(1)
  for (const receipt of exactReads) {
    expect(receipt.input).toMatchObject({ hostId: route, agentSessionId: reference.agentSessionId,
      record: { ...reference, source: target } })
    expect(receipt.page).toMatchObject({ hostId: route, sourceHostId: reference.hostId })
  }
  // Wire continuations belong to this same target read, not another summary navigation.
  expect(new Set(exactReads.map(receipt => receipt.page!.window.id)).size).toBe(1)
  const current = useAppStore.getState().sessions.find(session => session.id === reference.agentSessionId)
  if (current?.kind !== 'agent') throw new Error('The original mounted Agent is missing')
  expect(current.control.run).toEqual(run)
  expect(dom.draft()).toBe('Keep my draft'); expect(send).not.toHaveBeenCalled()
  expect(terminal.mounts).toBe(1); expect(terminal.disposals).toBe(0)
})


it('a later feed wheel cancels the original Activity record reply without replacing its visible window and a new explicit reveal still works', async () => {
  const { panel, row } = await originalInputs()
  let replies = 0, produced: ConversationPage | undefined, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  recordReply = async (_input, page) => {
    if (++replies !== 1) return
    produced = page
    await gate
  }
  const sample = () => {
    const consumers = inspectConversationConsumers({ hostId: routeHost, agentSessionId: reference.agentSessionId,
      records: [{ ...reference, source: target }] }).consumers
    expect(consumers).toHaveLength(1)
    return consumers[0]!
  }
  const action = row.closest('.composer-mailbox__record')!.querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
  expect(action).not.toBeNull()
  const run = original!.session.run
  try {
    await act(async () => { action.focus(); action.click() })
    await vi.waitFor(() => {
      expect(produced?.window.complete).toBe(true)
      expect(produced?.window.itemCount).toBe(1)
      expect(sample()).toMatchObject({ loading: true, inFlight: true })
    }, { timeout: 8000 })
    const feed = dom.container.querySelector<HTMLElement>('.activity-feed')!
    expect(feed).not.toBeNull()
    const rows = [...feed.querySelectorAll<HTMLElement>('[data-native-record-id]')]
    expect(rows.map(row => row.dataset.nativeRecordId).sort()).toEqual(['input-6', 'input-7'])
    const before = sample(), focus = document.activeElement, top = feed.scrollTop, requests = frames.length
    expect(before.accepted?.recordCount).toBe(2)
    expect(before.held).toBe(false); expect(feed.contains(focus)).toBe(false)
    expect(document.getSelection()!.isCollapsed).toBe(true)
    // These short original messages have no newer page. A real downward wheel
    // is later intent but must not manufacture an unrelated paging request.
    expect(frames.at(-2)!.page!.window.navigation.newer).toBeNull()
    lateReplyProof = { before: { sample: before, nativeIds: rows.map(row => row.dataset.nativeRecordId), scrollTop: top } }
    await act(async () => feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })))
    lateReplyProof.afterWheel = { sample: sample(), requestCount: frames.length, scrollTop: feed.scrollTop,
      focusSame: document.activeElement === focus }
    expect(frames).toHaveLength(requests)
    expect(document.activeElement).toBe(focus)
    await act(async () => release())
    await vi.waitFor(() => {
      const current = sample(), visible = [...feed.querySelectorAll<HTMLElement>('[data-native-record-id]')]
      lateReplyProof!.afterRelease = { sample: current, nativeIds: visible.map(node => node.dataset.nativeRecordId),
        originalNodesConnected: rows.map(row => row.isConnected), sameNodes: visible.length === rows.length && visible.every((node, index) => node === rows[index]),
        requestCount: frames.length, scrollTop: feed.scrollTop, focusSame: document.activeElement === focus }
      expect(current).toMatchObject({ loading: false, inFlight: false })
      expect(current.accepted).toEqual(before.accepted)
      expect([...feed.querySelectorAll('[data-native-record-id]')]).toEqual(rows)
    }, { timeout: 8000 })
    expect(rows.every(row => row.isConnected)).toBe(true)
    expect(frames).toHaveLength(requests); expect(feed.scrollTop).toBe(top); expect(document.activeElement).toBe(focus)
    expect(feed.querySelector('[data-message-located]')).toBeNull()
    expect(useAppStore.getState().viewModes['agent-1']).toBe('terminal')
    expect(panel.dataset.state).toBe('open'); expect(dom.draft()).toBe('Keep my draft')
    // This is a new explicit user operation, never an automatic replay of the
    // cancelled request. Cancelling one operation cannot poison later settles.
    await act(async () => { action.focus(); action.click() })
    const key = conversationMessageSourceKey(reference.agentSessionId, target)
    await vi.waitFor(() => {
      const located = feed.querySelector<HTMLElement>(`[data-message-source-key='${key}'][data-message-located]`)
      expect(located).not.toBeNull(); expect(document.activeElement).toBe(located)
      expect(located!.textContent).toContain('Original recorded input 0')
    }, { timeout: 8000 })
    expect(panel.dataset.state).toBe('closed')
    const session = useAppStore.getState().sessions.find(session => session.id === reference.agentSessionId)
    if (session?.kind !== 'agent') throw new Error('The original Agent is missing')
    expect(session.control.run).toEqual(run); expect(dom.draft()).toBe('Keep my draft')
    expect(terminal.mounts).toBe(1); expect(terminal.disposals).toBe(0)
  } finally { release() }
})

function activityConsumer() {
  const consumers = inspectConversationConsumers({ hostId: routeHost, agentSessionId: reference.agentSessionId,
    records: [{ ...reference, source: target }] }).consumers
  expect(consumers).toHaveLength(1)
  return consumers[0]!
}

async function explicitReveal(action: HTMLButtonElement, panel: HTMLElement, feed: HTMLElement) {
  await act(async () => { action.focus(); action.click() })
  const key = conversationMessageSourceKey(reference.agentSessionId, target)
  await vi.waitFor(() => {
    const located = feed.querySelector<HTMLElement>(`[data-message-source-key='${key}'][data-message-located]`)
    expect(located).not.toBeNull(); expect(document.activeElement).toBe(located)
    expect(located!.textContent).toContain('Original recorded input 0')
  }, { timeout: 8000 })
  expect(panel.dataset.state).toBe('closed')
  const session = useAppStore.getState().sessions.find(session => session.id === reference.agentSessionId)
  if (session?.kind !== 'agent') throw new Error('The original Agent is missing')
  expect(session.control.run).toEqual(original!.session.run)
  expect(dom.draft()).toBe('Keep my draft')
  expect(terminal.mounts).toBe(1); expect(terminal.disposals).toBe(0)
}

it('a later feed wheel settles a hanging original Activity watch opening without waiting for its reply and a new explicit reveal keeps its observer alive', async () => {
  const { panel, row } = await originalInputs()
  const originalObserve = vi.mocked(api.conversation.observeConversation).getMockImplementation()!
  expect(originalObserve).toBeTypeOf('function')
  type Handle = Awaited<ReturnType<typeof originalObserve>>
  const watches: Array<{ view: Parameters<typeof originalObserve>[0]['view']; handle: Handle }> = []
  let opening: (typeof watches)[number] | undefined, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.conversation.observeConversation).mockImplementation(async (...args) => {
    // Open the real public/IPC/Core observer first. Only its original opening
    // response is delayed; no observation, handle or cancellation is invented.
    const receipt = { view: args[0].view, handle: await originalObserve(...args) }
    watches.push(receipt)
    const exactActivity = frames.find(frame => frame.input.record && !frame.input.cursor)?.page
    if (!opening && exactActivity?.window.view !== undefined && exactActivity.window.view === receipt.view) { opening = receipt; await gate }
    return receipt.handle
  })
  const action = row.closest('.composer-mailbox__record')!.querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
  try {
    await act(async () => { action.focus(); action.click() })
    await vi.waitFor(() => {
      expect(opening).toBeDefined()
      expect(activityConsumer()).toMatchObject({ loading: true, inFlight: true, watch: { binding: true } })
    }, { timeout: 8000 })
    const feed = dom.container.querySelector<HTMLElement>('.activity-feed')!
    const rows = [...feed.querySelectorAll<HTMLElement>('[data-native-record-id]')]
    expect(rows.map(row => row.dataset.nativeRecordId)).toEqual(['input-6', 'input-7'])
    const before = activityConsumer(), top = feed.scrollTop, focus = document.activeElement, requests = frames.length
    expect(before.held).toBe(false); expect(feed.contains(focus)).toBe(false)
    expect(document.getSelection()!.isCollapsed).toBe(true)
    lateReplyProof = { phase: 'watch-opening', before: { sample: before, scrollTop: top } }
    await act(async () => feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })))
    // Cancellation must converge while the same original opening response is
    // still held. Releasing the reply is not a substitute for cancellation.
    await vi.waitFor(() => {
      const current = activityConsumer()
      lateReplyProof!.afterWheel = { sample: current, requestCount: frames.length }
      expect(current).toMatchObject({ loading: false, inFlight: false, watch: { binding: false } })
      expect(current.accepted).toEqual(before.accepted)
    }, { timeout: 8000 })
    expect(frames).toHaveLength(requests)
    expect([...feed.querySelectorAll('[data-native-record-id]')]).toEqual(rows)
    expect(feed.scrollTop).toBe(top); expect(document.activeElement).toBe(focus)
    await act(async () => release())
    await vi.waitFor(() => expect(opening!.handle.closed.aborted).toBe(true), { timeout: 8000 })
    expect(activityConsumer().accepted).toEqual(before.accepted)
    lateReplyProof.afterRelease = { sample: activityConsumer(), originalNodesConnected: rows.map(row => row.isConnected) }
    await explicitReveal(action, panel, feed)
    const acceptedView = frames.filter(frame => frame.input.record).at(-1)!.page!.window.view
    const installed = watches.find(watch => watch.view === acceptedView)!
    expect(installed).toBeDefined(); expect(installed.handle.closed.aborted).toBe(false)
    expect(activityConsumer()).toMatchObject({ loading: false, inFlight: false, watch: { bound: true, closed: false } })
    lateReplyProof.afterRetry = { sample: activityConsumer(), originalSuccessfulWatchClosed: installed.handle.closed.aborted }
  } finally { release() }
})

it('a completed selection-held Activity record frame is discarded after a later feed wheel and a new explicit reveal still works', async () => {
  const { panel, row } = await originalInputs()
  let replies = 0, produced: ConversationPage | undefined, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  recordReply = async (_input, page) => { if (++replies === 1) { produced = page; await gate } }
  const action = row.closest('.composer-mailbox__record')!.querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
  const selection = document.getSelection()!
  try {
    await act(async () => { action.focus(); action.click() })
    await vi.waitFor(() => {
      expect(produced?.window.complete).toBe(true)
      expect(activityConsumer()).toMatchObject({ loading: true, inFlight: true })
    }, { timeout: 8000 })
    const feed = dom.container.querySelector<HTMLElement>('.activity-feed')!
    const rows = [...feed.querySelectorAll<HTMLElement>('[data-native-record-id]')]
    expect(rows.map(row => row.dataset.nativeRecordId)).toEqual(['input-6', 'input-7'])
    const before = activityConsumer(), top = feed.scrollTop, focus = document.activeElement, requests = frames.length
    const range = document.createRange(); range.selectNodeContents(rows[0]!)
    await act(async () => { selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')) })
    expect(selection.isCollapsed).toBe(false)
    await act(async () => release())
    await vi.waitFor(() => {
      const current = activityConsumer()
      expect(current).toMatchObject({ loading: false, inFlight: false, held: true })
      expect(current.accepted).toEqual(before.accepted)
      expect(current.pending?.id).toBe(produced!.window.id)
    }, { timeout: 8000 })
    lateReplyProof = { phase: 'completed-held', before: { sample: before, scrollTop: top },
      completedHeld: activityConsumer() }
    await act(async () => feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })))
    expect(frames).toHaveLength(requests)
    await act(async () => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
    await vi.waitFor(() => {
      const current = activityConsumer(), visible = [...feed.querySelectorAll('[data-native-record-id]')]
      lateReplyProof!.afterRelease = { sample: current, sameNodes: visible.length === rows.length && visible.every((node, index) => node === rows[index]),
        originalNodesConnected: rows.map(row => row.isConnected), requestCount: frames.length, scrollTop: feed.scrollTop, focusSame: document.activeElement === focus }
      expect(current).toMatchObject({ loading: false, inFlight: false, held: false, pending: null })
      expect(current.accepted).toEqual(before.accepted)
      expect(visible).toEqual(rows)
    }, { timeout: 8000 })
    expect(feed.scrollTop).toBe(top); expect(document.activeElement).toBe(focus)
    expect(frames).toHaveLength(requests); expect(feed.querySelector('[data-message-located]')).toBeNull()
    await explicitReveal(action, panel, feed)
    lateReplyProof.afterRetry = activityConsumer()
  } finally { release(); selection.removeAllRanges() }
})


it('old-record navigation and Current keep the original summary receiving later inputs and answer context', async () => {
  const source = original!, run = source.session.run
  const diagnostics = vi.spyOn(readingDiagnostics, 'publishReadingDiagnostic')
  const provider = source.client.providers.get('claude')
  function ownsReading(value: AgentProvider): value is AgentProvider & Required<Pick<AgentProvider, 'readSessionHistoryPage' | 'readConversationChanges'>> {
    return typeof value.readSessionHistoryPage === 'function' && typeof value.readConversationChanges === 'function'
  }
  if (!ownsReading(provider)) throw new Error('The original Provider page/changes owner is unavailable')
  const questionId = 'original-reading-question', questionRecordId = 'live-question', answerRecordId = 'live-answer'
  const prompt = 'Keep receiving the original inputs?', answer = 'Keep the original summary current'
  const revisedQuestion = prompt + ' This is a newer native version.'
  const wire = '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: questionId, question: prompt, answer }]) + '\n</send_user_message_question_reply>'
  const decorate = (item: AgentSessionHistoryItem): AgentSessionHistoryItem => item.id === questionRecordId
    ? { ...item, questionRequest: { delivery: 'async', questions: [{ id: questionId, prompt, options: [], acceptsText: true }] } }
    : item.id === answerRecordId ? { ...item, questionAnswers: [{ questionId, prompt, answer }] } : item
  const pageOwner = provider.readSessionHistoryPage, changesOwner = provider.readConversationChanges
  // The real JSONL converter owns every body, kind, ID, cursor and source. Only
  // optional typed question facts are controlled at that exact Provider leaf.
  vi.spyOn(provider, 'readSessionHistoryPage').mockImplementation(async context => {
    expect(context.agentSessionId).toBe(reference.agentSessionId)
    expect(context.source).toEqual({ providerId: 'claude', nativeSessionId })
    const page = await pageOwner.call(provider, context)
    return { ...page, items: page.items.map(decorate) }
  })
  vi.spyOn(provider, 'readConversationChanges').mockImplementation(async context => {
    expect(context.agentSessionId).toBe(reference.agentSessionId)
    expect(context.source).toEqual({ providerId: 'claude', nativeSessionId })
    const page = await changesOwner.call(provider, context)
    return { ...page, items: page.items.map(decorate) }
  })
  const changes: Awaited<ReturnType<typeof api.conversation.readConversationChanges>>[] = []
  const readChanges = vi.mocked(api.conversation.readConversationChanges).getMockImplementation()!
  vi.mocked(api.conversation.readConversationChanges).mockImplementation(async (...args) => {
    const page = await readChanges(...args); changes.push(page); return page
  })
  await appendFile(source.path, jsonl([{ sessionId: nativeSessionId, uuid: questionRecordId, type: 'assistant',
    message: { role: 'assistant', content: prompt } }]))
  originalNative = await readFile(source.path)
  const scopeRecords = () => diagnostics.mock.calls.map(([record]) => record).filter(record => record.scope.hostId === routeHost &&
    record.scope.agentSessionId === reference.agentSessionId && record.scope.runId === run.runId && record.scope.consumerKind === 'input-summary')
  const { panel, row } = await originalInputs()
  // Only the original Composer/Mailbox summary exists before this exact reveal;
  // the never-opened Pane starts its own distinct consumer when navigation begins.
  const existingConsumers = new Set(scopeRecords().map(record => record.scope.consumerId))
  expect(existingConsumers.size).toBeGreaterThan(0)
  const action = row.closest('.composer-mailbox__record')!.querySelector<HTMLButtonElement>('.composer-mailbox__reveal')!
  expect(action).not.toBeNull()
  await act(async () => { action.focus(); action.click() })
  const key = conversationMessageSourceKey(reference.agentSessionId, target)
  await vi.waitFor(() => expect(dom.container.querySelector(`.activity-feed [data-message-source-key='${key}'][data-message-located]`)).not.toBeNull(), { timeout: 8000 })
  let summaryConsumerId: string | undefined
  await vi.waitFor(() => {
    const introduced = scopeRecords().filter(record => !existingConsumers.has(record.scope.consumerId))
    const active = [...new Set(introduced.map(record => record.scope.consumerId))].filter(id =>
      !introduced.some(record => record.scope.consumerId === id && record.events.some(event => event.phase === 'consumer-ended')))
    expect(active, 'This reveal must create exactly one live original Pane summary consumer').toHaveLength(1)
    summaryConsumerId = active[0]
  }, { timeout: 8000 })
  expect(summaryConsumerId).toBeTypeOf('string')
  expect(summaryConsumerId).not.toBe('')
  expect(panel.dataset.state).toBe('closed')
  const current = dom.container.querySelector<HTMLButtonElement>('[data-conversation-current-entry] button')!
  // Explicit pre-focus/keyboard activation; pointerdown intentionally preserves focus.
  expect(current).not.toBeNull(); await act(async () => { current.focus(); current.click() })
  const summaryEvents = () => scopeRecords().filter(record => record.scope.consumerId === summaryConsumerId).flatMap(record => record.events)
  const summaryEnded = () => summaryEvents().some(event => event.phase === 'consumer-ended')
  const assertSummaryAlive = () => expect(summaryEnded(), 'The fixed original Pane summary consumer must remain live').toBe(false)
  const summaryFrame = () => {
    assertSummaryAlive()
    const accepted = summaryEvents().filter(event => event.phase === 'admission-accepted').at(-1)
    const page = [...frames.flatMap(receipt => receipt.page ? [receipt.page] : []), ...changes].find(page =>
      page.window.id === accepted?.windowId && page.window.revision === accepted?.windowRevision && page.window.complete)
    return { accepted, page }
  }
  // First prove that Current actually reached the exact target DOM and that
  // this summary has settled its own accepted frame; do not wait for it to be correct.
  await vi.waitFor(() => {
    if (summaryEnded()) return
    const rows = [...dom.container.querySelectorAll<HTMLElement>(`[data-native-record-id='${questionRecordId}'] .log-turn__body`)]
    expect(rows).toHaveLength(1); expect(rows[0]!.textContent).toContain(prompt)
    expect(rows[0]!.closest('[hidden], [inert]')).toBeNull()
    const { accepted, page } = summaryFrame()
    expect(page).toBeDefined()
    expect(summaryEvents().some(event => event.phase === 'read-ended' && event.attemptId === accepted?.attemptId)).toBe(true)
  }, { timeout: 8000 })
  assertSummaryAlive()
  const preparedSummary = summaryFrame()
  lateReplyProof = { phase: 'summary-current-intent', summaryAccepted: preparedSummary.accepted,
    summaryPage: preparedSummary.page, targetActivity: activityConsumer(),
    previousConsumerIds: [...existingConsumers], summaryConsumerId, diagnosticScopes: scopeRecords().map(record => ({ scope: record.scope, events: record.events })) }
  const page = preparedSummary.page!
  expect(page!.window.anchor, 'Exact navigation must not freeze the input summary').toBeUndefined()
  const originalQuestion = page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : [])
    .find(record => record.original.kind === 'native' && record.original.item.id === questionRecordId)
  expect(originalQuestion?.reference).toEqual({ ...reference, source: { kind: 'native', providerId: 'claude', nativeSessionId, recordId: questionRecordId } })
  expect(originalQuestion?.revision).toBeTruthy()
  const questionRevision = originalQuestion!.revision
  let card: HTMLElement | null = null, body: HTMLElement | null = null
  await vi.waitFor(() => {
    if (summaryEnded()) return
    card = dom.container.querySelector('[aria-label="Native asynchronous question"]')
    body = dom.container.querySelector(`[data-native-record-id='${questionRecordId}'] .log-turn__body`)
    expect(card).not.toBeNull(); expect(card!.dataset.questionState).toBe('unknown'); expect(body).not.toBeNull()
    expect(body!.textContent).toContain(prompt)
  }, { timeout: 8000 })
  assertSummaryAlive()
  const originalCard = card!, originalBody = body!, node = originalBody.querySelector('.md-paragraph')?.firstChild
  expect(node).toBeDefined()
  const selection = document.getSelection()!, range = document.createRange()
  range.setStart(node!, 0); range.setEnd(node!, 4)
  await act(async () => { selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')) })
  try {
    assertSummaryAlive()
    const eventsBeforeAnswer = Math.max(...summaryEvents().map(event => event.sequence))
    // A plain neighbor append does not replace a selected version. The real
    // Provider UUID update explicitly changes this original question's body in
    // the same native append as the later answer; no presentation state is forced.
    await appendFile(source.path, jsonl([
      { sessionId: nativeSessionId, uuid: questionRecordId, type: 'assistant', message: { role: 'assistant', content: revisedQuestion } },
      { sessionId: nativeSessionId, uuid: answerRecordId, type: 'user', message: { role: 'user', content: wire } }
    ]))
    originalNative = await readFile(source.path)
    // Wait for the real native invalidation and its actual reader outcome. Both
    // normal changes and the old historical deferral are terminal observations;
    // lack of a summary update is asserted below, never qualified as a timeout.
    await vi.waitFor(() => {
      if (summaryEnded()) return
      const later = summaryEvents().filter(event => event.sequence > eventsBeforeAnswer)
      expect(later.some(event => event.phase === 'invalidation-received')).toBe(true)
      expect(later.some(event => event.phase === 'read-ended' && event.operation === 'changes' ||
        event.phase === 'read-deferred' && event.reason === 'historical')).toBe(true)
      const received = changes.flatMap(page => page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : []))
        .find(record => record.original.kind === 'native' && record.original.item.id === answerRecordId)
      expect(received?.reference).toEqual({ ...reference, source: { kind: 'native', providerId: 'claude', nativeSessionId, recordId: answerRecordId } })
      expect(received?.original.kind === 'native' && received.original.item.questionAnswers).toEqual([{ questionId, prompt, answer }])
      const updatedQuestion = changes.flatMap(page => page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : []))
        .findLast(record => record.original.kind === 'native' && record.original.item.id === questionRecordId && record.revision !== questionRevision)
      expect(updatedQuestion?.reference).toEqual(originalQuestion!.reference)
      expect(updatedQuestion?.revision).toBeTruthy(); expect(updatedQuestion?.revision).not.toBe(questionRevision)
      expect(updatedQuestion?.original.kind === 'native' && updatedQuestion.original.item.contentParts)
        .toEqual([expect.objectContaining({ kind: 'text', text: revisedQuestion })])
      expect(activityConsumer().held).toBe(true)
      expect(dom.container.querySelector(`[data-native-record-id='${questionRecordId}'] .log-turn__body`)).toBe(originalBody)
      expect(originalBody.textContent).toContain(prompt); expect(originalBody.textContent).not.toContain(revisedQuestion)
      expect(selection.getRangeAt(0)).toBe(range); expect(selection.toString()).toBe('Keep')
    }, { timeout: 8000 })
    const accepted = summaryEvents().filter(event => event.phase === 'admission-accepted').at(-1)
    const page = [...frames.flatMap(receipt => receipt.page ? [receipt.page] : []), ...changes].find(page => page.window.id === accepted?.windowId && page.window.revision === accepted?.windowRevision && page.window.complete)
    assertSummaryAlive()
    lateReplyProof = { phase: 'summary-after-current', summaryAccepted: accepted, summaryPage: page,
      summaryEvents: summaryEvents().filter(event => event.sequence > eventsBeforeAnswer), originalChanges: changes, targetActivity: activityConsumer(),
      previousConsumerIds: [...existingConsumers], summaryConsumerId, diagnosticScopes: scopeRecords().map(record => ({ scope: record.scope, events: record.events })) }
    expect(page, 'The original summary must have an accepted frame').toBeDefined()
    const originals = page!.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : [])
    const received = originals.find(record => record.original.kind === 'native' && record.original.item.id === answerRecordId)
    expect(received?.reference, 'The original summary must accept the later input after Current').toEqual({ ...reference,
      source: { kind: 'native', providerId: 'claude', nativeSessionId, recordId: answerRecordId } })
    expect(received?.original.kind === 'native' && received.original.item.questionAnswers).toEqual([{ questionId, prompt, answer }])
    await vi.waitFor(() => {
      if (summaryEnded()) return
      expect(originalCard.dataset.questionState, 'The original summary supplies later answer context to the retained Activity').toBe('answered')
      expect(originalCard.querySelector('.agent-question__answer')?.textContent).toBe(answer)
    }, { timeout: 8000 })
    assertSummaryAlive()
    expect(dom.container.querySelector('[aria-label="Native asynchronous question"]')).toBe(originalCard)
    expect(dom.container.querySelector(`[data-native-record-id='${questionRecordId}'] .log-turn__body`)).toBe(originalBody)
    expect(selection.anchorNode).toBe(node); expect(selection.focusNode).toBe(node); expect(selection.toString()).toBe('Keep')
    expect(useAppStore.getState().viewModes['agent-1']).toBe('activity'); expect(dom.draft()).toBe('Keep my draft')
    expect(frames.filter(receipt => receipt.input.record && !receipt.input.cursor)).toHaveLength(1)
    expect(terminal.mounts).toBe(1); expect(terminal.disposals).toBe(0)
    const session = useAppStore.getState().sessions.find(session => session.id === reference.agentSessionId)
    expect(session?.kind === 'agent' && session.control.run).toEqual(run)
  } finally { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }
})
