import { fixtureCivil as _hygiene_fixtureCivil, fixtureClock as _hygiene_fixtureClock, fixtureYear as _hygiene_fixtureYear } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentSessionHistoryPage } from '@agentmux/core'
import { Ruler } from '../src/renderer/src/components/ConversationRuler'
import { ConversationAxis } from '../src/renderer/src/components/ConversationAxis'
import { createRulerScale, describeRulerRange, rulerBand } from '../src/renderer/src/lib/activity-ruler'
import { conversationRulerRecords } from '../src/renderer/src/lib/conversation-ruler'

const sid = 'range-managed-session', native = 'range-native-session'
const start = new Date(_hygiene_fixtureYear - 1, 0, 1, 23, 30).getTime()
let container: HTMLDivElement, root: Root, home: string, client: AgentMuxClient, page: AgentSessionHistoryPage
let bandRect: DOMRect, controls: ReturnType<typeof vi.spyOn>[]
const feedRect = () => new DOMRect(10, 20, 332, 400)
const trackRect = () => new DOMRect(10, 50, 332, 14)
const records = () => conversationRulerRecords(sid, page, [])
const scale = () => createRulerScale(records().map(record => record.recordedAt), 332)
const select = vi.fn(), outsideEscape = vi.fn()

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('activity-ruler__band')) return bandRect
    if (this.classList.contains('activity-ruler__track')) return trackRect()
    return feedRect()
  })
  bandRect = new DOMRect(93, 50, 166, 14)
  home = await mkdtemp(join(tmpdir(), 'amx-ruler-range-')); await mkdir(join(home, 'workspace'))
  const transcript = join(home, 'conversation.jsonl')
  await writeFile(transcript, Array.from({ length: 5 }, (_, n) => JSON.stringify({
    uuid: `range-${n}`, type: 'assistant', sessionId: native,
    timestamp: new Date(start + n * 1_800_000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `Original reply ${n}` }] }
  })).join('\n') + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(home, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: sid, providerId: 'claude', executorId: 'claude',
    hostId: 'local', workspacePath: join(home, 'workspace'), run: { runId: 'range-original-run' }, retiredRuns: [],
    hookBindingId: 'range-private-hook', hookToken: 'range-private-token', createdAt: 1, updatedAt: 1,
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: native, transcriptPath: transcript } })
  client = new AgentMuxClient({ store }); page = await client.sessionHistoryPage(sid, { limit: 30 })
  expect(page.items).toHaveLength(5)
  controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(key =>
    vi.spyOn(Reflect.get(client, 'kernel'), key).mockImplementation(() => { throw new Error('Unexpected Runtime control') }))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  select.mockClear(); outsideEscape.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); window.getSelection()?.removeAllRanges()
  expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
  await client.dispose(); await rm(home, { recursive: true }); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function render(node: ReactNode) { await act(async () => root.render(node)) }
async function view(from = 1, to = 3, selectedIndex: number | null = null, extra: Partial<Parameters<typeof Ruler>[0]> = {}) {
  const current = scale()
  await render(<div className="activity-feed" onKeyDown={event => { if (event.key === 'Escape') outsideEscape() }}>
    <Ruler items={records()} scale={current} band={rulerBand(current, { from, to })} selectedIndex={selectedIndex} onSelect={select} {...extra} />
    <p id="original-body">Original selectable reply</p><textarea aria-label="Draft" defaultValue="Original draft" />
  </div>)
}
const track = () => container.querySelector<HTMLDivElement>('.activity-ruler__track')!
const popup = () => container.querySelector<HTMLElement>('.activity-ruler__readout')
async function move(x: number, y = 57) { await act(async () => track().dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))) }
async function key(key: string) { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); await act(async () => track().dispatchEvent(event)); return event }

it('uses actual public endpoint facts and loaded ordinal count without fabricating time', () => {
  const current = scale(), crossDay = describeRulerRange(current, rulerBand(current, { from: 0, to: 2 })!)
  expect(crossDay).toMatchObject({ axis: 'temporal', count: 3, from: (_hygiene_fixtureCivil(1, 1, -1) + " " + _hygiene_fixtureClock(23, 30, 0)), to: (_hygiene_fixtureCivil(1, 2, -1) + " " + _hygiene_fixtureClock(0, 30, 0)), elapsed: '1h00m00s' })
  const point = describeRulerRange(current, rulerBand(current, { from: 4, to: 4 })!)
  expect(point).toMatchObject({ axis: 'temporal', count: 1, elapsed: null })
  for (const times of [[undefined, undefined, undefined, undefined], [1, 1, 1, 1]]) {
    const ordinal = createRulerScale(times, 332)
    const result = describeRulerRange(ordinal, rulerBand(ordinal, { from: 1, to: 2 })!)
    expect(result).toEqual({ axis: 'ordinal', from: 2, to: 3, total: 4, count: 2 })
    expect(result).not.toHaveProperty('elapsed')
  }
})
it('hits the rendered three-pixel right endpoint and keeps outside hover a moment', async () => {
  await view(4, 4); bandRect = new DOMRect(339, 50, 3, 14)
  await move(340)
  expect(popup()?.dataset.body).toBe('range'); expect(popup()?.textContent).toContain('1 loaded record in range')
  expect(popup()?.textContent).not.toContain('elapsed')
  expect(select).not.toHaveBeenCalled(); expect(document.activeElement).not.toBe(track())
  await move(338)
  expect(popup()?.dataset.body).toBe('moment'); expect(popup()?.textContent).toContain('from start')
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
})
it('derives an open range from current band and stops consuming Escape when it disappears', async () => {
  await view(0, 2); await move(100)
  expect(popup()?.textContent).toContain((_hygiene_fixtureCivil(1, 1, -1) + " " + _hygiene_fixtureClock(23, 30, 0)))
  await view(2, 3)
  expect(popup()?.textContent).toContain('2 loaded records in range')
  expect(popup()?.textContent).not.toContain(_hygiene_fixtureCivil(1, 1, -1))
  await view(0, 4)
  expect(popup()).toBeNull()
  const escape = await key('Escape')
  expect(escape.defaultPrevented).toBe(false); expect(outsideEscape).toHaveBeenCalledOnce()
})
it('keeps slider focus and keyboard/click selection on actual records', async () => {
  await view(); await act(async () => track().focus())
  expect(popup()?.dataset.body).toBe('range')
  expect((await key('Escape')).defaultPrevented).toBe(true); expect(outsideEscape).not.toHaveBeenCalled()
  expect((await key('Escape')).defaultPrevented).toBe(false); expect(outsideEscape).toHaveBeenCalledOnce()
  await key('End'); expect(select).toHaveBeenLastCalledWith(4); expect(popup()?.dataset.body).toBe('moment')
  await view(1, 3, 2); await act(async () => { track().blur(); track().focus() })
  expect(popup()?.dataset.body).toBe('moment'); expect(popup()?.textContent).toContain(_hygiene_fixtureClock(0, 30, 0))
  await act(async () => track().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 176 })))
  expect(select).toHaveBeenLastCalledWith(2)
  expect(container.querySelectorAll('[role="slider"]')).toHaveLength(1)
})
it('replaces range, moment and sender quote in one original readout', async () => {
  await view(1, 3, null, { axes: ({ onPeek, onPeekEnd }) => <button onClick={() => onPeek({
    rect: new DOMRect(40, 30, 24, 24), name: 'Original agent', mark: { index: 1, fraction: .25,
      speaker: { role: 'agent', id: sid }, item: records()[1]! }
  })} onKeyDown={event => { if (event.key === 'Escape' && onPeekEnd()) event.stopPropagation() }}>Sender</button> })
  await move(100); expect(popup()?.dataset.body).toBe('range')
  await act(async () => container.querySelector('button')!.click())
  expect(popup()?.dataset.body).toBe('quote'); expect(popup()?.textContent).toContain('Original reply 1')
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
  await move(20); expect(popup()?.dataset.body).toBe('moment')
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
})
it('preserves surrounding body, connected Range, caret and draft across range updates', async () => {
  await view(); const body = container.querySelector('#original-body')!, text = body.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const editor = container.querySelector('textarea')!; editor.focus(); editor.setSelectionRange(3, 3)
  const feed = container.querySelector<HTMLElement>('.activity-feed')!; feed.scrollTop = 91
  await move(100); await view(2, 3)
  expect(container.querySelector('#original-body')).toBe(body); expect(text.isConnected).toBe(true)
  expect(selection.getRangeAt(0).startContainer).toBe(text); expect(selection.toString()).toBe('Original')
  expect(document.activeElement).toBe(editor); expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 3])
  expect(editor.value).toBe('Original draft'); expect(feed.scrollTop).toBe(91); expect(select).not.toHaveBeenCalled()
})


it('keeps the original participant host when the actual axis window becomes empty', async () => {
  let shown = records()
  const axes: NonNullable<Parameters<typeof Ruler>[0]['axes']> = ({ width, onPeek, onPeekEnd }) =>
    <ConversationAxis items={shown} belongs={() => true} label="Participants" size={16} width={width}
      describe={() => ({ name: 'Execution Agent' })} selectedIndex={null} onSelect={select}
      onPeek={onPeek} onPeekEnd={onPeekEnd} />
  await view(1, 3, null, { axes })
  const host = container.querySelector('.activity-ruler__participants'), originalTrack = track()
  expect(host).not.toBeNull()
  expect(host!.querySelector('[aria-label="Participants"]')).not.toBeNull()
  shown = [] // Process-only overview: no fake participant or accessible empty group.
  await view(1, 3, null, { axes })
  expect(container.querySelector('.activity-ruler__participants')).toBe(host)
  expect(host!.querySelector('[aria-label="Participants"]')).toBeNull()
  expect(host!.childElementCount).toBe(0)
  expect(track()).toBe(originalTrack)
  expect(container.querySelectorAll('.activity-ruler [role="slider"]')).toHaveLength(1)
})

it('adds no participant host without an actual presentation capability', async () => {
  await view()
  expect(container.querySelector('.activity-ruler__participants')).toBeNull()
  await view(1, 3, null, { axes: () => null })
  expect(container.querySelector('.activity-ruler__participants')).toBeNull()
  expect(track().getAttribute('role')).toBe('slider')
})
