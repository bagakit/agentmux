// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, writeFile } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { AgentMuxError } from '../../../packages/core/src/errors'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { createClientUiRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { consumeConversationWindowPage, type ConversationTimelineReadInput, type ConversationWindowAssembly, type AgentConversationReadPage } from '@agentmux/core/conversation'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { window.getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
type Fixture = Awaited<ReturnType<typeof nativeHistoryFixture>>
const row = (id: string, content = id) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content } })
const pause = async (ms = 80) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
const wait = (assertion: () => void) => vi.waitFor(async () => { await pause(15); assertion() }, { timeout: 7000, interval: 15 })
async function captured(f: Fixture, id: string) {
  // Publish isolated durable source records; never submit to an Agent or Run.
  await Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client, { type: 'append', agentSessionId: f.session.agentSessionId,
    item: { id, agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Original captured input', content: id, createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) } },
  { source: 'agentmux', observedAt: _tailFixtureEpoch(0, 0, 1) }, 'local')
}
async function complete(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, input: ConversationTimelineReadInput) {
  let pending: ConversationWindowAssembly | undefined, cursor = input.cursor
  for (let count = 0; count < 50; count++) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) }), result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') return result.snapshot
    pending = result.pending; cursor = page.nextCursor!; expect(cursor).toBeTruthy()
  }
  throw Error('The bounded original frame did not complete')
}
async function evict(port: Awaited<ReturnType<typeof desktopConversationReadBridge>>, f: Fixture) {
  for (let count = 0; count < 17; count++) await complete(port.readAgentConversation, { hostId: 'local', agentSessionId: f.session.agentSessionId, limit: 100 })
}
function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  return { host, root }
}
const sample = (f: Fixture) => inspectConversationConsumers({ hostId: 'local', agentSessionId: f.session.agentSessionId }).consumers[0]!
const code = (error: Error | null) => (error as (Error & { code: string }) | null)?.code

it('actual Activity rebuilds an evicted current view in its original scope and watches later native and captured records', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('initial-native')]))
  closes.push(f.close); await captured(f, 'initial-captured')
  const metadata = await f.store.readMetadata(f.session.agentSessionId), store = useAppStore.getState()
  useAppStore.setState({ agentComposerDrafts: { [f.session.agentSessionId]: 'Original unsent draft' } })
  closes.push(() => useAppStore.setState(store, true))
  const port = await desktopConversationReadBridge(f, closes), reads = vi.mocked(api.conversation.readAgentConversation)
  const { host, root } = mount(), control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const render = (visible = true) => act(async () => root.render(<ActivityView {...activityReadingProps({ control, visible, workspaceRoot: f.root })} />))
  await render()
  await wait(() => { expect(host.textContent).toContain('initial-native'); expect(host.textContent).toContain('initial-captured'); expect(sample(f).dirty).toBe(false); expect(sample(f).loading).toBe(false) })
  const initial = sample(f).accepted!
  await render(false); await pause()
  const hiddenReads = reads.mock.calls.length, hiddenChanges = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
  await evict(port, f)
  await act(async () => { await appendFile(f.path, jsonl([row('new-native')])); await captured(f, 'new-captured') })
  await pause(140)
  expect(reads.mock.calls).toHaveLength(hiddenReads); expect(vi.mocked(api.conversation.readConversationChanges).mock.calls).toHaveLength(hiddenChanges)
  await render()
  await wait(() => { expect(host.textContent, 'An expired current view must reopen its original sources').toContain('new-native'); expect(host.textContent).toContain('new-captured'); expect(sample(f).watch.bound).toBe(true); expect(sample(f).loading).toBe(false) })
  const recovered = sample(f).accepted!
  expect(recovered.id).not.toBe(initial.id); expect(recovered.scope).toEqual(initial.scope); expect(recovered.sourceHostId).toBe(initial.sourceHostId)
  expect(sample(f).error).toBeNull(); expect(sample(f).historical).toBe(false)
  const reopen = reads.mock.calls.slice(hiddenReads).find(([input]) => !input.view && !input.cursor)![0]
  expect(reopen.nativeSource).toEqual({ providerId: 'claude', nativeSessionId: 'native-main' })
  await act(async () => { await appendFile(f.path, jsonl([row('watched-native')])); await captured(f, 'watched-captured') })
  await wait(() => { expect(host.textContent).toContain('watched-native'); expect(host.textContent).toContain('watched-captured') })
  expect(sample(f).accepted!.id).toBe(recovered.id)
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(metadata)
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe('Original unsent draft')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('actual Activity keeps its selected old frame until the rebuilt current head can be committed', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 130 }, (_, index) => row('selected-native-' + index, index === 30 ? 'Original **selected words** remain readable.' : 'Native original ' + index))))
  closes.push(f.close); await captured(f, 'initial-captured')
  const port = await desktopConversationReadBridge(f, closes), { host, root } = mount()
  const control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const render = (visible = true) => act(async () => root.render(<ActivityView {...activityReadingProps({ control, visible, workspaceRoot: f.root })} />))
  await render()
  await wait(() => { expect(host.querySelector('[data-native-record-id="selected-native-30"] strong')).not.toBeNull(); expect(sample(f).dirty).toBe(false); expect(sample(f).loading).toBe(false) })
  const initial = sample(f).accepted!, selected = host.querySelector('[data-native-record-id="selected-native-30"] strong')!
  const range = document.createRange(); range.selectNodeContents(selected); window.getSelection()!.addRange(range)
  const feed = host.querySelector<HTMLElement>('.activity-feed')!
  Object.defineProperties(feed, { clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 2000 } })
  feed.scrollTop = 1400; await act(async () => feed.dispatchEvent(new Event('scroll')))
  feed.scrollTop = 300; await act(async () => feed.dispatchEvent(new Event('scroll')))
  await wait(() => expect(sample(f).loading).toBe(false))
  await render(false); await pause(); await evict(port, f)
  await act(async () => { await appendFile(f.path, jsonl(Array.from({ length: 105 }, (_, index) => row('new-head-' + index)))); await captured(f, 'new-captured') })
  await render()
  await wait(() => { expect(sample(f).held).toBe(true); expect(sample(f).pending?.id).not.toBe(initial.id); expect(sample(f).loading).toBe(false) })
  expect(sample(f).accepted!.id).toBe(initial.id); expect(selected.isConnected).toBe(true)
  expect(window.getSelection()!.getRangeAt(0)).toBe(range); expect(window.getSelection()!.toString()).toBe('selected words')
  expect(feed.scrollTop).toBe(300)
  expect(host.textContent).not.toContain('new-head-104')
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await wait(() => { expect(sample(f).held).toBe(false); expect(sample(f).accepted!.id).not.toBe(initial.id); expect(host.textContent).toContain('new-head-104'); expect(host.textContent).toContain('new-captured') })
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('an expired exact historical anchor keeps its original version and never automatically opens a current head', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('anchored-original')]))
  closes.push(f.close); await captured(f, 'anchored-captured')
  const port = await desktopConversationReadBridge(f, closes), ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, { root } = mount()
  let view!: ReturnType<typeof useConversationView>
  function Consumer({ active = true }: { active?: boolean }) { view = useConversationView(api.conversation, ref, active); return <output>{view.snapshot?.window.id}</output> }
  await act(async () => root.render(<Consumer />))
  await wait(() => { expect(view.snapshot).toBeTruthy(); expect(view.inspect().dirty).toBe(false); expect(view.loading).toBe(false) })
  const record = view.snapshot!.units.flatMap(unit => unit.records).find(record => record.original.item.id === 'anchored-original')!
  const anchor = { record: record.reference!, revision: record.revision, frontier: view.snapshot!.window.checkpoint }
  await act(async () => { await view.reveal(anchor) })
  await wait(() => { expect(view.historical).toBe(true); expect(view.loading).toBe(false) })
  const accepted = view.snapshot!
  await act(async () => root.render(<Consumer active={false} />)); await pause(); await evict(port, f)
  const before = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await appendFile(f.path, jsonl([row('later-current-head')]))
  await act(async () => root.render(<Consumer />))
  await wait(() => { expect(code(view.error)).toBe('AGENT_CONVERSATION_VIEW_EXPIRED'); expect(view.loading).toBe(false) })
  await pause(220)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(before).every(([input]) => Boolean(input.view))).toBe(true)
  expect(view.snapshot!.window.id).toBe(accepted.window.id); expect(view.snapshot!.window.anchor).toEqual(anchor)
  expect(view.snapshot!.units.flatMap(unit => unit.records.map(record => record.original.item.id))).toEqual(['anchored-original'])
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('actual Activity keeps an expired older frame until Read current records explicitly opens its original source', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 1400 }, (_, index) => row('historical-native-' + index))))
  closes.push(f.close); await captured(f, 'historical-captured')
  const metadata = await f.store.readMetadata(f.session.agentSessionId), store = useAppStore.getState()
  useAppStore.setState({ agentComposerDrafts: { [f.session.agentSessionId]: 'Original historical draft' } })
  closes.push(() => useAppStore.setState(store, true))
  const port = await desktopConversationReadBridge(f, closes), { host, root } = mount()
  const control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const render = (visible = true) => act(async () => root.render(<ActivityView {...activityReadingProps({ control, visible, workspaceRoot: f.root })} />))
  await render()
  await wait(() => { expect(host.textContent).toContain('historical-native-1399'); expect(sample(f).dirty).toBe(false); expect(sample(f).loading).toBe(false) })
  const feed = host.querySelector<HTMLElement>('.activity-feed')!
  Object.defineProperties(feed, { clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 5000 } })
  for (let count = 0; count < 13 && !sample(f).historical; count++) {
    const revision = sample(f).accepted!.revision
    await act(async () => feed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    await wait(() => { expect(sample(f).accepted!.revision).toBeGreaterThan(revision); expect(sample(f).loading).toBe(false) })
  }
  expect(sample(f).historical).toBe(true)
  const accepted = sample(f).accepted!, priorBody = host.querySelector('[data-native-record-id]')!.textContent
  await render(false); await pause(); await evict(port, f)
  await act(async () => { await appendFile(f.path, jsonl([row('explicit-current-native')])); await captured(f, 'explicit-current-captured') })
  const reads = vi.mocked(api.conversation.readAgentConversation), before = reads.mock.calls.length
  await render()
  await wait(() => { expect(sample(f).error?.code).toBe('AGENT_CONVERSATION_VIEW_EXPIRED'); expect(sample(f).loading).toBe(false) })
  await pause(160)
  expect(reads.mock.calls.slice(before).every(([input]) => Boolean(input.view))).toBe(true)
  expect(sample(f).accepted!.id).toBe(accepted.id); expect(sample(f).historical).toBe(true)
  expect(host.textContent).toContain(priorBody); expect(host.textContent).not.toContain('explicit-current-native')
  const current = [...host.querySelectorAll<HTMLButtonElement>('.conversation-read-issues button')].find(button => button.textContent === 'Read current records')
  expect(current, 'An expired historical view needs its real explicit current-record action').toBeDefined(); expect(current!.disabled).toBe(false)
  expect(host.querySelectorAll('.activity-feed__reading-service'), 'One unified reader failure must produce one service notice').toHaveLength(1)
  await act(async () => current!.click())
  await wait(() => { expect(host.textContent).toContain('explicit-current-native'); expect(host.textContent).toContain('explicit-current-captured'); expect(sample(f).error).toBeNull(); expect(sample(f).watch.bound).toBe(true) })
  const read = reads.mock.calls.slice(before).find(([input]) => !input.view && !input.cursor)![0]
  expect(read.nativeSource).toEqual({ providerId: 'claude', nativeSessionId: 'native-main' })
  expect(sample(f).accepted!.id).not.toBe(accepted.id); expect(sample(f).accepted!.scope).toEqual(accepted.scope)
  expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(metadata)
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe('Original historical draft')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
}, 30000)

it('a rebuilt temporary window cannot replace the original captured epoch and releases its rejected frame', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('accepted-native')]))
  const other = await nativeHistoryFixture('claude', jsonl([row('different-native')]))
  closes.push(f.close, other.close); await captured(f, 'accepted-captured'); await captured(other, 'different-captured')
  let owner = f.client
  const port = await desktopConversationReadBridge(f, closes, () => [{ hostId: 'local', client: owner }]), { host, root } = mount()
  const control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const render = (visible = true) => act(async () => root.render(<ActivityView {...activityReadingProps({ control, visible, workspaceRoot: f.root })} />))
  await render()
  await wait(() => { expect(host.textContent).toContain('accepted-native'); expect(sample(f).dirty).toBe(false); expect(sample(f).loading).toBe(false) })
  const initial = sample(f).accepted!
  await render(false); await pause(); await evict(port, f); owner = other.client
  const releases = vi.mocked(api.conversation.releaseConversationView), before = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await render()
  await wait(() => { expect(sample(f).error?.code, 'A rebuilt view must reject another original source scope').toBe('CONTROL_PROTOCOL_ERROR'); expect(sample(f).loading).toBe(false); expect(releases.mock.calls.length).toBeGreaterThan(0) })
  const attempts = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await pause(220); expect(vi.mocked(api.conversation.readAgentConversation).mock.calls).toHaveLength(attempts)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(before).filter(([input]) => !input.view && !input.cursor)).toHaveLength(1)
  expect(sample(f).accepted!.id).toBe(initial.id); expect(sample(f).accepted!.scope).toEqual(initial.scope)
  expect(host.textContent).toContain('accepted-native'); expect(host.textContent).toContain('accepted-captured')
  expect(host.textContent).not.toContain('different-native'); expect(host.textContent).not.toContain('different-captured')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]); expect(other.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('a real rejected native source cut is not treated as temporary-view expiry', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('original-native-cut')]))
  closes.push(f.close); await captured(f, 'original-captured-cut')
  await desktopConversationReadBridge(f, closes); const { host, root } = mount()
  const control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const render = (visible = true) => act(async () => root.render(<ActivityView {...activityReadingProps({ control, visible, workspaceRoot: f.root })} />))
  await render()
  await wait(() => { expect(host.textContent).toContain('original-native-cut'); expect(sample(f).dirty).toBe(false); expect(sample(f).loading).toBe(false) })
  const initial = sample(f).accepted!
  await render(false); await pause()
  await writeFile(f.path, jsonl([row('replacement-native')]))
  const before = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await render()
  await wait(() => { expect(sample(f).error?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED'); expect(sample(f).loading).toBe(false) })
  await pause(220)
  expect(vi.mocked(api.conversation.readAgentConversation).mock.calls.slice(before).every(([input]) => Boolean(input.view))).toBe(true)
  expect(sample(f).accepted!.id).toBe(initial.id); expect(host.textContent).toContain('original-native-cut'); expect(host.textContent).not.toContain('replacement-native')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('a failed expired-current reopen stops until the existing explicit Retry is requested', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([row('retained-native')]))
  closes.push(f.close); await captured(f, 'retained-captured')
  const port = await desktopConversationReadBridge(f, closes), original = f.client.readAgentConversation.bind(f.client)
  let fail = false, attempts = 0
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    if (input.nativeSource && !input.view && !input.cursor) { attempts++; if (fail) throw new AgentMuxError('The isolated original source is temporarily unavailable.', 'CONTROL_UNAVAILABLE') }
    return original(input, options)
  })
  const { host, root } = mount(), control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const render = (visible = true) => act(async () => root.render(<ActivityView {...activityReadingProps({ control, visible, workspaceRoot: f.root })} />))
  await render()
  await wait(() => { expect(host.textContent).toContain('retained-native'); expect(sample(f).dirty).toBe(false); expect(sample(f).loading).toBe(false) })
  const initial = sample(f).accepted!
  await render(false); await pause(); await evict(port, f); fail = true
  await appendFile(f.path, jsonl([row('recovered-native')])); await captured(f, 'recovered-captured')
  await render()
  await wait(() => { expect(attempts).toBe(1); expect(sample(f).error?.code).toBe('CONTROL_UNAVAILABLE'); expect(sample(f).loading).toBe(false) })
  await pause(450); expect(attempts).toBe(1); expect(sample(f).accepted!.id).toBe(initial.id)
  expect(host.textContent).toContain('retained-native'); expect(host.textContent).not.toContain('recovered-native')
  const retry = [...host.querySelectorAll<HTMLButtonElement>('.conversation-read-issues button')].find(button => button.textContent === 'Retry conversation records')
  expect(retry).toBeDefined(); expect(retry!.disabled).toBe(false)
  fail = false; await act(async () => retry!.click())
  await wait(() => { expect(host.textContent).toContain('recovered-native'); expect(host.textContent).toContain('recovered-captured'); expect(sample(f).error).toBeNull(); expect(sample(f).watch.bound).toBe(true) })
  expect(attempts).toBe(2); expect(sample(f).accepted!.scope).toEqual(initial.scope)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it.each(['native', 'captured'] as const)('a rebuilt view with unavailable %s coverage retains the accepted originals until explicit Retry succeeds', async source => {
  const f = await nativeHistoryFixture('claude', jsonl([row('available-original-native')]))
  closes.push(f.close); await captured(f, 'available-original-captured')
  const port = await desktopConversationReadBridge(f, closes), originalNative = f.client.sessionHistoryPage.bind(f.client), originalCaptured = f.store.readCapturedHistory.bind(f.store)
  let fail = false, failedFrames = 0
  vi.spyOn(f.client, 'sessionHistoryPage').mockImplementation(async (...args) => {
    if (source === 'native' && fail) throw Error('The isolated native head could not be read')
    return originalNative(...args)
  })
  vi.spyOn(f.store, 'readCapturedHistory').mockImplementation(async (id, input) => {
    if (source === 'captured' && fail && input?.epoch && input.throughSequence !== undefined && input.afterSequence === undefined) throw Error('The isolated captured head could not be read')
    return originalCaptured(id, input)
  })
  const original = f.client.readAgentConversation.bind(f.client)
  vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (...args) => {
    const page = await original(...args)
    if (page.window.complete && page.coverage.some(coverage => coverage.source.kind === source && coverage.current === 'unavailable')) failedFrames++
    return page
  })
  const { host, root } = mount(), control = { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }
  const render = (visible = true) => act(async () => root.render(<ActivityView {...activityReadingProps({ control, visible, workspaceRoot: f.root })} />))
  await render()
  await wait(() => { expect(host.textContent).toContain('available-original-native'); expect(host.textContent).toContain('available-original-captured'); expect(sample(f).dirty).toBe(false); expect(sample(f).loading).toBe(false) })
  const initial = sample(f).accepted!
  await render(false); await pause(); await evict(port, f); fail = true
  await act(async () => { await appendFile(f.path, jsonl([row('complete-recovered-native')])); await captured(f, 'complete-recovered-captured') })
  await render()
  await wait(() => { expect(failedFrames).toBeGreaterThan(0); expect(sample(f).loading).toBe(false) })
  await pause(140)
  expect(sample(f).accepted!.id, 'Unavailable source coverage must not replace the previously readable frame').toBe(initial.id)
  expect(host.textContent).toContain('available-original-native'); expect(host.textContent).toContain('available-original-captured')
  expect(sample(f).error?.code).toBe('AGENT_CONVERSATION_SOURCE_READ_UNAVAILABLE')
  const attempts = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  await pause(180); expect(vi.mocked(api.conversation.readAgentConversation).mock.calls).toHaveLength(attempts)
  const retry = [...host.querySelectorAll<HTMLButtonElement>('.conversation-read-issues button')].find(button => button.textContent === 'Retry conversation records')
  expect(retry).toBeDefined(); fail = false; await act(async () => retry!.click())
  await wait(() => { expect(host.textContent).toContain('complete-recovered-native'); expect(host.textContent).toContain('complete-recovered-captured'); expect(sample(f).error).toBeNull(); expect(sample(f).loading).toBe(false) })
  expect(sample(f).accepted!.scope).toEqual(initial.scope)
  expect(host.textContent).toContain('available-original-native'); expect(host.textContent).toContain('available-original-captured')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
