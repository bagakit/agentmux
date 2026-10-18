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
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM({ agentInformation: true })
const activeSession = (id: string) => ({ ...composerSession(id), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } })
const subject = { hostId: 'local', agentSessionId: 'scoped-task' }, task = activeSession(subject.agentSessionId), peer = activeSession('recorded-peer')
const unrelated = Array.from({ length: 240 }, (_, index) => activeSession('unrelated-' + index))
beforeEach(() => {
  installCollaborationCanvasGeometry()
  installCollaborationLayoutLoopback()
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
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
