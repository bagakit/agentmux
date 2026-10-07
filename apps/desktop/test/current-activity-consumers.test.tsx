// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentSession } from '../../../packages/core/src/types.js'
import { decideContinuousProgress } from '../../../packages/core/src/continuous-progress.js'
import { activityCertaintyClient } from '../../../packages/core/test/fixtures/activity-certainty-client.js'
import { RuntimeController } from '../src/main/runtime-controller'
import { api } from '../src/renderer/src/lib/api'
import { observeAgentSession } from '../src/renderer/src/lib/agent-observation'
import { agentContextForSession, createFocusProjectionSelector, focusNeutralGroupSummary } from '../src/renderer/src/lib/focus-context'
import { projectRuntimeEvent } from '../src/renderer/src/lib/session-state'
import { FocusContextStateMark } from '../src/renderer/src/components/FocusContextState'
import type { SessionSnapshot } from '../src/shared/contracts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture() {
  const now = Date.now()
  const h = await activityCertaintyClient('current-activity-consumer', 'grok', {
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now - 1000 }
  })
  cleanup.push(h.close)
  const kernel = Reflect.get(h.client, 'kernel')
  kernel.list = async () => [h.run]
  kernel.identity = () => ({ buildIdentity: 'private', protocolVersion: 1, daemonInstanceId: 'private' })
  const core = (await h.client.statusAgent('current-activity-consumer')).session
  const activity: NonNullable<AgentMuxAgentSession['currentActivity']> = {
    state: 'active', source: 'native-hook', run: core.run, nativeSessionId: 'native-main', nativeTurnId: 'native-turn',
    sourceId: 'native-source', sequence: 1, hookReceiptId: 'native-start', observedAt: now
  }
  const config = await api.config.get()
  const main = new RuntimeController(h.store, async () => h.client)
  main.commit(await main.prepare(config)); cleanup.push(async () => main.dispose())
  // Supply one already-qualified Core public observation at the actual Main consumer.
  const projection = h.client.runtimeProjection.bind(h.client)
  vi.spyOn(h.client, 'runtimeProjection').mockImplementation(async () => {
    const value = await projection()
    return { ...value, subjects: value.subjects.map(subject => subject.kind === 'agent'
      ? { ...subject, agentSession: { ...subject.agentSession, currentActivity: activity } } : subject) }
  })
  const session = (await main.snapshot(config)).sessions.find(item => item.id === core.agentSessionId) as Extract<SessionSnapshot, { kind: 'agent' }>
  expect(session.currentActivity).toEqual(activity)
  const apply = (previous: typeof session, incoming: AgentMuxAgentSession) => projectRuntimeEvent({
    sessions: [previous], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {}
  }, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: incoming } }).state.sessions[0] as typeof session
  return { now, core, activity, session, apply, config }
}

it('Main and same-state Session events carry current active to idle without rewriting task completion', async () => {
  const { now, core, activity, session, apply, config } = await fixture()
  const select = createFocusProjectionSelector()
  const input = { sessions: [session], timelines: {}, agentNames: {}, config, scratchTopicSnapshots: {} }
  expect(select(input).contexts[0]).toMatchObject({ bucket: 'working', activitySemantic: 'active' })
  const idle = apply(session, { ...core, currentActivity: { ...activity, state: 'idle', sequence: 2, hookReceiptId: 'native-complete' } })
  expect(idle.semanticStatus).toEqual(session.semanticStatus)
  expect(idle.status).toEqual(session.status)
  expect(observeAgentSession(idle, now)).toMatchObject({ semantic: 'idle' })
  const context = select({ ...input, sessions: [idle] }).contexts[0]!
  expect(context).toMatchObject({ bucket: 'idle', state: 'running', activitySemantic: 'idle', stateLabel: 'Idle', workingEnteredAt: null })
  expect(context.stateEnteredAt).toBeUndefined()
  expect(focusNeutralGroupSummary([context]).detail).toBe('Idle 1 · Activity unknown 0 · Recovery 0')
  expect(renderToStaticMarkup(createElement(FocusContextStateMark, { context }))).toContain('data-focus-state-icon="idle"')
  expect(decideContinuousProgress({ session: core, observation: observeAgentSession(idle, now), tickId: 'private-tick', now,
    inputByte: 11, inputOccupied: false }).kind).toBe('skip')
  const unconfirmed = apply(idle, core)
  expect(unconfirmed.currentActivity).toBeUndefined()
  expect(observeAgentSession(unconfirmed, now).semantic).toBe('active')
})

it('current idle stays separate from an old result and an absent native activity source', async () => {
  const { now, core, activity, session, apply } = await fixture()
  const oldResult = { state: 'done' as const, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now - 1000 }
  const idle = apply(session, { ...core, semanticStatus: oldResult,
    currentActivity: { ...activity, state: 'idle', sequence: 2, hookReceiptId: 'native-complete' } })
  const context = agentContextForSession({ ...idle, status: oldResult }, {
    agentSessionId: core.agentSessionId, revision: 1, items: [{ id: 'old-result', agentSessionId: core.agentSessionId, kind: 'assistant_message',
      status: 'complete', source: 'native-hook', createdAt: now - 1000, updatedAt: now - 1000, content: 'An earlier result' }]
  }, undefined, undefined, null)
  expect(context).toMatchObject({ bucket: 'idle', stateLabel: 'Idle', activitySemantic: 'idle' })
  expect(decideContinuousProgress({ session: { ...core, semanticStatus: oldResult, currentActivity: idle.currentActivity },
    observation: observeAgentSession(idle, now), tickId: 'old-result-tick', now, inputByte: 11, inputOccupied: false }).kind).toBe('skip')
  const unknown = { ...idle, currentActivity: undefined, semanticStatus: undefined,
    status: { state: 'running' as const, source: 'run-process' as const, observedAt: now } }
  const unknownContext = agentContextForSession(unknown, undefined, undefined, undefined, null)
  expect(focusNeutralGroupSummary([context, unknownContext]).detail).toBe('Idle 1 · Activity unknown 1 · Recovery 0')
  expect(renderToStaticMarkup(createElement(FocusContextStateMark, { context: unknownContext }))).toContain('data-focus-state-icon="unknown"')
})

it('a current idle observation retains the original failure attention', async () => {
  const { now, activity, session } = await fixture()
  const failure = { state: 'error' as const, source: 'native-hook' as const, observedAt: now, detail: 'Original native failure' }
  const failed = { ...session, status: failure, semanticStatus: failure, currentActivity: { ...activity, state: 'idle' as const } }
  expect(agentContextForSession(failed, undefined, undefined, undefined, null)).toMatchObject({ bucket: 'attention', actionable: true, state: 'error' })
})

it('an explicit current observation gap cannot revive the historical working state', async () => {
  const { now, core, activity, session, apply } = await fixture()
  const idle = apply(session, { ...core, currentActivity: { ...activity, state: 'idle', sequence: 2 } })
  const gap = apply(idle, { ...core, currentActivity: { ...activity, state: 'unknown', sequence: 3, hookReceiptId: 'source-gap' } })
  expect(gap.currentActivity?.state).toBe('unknown')
  expect(gap.semanticStatus).toEqual(session.semanticStatus)
  expect(observeAgentSession(gap, now)).toMatchObject({ semantic: 'unknown', reason: 'activity-unconfirmed' })
  const context = agentContextForSession(gap, undefined, undefined, undefined, null)
  expect(context).toMatchObject({ bucket: 'idle', state: 'running', activitySemantic: 'unknown', workingEnteredAt: null })
  expect(focusNeutralGroupSummary([context]).detail).toBe('Idle 0 · Activity unknown 1 · Recovery 0')
  expect(renderToStaticMarkup(createElement(FocusContextStateMark, { context }))).toContain('data-focus-state-icon="unknown"')
  const staleHistory = { ...gap, semanticStatus: { ...gap.semanticStatus!, observedAt: now - 30 * 60_000 },
    status: { ...gap.status, observedAt: now - 30 * 60_000 } }
  expect(observeAgentSession(staleHistory, now)).toMatchObject({ semantic: 'unknown', stale: false, reason: 'activity-unconfirmed' })
  expect(decideContinuousProgress({ session: { ...core, currentActivity: gap.currentActivity }, observation: observeAgentSession(gap, now),
    tickId: 'source-gap-tick', now, inputByte: 11, inputOccupied: false }).kind).toBe('skip')
})
