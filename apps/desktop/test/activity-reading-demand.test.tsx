import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'

let root: Root, host: HTMLDivElement
const records = [{ id: 'retained-original-input', agentSessionId: 'reading-owner', kind: 'user_message' as const,
  source: 'user' as const, content: 'Original retained input', title: 'Input', status: 'complete' as const, createdAt: 1, updatedAt: 1 }]
const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'source-a', transcriptPath: _hygiene_fixturePath("fixture/source-a") }
const page = { agentSessionId: 'reading-owner', source: { providerId: 'codex', nativeSessionId: 'source-a' }, items: [], nextCursor: null }
const reference = { hostId: 'local', agentSessionId: 'reading-owner', run: { runId: 'original-run' } }
const observerTargets = new Set<Element>()
let observerBuilds = 0
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  observerBuilds = 0; observerTargets.clear()
  vi.stubGlobal('IntersectionObserver', class {
    targets = new Set<Element>()
    constructor() { observerBuilds++ }
    observe(node: Element) { this.targets.add(node); observerTargets.add(node) }
    unobserve(node: Element) { this.targets.delete(node); observerTargets.delete(node) }
    disconnect() { for (const node of this.targets) observerTargets.delete(node); this.targets.clear() }
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: 'reading-owner', source: { providerId: 'codex', nativeSessionId: 'source-a' }, items: [], nextCursor: null })
  Element.prototype.scrollIntoView = vi.fn()
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(enabled: boolean, facts = { nativeHandle }) {
  await act(async () => root.render(<ActivityView sessionId="reading-owner" items={records} capability="complete-events"
    nativeHistoryPage={page}
    conversationReading={{ reference, identity: 'original-run', enabled, nativeSourceFacts: facts }} />))
}
it('a retained hidden reading body keeps its original DOM and Range without feed derivation or geometry; reveal restores demand', async () => {
  const derive = vi.spyOn(records, 'filter')
  await render(true)
  const feed = host.querySelector<HTMLElement>('.activity-feed')!
  expect(feed).not.toBeNull(); expect(derive).toHaveBeenCalled(); expect(observerBuilds).toBeGreaterThan(0)
  const textWalker = document.createTreeWalker(feed, NodeFilter.SHOW_TEXT)
  let original: Node | null = null
  while (textWalker.nextNode()) if (textWalker.currentNode.textContent?.includes('Original retained input')) { original = textWalker.currentNode; break }
  expect(original).not.toBeNull()
  const range = document.createRange(); range.setStart(original!, 0); range.setEnd(original!, 8); window.getSelection()!.addRange(range)
  feed.scrollTop = 37
  await render(false)
  expect(observerTargets.size).toBe(0)
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  const add = vi.spyOn(feed, 'addEventListener')
  derive.mockClear(); const builds = observerBuilds
  // Like the real SessionPane status-only clone, metadata identity may change without new source facts.
  for (let n = 0; n < 12; n++) await render(false, { nativeHandle: { ...nativeHandle } })
  await act(async () => feed.dispatchEvent(new Event('scroll')))
  expect(derive).not.toHaveBeenCalled(); expect(geometry).not.toHaveBeenCalled()
  expect(observerBuilds).toBe(builds); expect(add.mock.calls.filter(([kind]) => kind === 'scroll')).toHaveLength(0)
  expect(feed.scrollTop).toBe(37); expect(original!.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe('Original')
  await render(true)
  expect(observerBuilds).toBeGreaterThan(builds); expect(geometry).toHaveBeenCalled()
  expect(host.querySelector('.activity-feed')).toBe(feed); expect(original!.isConnected).toBe(true)
  expect(window.getSelection()!.toString()).toBe('Original')
})
it('initially hidden current and historical reading do not acquire feed geometry and record observers', async () => {
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
  await render(false)
  expect(host.querySelector('.activity-feed')).not.toBeNull(); expect(observerBuilds).toBe(0)
  expect(geometry.mock.instances.map(node => node?.className)).toEqual([]); expect(height.mock.instances.filter(node => node?.classList.contains('activity-feed'))).toEqual([]); expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await render(false, { nativeHandle: { ...nativeHandle, sessionId: 'source-b' } })
  expect(host.textContent).toContain('Native source changed')
  expect(host.textContent).toContain('Original retained input')
  expect(observerBuilds).toBe(0); expect(geometry.mock.instances.map(node => node?.className)).toEqual([]); expect(height.mock.instances.filter(node => node?.classList.contains('activity-feed'))).toEqual([]); expect(api.sessions.historyPage).not.toHaveBeenCalled()
})
