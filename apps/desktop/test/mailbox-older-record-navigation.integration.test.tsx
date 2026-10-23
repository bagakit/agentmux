// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc, type AgentMuxRpcClient, type AgentSessionHistoryPage } from '@agentmux/core'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { readStyleSheet } from './helpers/styles'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'

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
  expect(exactReads.length).toBeGreaterThanOrEqual(2)
  for (const receipt of exactReads) {
    expect(receipt.input).toMatchObject({ hostId: route, agentSessionId: reference.agentSessionId,
      record: { ...reference, source: target } })
    expect(receipt.page).toMatchObject({ hostId: route, sourceHostId: reference.hostId })
  }
  // The Pane summary and actual Activity use their own original Core windows;
  // an accepted frame belonging to the Mailbox cannot substitute either one.
  expect(new Set(exactReads.map(receipt => receipt.page!.window.id)).size).toBe(2)
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
    if (++replies !== 2) return
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
    expect(useAppStore.getState().viewModes['agent-1']).toBe('activity')
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
    const exactActivity = frames.filter(frame => frame.input.record)[1]?.page
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
  recordReply = async (_input, page) => { if (++replies === 2) { produced = page; await gate } }
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
