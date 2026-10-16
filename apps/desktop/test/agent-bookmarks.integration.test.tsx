// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

import * as Modal from '@agentmux/client-ui/components/Modal'
import { DocumentOverlayPortal } from '../src/renderer/src/components/WindowOverlayHost'
vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))
const dom = composerDOM({ agentInformation: true }), a = composerSession('bookmark-a'), b = composerSession('bookmark-b'), neighbor = { ...composerSession('neighbor-display'), hostId: 'neighbor-host', control: { ...a.control, hostId: 'neighbor-host' } }
const timeline = (id: string, text: string) => ({ agentSessionId: id, revision: text.length, items: [{ id: id + '-reply', agentSessionId: id, kind: 'assistant_message' as const, source: 'native-hook' as const, status: 'complete' as const, title: 'Reply', content: text, createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }] })
const context = (agent = a) => agentContextForSession(agent, useAppStore.getState().timelines[agent.id], 'Same display name', composerConfig.workspaces[0]!, null)
const panels = () => [...document.querySelectorAll<HTMLElement>('.agent-information-reader')]
const panel = (id = a.id) => panels().find(node => node.querySelector('.focus-context-hover__recap')?.textContent?.includes(id))!
async function scene(origin = true) {
  await dom.render(<>{origin ? <WorkspaceAgentRow context={context()} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => {}} /> : null}<FocusContextRow context={context(b)} selected={false} onSelect={() => {}} /></>)
}
async function open(id = a.id) { await act(async () => dom.container.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!.focus()); await waitForAgentCardReading(() => expect(api.sessions.observeHistory).toHaveBeenCalled()) }
async function pin(id = a.id) { expect(panel(id)).toBeDefined(); await act(async () => panel(id).querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click()); expect(panel(id)).toBeDefined() }
beforeEach(async () => {
  for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
  useAppStore.setState({ sessions: [a, b, neighbor], timelines: { [a.id]: timeline(a.id, a.id + ' original reply'), [b.id]: timeline(b.id, b.id + ' original reply') }, demands: {}, agentNames: {} })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: control.agentSessionId }, nextCursor: null, items: [] }))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: control.agentSessionId }, dispose() {} }))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  await agentCardConversationFixture(control => ({ providerId: 'codex', nativeSessionId: control.agentSessionId }))
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
  expect(original.textContent).toContain('next Run reply'); await waitForAgentCardReading(() => expect(api.sessions.historyPage).toHaveBeenLastCalledWith(replacement.control, expect.objectContaining({ limit: 100 })))
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
})
it('retains the saved presentation while its original Runtime subject is unavailable', async () => {
  await scene(); await open(); await pin(); const saved = agentBookmarks.get().bookmarks[0]!
  await act(async () => useAppStore.setState({ sessions: [], timelines: {} }))
  expect(panels()).toHaveLength(1); expect(panels()[0]!.textContent).toContain(a.id + ' original reply')
  expect(agentBookmarks.get().bookmarks[0]!.key).toBe(saved.key)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})
it('keeps keyboard window geometry within the viewport and writes its settled bounds', async () => {
  await scene(); await open(); await pin(); const original = panel()
  vi.spyOn(original, 'getBoundingClientRect').mockImplementation(() => ({ x: 32, y: 72, width: 460, height: 600, top: 72, left: 32, right: 492, bottom: 672, toJSON() {} }))
  const move = original.querySelector<HTMLButtonElement>('.agent-bookmark__move')!
  await act(async () => { move.focus(); move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  expect(agentBookmarks.get().bookmarks[0]!.bounds.x).toBe(48)
  const resize = original.querySelector<HTMLButtonElement>('.agent-bookmark__resize')!
  await act(async () => resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })))
  expect(agentBookmarks.get().bookmarks[0]!.bounds.width).toBe(444)
  await act(async () => original.querySelector<HTMLButtonElement>('.agent-bookmark__reset')!.click())
  expect(agentBookmarks.get().bookmarks[0]!.bounds).toMatchObject({ x: 32, y: 56, width: 460 })
  expect(original.querySelector('.focus-context-hover__recap')!.textContent).toContain(a.id + ' original reply')
})
it('persists completed pointer gestures, cancels unfinished geometry and keeps header controls usable', async () => {
  await scene(); await open(); await pin(); const original = panel(), saved = agentBookmarks.get().bookmarks[0]!.bounds
  vi.spyOn(original, 'getBoundingClientRect').mockImplementation(() => {
    const x = parseFloat(original.style.left), y = parseFloat(original.style.top), width = parseFloat(original.style.width), height = parseFloat(original.style.height)
    return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON() {} }
  })
  const header = original.querySelector<HTMLElement>('header')!
  const pointer = async (target: HTMLElement, type: string, x: number, y: number) => act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 7, clientX: x, clientY: y })))
  await pointer(header, 'pointerdown', 100, 100); await pointer(header, 'pointermove', -1000, -1000)
  await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())))
  expect(original.style.transform).toBe(`translate3d(${8 - saved.x}px, ${8 - saved.y}px, 0)`)
  expect(agentBookmarks.get().bookmarks[0]!.bounds).toEqual(saved)
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(original.style.left).toBe(saved.x + 'px'); expect(panels()).toContain(original)
  await pointer(header, 'pointerdown', 100, 100); await pointer(header, 'pointermove', 140, 120); await pointer(header, 'pointerup', 140, 120)
  expect(agentBookmarks.get().bookmarks[0]!.bounds).toMatchObject({ x: saved.x + 40, y: saved.y + 20 })
  const resize = original.querySelector<HTMLElement>('.agent-bookmark__resize')!
  await pointer(resize, 'pointerdown', 100, 100); await pointer(resize, 'pointermove', 2000, 2000); await pointer(resize, 'pointerup', 2000, 2000)
  const settled = agentBookmarks.get().bookmarks[0]!.bounds
  expect(settled.x + settled.width).toBeLessThanOrEqual(window.innerWidth - 8)
  expect(settled.y + settled.height).toBeLessThanOrEqual(window.innerHeight - 8)
  await pointer(resize, 'pointerdown', 100, 100); await pointer(resize, 'pointermove', 110, 110); await pointer(resize, 'pointercancel', 110, 110)
  expect(agentBookmarks.get().bookmarks[0]!.bounds).toEqual(settled)
})
it('keyboard entry through another alias focuses the same bookmark without replacing its reading', async () => {
  await scene(); await open(); await pin(); const original = panel()
  const alias = { ...a, id: 'keyboard-bookmark-alias' }
  await act(async () => useAppStore.setState({ sessions: [a, alias, b, neighbor] }))
  await dom.render(<FocusContextRow context={context(alias)} selected={false} onSelect={() => {}} />)
  await open(alias.id)
  const row = dom.container.querySelector<HTMLElement>(`[data-session-id="${alias.id}"]`)!
  await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(original.querySelector('.agent-information-reader__reading'))
  expect(panels()).toEqual([original]); expect(api.sessions.historyPage).toHaveBeenCalledTimes(1)
})
it('keeps preferred geometry when a fitted heading is clicked without dragging', async () => {
  await scene(); await open(); await pin(); const original = panel(), saved = agentBookmarks.get().bookmarks[0]!
  await act(async () => agentBookmarks.setBounds(saved.key, { x: 32, y: 56, width: 1600, height: 1200 }))
  const preferred = agentBookmarks.get().bookmarks[0]!.bounds
  vi.spyOn(original, 'getBoundingClientRect').mockImplementation(() => ({ x: 8, y: 8, width: window.innerWidth - 16, height: window.innerHeight - 16, top: 8, left: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8, toJSON() {} }))
  const header = original.querySelector<HTMLElement>('header')!
  await act(async () => {
    header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true, pointerId: 4, clientX: 50, clientY: 50 }))
    header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, isPrimary: true, pointerId: 4, clientX: 50, clientY: 50 }))
  })
  expect(agentBookmarks.get().bookmarks[0]!.bounds).toEqual(preferred)
})
it('raises the same bookmark tree in DOM order when keyboard focus enters it', async () => {
  await scene(); await open(); await pin(); const original = panel()
  await open(b.id); await pin(b.id)
  const second = panel(b.id), firstHost = original.parentElement!, secondHost = second.parentElement!
  expect(firstHost.parentElement).toBe(secondHost.parentElement)
  expect(firstHost.compareDocumentPosition(secondHost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(original.style.zIndex).toBe('var(--layer-popover)'); expect(second.style.zIndex).toBe('var(--layer-popover)')
  const prose = second.querySelector('.focus-context-hover__recap p')!, range = document.createRange()
  range.selectNodeContents(prose); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  expect(agentBookmarks.get().bookmarks.at(-1)!.agentSessionId).toBe(b.control.agentSessionId)
  const target = original.querySelector<HTMLButtonElement>('.agent-information-reader__close')!
  await act(async () => target.focus())
  expect(document.activeElement).toBe(target); expect(panel()).toBe(original)
  expect(agentBookmarks.get().bookmarks.at(-1)!.agentSessionId).toBe(a.control.agentSessionId)
  expect(panels()).toHaveLength(2)
  expect(secondHost.compareDocumentPosition(firstHost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(original.parentElement).toBe(firstHost); expect(second.parentElement).toBe(secondHost)
  expect(document.getSelection()!.toString()).toBe(b.id + ' original reply')
  await dom.render(<Modal.Root open>
    <DocumentOverlayPortal component={Modal.Portal}>
      <Modal.Overlay className="dialog-scrim" />
      <Modal.Content className="dialog-surface" aria-describedby={undefined}><Modal.Title>Later modal</Modal.Title><button>Modal action</button></Modal.Content>
    </DocumentOverlayPortal>
  </Modal.Root>)
  const scope = document.querySelector<HTMLElement>('[data-overlay-modal-scope]')!
  expect(scope).not.toBeNull()
  expect(original.closest('[data-overlay-modal-scope]')).toBeNull()
  expect(second.closest('[data-overlay-modal-scope]')).toBeNull()
  expect(firstHost.closest('#agentmux-window-overlay-host')!.contains(scope)).toBe(true)
  expect(original.style.zIndex).toBe('var(--layer-popover)'); expect(second.style.zIndex).toBe('var(--layer-popover)')
  expect(scope.querySelectorAll('[data-overlay-modal-part]')).toHaveLength(2)
})
