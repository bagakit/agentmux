import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { describe, expect, it, vi } from 'vitest'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import { parseRpcControlResult, rpcControlRequest } from '../src/rpc-business-codec.js'
import { isBackgroundLocalAgentOpen, spatialAgentFact } from '../src/spatial-agent-open-contract.js'
import { AgentMuxRpcService, type AgentMuxRpcCallContext, type AgentMuxRpcServiceOptions } from '../src/public-rpc-service.js'

const content = { kind: 'new-agent' as const, executorId: 'agent-executor', executionWorkspaceId: 'agent-workspace', toolWorkspaceId: 'resource-workspace', prompt: 'Original task\n unchanged' }
const input = { operationId: 'original-open', content, destination: { spaceId: 'space', zoneId: 'zone', newTab: true as const }, focus: false }
const session = { agentSessionId: 'original-session', run: { runId: 'agent-run' }, providerId: 'provider', executorId: content.executorId,
  workspacePath: '/agent/launch', toolExecution: { bindingId: 'original-binding', resourceHostId: 'resource-host', resourceRuntimeId: 'resource-core', workspacePath: '/resource/project' } }
const context = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'original-user' } }
const receipt = () => ({ operationId: input.operationId, outcome: 'opened', from: null, to: null, agent: spatialAgentFact(session, 'agent-host'),
  resource: null, save: { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null }, issues: [] })

describe('public agent.open with exact tool Workspace', () => {
  it('carries both independent Workspace references through the actual CLI and Control DTO', async () => {
    const invocation = await parseAgentMuxCliInvocation(['agent', 'open', '--executor', content.executorId,
      '--execution-workspace', content.executionWorkspaceId, '--tool-workspace', content.toolWorkspaceId,
      '--space', 'space', '--zone', 'zone', '--new-tab', '--prompt', content.prompt, '--operation-id', input.operationId])
    expect(invocation.command.method).toBe('agent.open')
    expect(invocation.params).toEqual(input)
    expect(rpcControlRequest('agent.open', invocation.params)).toMatchObject({ requestId: input.operationId, content, destination: input.destination })
    expect(agentMuxCommandHelp('agent.open')).toContain('--tool-workspace')
    expect(agentMuxCommandHelp('agent.open')).toContain('transport-approved user/device')
    expect(agentMuxModuleSkill('agent')).toContain('--tool-workspace')
    expect(agentMuxModuleSkill('space')).toContain('toolExecution')
  })

  it('delivers the CLI DTO through the real Unix RPC boundary and validates its original tool receipt', async () => {
    const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'amx-open-'))
    const seen: unknown[] = []
    const owner = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [], execute: async request => {
      seen.push(request)
      if (request.operation !== 'agent.open') throw new Error('Wrong operation owner')
      const { operationId: _operation, ...body } = receipt()
      return { operation: request.operation, requestId: request.requestId, ...body, outcome: 'opened', save: { ...body.save, diskDurability: 'unconfirmed' } }
    } })
    await owner.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: owner.path } })
    try {
      const invocation = await parseAgentMuxCliInvocation(['agent', 'open', '--executor', content.executorId,
        '--execution-workspace', content.executionWorkspaceId, '--tool-workspace', content.toolWorkspaceId,
        '--space', 'space', '--zone', 'zone', '--new-tab', '--prompt', content.prompt, '--operation-id', input.operationId])
      const result = await client.call('agent.open', invocation.params as typeof input)
      expect(result.agent).toEqual(spatialAgentFact(session, 'agent-host'))
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ operation: 'agent.open', requestId: input.operationId, content, destination: input.destination })
    } finally { await client.dispose(); await owner.stop(); await rm(root, { recursive: true, force: true }) }
  })

  it('rejects ambiguous execution, existing Session, native resume, fork and new Zone in both input carriers', async () => {
    for (const args of [ ['--executor', 'x'], ['--session', 'existing', '--execution-workspace', 'agent-workspace'],
      ['--fork-from', 'source', '--fork-source', '/must-not-read', '--execution-workspace', 'agent-workspace'],
      ['--executor', 'x', '--execution-workspace', 'agent-workspace', '--native-source', '/must-not-read'],
      ['--executor', 'x', '--execution-workspace', 'agent-workspace', '--new-zone', '--project', 'p', '--directory', '/new'] ]) {
      await expect(parseAgentMuxCliInvocation(['agent', 'open', ...args, '--tool-workspace', 'resource-workspace', '--region', 'region'])).rejects.toThrow()
    }
    const { executionWorkspaceId: _execution, ...withoutExecution } = content
    for (const invalid of [withoutExecution, { ...content, toolWorkspaceId: '' }, { ...content, nativeResumeSource: {} },
      { kind: 'agent-session', agentSessionId: 'original-session', toolWorkspaceId: content.toolWorkspaceId },
      { kind: 'fork-agent', source: {}, toolWorkspaceId: content.toolWorkspaceId }])
      expect(() => rpcControlRequest('agent.open', { ...input, content: invalid })).toThrow()
    expect(() => rpcControlRequest('agent.open', { ...input, destination: { spaceId: 'space', newZone: { kind: 'directory', projectId: 'p', path: '/new' } } })).toThrow()
  })

  it('never admits a tool selection to the background local shortcut, even before DTO validation', () => {
    const request = rpcControlRequest('agent.open', input)
    expect(isBackgroundLocalAgentOpen(request)).toBe(false)
    const { executionWorkspaceId: _execution, ...toolOnly } = content
    expect(isBackgroundLocalAgentOpen({ ...request, content: toolOnly })).toBe(false)
    const { toolWorkspaceId: _tool, ...ordinary } = toolOnly
    expect(isBackgroundLocalAgentOpen({ ...request, content: ordinary })).toBe(true)
  })

  it('preserves original Session tool identity separately from Agent cwd in strict spatial receipts', () => {
    const fact = spatialAgentFact(session, 'agent-host')
    expect(fact).toMatchObject({ agentSessionId: session.agentSessionId, runId: session.run.runId, hostId: 'agent-host', cwd: '/agent/launch', toolExecution: session.toolExecution })
    expect(fact.toolExecution).not.toBe(session.toolExecution)
    const parsed = parseRpcControlResult('agent.open', receipt(), input)
    expect(parsed.agent).toEqual(fact)
    for (const bad of [{ ...receipt().agent, toolExecution: undefined }, { ...receipt().agent, toolExecution: { ...session.toolExecution, privateUrl: 'secret' } },
      { ...receipt().agent, toolExecution: { ...session.toolExecution, resourceRuntimeId: '' } }])
      expect(() => parseRpcControlResult('agent.open', { ...receipt(), agent: bad }, input)).toThrow()
    const { toolWorkspaceId: _tool, ...ordinary } = content
    const { toolExecution: _binding, ...ordinaryFact } = fact
    expect(parseRpcControlResult('agent.open', { ...receipt(), agent: ordinaryFact }, { ...input, content: ordinary }).agent).toEqual(ordinaryFact)
  })

  it('denies wrong transport context before forwarding or consulting any Agent, and keeps ordinary open available', async () => {
    const forward = vi.fn(async () => receipt()), coreClients = vi.fn(() => { throw new Error('No caller scan may authorize resource access') })
    const service = new AgentMuxRpcService({ forwardControl: forward as NonNullable<AgentMuxRpcServiceOptions['forwardControl']>, coreClients })
    for (const denied of [{}, { ...context, caller: { agentSessionId: 'managed-agent', capability: 'capability' } },
      { principal: { kind: 'user', id: '' } }, { principal: { kind: 'device', id: 'bad\0id' } },
      { principal: { kind: 'agent', id: 'agent' } }]) {
      await expect(service.call('agent.open', input, denied as AgentMuxRpcCallContext)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    }
    expect(forward).not.toHaveBeenCalled(); expect(coreClients).not.toHaveBeenCalled()
    const { toolWorkspaceId: _tool, ...ordinary } = content
    await expect(service.call('agent.open', { ...input, content: ordinary }, {})).resolves.toEqual(receipt())
    expect(forward).toHaveBeenCalledTimes(1)
  })

  it('passes the original approved user/device context to the presentation owner and rejects revoked authorization', async () => {
    const forward = vi.fn(async () => receipt()), local = vi.fn(async () => { throw new Error('Tool mode cannot use local shortcut') })
    const service = new AgentMuxRpcService({ forwardControl: forward as NonNullable<AgentMuxRpcServiceOptions['forwardControl']>, callOriginalCore: local })
    for (const kind of ['user', 'device'] as const) {
      const original = { ...context, principal: { kind, id: 'approved-original' } }
      await expect(service.call('agent.open', input, original)).resolves.toEqual(receipt())
      expect(forward).toHaveBeenLastCalledWith('agent.open', input, original)
    }
    await expect(service.call('agent.open', input, { ...context, assertCurrent: async () => { throw new Error('Original authority revoked') } })).rejects.toThrow('Original authority revoked')
    expect(forward).toHaveBeenCalledTimes(2); expect(local).not.toHaveBeenCalled()
  })
})
