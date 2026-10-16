// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { msUntilSemanticStatusStale } from '@agentmux/core/agent-status'
import { api } from '../src/renderer/src/lib/api'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span') }))
const dom = composerDOM({ agentInformation: true }), agent = composerSession('pinned-agent'), neighbor = composerSession('neighbor-agent')
const workspace = composerConfig.workspaces[0]!, onOpen = vi.fn(), dispose = vi.fn()
let conversation: Awaited<ReturnType<typeof agentCardConversationFixture>>
const timeline = { agentSessionId: agent.id, revision: 1, items: [{ id: 'held-reply', agentSessionId: agent.id, kind: 'assistant_message' as const, source: 'native-hook' as const, title: 'Reply', status: 'complete' as const, content: 'Original **reply**.\n\nComplete held tail.', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }] }
const context = (session = agent) => agentContextForSession(session, session.id === agent.id ? timeline : undefined, session.id, workspace, null)
const panel = () => document.querySelector<HTMLElement>('.agent-information-reader')!
const row = (id = agent.id) => dom.container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`)!
const native = (text = 'Original observed input') => ({ agentSessionId: agent.id, source: { providerId: 'codex', nativeSessionId: 'original-source' }, nextCursor: null,
  items: [{ id: 'original-input', kind: 'user-message' as const, contentParts: [{ kind: 'text' as const, text }], startedAt: _historyFixtureEpoch(0, 0, 1) }] })
async function scene(origin = true, active = true) {
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}>
    {origin ? <WorkspaceAgentRow key={agent.id} context={context()} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={onOpen} /> : null}
    <FocusContextRow key={neighbor.id} context={context(neighbor)} selected={false} onSelect={onOpen} />
  </WorkbenchPresentationContext.Provider>)
}
async function open() { await scene(); await act(async () => row().focus()); expect(panel()).not.toBeNull(); await waitForAgentCardReading(() => expect(api.sessions.historyPage).toHaveBeenCalled()) }
async function pin() { await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click()) }
function selectReply() { const text = panel().querySelector('.focus-context-hover__recap p')!, range = document.createRange(); range.selectNodeContents(text); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range) }
async function ready() { await waitForAgentCardReading(() => expect(panel().querySelector('[data-hover-input-id]')?.textContent).toContain('Original observed input')) }
beforeEach(async () => {
  for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
  useAppStore.setState({ sessions: [agent, neighbor], timelines: { [agent.id]: timeline }, agentNames: {}, demands: {}, mainSurface: 'agents' })
  onOpen.mockClear(); dispose.mockClear()
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(native())
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'original-source' }, dispose }))
  vi.spyOn(api.sessions, 'dispatches').mockResolvedValue({ hostId: 'local', participantSessionId: agent.id, nextSourceMessageId: null, dispatches: [] })
  conversation = await agentCardConversationFixture(() => native().source)
})
afterEach(async () => { await act(async () => { for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key); await agentBookmarks.flush() }) })

it('keeps the same pinned reader through origin removal while neighbor hover and original navigation remain independent', async () => {
  await open(); await ready()
  const original = panel(), reading = original.querySelector<HTMLElement>('.agent-information-reader__reading')!, reply = original.querySelector('.focus-context-hover__recap p')!
  const range = document.createRange(); range.selectNodeContents(reply); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const selected = window.getSelection()!.toString(); reading.scrollTop = 97
  await pin(); expect(panel()).toBe(original); expect(panel().getAttribute('data-pinned')).toBe('true')
  expect(panel().querySelector('.agent-information-reader__pin')?.getAttribute('aria-pressed')).toBe('true')
  expect(panel().querySelectorAll('.agent-information-reader__footer')).toHaveLength(1)
  await scene(false, false); expect(row(agent.id)).toBeNull(); expect(panel()).toBe(original)
  await act(async () => row(neighbor.id).focus()); expect(panel()).toBe(original)
  await act(async () => row(neighbor.id).click()); expect(onOpen).toHaveBeenCalledExactlyOnceWith(neighbor.id)
  expect(panel()).toBe(original); expect(reading.scrollTop).toBe(97); expect(panel().querySelector('.focus-context-hover__recap p')).toBe(reply)
  expect(window.getSelection()!.toString()).toBe(selected); expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
  await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__close')!.click())
  expect(panel()).toBeNull(); expect(document.activeElement).toBe(row(neighbor.id))
})

it('lets the original in-flight input finish once after pin and releases its view on close without remounting', async () => {
  let resolve!: (value: ReturnType<typeof native>) => void
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await open(); const original = panel(), inputRegion = original.querySelector('.focus-context-hover__inputs')!
  await pin(); expect(panel()).toBe(original)
  await act(async () => resolve(native())); await ready()
  expect(panel().querySelector('.focus-context-hover__inputs')).toBe(inputRegion)
  const frame = await vi.mocked(api.conversation.readAgentConversation).mock.results[0]!.value
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
  await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__facts')!.click())
  await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Back to original content"]')!.click())
  await pin(); expect(panel()).toBe(original); expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
  await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__close')!.click())
  await waitForAgentCardReading(() => expect(vi.mocked(api.conversation.releaseConversationView).mock.calls.some(([input]) => input.view === frame.window.view)).toBe(true))
  expect(dispose).toHaveBeenCalledTimes(vi.mocked(api.sessions.observeHistory).mock.calls.length)
})

it.each(['source', 'run', 'control-host', 'removed'] as const)('retains original observed input and reply when the pinned %s scope changes', async change => {
  await open(); await ready(); selectReply(); await pin()
  const original = panel(), input = original.querySelector('[data-hover-input-id]')!, reply = original.querySelector('.focus-context-hover__recap p')!
  const replacement = change === 'run' ? { ...agent, control: { ...agent.control, run: { runId: 'replacement-run' } } }
    : change === 'control-host' ? { ...agent, control: { ...agent.control, hostId: 'other-host' } }
      : { ...agent, nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'new-source' } }
  const before = vi.mocked(api.sessions.historyPage).mock.calls.length
  await act(async () => useAppStore.setState({ sessions: change === 'removed' ? [neighbor] : [replacement, neighbor] }))
  expect(panel()).toBe(original); expect(original.textContent).toContain(change === 'source' || change === 'run' ? 'Reading an earlier Run or source' : 'Original Run or source is no longer confirmed')
  expect(original.querySelector('[data-hover-input-id]')).toBe(input); expect(input.textContent).toContain('Original observed input')
  expect(original.querySelector('.focus-context-hover__recap p')).toBe(reply); expect(reply.textContent).toContain('Original reply')
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(before); expect(onOpen).not.toHaveBeenCalled()
})

it('keeps selected bookmark inputs when the original in-flight native frame completes alongside later captured requests', async () => {
  const captured = [1, 2, 3].map(index => ({ ...timeline.items[0]!, id: 'captured-' + index, kind: 'user_message' as const, source: 'user' as const, content: 'Original captured input ' + index, createdAt: index, updatedAt: index }))
  await act(async () => useAppStore.setState({ timelines: { [agent.id]: { ...timeline, revision: 4, items: [...captured, timeline.items[0]!] } } }))
  vi.mocked(api.sessions.historyPage).mockResolvedValueOnce({ ...native(), items: [] })
  let resolve!: (value: Awaited<ReturnType<ReturnType<typeof conversation.clientFor>['readSessionHistoryChanges']>>) => void
  vi.mocked(conversation.clientFor('local').readSessionHistoryChanges).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await open()
  await waitForAgentCardReading(() => expect(panel().querySelectorAll('[data-hover-input-id]')).toHaveLength(3))
  await waitForAgentCardReading(() => expect(resolve).toBeTypeOf('function'))
  const inputs = [...panel().querySelectorAll('[data-hover-input-id]')]
  expect(inputs).toHaveLength(3)
  const original = inputs[0]!, range = document.createRange(); range.selectNodeContents(original.querySelector('p')!)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); const selected = window.getSelection()!.toString()
  await pin()
  await act(async () => useAppStore.setState({ timelines: { [agent.id]: { ...timeline, revision: 5, items: [...captured, { ...captured[0]!, id: 'later-captured', content: 'LATER CAPTURED REQUEST', createdAt: _historyFixtureEpoch(0, 0, 5), updatedAt: _historyFixtureEpoch(0, 0, 5) }, timeline.items[0]!] } } }))
  await act(async () => conversation.sync({ hostId: 'local', agentSessionId: agent.id }))
  expect([...panel().querySelectorAll('[data-hover-input-id]')]).toEqual(inputs)
  expect(window.getSelection()!.toString()).toBe(selected); expect(panel().textContent).not.toContain('LATER CAPTURED REQUEST')
  await act(async () => resolve({ hostId: 'local', agentSessionId: agent.id, source: native().source, items: native().items,
    checkpoint: { agentSessionId: agent.id, source: native().source, cursor: 'original-card-source-next-cut' }, more: false }))
  await waitForAgentCardReading(() => expect(vi.mocked(api.conversation.readConversationChanges).mock.settledResults[0]?.type).toBe('fulfilled'))
  const completed = await vi.mocked(api.conversation.readConversationChanges).mock.results[0]!.value
  expect(JSON.stringify(completed.items)).toContain('Original observed input')
  expect([...panel().querySelectorAll('[data-hover-input-id]')]).toEqual(inputs)
  for (const input of inputs) expect(input.isConnected).toBe(true)
  expect(panel().textContent).not.toContain('LATER CAPTURED REQUEST')
  expect(panel().textContent).not.toContain('Original observed input')
  expect(window.getSelection()!.toString()).toBe(selected)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1); expect(onOpen).not.toHaveBeenCalled()
})

it('ignores a late old-source input instead of attaching it to a pinned replacement Run', async () => {
  let resolve!: (value: ReturnType<typeof native>) => void
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await open(); await pin()
  await act(async () => useAppStore.setState({ sessions: [{ ...agent, control: { ...agent.control, run: { runId: 'replacement-run' } } }, neighbor] }))
  await act(async () => resolve(native('LATE OLD SOURCE MUST NOT ARRIVE')))
  expect(panel().textContent).not.toContain('LATE OLD SOURCE MUST NOT ARRIVE'); expect(panel().textContent).toContain('Complete held tail')
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})

it('pauses an invisible pinned window and resumes only its original source without reopening closed content', async () => {
  let visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState)
  let resolve!: (value: ReturnType<typeof native>) => void
  vi.mocked(api.sessions.historyPage).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await open(); await pin(); const original = panel()
  await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')) })
  expect(panel()).toBe(original); expect(original.hidden).toBe(true)
  expect(api.sessions.observeHistory).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled()
  await act(async () => resolve(native('INVISIBLE LATE INPUT')))
  expect(original.textContent).not.toContain('INVISIBLE LATE INPUT')
  const count = vi.mocked(api.sessions.historyPage).mock.calls.length
  await act(async () => useAppStore.setState({ sessions: [agent, { ...neighbor, latestOutputBytes: 40 }] }))
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(count)
  await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })
  expect(panel()).toBe(original); expect(original.hidden).toBe(false)
  await ready(); await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__close')!.click())
  await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })
  expect(panel()).toBeNull()
})


it('expires a visible pinned work signal at the Core boundary without changing the held text or reading demand', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  try {
    const status = { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now(), stateEnteredAt: Date.now() }
    const working = { ...agent, status, semanticStatus: status }
    useAppStore.setState({ sessions: [working], timelines: { [agent.id]: timeline } })
    await dom.render(<WorkspaceAgentRow context={context(working)} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={onOpen} />)
    await act(async () => { row().focus(); for (let n = 0; n < 12; n++) await Promise.resolve() })
    await pin()
    const original = panel(), prose = original.querySelector('.focus-context-hover__recap p'), reads = vi.mocked(api.sessions.historyPage).mock.calls.length
    expect(original.querySelector('.focus-context-hover__state-label')?.textContent).toContain('Working')
    await act(async () => vi.advanceTimersByTime(msUntilSemanticStatusStale(status, Date.now()) + 1000))
    expect(panel()).toBe(original); expect(panel().textContent).toContain('Work signal expired')
    expect(panel().querySelector('.focus-context-hover__state-label')?.textContent).not.toContain('Working')
    expect(panel().querySelector('.focus-context-hover__recap p')).toBe(prose)
    expect(api.sessions.historyPage).toHaveBeenCalledTimes(reads)
  } finally { vi.useRealTimers() }
})


it('restores original text selection after metadata but yields to a later selection outside that text', async () => {
  await open(); await ready(); await pin()
  const prose = panel().querySelector('.focus-context-hover__recap p')!, range = document.createRange()
  range.selectNodeContents(prose); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const selected = window.getSelection()!.toString()
  const metadata = () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__facts')!
  const back = () => panel().querySelector<HTMLButtonElement>('[aria-label="Back to original content"]')!
  await act(async () => metadata().click())
  window.getSelection()!.removeAllRanges()
  await act(async () => back().click())
  expect(window.getSelection()!.toString()).toBe(selected)
  await act(async () => metadata().click())
  const foreign = panel().querySelector('.agent-information-reader__metadata')!, later = document.createRange()
  later.selectNodeContents(foreign); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(later)
  await act(async () => document.dispatchEvent(new Event('selectionchange')))
  window.getSelection()!.removeAllRanges()
  await act(async () => back().click())
  expect(window.getSelection()!.toString()).toBe('')
  expect(panel().querySelector('.focus-context-hover__recap p')).toBe(prose)
})
