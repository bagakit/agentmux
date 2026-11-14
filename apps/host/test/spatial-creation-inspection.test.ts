import { afterEach, expect, it, vi } from 'vitest'
import { nonSessionCreation } from './helpers/non-session-creation.js'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); cleanup.push(f.close)
  const runtime = { runtimeId: 'spatial-runtime', instanceId: 'spatial-instance', buildIdentity: 'controlled-runtime', protocolVersion: 1 }
  f.h.inner.kernel.creationRuntimeIdentity = () => runtime
  f.h.inner.kernel.startPrepared = vi.fn(async (request, operationKey) => f.h.inner.kernel.start({ ...request, operationKey }))
  f.h.inner.kernel.inspectPreparedStart = vi.fn(async () => null)
  f.h.inner.hookServer.createBinding = (_sessionId: string, _providerId: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  return f
}

it.each(['prepared-agent-creation', 'closed-agent-creation'] as const)('public spatial inspection retains %s without settling or replaying its original creation', async kind => {
  const f = await fixture()
  const operationId = 'original-spatial-creation'
  const opened = await f.start(operationId, 'Original Query kept until binding')
  expect(opened.outcome, JSON.stringify(opened.issues)).toBe('opened')
  const session = await f.h.client.inspectAgentCreation(opened.agent!.agentSessionId)
  if (session.kind !== 'agent' || !session.creation) throw Error('The original fixture must create its exact Session')
  const before = await f.spatial.read(), starts = f.h.started.length, writes = f.h.inner.kernel.input.mock.calls.length
  const settle = vi.spyOn(f.spatial, 'settleAgentOpen')
  const pending = nonSessionCreation(kind, { ...session, createOperationId: operationId, runId: session.run.runId })
  const inspection = vi.spyOn(f.h.client, 'inspectAgentCreation').mockResolvedValue(pending)
  const result = await f.rpc.call('space.inspect', { target: { operationId } })
  expect(result.request?.report).toMatchObject({ outcome: 'unknown', agent: null,
    issues: [expect.objectContaining({ code: 'AGENT_CREATION_UNCONFIRMED' })] })
  expect(settle).not.toHaveBeenCalled()
  expect(await f.spatial.read()).toEqual(before)
  expect(f.h.started).toHaveLength(starts); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  inspection.mockRestore()
  const continued = await f.rpc.call('space.inspect', { target: { operationId } })
  expect(continued.request?.report).toMatchObject({ outcome: 'opened', agent: { agentSessionId: session.agentSessionId } })
  expect(settle).toHaveBeenCalledOnce()
  expect(f.h.started).toHaveLength(starts); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes)
}, 45000)
