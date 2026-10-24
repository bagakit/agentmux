// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
import { AgentCollaborationMap } from '../src/renderer/src/components/AgentCollaborationMap'
import { api } from '../src/renderer/src/lib/api'
import * as contextOwner from '../src/renderer/src/lib/focus-context'
import * as graphOwner from '../src/renderer/src/components/AgentCollaborationGraph'
import { focusMapPreset } from '../src/shared/focus-map-preferences'
import { collaborationSubjectKey } from '../src/renderer/src/lib/agent-collaboration'
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM({ agentInformation: true })
const activeSession = (id: string) => ({ ...composerSession(id), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } })
const subject = { hostId: 'local', agentSessionId: 'scoped-task' }, task = activeSession(subject.agentSessionId), peer = activeSession('recorded-peer')
const unrelated = Array.from({ length: 240 }, (_, index) => activeSession('unrelated-' + index))
beforeEach(() => {
  installCollaborationCanvasGeometry()
  installCollaborationLayoutLoopback()
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue({ sources: [], warnings: [] })
  useAppStore.setState({ config: composerConfig, sessions: [task, ...unrelated, peer], tabs: {}, layouts: {}, timelines: {},
    scratchTopicSnapshots: {}, spaceZoneBindings: {}, spatialRequests: {}, topicCategories: [], projectGroups: [],
    agentNames: { [task.id]: 'Scoped task', [peer.id]: 'Recorded peer' }, agentComposerDrafts: { [task.id]: 'Original unsent task' } })
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async (reference, options = {}): Promise<AgentMuxRpcResult<'message.events'>> => ({
    hostId: reference.hostId, participantSessionId: reference.agentSessionId, afterSequence: options.afterSequence ?? 0, latest: options.latest ?? false,
    beforeSequence: options.beforeSequence ?? null, throughSequence: 1, incarnation: 'scoped-journal', messageId: options.messageId ?? null, broadcastOperationId: null,
    events: [task.id, peer.id].includes(reference.agentSessionId) ? [{ sequence: 1, kind: 'message', at: fixtureEpoch(1), messages: [{ messageId: 'scoped-message', senderSessionId: task.id,
      recipientSessionId: peer.id, threadId: 'scoped-thread', replyTo: null }] }] : [], nextAfterSequence: null, nextBeforeSequence: null
  }))
  vi.spyOn(api.sessions, 'spawns').mockImplementation(async (reference, options) => ({ hostId: reference.hostId, participantSessionId: reference.agentSessionId,
    direction: options.direction, creatorRuntimeId: null, records: [], nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }))
  vi.spyOn(api.sessions, 'readMessage').mockRejectedValue(Error('No original body demand'))
  vi.spyOn(api.sessions, 'dispatch').mockRejectedValue(Error('No supervised request demand'))
})

it('keeps the full map world while bounding production contexts and reads to the visible and selected Agents', async () => {
  const heavy = vi.spyOn(contextOwner, 'agentContextForSession')
  await dom.render(<AgentCollaborationMap request={{ kind: 'focus', subject, name: 'Scoped task' }} onViewInFocus={() => { throw Error("Reading cannot navigate") }} onOpen={() => { throw Error('Observation cannot navigate') }} />)
  const graph = () => document.querySelector<HTMLElement>('.collaboration-map')!
  await settleCollaborationCanvas(() => {
    expect(graph()?.querySelector('[aria-label="Map sources"]')?.getAttribute('title')).toContain('1 connections')
    expect(graph()?.querySelector('.focus-context[data-session-id="scoped-task"]')).not.toBeNull()
    expect(graph()?.querySelector('[aria-label="Reading sources"]')).toBeNull()
  })
  expect(heavy).toHaveBeenCalled()
  const built = new Set(heavy.mock.calls.map(([session]) => session.id))
  expect(built.has(task.id)).toBe(true); expect(built.size).toBeLessThan(64)
  expect(graph().querySelectorAll('.focus-context').length).toBeLessThan(64)
  expect(graph()?.querySelector('[aria-label="Map sources"]')?.getAttribute('title')).toContain('242 Agents')
  expect(api.sessions.messageEvents).toHaveBeenCalledWith(subject, { latest: true, limit: 50 })
  const originalLatestReads = () => vi.mocked(api.sessions.messageEvents).mock.calls.filter(([reference, options]) => reference.agentSessionId === task.id && options?.latest)
  expect(originalLatestReads()).toHaveLength(1)
  heavy.mockClear()
  await act(async () => useAppStore.setState({ sessions: [task, ...unrelated, ...Array.from({ length: 240 }, (_, index) => activeSession('other-unrelated-' + index)), peer] }))
  await settleCollaborationCanvas(() => { expect(graph()?.querySelector('[aria-label="Map sources"]')?.getAttribute('title')).toContain('482 Agents'); expect(graph().querySelector('[aria-label="Reading sources"]')).toBeNull(); expect(graph().textContent).not.toContain('Arranging map…') })
  expect(new Set(heavy.mock.calls.map(([session]) => session.id)).size).toBeLessThan(64)
  expect(graph().querySelectorAll('.focus-context').length).toBeLessThan(64)
  expect(graph()?.querySelector('[aria-label="Map sources"]')?.getAttribute('title')).toContain('1 connections')
  expect(originalLatestReads()).toHaveLength(1)
  expect(new Set(vi.mocked(api.sessions.messageEvents).mock.calls.map(([reference]) => reference.agentSessionId)).size).toBeLessThan(96)
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[task.id]).toBe('Original unsent task')
})

it.each([
  { profile: 'all-point', presentationId: task.id, form: 'point' as const },
  { profile: 'identity-card', presentationId: 'scoped-presentation', form: 'card' as const }
])('refreshes retained exact Agent metadata outside body demand with $profile while preserving unrelated objects and read budgets', async ({ presentationId, form }) => {
  const watched = { ...task, id: presentationId, status: { state: 'waiting' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  useAppStore.setState({ sessions: [watched, ...unrelated, peer], agentNames: { [presentationId]: 'Scoped task', [peer.id]: 'Recorded peer' } })
  const build = vi.spyOn(contextOwner, 'agentContextForSession'), canvas = vi.spyOn(graphOwner, 'AgentCollaborationGraph')
  const graph = () => document.querySelector<HTMLElement>('.collaboration-map')!
  const agentId = collaborationSubjectKey(subject)
  const rendered = () => canvas.mock.calls.at(-1)![0].agents
  const mark = () => [...graph().querySelectorAll<HTMLElement>('[data-collaboration-agent]')].find(node => node.dataset.collaborationAgent === agentId)!
  await dom.render(<AgentCollaborationMap request={{ kind: 'focus', subject, name: 'Scoped task' }} onViewInFocus={() => { throw Error('Metadata cannot navigate') }} onOpen={() => { throw Error('Metadata cannot navigate') }} />)
  await settleCollaborationCanvas(() => {
    expect(graph().querySelector(`.focus-context[data-session-id="${presentationId}"]`)).not.toBeNull()
    expect(rendered().get(agentId)?.context?.bucket).toBe('attention')
    expect([...rendered().values()].filter(agent => agent.id !== agentId && agent.context).length).toBeGreaterThan(0)
  })
  await dom.click('[aria-label="Close map details"]')
  const levels = focusMapPreset(2).map(level => ({ ...level, form, information: 'identity' as const }))
  await act(async () => useAppStore.setState({ config: { ...composerConfig, focus: { recentActivityHours: 48, mapMotion: 'off', map: { boundary: 'bezier', levels } } } }))
  await settleCollaborationCanvas(() => expect(graph().querySelector('[aria-label="Map sources"]')?.getAttribute('title')).toContain('0 participants observed'))
  const held = [...rendered().values()].find(agent => agent.id !== agentId && agent.context)!
  const heldContext = held.context, reads = vi.mocked(api.sessions.messageEvents).mock.calls.length
  const timelineReads = vi.fn()
  const timelines = new Proxy(useAppStore.getState().timelines, { get(record, key, receiver) {
    if (typeof key === 'string') timelineReads(key)
    return Reflect.get(record, key, receiver)
  } })
  await act(async () => useAppStore.setState({ timelines }))
  build.mockClear(); timelineReads.mockClear()
  const working = { ...watched, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  await act(async () => useAppStore.setState({ sessions: [working, ...unrelated, peer], agentNames: { [presentationId]: 'Refreshed scoped task', [peer.id]: 'Recorded peer' } }))
  await settleCollaborationCanvas(() => {
    expect(rendered().get(agentId)?.context).toMatchObject({ id: presentationId, name: 'Refreshed scoped task', state: 'working', bucket: 'working', actionable: false,
      control: { hostId: subject.hostId, agentSessionId: subject.agentSessionId } })
    expect(mark().querySelector('.collaboration-agent__essential')).toBeNull()
  })
  expect(rendered().get(held.id)).toBe(held)
  expect(rendered().get(held.id)?.context).toBe(heldContext)
  expect(build.mock.calls.map(([session]) => session.id)).toEqual([presentationId])
  expect(build.mock.calls.every(([, timeline]) => timeline === undefined)).toBe(true)
  build.mockClear()
  const closed = { ...working, processState: 'exited' as const, status: { state: 'exited' as const, source: 'run-process' as const, observedAt: Date.now() } }
  await act(async () => useAppStore.setState({ sessions: [closed, ...unrelated, peer] }))
  await settleCollaborationCanvas(() => {
    expect(rendered().get(agentId)).toMatchObject({ tier: 'closed', context: { id: presentationId, processState: 'exited', state: 'exited', liveAgent: false } })
    expect(mark().classList.contains('collaboration-agent--closed')).toBe(true)
  })
  expect(rendered().get(held.id)).toBe(held)
  expect(rendered().get(held.id)?.context).toBe(heldContext)
  expect(build.mock.calls.map(([session]) => session.id)).toEqual([presentationId])
  expect(build.mock.calls.every(([, timeline]) => timeline === undefined)).toBe(true)
  expect(timelineReads).not.toHaveBeenCalled()
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(reads)
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[task.id]).toBe('Original unsent task')
})
