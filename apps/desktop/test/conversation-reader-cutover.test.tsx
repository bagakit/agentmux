// @vitest-environment happy-dom
import { act } from 'react'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { api } from '../src/renderer/src/lib/api'
import type { AgentSessionControl } from '../src/shared/contracts'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { consumeConversationWindowPage, parseConversationReadPage } from '@agentmux/core/conversation'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { activityReadingProps } from './helpers/activity-reading-props'
import { unifiedConversationOriginals } from '../../../packages/core/test/helpers/conversation-unified-originals'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { composerSession, composerConfig } from './helpers/composer-dom-fixture'
import { savedQuestionFixture, savedQuestionSource, savedQuestionId, savedQuestionPrompt, savedQuestionAnswer } from '../../../packages/core/test/helpers/codex-saved-question'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'



const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
let current: ReturnType<typeof useSessionUserMessages>
function Consumer({ control, active = true }: { control: AgentSessionControl; active?: boolean }) {
  current = useSessionUserMessages(control, { enabled: active })
  const snapshot = current.conversation.snapshot, reading = snapshot ? projectConversationWindow(snapshot) : null
  return <ConversationView sessionId={control.agentSessionId} page={reading?.historyPage ?? null} timeline={reading?.captured}
    records={reading?.records ?? []} originalRecords={reading?.originalRecords ?? []} coverage={reading?.timeline.coverage ?? []} active={active} />
}
const flush = (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); assertion() }, { timeout: 10000 })

const desktopBridge = (f: Parameters<typeof desktopConversationReadBridge>[0], clients?: Parameters<typeof desktopConversationReadBridge>[2]) => desktopConversationReadBridge(f, closes, clients)

function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, root }
}
it('actual Desktop bridge consumes one original public Reader frame and same-cut changes, then releases inactive observation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'input-original', sessionId: 'native-main',
    message: { role: 'user', content: 'Exact original first body' } }]))
  closes.push(f.close)
  await desktopBridge(f)
  const nativeRaw = vi.spyOn(api.sessions, 'historyPage'), capturedRaw = vi.spyOn(api.sessions, 'timeline')
  const inspect = vi.spyOn(f.client, 'readAgentConversation'), changes = vi.spyOn(f.client, 'readConversationChanges')
  const watches = vi.spyOn(f.client, 'observeConversation')
  const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => root.render(<Consumer control={control} />))
  await flush(() => { expect(host.textContent, current.error?.stack ?? current.observationError?.stack).toContain('Exact original first body'); expect(current.loading).toBe(false) })
  const windowId = current.conversation.snapshot!.window.id
  expect(inspect).toHaveBeenCalled(); await flush(() => expect(changes).toHaveBeenCalled())
  await appendFile(f.path, jsonl([{ type: 'assistant', uuid: 'reply-original', sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'text', text: 'Exact later original answer' }] } }]))
  await flush(() => expect(host.textContent).toContain('Exact later original answer'))
  expect(current.conversation.snapshot!.window.id).toBe(windowId)
  expect(current.conversation.snapshot!.units.flatMap(unit => unit.records.map(record => record.original.item.id)).sort()).toEqual(['input-original', 'reply-original'])
  const originalObservation = await watches.mock.results.at(-1)!.value
  await act(async () => {
    originalObservation.dispose()
    await appendFile(f.path, jsonl([{ type: 'assistant', uuid: 'after-observer-reopen', sessionId: 'native-main', message: { role: 'assistant', content: 'Original reader reconnected without reopening the source head' } }]))
  })
  await flush(() => expect(host.textContent).toContain('Original reader reconnected without reopening the source head'))
  expect(current.conversation.snapshot!.window.id).toBe(windowId)
  expect(inspect.mock.calls.at(-1)![0].view).toBeTruthy()
  expect(nativeRaw).not.toHaveBeenCalled(); expect(capturedRaw).not.toHaveBeenCalled()
  const calls = inspect.mock.calls.length + changes.mock.calls.length
  await act(async () => root.render(<Consumer control={control} active={false} />))
  await appendFile(f.path, jsonl([{ type: 'assistant', uuid: 'inactive-original', sessionId: 'native-main', message: { role: 'assistant', content: 'Inactive answer' } }]))
  await new Promise(resolve => setTimeout(resolve, 120))
  expect(inspect.mock.calls.length + changes.mock.calls.length).toBe(calls)
  expect(host.textContent).toContain('Exact later original answer')
  await act(async () => root.render(<Consumer control={control} />))
  await flush(() => { expect(current.conversation.snapshot!.window.id).toBe(windowId); expect(host.textContent).toContain('Inactive answer') })
  expect(inspect.mock.calls.at(-1)![0].view).toBeTruthy()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

async function inventory() {
  const original = unifiedConversationOriginals(), usage = original.native.metrics!.usage!
  const native = { sessionId: original.source.nativeSessionId, uuid: original.native.id, type: 'assistant',
    timestamp: new Date(original.native.startedAt!).toISOString(), message: { role: 'assistant',
      content: original.native.contentParts.map(part => { if (part.kind !== 'text') throw Error('Bounded original changed shape'); return { type: 'text', text: part.text } }),
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cachedInputTokens } } }
  const f = await nativeHistoryFixture('claude', jsonl([native, original.claudeTool]), { nativeSessionId: original.source.nativeSessionId, agentSessionId: original.agentSessionId }); closes.push(f.close)
  for (const item of [original.captured, original.capturedTool, { id: 'joint-unread-observation', agentSessionId: original.agentSessionId,
    kind: 'tool_call' as const, source: 'native-hook' as const, status: 'complete' as const, title: 'Original target remains unread',
    content: 'Readable observation with an unread exact target', createdAt: _historyFixtureEpoch(0, 0, 400), updatedAt: _historyFixtureEpoch(0, 0, 400),
    conversation: { observes: { hostId: 'local', agentSessionId: original.agentSessionId, source: { kind: 'native' as const, ...original.source, recordId: 'joint-unread-target' } } } }])
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: original.agentSessionId, item })
  return { f, original }
}
it('actual Activity reads the retained unified inventory through IPC/RPC and keeps unjoined Hook speech in an expandable observation', async () => {
  const { f, original } = await inventory(); await desktopBridge(f)
  const rawNative = vi.spyOn(api.sessions, 'historyPage'), rawCaptured = vi.spyOn(api.sessions, 'timeline')
  const { host, root } = mount(), control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const props = activityReadingProps({ control, workspaceRoot: f.root })
  await act(async () => root.render(<ActivityView {...props} />))
  await flush(() => expect(host.querySelectorAll('[data-native-record-id]'), host.textContent).toHaveLength(2))
  const observation = host.querySelector<HTMLElement>('[data-captured-reply-observation]')!
  expect(observation.dataset.capturedReplyObservation).toBe(original.captured.id)
  const toggle = observation.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(observation.querySelector('.log-turn')).toBeNull()
  expect(host.querySelectorAll('.log-turn[data-speaker-role="agent"]')).toHaveLength(2)
  await act(async () => toggle.click())
  expect(observation.textContent).toContain('6ff13b0bb3832586eea50913951a50d7de2cb9715ea6b72274d8beec806a0ba5')
  expect(observation.querySelector('.log-turn')?.getAttribute('data-recorded-identity')).toBe('true')
  const copied = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await act(async () => observation.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copied).toHaveBeenLastCalledWith(original.captured.content)
  expect(host.querySelector('[data-native-record-id="' + original.native.id + '"]')?.textContent).toContain('ac700ed633')
  expect(rawNative).not.toHaveBeenCalled(); expect(rawCaptured).not.toHaveBeenCalled()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
it('automatic Activity coverage keeps the retained head live and clears the latest affordance after catch-up', async () => {
  const at = Date.now(), originals = Array.from({ length: 150 }, (_, index) => ({ type: 'user', uuid: 'coverage-' + index, sessionId: 'native-main',
    timestamp: new Date(at - (150 - index) * 1000).toISOString(), message: { role: 'user', content: 'Original coverage body ' + index } }))
  const f = await nativeHistoryFixture('claude', jsonl(originals)); closes.push(f.close); await desktopBridge(f)
  const inspect = vi.spyOn(f.client, 'readAgentConversation'), changes = vi.spyOn(f.client, 'readConversationChanges')
  const { host, root } = mount(), props = activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })
  await act(async () => root.render(<ActivityView {...props} />))
  await flush(() => { expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(150); expect(inspect.mock.calls.some(([input]) => Boolean(input.cursor))).toBe(true) })
  await appendFile(f.path, jsonl([{ type: 'assistant', uuid: 'after-coverage', sessionId: 'native-main', timestamp: new Date(at + 1000).toISOString(), message: { role: 'assistant', content: 'A live tail after automatic coverage' } }]))
  await flush(() => { expect(host.textContent).toContain('A live tail after automatic coverage'); expect(host.querySelector('[data-message-tool-control="jump-to-latest"]')).toBeNull() })
  expect(changes).toHaveBeenCalled(); expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
it('explicit latest supersedes an in-flight older read and rejects its late frame without losing the live watch', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 150 }, (_, index) => ({ type: 'user', uuid: 'inflight-' + index,
    sessionId: 'native-main', message: { role: 'user', content: 'Original in-flight body ' + index } })))); closes.push(f.close)
  const port = await desktopBridge(f), reference = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  // A late transport may ignore cancellation. The real RPC/IPC chain still
  // returns its original frame; the presentation generation must reject it.
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(input => port.readAgentConversation(input))
  let view: ReturnType<typeof useConversationView>
  function NavigationConsumer() { view = useConversationView(api.conversation, reference, true); return <output>{view.snapshot?.window.id}</output> }
  const { root } = mount(); await act(async () => root.render(<NavigationConsumer />))
  await flush(() => { expect(view!.snapshot?.units).toHaveLength(100); expect(view!.loading).toBe(false) })
  await act(async () => { await view!.settle() })
  const prior = view!.snapshot!, original = f.client.readAgentConversation.bind(f.client)
  let release!: () => void, entered!: () => void, returned = false, delayed = false
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const inspect = vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    const hold = Boolean(input.cursor && !delayed)
    if (hold) delayed = true
    const page = await original(input, options)
    if (hold) { entered(); await gate; returned = true }
    return page
  })
  let older!: Promise<unknown>
  try {
    await act(async () => { older = view!.earlier(); await started })
    let latest!: Promise<void>
    await act(async () => { latest = view!.refresh(); await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(inspect.mock.calls.some(([input]) => !input.cursor && !input.view), 'latest must start before the older frame returns').toBe(true)
    await act(async () => { await latest })
    const accepted = view!.snapshot!
    expect(accepted.window.id).not.toBe(prior.window.id); expect(accepted.units).toHaveLength(100)
    release(); await act(async () => { await older })
    expect(returned).toBe(true); expect(view!.snapshot).toBe(accepted)
    expect(view!.loading).toBe(false); expect(view!.error).toBeNull(); expect(view!.observationError).toBeNull()
    await appendFile(f.path, jsonl([{ type: 'assistant', uuid: 'after-superseded-read', sessionId: 'native-main',
      message: { role: 'assistant', content: 'The latest watch survived the superseded original frame' } }]))
    await flush(() => expect(view!.snapshot!.units.some(unit => unit.records.some(record => record.original.item.id === 'after-superseded-read'))).toBe(true))
    expect(view!.snapshot!.window.id).toBe(accepted.window.id)
    expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  } finally { release(); await act(async () => { await older }) }
})
it('the actual shared consumer holds an evicted head, then catches up its original cut when newer navigation returns to the head', async () => {
  const originals = Array.from({ length: 1400 }, (_, index) => ({ type: 'user', uuid: 'bounded-' + index, sessionId: 'native-main', message: { role: 'user', content: 'Bounded original ' + index } }))
  const f = await nativeHistoryFixture('claude', jsonl(originals)); closes.push(f.close); await desktopBridge(f)
  const changes = vi.spyOn(f.client, 'readConversationChanges'), reference = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  let view: ReturnType<typeof useConversationView>
  function NavigationConsumer() { view = useConversationView(api.conversation, reference, true); return <output>{view.snapshot?.units.length ?? 0}</output> }
  const { host, root } = mount(); await act(async () => root.render(<NavigationConsumer />))
  await flush(() => { expect(host.textContent).toBe('100'); expect(changes).toHaveBeenCalled() })
  await act(async () => { await view!.settle() })
  for (let index = 0; index < 12; index++) await act(async () => { await view!.earlier() })
  expect(view!.historical).toBe(true); expect(view!.snapshot!.window.navigation.newer).toBeTruthy(); expect(host.textContent).toBe('1200')
  const frame = view!.snapshot, reads = changes.mock.calls.length
  await act(async () => { await appendFile(f.path, jsonl([{ type: 'assistant', uuid: 'after-evicted-head', sessionId: 'native-main', message: { role: 'assistant', content: 'Original update after the retained head left' } }])); await new Promise(resolve => setTimeout(resolve, 160)) })
  expect(changes.mock.calls.length).toBe(reads); expect(view!.snapshot).toBe(frame); expect(view!.newerAvailable).toBe(true)
  await act(async () => { await view!.newer() })
  await flush(() => {
    expect(view!.snapshot!.units.some(unit => unit.records.some(record => record.original.item.id === 'after-evicted-head'))).toBe(true)
    expect(view!.historical).toBe(false); expect(view!.newerAvailable).toBe(false)
  })
  await act(async () => { await view!.settle() })
  const original = view!.snapshot!.units.at(-1)!.records[0]!, frontier = view!.snapshot!.window.checkpoint
  await act(async () => { await view!.reveal({ record: original.reference!, revision: original.revision, frontier }) })
  expect(view!.snapshot!.units.flatMap(unit => unit.records).map(record => record.id)).toEqual([original.id])
  expect(view!.snapshot!.units[0]!.records[0]!.original).toEqual(original.original)
  const anchored = view!.snapshot!
  expect(anchored.window.anchor).toEqual({ record: original.reference!, revision: original.revision, frontier })
  expect(anchored.window.navigation).toEqual({ older: null, newer: null }); expect(view!.historical).toBe(true)
  expect(anchored.sourceHostId).toBe(frontier.sourceHostId); expect(anchored.scope).toEqual(frontier.frontier.scope)
  expect(anchored.coverage.every(source => source.current !== 'complete-through-cut')).toBe(true)
  const anchoredReads = changes.mock.calls.length
  await act(async () => { await appendFile(f.path, jsonl([{ type: 'assistant', uuid: 'after-exact-anchor', sessionId: 'native-main', message: { role: 'assistant', content: 'Later, outside the exact original version' } }])); await new Promise(resolve => setTimeout(resolve, 160)) })
  expect(view!.snapshot).toBe(anchored); expect(changes.mock.calls.length).toBe(anchoredReads); expect(view!.newerAvailable).toBe(true)
  await expect(api.conversation.readConversationChanges({ ...reference, view: anchored.window.view!, checkpoint: anchored.window.checkpoint })).rejects.toThrow(/exact original version/)
  const anchorInput = { ...reference, view: anchored.window.view!, limit: 100 }
  const anchorPage = await api.conversation.readAgentConversation(anchorInput)
  const wrongRecord = structuredClone(anchorPage)
  wrongRecord.window.anchor = { ...wrongRecord.window.anchor!, record: { ...wrongRecord.window.anchor!.record, source: { ...wrongRecord.window.anchor!.record.source, recordId: 'another-original' } } }
  expect(() => consumeConversationWindowPage(parseConversationReadPage(wrongRecord, anchorInput))).toThrow(/anchor|original record/)
  const missingAnchor = structuredClone(anchorPage); delete missingAnchor.window.anchor
  expect(() => parseConversationReadPage(missingAnchor, { ...anchorInput, anchor: anchored.window.anchor! })).toThrow(/anchor/)
  await act(async () => { await view!.resume() }); expect(view!.snapshot!.window.anchor).toEqual(anchored.window.anchor); expect(view!.historical).toBe(true)
  await act(async () => { await view!.refresh() })
  await flush(() => { expect(view!.snapshot!.units.some(unit => unit.records.some(record => record.original.item.id === 'after-exact-anchor'))).toBe(true); expect(view!.historical).toBe(false); expect(view!.newerAvailable).toBe(false) })
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
}, 30000)
it('actual Mobile uses the original Hosted public Reader for the same inventory and parks its frame while hidden', async () => {
  const { f, original } = await inventory()
  vi.spyOn(f.client, 'connect').mockRejectedValue(new Error('Declared unavailable isolated Runtime'))
  vi.spyOn(f.client, 'statusAgent').mockRejectedValue(new Error('Declared unavailable isolated Runtime observation'))
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => ({ runtimeId: 'original-isolated-runtime', ownerInstanceId: 'original-isolated-owner', protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null })); closes.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'mobile.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => service })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc, waitForReady: false }); closes.push(() => client.dispose())
  const rawNative = vi.spyOn(client, 'sessionHistoryPage'), rawCaptured = vi.spyOn(client, 'sessionTimeline')
  const inspect = vi.spyOn(f.client, 'readAgentConversation'), changes = vi.spyOn(f.client, 'readConversationChanges')
  const platform = { copyText: vi.fn(async () => true), overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  const { host, root } = mount()
  const render = (visible = true) => root.render(<MobileConversationSurface client={client} agentSessionId={f.session.agentSessionId}
    connection={{ state: 'connected', message: 'Original private Host' }} platform={platform} visible={visible} />)
  await act(async () => render())
  await flush(() => expect(host.querySelectorAll('[data-native-record-id]'), host.textContent).toHaveLength(2))
  expect(host.querySelector('[data-captured-reply-observation]')?.getAttribute('data-captured-reply-observation')).toBe(original.captured.id)
  expect(host.querySelector('[data-captured-reply-observation] button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
  await flush(() => expect(changes).toHaveBeenCalled())
  await act(async () => render(false)); const count = inspect.mock.calls.length + changes.mock.calls.length
  await act(async () => { await appendFile(f.path, jsonl([{ type: 'assistant', uuid: 'mobile-hidden-new', sessionId: original.source.nativeSessionId, message: { role: 'assistant', content: 'Mobile hidden original update' } }])); await new Promise(resolve => setTimeout(resolve, 120)) })
  expect(inspect.mock.calls.length + changes.mock.calls.length).toBe(count)
  await act(async () => render())
  await flush(() => expect(host.textContent).toContain('Mobile hidden original update'))
  expect(inspect.mock.calls.at(-1)![0].view).toBeTruthy()
  expect(rawNative).not.toHaveBeenCalled(); expect(rawCaptured).not.toHaveBeenCalled()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
it('actual Focus retains read Context frames and exact pinned versions while unread Contexts perform no conversation reads', async () => {
  const at = new Date().toISOString()
  const row = (id: string, content: string, sessionId = 'native-main') => ({ type: 'user', uuid: id, sessionId, timestamp: at, message: { role: 'user', content } })
  const f = await nativeHistoryFixture('claude', jsonl([row('focus-original', 'Focus original input')])); closes.push(f.close)
  const second = await nativeHistoryFixture('claude', jsonl([row('focus-second', 'Second Context original input', 'second-native')]), { agentSessionId: 'second-context', nativeSessionId: 'second-native' }); closes.push(second.close)
  const secondSession = { ...second.session, run: { runId: 'second-original-run' }, hookBindingId: 'second-original-binding' }
  await f.store.compareAndSwap(null, secondSession)
  await desktopBridge(f)
  const baseline = useAppStore.getState(); closes.push(() => useAppStore.setState(baseline, true))
  const session = { ...composerSession(f.session.agentSessionId, 'claude'), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run } }
  const another = { ...composerSession(secondSession.agentSessionId, 'claude'), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: secondSession.agentSessionId, run: secondSession.run } }
  const unread = composerSession('unread-context', 'claude')
  const nativeRaw = vi.spyOn(api.sessions, 'historyPage'), capturedRaw = vi.spyOn(api.sessions, 'timeline')
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  useAppStore.setState({ sessions: [session, another, unread], config: composerConfig, timelines: {}, tabs: {}, layouts: {}, agentNames: {}, agentComposerDrafts: { [session.id]: 'Original Focus draft' } })
  const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
  const { host, root } = mount(), inspect = vi.spyOn(f.client, 'readAgentConversation'), changes = vi.spyOn(f.client, 'readConversationChanges')
  const render = (id: string, visible = true) => root.render(<RecentFocusTimeline contexts={contexts} entries={[]} currentSessionId={id} visible={visible} onSelect={() => { throw Error('Reading cannot navigate execution') }} />)
  const count = () => Number(host.querySelector('[data-read-source-count]')?.getAttribute('data-read-source-count'))
  await act(async () => render(session.id))
  await flush(() => expect(count()).toBe(1))
  await flush(() => expect(changes).toHaveBeenCalled())
  await act(async () => render(another.id))
  await flush(() => expect(count()).toBe(2))
  await act(async () => render(session.id))
  await flush(() => expect(inspect.mock.calls.at(-1)![0]).toMatchObject({ agentSessionId: session.id, view: expect.any(String) }))
  const before = inspect.mock.calls.length + changes.mock.calls.length
  await act(async () => render(session.id, false))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
  expect(inspect.mock.calls.length + changes.mock.calls.length).toBe(before)
  await act(async () => render(session.id))
  await flush(() => expect(inspect.mock.calls.length).toBeGreaterThan(before - changes.mock.calls.length))
  await act(async () => { await Promise.allSettled([changes.mock.results.at(-1)?.value]); await new Promise(resolve => setTimeout(resolve, 80)) })
  const marker = host.querySelector<HTMLButtonElement>('[data-message-raw-id="focus-original"]')!
  await act(async () => marker.click())
  await flush(() => expect(document.querySelector('[role="dialog"].recent-focus__message-preview')?.textContent).toContain('Focus original input'))
  const bytes = host.querySelector('[data-read-bytes]')!.getAttribute('data-read-bytes'), changed = changes.mock.calls.length
  await act(async () => { await appendFile(f.path, jsonl([row('focus-original', 'Exact later version of the same original focus input')])) })
  await flush(() => expect(changes.mock.calls.length).toBeGreaterThan(changed))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
  expect(host.querySelector('[data-read-bytes]')!.getAttribute('data-read-bytes')).toBe(bytes)
  expect(document.querySelector('[role="dialog"].recent-focus__message-preview')?.textContent).toContain('Focus original input')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close message"]')!.click())
  await flush(() => expect(host.querySelector('[data-read-bytes]')!.getAttribute('data-read-bytes')).not.toBe(bytes))
  expect(inspect.mock.calls.every(([input]) => input.agentSessionId !== unread.id)).toBe(true)
  expect(count()).toBe(2)
  expect(host.querySelector('[data-mounted-reader-count]')!.getAttribute('data-mounted-reader-count')).toBe('2')
  expect(nativeRaw).not.toHaveBeenCalled(); expect(capturedRaw).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original Focus draft')
})
it('a replaced same-SID source epoch cannot revive a parked view by equal revision, and explicit refresh opens the new exact scope', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'old-original', sessionId: 'native-main', message: { role: 'user', content: 'Old exact source body' } }])); closes.push(f.close)
  const other = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'new-original', sessionId: 'native-main', message: { role: 'user', content: 'New exact source body' } }])); closes.push(other.close)
  for (const value of [f, other]) await value.store.applyTimelineMutation({ type: 'append', agentSessionId: value.session.agentSessionId,
    item: { id: 'same-record', agentSessionId: value.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Original input', content: value === f ? 'Old captured body' : 'New captured body', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) } })
  let owner = f.client
  await desktopBridge(f, () => [{ hostId: 'local', client: owner }])
  const { host, root } = mount(), control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  await act(async () => root.render(<Consumer control={control} />))
  await flush(() => { expect(host.textContent).toContain('Old exact source body'); expect(current.loading).toBe(false) })
  const original = current.conversation.snapshot!
  await act(async () => root.render(<Consumer control={control} active={false} />))
  owner = other.client
  await act(async () => root.render(<Consumer control={control} />))
  await flush(() => expect(current.error?.message).toMatch(/expired/))
  expect(current.conversation.snapshot!.window.id).toBe(original.window.id)
  expect(host.textContent).toContain('Old exact source body'); expect(host.textContent).not.toContain('New exact source body')
  await act(async () => { await current.refresh() })
  await flush(() => expect(host.textContent).toContain('New exact source body'))
  expect(current.conversation.snapshot!.scope).not.toEqual(original.scope)
  expect(current.conversation.snapshot!.window.revision).toBe(1)
})

it('the actual Desktop consumer rejects a different valid view before comparing equal numeric revisions', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'exact-original', sessionId: 'native-main', message: { role: 'user', content: 'The accepted original frame' } }])); closes.push(f.close)
  await desktopBridge(f)
  const changes = vi.spyOn(f.client, 'readConversationChanges'), { host, root } = mount()
  const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  await act(async () => root.render(<Consumer control={control} />))
  await flush(() => { expect(host.textContent).toContain('The accepted original frame'); expect(changes).toHaveBeenCalled() })
  await act(async () => { await current.conversation.settle(); await new Promise(resolve => setTimeout(resolve, 80)) })
  const original = current.conversation.snapshot!, ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const other = await f.client.readAgentConversation({ ...ref, limit: 100 })
  let wrong = await f.client.readConversationChanges({ ...ref, view: other.window.view!, checkpoint: other.window.checkpoint, limit: 100 })
  while (wrong.window.revision < original.window.revision) wrong = await f.client.readConversationChanges({ ...ref, view: wrong.window.view!, checkpoint: wrong.window.checkpoint, limit: 100 })
  expect(wrong.scope).toEqual(original.scope); expect(wrong.window.revision).toBe(original.window.revision); expect(wrong.window.id).not.toBe(original.window.id)
  // Inject a misrouted, otherwise real and codec-valid response at the Core RPC
  // service boundary. The Renderer must fence exact view identity, even at rev N.
  changes.mockResolvedValueOnce(wrong)
  await act(async () => { await current.conversation.changes() })
  expect(current.error?.message).toContain('original conversation scope changed')
  expect(current.conversation.snapshot).toEqual(original)
  expect(host.textContent).toContain('The accepted original frame')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('actual Focus consumes the same five-original unified inventory as Desktop and Mobile', async () => {
  const { f, original } = await inventory(); await desktopBridge(f)
  vi.spyOn(Date, 'now').mockReturnValue(original.captured.createdAt + 1000)
  const baseline = useAppStore.getState(); closes.push(() => useAppStore.setState(baseline, true))
  const session = { ...composerSession(f.session.agentSessionId, 'claude'), control: { kind: 'agent' as const, hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run } }
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  const raw = [vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline')]
  useAppStore.setState({ sessions: [session], config: composerConfig, timelines: {}, tabs: {}, layouts: {}, agentNames: {} })
  const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts, { host, root } = mount()
  await act(async () => root.render(<RecentFocusTimeline contexts={contexts} entries={[]} currentSessionId={session.id} onSelect={() => { throw Error('Reading cannot navigate execution') }} />))
  await flush(() => {
    expect(host.querySelector('[data-native-record-count]')?.getAttribute('data-native-record-count')).toBe('2')
    expect(host.querySelector('[data-captured-record-count]')?.getAttribute('data-captured-record-count')).toBe('3')
  })
  const marker = host.querySelector<HTMLButtonElement>('[data-message-raw-id="' + original.native.id + '"]')!
  expect(marker).not.toBeNull(); await act(async () => marker.click())
  await flush(() => expect(document.querySelector('[role="dialog"].recent-focus__message-preview')?.textContent).toContain('ac700ed633'))
  expect(raw.map(spy => spy.mock.calls.length)).toEqual([0, 0])
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('the original Codex question and late recorded answer reach actual Activity through the public Reader without dispatching a reply', async () => {
  const originals = unifiedConversationOriginals(), f = await savedQuestionFixture(originals.codexRows.slice(0, 3), { unifiedCapturedRead: true }); closes.push(f.close)
  await desktopBridge(f)
  const { host, root } = mount(), control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const draft = vi.fn(), terminal = vi.fn(), changes = vi.spyOn(f.client, 'readConversationChanges')
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control, workspaceRoot: f.root })}
    questionReplyRoute="terminal" questionTerminalTarget={{ source: savedQuestionSource, run: f.session.run }} onQuestionDraftChange={draft} onOpenQuestionTerminal={terminal} />))
  await flush(() => expect(host.querySelector('[aria-label="Native asynchronous question"] fieldset')?.getAttribute('data-question-id')).toBe(savedQuestionId))
  expect(host.querySelector('[aria-label="Native asynchronous question"] legend')?.textContent).toBe(savedQuestionPrompt)
  await flush(() => expect(changes).toHaveBeenCalled())
  await act(async () => { await appendFile(f.transcriptPath, jsonl([originals.codexRows[3]])) })
  await flush(() => expect(host.querySelector('[data-question-state="answered"] .agent-question__answer')?.textContent).toContain(savedQuestionAnswer))
  expect(draft).not.toHaveBeenCalled(); expect(terminal).not.toHaveBeenCalled()
  for (const toggle of host.querySelectorAll<HTMLButtonElement>('.conversation-record-process .wf-head[aria-expanded="false"]')) await act(async () => toggle.click())
  expect(host.querySelectorAll('[data-native-step-id="original-tool-record"]')).toHaveLength(1)
  expect(host.querySelectorAll('[data-native-step-id="original-tool-result"]')).toHaveLength(1)
})

it('actual Activity retains a selected original native body through changes and reads its exact resource via the original Core capability', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
  const original = { type: 'user', uuid: 'original-image-input', sessionId: 'native-main', user_message_uuid: 'original-image-turn',
    message: { role: 'user', content: [{ type: 'text', text: 'Original **selected words** body' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } }
  const f = await nativeHistoryFixture('claude', jsonl([original])); closes.push(f.close); await desktopBridge(f)
  const { host, root } = mount(), control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const resources = vi.spyOn(f.client, 'sessionHistoryResource'), changes = vi.spyOn(f.client, 'readConversationChanges')
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control, workspaceRoot: f.root })}
    readHistoryResource={input => f.client.sessionHistoryResource(control.agentSessionId, input)} />))
  await flush(() => expect(host.querySelector('.md-conversation-image__thumb')?.getAttribute('src')).toBe('data:image/png;base64,' + png))
  expect(resources).toHaveBeenCalledWith(control.agentSessionId, expect.objectContaining({ source: { providerId: 'claude', nativeSessionId: 'native-main' },
    recordId: original.uuid, turnId: original.user_message_uuid, partIndex: 1, expectedReference: 'data:image/png;base64,' + png }))
  await flush(() => expect(changes).toHaveBeenCalled())
  await act(async () => { await Promise.allSettled([changes.mock.results.at(-1)?.value]); await new Promise(resolve => setTimeout(resolve, 80)) })
  const body = host.querySelector('[data-native-record-id="original-image-input"] strong')!, range = document.createRange()
  range.selectNodeContents(body); getSelection()!.addRange(range)
  const count = changes.mock.calls.length
  await act(async () => { await appendFile(f.path, jsonl([{ ...original, message: { ...original.message, content: [{ type: 'text', text: 'Later **different selected words** body' }, original.message.content[1]] } }])) })
  await flush(() => expect(changes.mock.calls.length).toBeGreaterThan(count))
  expect(body.isConnected).toBe(true); expect(getSelection()!.toString()).toBe('selected words')
  expect(host.querySelector('[data-native-record-id="original-image-input"] strong')).toBe(body)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await flush(() => expect(host.textContent).toContain('Later different selected words body'))
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
