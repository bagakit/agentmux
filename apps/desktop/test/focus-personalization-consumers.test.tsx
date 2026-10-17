// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { AgentInputEntry, type InputPresentation } from '../src/renderer/src/components/AgentInputEntry'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { FocusPreviewTrigger, FocusRecentInputs } from '../src/shared/focus-preferences'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))

const dom = composerDOM({ agentInformation: true }), agent = composerSession('personalized-agent'), onSelect = vi.fn()
const timeline = { agentSessionId: agent.id, revision: 1, items: [{ id: 'original-reply', agentSessionId: agent.id,
  kind: 'assistant_message' as const, source: 'native-hook' as const, status: 'complete' as const, title: 'Reply',
  content: 'The original complete reply stays available across presentation choices.', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }] }
const context = () => agentContextForSession(agent, timeline, 'Original task', composerConfig.workspaces[0]!, null)
const panel = () => document.querySelector<HTMLElement>('.agent-information-reader')
const entries = () => [...(panel()?.querySelectorAll<HTMLElement>('.agent-input-recall__entry') ?? [])]
const originalInput = () => panel()?.querySelector<HTMLElement>('[data-agent-input-reading]')
const row = () => dom.container.querySelector<HTMLButtonElement>('button.focus-context')!
function preferences(previewTrigger: FocusPreviewTrigger, recentInputs: FocusRecentInputs = 6) {
  useAppStore.setState({ config: { ...composerConfig, focus: { recentActivityHours: 48, previewTrigger, recentInputs } } })
}
async function renderRow(surface: 'focus' | 'workspace' = 'focus', active = true) {
  const current = context()
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}>
    {surface === 'focus' ? <FocusContextRow context={current} selected={false} onSelect={onSelect} />
      : <WorkspaceAgentRow context={current} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => onSelect(agent.id)} />}
  </WorkbenchPresentationContext.Provider>)
}
async function key(target: Element, value: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
}
async function hover() { await act(async () => row().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))) }
async function wait(ms: number) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }

beforeEach(async () => {
  onSelect.mockClear()
  for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
  useAppStore.setState({ sessions: [agent], timelines: { [agent.id]: timeline }, demands: {}, tabs: {}, layouts: {}, agentNames: {} })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: agent.id, source: { providerId: 'codex', nativeSessionId: 'personalization-source' }, nextCursor: null,
    items: Array.from({ length: 12 }, (_, index) => ({ id: 'input-' + index, kind: 'user-message' as const, startedAt: index + 1,
      contentParts: [{ kind: 'text' as const, text: 'Complete original input ' + index }] })) })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'personalization-source' }, dispose() {} }))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  await agentCardConversationFixture(() => ({ providerId: 'codex', nativeSessionId: 'personalization-source' }))
})
afterEach(async () => {
  vi.useRealTimers()
  await act(async () => { for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key); await agentBookmarks.flush() })
  vi.unstubAllGlobals()
})

it.each([{ trigger: 'quick' as const, delay: 180 }, { trigger: 'deliberate' as const, delay: 600 }])('actual Focus pointer intent uses $trigger timing and preserves the original selection action', async ({ trigger, delay }) => {
  preferences(trigger); await renderRow()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await hover(); await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1) })
  expect(panel()).toBeNull(); expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) }); vi.useRealTimers()
  await waitForAgentCardReading(() => expect(entries()).toHaveLength(6))
  expect(onSelect).not.toHaveBeenCalled()
  await act(async () => row().click())
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(agent.id)
})

it.each(['focus', 'workspace'] as const)('keyboard-only %s ignores pointer and ordinary focus while keeping explicit reading, Pin and navigation', async surface => {
  preferences('keyboard'); await renderRow(surface)
  await act(async () => row().focus()); await hover(); await wait(650)
  expect(panel()).toBeNull(); expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await key(row(), 'ArrowDown')
  await waitForAgentCardReading(() => expect(entries()).toHaveLength(6))
  const reading = panel()!
  await key(reading, 'p')
  expect(reading.dataset.pinned).toBe('true')
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
  await act(async () => row().click())
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(agent.id)
  expect(panel()).toBe(reading)
})

it('cancels pending automatic intent when the mode changes or the original surface becomes inactive', async () => {
  preferences('quick'); await renderRow(); await hover()
  await act(async () => preferences('keyboard')); await wait(220)
  expect(panel()).toBeNull(); expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await act(async () => preferences('deliberate')); await renderRow(); await hover(); await wait(200)
  await renderRow('focus', false); await wait(650)
  expect(panel()).toBeNull(); expect(api.sessions.historyPage).not.toHaveBeenCalled()
  expect(onSelect).not.toHaveBeenCalled()
})

it.each([3, 6, 10] as const)('a new Reader takes %i inputs and keeps its original cut, body and Range through later preference edits', async limit => {
  preferences('quick', limit); await renderRow(); await act(async () => row().focus())
  await waitForAgentCardReading(() => expect(entries()).toHaveLength(limit))
  expect(entries().map(entry => entry.querySelector('p')!.textContent)).toEqual(Array.from({ length: limit }, (_, i) => 'Complete original input ' + (12 - limit + i)))
  await key(entries()[0]!, 'Enter')
  const reading = panel()!, body = originalInput()!, text = body.querySelector('p')!.firstChild!
  const selection = document.getSelection()!, range = document.createRange(); range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range)
  body.scrollTop = 37
  const selected = selection.toString(), reads = vi.mocked(api.sessions.historyPage).mock.calls.length
  await key(reading, 'p')
  await act(async () => preferences('quick', limit === 3 ? 10 : 3))
  expect(panel()).toBe(reading); expect(originalInput()).toBe(body); expect(body.contains(text)).toBe(true)
  expect(entries()).toHaveLength(limit); expect(selection.toString()).toBe(selected); expect(body.scrollTop).toBe(37)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(reads)
  await key(body, 'Escape'); await act(async () => reading.querySelector<HTMLButtonElement>('[aria-label="Close Agent reading"]')!.click())
  await key(row(), 'ArrowDown')
  await waitForAgentCardReading(() => expect(entries()).toHaveLength(limit === 3 ? 10 : 3))
})

it('the actual Global shares reply-line budgets with row allocation and lazy cards without changing service facts or original DOM', async () => {
  let width = 550
  vi.stubGlobal('ResizeObserver', class {
    private active = true
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => { if (this.active) this.callback([{ target, contentRect: new DOMRect(0, 0, width, 600) } as ResizeObserverEntry], this as unknown as ResizeObserver) }) }
    disconnect() { this.active = false }
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('focus-project-lanes__rows') ? width : 0 })
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return this.classList.contains('focus-project-lanes__groups') ? new DOMRect(0, 0, width, 600) : originalRect.call(this) })
  const styles = document.createElement('style'); styles.textContent = '.focus-project-lanes__groups{padding:2px;column-gap:2px}.focus-context-group__cards{column-gap:2px}'; document.head.append(styles)
  try {
    const now = Date.now(), counts = [1, 13, 16, 12] as const
    const sessions = counts.flatMap((count, bucket) => Array.from({ length: count }, (_, index) => ({ ...composerSession(`budget-${bucket}-${index}`),
      processState: bucket === 3 ? 'interrupted' as const : 'running' as const,
      status: { state: bucket === 0 ? 'error' as const : bucket === 1 ? 'working' as const : bucket === 2 ? 'done' as const : 'running' as const,
        source: 'native-hook' as const, observedAt: now, ...(bucket === 0 ? { detail: 'Keep the complete original service failure.' } : {}) } })))
    const timelines = Object.fromEntries(sessions.filter(session => session.status.state === 'done').map(session => [session.id,
      { ...timeline, agentSessionId: session.id, items: timeline.items.map(item => ({ ...item, agentSessionId: session.id, createdAt: now, updatedAt: now })) }]))
    vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: composerConfig.workspaces[0]!.path })
    preferences('keyboard')
    useAppStore.setState(state => ({ config: { ...state.config!, focus: { ...state.config!.focus!, replyLines: 1 } }, sessions, timelines, mainSurface: 'agents',
      agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }))
    await dom.render(<GlobalFocusSurface />)
    const surface = dom.container.querySelector<HTMLElement>('.global-focus-surface')!, card = dom.container.querySelector<HTMLElement>('[data-session-id="budget-2-0"]')!
    const sectionRows = () => [...dom.container.querySelectorAll<HTMLElement>('.focus-project-lanes__groups > section')].map(section => section.style.gridRow)
    expect(surface.style.getPropertyValue('--focus-reply-lines')).toBe('1')
    expect(surface.style.getPropertyValue('--focus-card-track-height')).toBe('38px')
    expect(sectionRows()).toEqual(['1', '2', '2', '2'])
    expect(card.closest<HTMLElement>('[data-focus-card-body]')!.style.minHeight).toBe('38px')
    const before = useAppStore.getState(), prose = card.querySelector('.focus-context__recap')!
    expect(prose.textContent).toContain('original complete reply')
    for (const lines of [2, 3] as const) {
      await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, focus: { ...state.config!.focus!, replyLines: lines } } })))
      expect(surface.style.getPropertyValue('--focus-reply-lines')).toBe(String(lines))
      expect(surface.style.getPropertyValue('--focus-card-track-height')).toBe(lines === 2 ? '52px' : '66px')
      expect(dom.container.querySelector('[data-session-id="budget-2-0"]')).toBe(card)
      expect(card.querySelector('.focus-context__recap')).toBe(prose)
      expect(card.closest<HTMLElement>('[data-focus-card-body]')!.style.minHeight).toBe(lines === 2 ? '52px' : '66px')
      expect(dom.container.querySelector('[data-session-id="budget-0-0"]')!.textContent).toContain('Keep the complete original service failure.')
    }
    expect(sectionRows()).toEqual(['1', '2', '3', '4'])
    expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  } finally { styles.remove() }
})

it('the shared input entry remains a held presentation leaf with explicit keyboard and click disclosure', async () => {
  const open = vi.fn(), meta: InputPresentation = { author: 'You', date: null, time: 'Time unknown', provenance: 'Example input', reading: { text: 'Same complete input content.', truncated: false } }
  await dom.render(<AgentInputEntry presentation={meta} expanded={false} controls="original-input" onOpen={open}><span>Held thumbnail</span></AgentInputEntry>)
  const entry = dom.container.querySelector<HTMLElement>('.agent-input-recall__entry')!
  expect(entry.textContent).toContain(meta.reading.text); expect(entry.textContent).toContain('Held thumbnail')
  expect(entry.getAttribute('aria-controls')).toBe('original-input')
  await act(async () => entry.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  expect(open).not.toHaveBeenCalled(); expect(api.sessions.historyPage).not.toHaveBeenCalled()
  for (const value of ['Enter', ' ', 'ArrowDown']) await key(entry, value)
  await act(async () => entry.click())
  expect(open).toHaveBeenCalledTimes(4)
  expect(open.mock.calls.every(([target]) => target === entry)).toBe(true)
})
