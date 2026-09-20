// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import type { SessionSnapshot, AgentTimelineItem } from '../src/shared/contracts.js'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline.js'
import { useAppStore } from '../src/renderer/src/store'
import { focusExecution, restoreAgentFocus, EMPTY_AGENT_FOCUS, executionFocusHistory } from '../src/renderer/src/lib/agent-focus'
import { HOUR_MS, localDateTime } from '../src/renderer/src/lib/focus-time-window'

const NOW = new Date('2026-10-02T12:00:00Z').getTime()
const baseline = useAppStore.getState()
function terminal(id: string): SessionSnapshot {
  return { id, kind: 'terminal', providerId: null, executorId: null, hostId: 'local', workspacePath: '/repo', label: id,
    createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'working', source: 'run-process', observedAt: 1 },
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } } as SessionSnapshot
}
function message(id: string, session = 'one', createdAt = NOW - HOUR_MS, kind: AgentTimelineItem['kind'] = 'user_message'): AgentTimelineItem {
  return { id, agentSessionId: session, kind, source: 'user', status: 'complete', createdAt, updatedAt: NOW, title: 'User prompt', content: `Original message ${id}` }
}

describe('Recent Focus timeline', () => {
  let root: Root, container: HTMLDivElement
  const contexts = () => createFocusProjectionSelector()({ sessions: [terminal('one'), terminal('two')], config: null, timelines: {}, agentNames: {} }).contexts
  const render = (onSelect = vi.fn(), entries = [{ sessionId: 'one', focusedAt: NOW - 2 * HOUR_MS }, { sessionId: 'two', focusedAt: NOW - HOUR_MS / 2 }]) => act(async () => root.render(createElement(RecentFocusTimeline, { entries, currentSessionId: 'two', contexts: contexts(), onSelect })))
  const click = (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click())
  const range = () => [Number(container.querySelector<HTMLElement>('.recent-focus')!.dataset.windowStart), Number(container.querySelector<HTMLElement>('.recent-focus')!.dataset.windowEnd)]
  const changeDate = (timestamp: number) => act(async () => { const input = container.querySelector<HTMLInputElement>('[aria-label="Focus history date and time"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, localDateTime(timestamp)); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); useAppStore.setState({ timelines: {} }) })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(baseline, true); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('renders source-derived tracks on the default past3h/future1h window, with true Now at 75%', async () => {
    const onSelect = vi.fn(); await render(onSelect)
    expect(range()).toEqual([NOW - 3 * HOUR_MS, NOW + HOUR_MS])
    expect(container.querySelectorAll('[data-focus-timeline-id]').length).toBe(2)
    expect(container.querySelector('[data-focus-timeline-id="two"] .recent-focus__segment')?.getAttribute('aria-current')).toBe('true')
    expect([...container.querySelectorAll<HTMLElement>('.recent-focus__playhead')].map(line => line.style.left)).toEqual(['75%', '75%', '75%'])
    expect(container.querySelector<HTMLButtonElement>('[data-focus-timeline-id="one"] .recent-focus__segment')!.style.width).toBe('37.5%')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-focus-timeline-id="one"] .recent-focus__segment')!.click()); expect(onSelect).toHaveBeenCalledWith('one')
  })

  it('queries arbitrary history, moves/resizes windows, holds the query through clock ticks and returns to Now', async () => {
    const onSelect = vi.fn(), old = NOW - 7 * 24 * HOUR_MS; await render(onSelect, [{ sessionId: 'one', focusedAt: old - HOUR_MS }, { sessionId: 'two', focusedAt: old }])
    expect(container.querySelectorAll('.recent-focus__track')).toHaveLength(2)
    expect(container.querySelectorAll('.recent-focus__segment')).toHaveLength(0)
    expect(container.querySelectorAll('[data-run-state="running"]')).toHaveLength(2)
    await changeDate(old); expect(range()).toEqual([old - 3 * HOUR_MS, old + HOUR_MS]); expect(container.querySelectorAll('.recent-focus__track')).toHaveLength(2)
    expect(container.querySelector('.recent-focus__playhead')).toBeNull()
    await click('Previous focus window'); expect(range()).toEqual([old - 7 * HOUR_MS, old - 3 * HOUR_MS])
    await click('Next focus window'); expect(range()).toEqual([old - 3 * HOUR_MS, old + HOUR_MS])
    await act(async () => { const select = container.querySelector<HTMLSelectElement>('[aria-label="Focus window size"]')!; select.value = '24'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(range()).toEqual([old - 18 * HOUR_MS, old + 6 * HOUR_MS])
    await act(async () => vi.advanceTimersByTime(60_000)); expect(range()).toEqual([old - 18 * HOUR_MS, old + 6 * HOUR_MS]); expect(onSelect).not.toHaveBeenCalled()
    await click('Return to current focus window'); expect(range()).toEqual([NOW + 60_000 - 18 * HOUR_MS, NOW + 60_000 + 6 * HOUR_MS])
    expect(container.querySelector('[aria-label="Focus window size"]')!.textContent).toBe('1h4h12h24h')
  })

  it('places canonical user messages on their Context at createdAt, previews without focus change and returns to existing work', async () => {
    useAppStore.setState({ timelines: { one: { agentSessionId: 'one', revision: 1, items: [message('first'), message('reply', 'one', NOW - HOUR_MS, 'assistant_message'), message('old', 'one', NOW - 4 * HOUR_MS), message('future', 'one', NOW + HOUR_MS / 2)] }, two: { agentSessionId: 'two', revision: 1, items: [message('second', 'two', NOW - HOUR_MS / 2)] } } })
    const onSelect = vi.fn(); await render(onSelect, [])
    const markers = [...container.querySelectorAll<HTMLButtonElement>('.recent-focus__message')]
    expect(markers.map(marker => [marker.dataset.messageId, marker.closest<HTMLElement>('.recent-focus__track')!.dataset.focusTimelineId, marker.style.left])).toEqual([['first', 'one', '50%'], ['second', 'two', '62.5%']])
    await act(async () => markers[0]!.click())
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('Original message first'); expect(onSelect).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('[role="dialog"] > button')!.click()); expect(onSelect).toHaveBeenCalledWith('one'); expect(container.querySelector('[role="dialog"]')).toBeNull()
    const before = markers[1]
    await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: 1, items: [message('unrelated', 'unrelated')] } } })))
    expect(container.querySelector('[data-message-id="second"]')).toBe(before)
    expect(container.querySelector('.recent-focus__range')!.getAttribute('title')).toContain('retained')
  })

  it('keeps revisits in the single durable event sequence through save/restore while MRU is unique', async () => {
    let focus = focusExecution(EMPTY_AGENT_FOCUS, 'one', NOW - 2 * HOUR_MS)
    focus = focusExecution(focus, 'two', NOW - HOUR_MS); focus = focusExecution(focus, 'one', NOW)
    useAppStore.setState({ agentFocus: focus }); const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
    const restored = restoreAgentFocus(saved.agentFocus)
    expect(restored).toEqual(focus); expect(executionFocusHistory(restored)).toEqual([{ sessionId: 'one', focusedAt: NOW }, { sessionId: 'two', focusedAt: NOW - HOUR_MS }])
    await render(vi.fn(), restored.execution.history)
    expect([...container.querySelectorAll<HTMLElement>('[data-focus-timeline-id="one"] .recent-focus__segment')].map(node => node.dataset.focusedAt)).toEqual([String(NOW - 2 * HOUR_MS), String(NOW)])
  })
})
