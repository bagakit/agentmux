// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { projectConversationReading } from '@agentmux/client-ui/conversation-records'
import { ConversationCoverage } from '@agentmux/client-ui/components/ConversationCoverage'
import type { AgentMuxClientEvent } from '@agentmux/core'
import type { AgentTimelineItem, AgentTimelineSnapshot, SessionSnapshot } from '../src/shared/contracts'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { AgentMuxClientEventPublisher } from '../../../packages/core/src/client-event-publisher'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { reduceTimelineSnapshot, reduceRuntimeEvent } from '../src/renderer/src/lib/session-state'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
  kind: 'agent', id: 'original-session', providerId: 'codex', executorId: 'codex', hostId: 'selected-route',
  workspacePath: fixturePath('original-workspace'), label: 'Original Agent', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2), agentSessionUpdatedAt: _historyFixtureEpoch(0, 0, 2),
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  processState: 'running', status: { state: 'running', source: 'run-process', observedAt: _historyFixtureEpoch(0, 0, 2) }, latestOutputBytes: 0,
  control: { kind: 'agent', hostId: 'selected-route', agentSessionId: 'original-session', run: { runId: 'original-run' } }
}
const timelineItem: AgentTimelineItem = { id: 'original-record', agentSessionId: session.id, kind: 'lifecycle', status: 'complete',
  source: 'user', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2), title: 'Original record' }


const originalAppState = useAppStore.getState()
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(originalAppState, true) })

describe('Captured source metadata through the Renderer snapshot owner', () => {
  function capturedReading(sourceHostId: string | null = 'source-owner') {
    const source = { providerId: 'codex', nativeSessionId: 'original-native' }
    const target = { hostId: 'source-owner', agentSessionId: session.id,
      source: { kind: 'native' as const, ...source, recordId: 'unread-original' } }
    const observed: AgentTimelineItem = { ...timelineItem, id: 'original-observation', kind: 'tool_call', source: 'native-hook',
      content: 'Original observation remains readable', conversation: { observes: target } }
    const peer: AgentTimelineItem = { ...timelineItem, id: 'original-peer' }
    const snapshot: AgentTimelineSnapshot = { agentSessionId: session.id, revision: 1, items: [observed, peer],
      ...(sourceHostId === null ? {} : { sourceHostId }), stream: { epoch: 'original-captured-epoch', sequence: 2, revision: 1,
        origin: 'beginning', gaps: [{ code: 'ORIGINAL_SOURCE_GAP', message: 'The original source reports an unread range.' }],
        positions: [observed, peer].map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: 'a'.repeat(64) })) } }
    const state = { sessions: [session], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
    const read = (timeline: AgentTimelineSnapshot) => projectConversationReading({ agentSessionId: session.id,
      executionHostId: 'selected-route', historyPage: { agentSessionId: session.id, sourceHostId: 'source-owner', source,
        items: [], nextCursor: null }, timeline })
    return { state, snapshot, observed, peer, target, read }
  }

  it('keeps an exact source-qualified unread gap visible after accepting the original Core snapshot', () => {
    const fixture = capturedReading()
    const accepted = reduceTimelineSnapshot(fixture.state, fixture.snapshot).timelines[session.id]!
    const reading = fixture.read(accepted)
    const html = renderToStaticMarkup(createElement(ConversationCoverage, { coverage: reading.timeline.coverage }))
    expect(html).toContain('data-conversation-gap="CONVERSATION_OBSERVED_TARGET_UNREAD"')
    expect(html).toContain('unread-original')
    expect(html).toContain('ORIGINAL_SOURCE_GAP')
    expect(reading.timeline.coverage.flatMap(row => row.gaps)).toContainEqual(expect.objectContaining({ record: fixture.target }))
    expect(reading.records.find(record => record.rawId === fixture.observed.id)?.event?.reference?.hostId).toBe('source-owner')
    expect(accepted.stream).toBe(fixture.snapshot.stream)
    expect(accepted.items).toBe(fixture.snapshot.items)
  })

  it('does not turn a selected route into missing source authority', () => {
    const fixture = capturedReading(null)
    const accepted = reduceTimelineSnapshot(fixture.state, fixture.snapshot).timelines[session.id]!
    const reading = fixture.read(accepted)
    expect(reading.records).toHaveLength(2)
    expect(reading.records.every(record => record.event?.reference === null)).toBe(true)
    expect(accepted).not.toHaveProperty('sourceHostId')
    expect(accepted.items).toEqual(fixture.snapshot.items)
  })

  async function liveReading() {
    const fixture = capturedReading(), store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: session.id, hostId: 'source-owner', providerId: 'codex',
      executorId: 'codex', workspacePath: session.workspacePath, run: session.control.run, retiredRuns: [],
      hookBindingId: 'original-binding', hookToken: 'original-token', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2) })
    for (const item of fixture.snapshot.items) await store.applyTimelineMutation({ type: 'append', agentSessionId: session.id, item })
    const baseline = { ...await store.loadTimeline(session.id), sourceHostId: 'source-owner' }
    const state = reduceTimelineSnapshot(fixture.state, baseline)
    const commit = await store.applyTimelineMutation({ type: 'update', agentSessionId: session.id, itemId: fixture.observed.id,
      updatedAt: _historyFixtureEpoch(0, 0, 3), content: 'Exact live original body' })
    const publisher = new AgentMuxClientEventPublisher(), events: Extract<AgentMuxClientEvent, { type: 'agent-timeline' }>[] = []
    publisher.onEvent(event => { if (event.type === 'agent-timeline') events.push(event) })
    publisher.publishTimeline(commit, { source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 3), run: session.control.run }, 'source-owner')
    publisher.dispose()
    expect(events).toHaveLength(1)
    return { ...fixture, store, baseline, state, event: events[0]! }
  }

  it('renders the original exact gap and new body version from the real Store event through the selected route', async () => {
    const fixture = await liveReading()
    const next = reduceRuntimeEvent(fixture.state, { type: 'core', hostId: session.hostId, event: fixture.event })
    const snapshot = next.timelines[session.id]!, reading = fixture.read(snapshot)
    const html = renderToStaticMarkup(createElement(ConversationCoverage, { coverage: reading.timeline.coverage }))
    expect(html).toContain('data-conversation-gap="CONVERSATION_OBSERVED_TARGET_UNREAD"')
    expect(snapshot).toEqual({ ...await fixture.store.loadTimeline(session.id), sourceHostId: 'source-owner' })
    expect(reading.timeline.records.find(record => record.original.item.id === fixture.observed.id)?.revision).toBe(fixture.event.position.revision)
    expect(snapshot.items[0]?.content).toBe('Exact live original body')
    expect(next.sessions[0]?.control).toEqual(session.control)
  })

  it('repairs inconsistent live metadata only through the original scoped Store read and preserves healthy input', async () => {
    const fixture = await liveReading()
    useAppStore.setState({ sessions: [session], timelines: fixture.state.timelines, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} })
    const read = vi.spyOn(api.sessions, 'timeline').mockImplementation(async control => {
      expect(control).toEqual(session.control)
      return { ...await fixture.store.loadTimeline(session.id), sourceHostId: 'source-owner' }
    })
    const send = vi.spyOn(api.sessions, 'submitPrompt')
    useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId,
      event: { ...fixture.event, stream: { ...fixture.event.stream, epoch: 'unconfirmed-foreign-epoch' } } })
    expect(useAppStore.getState().timelines[session.id]).toBe(fixture.state.timelines[session.id])
    await vi.waitFor(() => expect(read).toHaveBeenCalledExactlyOnceWith(session.control))
    await vi.waitFor(() => expect(useAppStore.getState().timelines[session.id]?.stream?.epoch).toBe(fixture.baseline.stream?.epoch))
    const current = useAppStore.getState()
    expect(current.timelines[session.id]?.items[0]?.content).toBe('Exact live original body')
    expect(current.sessions[0]?.control).toEqual(session.control)
    expect(current.sessions[0]?.processState).toBe('running')
    expect(send).not.toHaveBeenCalled()
  })

})
