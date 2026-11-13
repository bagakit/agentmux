// @vitest-environment happy-dom
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { expect, it, vi } from 'vitest'
import { AgentMuxError, type AgentMuxAgentStopReceipt } from '@agentmux/core'
import { unwrapSessionStopReply } from '../src/shared/session-stop-result'

const receipt = (operationId: string): AgentMuxAgentStopReceipt => ({ agentSessionId: control.agentSessionId, expectedRun: { ...control.run },
  operationId, lifecycleOperationId: `stop-${operationId}`, admission: 'new', runtime: { observed: 'running', stop: 'graceful' }, retiredAt: 7,
  stages: [{ stage: 'admission', startedAt: 1, endedAt: 1, outcome: 'ok' }, { stage: 'runtime-stop', startedAt: 2, endedAt: 3, outcome: 'ok' }] })

function withStop(client: object, stopAgent: ReturnType<typeof vi.fn>, inspectAgentStop = vi.fn()) {
  Object.assign(client, { stopAgent, inspectAgentStop })
  return { stopAgent, inspectAgentStop }
}

it('actual preload, registered IPC and Main carry the caller operation id to Core and return its receipt', async () => {
  const { client, dispose } = await owningBridge()
  const { stopAgent } = withStop(client, vi.fn(async (_id: string, _run: unknown, options: { operationId?: string }) => receipt(options.operationId!)))
  try {
    const reply = await bridge.api!.sessions.stop(control, 'one-stop-intent')
    expect(stopAgent).toHaveBeenCalledExactlyOnceWith(control.agentSessionId, control.run, { operationId: 'one-stop-intent' })
    expect(unwrapSessionStopReply(reply)).toEqual(receipt('one-stop-intent'))
  } finally { await dispose() }
})

it('a failed Agent Stop keeps the Core code, the same operation and the stage Core recorded for it', async () => {
  const { client, dispose } = await owningBridge()
  const { stopAgent, inspectAgentStop } = withStop(client,
    vi.fn(async () => { throw new AgentMuxError('Runtime did not answer the stop frame.', 'CTXMUX_TIMEOUT') }),
    vi.fn(async () => ({ agentSessionId: control.agentSessionId, expectedRun: control.run, phase: 'stopping', canRetry: true, operationIdMatched: true,
      failure: { stage: 'runtime-stop', code: 'CTXMUX_TIMEOUT', message: 'Runtime did not answer the stop frame.', observedAt: 9 }, observedAt: 9 })))
  try {
    const reply = await bridge.api!.sessions.stop(control, 'one-stop-intent')
    expect(reply).toEqual({ ok: false, error: { code: 'CTXMUX_TIMEOUT', message: 'Runtime did not answer the stop frame.',
      operationId: 'one-stop-intent', stage: 'runtime-stop' } })
    expect(inspectAgentStop).toHaveBeenCalledExactlyOnceWith({ agentSessionId: control.agentSessionId, expectedRun: control.run, operationId: 'one-stop-intent' })
    // The retry is the same operation, so Core continues that Stop.
    stopAgent.mockResolvedValueOnce(receipt('one-stop-intent'))
    expect(unwrapSessionStopReply(await bridge.api!.sessions.stop(control, 'one-stop-intent'))?.operationId).toBe('one-stop-intent')
    expect(stopAgent.mock.calls.map(call => call[2])).toEqual([{ operationId: 'one-stop-intent' }, { operationId: 'one-stop-intent' }])
  } finally { await dispose() }
})

it('a stale Run keeps Core’s STALE_AGENT_SESSION code; a failed inspect leaves the original error', async () => {
  const { client, dispose } = await owningBridge()
  withStop(client, vi.fn(async () => { throw new AgentMuxError('Agent Session changed before its Run was stopped.', 'STALE_AGENT_SESSION') }),
    vi.fn(async () => { throw new Error('inspect unavailable') }))
  try {
    expect(await bridge.api!.sessions.stop(control, 'stale-intent')).toEqual({ ok: false, error: { code: 'STALE_AGENT_SESSION',
      message: 'Agent Session changed before its Run was stopped.', operationId: 'stale-intent' } })
  } finally { await dispose() }
})

it('another operation’s recorded failure is not reported as this Stop’s stage', async () => {
  const { client, dispose } = await owningBridge()
  withStop(client, vi.fn(async () => { throw new AgentMuxError('Busy.', 'AGENT_STOP_FAILED') }),
    vi.fn(async () => ({ agentSessionId: control.agentSessionId, expectedRun: control.run, phase: 'stopping', canRetry: true, operationIdMatched: false,
      failure: { stage: 'runtime-observe', code: 'X', message: 'other', observedAt: 1 }, observedAt: 1 })))
  try {
    const reply = await bridge.api!.sessions.stop(control, 'mine')
    expect(reply.ok === false && reply.error).toEqual({ code: 'AGENT_STOP_FAILED', message: 'Busy.', operationId: 'mine' })
  } finally { await dispose() }
})
