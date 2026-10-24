// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { projectConversationSummary } from '@agentmux/core/conversation'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { agentContextForSession, createFocusProjectionSelector, type FocusContext } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'

vi.mock('@agentmux/core/conversation', async original => {
  const actual = await original<typeof import('@agentmux/core/conversation')>()
  return { ...actual, projectConversationSummary: vi.fn(actual.projectConversationSummary) }
})
// Exercise the actual CardBody Store subscription/completion owner; its painted
// Row is an observation leaf here. The full Focus consumer is covered separately.
const row = vi.hoisted(() => ({ contexts: [] as FocusContext[] }))
vi.mock('../src/renderer/src/components/FocusContextRow', () => ({ FocusContextRow: ({ context }: { context: FocusContext }) => {
  row.contexts.push(context)
  return <span data-body-session={context.id}>{context.recap?.reading?.text ?? context.detail}</span>
} }))
import { FocusContextCardBody } from '../src/renderer/src/components/FocusContextCardBody'

const baseline = useAppStore.getState(), project = vi.mocked(projectConversationSummary)
let root: Root | undefined, host: HTMLDivElement | undefined
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); project.mockClear(); row.contexts.length = 0 })
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; host?.remove(); host = undefined
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function scene() {
  const scratch = { id: '__scratch__', hostId: 'local', name: 'Original Scratch', path: fixturePath('coordination-scratch'), kind: 'folder' as const }
  const mote: ScratchTopicSnapshot = { id: 'launcher:coordinator', kind: 'mote', title: 'Original Mote', summary: '',
    directoryPath: scratch.path + '/topic--launcher--coordinator', identityDirectoryPath: scratch.path + '/topic--launcher--coordinator',
    topicPath: scratch.path + '/topic--launcher--coordinator/topic.md', collaborators: [] }
  const session = { ...composerSession('mote-original'), workspacePath: mote.directoryPath,
    status: { state: 'waiting' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  const execution = composerSession('execution-original')
  const input = { sessions: [session, execution], config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratch] }, timelines: {} as Record<string, AgentTimelineSnapshot>,
    agentNames: { [session.id]: 'Original coordination Agent' }, scratchTopicSnapshots: { [scratch.id]: {
      scope: JSON.stringify([scratch.hostId, scratch.path]), revision: 1, topics: [mote], reading: false, error: null
    } } }
  return { input, scratch, mote, session, execution }
}
function reply(id: string, text = 'Original accepted response'): AgentTimelineSnapshot {
  return { agentSessionId: id, sourceHostId: 'local', revision: 1, items: [{ id: 'original-reply', agentSessionId: id,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Reply', content: text,
    createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }] }
}
function poisonTimeline(id: string) {
  const reads = { references: 0, iteration: 0, body: 0 }, timeline = reply(id)
  Object.defineProperty(timeline.items[0]!, 'content', { get() { reads.body++; throw new Error('Coordination metadata read a message body') } })
  const original = timeline.items
  const items = new Proxy(original, { get(target, key, receiver) {
    if (key === Symbol.iterator || key === 'length' || typeof key === 'string' && (/^\d+$/.test(key) || ['at', 'find', 'filter', 'map', 'flatMap', 'slice', 'reverse'].includes(key))) {
      reads.iteration++; throw new Error('Coordination metadata iterated a retained Timeline')
    }
    return Reflect.get(target, key, receiver)
  } })
  Object.defineProperty(timeline, 'items', { get() { reads.references++; return items } })
  return { timeline, reads }
}

it('requests coordination metadata explicitly without changing execution membership, reminder or original history', () => {
  const { input, session, execution } = scene(), select = createFocusProjectionSelector()
  const history = { sessionId: execution.id, history: [{ sessionId: execution.id, focusedAt: fixtureEpoch(0, 0, 1) }] }
  const originalFocus = { execution: history, pmo: { sessionId: session.id } }, state = { ...input, agentFocus: originalFocus }
  const compact = select(state)
  expect(compact.contexts.map(context => context.id)).toEqual([execution.id]); expect(compact.laneContexts.map(context => context.id)).toEqual([execution.id])
  expect(compact.pmoAttention).toEqual([session.id]); expect(compact.coordinationContexts).toEqual([])
  const expanded = select(state, true, undefined, true)
  expect(expanded.coordinationContexts.map(context => [context.id, context.topicId, context.bucket, context.recap])).toEqual([[session.id, 'launcher:coordinator', 'attention', null]])
  expect(expanded.contexts).toBe(compact.contexts); expect(expanded.laneContexts).toBe(compact.laneContexts); expect(expanded.pmoAttention).toBe(compact.pmoAttention)
  expect(select({ ...state }, true, undefined, true)).toBe(expanded)
  const hidden = select(state, true)
  expect(hidden.coordinationContexts).toEqual([]); expect(hidden.contexts).toBe(compact.contexts)
  expect(select(state, true, undefined, true).coordinationContexts[0]).toBe(expanded.coordinationContexts[0])
  expect(state.agentFocus).toBe(originalFocus); expect(state.agentFocus.execution).toBe(history)
  expect(state.agentFocus.execution.history).toEqual([{ sessionId: execution.id, focusedAt: fixtureEpoch(0, 0, 1) }])
  expect(input.sessions).toEqual([session, execution]); expect(expanded.coordinationContexts[0]!.control).toBe(session.control)
})

it.each(['metadata', 'full'] as const)('does not iterate retained Mote records or read body/name text in %s mode', mode => {
  const { input, session } = scene(), { timeline, reads } = poisonTimeline(session.id)
  input.timelines[session.id] = timeline
  const select = createFocusProjectionSelector(), compact = select(input, true, mode)
  expect(compact.coordinationContexts).toEqual([])
  const before = select(input, true, mode, true)
  expect(before.coordinationContexts.map(context => [context.name, context.recap])).toEqual([['Original coordination Agent', null]])
  expect(reads.iteration).toBe(0); expect(reads.body).toBe(0); expect(project).not.toHaveBeenCalled()
  reads.references = 0
  expect(select({ ...input }, true, mode, true)).toBe(before)
  expect(reads.iteration).toBe(0); expect(reads.body).toBe(0)
  const next = select({ ...input, sessions: input.sessions.map(current => ({ ...current, latestOutputBytes: current.latestOutputBytes + 100 })) }, true, mode, true)
  expect(next.coordinationContexts).toBe(before.coordinationContexts); expect(next.contexts).toBe(before.contexts); expect(next.laneContexts).toBe(before.laneContexts)
  expect(reads.iteration).toBe(0); expect(reads.body).toBe(0); expect(project).not.toHaveBeenCalled()
})

it('does not adopt a warmed conversation cache or turn a done Mote label into Results', () => {
  const { input, session, scratch, mote } = scene(), done = { ...session, status: { state: 'done' as const, source: 'native-hook' as const, observedAt: Date.now() } }, timeline = reply(session.id)
  expect(agentContextForSession(done, timeline, 'Original Mote', scratch, mote.id).bucket).toBe('results')
  project.mockClear(); input.sessions[0] = done; input.timelines[session.id] = timeline
  const projected = createFocusProjectionSelector()(input, true, 'full', true)
  expect(projected.coordinationContexts.map(context => ({ id: context.id, bucket: context.bucket, recap: context.recap, lastActivityAt: context.lastActivityAt }))).toEqual([
    { id: session.id, bucket: 'idle', recap: null, lastActivityAt: null }
  ])
  expect(project).not.toHaveBeenCalled()
})

it('invalidates requested metadata for original name, Run/control and Mote identity changes, including while disabled', () => {
  const { input, session, execution, mote } = scene(), select = createFocusProjectionSelector(), initial = select(input, true, 'metadata', true)
  const renamed = { ...input, agentNames: { [session.id]: 'New original name' } }
  const disabled = select(renamed, true, 'metadata', false)
  expect(disabled.coordinationContexts).toEqual([]); expect(disabled.contexts).toBe(initial.contexts)
  const enabled = select(renamed, true, 'metadata', true)
  expect(enabled.coordinationContexts[0]!.name).toBe('New original name'); expect(enabled.coordinationContexts[0]).not.toBe(initial.coordinationContexts[0])
  const nextSession = { ...session, control: { ...session.control, agentSessionId: 'new-original-control', run: { runId: 'new-original-run' } },
    nativeHandle: { kind: 'provider' as const, providerId: session.providerId, sessionId: 'new-native-identity' } }
  const changed = select({ ...renamed, sessions: [nextSession, execution] }, true, 'metadata', true)
  expect(changed.coordinationContexts[0]!.control).toBe(nextSession.control); expect(changed.coordinationContexts[0]!.runId).toBe('new-original-run')
  expect(changed.coordinationContexts[0]!.nativeSessionId).toBe('new-native-identity'); expect(changed.contexts).toBe(initial.contexts)
  const snapshot = input.scratchTopicSnapshots.__scratch__!
  const asTopic = select({ ...input, scratchTopicSnapshots: { __scratch__: { ...snapshot, topics: [{ ...mote, kind: 'topic' as const }] } } }, true, 'metadata', true)
  expect(asTopic.coordinationContexts).toEqual([]); expect(asTopic.contexts.map(context => context.id)).toEqual([session.id, execution.id]); expect(asTopic.pmoAttention).toEqual([])
  const { kind: _knownKind, ...originalAddress } = mote
  const unknown = select({ ...input, scratchTopicSnapshots: { __scratch__: { ...snapshot, topics: [{ ...originalAddress, readError: 'Original content classification unavailable' }] } } }, true, 'metadata', true)
  expect(unknown.coordinationContexts).toEqual([]); expect(unknown.contexts.map(context => context.id)).toEqual([session.id, execution.id])
  expect(unknown.contexts[0]!.detail).toContain('Mote identity is not confirmed')
  const restored = select(input, true, 'metadata', true)
  expect(restored.coordinationContexts.map(context => context.id)).toEqual([session.id]); expect(restored.contexts.map(context => context.id)).toEqual([execution.id])
  const removed = select({ ...input, sessions: [execution] }, true, 'metadata', true)
  expect(removed.coordinationContexts).toEqual([]); expect(removed.contexts).toBe(restored.contexts); expect(removed.pmoAttention).toEqual([])
})

it.each([14, 112])('keeps related metadata recomputation bounded with %i unrelated Agent Sessions', count => {
  const { input, session, execution, scratch } = scene(), { timeline, reads } = poisonTimeline(session.id)
  let scopeReads = 0
  const originalScratch = new Proxy(scratch, { get(target, key, receiver) { if (key === 'path') scopeReads++; return Reflect.get(target, key, receiver) } })
  const second = { ...session, id: 'second-coordinator', control: { ...session.control, agentSessionId: 'second-coordinator' } }
  input.sessions = [session, second, ...Array.from({ length: count }, (_, index) => ({ ...execution, id: 'unrelated-' + index, control: { ...execution.control, agentSessionId: 'unrelated-' + index } }))]
  input.config.workspaces = [...composerConfig.workspaces, originalScratch]
  input.timelines[session.id] = timeline; input.timelines[second.id] = poisonTimeline(second.id).timeline
  const select = createFocusProjectionSelector(), before = select(input, true, 'metadata', true)
  expect(before.contexts).toHaveLength(count); expect(before.coordinationContexts.map(context => context.id)).toEqual([session.id, second.id])
  scopeReads = 0
  expect(select({ ...input }, true, 'metadata', true)).toBe(before); expect(scopeReads).toBe(0)
  const changed = select({ ...input, agentNames: { [session.id]: 'Changed metadata only' } }, true, 'metadata', true)
  expect(changed.contexts).toBe(before.contexts); expect(changed.laneContexts).toBe(before.laneContexts)
  expect(changed.coordinationContexts[0]!.name).toBe('Changed metadata only'); expect(changed.coordinationContexts[1]).toBe(before.coordinationContexts[1])
  expect(scopeReads).toBe(1); expect(reads.iteration).toBe(0); expect(reads.body).toBe(0); expect(project).not.toHaveBeenCalled()
  const inactive = { ...input, sessions: new Proxy(input.sessions, { get() { throw new Error('Inactive Focus read Session facts') } }) }
  expect(select(inactive, false, 'full', false)).toBe(changed)
})

async function mount(context: FocusContext, summary = 2) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(<FocusContextCardBody context={context} selected={false} onSelect={() => {}} disclosure={{ status: 2, summary }} />))
}

it.each(['none', 'accepted'] as const)('keeps explicit %s recap cards outside the retained facts subscription', async kind => {
  const session = composerSession('card-metadata'), workspace = composerConfig.workspaces[0]!, context = agentContextForSession(session, kind === 'accepted' ? reply(session.id) : undefined, 'Original card', workspace, null)
  let timelineReads = 0
  const timelines = new Proxy({} as Record<string, AgentTimelineSnapshot>, { get(_target, key) { if (key === session.id) timelineReads++; return undefined } })
  useAppStore.setState({ sessions: [session], timelines, agentNames: {}, config: composerConfig })
  project.mockClear(); await mount(context)
  expect(row.contexts).toEqual([context]); expect(timelineReads).toBe(0); expect(project).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ agentNames: { [session.id]: 'Unrelated Store update' } }))
  expect(row.contexts).toEqual([context]); expect(timelineReads).toBe(0)
})

it('retains the original undefined-recap completion and updates the same accepted Timeline wrapper', async () => {
  const session = composerSession('card-deferred'), workspace = composerConfig.workspaces[0]!, accepted = reply(session.id), timelines = { [session.id]: accepted }
  const deferred = { ...agentContextForSession(session, undefined, 'Original card', workspace, null), recap: undefined }
  useAppStore.setState({ sessions: [session], timelines, agentNames: {}, config: composerConfig, agentComposerDrafts: { [session.id]: 'Keep original draft' } })
  project.mockClear(); await mount(deferred)
  expect(host!.textContent).toBe('Original accepted response'); expect(project).toHaveBeenCalledTimes(1); expect(deferred.recap).toBeUndefined()
  const originalNode = host!.firstChild
  accepted.revision++; accepted.items[0] = { ...accepted.items[0]!, content: 'Current original response' }
  await act(async () => useAppStore.setState({ timelines }))
  expect(host!.textContent).toBe('Current original response'); expect(host!.firstChild).toBe(originalNode); expect(project).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep original draft'); expect(useAppStore.getState().sessions[0]!.control.run).toBe(session.control.run)
})
