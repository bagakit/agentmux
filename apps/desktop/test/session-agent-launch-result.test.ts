import { expect, it } from 'vitest'
import { sessionAgentLaunchResult, unwrapSessionAgentLaunchResult, unconfirmedSessionAgentLaunch } from '../src/shared/session-agent-launch-result'
import type { AgentLaunchResult } from '../src/shared/contracts'

const input = { agentSessionId: 'original-session', createOperationId: 'original-operation' }
it.each(['not_applied', 'unknown'] as const)('preserves an authoritative %s outcome as cloneable launch data', async disposition => {
  const error = Object.assign(new Error('Owner launch outcome'), { code: 'OWNER_RESULT', detail: 'owner detail', controlFailure: { disposition, confirmedInputBytes: null } })
  const carrier = structuredClone(await sessionAgentLaunchResult(input, async () => { throw error }))
  expect(carrier).toMatchObject({ ok: false, error: { ...input, code: 'OWNER_RESULT', detail: 'owner detail', controlFailure: { disposition, confirmedInputBytes: null } } })
  expect(() => unwrapSessionAgentLaunchResult(carrier)).toThrow(expect.objectContaining({ ...input, code: 'OWNER_RESULT', controlFailure: { disposition, confirmedInputBytes: null } }))
})
it('a generic Main failure and a missing transport receipt remain unknown and retain the original identity', async () => {
  const error = Object.assign(new Error('Channel closed'), { code: 'CONTROL_UNAVAILABLE', controlFailure: { disposition: 'not_applied', confirmedInputBytes: null },
    agentSessionId: 'untrusted-transport-sid', createOperationId: 'untrusted-transport-operation' })
  expect(unconfirmedSessionAgentLaunch(input, error)).toMatchObject({ ...input, code: 'AGENT_CREATION_UNCONFIRMED', controlFailure: { disposition: 'unknown' } })
  const stripped = new Error(error.message)
  expect(unconfirmedSessionAgentLaunch(input, stripped)).toMatchObject({ ...input, code: 'AGENT_CREATION_UNCONFIRMED', controlFailure: { disposition: 'unknown' } })
  const carrier = structuredClone(await sessionAgentLaunchResult(input, async () => { throw stripped }))
  expect(carrier).toMatchObject({ ok: false, error: { ...input, controlFailure: { disposition: 'unknown' } } })
})
it('successful launch unwraps the original result rather than exposing a transport envelope to consumers', async () => {
  const result = { created: { agentSessionId: input.agentSessionId, run: { runId: 'actual-run' } }, projectionFailures: [] } as unknown as AgentLaunchResult
  const carrier = structuredClone(await sessionAgentLaunchResult(input, async () => result))
  expect(unwrapSessionAgentLaunchResult(carrier)).toEqual(result)
})
