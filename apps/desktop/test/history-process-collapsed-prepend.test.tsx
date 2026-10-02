const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { SessionHistoryView } from '../src/renderer/src/components/SessionHistoryView'

const fixture = vi.hoisted(() => ({ historyPage: vi.fn(), clipboard: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: {
  sessions: { historyPage: fixture.historyPage }, ui: { writeClipboardText: fixture.clipboard }
} }))
const control = { hostId: 'local', agentSessionId: 'collapsed-history' }
const item = (id: string, turnId: string): AgentSessionHistoryItem => ({ id, kind: 'activity', turnId,
  title: id, contentParts: [{ kind: 'text', text: `Exact body ${id}` }] })
const page = (items: AgentSessionHistoryItem[], nextCursor: string | null): AgentSessionHistoryPage => ({
  agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'native-history' }, items, nextCursor
})
let root: Root, container: HTMLDivElement
const bounds = (top: number, height: number): DOMRect => ({ top, bottom: top + height, left: 0, right: 500,
  width: 500, height, x: 0, y: top, toJSON() {} }) as DOMRect
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  fixture.historyPage.mockReset().mockResolvedValue(page([item('current-first', 'same-turn'), item('current-next', 'same-turn')], 'opaque-earlier'))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  // A bounded DOM geometry oracle, not physical browser evidence. Hidden real rows have no geometry.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('session-history__viewport')) return bounds(0, 240)
    if (this.closest('[hidden]')) return bounds(0, 0)
    const viewport = container.querySelector<HTMLElement>('.session-history__viewport')
    const cards = Array.from(container.querySelectorAll('.wf-card--observation'))
    const card = this.closest('.wf-card--observation')
    const cardTop = 24 + Math.max(0, cards.indexOf(card!)) * 128 - (viewport?.scrollTop ?? 0)
    if (this.classList.contains('wf-head')) return bounds(cardTop, 24)
    if (this.hasAttribute('data-history-item-id')) return bounds(cardTop + 32, 28)
    return bounds(0, 0)
  })
})
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function mount() {
  await act(async () => root.render(<SessionHistoryView control={control} label="History" visible themeId="graphite"
    fontSize={12} workspaceRoot={_hygiene_fixturePath("private")} openWorkspaceFile={vi.fn()} openHttpLink={vi.fn()} />))
}
function head() { const found = container.querySelector<HTMLButtonElement>('.wf-head'); expect(found, 'real visible shared Workflow group header').not.toBeNull(); return found! }
function viewport() { return container.querySelector<HTMLDivElement>('.session-history__viewport')! }
async function prepend() {
  let finish!: (value: AgentSessionHistoryPage) => void
  fixture.historyPage.mockImplementationOnce(() => new Promise<AgentSessionHistoryPage>(resolve => { finish = resolve }))
  const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.trim() === 'Load earlier records')!
  await act(async () => button.click())
  await act(async () => finish(page([item('earlier-separate', 'earlier-turn'), item('new-group-first', 'same-turn')], null)))
}
it('keeps real raw article shells and the existing expanded-row anchor through an opaque prepend', async () => {
  await mount()
  const original = container.querySelector('[data-history-item-id="current-first"]')!
  expect(head().getAttribute('aria-expanded')).toBe('true')
  expect(original.getBoundingClientRect().height).toBeGreaterThan(0)
  const offset = original.getBoundingClientRect().top
  await prepend()
  expect(container.querySelector('[data-history-item-id="current-first"]')).toBe(original)
  expect(original.getBoundingClientRect().top).toBe(offset)
  expect(fixture.historyPage.mock.calls).toEqual([[control, undefined], [control, { cursor: 'opaque-earlier' }]])
})
it('keeps the same visible collapsed process header anchored when its first raw ID changes on prepend', async () => {
  await mount()
  const originalHead = head(), originalCard = originalHead.closest('.wf-card--observation')!
  await act(async () => originalHead.click())
  expect(originalHead.getAttribute('aria-expanded')).toBe('false')
  const originalRaw = container.querySelector('[data-history-item-id="current-first"]')!
  expect(originalRaw.getBoundingClientRect().height).toBe(0)
  const before = originalHead.getBoundingClientRect().top
  await prepend()
  expect(container.querySelectorAll('.wf-card--observation')).toHaveLength(2)
  expect(container.querySelectorAll('.wf-head')[1]).toBe(originalHead)
  expect(originalHead.closest('.wf-card--observation')).toBe(originalCard)
  expect(originalHead.getAttribute('aria-expanded')).toBe('false')
  expect(container.querySelector('[data-history-item-id="current-first"]')).toBe(originalRaw)
  // The original group is retained, but older records replace its previous first ID.
  expect(originalHead.closest('[data-history-group-anchor]')?.querySelector('[data-history-item-id]')?.getAttribute('data-history-item-id')).toBe('new-group-first')
  expect(originalHead.getBoundingClientRect().top, 'same actual header pixel anchor').toBe(before)
})
it('keeps a collapsed group containing real newest raw records inside the original three-page fence', async () => {
  await mount()
  const originalHead = head(), original = container.querySelector('[data-history-item-id="current-first"]')!
  await act(async () => originalHead.click())
  fixture.historyPage.mockResolvedValueOnce(page([item('earlier-1', 'earlier-turn-1')], 'opaque-2'))
    .mockResolvedValueOnce(page([item('earlier-2', 'earlier-turn-2')], 'opaque-3'))
    .mockResolvedValueOnce(page([item('earlier-3', 'earlier-turn-3')], 'opaque-4'))
  for (let index = 0; index < 3; index++) {
    const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.trim() === 'Load earlier records')!
    expect(button).toBeDefined(); await act(async () => button.click())
  }
  expect(container.textContent).toContain('preserve your reading position')
  expect(container.querySelector('[data-history-item-id="current-first"]')).toBe(original)
  expect(container.querySelector('[data-history-item-id="earlier-3"]')).toBeNull()
  expect(container.querySelectorAll('[data-history-item-id]')).toHaveLength(4)
  expect(originalHead.getAttribute('aria-expanded')).toBe('false')
  expect(originalHead.getBoundingClientRect().top).toBe(24)
  expect(fixture.historyPage).toHaveBeenCalledTimes(4)
})
