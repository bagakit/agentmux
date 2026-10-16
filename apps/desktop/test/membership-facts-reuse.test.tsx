// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { conversationRevision, projectConversationRecords } from '@agentmux/core/conversation'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { RuntimeSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

vi.mock('@agentmux/core/conversation', async original => {
  const actual = await original<typeof import('@agentmux/core/conversation')>()
  return { ...actual, projectConversationRecords: vi.fn(actual.projectConversationRecords) }
})
vi.mock('../src/shared/config-edit', async original => {
  const actual = await original<typeof import('../src/shared/config-edit')>()
  return { ...actual, configValuesEqual: vi.fn(actual.configValuesEqual) }
})
// Only unrelated painting and hierarchy I/O are excluded. Store, Focus, and Core projection are real.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { configValuesEqual } from '../src/shared/config-edit'

const decode = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const project = vi.mocked(projectConversationRecords), compare = vi.mocked(configValuesEqual)

it('real membership resync preserves equal facts for mounted Focus and admits same-version changes', async () => {
  const initial = useAppStore.getState(), agent = composerSession('membership-original')
  agent.status = { state: 'done', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 1) }
  const items: AgentTimelineSnapshot['items'] = Array.from({ length: 24 }, (_, index) => ({
    id: `reply-${index}`, agentSessionId: agent.id, kind: 'assistant_message', status: 'complete', source: 'native-hook',
    title: 'Reply', content: `Original record ${index}. ` + 'Retained original body. '.repeat(32), createdAt: index + 1, updatedAt: index + 1
  }))
  const timeline: AgentTimelineSnapshot = { agentSessionId: agent.id, sourceHostId: agent.hostId, revision: 24, items,
    stream: { epoch: 'original-captured-epoch', sequence: 24, revision: 24, origin: 'beginning', gaps: [],
      positions: items.map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: conversationRevision(item) })) } }
  let payload: RuntimeSnapshot = { sessions: [agent], timelines: { [agent.id]: timeline }, recoveryCandidates: [] }
  const decoded: RuntimeSnapshot[] = [], facts: object[] = []
  const reads = vi.spyOn(api.sessions, 'snapshot').mockImplementation(async () => {
    const value = decode(payload); decoded.push(value); return value
  })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ config: composerConfig, sessions: [], timelines: {}, tabs: {}, layouts: {}, recoveryCandidates: [],
    pendingAgentLaunches: {}, agentSteerQueues: {}, scratchTopicSnapshots: {}, runtimeEndpointWarnings: [],
    mainSurface: 'agents', agentComposerDrafts: { [agent.id]: 'Original unsent draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  async function resync() {
    const expected = reads.mock.calls.length + 1
    await act(async () => {
      useAppStore.getState().applyEvent({ type: 'core', hostId: agent.hostId, event: { type: 'connection-state', state: 'restored',
        observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'run-process', observedAt: expected } } })
      await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(expected))
    })
    return useAppStore.getState()
  }
  const row = () => container.querySelector<HTMLElement>(`.focus-context[data-session-id="${agent.id}"]`)!
  try {
    await act(async () => root.render(<GlobalFocusSurface />))
    await resync()
    const before = useAppStore.getState(), original = before.timelines[agent.id]!
    expect(original.items).toHaveLength(24); expect(row().getAttribute('aria-label')).toContain('Original record 23.')
    expect(project.mock.calls.some(([input]) => input.agentSessionId === agent.id)).toBe(true)
    project.mockClear(); compare.mockClear()
    const after = await resync()
    facts.push({ phase: 'equal-full-snapshot', inputBytes: JSON.stringify(decoded.at(-1)).length,
      inputItems: items.length, comparisonCalls: compare.mock.calls.length, projectionCalls: project.mock.calls.length,
      serializedComparisonArgumentsBytes: compare.mock.calls.reduce((bytes, args) => bytes + Buffer.byteLength(JSON.stringify(args)), 0),
      sameSessions: after.sessions === before.sessions, sameTimelineMap: after.timelines === before.timelines,
      sameTimeline: after.timelines[agent.id] === original, sameItems: after.timelines[agent.id]!.items === original.items,
      sameStream: after.timelines[agent.id]!.stream === original.stream })
    expect(decoded[1]).not.toBe(decoded[0]); expect(decoded[1]!.timelines[agent.id]!.items).not.toBe(decoded[0]!.timelines[agent.id]!.items)
    expect(project, 'an equal independently decoded membership snapshot must not reproject history').not.toHaveBeenCalled()
    expect(after.sessions).toBe(before.sessions); expect(after.timelines).toBe(before.timelines)
    expect(after.timelines[agent.id]).toBe(original); expect(after.timelines[agent.id]!.items).toBe(original.items)
    expect(after.timelines[agent.id]!.stream).toBe(original.stream)

    for (const change of ['body', 'gaps', 'epoch', 'source', 'order'] as const) {
      payload = decode(payload)
      const next = payload.timelines[agent.id]!
      if (change === 'body') { next.items.at(-1)!.content = 'Changed body at the same revision'; next.stream!.positions.at(-1)!.revision = conversationRevision(next.items.at(-1)) }
      if (change === 'gaps') next.stream!.gaps.push({ code: 'ORIGINAL_OBSERVATION_UNAVAILABLE', message: 'Accepted facts remain readable.' })
      if (change === 'epoch') next.stream!.epoch = 'different-original-epoch'
      if (change === 'source') next.sourceHostId = 'different-original-source'
      if (change === 'order') { next.items.reverse(); next.stream!.positions.reverse() }
      project.mockClear(); const old = useAppStore.getState().timelines[agent.id]!, state = await resync()
      expect(state.timelines[agent.id]).toEqual(next); expect(state.timelines[agent.id]).not.toBe(old)
      expect(project.mock.calls.some(([input]) => input.agentSessionId === agent.id)).toBe(true)
      if (change === 'body') expect(row().getAttribute('aria-label')).toContain('Changed body at the same revision')
      facts.push({ phase: change, projectionCalls: project.mock.calls.length, revision: next.revision })
    }
    const retained = useAppStore.getState().timelines[agent.id]!
    payload = decode(payload); payload.timelines[agent.id]!.revision--
    payload.timelines[agent.id]!.items = [{ ...items[0]!, content: 'Older observation must not replace history' }]
    project.mockClear(); await resync()
    expect(useAppStore.getState().timelines[agent.id]).toBe(retained); expect(project).not.toHaveBeenCalled()

    payload = decode({ ...payload, timelines: { [agent.id]: retained } })
    await act(async () => useAppStore.setState({ timelines: { [agent.id]: { ...retained,
      liveTool: { itemId: 'tool', hostId: agent.hostId, runId: agent.control.run.runId, epoch: 1, observedAt: _tailFixtureEpoch(0, 0, 1), startedAt: _tailFixtureEpoch(0, 0, 1) } } } }))
    project.mockClear(); const cleared = (await resync()).timelines[agent.id]!
    expect(cleared).not.toHaveProperty('liveTool'); expect(cleared.items).toBe(retained.items); expect(cleared.stream).toBe(retained.stream)
    expect(project).not.toHaveBeenCalled()

    payload = decode(payload); const originalAgent = payload.sessions[0]!
    expect(originalAgent.kind).toBe('agent')
    if (originalAgent.kind !== 'agent') throw Error('The controlled source must remain an Agent')
    originalAgent.capabilities = { ...originalAgent.capabilities, permission: 'respond' }
    await resync()
    expect(useAppStore.getState().sessions[0]).toHaveProperty('capabilities.permission', 'respond')

    payload = decode(payload); payload.sessions[0] = { ...agent, control: { ...agent.control, run: { runId: 'later-original-run' } },
      status: { state: 'error', source: 'native-hook', observedAt: _tailFixtureEpoch(0, 0, 2), detail: 'Current source observation failed' } }
    await resync(); expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe('later-original-run')
    expect(row().textContent).toContain('Current source observation failed')
    payload = decode(payload); delete payload.timelines[agent.id]
    await resync()
    expect(useAppStore.getState().sessions[0]).toHaveProperty('timelineObservation')
    expect(useAppStore.getState().timelines[agent.id]).toBe(cleared)
    expect(useAppStore.getState().agentComposerDrafts[agent.id]).toBe('Original unsent draft')
  } finally {
    try {
      if (process.env.AGENTMUX_MEMBERSHIP_FACTS) writeFileSync(process.env.AGENTMUX_MEMBERSHIP_FACTS, JSON.stringify({ facts, snapshotReads: reads.mock.calls.length }, null, 2))
    } finally {
      await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
      vi.restoreAllMocks(); project.mockClear(); vi.unstubAllGlobals()
    }
  }
})
