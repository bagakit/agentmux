import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentExecutionCreate, parseAgentExecutionBinding, parseAgentExecutionInspection } from '../src/public-rpc-agent-execution.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import type { AgentExecutionInspection, AgentExecutionOpenInput } from '../src/agent-execution-coordinator.js'
import type { AgentMuxAgentSession } from '../src/types.js'

const input: AgentExecutionOpenInput = { bindingId: 'original-binding', agentHostId: 'agent-host', agentRuntimeId: 'agent-core',
  resourceHostId: 'resource-host', resourceRuntimeId: 'resource-core', resourceWorkspacePath: '/resource/project',
  resourceGrant: { scope: 'host-user', bindingId: 'original-binding' }, agent: { agentSessionId: 'original-session', createOperationId: 'original-create',
    executorId: 'configured-executor', executorRevision: 'a'.repeat(64), workspacePath: '/agent/launch', prompt: '原文\n  exact  ', launchOptions: {} } }
const original = { bindingId: input.bindingId, agentSessionId: input.agent.agentSessionId, createOperationId: input.agent.createOperationId }
const inspection: AgentExecutionInspection = { continuation: original, bindingId: input.bindingId, agentHostId: input.agentHostId, resourceHostId: input.resourceHostId,
  agentSessionId: input.agent.agentSessionId, resourceWorkspacePath: input.resourceWorkspacePath, state: 'connected' }
const session: AgentMuxAgentSession = { kind: 'agent', agentSessionId: input.agent.agentSessionId, executorId: input.agent.executorId, providerId: 'fixture-provider', hostId: 'local',
  run: { runId: 'original-agent-run' }, retiredRuns: [], workspacePath: input.agent.workspacePath, createdAt: 1, updatedAt: 1,
  creation: { createOperationId: input.agent.createOperationId, initialPrompt: 'confirmed', intentDigest: 'b'.repeat(64), executorRevision: input.agent.executorRevision },
  toolExecution: { bindingId: input.bindingId, resourceHostId: input.resourceHostId, resourceRuntimeId: input.resourceRuntimeId, workspacePath: input.resourceWorkspacePath } }
const context = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'transport-user' } }
const key = { bindingId: input.bindingId }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const owner = { create: vi.fn(async (_input: AgentExecutionOpenInput) => ({ session: structuredClone(session), execution: structuredClone(inspection) })),
    continueOriginal: vi.fn(async () => ({ session: structuredClone(session), execution: structuredClone(inspection) })),
    inspect: vi.fn(async (): Promise<AgentExecutionInspection | null> => structuredClone(inspection)), rejoin: vi.fn(async () => structuredClone(inspection)) }
  const coreClients = vi.fn(() => { throw new Error('Coordinator routing must not scan Session clients') })
  return { owner, coreClients, service: new AgentMuxRpcService({ executionBindings: owner, coreClients }) }
}

describe('public execution binding owner', () => {
  it('calls exactly the original coordinator methods, preserves authored input, and awaits lazy inspection', async () => {
    const f = fixture()
    expect(await f.service.call('agent.execution.create', input, context)).toEqual({ session, execution: inspection })
    expect(f.owner.create).toHaveBeenCalledExactlyOnceWith(input, context)
    expect(await f.service.call('agent.execution.continue', original, context)).toEqual({ session, execution: inspection })
    expect(f.owner.continueOriginal).toHaveBeenCalledExactlyOnceWith(original, context)
    expect(await f.service.call('agent.execution.binding', key, context)).toEqual(inspection)
    expect(f.owner.inspect).toHaveBeenCalledExactlyOnceWith(input.bindingId, undefined, context)
    expect(await f.service.call('agent.execution.rejoin', key, context)).toEqual(inspection)
    expect(f.owner.rejoin).toHaveBeenCalledExactlyOnceWith(input.bindingId, context, false)
    expect(f.coreClients).not.toHaveBeenCalled()
    expect(f.owner.create.mock.calls[0]![0]).not.toBe(input)
    expect(parseAgentExecutionCreate(input)).toEqual(input)
  })

  it('accepts either Host orientation as explicit input without granting reverse authorization', async () => {
    const f = fixture(), reverse = { ...input, bindingId: 'reverse-binding', resourceGrant: { scope: 'host-user' as const, bindingId: 'reverse-binding' },
      agentHostId: input.resourceHostId, agentRuntimeId: input.resourceRuntimeId, resourceHostId: input.agentHostId, resourceRuntimeId: input.agentRuntimeId }
    const reverseSession = { ...session, toolExecution: { ...session.toolExecution!, bindingId: reverse.bindingId, resourceHostId: reverse.resourceHostId, resourceRuntimeId: reverse.resourceRuntimeId } }
    const reverseInspection = { ...inspection, continuation: { ...original, bindingId: reverse.bindingId }, bindingId: reverse.bindingId, agentHostId: reverse.agentHostId, resourceHostId: reverse.resourceHostId }
    f.owner.create.mockResolvedValueOnce({ session: reverseSession, execution: reverseInspection })
    expect(await f.service.call('agent.execution.create', reverse, { ...context, principal: { kind: 'device', id: 'paired-device' } })).toEqual({ session: reverseSession, execution: reverseInspection })
    await expect(f.service.call('agent.execution.create', { ...reverse, resourceGrant: input.resourceGrant }, context)).rejects.toThrow()
    expect(f.owner.create).toHaveBeenCalledTimes(1)
  })

  it('exposes an explicit project recovery action through the original rejoin entry only', async () => {
    const f = fixture(), request = { ...key, recoverProject: true as const }
    expect(await f.service.call('agent.execution.rejoin', request, context)).toEqual(inspection)
    expect(f.owner.rejoin).toHaveBeenCalledExactlyOnceWith(input.bindingId, context, true)
    await expect(f.service.call('agent.execution.binding', request, context)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    await expect(f.service.call('agent.execution.rejoin', { ...key, recoverProject: false }, context)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  })

  it('denies Agent and anonymous callers before touching the binding owner, including user-principal Agent contexts', async () => {
    const f = fixture()
    for (const caller of [{}, { ...context, caller: { agentSessionId: 'managed-agent', capability: 'agent-capability' } },
      { principal: { kind: 'user' as const, id: '' } }, { principal: { kind: 'device' as const, id: 'bad\0principal' } }]) {
      await expect(f.service.call('agent.execution.create', input, caller)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(f.service.call('agent.execution.continue', original, caller)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(f.service.call('agent.execution.binding', key, caller)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(f.service.call('agent.execution.rejoin', key, caller)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    }
    for (const fn of Object.values(f.owner)) expect(fn).not.toHaveBeenCalled()
  })

  it('keeps missing bindings, unavailable owners, and unavailable healthy-session tool service distinct', async () => {
    const f = fixture(); f.owner.inspect.mockResolvedValueOnce(null)
    expect(await f.service.call('agent.execution.binding', key, context)).toBeNull()
    expect(parseRpcNativeResult('agent.execution.binding', null, key)).toBeNull()
    expect(() => parseRpcNativeResult('agent.execution.rejoin', null, key)).toThrow()
    const unavailable = { ...inspection, state: 'unavailable' as const, diagnostic: { code: 'EXECUTION_OPERATION_UNKNOWN', message: 'Original tool outcome unknown.',
      generation: 'original-generation', operation: { bindingId: input.bindingId, streamGeneration: 'original-generation', nativeRequestId: '0' } } }
    f.owner.create.mockResolvedValueOnce({ session, execution: unavailable })
    expect(await f.service.call('agent.execution.create', input, context)).toEqual({ session, execution: unavailable })
    const noOwner = new AgentMuxRpcService({})
    await expect(noOwner.call('agent.execution.binding', key, context)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    f.owner.rejoin.mockRejectedValueOnce(new Error('Original helper is missing'))
    await expect(f.service.call('agent.execution.rejoin', key, context)).rejects.toThrow('Original helper is missing')
    expect(f.owner.create).toHaveBeenCalledTimes(1)
  })

  it('rejects command overrides and malformed nested creation fields before any durable or native action', async () => {
    const f = fixture()
    for (const bad of [{ ...input, hostId: 'injected' }, { ...input, resourceGrant: { scope: 'host-user', bindingId: 'other' } },
      { ...input, agentRuntimeId: '' }, { ...input, resourceWorkspacePath: 'relative' }, { ...input, agent: { ...input.agent, command: '/bin/sh' } },
      { ...input, agent: { ...input.agent, env: { SECRET: 'injected' } } }, { ...input, agent: { ...input.agent, toolExecution: session.toolExecution } },
      { ...input, agent: { ...input.agent, cols: 0 } }, { ...input, agent: { ...input.agent, rows: 1.5 } },
      { ...input, agent: { ...input.agent, optionalContext: [{ text: 'body' }] } }, { ...input, agent: { ...input.agent, launchOptions: { unsafe: true } } },
      { ...input, agent: { ...input.agent, spatialIntent: { tabId: 'tab', regionId: 'region', executionWorkspaceId: 'workspace', extra: true } } }]) {
      await expect(f.service.call('agent.execution.create', bad as AgentExecutionOpenInput, context)).rejects.toThrow()
    }
    for (const bad of [{ bindingId: '' }, { bindingId: input.bindingId, hostId: 'other' }]) expect(() => parseAgentExecutionBinding(bad)).toThrow()
    expect(f.owner.create).not.toHaveBeenCalled()
  })

  it('refuses substituted Session, creation, resource and diagnostic identities in owner receipts', async () => {
    const f = fixture()
    const wrongSessions = [{ ...session, agentSessionId: 'other' }, { ...session, creation: { ...session.creation!, createOperationId: 'other' } },
      { ...session, workspacePath: '/other/project' }, { ...session, executorId: 'other' }, { ...session, toolExecution: { ...session.toolExecution!, resourceRuntimeId: 'other' } },
      { ...session, hookToken: 'private-secret' }]
    for (const wrong of wrongSessions) {
      f.owner.create.mockResolvedValueOnce({ session: wrong, execution: inspection })
      await expect(f.service.call('agent.execution.create', input, context)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    }
    const wrongInspections = [{ ...inspection, bindingId: 'other' }, { ...inspection, payload: 'private' }, { ...inspection, state: ['connected'] },
      { ...inspection, state: 'unavailable' }, { ...inspection, state: 'unavailable', diagnostic: { code: 'unknown', message: 'unknown', result: 'private' } },
      { ...inspection, state: 'unavailable', diagnostic: { code: 'unknown', message: 'unknown', generation: 'original', operation: { bindingId: input.bindingId, streamGeneration: 'other', nativeRequestId: 0 } } }]
    for (const wrong of wrongInspections) expect(() => parseAgentExecutionInspection(wrong, key)).toThrow()
    for (const field of ['agentHostId', 'resourceHostId', 'agentSessionId', 'resourceWorkspacePath']) {
      f.owner.create.mockResolvedValueOnce({ session, execution: { ...inspection, [field]: '/other' } })
      await expect(f.service.call('agent.execution.create', input, context)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    }
  })

  it('checks current transport authority before dispatch and never automatically repeats a lost creation reply', async () => {
    const f = fixture()
    await expect(f.service.call('agent.execution.create', input, { ...context, assertCurrent: async () => { throw new Error('revoked') } })).rejects.toThrow('revoked')
    expect(f.owner.create).not.toHaveBeenCalled()
    f.owner.create.mockRejectedValueOnce(new Error('Creation reply unknown'))
    await expect(f.service.call('agent.execution.create', input, context)).rejects.toThrow('Creation reply unknown')
    expect(f.owner.create).toHaveBeenCalledTimes(1)
    expect(f.owner.rejoin).not.toHaveBeenCalled()
  })

  it('discovers executable CLI commands and reads the exact JSON file through the shared parser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-execution-rpc-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
    for (const action of ['create', 'binding', 'rejoin']) {
      const method = 'agent.execution.' + action, params = action === 'create' ? input : key, path = join(root, action + '.json')
      await writeFile(path, JSON.stringify(params))
      const invocation = await parseAgentMuxCliInvocation(['agent', 'execution', action, '--input', path])
      expect(invocation.command.method).toBe(method); expect(invocation.params).toEqual(params)
      expect(AGENTMUX_CLI_COMMANDS.filter(command => command.method === method)).toHaveLength(1)
      expect(agentMuxCommandHelp(method)).toContain('--input FILE|-')
      await expect(parseAgentMuxCliInvocation(['agent', 'execution', action])).rejects.toThrow()
    }
    expect(agentMuxModuleSkill('agent')).toContain('amux agent execution rejoin')
    expect(agentMuxCommandHelp('agent.execution')).toContain('amux agent execution create')
  })
})


it('preserves typed Provider notices through actual RPC service and strict result codec without altering connected state', async () => {
  const f = fixture(), value: AgentExecutionInspection = { ...inspection, notices: [{ providerId: 'fixture-provider', role: 'executor', capability: 'agent-control', state: 'unconfigured', code: 'AGENT_TOOL_CONTEXT_UNAVAILABLE', message: 'Agent control unconfigured', action: 'Configure original route' }] }
  const expected = structuredClone(value)
  f.owner.inspect.mockResolvedValueOnce(value)
  const returned = await f.service.call('agent.execution.binding', key, context)
  expect(parseRpcNativeResult('agent.execution.binding', returned, key)).toEqual(expected)
  for (const notice of [{ ...value.notices![0], state: 'connected' }, { ...value.notices![0], privateCredential: 'secret' }]) {
    expect(() => parseAgentExecutionInspection({ ...value, notices: [notice] }, key)).toThrow()
  }
  expect(() => parseAgentExecutionInspection({ ...value, notices: [...value.notices!, ...value.notices!] }, key)).toThrow()
})


it('roundtrips connected bindings with exact scoped local diagnostics without private payloads', () => {
  const operation = { bindingId: input.bindingId, streamGeneration: 'original', nativeRequestId: '1' }
  const diagnostic = { scope: 'operation', side: 'executor', runId: 'original-helper', generation: 'original', operation, code: 'RESPONSE_STORAGE_UNCONFIRMED', message: 'Original response not committed' }
  const value = { ...inspection, diagnostics: [diagnostic, { scope: 'unclassified', code: 'OLD', message: 'Original unscoped issue' }] }
  expect(parseAgentExecutionInspection(value, key)).toEqual(value)
  for (const wrong of [{ ...diagnostic, side: 'frontend' }, { ...diagnostic, operation: undefined }, { ...diagnostic, runId: '' }, { ...diagnostic, scope: 'guessed' }, { ...diagnostic, operation: { ...operation, bindingId: 'wrong' } }, { ...diagnostic, result: 'private' }]) {
    expect(() => parseAgentExecutionInspection({ ...inspection, diagnostics: [wrong] }, key)).toThrow()
  }
})

it('parses continuation CLI as exact original identity and rejects any replacement launch input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-continue-cli-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'original.json')
  await writeFile(file, JSON.stringify(original))
  const parsed = await parseAgentMuxCliInvocation(['agent', 'execution', 'continue', '--input', file])
  expect(parsed).toMatchObject({ command: { method: 'agent.execution.continue' }, params: original })
  expect(agentMuxCommandHelp('agent.execution.continue')).toContain('original')
  for (const replacement of [{ ...original, prompt: 'replacement' }, { ...original, agentSessionId: '' }, { bindingId: original.bindingId }]) {
    await writeFile(file, JSON.stringify(replacement))
    await expect(parseAgentMuxCliInvocation(['agent', 'execution', 'continue', '--input', file])).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  }
  for (const changed of [{ ...original, agentSessionId: 'another' }, { ...original, createOperationId: 'another' }])
    expect(() => parseRpcNativeResult('agent.execution.continue', { session, execution: inspection }, changed)).toThrow()
})

it('binding watch denies anonymous/managed readers before owner access and parses exact CLI stream input', async () => {
  const f = fixture(), watch = vi.fn()
  const service = new AgentMuxRpcService({ executionBindings: { ...f.owner, watch } })
  for (const caller of [{}, { ...context, caller: { agentSessionId: 'managed-agent', capability: 'capability' } }]) {
    await expect(service.subscribe('agent.execution.watch', key, vi.fn(), caller)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  expect(watch).not.toHaveBeenCalled()
  const root = await mkdtemp(join(tmpdir(), 'amux-watch-cli-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'input.json'); await writeFile(path, JSON.stringify(key))
  const invocation = await parseAgentMuxCliInvocation(['agent', 'execution', 'watch', '--input', path])
  expect(agentMuxModuleSkill('agent')).toContain('amux agent execution watch')
  expect(agentMuxCommandHelp('agent.execution.watch')).toContain('user/device')
  expect(invocation.command.method).toBe('agent.execution.watch'); expect(invocation.command.stream).toBe(true); expect(invocation.params).toEqual(key)
  expect(() => parseRpcNativeResult('agent.execution.watch', { bindingId: 'other', inspection }, key)).toThrow()
  expect(() => parseRpcNativeResult('agent.execution.watch', { bindingId: input.bindingId, inspection: { ...inspection, bindingId: 'other' } }, key)).toThrow()
})

it.each(['revoked', 'aborted', 'runtime'] as const)('does not disclose a delayed watch opening after its reader becomes %s', async kind => {
  const f = fixture(); let release!: () => void, entered!: () => void
  const ready = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
  const dispose = vi.fn(), start = vi.fn(), events = vi.fn(), abort = new AbortController(); let revoked = false
  const watch = vi.fn(async () => { entered(); await held; return { initial: { bindingId: input.bindingId, inspection }, dispose, start } })
  const service = new AgentMuxRpcService({ executionBindings: { ...f.owner, watch },
    hostedRuntime: () => ({ assertFence: () => { if (revoked && kind === 'runtime') throw Error('original Runtime changed') } }) as never })
  const opening = service.subscribe('agent.execution.watch', key, events, { ...context, signal: abort.signal, runtimeFence: { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' },
    assertCurrent: () => { if (revoked && kind === 'revoked') throw Error('revoked original authority') } })
  const settled = opening.then(async value => { await value.dispose(); return { initial: value.initial } }, error => ({ error }))
  await ready; if (kind === 'aborted') abort.abort(); else revoked = true
  release(); const outcome = await settled
  expect(outcome).toHaveProperty('error')
  expect(dispose).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled()
})
it('SDK watch retains per-request managed credentials on the actual Unix transport instead of gaining local user authority', async () => {
  const f = fixture(), watch = vi.fn(async () => ({ initial: { bindingId: input.bindingId, inspection }, start: vi.fn(), dispose: vi.fn() }))
  const root = await mkdtemp(join(tmpdir(), 'amux-binding-wire-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'core.sock'), executionBindings: { ...f.owner, watch } }); await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const managed = await rpc.subscribe('agent.execution.watch', key, { credentials: { agentSessionId: 'managed-original', capability: 'original-capability' }, onInitial: () => {}, onEvent: () => {} }).then(async reader => { await reader.dispose(); return { allowed: true } }, error => ({ error }))
  expect(managed).toHaveProperty('error'); expect('error' in managed && managed.error).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(watch).not.toHaveBeenCalled()
  const initial = vi.fn(), reader = await rpc.subscribe('agent.execution.watch', key, { onInitial: initial, onEvent: () => {} })
  expect(initial).toHaveBeenCalledExactlyOnceWith({ bindingId: input.bindingId, inspection }); expect(watch).toHaveBeenCalledOnce()
  await reader.dispose()
})
