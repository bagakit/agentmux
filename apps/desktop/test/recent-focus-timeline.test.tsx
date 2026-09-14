// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline.js'

function terminal(id: string): SessionSnapshot {
  return {
    id, kind: 'terminal', providerId: null, executorId: null, hostId: 'local', workspacePath: '/repo', label: id,
    createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'working', source: 'run-process', observedAt: 1 },
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } }
  } as SessionSnapshot
}

describe('Recent Focus timeline', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

  it('renders source-derived focus tracks with readable times and selection', async () => {
    const onSelect = vi.fn()
    await act(async () => root.render(createElement(RecentFocusTimeline, {
      entries: [{ sessionId: 'one', focusedAt: 1_000 }, { sessionId: 'two', focusedAt: 61_000 }],
      currentSessionId: 'two', sessions: [terminal('one'), terminal('two')], config: null, names: {}, onSelect
    })))
    expect(container.querySelector('.recent-focus__title')?.textContent).toContain('Recent Focus')
    expect(container.querySelectorAll('[data-focus-timeline-id]').length).toBe(2)
    expect(container.querySelector('[data-focus-timeline-id="two"] .recent-focus__segment')?.getAttribute('aria-current')).toBe('true')
    await act(async () => (container.querySelector('[data-focus-timeline-id="one"] button') as HTMLButtonElement).click())
    expect(onSelect).toHaveBeenCalledWith('one')
  })
})
