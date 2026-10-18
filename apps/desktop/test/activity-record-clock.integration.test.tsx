import { fixtureClock as clock, fixtureYear } from '../scripts/lib/fixture-values.mjs'
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { activityReadingProps } from './helpers/activity-reading-props'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { formatClock } from '@agentmux/client-ui/conversation-time'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
let host: HTMLDivElement, root: Root
const fixtures: Awaited<ReturnType<typeof conversationPagePortFixture>>[] = []
const reference = { hostId: 'local', agentSessionId: 'clock-session' }
const source = { providerId: 'codex', nativeSessionId: 'original-clock-native' }
const start = new Date(fixtureYear, 9, 4, 9, 31, 15).getTime()
const at = (seconds: number) => start + seconds * 1000
const dateClock = (value: number) => {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${formatClock(value)}`
}
function event(id: string, overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return { id, agentSessionId: reference.agentSessionId, kind: 'tool_call', source: 'native-hook',
    status: 'complete', createdAt: start, updatedAt: start, title: id, ...overrides }
}
function native(id: string, startedAt?: number, completedAt?: number): AgentSessionHistoryItem {
  return { id, kind: 'activity', contentParts: [{ kind: 'text', text: `Original native ${id}` }],
    ...(startedAt === undefined ? {} : { startedAt }), ...(completedAt === undefined ? {} : { completedAt }) }
}
async function mount(items: AgentTimelineItem[], originals: AgentSessionHistoryItem[] = []) {
  expect(items.length + originals.length).toBeGreaterThan(0)
  const page: AgentSessionHistoryPage = { agentSessionId: reference.agentSessionId, source, items: originals, nextCursor: null }
  const f = await conversationPagePortFixture(reference, source, async () => page); fixtures.push(f)
  const stream = await f.publishCaptured(items), props = activityReadingProps({ control: reference })
  await act(async () => root.render(<ActivityView {...props} />))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    expect(f.acceptedCaptured(stream)).toBe(true)
    const consumer = inspectConversationConsumers(reference).consumers[0]
    expect(consumer?.loading).toBe(false); expect(consumer?.inFlight).toBe(false)
  })
  return { f, props }
}
function fold(): HTMLButtonElement {
  const node = host.querySelector<HTMLButtonElement>('.log-fold'); expect(node).not.toBeNull(); return node!
}
function expectSpan(group: HTMLElement, from: string, to: string) {
  expect(group.title).toContain(`${from} – ${to} · Observed record span, not execution duration · Offset not recorded`)
  expect(group.getAttribute('aria-description')).toBe(group.title)
  expect(group.querySelector('.log-fold__time'), 'Compact clocks stay in the keyboard/hover description').toBeNull()
  expect(group.querySelector('.log-fold__elapsed'), 'Record span is not execution duration').toBeNull()
}
function times(): HTMLElement[] {
  const nodes = [...host.querySelectorAll<HTMLElement>('.log-row__time')]; expect(nodes.length).toBeGreaterThan(0); return nodes
}
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host) })
afterEach(async () => {
  window.getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove()
  try { for (const f of fixtures) f.controls.forEach(control => expect(control).not.toHaveBeenCalled()) }
  finally { for (const f of fixtures.splice(0).reverse()) await f.close(); vi.restoreAllMocks() }
})

describe('Activity actual recorded clock consumption', () => {
  it('renders the captured group first/max-updated range and preserves its count, disclosure and selected head', async () => {
    const { props, f } = await mount([event('first', { updatedAt: at(300) }), event('last', { createdAt: at(1), updatedAt: at(2) })])
    const group = fold(); expectSpan(group, clock(9, 31, 15), clock(9, 36, 15))
    expect(group.querySelector('.log-fold__steps')?.textContent).toBe('2 条已加载记录')
    expect(group.getAttribute('aria-expanded')).toBe('false')
    const text = group.querySelector('.log-fold__steps')!.firstChild!, range = document.createRange()
    range.selectNodeContents(text); window.getSelection()!.addRange(range)
    const before = f.nativeRead.mock.calls.length
    await act(async () => root.render(<ActivityView {...props} displayState="working" />))
    expect(fold()).toBe(group); expect(range.startContainer).toBe(text); expect(range.toString()).toBe('2')
    expect(f.nativeRead).toHaveBeenCalledTimes(before); window.getSelection()!.removeAllRanges()
    await act(async () => group.click())
    expect(times().map(time => time.textContent)).toEqual([clock(9, 31, 15), clock(9, 31, 16)])
    expect(times().map(time => time.title)).toEqual(['+0ms from start', '+1.0s from start'])
  })
  it.each([false, true])('keeps a single captured record clock, failed status, keyboard access and its %s original payload', async expandable => {
    await mount([event('single', { createdAt: at(15), updatedAt: at(20), source: 'acp',
      ...(expandable ? { toolInput: 'Exact command argument' } : {}), status: 'failed' })])
    expectSpan(fold(), clock(9, 31, 30), clock(9, 31, 35)); await act(async () => fold().click())
    const row = host.querySelector<HTMLButtonElement>('.log-row')!; expect(row).not.toBeNull()
    expect(times().map(time => time.textContent)).toEqual([clock(9, 31, 30)])
    expect(times().map(time => time.title)).toEqual(['+0ms from start'])
    expect(row.dataset.status).toBe('failed'); expect(row.querySelector('.log-row__chip--failed')?.textContent).toBe('Failed')
    expect(row.getAttribute('aria-description')).toBe('+0ms from start'); row.focus(); expect(document.activeElement).toBe(row)
    await act(async () => row.click()); expect(row.getAttribute('aria-expanded')).toBe('true')
    if (expandable) expect(host.querySelector('pre')?.textContent).toBe('Exact command argument')
    else expect(JSON.parse(host.querySelector('pre')!.textContent!)).toMatchObject({ id: 'single', status: 'failed', source: 'acp' })
  })
  it('shows both actual dates across 48h instead of an ambiguous clock-only or execution range', async () => {
    const later = at(48 * 3600 + 24 * 60)
    await mount([event('initial'), event('late', { createdAt: later, updatedAt: later + 10_000 })])
    const group = fold(); expectSpan(group, dateClock(start), dateClock(later + 10_000))
    expect(group.querySelector('.log-fold__steps')?.textContent).toBe('2 条已加载记录')
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="History window: 24h"]')!
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const rangeOption = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent === '3d reading window')!
    expect(rangeOption).toBeDefined(); await act(async () => rangeOption.click())
    const rulerRange = host.querySelector('.activity-ruler__span-range')!; expect(rulerRange).not.toBeNull()
    expect([...rulerRange.children].map(child => child.textContent)).toEqual([dateClock(start), '', dateClock(later)])
    await act(async () => group.click()); expect(times().map(time => time.textContent)).toEqual([formatClock(start), formatClock(later)])
    expect(times()[1]!.title).toBe('+48h24m00s from start')
  })
  it('retains distinct original IDs, failed steps and same-instant clocks without manufacturing elapsed time', async () => {
    await mount([event('repeat-1', { title: 'Same tool', toolInput: 'same', status: 'failed' }), event('repeat-2', { title: 'Same tool', toolInput: 'same', status: 'failed' })])
    const group = fold(); expectSpan(group, clock(9, 31, 15), clock(9, 31, 15))
    expect(group.querySelector('.log-fold__steps')?.textContent).toBe('2 条已加载记录'); await act(async () => group.click())
    expect([...host.querySelectorAll('.log-row__chip--failed')].map(node => node.textContent)).toEqual(['Failed', 'Failed'])
    expect(times().map(time => time.textContent)).toEqual([clock(9, 31, 15), clock(9, 31, 15)])
    expect([...host.querySelectorAll('[data-observation-step-id]')].map(node => node.getAttribute('data-observation-step-id'))).toEqual(['repeat-1', 'repeat-2'])
    expect(host.querySelector('.activity-ruler__track')?.getAttribute('data-axis')).toBe('ordinal')
  })
  it('keeps readable input bytes outside each exact process range and group identity', async () => {
    await mount([event('one'), event('two', { createdAt: at(1), updatedAt: at(2) }),
      event('input', { kind: 'user_message', source: 'user', createdAt: at(3), updatedAt: at(3), content: 'Original input bytes' }),
      event('three', { createdAt: at(4), updatedAt: at(5) }), event('four', { createdAt: at(6), updatedAt: at(7) })])
    const groups = [...host.querySelectorAll<HTMLElement>('.log-fold')]
    expect(groups.map(group => group.querySelector('.log-fold__steps')?.textContent)).toEqual(['2 条已加载记录', '2 条已加载记录'])
    expectSpan(groups[0]!, formatClock(start), formatClock(at(2))); expectSpan(groups[1]!, formatClock(at(4)), formatClock(at(7)))
    const original = host.querySelector<HTMLDetailsElement>('[data-submission-id="input"] .message-disclosure')!
    await act(async () => { original.open = true; original.dispatchEvent(new Event('toggle')) })
    expect([...host.querySelectorAll('.log-turn__body')].map(node => node.textContent)).toEqual(['Original input bytes'])
    expect(host.querySelectorAll('.log-turn')).toHaveLength(1)
    expect(new Set([...host.querySelectorAll('[data-conversation-process-key]')].map(node => node.getAttribute('data-conversation-process-key'))).size).toBe(2)
  })
  it.each(['first', 'middle'])('keeps the group unknown when its %s native member has no original start, without borrowing a neighbor clock', async position => {
    const known = native('known', start, at(300)), unknown = native('unknown')
    await mount([], position === 'first' ? [unknown, known] : [known, unknown])
    const group = fold(); expect(group.title).not.toContain(' – '); expect(group.title).not.toMatch(/NaN|Invalid Date/u)
    expect(group.getAttribute('aria-description')).toBe(group.title)
    expect(group.querySelector('.log-fold__steps')?.textContent).toBe('2 条已加载记录'); await act(async () => group.click())
    const missing = host.querySelector('[data-native-step-id="unknown"]')!
    expect(missing.querySelector('.log-row__time')).toBeNull()
    expect(missing.querySelector('[data-observation-step-id]')?.getAttribute('data-recorded-time')).toBe('false')
    expect(host.querySelector('[data-native-step-id="known"] .log-row__time')?.textContent).toBe(formatClock(start))
  })
  it('uses the first native start and maximum original completion even when the last member ends earlier', async () => {
    await mount([], [native('native-first', start, at(300)), native('native-last', at(1), at(2))])
    expectSpan(fold(), formatClock(start), formatClock(at(300)))
    expect(fold().querySelector('.log-fold__steps')?.textContent).toBe('2 条已加载记录')
  })
  it('uses all original sources for one mixed process span without changing members or recorded states', async () => {
    await mount([event('captured-max', { createdAt: at(1), updatedAt: at(300), status: 'streaming' }),
      event('captured-last', { createdAt: at(2), updatedAt: at(3) })], [native('native-first', start, at(4))])
    expectSpan(fold(), formatClock(start), formatClock(at(300)))
    expect(fold().querySelector('.log-fold__steps')?.textContent).toBe('3 条已加载记录')
    expect(host.querySelectorAll('[data-conversation-process-key]')).toHaveLength(1); await act(async () => fold().click())
    expect(host.querySelector('[data-observation-step-id="captured-max"]')?.getAttribute('data-status')).toBe('streaming')
    expect(host.querySelector('[data-native-step-id="native-first"]')).not.toBeNull()
    expect([...host.querySelectorAll('[data-observation-step-id]')].map(node => node.getAttribute('data-observation-step-id'))).toEqual(['native-first', 'captured-max', 'captured-last'])
  })
})
