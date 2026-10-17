// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { AgentCollaborationDialog } from '../src/renderer/src/components/AgentCollaborationDialog'
import { api } from '../src/renderer/src/lib/api'
import * as contextOwner from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM({ agentInformation: true })
const subject = { hostId: 'local', agentSessionId: 'scoped-task' }, task = composerSession(subject.agentSessionId), peer = composerSession('recorded-peer')
const unrelated = Array.from({ length: 240 }, (_, index) => composerSession('unrelated-' + index))
beforeEach(() => {
  useAppStore.setState({ config: composerConfig, sessions: [task, ...unrelated, peer], tabs: {}, layouts: {}, timelines: {},
    scratchTopicSnapshots: {}, spaceZoneBindings: {}, spatialRequests: {}, topicCategories: [], projectGroups: [],
    agentNames: { [task.id]: 'Scoped task', [peer.id]: 'Recorded peer' }, agentComposerDrafts: { [task.id]: 'Original unsent task' } })
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async (reference, options = {}): Promise<AgentMuxRpcResult<'message.events'>> => ({
    hostId: reference.hostId, participantSessionId: reference.agentSessionId, afterSequence: options.afterSequence ?? 0, latest: options.latest ?? false,
    beforeSequence: options.beforeSequence ?? null, throughSequence: 1, incarnation: 'scoped-journal', messageId: options.messageId ?? null, broadcastOperationId: null,
    events: [{ sequence: 1, kind: 'message', at: fixtureEpoch(1), messages: [{ messageId: 'scoped-message', senderSessionId: task.id,
      recipientSessionId: peer.id, threadId: 'scoped-thread', replyTo: null }] }], nextAfterSequence: null, nextBeforeSequence: null
  }))
  vi.spyOn(api.sessions, 'spawns').mockImplementation(async (reference, options) => ({ hostId: reference.hostId, participantSessionId: reference.agentSessionId,
    direction: options.direction, creatorRuntimeId: null, records: [], nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }))
  vi.spyOn(api.sessions, 'readMessage').mockRejectedValue(Error('No original body demand'))
  vi.spyOn(api.sessions, 'dispatch').mockRejectedValue(Error('No supervised request demand'))
})

it('builds production contexts only for the focused Agent and recorded peers as unrelated Sessions grow', async () => {
  const heavy = vi.spyOn(contextOwner, 'agentContextForSession')
  await dom.render(<AgentCollaborationDialog request={{ kind: 'focus', subject, name: 'Scoped task' }} onClose={() => {}} onOpen={() => { throw Error('Observation cannot navigate') }} />)
  const graph = () => document.querySelector<HTMLElement>('.collaboration-dialog')!
  await act(async () => vi.waitFor(() => expect(graph()?.textContent).toContain('1 connections')))
  expect(heavy).toHaveBeenCalled()
  expect([...new Set(heavy.mock.calls.map(([session]) => session.id))].sort()).toEqual([task.id, peer.id].sort())
  expect(graph().querySelector('.focus-context[data-session-id="scoped-task"]')).not.toBeNull()
  expect(graph().querySelector('.focus-context[data-session-id="recorded-peer"]')).not.toBeNull()
  expect(graph().querySelectorAll('.focus-context')).toHaveLength(2)
  expect(api.sessions.messageEvents).toHaveBeenCalledExactlyOnceWith(subject, { latest: true, limit: 50 })
  heavy.mockClear()
  await act(async () => useAppStore.setState({ sessions: [task, ...unrelated, ...Array.from({ length: 240 }, (_, index) => composerSession('other-unrelated-' + index)), peer] }))
  expect(heavy).toHaveBeenCalled()
  expect([...new Set(heavy.mock.calls.map(([session]) => session.id))].sort()).toEqual([task.id, peer.id].sort())
  expect(graph().querySelectorAll('.focus-context')).toHaveLength(2)
  expect(graph().textContent).toContain('1 connections')
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(1)
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[task.id]).toBe('Original unsent task')
})
