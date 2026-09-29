// @vitest-environment happy-dom
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import * as UserMessages from '@agentmux/core/session-user-messages'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { HOUR_MS, localDateTime } from '../src/renderer/src/lib/focus-time-window'

const NOW = Date.parse('2026-10-03T12:00:00Z'), baseline = useAppStore.getState()
const roots: Root[] = [], elements: HTMLElement[] = [], cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const element of elements.splice(0)) element.remove()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})

/** Real private FileStore and public Provider Reader; only the existing Renderer transport is isolated. */
async function fixture(count = 130) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const directory = await mkdtemp(join(tmpdir(), 'focus-navigation-')), path = join(directory, 'native.jsonl')
  await writeFile(path, Array.from({ length: count }, (_, i) => JSON.stringify({ sessionId: 'native-navigation', uuid: `record-${i}`, type: 'user', message: { role: 'user', content: `Original native task ${i}` }, timestamp: new Date(NOW - HOUR_MS).toISOString() })).join('\n') + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'archived-navigation', providerId: 'claude', executorId: 'private', hostId: 'private-host', workspacePath: directory, run: { runId: 'never-started' }, retiredRuns: [], hookBindingId: 'private', hookToken: 'private', createdAt: 1, updatedAt: 1, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-navigation', transcriptPath: path } }
  await store.compareAndSwap(null, session)
  await store.applyTimelineMutation({ type: 'append', agentSessionId: session.agentSessionId, item: { id: 'captured', agentSessionId: session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', createdAt: NOW - HOUR_MS, updatedAt: NOW - HOUR_MS, title: 'Input', content: 'Original captured task' } })
  const reservation = { kind: 'stop' as const, reservationId: 'retire', ownerId: 'private', ownerPid: process.pid, agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'retire', expiresAt: NOW + 60_000, stopOperation: { daemonInstance: 'no-runtime', operationKey: 'not-a-stop', runId: session.run.runId } }
  await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null)
  const client = new AgentMuxClient({ store })
  const pendingReads = new Set<Promise<unknown>>()
  function read<T>(promise: Promise<T>): Promise<T> {
    pendingReads.add(promise)
    void promise.then(() => pendingReads.delete(promise), () => pendingReads.delete(promise))
    return promise
  }
  cleanups.push(async () => {
    await Promise.allSettled([...pendingReads])
    expect(pendingReads.size).toBe(0)
    await client.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const control = vi.spyOn(client, 'connect').mockRejectedValue(new Error('No Runtime permitted'))
  const catalog = vi.spyOn(api.sessions, 'historySources').mockImplementation(() => read(client.sessionHistorySources()))
  const page = vi.spyOn(api.sessions, 'historyPage').mockImplementation((reference, options) => read(client.sessionHistoryPage(reference.agentSessionId, options)))
  const timeline = vi.spyOn(api.sessions, 'timeline').mockImplementation(reference => read(client.sessionTimeline(reference.agentSessionId)))
  const projector = vi.spyOn(UserMessages, 'projectSessionUserMessages')
  useAppStore.setState({ sessions: [], timelines: {}, config: null, tabs: {}, layouts: {}, agentFocus: EMPTY_AGENT_FOCUS, agentComposerDrafts: { original: 'Keep my draft' } })
  const element = document.createElement('div'); document.body.append(element); elements.push(element)
  const root = createRoot(element); roots.push(root)
  const onSelect = vi.fn()
  await act(async () => root.render(createElement(RecentFocusTimeline, { contexts: [], entries: [], currentSessionId: null, onSelect })))
  const scale = element.querySelector<HTMLElement>('.recent-focus__time-scale')!
  expect(scale).not.toBeNull()
  vi.spyOn(scale, 'getBoundingClientRect').mockReturnValue({ x: 112, y: 28, left: 112, right: 512, top: 28, bottom: 46, width: 400, height: 18, toJSON() {} })
  const range = () => { const node = element.querySelector<HTMLElement>('.recent-focus')!; expect(node).not.toBeNull(); return [Number(node.dataset.windowStart), Number(node.dataset.windowEnd)] }
  const wait = async (check: () => void) => { for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); try { check(); return } catch (error) { if (i === 99) throw error } } }
  const click = (label: string) => act(async () => { const button = element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(button).not.toBeNull(); button!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); button!.click() })
  const wheel = async (init: WheelEventInit, target: Element = scale) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    // happy-dom's WheelEvent extends Event rather than MouseEvent. Supply the
    // browser's standard read-only modifiers in this transport fixture only.
    for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey'] as const) Object.defineProperty(event, modifier, { value: init[modifier] ?? false })
    await act(async () => target.dispatchEvent(event)); return event
  }
  const choose = async () => {
    await click('View input records')
    await wait(() => expect(document.querySelector('[aria-label="Input records Context"] option[value="archived-navigation"]')).not.toBeNull())
    await act(async () => { const select = document.querySelector<HTMLSelectElement>('[aria-label="Input records Context"]')!; select.value = session.agentSessionId; select.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  const inputs = () => [...document.querySelectorAll<HTMLElement>('[data-input-message-id]')]
  const counts = () => [catalog.mock.calls.length, page.mock.calls.length, timeline.mock.calls.length, projector.mock.calls.length]
  const unchanged = () => { expect(control.mock.calls).toEqual([]); expect(onSelect.mock.calls).toEqual([]); expect(useAppStore.getState().agentComposerDrafts).toEqual({ original: 'Keep my draft' }); expect(useAppStore.getState().agentFocus).toEqual(EMPTY_AGENT_FOCUS) }
  return { root, element, scale, range, wheel, click, wait, choose, inputs, counts, page, client, unchanged }
}

it('pans the actual time surface in both directions while normal vertical, gutters, controls and pinch retain native behavior', async () => {
  const h = await fixture(1), start = h.range()
  expect((await h.wheel({ deltaX: 100 })).defaultPrevented).toBe(true)
  expect(h.range()).toEqual(start.map(time => time + HOUR_MS))
  await h.wheel({ shiftKey: true, deltaY: -100 }); expect(h.range()).toEqual(start)
  for (const init of [{ deltaY: 100 }, { ctrlKey: true, deltaX: 100 }, { metaKey: true, deltaX: 100 }]) expect((await h.wheel(init)).defaultPrevented).toBe(false)
  const gutter = h.element.querySelector('.recent-focus__gutter')!, control = h.element.querySelector('[aria-label="Focus window size"]')!
  for (const target of [gutter, control]) expect((await h.wheel({ deltaX: 100 }, target)).defaultPrevented).toBe(false)
  expect(h.range()).toEqual(start); h.unchanged()
})

it('uses real ruler geometry for pixel, line and page deltas and accumulates every rapid native event', async () => {
  const h = await fixture(1), start = h.range()
  await h.wheel({ deltaX: 1, deltaMode: 1 }); expect(h.range()).toEqual(start.map(time => time + .16 * HOUR_MS))
  await h.wheel({ deltaX: 1, deltaMode: 2 }); expect(h.range()).toEqual(start.map(time => time + 4.16 * HOUR_MS))
  await act(async () => { for (let i = 0; i < 200; i++) h.scale.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: -1 })) })
  expect(h.range()).toEqual(start.map(time => time + 2.16 * HOUR_MS)); h.unchanged()
})

it('zooms through all eleven requested presets around a historical anchor, disables both bounds and preserves Now mode', async () => {
  const h = await fixture(1)
  const select = h.element.querySelector<HTMLSelectElement>('[aria-label="Focus window size"]')!
  const plus = h.element.querySelector<HTMLButtonElement>('[aria-label="Zoom in Focus timeline"]')!, minus = h.element.querySelector<HTMLButtonElement>('[aria-label="Zoom out Focus timeline"]')!
  expect([plus, minus]).not.toContain(null); expect(plus.title).toContain('narrower'); expect(minus.title).toContain('wider')
  const presets = ['0.5', '1', '2', '4', '6', '8', '12', '18', '24', '36', '48']
  expect([...select.options].map(option => [option.value, option.text])).toEqual([
    ['0.5', '30m'], ['1', '1h'], ['2', '2h'], ['4', '4h'], ['6', '6h'], ['8', '8h'],
    ['12', '12h'], ['18', '18h'], ['24', '24h'], ['36', '1.5d'], ['48', '2d']
  ])
  expect(plus.tabIndex).toBe(0)
  for (const expected of ['2', '1', '0.5']) { await h.click('Zoom in Focus timeline'); expect(select.value).toBe(expected) }
  expect(plus.disabled).toBe(true)
  expect(h.element.querySelector('[aria-label="Return to current focus window"]')?.getAttribute('aria-pressed')).toBe('true')
  await h.wheel({ deltaX: -400 }); const anchor = h.range()[0]! + .375 * HOUR_MS
  for (const expected of presets.slice(1)) {
    await h.click('Zoom out Focus timeline'); expect(select.value).toBe(expected)
    expect(h.range()).toEqual([anchor - Number(expected) * .75 * HOUR_MS, anchor + Number(expected) * .25 * HOUR_MS])
  }
  expect(select.value).toBe('48'); expect(minus.disabled).toBe(true)
  expect(h.element.querySelector('[aria-label="Return to current focus window"]')?.getAttribute('aria-pressed')).toBe('false'); h.unchanged()
})

it('keeps one public 90-raw snapshot across 200 pan/zoom actions with zero page, catalog, timeline or projector amplification and preserves the preview Range', async () => {
  const h = await fixture(); await h.choose(); await h.wait(() => expect(h.inputs()).toHaveLength(91))
  expect(h.page.mock.calls.map(call => call[1]?.limit)).toEqual([30, 30, 30])
  await act(async () => h.inputs()[0]!.click())
  const body = document.querySelector('[data-input-preview-id]')!; expect(body.textContent).toContain('Original native task')
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let text: Node | null
  while ((text = walker.nextNode()) && !text.textContent?.includes('Original native task')) {}
  expect(text).not.toBeNull(); const range = document.createRange(); range.selectNodeContents(text!)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  const before = h.counts(); expect(before.slice(0, 3)).toEqual([1, 3, 1]); expect(before[3]).toBeGreaterThan(0)
  for (let i = 0; i < 100; i++) { await h.wheel({ deltaX: i % 2 ? -400 : 400 }); await h.click(i % 2 ? 'Zoom in Focus timeline' : 'Zoom out Focus timeline') }
  expect(h.counts()).toEqual(before); expect(h.inputs()).toHaveLength(91)
  expect(document.querySelector('[data-input-preview-id]')).toBe(body); expect(selection.toString()).toBe(selected)
  expect(document.querySelector('.recent-focus__message-preview')).not.toBeNull(); h.unchanged()
})

it('accepts a truly read but delayed same-source page into its snapshot and filters markers by the newer viewport without closing a captured preview', async () => {
  const h = await fixture(1)
  let release!: () => void, actuallyRead = false; const gate = new Promise<void>(resolve => { release = resolve })
  h.page.mockImplementation(async (reference, options) => { const page = await h.client.sessionHistoryPage(reference.agentSessionId, options); actuallyRead = true; await gate; return page })
  await h.choose(); await h.wait(() => expect(actuallyRead).toBe(true)); await h.wait(() => expect(h.inputs()).toHaveLength(1))
  await act(async () => h.inputs()[0]!.click()); const body = document.querySelector('[data-input-preview-id]')!; expect(body.textContent).toContain('Original captured task')
  await h.wheel({ deltaX: 400 }); await act(async () => { release(); await gate })
  await h.wait(() => expect(h.inputs()).toHaveLength(2)); expect(h.page.mock.calls).toHaveLength(1)
  expect(h.element.querySelectorAll('[data-message-id]')).toHaveLength(0)
  expect(document.querySelector('[data-input-preview-id]')).toBe(body); h.unchanged()
})

it('date and window buttons browse an already read source without clearing it or beginning another batch', async () => {
  const h = await fixture(1); await h.choose(); await h.wait(() => expect(h.inputs()).toHaveLength(2)); const before = h.counts()
  await act(async () => { const input = h.element.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, localDateTime(NOW - HOUR_MS)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
  await h.click('Previous focus window'); await h.click('Next focus window'); await h.click('Return to current focus window')
  expect(h.counts()).toEqual(before); expect(h.inputs()).toHaveLength(2); h.unchanged()
})

it('removes the native wheel listener when collapsed and unmounted instead of retaining a detached timeline consumer', async () => {
  const h = await fixture(1), start = h.range(), detachedScale = h.scale
  await h.click('Collapse focus history'); expect((await h.wheel({ deltaX: 400 }, detachedScale)).defaultPrevented).toBe(false)
  await h.click('Show focus history'); expect(h.range()).toEqual(start)
  const mounted = h.element.querySelector('.recent-focus__time-scale')!; expect(mounted).not.toBe(detachedScale)
  await act(async () => h.root.unmount()); roots.splice(roots.indexOf(h.root), 1)
  expect((await h.wheel({ deltaX: 400 }, mounted)).defaultPrevented).toBe(false); h.unchanged()
})
