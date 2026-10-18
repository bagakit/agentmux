// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import * as WorkHistory from '@agentmux/core/timeline'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { createFocusWorkSelector } from '../src/renderer/src/lib/focus-work-history'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), HOUR = 3_600_000, NOW = Date.now(), ID = 'focus-work-owner'
const owner = composerSession(ID), foreign = composerSession('focus-work-foreign')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(NOW)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  useAppStore.setState({ sessions: [owner, foreign], timelines: {}, agentNames: {},
    agentComposerDrafts: { [ID]: 'Keep this draft' }, agentFocus: { execution: { sessionId: ID, history: [] }, pmo: { sessionId: null } } })
})
afterEach(() => vi.useRealTimers())
function observed(id: string, at: number, state: 'working' | 'done', previous?: string): AgentTimelineItem {
  return { id, agentSessionId: ID, kind: 'lifecycle', status: 'complete', source: 'acp', title: 'Controlled typed observation', createdAt: at, updatedAt: at,
    activityState: { run: owner.control.run, state, stateEnteredAt: at, ...(previous ? { previousObservationId: previous } : {}) } }
}
async function mounted(toolCount = 0) {
  const own: AgentTimelineSnapshot = { agentSessionId: ID, revision: 1, items: [
    observed('work-one', NOW - 2 * HOUR, 'working'), observed('done-one', NOW - HOUR, 'done', 'work-one'),
    ...Array.from({ length: toolCount }, (_, index) => ({ id: `tool-${index}`, agentSessionId: ID, kind: 'tool_call' as const,
      source: 'acp' as const, status: 'complete' as const, createdAt: NOW, updatedAt: NOW, title: 'Historical tool detail' }))] }
  useAppStore.setState({ timelines: { [ID]: own } })
  const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
  await dom.render(<RecentFocusTimeline contexts={contexts} entries={[]} currentSessionId={ID} onSelect={vi.fn()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(dom.container.querySelectorAll('[data-work-end]')).toHaveLength(1)
  return own
}

it.each([1, 2048])('does not rescan %i historical records on unrelated accepted Session events', async count => {
  const own = await mounted(count)
  await dom.click('[data-work-end]')
  const detail = document.querySelector<HTMLElement>('[role=dialog]')!
  expect(detail.textContent).toContain(ID)
  expect(detail.textContent).toContain(owner.control.run.runId)
  const range = document.createRange(); range.selectNodeContents(detail.querySelector('p')!)
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString()
  expect(selected.length).toBeGreaterThan(0)
  const filter = vi.spyOn(own.items, 'filter'), reads = vi.spyOn(api.sessions, 'timeline')
  const sourceReads = vi.mocked(api.sessions.historySources).mock.calls.length
  for (let index = 0; index < 40; index++) {
    await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: foreign.hostId, event: {
      type: 'agent-status', agentSessionId: foreign.id, state: index % 2 ? 'working' : 'done', evidence: { source: 'native-hook', observedAt: NOW + index + 1 }
    } }))
    expect(useAppStore.getState().sessions.find(value => value.id === foreign.id)!.status.observedAt).toBe(NOW + index + 1)
  }
  expect(useAppStore.getState().timelines[ID]).toBe(own)
  expect(document.querySelector('[role=dialog]')).toBe(detail)
  expect(selection.toString()).toBe(selected)
  expect(selection.getRangeAt(0)).toBe(range)
  expect(dom.draft(ID)).toBe('Keep this draft')
  expect(vi.mocked(api.sessions.historySources).mock.calls.length).toBe(sourceReads)
  expect(reads).not.toHaveBeenCalled()
  expect(filter).not.toHaveBeenCalled()
})

it('consumes same-array revision advances and same-revision array replacements', async () => {
  const own = await mounted()
  // The preview producer appends in place before publishing its revision.
  own.items.push(observed('next-work', NOW - HOUR / 4, 'working', 'done-one'))
  own.revision += 1
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines } })))
  expect(dom.container.querySelectorAll('[data-work-end]')).toHaveLength(2)
  const next = { ...own, items: own.items.map(item => item.id === 'next-work'
    ? observed(item.id, NOW - HOUR / 8, 'working', 'done-one') : item) }
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [ID]: next } })))
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-work-end]')].some(node => Number(node.dataset.workingEnteredAt) === NOW - HOUR / 8)).toBe(true)
  expect(dom.container.querySelectorAll('[data-work-end]')).toHaveLength(2)
})

it('keeps typed facts stable through normalized tool clones', async () => {
  const own = await mounted(3), projector = vi.spyOn(WorkHistory, 'projectAgentWorkHistory')
  const normalized = { ...own, items: own.items.map(item => ({ ...item, updatedAt: item.updatedAt + 1, title: 'Normalized display detail' })) }
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [ID]: normalized } })))
  expect(projector).not.toHaveBeenCalled()
  expect(dom.container.querySelectorAll('[data-work-end]')).toHaveLength(1)
})

it('retires a removed source key and consumes its later return', () => {
  const select = createFocusWorkSelector(ID)
  const timeline: AgentTimelineSnapshot = { agentSessionId: ID, revision: 1, items: [observed('original-work', NOW - HOUR, 'working')] }
  const original = select({ timelines: { [ID]: timeline } })
  expect(original).toHaveLength(1)
  expect(select({ timelines: {} })).toEqual([])
  expect(select({ timelines: { [ID]: timeline } })).toEqual(original)
  const next = { ...timeline, items: [observed('later-work', NOW, 'working')] }
  expect(select({ timelines: { [ID]: next } }).map(item => item.id)).toEqual(['later-work'])
})
