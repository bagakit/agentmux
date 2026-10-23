import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPSULE_METHODS, type CapsuleCallContext, type CapsuleInspection, type CapsulePort } from '@agentmux/capsule'
import { AgentMuxRpcService, type AgentMuxRpcCorePort } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AGENTMUX_RPC_NATIVE_METHODS, isAgentMuxRpcMethod } from '../src/public-rpc.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { parseCapsuleRpcParams } from '../src/capsule.js'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import { AgentMuxError } from '../src/errors.js'
import { CAPSULE_RUNTIME_METHODS, type CapsuleRuntimeObservation } from '../src/capsule-runtime.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const capsuleId = '123456789ABC', otherId = '23456789ABCD'
const user = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'original-local-user' } }
const inspection: CapsuleInspection = {
  record: { capsuleId, title: 'Original page', revision: 1, storageMode: 'managed', contentRoot: '/capsules/original',
    sourcePath: '/build/original', entry: 'index.html', routing: 'file', mode: 'isolated', theme: 'none',
    port: 43123, createdAt: 1, updatedAt: 1 },
  content: { status: 'available', observedAt: 1 },
  endpoint: { status: 'available', url: 'http://127.0.0.1:43123/', port: 43123, observedAt: 1, instanceId: '4JkN7Q2vR8sW' }, issues: []
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'amux-capsule-core-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}
function port(call: (...args: unknown[]) => Promise<unknown>): CapsulePort { return { call } as CapsulePort }

describe('Capsule public composition', () => {
  it('derives all wire and CLI methods from the domain and Core runtime registries', () => {
    const registry = { ...CAPSULE_METHODS, ...CAPSULE_RUNTIME_METHODS }, methods = Object.keys(registry)
    expect(methods.length).toBeGreaterThan(0)
    expect(AGENTMUX_CLI_COMMANDS.filter(command => command.method.startsWith('capsule.')).map(command => command.method)).toEqual(methods)
    for (const method of methods) {
      expect(isAgentMuxRpcMethod(method)).toBe(true)
      expect(AGENTMUX_RPC_NATIVE_METHODS[method as keyof typeof registry]).toBe(registry[method as keyof typeof registry])
      expect(agentMuxCommandHelp(method)).toContain(`Usage: amux ${method.replaceAll('.', ' ')}`)
    }
    expect(agentMuxModuleSkill('capsule')).toContain('The Capsule owner holds each original page')
    expect(agentMuxModuleSkill('capsule')).toContain('cannot self-author Human')
  })

  it('requires original transport authority before invoking the finite service management owner', async () => {
    const call = vi.fn(async () => { throw new Error('Unauthenticated management must not reach the owner.') })
    const service = new AgentMuxRpcService({ coreClients: () => [], capsuleRuntime: { call } })
    cleanup.push(() => service.dispose())
    await expect(service.call('capsule.runtime.inspect', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call('capsule.runtime.stop', { operationId: 'original-stop', expectedRevision: 2, expectedRun: { runId: 'original-service-run' } }))
      .rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(call).not.toHaveBeenCalled()
  })

  it('forwards exact runtime management identity and validates the original observation over real RPC', async () => {
    const root = await directory(), seen: unknown[] = []
    const observation: CapsuleRuntimeObservation = { revision: 2, desired: 'stopped', phase: 'stopped',
      stateDirectory: join(root, 'capsules'), socketPath: join(root, 'service.sock'), run: { hostId: 'local', runId: 'original-service-run' },
      runtime: null, operation: { operationId: 'original-stop', kind: 'stop', phase: 'confirmed' }, issue: null }
    const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [],
      capsuleRuntime: { call: async (method, input) => { seen.push({ method, input }); return observation } } })
    await server.start(); cleanup.push(() => server.stop())
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    cleanup.push(() => client.dispose())
    const input = { operationId: 'original-stop', expectedRevision: 2, expectedRun: { runId: 'original-service-run' } }
    expect(await client.call('capsule.runtime.stop', input)).toEqual(observation)
    expect(seen).toEqual([{ method: 'capsule.runtime.stop', input }])
    await expect(client.call('capsule.runtime.stop', { ...input, authorHuman: true } as typeof input)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(seen).toHaveLength(1)
  })

  it('uses the original strict schema and standard wire error for malformed targets or authored authority', () => {
    for (const params of [{ capsuleId }, { capsuleId, operationId: 'original', authorHuman: true }, { capsuleId, operationId: 'original', caller: { agentSessionId: 'forged' } }]) {
      expect(() => parseCapsuleRpcParams('capsule.open', params)).toThrow()
      try { parseCapsuleRpcParams('capsule.open', params) } catch (error) { expect(error).toMatchObject({ code: 'INVALID_CONTROL_REQUEST' }) }
    }
    expect(parseCapsuleRpcParams('capsule.open', { capsuleId, operationId: 'original' })).toEqual({ capsuleId, operationId: 'original' })
  })

  it('rejects another owner target on both service and client result boundaries', async () => {
    const wrong = { ...inspection, record: { ...inspection.record, capsuleId: otherId } }
    const service = new AgentMuxRpcService({ coreClients: () => [], capsules: port(async () => wrong) })
    cleanup.push(() => service.dispose())
    const outcome = await service.call('capsule.inspect', { capsuleId }, user).then(result => ({ result, error: null }), error => ({ result: null, error }))
    expect(outcome.error).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(() => parseRpcNativeResult('capsule.inspect', wrong, { capsuleId })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })

  it('passes authenticated caller separately from producer-declared source', async () => {
    const authorizeRetainedAgentCaller = vi.fn(async () => ({ agentSessionId: 'original-session', hostId: 'local' }))
    const core = { authorizeRetainedAgentCaller } as unknown as AgentMuxRpcCorePort
    const call = vi.fn(async (_method: unknown, params: unknown, context: unknown) => {
      expect(params).toMatchObject({ source: { agentSessionId: 'declared-other', toolId: 'declared-tool', executionId: 'declared-execution' } })
      expect(context).toMatchObject({ caller: { hostId: 'local', agentSessionId: 'original-session' } })
      return { ...inspection, operationId: 'original-create', status: 'committed' }
    })
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: core }], capsules: port(call) })
    cleanup.push(() => service.dispose())
    await service.call('capsule.create', { operationId: 'original-create', sourcePath: '/build/original',
      source: { agentSessionId: 'declared-other', toolId: 'declared-tool', executionId: 'declared-execution' } },
    { ...user, caller: { agentSessionId: 'original-session', capability: 'original-capability' } })
    expect(authorizeRetainedAgentCaller).toHaveBeenCalledWith('original-capability', 'original-session')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('refuses managed Human attribution before touching the reply owner', async () => {
    const call = vi.fn(async () => { throw new Error('reply owner must not be called') })
    const core = { authorizeRetainedAgentCaller: async () => ({ agentSessionId: 'original-session', hostId: 'local' }) } as unknown as AgentMuxRpcCorePort
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: core }], capsules: port(call) })
    cleanup.push(() => service.dispose())
    await expect(service.call('capsule.interaction.reply', { capsuleId, interactionId: otherId, operationId: 'original-answer', expectedRevision: 1, answer: 'Original answer' },
      { ...user, caller: { agentSessionId: 'original-session', capability: 'original-capability' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(call).not.toHaveBeenCalled()
  })

  it('requires transport authority and forwards the original complete operation unchanged', async () => {
    const forwardControl = vi.fn(async () => ({ operationId: 'original-open', capsuleId, endpoint: inspection.endpoint,
      rendering: { status: 'unavailable', reason: 'Original presentation owner is unavailable.' } }))
    const service = new AgentMuxRpcService({ coreClients: () => [], forwardControl: forwardControl as never })
    cleanup.push(() => service.dispose())
    const input = { capsuleId, operationId: 'original-open', placement: { destination: { kind: 'launcher', regionId: 'original-region' } } }
    await expect(service.call('capsule.open', input)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(forwardControl).not.toHaveBeenCalled()
    expect(await service.call('capsule.open', input, user)).toEqual(await forwardControl.mock.results[0]!.value)
    expect(forwardControl).toHaveBeenCalledExactlyOnceWith('capsule.open', input, user)
  })

  it('keeps original input-owner refusal instead of turning saved answers into trusted Human input', async () => {
    const service = new AgentMuxRpcService({ coreClients: () => [], capsules: port(async (_method, _input, context) => {
      expect(context).toMatchObject({ principal: user.principal })
      throw new AgentMuxError('The original trusted input owner is unavailable; draft retained.', 'CAPSULE_INPUT_UNAVAILABLE')
    }) })
    cleanup.push(() => service.dispose())
    await expect(service.call('capsule.interaction.reply', { capsuleId, interactionId: otherId, operationId: 'original-answer', expectedRevision: 1, answer: 'Original answer' }, user))
      .rejects.toMatchObject({ code: 'CAPSULE_INPUT_UNAVAILABLE' })
  })

  it('uses real RPC dispatch for original content and unavailable presentation, without creating another operation', async () => {
    const root = await directory(), seen: Array<{ method: string; input: unknown; context?: CapsuleCallContext }> = []
    const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [], capsules: port(async (method, input, context) => {
      seen.push({ method: method as string, input, context: context as CapsuleCallContext })
      if (method === 'capsule.inspect') return inspection
      if (method === 'capsule.open') return { capsuleId, operationId: 'original-open', endpoint: inspection.endpoint,
        rendering: { status: 'unavailable', reason: 'No Desktop presentation owner is mounted.' } }
      throw new AgentMuxError('Unexpected method.', 'CONTROL_UNAVAILABLE')
    }) })
    await server.start(); cleanup.push(() => server.stop())
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    cleanup.push(() => client.dispose())
    expect(await client.call('capsule.inspect', { capsuleId })).toEqual(inspection)
    expect(await client.call('capsule.open', { capsuleId, operationId: 'original-open' })).toMatchObject({ capsuleId, operationId: 'original-open', rendering: { status: 'unavailable' } })
    expect(seen.map(call => call.method)).toEqual(['capsule.inspect', 'capsule.open'])
    expect(seen[1]).toMatchObject({ input: { capsuleId, operationId: 'original-open' }, context: { principal: { kind: 'user' } } })
  })

  it('prints offline compiled guidance and parses original JSON without creating state', async () => {
    const root = await directory(), env = objectCliEnvironment(root)
    const run = (args: string[]) => runCompiledObjectCli(args, env)
    const guide = await run(['capsule', '--skill'])
    expect(guide.code, guide.stderr).toBe(0); expect(guide.stdout).toContain('The Capsule owner holds each original page')
    const help = await run(['capsule', 'open', '--help'])
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('Usage: amux capsule open --input <FILE|->')
    expect(await readdir(root)).toEqual([])
    const input = { capsuleId, operationId: 'original-open' }, file = join(root, 'open.json')
    await writeFile(file, JSON.stringify(input))
    const parsed = await parseAgentMuxCliInvocation(['capsule', 'open', '--input', file])
    expect(parsed.params).toEqual(input)
    await expect(parseAgentMuxCliInvocation(['capsule', 'open'])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
    await writeFile(file, JSON.stringify({ ...input, authorHuman: true }))
    await expect(parseAgentMuxCliInvocation(['capsule', 'open', '--input', file])).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  })
})
