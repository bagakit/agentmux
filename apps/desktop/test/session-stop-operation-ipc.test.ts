// @vitest-environment happy-dom
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { expect, it, vi } from 'vitest'
import { AgentMuxError, type AgentMuxAgentStopInspection, type AgentMuxAgentStopReceipt } from '@agentmux/core'
import type { DesktopRuntimeClient } from '../src/main/desktop-host'
import { unwrapSessionStopReply } from '../src/shared/session-stop-result'
import { unwrapSessionObservationResult } from '../src/shared/session-observation-result'

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

it('Stop inspection crosses the actual preload and registered IPC with the original Run and operation, without lifecycle or connection effects', async () => {
  const { client, dispose, runtime } = await owningBridge()
  const inspection: AgentMuxAgentStopInspection = { agentSessionId: control.agentSessionId, expectedRun: control.run,
    phase: 'stopping', canRetry: true, operationIdMatched: true, lifecycleOperationId: 'original-reservation', observedAt: 17,
    failure: { stage: 'runtime-stop', code: 'CTXMUX_TIMEOUT', message: 'The original stop is unconfirmed.', observedAt: 16 } }
  const { stopAgent, inspectAgentStop } = withStop(client, vi.fn(), vi.fn(async () => inspection))
  const connections = client as { connect: ReturnType<typeof vi.fn>; connectRuntime: ReturnType<typeof vi.fn> }
  connections.connect.mockRejectedValue(new Error('Inspection must not prepare semantic recovery.'))
  connections.connectRuntime.mockRejectedValue(new Error('Inspection must not prepare Native.'))
  const forget = vi.spyOn(runtime as unknown as { forgetSessionAttachmentOwner(key: string): void }, 'forgetSessionAttachmentOwner')
  const progress = vi.spyOn(runtime, 'callOriginalCore')
  try {
    const reply = await bridge.api!.sessions.inspectStop(control, 'original-stop')
    expect(unwrapSessionObservationResult(reply)).toEqual(inspection)
    expect(bridge.invoke).toHaveBeenLastCalledWith('sessions:inspectStop', control, 'original-stop')
    expect(inspectAgentStop).toHaveBeenCalledExactlyOnceWith({ agentSessionId: control.agentSessionId,
      expectedRun: control.run, operationId: 'original-stop' })
    expect(stopAgent).not.toHaveBeenCalled()
    expect(connections.connect).not.toHaveBeenCalled()
    expect(connections.connectRuntime).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
  } finally { forget.mockRestore(); progress.mockRestore(); await dispose() }
})

it('Stop inspection routes the exact Host even when another Host has the same Session id', async () => {
  const { client, dispose, runtime } = await owningBridge()
  const localInspect = vi.fn(async () => { throw new Error('Wrong Host was read.') })
  Object.assign(client, { inspectAgentStop: localInspect })
  const expected: AgentMuxAgentStopInspection = { agentSessionId: control.agentSessionId, expectedRun: control.run,
    phase: 'retired', canRetry: false, operationIdMatched: false, retiredAt: 19, observedAt: 20 }
  const remoteInspect = vi.fn(async () => expected)
  const remote = { ...client, inspectAgentStop: remoteInspect, dispose: vi.fn().mockResolvedValue(undefined) }
  runtime.commit({ hosts: [{ id: 'original-host', client: remote as unknown as DesktopRuntimeClient,
    executionHost: { kind: 'local', dispose: vi.fn() } as never,
    config: { id: 'original-host', kind: 'local', label: 'Original Host' } }],
    removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const original = { ...control, hostId: 'original-host' }
  try {
    expect(unwrapSessionObservationResult(await bridge.api!.sessions.inspectStop(original, 'retained-operation'))).toEqual(expected)
    expect(remoteInspect).toHaveBeenCalledExactlyOnceWith({ agentSessionId: control.agentSessionId,
      expectedRun: control.run, operationId: 'retained-operation' })
    expect(localInspect).not.toHaveBeenCalled()
  } finally { await dispose() }
})

it('a Stop inspection failure retains its typed cause and cannot dispatch or retry Stop', async () => {
  const { client, dispose } = await owningBridge()
  const { stopAgent, inspectAgentStop } = withStop(client, vi.fn(), vi.fn(async () => {
    throw Object.assign(new Error('Original Stop rows are unavailable.'), { code: 'STOP_STORE_UNAVAILABLE', detail: 'original-store-read' })
  }))
  try {
    const reply = await bridge.api!.sessions.inspectStop(control, 'unconfirmed-stop')
    expect(reply).toEqual({ ok: false, error: { code: 'STOP_STORE_UNAVAILABLE', message: 'Original Stop rows are unavailable.', detail: 'original-store-read' } })
    expect(() => unwrapSessionObservationResult(reply)).toThrow(expect.objectContaining({
      code: 'STOP_STORE_UNAVAILABLE', detail: 'original-store-read'
    }))
    expect(inspectAgentStop).toHaveBeenCalledExactlyOnceWith({ agentSessionId: control.agentSessionId,
      expectedRun: control.run, operationId: 'unconfirmed-stop' })
    expect(stopAgent).not.toHaveBeenCalled()
  } finally { await dispose() }
})
