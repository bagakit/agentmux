import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxRpcService, type AgentMuxRpcCorePort } from '../src/public-rpc-service.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { parseAgentMuxCliInvocation, AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import { AGENTMUX_RPC_NATIVE_METHODS } from '../src/public-rpc.js'
import type { AgentExecutionOperation } from '../src/agent-execution-journal.js'

const method = 'agent.execution.inspect' as const
const key = { bindingId: 'original-binding', streamGeneration: 'original-generation', nativeRequestId: 0 }
const params = { hostId: 'resource-host', ...key }
const context = { principal: { kind: 'user' as const, id: 'original-user' }, transport: 'unix' as const }
const operation: AgentExecutionOperation = { ...key, payloadDigest: 'sha256:' + 'a'.repeat(64), payloadBytes: 71,
  phase: 'unknown', revision: 3, outcome: 'unknown', resultDigest: null, resultBytes: null }
const forbidden = () => { throw new Error('Unrelated Session, Runtime or Host must not be consulted') }
function fixture(result: AgentExecutionOperation | null = operation) {
  const inspect = vi.fn(async () => result), neighbor = vi.fn(forbidden), sessions = vi.fn(forbidden), connect = vi.fn(forbidden)
  const client = { inspectAgentExecutionOperation: inspect, readAgentSessions: sessions, agentSessions: sessions, connect } as unknown as AgentMuxRpcCorePort
  const scopes = [{ hostId: 'resource-host', client }, { hostId: 'neighbor-host', client: { inspectAgentExecutionOperation: neighbor } as unknown as AgentMuxRpcCorePort }]
  const service = new AgentMuxRpcService({ coreClients: () => scopes })
  return { inspect, neighbor, sessions, connect, scopes, service }
}
afterEach(() => vi.restoreAllMocks())

describe('original tool operation public inspection', () => {
  it('uses only the exact Host owner and keeps unknown, completed and missing metadata distinct', async () => {
    const f = fixture()
    expect(await f.service.call(method, params, context)).toEqual(operation)
    expect(f.inspect).toHaveBeenCalledExactlyOnceWith(key)
    expect(f.sessions).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.neighbor).not.toHaveBeenCalled()
    const completed = { ...operation, phase: 'completed' as const, outcome: 'response-recorded' as const, resultDigest: 'sha256:' + 'b'.repeat(64), resultBytes: 103 }
    f.inspect.mockResolvedValueOnce(completed).mockResolvedValueOnce(null)
    expect(await f.service.call(method, params, context)).toEqual(completed)
    expect(await f.service.call(method, params, context)).toBeNull()
    expect(parseRpcNativeResult(method, null, params)).toBeNull()
    expect(await f.service.call(method, params, { ...context, principal: { kind: 'device', id: 'paired-device' } })).toEqual(operation)
  })

  it('preserves JSON ID types and forwards only through the exact configured remote route', async () => {
    const f = fixture(), stringKey = { ...key, nativeRequestId: '0' }
    const forwardRpc = vi.fn(async () => ({ ...operation, ...stringKey }))
    f.scopes[0]!.client.forwardRpc = forwardRpc as unknown as NonNullable<AgentMuxRpcCorePort['forwardRpc']>
    expect(await f.service.call(method, { ...params, ...stringKey }, context)).toEqual({ ...operation, ...stringKey })
    expect(forwardRpc).toHaveBeenCalledExactlyOnceWith(method, { hostId: 'local', ...stringKey }, context)
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.neighbor).not.toHaveBeenCalled()
    await expect(f.service.call(method, { ...params, hostId: 'missing-host' }, context)).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
    f.scopes.push(f.scopes[0]!)
    await expect(f.service.call(method, params, context)).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
    expect(forwardRpc).toHaveBeenCalledTimes(1)
  })

  it('denies anonymous and managed Agent access without broadening existing Agent authority', async () => {
    const f = fixture()
    for (const actor of [{}, { ...context, caller: { agentSessionId: 'original-agent', capability: 'credential' } },
      { principal: { kind: 'user' as const, id: '' } }, { principal: { kind: 'device' as const, id: 'bad\0id' } }]) {
      await expect(f.service.call(method, params, actor)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    }
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
  })

  it('rejects malformed keys, unexpected fields and withdrawn transport authority before owner reads', async () => {
    const f = fixture()
    for (const nativeRequestId of [null, true, {}, [], 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(f.service.call(method, { ...params, nativeRequestId } as typeof params, context)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    }
    for (const bad of [{ ...params, hostId: '' }, { ...params, bindingId: '' }, { ...params, streamGeneration: '' }, { ...params, payload: 'private' }]) {
      await expect(f.service.call(method, bad, context)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    }
    await expect(f.service.call(method, params, { ...context, assertCurrent: async () => { throw new Error('revoked') } })).rejects.toThrow('revoked')
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it('refuses wrong original receipts and any private payload or response bytes at the public boundary', async () => {
    const f = fixture()
    const invalid = [{ ...operation, nativeRequestId: '0' }, { ...operation, bindingId: 'other-binding' }, { ...operation, streamGeneration: 'other-stream' },
      { ...operation, payload: 'private' }, { ...operation, result: 'private' }, { ...operation, revision: 0 },
      { ...operation, phase: 'completed', outcome: 'response-recorded' }, { ...operation, outcome: 'response-recorded' },
      { ...operation, resultDigest: 'sha256:' + 'b'.repeat(64), resultBytes: 1 }]
    for (const receipt of invalid) {
      expect(() => parseRpcNativeResult(method, receipt, params)).toThrow()
      f.inspect.mockResolvedValueOnce(receipt as AgentExecutionOperation)
      await expect(f.service.call(method, params, context)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    }
  })

  it('discovers one executable command and parses JSON request identities without coercion', async () => {
    expect(AGENTMUX_RPC_NATIVE_METHODS[method]).toBe('short')
    expect(AGENTMUX_CLI_COMMANDS.filter(command => command.method === method)).toHaveLength(1)
    const prefix = ['agent', 'execution', 'inspect', '--host', params.hostId, '--binding', key.bindingId, '--generation', key.streamGeneration]
    for (const nativeRequestId of [0, '0', '', 'native/request']) {
      const invocation = await parseAgentMuxCliInvocation([...prefix, '--request-json', JSON.stringify(nativeRequestId)])
      expect(invocation.command.method).toBe(method)
      expect(invocation.params).toEqual({ ...params, nativeRequestId })
    }
    for (const invalid of ['undefined', '{}', 'null', 'true', '0.5', '9007199254740992']) await expect(parseAgentMuxCliInvocation([...prefix, '--request-json', invalid])).rejects.toThrow()
    await expect(parseAgentMuxCliInvocation(prefix)).rejects.toThrow()
    expect(agentMuxCommandHelp('agent.execution')).toContain('amux agent execution inspect')
    expect(agentMuxCommandHelp(method)).toContain('--request-json JSON')
    expect(agentMuxCommandHelp(method)).toContain('never request or response bytes')
    expect(agentMuxModuleSkill('agent')).toContain('amux agent execution inspect')
  })
})
