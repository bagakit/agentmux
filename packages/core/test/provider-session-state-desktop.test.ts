import { afterEach, expect, it } from 'vitest'
import type { SessionSnapshot } from '../../../apps/desktop/src/shared/contracts'
import { observeAgentSession } from '../../../apps/desktop/src/renderer/src/lib/agent-observation'
import { projectRuntimeEvent, type SessionProjectionState } from '../../../apps/desktop/src/renderer/src/lib/session-state'
import { agentPresentationState } from '../../client-ui/src/lib/agent-presentation.js'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })

async function desktop() {
  const h = await activityCertaintyClient('desktop-original', 'claude'); closes.push(h.close)
  const snapshot: Extract<SessionSnapshot, { kind: 'agent' }> = { kind: 'agent', id: 'desktop-original',
    hostId: 'local', workspacePath: h.directory, label: 'Original', createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 17,
    providerId: 'claude', executorId: 'claude', capabilities: h.client.providers.get('claude').catalog.capabilities,
    agentSessionUpdatedAt: 1, control: { kind: 'agent', hostId: 'local', agentSessionId: 'desktop-original', run: { runId: h.run.runId } } }
  const state: SessionProjectionState = { sessions: [snapshot], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
  const native = (sequence: number, turnId: string, extra = {}) => ({ session_id: 'native-main', sourceId: 'source-original', sequence, turnId, ...extra })
  await h.hook('turn.start', 'main-start', native(1, 'main-original'))
  await h.hook('turn.start', 'child-start', native(2, 'child-original-turn', { agent_id: 'child-original' }))
  await h.hook('turn.complete', 'main-end', native(3, 'main-original', { reason: 'answer', isAborted: false, backgroundWork: 'pending' }))
  return { h, snapshot, state, native }
}

it('Desktop consumes the same main and child facts through its production Session reducer', async () => {
  const { h, snapshot, state: initial, native } = await desktop()
  let state = initial
  state = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: h.client.agentSession('desktop-original') } }).state
  const first = state.sessions[0] as Extract<SessionSnapshot, { kind: 'agent' }>
  expect(first.nativeSubagents?.sessions).toEqual([expect.objectContaining({ nativeAgentId: 'child-original', state: 'working' })])
  expect(observeAgentSession(first, Date.now())).toMatchObject({ semantic: 'active', mainSession: { semantic: 'idle' } })
  await h.hook('turn.complete', 'child-end', native(4, 'child-original-turn', { agent_id: 'child-original', reason: 'answer', isAborted: false }))
  state = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: h.client.agentSession('desktop-original') } }).state
  const ended = state.sessions[0] as Extract<SessionSnapshot, { kind: 'agent' }>
  expect(ended.nativeSubagents?.sessions).toEqual([expect.objectContaining({ nativeAgentId: 'child-original', state: 'done', phase: 'ended', outcome: 'completed' })])
  expect(observeAgentSession(ended, Date.now())).toMatchObject({ semantic: 'unknown', mainSession: { semantic: 'idle' } })
  expect(ended.control).toEqual(snapshot.control)
})

it('confirmed child work preserves the original main permission request and Desktop attention', async () => {
  const { h, state } = await desktop()
  await h.hook('PermissionRequest', 'permission-original', { session_id: 'native-main', tool_name: 'Bash',
    tool_use_id: 'permission-call-original', tool_input: { command: 'private fixture' } })
  const original = h.client.agentSession('desktop-original')
  const projected = projectRuntimeEvent(state, { type: 'core', hostId: 'local', event: { type: 'agent-session', session: original } }).state
  const session = projected.sessions[0] as Extract<SessionSnapshot, { kind: 'agent' }>
  const observation = observeAgentSession(session, Date.now())
  expect(observation).toMatchObject({ semantic: 'active', mainSession: { semantic: 'awaiting-input' }, readiness: 'pending' })
  expect(session.pendingInteraction).toEqual(original.pendingInteraction?.request)
  expect(session.pendingInteraction?.kind).toBe('permission')
  expect(agentPresentationState(session, observation, false)).toMatchObject({ bucket: 'attention', stateLabel: 'Request pending' })
})
