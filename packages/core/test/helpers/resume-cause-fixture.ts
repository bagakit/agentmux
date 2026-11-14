import { expect } from 'vitest'
import { fixture, otherRuntime } from './prepared-resume-fixture.js'
import { AgentMuxRpcService } from '../../src/public-rpc-service.js'
import { parseRpcNativeResult } from '../../src/rpc-native-codec.js'

/** Real private file owner + two Runtime endpoints; no user Session or Provider profile. */
export async function pendingResumeCause() {
  const f = await fixture(), second = await otherRuntime(f)
  const originalSocket = f.inner.kernel.socketPath
  f.inner.kernel.disconnect()
  Object.defineProperty(f.inner.kernel, 'socketPath', { value: second.socketPath, configurable: true })
  await f.inner.kernel.connect()
  const input = { ...f.request, trigger: 'manual' as const, expectedRun: f.previous.run,
    policy: { recheckMaxAttempts: 0 } }
  const result = await f.client.ensureAgentContinuity(input)
  expect(result).toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed' })
  const saved = (await f.store.readMetadata(f.previous.agentSessionId))!
  f.inner.kernel.disconnect()
  Object.defineProperty(f.inner.kernel, 'socketPath', { value: originalSocket, configurable: true })
  await f.client.dispose()
  const reader = await f.reader()
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: reader.client }] })
  const params = { target: { kind: 'agent-session' as const, agentSessionId: f.previous.agentSessionId } }
  const response = await service.call('agent.inspect', params)
  const decoded = parseRpcNativeResult('agent.inspect', JSON.parse(JSON.stringify(response)), params) as typeof response
  return { ...f, result, saved, reader, decoded }
}
