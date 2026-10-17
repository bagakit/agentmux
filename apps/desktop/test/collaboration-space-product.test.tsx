// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxMessageEvent, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxDesktopSpaceSelection } from '@agentmux/core/control'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerDOM } from './helpers/composer-dom-fixture'
import { defaultAgent, neighborAgent, customAgent, customMoteId, moteSessions, moteTopics, ordinaryTopicId, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { topicSpatialAddress } from '../src/shared/space-addresses'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { WorkspaceAgentsTool } from '../src/renderer/src/components/SurfaceToolDock'

const dom = composerDOM({ agentInformation: true }), open = vi.fn()
const graph = () => document.querySelector<HTMLElement>('.collaboration-dialog')!
let records: AgentMuxMessageEvent[]
function choice(topicId: string): AgentMuxDesktopSpaceSelection {
  const state = useAppStore.getState(), topic = moteTopics.find(value => value.id === topicId)!
  return { workspaceId: scratchWorkspace.id, topicId, ...topicSpatialAddress(state.config, topic, state.spaceZoneBindings, state.topicCategories)!, tabId: null, regionId: null, groupId: null }
}
function event(sequence: number, messageId: string, sender = defaultAgent.id, recipient = neighborAgent.id, kind: AgentMuxMessageEvent['kind'] = 'message'): AgentMuxMessageEvent {
  return { sequence, kind, at: fixtureEpoch(1), messages: [{ messageId, senderSessionId: sender, recipientSessionId: recipient, threadId: 'thread-' + messageId, replyTo: null }] }
}
async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  expect(button).not.toBeNull(); await act(async () => button!.click())
}
async function textClick(text: string) {
  const button = [...graph().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(button).toBeDefined(); await act(async () => button!.click())
}
async function render() {
  await dom.render(<WorkspaceAgentsTool workspace={scratchWorkspace} sessions={moteSessions} onOpen={open} />)
  await click('Open area collaboration graph')
  await act(async () => vi.waitFor(() => expect(graph()?.textContent).toContain('connections')))
}
beforeEach(() => {
  seedMoteWorkface()
  useAppStore.setState({ spaceZoneBindings: {}, spatialRequests: {}, topicCategories: [], projectGroups: [], workspaceAgentOrder: {},
    workbenchSpaceSelection: choice(PMO_TEAMS_TOPIC_ID), agentNames: { [defaultAgent.id]: 'Original sender', [neighborAgent.id]: 'Original recipient', [customAgent.id]: 'Custom task' } })
  records = [event(1, 'original-mid')]; open.mockReset()
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async (subject, options = {}): Promise<AgentMuxRpcResult<'message.events'>> => ({
    hostId: subject.hostId, participantSessionId: subject.agentSessionId, afterSequence: options.afterSequence ?? 0,
    latest: options.latest ?? false, beforeSequence: options.beforeSequence ?? null, throughSequence: records.at(-1)?.sequence ?? 0,
    incarnation: 'space-original-journal', messageId: options.messageId ?? null, broadcastOperationId: null,
    events: records.filter(item => item.sequence > (options.afterSequence ?? 0) && item.messages.some(message =>
      (!options.messageId || message.messageId === options.messageId) && (message.senderSessionId === subject.agentSessionId || message.recipientSessionId === subject.agentSessionId))),
    nextAfterSequence: null, nextBeforeSequence: null
  }))
  vi.spyOn(api.sessions, 'spawns').mockImplementation(async (subject, options) => ({ hostId: subject.hostId, participantSessionId: subject.agentSessionId,
    direction: options.direction, creatorRuntimeId: null, records: [], nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }))
  vi.spyOn(api.sessions, 'readMessage').mockRejectedValue(Error('Body not requested'))
  vi.spyOn(api.sessions, 'dispatch').mockRejectedValue(Error('Request not requested'))
})

it('opens the real Space graph from a captured area without retargeting it when background selection changes', async () => {
  const state = useAppStore.getState(), draft = state.agentComposerDrafts
  await render()
  const reads = vi.mocked(api.sessions.messageEvents).mock.calls
  expect(reads.map(call => call[0].agentSessionId).sort()).toEqual([defaultAgent.id, neighborAgent.id].sort())
  expect(graph().querySelector('.focus-context[data-session-id="default-agent"]')).not.toBeNull()
  expect(graph().querySelector('.focus-context[data-session-id="custom-agent"]')).toBeNull()
  const originalSelection = state.workbenchSpaceSelection, originalGraph = graph()
  await act(async () => useAppStore.setState({ workbenchSpaceSelection: choice(ordinaryTopicId), agentNames: { ...state.agentNames, [defaultAgent.id]: 'Original sender updated' } }))
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(2)
  expect(graph()).toBe(originalGraph)
  expect(graph().querySelector('.focus-context[data-session-id="default-agent"]')).not.toBeNull()
  expect(graph().querySelector('.focus-context[data-session-id="ordinary-agent"]')).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts).toBe(draft); expect(open).not.toHaveBeenCalled()
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
  await click('Close collaboration graph'); expect(graph()).toBeNull()
  expect(useAppStore.getState().workbenchSpaceSelection).not.toBe(originalSelection)
})

it('observes an original Host and SID once across overlapping areas without writing membership or task state', async () => {
  const state = useAppStore.getState(), snapshot = state.scratchTopicSnapshots[scratchWorkspace.id]!
  const topics = snapshot.topics.map(topic => topic.id === customMoteId ? { ...topic, collaborators: [defaultAgent, neighborAgent].map(session => ({ fileName: session.id + '.md', sessionId: session.id, providerId: session.providerId })) } : topic)
  useAppStore.setState({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [scratchWorkspace.id]: { ...snapshot, topics } } })
  await render()
  const original = useAppStore.getState()
  await textClick('All areas')
  const ids = vi.mocked(api.sessions.messageEvents).mock.calls.map(call => JSON.stringify(call[0]))
  expect(ids).toHaveLength(moteSessions.length); expect(new Set(ids).size).toBe(moteSessions.length)
  expect(graph().querySelectorAll('.focus-context[data-session-id="default-agent"]').length).toBe(2)
  expect(graph().textContent).toContain('1 connections')
  expect(useAppStore.getState().spaceZoneBindings).toBe(original.spaceZoneBindings)
  expect(useAppStore.getState().scratchTopicSnapshots).toBe(original.scratchTopicSnapshots)
  expect(useAppStore.getState().agentFocus).toBe(original.agentFocus)
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
})

it('makes folded internal connections inspectable as original messages and applies kind filters to the same badge', async () => {
  records = [event(1, 'original-mid'), event(2, 'reply-mid', neighborAgent.id, defaultAgent.id), event(3, 'supervised-mid', defaultAgent.id, neighborAgent.id, 'dispatch-open')]
  await render()
  expect(graph().textContent).toContain('3 connections')
  const heading = graph().querySelector<HTMLButtonElement>('.collaboration-area__heading')!
  expect(heading.getAttribute('aria-expanded')).toBe('true'); await act(async () => heading.click())
  const badge = graph().querySelector<HTMLButtonElement>('[aria-label="Mote: 3 internal connections"]')!
  expect(badge).not.toBeNull(); expect(heading.getAttribute('aria-expanded')).toBe('false')
  await act(async () => badge.click())
  expect(graph().querySelectorAll('[aria-label="Grouped connections"] .collaboration-relation')).toHaveLength(3)
  expect(graph().textContent).toContain('original-mid'); expect(graph().textContent).toContain('supervised-mid')
  const group = [...graph().querySelectorAll<HTMLButtonElement>('[aria-label="Grouped connections"] .collaboration-relation')].find(node => node.textContent?.includes('Original recipient → Original sender'))!
  await act(async () => group.click()); expect(graph().textContent).toContain('reply-mid')
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
  await act(async () => graph().querySelector<HTMLButtonElement>('.collaboration-toolbar__kinds [data-kind="communication"]')!.click())
  expect(graph().querySelector('[aria-label="Mote: 1 internal connections"]')).not.toBeNull()
  expect(graph().textContent).toContain('1 connections')
  await act(async () => graph().querySelector<HTMLButtonElement>('[aria-label="Mote: 1 internal connections"]')!.click())
  expect(graph().textContent).toContain('supervised-mid')
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
})
