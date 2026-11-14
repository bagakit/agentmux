import { afterEach, expect, it, vi } from 'vitest'
import { demandExecutionReferences, type Demand, type DemandDelegation } from '@agentmux/demand'
import { observeAgent, type AgentObservation } from '../src/agent-status-freshness.js'
import type { AgentMuxAgentRuntimeStatus } from '../src/client-contract.js'
import { observeGoalExecution, parseGoalResponsibility } from '../src/goal-responsibility.js'
import { parseGoalDelegationResult } from '../src/goal-delegation.js'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'

const now = 1_800_000_000_000
const runId = 'original-worker-run'
const delegation: DemandDelegation = { operationId: 'original-delegation', sourceMessageId: 'original-source', hostId: 'local',
  ownerAgentSessionId: 'manager', workerAgentSessionId: 'worker', ownerRunId: 'manager-run', workerRunId: runId, threadId: 'original-thread',
  text: 'Keep the original work', alignmentRevision: 1, criterionIds: ['AC'], preparedAt: now - 1000, linkedAt: now - 500, capturedCriteria: [{ id: 'AC', text: 'Original criterion' }] }
const goal: Demand = { id: 'original-goal', title: 'Original Goal', description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
  executorId: null, tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, sessionIds: [], assigneeSessionIds: [], supervisorSessionId: 'manager', participations: [],
  activities: [], decisions: [], delegations: [delegation], createdAt: now - 1000, updatedAt: now }
const references = demandExecutionReferences(goal)
const observation = (children = false): AgentObservation => observeAgent({ process: 'running', status: { state: children ? 'done' : 'working', source: 'native-hook', observedAt: now - 10, nativeTurnId: 'original-main-turn' },
  timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false,
  ...(children ? { subagentSessions: { run: { runId }, providerId: 'codex', nativeSessionId: 'original-native-session', sourceId: 'original-source', unconfirmed: false,
    sessions: [{ nativeAgentId: 'original-child', hookReceiptId: 'original-child-hook', nativeTurnId: 'original-child-turn', sourceId: 'original-source', sequence: 1, state: 'working', phase: 'running', observedAt: now }] } } : {}) }, now)
function result(observed: AgentObservation, runtime?: AgentMuxAgentRuntimeStatus) {
  // Only the status fields consumed by responsibility are supplied in the pure producer cases.
  const status = runtime ?? { session: { agentSessionId: 'worker', run: { runId } }, run: { runId, state: 'running' }, observation: observed } as AgentMuxAgentRuntimeStatus
  const row = observeGoalExecution(goal, { execution: references[0]!, inputConfirmed: true, status, originalRun: { runId, state: 'running' } }, now)
  return { goalId: goal.id, goalUpdatedAt: now, diskDurability: 'confirmed' as const, delegations: [delegation], responsibility: {
    scope: 'original-owner', observedAt: now, supervisor: { agentSessionId: 'manager', state: 'available' as const, reason: 'Original manager observed' }, executions: [row] } }
}
const parse = (value: unknown) => parseGoalDelegationResult(value, { goalId: goal.id })
afterEach(() => vi.restoreAllMocks())

it.each([false, true])('preserves actual observeAgent main/child output through original responsibility and the public Goal consumer (children=%s)', children => {
  const observed = observation(children), value = result(observed)
  expect(observed.mainSession).toMatchObject({ semantic: children ? 'idle' : 'active', nativeTurnId: 'original-main-turn' })
  expect(observed.semantic).toBe('active')
  expect(parseGoalResponsibility(value.responsibility, references).executions[0]!.observation).toEqual(observed)
  const read = parse(value)
  expect(read.responsibility!.executions[0]).toMatchObject({ execution: references[0], phase: 'executing', observation: observed })
  expect(read.delegations).toEqual([delegation]); expect(read.grounding).toBeUndefined()
  expect(read.responsibility!.executions[0]!.observation?.subagentSessions).toEqual(observed.subagentSessions)
})

it('the actual durable Core Client status reaches the Goal decoder with its mainSession observation intact', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const h = await activityCertaintyClient('worker', 'codex', { semanticStatus: { state: 'working', source: 'native-hook', observedAt: now } })
  try {
    const status = await h.client.statusAgent('worker')
    const original = { ...delegation, workerRunId: status.run.runId }, execution = demandExecutionReferences({ delegations: [original] })[0]!
    const row = observeGoalExecution({ ...goal, delegations: [original] }, { execution, inputConfirmed: true, status, originalRun: { runId: status.run.runId, state: 'running' } }, now)
    const value = { ...result(status.observation), delegations: [original] }
    value.responsibility.executions = [row]
    expect(status.observation.mainSession).toBeDefined()
    expect(parse(value).responsibility!.executions[0]!.observation).toEqual(status.observation)
    expect(h.requests).toEqual([status.run.runId])
  } finally { await h.close() }
})

it('keeps unknown and historical activity as original facts without inventing current work', () => {
  const observed = observeAgent({ process: 'running', status: { state: 'working', source: 'acp', observedAt: now - 30 * 60_000 },
    timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now)
  expect(observed).toMatchObject({ semantic: 'unknown', readiness: 'ready', reason: 'activity-stale', lastKnownActivity: { state: 'working', source: 'acp' } })
  expect(parse(result(observed)).responsibility!.executions[0]).toMatchObject({ phase: 'unknown', observation: observed })
})

it('preserves the producer output for every original evidence source and main semantic declaration', () => {
  for (const source of ['terminal-output', 'run-process', 'native-hook', 'native-transcript', 'acp', 'user', 'agentmux'] as const)
    for (const state of ['working', 'waiting', 'done', 'error'] as const) {
      const observed = observeAgent({ process: 'running', status: { state, source, observedAt: now }, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now)
      expect(parse(result(observed)).responsibility!.executions[0]!.observation).toEqual(observed)
    }
})

const invalid: Array<[string, (observation: AgentObservation) => void]> = [
  ['unknown observation field', value => Object.assign(value, { inputAllowed: true })],
  ['main arbitrary field', value => Object.assign(value.mainSession!, { inputAllowed: true })],
  ['main unsupported semantic', value => Object.assign(value.mainSession!, { semantic: 'running' })],
  ['main invalid source', value => Object.assign(value.mainSession!, { source: 'title' })],
  ['main invalid time', value => { value.mainSession!.observedAt = -1 }],
  ['main invalid turn identity', value => { value.mainSession!.nativeTurnId = 'other\nturn' }],
  ['invalid observation time', value => { value.observedAt = 1.5 }],
  ['invalid source', value => Object.assign(value, { source: 'title' })],
  ['contradictory current reason', value => { value.reason = 'activity-stale' }],
  ['unbacked historical activity', value => { value.lastKnownActivity = { state: 'working', source: 'native-hook', observedAt: now } }],
  ['child arbitrary field', value => Object.assign(value.subagentSessions!.sessions[0]!, { inputAllowed: true })],
  ['child wrong original Run', value => { value.subagentSessions!.run.runId = 'another-run' }],
  ['child invalid phase', value => Object.assign(value.subagentSessions!.sessions[0]!, { phase: 'paused' })],
  ['child contradictory outcome', value => { value.subagentSessions!.sessions[0]!.outcome = 'completed' }],
  ['child contradictory pending input', value => { value.subagentSessions!.sessions[0]!.waitingFor = 'permission' }],
  ['duplicate child identity', value => { value.subagentSessions!.sessions.push({ ...value.subagentSessions!.sessions[0]! }) }]
]
it.each(invalid)('rejects malformed original observation: %s without altering the Goal or Agent identity', (_name, change) => {
  const value = result(observation(true)), original = structuredClone(value.delegations)
  change(value.responsibility.executions[0]!.observation!)
  expect(() => parse(value)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(value.delegations).toEqual(original)
})
