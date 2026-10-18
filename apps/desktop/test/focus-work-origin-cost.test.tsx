// @vitest-environment happy-dom
import { act, createElement, useMemo } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import * as WorkHistory from '@agentmux/core/timeline'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { deriveFocusProjectLanes } from '../src/renderer/src/lib/focus-project-lanes'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(),
  NOW = fixtureEpoch(10),
  ID = 'private-cost-owner'
const owner = composerSession(ID),
  foreign = composerSession('private-cost-foreign')
const startReads = vi.fn()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue({ sources: [], warnings: [] })
  startReads.mockClear()
})
afterEach(() => vi.useRealTimers())
function item(id: string, at: number, value: 'working' | 'done', previous?: string): AgentTimelineItem {
  const record: AgentTimelineItem = {
    id,
    agentSessionId: ID,
    kind: 'lifecycle',
    status: 'complete',
    source: 'acp',
    title: 'Typed source work',
    createdAt: at,
    updatedAt: at,
    activityState: {
      run: owner.control.run,
      state: value,
      stateEnteredAt: at,
      ...(previous ? { previousObservationId: previous } : {})
    }
  }
  // Observe original fact reads; do not replace the production projector or origin lookup.
  Object.defineProperty(record, 'createdAt', {
    enumerable: true,
    configurable: true,
    get() {
      startReads(id)
      return at
    }
  })
  return record
}

it.each([4, 36])(
  'reuses original start provenance across Now and foreign updates with %i work segments',
  async (rounds) => {
    const items: AgentTimelineItem[] = []
    let previous: string | undefined
    for (let i = 0; i < rounds; i++) {
      const at = NOW - (rounds - i) * 120_000,
        start = `work-${i}`
      items.push(item(start, at, 'working', previous))
      if (i < rounds - 1) {
        previous = `done-${i}`
        items.push(item(previous, at + 60_000, 'done', start))
      }
    }
    const own: AgentTimelineSnapshot = { agentSessionId: ID, revision: 1, items }
    const session = {
      ...owner,
      status: { state: 'working' as const, source: 'acp' as const, observedAt: NOW - 120_000 },
      semanticStatus: {
        state: 'working' as const,
        source: 'acp' as const,
        observedAt: NOW - 120_000,
        stateEnteredAt: NOW - 120_000
      }
    }
    useAppStore.setState({
      sessions: [session, foreign],
      timelines: { [ID]: own },
      agentNames: {},
      agentComposerDrafts: { [ID]: 'Keep original draft' },
      agentFocus: { execution: { sessionId: ID, history: [] }, pmo: { sessionId: null } }
    })
    const selector = createFocusProjectionSelector()
    function Surface() {
      const contexts = useAppStore((s) => selector(s).contexts),
        config = useAppStore((s) => s.config)
      const lanes = useMemo(() => deriveFocusProjectLanes(contexts, config), [contexts, config])
      return createElement(RecentFocusTimeline, {
        contexts,
        lanes,
        entries: [],
        currentSessionId: ID,
        onSelect: () => {}
      })
    }
    await dom.render(createElement(Surface))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    const bands = () => [
      ...dom.container.querySelectorAll<HTMLElement>(`[data-focus-timeline-id="${ID}"] [data-work-end]`)
    ]
    expect(bands()).toHaveLength(rounds)
    expect(startReads).toHaveBeenCalled()
    await act(async () => bands()[0]!.click())
    const dialog = document.querySelector<HTMLElement>('[role=dialog]')!
    expect(dialog).not.toBeNull()
    const range = document.createRange()
    range.selectNodeContents(dialog.querySelector('p')!)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const selected = selection.toString()
    expect(selected.length).toBeGreaterThan(0)
    const projector = vi.spyOn(WorkHistory, 'projectAgentWorkHistory')
    startReads.mockClear()
    const through = Number(bands().find((n) => n.dataset.workEnd === 'current')!.dataset.workingThrough)
    for (let index = 0; index < 3; index++) {
      startReads.mockClear()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      // The pinned event dialog may read its one original timestamp. It may not
      // rescan the track's other starts when only the playhead moves.
      expect(startReads.mock.calls.length).toBeLessThanOrEqual(1)
      expect(startReads.mock.calls.every(([id]) => id === 'work-0')).toBe(true)
    }
    expect(projector).not.toHaveBeenCalled()
    expect(Number(bands().find((n) => n.dataset.workEnd === 'current')!.dataset.workingThrough)).toBeGreaterThan(
      through
    )
    startReads.mockClear()
    await act(async () =>
      useAppStore
        .getState()
        .applyEvent({
          type: 'core',
          hostId: foreign.hostId,
          event: {
            type: 'agent-status',
            agentSessionId: foreign.id,
            state: 'working',
            evidence: { source: 'native-hook', observedAt: Date.now() }
          }
        })
    )
    expect(useAppStore.getState().sessions.find((x) => x.id === foreign.id)!.status.observedAt).toBe(Date.now())
    expect(startReads.mock.calls.length).toBeLessThanOrEqual(1)
    expect(startReads.mock.calls.every(([id]) => id === 'work-0')).toBe(true)
    expect(
      projector.mock.calls.filter(([, options]) => options?.current?.run.runId === owner.control.run.runId)
    ).toHaveLength(0)
    expect(document.querySelector('[role=dialog]')).toBe(dialog)
    expect(selection.toString()).toBe(selected)
    expect(selection.getRangeAt(0)).toBe(range)
    expect(dom.draft(ID)).toBe('Keep original draft')
    // Advancing the original revision must still rebuild provenance and move the band.
    const nextStart = NOW - 30_000
    const next = item('new-original-work', nextStart, 'working', `done-${rounds - 2}`)
    own.items.push(next)
    own.revision++
    startReads.mockClear()
    await act(async () => useAppStore.setState((state) => ({ timelines: { ...state.timelines } })))
    expect(startReads).toHaveBeenCalled()
    expect(bands().some((band) => Number(band.dataset.workingEnteredAt) === nextStart)).toBe(true)
    expect(dom.draft(ID)).toBe('Keep original draft')
  }
)
