// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
const observers = new Set<{ targets: Set<Element>; callback: ResizeObserverCallback }>()
const sizes = new Map<string, number>()
let offsetReads = 0, cardObserverRegistrations = 0
const entries = () => ['first', 'middle', 'last'].map(operationId => ({ operationId, runId: 'run-agent-1', text: 'Original ' + operationId, status: 'queued' as const, promptCondition: null }))
const cards = () => [...document.querySelectorAll<HTMLElement>('.composer-pending__card')]
const card = (id: string) => cards().find(node => node.dataset.operationId === id)!
const editor = () => dom.container.querySelector<HTMLElement>('[role="textbox"]')!
const render = async () => dom.render(<AgentSessionComposer sessionId="agent-1" />)
async function resize(target: Element) {
  await act(async () => {
    for (const observer of observers) if (observer.targets.has(target)) observer.callback([], observer as unknown as ResizeObserver)
  })
}

beforeEach(() => {
  observers.clear(); sizes.clear(); offsetReads = 0; cardObserverRegistrations = 0
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  useAppStore.setState({ agentSteerQueues: { 'agent-1': entries() }, agentSteerInFlight: {}, agentSteerInFlightPhase: {}, timelines: {}, noticeReadReceipts: {} })
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this) }
    observe(target: Element) { this.targets.add(target); if (target.classList.contains('composer-pending__card')) cardObserverRegistrations++ }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear(); observers.delete(this) }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
  for (const property of ['offsetLeft', 'offsetTop', 'offsetWidth', 'offsetHeight'] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('composer-pending__card')) return 0
      offsetReads++
      return property === 'offsetHeight' ? sizes.get(this.dataset.operationId!) ?? 28 : property === 'offsetWidth' ? 300 : property === 'offsetTop' ? cards().indexOf(this) * 28 : 0
    })
  }
})
afterEach(() => vi.unstubAllGlobals())

it('actual Composer queue projections do not remeasure or reconnect unchanged original cards on activity and content updates', async () => {
  await render()
  const originalCards = cards(), originalEditor = editor()
  expect(offsetReads).toBeGreaterThan(0)
  expect(cardObserverRegistrations).toBe(3)
  offsetReads = 0; cardObserverRegistrations = 0
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), latestOutputBytes: 400, updatedAt: _historyFixtureEpoch(0, 0, 2) }] }))
  await act(async () => useAppStore.setState({ agentSteerQueues: { 'agent-1': entries().map(entry => entry.operationId === 'middle' ? { ...entry, text: 'Changed original body' } : entry) } }))
  expect(card('middle').textContent).toContain('Changed original body')
  expect(offsetReads, 'Unchanged operations must not synchronously read every card offset').toBe(0)
  expect(cardObserverRegistrations, 'Unchanged operations must retain the native size observers').toBe(0)
  expect(cards()).toEqual(originalCards)
  expect(editor()).toBe(originalEditor); expect(dom.draft()).toBe('Keep my draft')
})

it('native size notifications and real membership/order changes still update the original card geometry', async () => {
  await render()
  const middle = card('middle'), originalEditor = editor()
  offsetReads = 0; cardObserverRegistrations = 0
  await act(async () => useAppStore.setState({ agentSteerQueues: { 'agent-1': entries().map(entry => entry.operationId === 'middle' ? { ...entry, status: 'failed', error: 'Original delivery failed' } : entry) } }))
  expect(card('middle').dataset.explained).toBe('true')
  expect(offsetReads).toBe(0)
  sizes.set('middle', 70); await resize(middle)
  expect(offsetReads).toBeGreaterThan(0); expect(middle.style.getPropertyValue('--queue-card-height')).toBe('70px')
  expect(cardObserverRegistrations).toBe(0)
  offsetReads = 0
  await act(async () => useAppStore.setState({ agentSteerQueues: { 'agent-1': [entries()[2]!, entries()[1]!, entries()[0]!, { ...entries()[0]!, operationId: 'new' }] } }))
  expect(cards().map(node => node.dataset.operationId)).toEqual(['last', 'middle', 'first', 'new'])
  expect(offsetReads).toBeGreaterThan(0); expect(cardObserverRegistrations).toBe(4)
  expect(card('middle')).toBe(middle); expect(editor()).toBe(originalEditor); expect(dom.draft()).toBe('Keep my draft')
})

it('selection and original card editing keep immediate layout and native resize observation', async () => {
  await render()
  const last = card('last'), originalEditor = editor()
  offsetReads = 0
  await act(async () => last.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })))
  expect(last.dataset.selected).toBe('true'); expect(offsetReads).toBeGreaterThan(0)
  offsetReads = 0
  await act(async () => last.querySelector<HTMLButtonElement>('.composer-pending__preview')!.click())
  expect(last.dataset.editing).toBe('true'); expect(last.querySelector('textarea')).not.toBeNull(); expect(offsetReads).toBeGreaterThan(0)
  sizes.set('last', 130); await resize(last)
  expect(last.style.getPropertyValue('--queue-card-height')).toBe('130px')
  expect(card('last')).toBe(last); expect(editor()).toBe(originalEditor); expect(dom.draft()).toBe('Keep my draft')
})
