// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTimelineItem } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { formatClock } from '../src/renderer/src/lib/activity-ruler'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })

let host: HTMLDivElement
let root: Root
const start = new Date(2026, 9, 4, 9, 31, 15).getTime()
const at = (seconds: number): number => start + seconds * 1000
const dateClock = (value: number): string => {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${formatClock(value)}`
}
function event(id: string, overrides: Partial<AgentTimelineItem> = {}): AgentTimelineItem {
  return { id, agentSessionId: 'clock-session', kind: 'tool_call', source: 'native-hook',
    status: 'complete', createdAt: start, updatedAt: start, title: id, ...overrides }
}
async function mount(items: AgentTimelineItem[]): Promise<void> {
  expect(items.length).toBeGreaterThan(0)
  await act(async () => root.render(<ActivityView sessionId="clock-session" items={items} capability="complete-events" />))
  expect(host.querySelectorAll('.activity-log__segment').length).toBeGreaterThan(0)
}
function fold(): HTMLButtonElement {
  const node = host.querySelector<HTMLButtonElement>('.log-fold')
  expect(node).not.toBeNull()
  return node!
}
function times(): HTMLElement[] {
  const nodes = [...host.querySelectorAll<HTMLElement>('.log-row__time')]
  expect(nodes.length).toBeGreaterThan(0)
  return nodes
}
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('Activity actual recorded clock consumption', () => {
  it('renders the group first/max-updated range and keeps keyboard/hover offsets outside the main clock', async () => {
    await mount([event('first', { createdAt: start, updatedAt: at(300) }), event('last', { createdAt: at(1), updatedAt: at(2) })])
    const group = fold()
    const time = group.querySelector<HTMLElement>('.log-fold__time')!
    expect(time).not.toBeNull()
    expect([...time.children].map(child => child.textContent)).toEqual(['09:31:15', '–', '09:36:15'])
    expect(time.title).toBe('+0ms to +5m00s from start')
    expect(group.getAttribute('aria-description')).toBe(time.title)
    expect(group.querySelector('.log-fold__steps')?.textContent).toBe('2 steps')
    expect(group.querySelector('.log-fold__elapsed')?.textContent).toBe('5m00s')
    expect(time.textContent).not.toContain('+')
    expect(group.getAttribute('aria-expanded')).toBe('false')
    await act(async () => group.click())
    expect(times().map(time => time.textContent)).toEqual(['09:31:15', '09:31:16'])
    expect(times().map(time => time.title)).toEqual(['+0ms from start', '+1.0s from start'])
  })

  it.each([false, true])('renders the %s expandable single-row branch at its concrete clock with the original payload', async expandable => {
    await mount([event('single', { createdAt: at(15), updatedAt: at(20), source: 'acp',
      ...(expandable ? { toolInput: 'Exact command argument' } : {}), status: 'failed' })])
    const row = host.querySelector<HTMLElement>('.log-row')!
    expect(row).not.toBeNull()
    expect(times().map(time => time.textContent)).toEqual(['09:31:30'])
    expect(times().map(time => time.title)).toEqual(['+0ms from start'])
    expect(row.dataset.status).toBe('failed')
    expect(row.querySelector('.log-row__chip--failed')?.textContent).toBe('Failed')
    if (expandable) {
      expect(row.getAttribute('aria-description')).toBe('+0ms from start')
      await act(async () => row.click())
      expect(row.getAttribute('aria-expanded')).toBe('true')
      expect(host.querySelector('.log-row__payload')?.textContent).toBe('Exact command argument')
    } else {
      expect(row.tagName).toBe('DIV')
      expect(times()[0]!.tagName).toBe('TIME')
      expect(times()[0]!.tabIndex).toBe(0)
      expect(times()[0]!.getAttribute('aria-description')).toBe('+0ms from start')
      times()[0]!.focus()
      expect(document.activeElement).toBe(times()[0])
      expect(row.hasAttribute('aria-expanded')).toBe(false)
    }
  })

  it('shows both actual dates across 48h instead of an ambiguous clock-only or offset range', async () => {
    const later = at(48 * 3600 + 24 * 60)
    await mount([event('initial'), event('late', { createdAt: later, updatedAt: later + 10_000 })])
    const group = fold()
    const time = group.querySelector<HTMLElement>('.log-fold__time')!
    expect([...time.children].map(child => child.textContent)).toEqual([dateClock(start), '–', dateClock(later + 10_000)])
    expect(time.title).toBe('+0ms to +48h24m10s from start')
    expect(time.textContent).not.toContain('+48h')
    expect(group.querySelector('.log-fold__steps')?.textContent).toBe('2 steps')
    const rulerRange = host.querySelector('.activity-ruler__span-range')!
    expect(rulerRange).not.toBeNull()
    expect(rulerRange.textContent).toBe(`${dateClock(start)}→${dateClock(later)}`)
    await act(async () => group.click())
    expect(times().map(time => time.textContent)).toEqual([formatClock(start), formatClock(later)])
    expect(times()[1]!.title).toBe('+48h24m00s from start')
  })

  it('retains exact duplicate counts, failed status and concrete same-instant records without making elapsed time', async () => {
    await mount([event('repeat-1', { title: 'Same tool', toolInput: 'same', status: 'failed' }), event('repeat-2', { title: 'Same tool', toolInput: 'same', status: 'failed' })])
    const group = fold()
    expect([...group.querySelector('.log-fold__time')!.children].map(child => child.textContent)).toEqual(['09:31:15', '–', '09:31:15'])
    expect(group.querySelector('.log-fold__elapsed')).toBeNull()
    expect(group.querySelector('.log-row__chip--failed')?.textContent).toBe('FAILED')
    expect(group.querySelector('.log-row__count')?.textContent).toBe('1 unique')
    await act(async () => group.click())
    expect(times().map(time => time.textContent)).toEqual(['09:31:15'])
    expect(host.querySelector('.log-row .log-row__count')?.textContent).toBe('×2')
    expect(host.querySelector('.activity-ruler__track')?.getAttribute('data-axis')).toBe('ordinal')
  })

  it('does not fold a readable input into the range or change original message bytes', async () => {
    await mount([event('one'), event('two', { createdAt: at(1), updatedAt: at(2) }),
      event('input', { kind: 'user_message', source: 'user', createdAt: at(3), updatedAt: at(3), content: 'Original input bytes' }),
      event('three', { createdAt: at(4), updatedAt: at(5) }), event('four', { createdAt: at(6), updatedAt: at(7) })])
    expect([...host.querySelectorAll('.log-fold__steps')].map(node => node.textContent)).toEqual(['2 steps', '2 steps'])
    expect([...host.querySelectorAll('.log-turn__body')].map(node => node.textContent)).toEqual(['Original input bytes'])
    expect(host.querySelectorAll('.log-turn')).toHaveLength(1)
  })

  it('keeps invalid recorded time honestly unknown instead of NaN clock or a manufactured timestamp', async () => {
    await mount([event('invalid', { source: 'acp', createdAt: Number.NaN, updatedAt: Number.NaN })])
    expect(times().map(time => time.textContent)).toEqual(['Unknown time'])
    expect(times().map(time => time.title)).toEqual(['Offset not recorded'])
    expect(host.querySelectorAll('.log-row')).toHaveLength(1)
  })
})
