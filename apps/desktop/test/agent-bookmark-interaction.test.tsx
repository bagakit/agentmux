// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span') }))
const dom = composerDOM({ agentInformation: true }), agent = composerSession('pinned-interaction')
const timeline = { agentSessionId: agent.id, revision: 1, items: [{ id: 'reply', agentSessionId: agent.id, kind: 'assistant_message' as const, source: 'native-hook' as const, status: 'complete' as const, title: 'Reply', content: 'Original reply.', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }] }
const panel = () => document.querySelector<HTMLElement>('.agent-information-reader')!
const entries = () => [...panel().querySelectorAll<HTMLElement>('.agent-input-recall__entry')]
const inspection = () => panel().querySelector<HTMLElement>('.agent-input-recall__original')
async function open() {
  await dom.render(<WorkspaceAgentRow context={agentContextForSession(agent, timeline, 'Pinned reading', composerConfig.workspaces[0]!, null)} percent={null} onOpen={() => {}} />)
  await act(async () => dom.container.querySelector<HTMLElement>('.workspace-agent-row')!.focus())
  await act(async () => vi.waitFor(() => expect(entries()).toHaveLength(2)))
}
async function pin(height = 172) {
  const original = panel()
  vi.spyOn(original, 'getBoundingClientRect').mockImplementation(() => {
    const x = parseFloat(original.style.left) || 32, y = parseFloat(original.style.top) || 72
    const width = parseFloat(original.style.width) || 460, h = parseFloat(original.style.height) || height
    return { x, y, width, height: h, top: y, left: x, right: x + width, bottom: y + h, toJSON() {} }
  })
  await act(async () => original.querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
  expect(panel()).toBe(original)
  return original
}
async function hover(entry: HTMLElement) { await act(async () => entry.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))) }
async function settle() { await act(async () => new Promise(resolve => setTimeout(resolve, 200))) }
async function pointer(target: Element, type: string, id: number, x: number, y: number) {
  await act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: id, clientX: x, clientY: y })))
}
beforeEach(() => {
  for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
  useAppStore.setState({ sessions: [agent], timelines: { [agent.id]: timeline }, demands: {}, agentNames: {} })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: agent.id, source: { providerId: 'codex', nativeSessionId: 'pinned-original' }, nextCursor: null,
    items: [0, 1].map(index => ({ id: 'input-' + index, kind: 'user-message' as const, startedAt: index + 1, contentParts: [{ kind: 'text' as const, text: 'Original input ' + index }] })) })
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'pinned-original' }, dispose() {} }))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => { for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key); await agentBookmarks.flush() }) })
it('preserves the actual short preview dimensions through pin, drag and content updates', async () => {
  await open(); const original = await pin()
  const start = agentBookmarks.get().bookmarks[0]!.bounds
  expect(original.style.width).toBe('460px'); expect(original.style.height).toBe('172px')
  const header = original.querySelector('header')!
  await pointer(header, 'pointerdown', 7, 100, 100); await pointer(header, 'pointermove', 7, 140, 125); await pointer(header, 'pointerup', 7, 140, 125)
  expect(agentBookmarks.get().bookmarks[0]!.bounds).toMatchObject({ x: start.x + 40, y: start.y + 25, width: 460, height: 172 })
  await act(async () => useAppStore.setState({ timelines: { [agent.id]: { ...timeline, revision: 2, items: [{ ...timeline.items[0]!, content: 'A much longer updated reply. '.repeat(40) }] } } }))
  expect(original.style.height).toBe('172px'); expect(panel()).toBe(original)
})
it('changes size only through the explicit corner and ignores another pointer cancellation', async () => {
  await open(); const original = await pin(), handle = original.querySelector('.agent-bookmark__resize')!
  await pointer(handle, 'pointerdown', 7, 100, 100); await pointer(handle, 'pointermove', 7, 160, 180)
  await pointer(handle, 'pointercancel', 8, 160, 180); await pointer(handle, 'lostpointercapture', 8, 160, 180)
  await pointer(handle, 'pointerup', 7, 160, 180)
  expect(agentBookmarks.get().bookmarks[0]!.bounds).toMatchObject({ width: 520, height: 252 })
  expect(original.style.width).toBe('520px'); expect(original.style.height).toBe('252px')
})
it('keeps pinned hover on the summary without changing the Agent workface', async () => {
  await open(); await pin(400)
  const select = vi.spyOn(useAppStore.getState(), 'selectSession'), entry = entries()[0]!
  await hover(entry); await settle()
  expect(inspection()).toBeNull(); expect(entry.getAttribute('aria-expanded')).toBe('false')
  expect(panel().querySelector('.agent-information-reader__reading')!.textContent).toContain('Original reply.')
  expect(select).not.toHaveBeenCalled(); expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})
it('cancels the pending unpinned hover intent when the same window is pinned', async () => {
  await open(); await hover(entries()[0]!); await pin(400); await settle()
  expect(inspection()).toBeNull(); expect(panel().dataset.pinned).toBe('true')
})
it('retains ordinary unpinned hover and the already inspected input across pin', async () => {
  await open(); await hover(entries()[0]!); await settle()
  const held = inspection()!; expect(held.textContent).toContain('Original input 0')
  await pin(400); await hover(entries()[1]!); await settle()
  expect(inspection()).toBe(held); expect(held.textContent).not.toContain('Original input 1')
})
it.each(['click', 'Enter', ' '] as const)('enters pinned original input explicitly with %s and returns to the same bookmark', async action => {
  await open(); const original = await pin(400), entry = entries()[1]!
  const select = vi.spyOn(useAppStore.getState(), 'selectSession')
  await act(async () => { entry.focus(); if (action === 'click') entry.click(); else entry.dispatchEvent(new KeyboardEvent('keydown', { key: action, bubbles: true, cancelable: true })) })
  const body = inspection()!.querySelector<HTMLElement>('[data-agent-input-reading]')!
  expect(body.textContent).toContain('Original input 1')
  await act(async () => body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(inspection()).toBeNull(); expect(panel()).toBe(original); expect(original.dataset.pinned).toBe('true')
  expect(document.activeElement).toBe(entry); expect(select).not.toHaveBeenCalled()
})
