import { withInteractionOperation } from './fixtures/interaction-client.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { agentInteractionActiveRequest, agentInteractionResponseUnavailableReason } from '../src/agent-interaction-state.js'
import { AgentMuxError } from '../src/errors.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import type { AgentHookServer } from '../src/hook-server.js'
import type { AgentMuxInteractionRequest, AgentMuxClientEvent, AgentProviderSessionStatus } from '../src/types.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

// Real authenticated Hook HTTP, Core/Store/Provider and response owner. Only Runtime/process-native
// witness are controlled ports; upstream adoption is proved separately on ordinary Builtin Native.
async function fixture() {
  const h = await rpcOwnerFixture(['recipient'])
  const provider = h.client.providers.get('codex')
  provider.discoverNativeSession = async () => ({ handle: { kind: 'provider', providerId: 'codex', sessionId: 'native-original' }, assertCurrent: async () => {} })
  let onStatus: ((status: AgentProviderSessionStatus) => void) | undefined
  provider.observeSessionStatus = async context => { onStatus = context.onStatus; return { dispose() {} } }
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: 123 }))
  const server = Reflect.get(h.client, 'hookServer') as AgentHookServer
  await server.start()
  const binding = server.createBinding('recipient', 'codex'); await binding.bindRun('run-recipient')
  const events: AgentMuxClientEvent[] = []
  h.client.onEvent(event => { events.push(event) })
  const read = (id: string) => {
    const pending = h.client.agentSession('recipient').pendingInteraction
    return [pending?.request, ...(pending?.additionalRequests ?? [])].find(request => request?.id === id)
  }
  const open = async (id: string) => {
    const pending = fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}` },
      body: JSON.stringify({ receiptId: id, eventName: 'PermissionRequest', decision: true,
        payload: { hook_event_name: 'PermissionRequest', session_id: 'native-original', turn_id: 'turn-original', tool_name: 'Bash', tool_input: { command: 'private command' } } }) })
    await expect.poll(() => read(id)?.kind === 'permission' && read(id)?.evidence.hookReceiptId === id).toBe(true)
    const bindings = Reflect.get(server, 'bindings') as Map<string, { tail: Promise<void> }>
    await bindings.get(binding.endpoint.token)!.tail
    return { pending }
  }
  const input = (id: string) => ({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' },
    response: { kind: 'permission' as const, requestId: id, decision: { outcome: 'selected' as const, optionId: 'allow-once' } } })
  const observe = async (status: AgentProviderSessionStatus) => {
    if (!onStatus) throw new Error('The original Provider status port is not attached.')
    onStatus(status)
    const watches = Reflect.get(h.client, 'nativeStatusWatches') as Map<string, { pending: Promise<void> }>
    await watches.get('recipient')!.pending
  }
  return { ...h, provider, server, binding, events, read, open, input, observe }
}

it('uses the original callback without a pane, terminal bytes or nonexistent tool call ID and publishes receipts', async () => {
  const h = await fixture(), { pending } = await h.open('original')
  try {
    expect(h.read('original')).not.toHaveProperty('nativeToolCallId')
    await h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('original')))
    expect(await (await pending).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    await expect.poll(() => {
      const request = h.read('original')
      return request?.kind === 'permission' && request.permissionHook?.closed
    }).toBe('decision-returned')
    const observed = h.events.filter(event => event.type === 'agent-session').map(event => event.session.pendingInteraction?.request)
    expect(observed.some(request => request?.kind === 'permission' && request.permissionHook?.response?.delivery === 'connection-written')).toBe(true)
    expect(h.read('original')).not.toHaveProperty('inputByteRange')
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    // A same-response read cannot invoke another callback or repeat input.
    await h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('original')))
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('rechecks the current author after saving and releases the original callback without approval on revocation', async () => {
  const h = await fixture(), { pending } = await h.open('revoked')
  let checks = 0
  try {
    const result = await h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('revoked')), { assertCurrent: async () => {
      checks++
      const current = h.read('revoked')
      if (current?.kind === 'permission' && current.permissionHook?.response?.delivery === 'unknown') throw new AgentMuxError('Original author revoked.', 'CONTROL_PERMISSION_DENIED')
    } }).then(() => null, error => error)
    expect(result).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(checks).toBeGreaterThan(0)
    expect(h.server.hasPermissionCallback('recipient', 'run-recipient', 'revoked')).toBe(false)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    expect(await (await pending).json()).toEqual({})
    const request = h.read('revoked')
    expect(request?.kind === 'permission' && request.permissionHook?.response).toMatchObject({ value: h.input('revoked').response, delivery: 'saved' })
  } finally { await h.close() }
})

it('rejects another Run, callback or choice while preserving the original native waiter', async () => {
  const h = await fixture(), { pending } = await h.open('original')
  try {
    await expect(h.client.respondAgentInteraction(withInteractionOperation(h.client, { ...h.input('original'), expectedRun: { runId: 'different' } }))).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    await expect(h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('different')))).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_INTERACTION' })
    await expect(h.client.respondAgentInteraction(withInteractionOperation(h.client, { ...h.input('original'), response: { ...h.input('original').response,
      decision: { outcome: 'selected', optionId: 'allow-always' } } }))).rejects.toMatchObject({ code: 'INVALID_AGENT_INTERACTION_RESPONSE' })
    expect(h.server.hasPermissionCallback('recipient', 'run-recipient', 'original')).toBe(true)
    await h.client.respondAgentInteraction(withInteractionOperation(h.client, { ...h.input('original'), response: { ...h.input('original').response, decision: { outcome: 'selected', optionId: 'reject-once' } } }))
    expect(await (await pending).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } })
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('does not adopt a callback when the original native witness is unavailable', async () => {
  const h = await fixture()
  h.provider.discoverNativeSession = async () => null
  try {
    const pending = fetch(h.binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${h.binding.endpoint.token}` },
      body: JSON.stringify({ receiptId: 'unadopted', eventName: 'PermissionRequest', decision: true,
        payload: { session_id: 'native-original', hook_event_name: 'PermissionRequest', tool_name: 'Bash' } }) })
    const bindings = Reflect.get(h.server, 'bindings') as Map<string, { receipts: Map<string, unknown>; tail: Promise<void> }>
    const binding = bindings.get(h.binding.endpoint.token)!
    await expect.poll(() => binding.receipts.has('unadopted')).toBe(true)
    await binding.tail
    expect(h.server.hasPermissionCallback('recipient', 'run-recipient', 'unadopted')).toBe(false)
    expect(await (await pending).json()).toEqual({})
    expect(h.read('unadopted')).toBeUndefined()
    expect(h.server.hasPermissionCallback('recipient', 'run-recipient', 'unadopted')).toBe(false)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('the existing Hosted SDK answers the same callback through actual Unix RPC and rejects a wire context slot', async () => {
  const h = await fixture(), { pending } = await h.open('hosted')
  const owner = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client))
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients, hostedRuntime: () => owner })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false })
  try {
    h.inner.connected = false
    const connect = vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('Runtime observation unavailable'))
    const status = vi.fn(async () => { throw new Error('Runtime observation unavailable') })
    h.inner.kernel.status = status
    await hosted.respondAgentInteraction(withInteractionOperation(h.client, h.input('hosted')))
    expect(await hosted.inspectAgentInteractionOperation({ agentSessionId: 'recipient', operationId: 'response-hosted' }))
      .toMatchObject({ delivery: 'hook-written', nativeAdoption: 'unknown' })
    expect(status).not.toHaveBeenCalled()
    expect(await (await pending).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    await expect(owner.call('runtime.invoke', { consumerId: 'malformed', fence: { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' },
      invocation: { method: 'respondAgentInteraction', args: [h.input('hosted'), { assertCurrent: {} }] } }, {})).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { h.inner.connected = true; await hosted.dispose(); await rpc.dispose(); await server.stop(); await owner.dispose(); await h.close() }
})

it('retains an attempted terminal receipt and never replays it into the still-open Hook', async () => {
  const h = await fixture(), { pending } = await h.open('terminal-original')
  try {
    const previous = (await h.store.readMetadata('recipient'))!
    const value = h.input('terminal-original').response
    const response = { value, responseDigest: createHash('sha256').update(JSON.stringify(value)).digest('base64url'),
      operationId: 'original-terminal-attempt', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false }
    await h.store.compareAndSwapMetadata(previous, { ...previous, pendingInteraction: { ...previous.pendingInteraction!, response } })
    await h.inner.registry.load('local')
    const result = await h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('terminal-original'))).then(() => null, error => error)
    expect(result).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    expect(h.client.agentSession('recipient').pendingInteraction?.response).toEqual(response)
    expect(h.server.hasPermissionCallback('recipient', 'run-recipient', 'terminal-original')).toBe(true)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    await h.binding.close(); expect(await (await pending).json()).toEqual({})
  } finally { await h.close() }
})

it.each(['allow', 'abstain'])('the original managed command uses the Server Provider declaration and returns one %s reply', async mode => {
  const h = await fixture()
  const env = { ...process.env, AGENTMUX_ENV: '1', AGENTMUX_HOOK_URL: h.binding.endpoint.url,
    AGENTMUX_HOOK_TOKEN: h.binding.endpoint.token, AGENTMUX_HOOK_PROVIDER: 'codex', AGENTMUX_HOOK_PAYLOAD_KEY: 'hook_event_name' }
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/agentmux-hook.js', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(child, 'close'); let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'native-original', turn_id: 'turn-original', tool_name: 'Bash', tool_input: { command: 'private command' } }))
  try {
    await expect.poll(() => {
      const pending = h.client.agentSession('recipient').pendingInteraction
      return pending?.request.id
    }).toBeTruthy()
    const request = h.client.agentSession('recipient').pendingInteraction!.request
    expect(request.kind === 'permission' && request.permissionHook?.receiptId).toBe(request.id)
    if (mode === 'allow') await h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input(request.id)))
    else await h.binding.close()
    const [code, signal] = await closed
    expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: '' })
    expect(stdout).toBe(mode === 'allow'
      ? '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n' : '{}\n')
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed }; await h.close() }
})

it('normalizes a legal differently ordered SDK permission DTO before its durable digest claim', async () => {
  const h = await fixture(), { pending } = await h.open('ordered')
  try {
    const result = await h.client.respondAgentInteraction(withInteractionOperation(h.client, { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' },
      response: { requestId: 'ordered', kind: 'permission', decision: { optionId: 'allow-once', outcome: 'selected' } } })).then(() => null, error => error)
    expect(result).toBeNull()
    expect(await (await pending).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    const saved = (await h.store.readMetadata('recipient'))!.pendingInteraction!.request
    expect(saved.kind === 'permission' && saved.permissionHook?.response?.delivery).toBe('connection-written')
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('a new original callback never inherits the primary request terminal tuple in public projection or dispatch', async () => {
  const h = await fixture(), { pending: original } = await h.open('old-terminal')
  try {
    await h.binding.close(); await original
    await expect.poll(() => { const request = h.read('old-terminal'); return request?.kind === 'permission' && request.permissionHook?.closed }).toBe('abstained')
    const previous = (await h.store.readMetadata('recipient'))!, value = h.input('old-terminal').response
    const response = { value, responseDigest: createHash('sha256').update(JSON.stringify(value)).digest('base64url'),
      operationId: 'old-terminal', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false }
    const oldRequest = previous.pendingInteraction!.request
    if (oldRequest.kind !== 'permission') throw new Error('The original request fixture is missing.')
    const { permissionHook: _oldCallback, ...retainedTerminalRequest } = oldRequest
    await h.store.compareAndSwapMetadata(previous, { ...previous, pendingInteraction: { ...previous.pendingInteraction!,
      request: { ...retainedTerminalRequest, nativeToolCallId: 'original-terminal-call' }, response,
      nativeCompleted: { source: 'native-hook', run: { runId: 'run-recipient' }, hookReceiptId: 'original-terminal-call-end', observedAt: Date.now() } } })
    await h.inner.registry.load('local')
    const nextBinding = h.server.createBinding('recipient', 'codex'); await nextBinding.bindRun('run-recipient')
    const pending = fetch(nextBinding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${nextBinding.endpoint.token}` },
      body: JSON.stringify({ receiptId: 'new-hook', eventName: 'PermissionRequest', decision: true,
        payload: { hook_event_name: 'PermissionRequest', session_id: 'native-original', turn_id: 'turn-original', tool_name: 'Bash' } }) })
    await expect.poll(() => h.read('new-hook')?.id).toBe('new-hook')
    const projected = h.client.agentSession('recipient').pendingInteraction!
    expect(projected.request.id).toBe('old-terminal')
    expect(projected.response).toEqual(response)
    expect(agentInteractionActiveRequest(projected)?.id).toBe('new-hook')
    expect(agentInteractionResponseUnavailableReason(projected)).toBeUndefined()
    await h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('new-hook')))
    expect(await (await pending).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(h.client.agentSession('recipient').pendingInteraction?.response).toEqual(response)
    await h.observe({ recordId: 'wrong-turn-end', nativeTurnId: 'foreign-turn', state: 'done' })
    const wrongTurn = h.read('new-hook')
    expect(wrongTurn?.kind === 'permission' ? wrongTurn.permissionHook?.nativeTurnEnded : undefined).toBeUndefined()
    await h.observe({ recordId: 'original-turn-end', nativeTurnId: 'turn-original', state: 'done' })
    const retained = h.client.agentSession('recipient').pendingInteraction!
    expect(retained.response).toEqual(response)
    expect(retained.request.id).toBe('old-terminal')
    expect(agentInteractionActiveRequest(retained)).toBeUndefined()
    const request = h.read('new-hook')
    expect(request?.kind === 'permission' && request.permissionHook?.nativeTurnEnded?.recordId).toBe('original-turn-end')
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})


it('concurrent callers share the original response and a rejected non-owner cannot close it', async () => {
  const h = await fixture(), { pending } = await h.open('concurrent')
  const original = vi.spyOn(h.server, 'respondPermission')
  try {
    // A caller with no decision ownership cannot abstain on behalf of another author.
    const rejected = await h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('concurrent')), { assertCurrent: async () => {
      throw new AgentMuxError('No current authority.', 'CONTROL_PERMISSION_DENIED')
    } }).then(() => null, error => error)
    expect(rejected).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(h.server.hasPermissionCallback('recipient', 'run-recipient', 'concurrent')).toBe(true)
    const results = await Promise.allSettled([h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('concurrent'))), h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('concurrent')))])
    expect(results.filter(result => result.status === 'fulfilled').length).toBeGreaterThan(0)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
    expect(await (await pending).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(original).toHaveBeenCalledTimes(1)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})


it('a still-open original callback stays answerable while Runtime observation is disconnected', async () => {
  const h = await fixture(), { pending } = await h.open('runtime-observation-lost')
  h.inner.connected = false
  const status = vi.fn(async () => { throw new Error('Runtime observation is unavailable') })
  h.inner.kernel.status = status; h.inner.kernel.isConnected = () => false
  try {
    const result = await h.client.respondAgentInteraction(withInteractionOperation(h.client, h.input('runtime-observation-lost'))).then(() => null, error => error)
    expect(result).toBeNull()
    expect(await (await pending).json()).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(status).not.toHaveBeenCalled()
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { h.inner.connected = true; await h.close() }
})
