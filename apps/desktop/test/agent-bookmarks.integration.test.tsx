// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => createElement('span') }))
const dom = composerDOM({ agentInformation: true }), a = composerSession('bookmark-a'), b = composerSession('bookmark-b'), neighbor = { ...composerSession('neighbor-display'), hostId: 'neighbor-host', control: { ...a.control, hostId: 'neighbor-host' } }
const timeline = (id: string, text: string) => ({ agentSessionId: id, revision: text.length, items: [{ id: id + '-reply', agentSessionId: id, kind: 'assistant_message' as const, source: 'native-hook' as const, status: 'complete' as const, title: 'Reply', content: text, createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }] })
const context = (agent = a) => agentContextForSession(agent, useAppStore.getState().timelines[agent.id], 'Same display name', composerConfig.workspaces[0]!, null)
const panels = () => [...document.querySelectorAll<HTMLElement>('.agent-information-reader')]
const panel = (id = a.id) => panels().find(node => node.querySelector('.focus-context-hover__recap')?.textContent?.includes(id))!
async function scene(origin = true) {
  await dom.render(<>{origin ? <WorkspaceAgentRow context={context()} percent={null} onOpen={() => {}} /> : null}<FocusContextRow context={context(b)} selected={false} onSelect={() => {}} /></>)
}
async function open(id = a.id) { await act(async () => dom.container.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!.focus()); await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }) }
async function pin(id = a.id) { expect(panel(id)).toBeDefined(); await act(async () => panel(id).querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click()); expect(panel(id)).toBeDefined() }
beforeEach(() => {
  for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
  useAppStore.setState({ sessions: [a, b, neighbor], timelines: { [a.id]: timeline(a.id, a.id + ' original reply'), [b.id]: timeline(b.id, b.id + ' original reply') }, demands: {}, agentNames: {} })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: control.agentSessionId }, nextCursor: null, items: [] }))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: control.agentSessionId }, dispose() {} }))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => { for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key); await agentBookmarks.flush() }) })
it('pins different Agents together and duplicate aliases reuse the same original bookmark tree', async () => {
  await scene(); await open(); const first = panel(); await pin(); expect(panel()).toBe(first)
  await open(b.id); expect(panels()).toHaveLength(2); await pin(b.id)
  expect(agentBookmarks.get().bookmarks).toHaveLength(2); expect(panel()).toBe(first)
  const alias = { ...a, id: 'bookmark-a-alias' }
  await act(async () => useAppStore.setState({ sessions: [a, alias, b, neighbor], timelines: { ...useAppStore.getState().timelines, [alias.id]: timeline(alias.id, 'alias text cannot replace protected original') } }))
  await dom.render(<FocusContextRow context={context(alias)} selected={false} onSelect={() => {}} />)
  await open(alias.id); expect(panels()).toHaveLength(2); expect(agentBookmarks.get().bookmarks).toHaveLength(2); expect(panel()).toBe(first)
  expect(first.textContent).not.toContain('alias text'); expect(first.textContent).not.toContain('neighbor-display')
})
it('follows its original live content without an origin row and preserves selected text until explicit adoption', async () => {
  await scene(); await open(); await pin(); const original = panel(); await scene(false)
  await act(async () => useAppStore.setState({ timelines: { ...useAppStore.getState().timelines, [a.id]: timeline(a.id, a.id + ' current reply') } }))
  expect(original.textContent).toContain(a.id + ' current reply')
  const prose = original.querySelector('.focus-context-hover__recap p')!, range = document.createRange(); range.selectNodeContents(prose); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  await act(async () => { document.dispatchEvent(new Event('selectionchange')); useAppStore.setState({ timelines: { ...useAppStore.getState().timelines, [a.id]: timeline(a.id, a.id + ' NEW ORIGINAL CONTENT') } }) })
  expect(original.querySelector('.focus-context-hover__recap p')).toBe(prose); expect(document.getSelection()!.toString()).toBe(a.id + ' current reply')
  expect(original.textContent).toContain('New Agent content'); expect(original.textContent).not.toContain('NEW ORIGINAL CONTENT')
  await act(async () => original.querySelector<HTMLButtonElement>('.agent-information-reader__update button')!.click())
  expect(original.textContent).toContain('NEW ORIGINAL CONTENT'); expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})
it('keeps a missing original subject as a bookmark and closes only the explicitly chosen bookmark', async () => {
  await scene(); await open(); await pin(); await open(b.id); await pin(b.id)
  const original = panel(); await act(async () => useAppStore.setState({ sessions: [b, neighbor] }))
  expect(panels()).toHaveLength(2); expect(original.textContent).toContain(a.id + ' original reply'); expect(original.textContent).toContain('no longer confirmed')
  await act(async () => original.querySelector<HTMLButtonElement>('.agent-information-reader__close')!.click())
  expect(panels()).toHaveLength(1); expect(agentBookmarks.get().bookmarks.map(item => item.agentSessionId)).toEqual([b.control.agentSessionId])
})

it('stops the held source on Run replacement and adopts only the same canonical Agent when chosen', async () => {
  await scene(); await open(); await pin(); const original = panel(), prose = original.querySelector('.focus-context-hover__recap p')!
  const range = document.createRange(); range.selectNodeContents(prose); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  const reads = vi.mocked(api.sessions.historyPage).mock.calls.length, replacement = { ...a, control: { ...a.control, run: { runId: 'next-bookmark-run' } } }
  await act(async () => useAppStore.setState({ sessions: [replacement, b, neighbor], timelines: { ...useAppStore.getState().timelines, [a.id]: timeline(a.id, a.id + ' next Run reply') } }))
  expect(original.querySelector('.focus-context-hover__recap p')).toBe(prose); expect(document.getSelection()!.toString()).toBe(a.id + ' original reply')
  expect(original.textContent).toContain('earlier Run or source'); expect(api.sessions.historyPage).toHaveBeenCalledTimes(reads)
  await act(async () => original.querySelector<HTMLButtonElement>('.agent-information-reader__update button')!.click())
  expect(original.textContent).toContain('next Run reply'); expect(api.sessions.historyPage).toHaveBeenLastCalledWith(replacement.control, { limit: 30 })
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
})
it('retains the saved presentation while its original Runtime subject is unavailable', async () => {
  await scene(); await open(); await pin(); const saved = agentBookmarks.get().bookmarks[0]!
  await act(async () => useAppStore.setState({ sessions: [], timelines: {} }))
  expect(panels()).toHaveLength(1); expect(panels()[0]!.textContent).toContain(a.id + ' original reply')
  expect(agentBookmarks.get().bookmarks[0]!.key).toBe(saved.key)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})
