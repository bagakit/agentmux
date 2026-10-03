import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { BUILT_IN_AGENT_PROVIDERS } from '../src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore, AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'
import type { AgentProviderPreparedInteractionResponse } from '../src/agent-provider.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { hostedTestOwner, hostedTestFence, logicalHostedEvents } from './helpers/hosted-runtime-port.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'
import { AgentMuxError } from '../src/errors.js'

/** Real Core Store, Hook normalization, claim and settlement. The byte owner here is synthetic. */
async function fixture() {
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: 'target-agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: upstreamFixturePath("tmp/target-agent"), run: { runId: 'target-run' }, retiredRuns: [],
    hookBindingId: 'target-binding', hookToken: 'target-token', createdAt: 1, updatedAt: 1
  } as AgentMuxStoredAgentSession)
  const client = new AgentMuxClient({ store, providers: BUILT_IN_AGENT_PROVIDERS.map(provider => provider.id !== 'codex' ? provider : {
    ...provider,
    // Synthetic Runtime PID has no OS identity. Admit only this fixture's exact native source;
    // session-status-authority independently qualifies real process-native discovery.
    discoverNativeSession: async () => ({ handle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'native-exact', transcriptPath: upstreamFixturePath("tmp/native-exact.jsonl") }, assertCurrent: async () => {} })
  }) })
  const owner = client as unknown as {
    connected: boolean; registry: { load(host: string): Promise<void> }; kernel: Record<string, unknown>
    acceptHookEvent(envelope: NativeHookEnvelope, signal: AbortSignal): Promise<void>
    screenEvidence: { currentCompleteFrame: () => unknown }
  }
  await owner.registry.load('local')
  let cursor = 0
  const writes: string[] = []
  const run = () => ({ nativeService: null, runId: 'target-run', lifecycleOperationId: null,
    program: 'codex', args: [], cwd: upstreamFixturePath("tmp/target-agent"), env: {}, workspacePath: upstreamFixturePath("tmp/target-agent"), pid: 999,
    state: { type: 'running' as const }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
  owner.kernel.isConnected = () => true
  owner.kernel.identity = () => ({ daemonInstanceId: 'target-daemon', protocolVersion: 1, buildIdentity: 'test' })
  owner.kernel.status = async () => run()
  owner.kernel.input = async (_id: string, op: { expectedByte: number; data: string }) => {
    writes.push(op.data); cursor = op.expectedByte + Buffer.byteLength(op.data)
    return { run: run(), appliedByteRange: { startByte: op.expectedByte, endByte: cursor } }
  }
  owner.connected = true
  // Explicit synthetic target contribution. Native decoder/PTY qualification has its own gate.
  const provider = client.providers.get('codex')
  provider.prepareInteractionResponse = async (context, request, response) => ({
    plan: provider.planInteractionResponse(request, response),
    target: { agentSessionId: context.agentSessionId, run: context.run, requestId: request.id,
      nativeToolCallId: request.nativeToolCallId!, nativeSourceId: 'synthetic-source', inputByte: context.inputByte,
      frame: { run: context.run, outputThroughByte: 0, geometryRevision: 0, evidenceGeneration: 0 } },
    inspectCurrentTarget: () => true, verifyCurrentTarget: async () => true
  })
  owner.screenEvidence.currentCompleteFrame = () => ({ snapshot: { cols: 80, rows: 24, cursor: { row: 0, column: 0 }, lines: [] },
    outputThroughByte: 0, geometryRevision: 0, evidenceGeneration: 0 })
  let serial = 0
  const hook = async (event: 'PermissionRequest' | 'PostToolUse', call: string) => owner.acceptHookEvent({
    receiptId: `target-receipt-${++serial}`, agentSessionId: 'target-agent', providerId: 'codex', runId: 'target-run',
    payload: { session_id: 'native-exact', hook_event_name: event, tool_name: 'exec_command', tool_call_id: call, tool_input: { cmd: `printf ${call}` } }
  }, new AbortController().signal)
  const reply = () => client.respondAgentInteraction({ agentSessionId: 'target-agent', expectedRun: { runId: 'target-run' },
    response: { kind: 'permission', requestId: client.agentSession('target-agent').pendingInteraction!.request.id,
      decision: { outcome: 'selected', optionId: 'allow-once' } } })
  return { client, owner, store, writes, run, hook, reply, pending: () => client.agentSession('target-agent').pendingInteraction }
}

describe('typed ACK and exact native completion are separate facts', () => {
  it.each(['unknown', 'not_applied', 'old-ack'] as const)('cold public connect reconciles an ended original operation as %s without blocking a healthy sibling', async disposition => {
    const h = await fixture(), events: import('../src/types.js').AgentMuxClientEvent[] = []
    h.client.onEvent(event => events.push(event))
    let resets = 0, healthyCursor = 0
    let originalOperation!: { operationId: string; expectedByte: number; data: string }
    const recovered: typeof originalOperation[] = []
    try {
      await h.hook('PermissionRequest', 'ended-original')
      h.owner.kernel.input = async (_id: string, operation: typeof originalOperation) => {
        originalOperation = { ...operation }
        throw new AgentMuxError('Private original receipt is unavailable.', 'PRIVATE_INPUT_FAILURE', 'unknown')
      }
      await expect(h.reply()).rejects.toMatchObject({ code: 'PRIVATE_INPUT_FAILURE' })
      const original = structuredClone(h.pending()!)
      const ended = { ...h.run(), state: { type: 'exited' as const, code: 0, signal: null } }
      const healthy = () => ({ ...h.run(), runId: 'healthy-run', cwd: upstreamFixturePath("tmp/healthy-agent"), workspacePath: upstreamFixturePath("tmp/healthy-agent"), acceptedInputBytes: healthyCursor })
      const sibling: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'healthy-agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
        run: { runId: 'healthy-run' }, retiredRuns: [], workspacePath: upstreamFixturePath("tmp/healthy-agent"),
        hookBindingId: 'healthy-binding', hookToken: 'healthy-token', createdAt: 1, updatedAt: 1 }
      await h.store.compareAndSwap(null, sibling)
      // Only Runtime and ingress/handshake collaborators are synthetic. Public cold
      // connect, canonical Store recovery, receipt reconciliation and raw write are real.
      Object.assign(h.owner, { connected: false, tryRestoreHookIngress: async () => {},
        ensureTerminalHandshakeOrDegrade: async () => {}, queueNativeIdentityCapture: () => {} })
      Object.assign(h.owner.kernel, { connect: async () => {}, list: async () => [ended, healthy()],
        status: async (id: string) => id === 'target-run' ? ended : healthy(),
        onEvent: () => () => {}, onError: () => () => {}, onConnectionLost: () => () => {},
        resetConnection: () => { resets++ },
        input: async (id: string, operation: typeof originalOperation) => {
          if (id === 'target-run') {
            recovered.push({ ...operation })
            expect(operation).toEqual(originalOperation)
            if (disposition !== 'old-ack') throw new AgentMuxError('Private original receipt reconciliation failed.', 'PRIVATE_INPUT_FAILURE', disposition)
            // An authoritative receipt for the original operation is returned without
            // applying any bytes to the ended Run. It is not native tool completion.
            return { run: { ...ended, acceptedInputBytes: original.response!.inputByteRange.endByte }, appliedByteRange: { ...original.response!.inputByteRange } }
          }
          expect(id).toBe('healthy-run')
          h.writes.push(operation.data); healthyCursor = operation.expectedByte + Buffer.byteLength(operation.data)
          return { run: healthy(), appliedByteRange: { startByte: operation.expectedByte, endByte: healthyCursor } }
        } })
      await h.client.connect()
      expect(resets).toBe(0); expect(h.writes).toEqual([])
      expect(recovered).toEqual([originalOperation])
      if (disposition === 'not_applied') expect(h.pending()).toBeUndefined()
      else if (disposition === 'old-ack') expect(h.pending()).toEqual({ ...original, response: { ...original.response!, acknowledged: true } })
      else {
        expect(h.pending()).toEqual(original)
        expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_INTERACTION_UNCONFIRMED', agentSessionId: 'target-agent' }))
      }
      await h.client.writeAgent({ agentSessionId: 'healthy-agent', expectedRun: { runId: 'healthy-run' }, source: 'user', data: 'ordinary' })
      expect(h.writes).toEqual(['ordinary']); expect(recovered).toEqual([originalOperation]); expect(resets).toBe(0)
      if (disposition === 'unknown') expect(h.pending()).toEqual(original)
    } finally { await h.client.dispose() }
  })
  it('cold public connect keeps an original unacknowledged claim and healthy input without automatically adding answer bytes', async () => {
    const h = await fixture(), events: import('../src/types.js').AgentMuxClientEvent[] = []
    h.client.onEvent(event => events.push(event))
    const originalInput = h.owner.kernel.input
    let resets = 0
    try {
      await h.hook('PermissionRequest', 'cold-original')
      h.owner.kernel.input = async () => { throw new AgentMuxError('Private original input was not applied.', 'PRIVATE_INPUT_FAILURE', 'not_applied') }
      await expect(h.reply()).rejects.toMatchObject({ code: 'PRIVATE_INPUT_FAILURE' })
      const original = structuredClone(h.pending()!.response)
      // Runtime and ingress/handshake collaborators are controlled. Public connect/open,
      // Store reload and original response recovery stay production code.
      Object.assign(h.owner, { connected: false, tryRestoreHookIngress: async () => {},
        ensureTerminalHandshakeOrDegrade: async () => {}, queueNativeIdentityCapture: () => {} })
      Object.assign(h.owner.kernel, { connect: async () => {}, list: async () => [h.run()],
        onEvent: () => () => {}, onError: () => () => {}, onConnectionLost: () => () => {},
        resetConnection: () => { resets++ } })
      await h.client.connect()
      expect(resets).toBe(0); expect(h.writes).toEqual([])
      expect(h.pending()!.response).toEqual(original)
      expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_INTERACTION_UNCONFIRMED', agentSessionId: 'target-agent' }))
      expect((await h.client.statusAgent('target-agent')).interactionResponseUnavailableReason).toContain('original typed response receipt is unconfirmed')
      h.owner.kernel.input = originalInput
      await h.client.writeAgent({ agentSessionId: 'target-agent', expectedRun: { runId: 'target-run' }, source: 'terminal-protocol', data: 'ordinary' })
      expect(h.writes).toEqual(['ordinary']); expect(h.pending()!.response).toEqual(original)
    } finally { await h.client.dispose() }
  })
  it('consumes typed ACK through the finite Hosted method and observes the original pending facts through actual inspect/context CLI', async () => {
    const h = await fixture()
    const hosted = new AgentMuxHostedRuntimeService(h.client, null, () => hostedTestOwner(h.client))
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.client }] })
    let corruptReason = false
    const probe = new ObjectCliProbe(async request => {
      const value = await service.call(request.method as 'agent.inspect', request.params as any)
      if (corruptReason) (value as any).status.interactionResponseUnavailableReason = 'A different request is ready.'
      return value
    })
    let consumer: Awaited<ReturnType<typeof hosted.subscribe>> | undefined
    try {
      await h.hook('PermissionRequest', 'hosted-call')
      consumer = await hosted.subscribe('runtime.events', { fence: hostedTestFence, consumerId: 'typed-consumer' }, logicalHostedEvents(() => {}))
      await consumer.start?.()
      await hosted.call('runtime.invoke', { fence: hostedTestFence, consumerId: 'typed-consumer', invocation: {
        method: 'respondAgentInteraction', args: [{ agentSessionId: 'target-agent', expectedRun: { runId: 'target-run' },
          response: { kind: 'permission', requestId: h.pending()!.request.id, decision: { outcome: 'selected', optionId: 'allow-once' } } }]
      } })
      expect(h.writes).toEqual(['1'])
      await probe.start()
      for (const args of [['agent', 'inspect', '--session', 'target-agent'], ['agent', 'context', '--host', 'local', '--session', 'target-agent']]) {
        const result = await probe.run(args)
        expect(result.code, result.stderr + result.stdout).toBe(0)
        const body = JSON.parse(result.stdout)
        expect(body.ok).toBe(true)
        const session = body.result?.session ?? body.session
        expect(session.pendingInteraction).toMatchObject({ request: { nativeToolCallId: 'hosted-call' }, response: { acknowledged: true } })
        expect(JSON.stringify(body)).toContain('Waiting for the exact native request to complete')
      }
      corruptReason = true
      const corrupt = await probe.run(['agent', 'inspect', '--session', 'target-agent'])
      expect(corrupt.code).not.toBe(0)
      expect(corrupt.stdout + corrupt.stderr).toContain('CONTROL_PROTOCOL_ERROR')
      corruptReason = false
      await h.hook('PostToolUse', 'hosted-call')
      const settled = await probe.run(['agent', 'inspect', '--session', 'target-agent'])
      expect(settled.code, settled.stdout + settled.stderr).toBe(0)
      const result = JSON.parse(settled.stdout)
      expect((result.result?.session ?? result.session).pendingInteraction).toBeUndefined()
      expect(h.writes).toEqual(['1'])
      expect(probe.requests.map(request => request.method)).toEqual(['agent.inspect', 'agent.context', 'agent.inspect', 'agent.inspect'])
    } finally { await probe.stop(); await consumer?.dispose(); await hosted.dispose(); await service.dispose(); await h.client.dispose() }
  }, 30_000)
  it('keeps an acknowledged response pending until its exact native invocation completes', async () => {
    const h = await fixture()
    try {
      await h.hook('PermissionRequest', 'call-1')
      await h.reply()
      expect(h.writes).toEqual(['1'])
      expect(h.pending()).toMatchObject({ request: { nativeToolCallId: 'call-1' }, response: { acknowledged: true } })
      await h.reply()
      expect(h.writes).toEqual(['1'])
      await h.hook('PostToolUse', 'wrong-call')
      expect(h.pending()?.request.nativeToolCallId).toBe('call-1')
      await h.hook('PostToolUse', 'call-1')
      expect(h.pending()).toBeUndefined()
      expect(h.writes).toEqual(['1'])
    } finally { await h.client.dispose() }
  })

  it('retains a completed old response tuple across a new request while its original ACK is delayed', async () => {
    const h = await fixture()
    let release!: () => void
    let entered!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve })
    const original = h.owner.kernel.input as (...args: unknown[]) => Promise<unknown>
    h.owner.kernel.input = async (...args: unknown[]) => {
      const receipt = await original(...args); entered()
      await new Promise<void>(resolve => { release = resolve })
      return receipt
    }
    try {
      await h.hook('PermissionRequest', 'call-old')
      const response = h.reply()
      await inside
      const tuple = structuredClone(h.pending()!.response)
      await h.hook('PostToolUse', 'call-old')
      await h.hook('PermissionRequest', 'call-new')
      expect((await loadAgentSessions(h.store))[0]!.pendingInteraction).toMatchObject({
        request: { nativeToolCallId: 'call-old' }, response: tuple,
        nativeCompleted: { source: 'native-hook' }, additionalRequests: [{ nativeToolCallId: 'call-new' }]
      })
      release(); await response
      expect(h.pending()).toMatchObject({ request: { nativeToolCallId: 'call-new' } })
      expect(h.pending()).not.toHaveProperty('response')
      expect(h.writes).toEqual(['1'])
    } finally { release?.(); await h.client.dispose() }
  })
})

describe('typed bytes require the exact current input target', () => {
  it('retains the original unknown claim without input if native authority changes while persisting the first claim', async () => {
    const h = await fixture()
    try {
      await h.hook('PermissionRequest', 'claim-window')
      const provider = h.client.providers.get('codex'), prepare = provider.prepareInteractionResponse!
      let checks = 0
      provider.prepareInteractionResponse = async (...args) => ({ ...(await prepare(...args))!, verifyCurrentTarget: async () => ++checks === 1 })
      await expect(h.reply()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(checks).toBe(2); expect(h.writes).toEqual([])
      expect(h.pending()).toMatchObject({ request: { nativeToolCallId: 'claim-window' }, response: { acknowledged: false, inputByteRange: { startByte: 0, endByte: 1 } } })
    } finally { await h.client.dispose() }
  })
  it('refuses an early Hook when the Provider cannot confirm its target and keeps ordinary input usable', async () => {
    const h = await fixture()
    try {
      await h.hook('PermissionRequest', 'not-ready')
      h.client.providers.get('codex').prepareInteractionResponse = async () => null
      await expect(h.reply()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(h.writes).toEqual([])
      expect(h.pending()).not.toHaveProperty('response')
      await h.client.writeAgent({ agentSessionId: 'target-agent', expectedRun: { runId: 'target-run' }, source: 'user', data: 'ordinary' })
      expect(h.writes).toEqual(['ordinary'])
    } finally { await h.client.dispose() }
  })

  it.each(['request', 'native-call', 'source', 'input-fence', 'run', 'frame-run'] as const)('refuses a wrong %s target before claiming input', async wrong => {
    const h = await fixture()
    try {
      await h.hook('PermissionRequest', 'exact-call')
      const provider = h.client.providers.get('codex'), original = provider.prepareInteractionResponse!
      provider.prepareInteractionResponse = async (...args) => {
        const prepared = (await original(...args))! as AgentProviderPreparedInteractionResponse
        const target = { ...prepared.target }
        if (wrong === 'request') target.requestId = 'other-request'
        if (wrong === 'native-call') target.nativeToolCallId = 'other-call'
        if (wrong === 'source') target.nativeSourceId = ''
        if (wrong === 'input-fence') target.inputByte++
        if (wrong === 'run') target.run = { runId: 'other-run' }
        if (wrong === 'frame-run') target.frame = { ...target.frame, run: { runId: 'other-run' } }
        return { ...prepared, target }
      }
      await expect(h.reply()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(h.writes).toEqual([])
      expect(h.pending()).not.toHaveProperty('response')
    } finally { await h.client.dispose() }
  })

  it('rechecks the native source and current complete frame before possible bytes', async () => {
    const h = await fixture()
    try {
      await h.hook('PermissionRequest', 'recheck')
      const provider = h.client.providers.get('codex'), original = provider.prepareInteractionResponse!
      provider.prepareInteractionResponse = async (...args) => ({ ...(await original(...args))!, verifyCurrentTarget: async () => false })
      await expect(h.reply()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(h.writes).toEqual([])
      provider.prepareInteractionResponse = original
      h.owner.screenEvidence.currentCompleteFrame = () => null
      await expect(h.reply()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(h.writes).toEqual([])
    } finally { await h.client.dispose() }
  })

  it('raw input cancels an uncooperative final verifier before a typed claim', async () => {
    const h = await fixture()
    let entered!: () => void, release!: () => void
    const observed = new Promise<void>(resolve => { entered = resolve })
    const finish = new Promise<boolean>(resolve => { release = () => resolve(true) })
    try {
      await h.hook('PermissionRequest', 'final-verifier')
      const provider = h.client.providers.get('codex'), prepare = provider.prepareInteractionResponse!
      provider.prepareInteractionResponse = async (...args) => ({ ...(await prepare(...args))!, verifyCurrentTarget: async () => { entered(); return await finish } })
      const typed = h.reply().then(() => 'delivered', () => 'cancelled')
      await observed
      const raw = h.client.writeAgent({ agentSessionId: 'target-agent', expectedRun: { runId: 'target-run' }, source: 'user', data: 'raw' })
      const rawFinished = await Promise.race([raw.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
      expect(rawFinished, 'ordinary input waited for an unknown final verifier').toBe(true)
      expect(await typed).toBe('cancelled')
      expect(h.writes).toEqual(['raw'])
      expect(h.pending()).not.toHaveProperty('response')
    } finally { release?.(); await h.client.dispose() }
  })

  it('rejects a changed Runtime PID after the final Provider check without claiming bytes', async () => {
    const h = await fixture()
    try {
      await h.hook('PermissionRequest', 'final-pid')
      const provider = h.client.providers.get('codex'), prepare = provider.prepareInteractionResponse!
      provider.prepareInteractionResponse = async (...args) => ({ ...(await prepare(...args))!, verifyCurrentTarget: async () => {
        h.owner.kernel.status = async () => ({ ...h.run(), pid: 1000 }); return true
      } })
      await expect(h.reply()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(h.writes).toEqual([]); expect(h.pending()).not.toHaveProperty('response')
    } finally { await h.client.dispose() }
  })

  it('raw input can cancel an in-flight read-only preparation without waiting for it', async () => {
    const h = await fixture()
    let started!: () => void
    const observed = new Promise<void>(resolve => { started = resolve })
    try {
      await h.hook('PermissionRequest', 'waiting-target')
      h.client.providers.get('codex').prepareInteractionResponse = async context => {
        started()
        await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))
        return null
      }
      const result = h.reply().then(() => 'delivered', () => 'cancelled')
      await observed
      await h.client.writeAgent({ agentSessionId: 'target-agent', expectedRun: { runId: 'target-run' }, source: 'user', data: 'native' })
      expect(await result).toBe('cancelled')
      expect(h.writes).toEqual(['native'])
      expect(h.pending()).not.toHaveProperty('response')
    } finally { await h.client.dispose() }
  })
})

/** Observed native protocol: Pre has ID; adjacent Permission shares SID/turn/command but omits ID. */
describe('authenticated adjacent Hook tool identity', () => {
  const invocation = { nativeSessionId: 'native-exact', nativeTurnId: 'native-turn', nativeTranscriptPath: upstreamFixturePath("tmp/native-exact.jsonl"), nativeToolCallId: 'actual-call-1', toolName: 'Bash', toolInput: '{"command":"printf exact"}' }
  const pre = (event: string, call = 'actual-call-1', turn = 'native-turn') => ({ hook_event_name: event, session_id: 'native-exact', turn_id: turn, transcript_path: upstreamFixturePath("tmp/native-exact.jsonl"),
    tool_name: 'Bash', tool_input: { command: 'printf exact' }, ...(event === 'PreToolUse' ? { tool_use_id: call } : {}) })
  async function ingress(h: Awaited<ReturnType<typeof fixture>>, id: string, payload: Record<string, unknown>, runId = 'target-run') {
    await h.owner.acceptHookEvent({ receiptId: id, agentSessionId: 'target-agent', providerId: 'codex', runId, payload }, new AbortController().signal)
  }
  it('persists the actual Pre identity through Store, public inspect/context, strict RPC and compiled CLI before answering its adjacent Permission', async () => {
    const h = await fixture(), service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.client }] })
    let invalidInvocation = false
    const probe = new ObjectCliProbe(async request => {
      const value = await service.call(request.method as 'agent.inspect', request.params as any)
      if (invalidInvocation) (value as any).session.hookReceipt.toolInvocation.ambiguous = false
      return value
    })
    try {
      await ingress(h, 'actual-pre', pre('PreToolUse'))
      expect((await loadAgentSessions(h.store))[0]!.hookReceipt?.toolInvocation).toEqual(invocation)
      const root = await mkdtemp(join(tmpdir(), 'amx-hook-fact-'))
      try {
        const path = join(root, 'sessions.json'), file = new AgentMuxFileAgentSessionStore(path)
        const stored = (await loadAgentSessions(h.store))[0]!
        await file.compareAndSwap(null, stored)
        expect((await loadAgentSessions(new AgentMuxFileAgentSessionStore(path)))[0]!.hookReceipt?.toolInvocation).toEqual(invocation)
        await expect(file.compareAndSwap(stored, { ...stored, hookReceipt: { ...stored.hookReceipt!,
          toolInvocation: { ...invocation, ambiguous: false as any } } })).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
      } finally { await rm(root, { recursive: true, force: true }) }
      await probe.start()
      const result = await probe.run(['agent', 'inspect', '--session', 'target-agent'])
      expect(result.code).toBe(0)
      const output = JSON.parse(result.stdout)
      expect((output.result?.session ?? output.session).hookReceipt.toolInvocation).toEqual(invocation)
      const context = await probe.run(['agent', 'context', '--host', 'local', '--session', 'target-agent'])
      expect(context.code).toBe(0); expect(JSON.stringify(JSON.parse(context.stdout))).toContain('actual-call-1')
      invalidInvocation = true
      const invalid = await probe.run(['agent', 'inspect', '--session', 'target-agent'])
      expect(invalid.code).not.toBe(0); expect(invalid.stdout + invalid.stderr).toContain('CONTROL_PROTOCOL_ERROR')
      invalidInvocation = false
      await ingress(h, 'actual-permission', { ...pre('PermissionRequest'), tool_input: { command: 'printf exact', description: 'Native approval' } })
      expect(h.pending()?.request.nativeToolCallId).toBe('actual-call-1')
      await h.reply(); expect(h.writes).toEqual(['1'])
      expect(h.pending()?.response?.acknowledged).toBe(true)
      await ingress(h, 'actual-post', { ...pre('PostToolUse'), tool_use_id: 'actual-call-1', tool_response: 'done' })
      expect(h.pending()).toBeUndefined()
    } finally { await probe.stop(); await service.dispose(); await h.client.dispose() }
  }, 30_000)

  it.each(['missing-pre', 'missing-id', 'missing-turn', 'other-turn', 'other-source', 'other-transcript', 'other-command', 'other-tool', 'inserted-hook', 'wrong-run', 'concurrent-same-command', 'interleaved-starts', 'partial-completion', 'child-interruption'] as const)
  ('keeps an unbound Permission and healthy raw input with %s', async fault => {
    const h = await fixture()
    try {
      if (fault !== 'missing-pre') {
        const payload: Record<string, unknown> = pre('PreToolUse')
        if (fault === 'missing-id') delete payload.tool_use_id
        if (fault === 'missing-turn') delete payload.turn_id
        await ingress(h, 'actual-pre', payload)
      }
      if (fault === 'inserted-hook') await ingress(h, 'intervening', { hook_event_name: 'SubagentStart', session_id: 'native-exact', turn_id: 'native-turn' })
      if (fault === 'concurrent-same-command') {
        await ingress(h, 'second-pre', pre('PreToolUse', 'actual-call-2'))
        await ingress(h, 'third-pre', pre('PreToolUse', 'actual-call-3'))
        expect(h.client.agentSession('target-agent').hookReceipt?.toolInvocation?.ambiguous).toBe(true)
      }
      if (fault === 'interleaved-starts' || fault === 'partial-completion' || fault === 'child-interruption') {
        if (fault === 'interleaved-starts') await ingress(h, 'intervening', { hook_event_name: 'SubagentStart', session_id: 'native-exact' })
        await ingress(h, 'second-pre', pre('PreToolUse', 'actual-call-2'))
        if (fault === 'child-interruption') {
          await ingress(h, 'child-hook', { hook_event_name: 'PreToolUse', session_id: 'child-source', agent_id: 'child', turn_id: 'child-turn', tool_use_id: 'child-call', tool_name: 'Bash', tool_input: { command: 'printf child' } })
          await ingress(h, 'third-pre', pre('PreToolUse', 'actual-call-3'))
        }
        if (fault === 'partial-completion') {
          await ingress(h, 'partial-post', { ...pre('PostToolUse'), tool_use_id: 'actual-call-2' })
          await ingress(h, 'third-pre', pre('PreToolUse', 'actual-call-3'))
        }
        expect(h.client.agentSession('target-agent').hookReceipt?.toolInvocation?.ambiguous).toBe(true)
      }
      if (fault === 'wrong-run') {
        const stored = (await loadAgentSessions(h.store))[0]!
        await expect(h.store.compareAndSwap(stored, { ...stored, hookReceipt: { ...stored.hookReceipt!, run: { runId: 'other-run' } } })).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
        // The store itself must reject a foreign Run receipt; the direct Provider boundary also rejects it.
        const provider = h.client.providers.get('codex'), previous = h.client.agentSession('target-agent').hookReceipt!
        const normalized = provider.normalizeHook({ receiptId: 'direct-permission', agentSessionId: 'target-agent', providerId: 'codex', runId: 'target-run', payload: pre('PermissionRequest') },
          { nativeHandle: h.client.agentSession('target-agent').nativeHandle!, processNativeHandle: h.client.agentSession('target-agent').nativeHandle!, previousHookReceipt: { ...previous, run: { runId: 'other-run' } } })
        expect(normalized.interaction?.nativeToolCallId).toBeUndefined()
        await ingress(h, 'intervening', { hook_event_name: 'UserPromptSubmit', session_id: 'native-exact', turn_id: 'native-turn' })
      }
      const payload: Record<string, unknown> = pre('PermissionRequest')
      if (fault === 'missing-turn') delete payload.turn_id
      if (fault === 'other-turn') payload.turn_id = 'other-turn'
      if (fault === 'other-source') payload.session_id = 'other-source'
      if (fault === 'other-transcript') payload.transcript_path = upstreamFixturePath("tmp/other-source.jsonl")
      if (fault === 'other-command') payload.tool_input = { command: 'printf other' }
      if (fault === 'other-tool') payload.tool_name = 'OtherTool'
      await ingress(h, 'actual-permission', payload)
      expect(h.pending()?.request.nativeToolCallId).toBeUndefined()
      if (fault === 'other-source') {
        expect(h.pending()).toBeUndefined()
        expect(h.client.agentSession('target-agent').hookReceipt?.subject).toMatchObject({ kind: 'foreign' })
      } else {
        await expect(h.reply()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
        expect(h.pending()).not.toHaveProperty('response')
      }
      expect(h.writes).toEqual([])
      await h.client.writeAgent({ agentSessionId: 'target-agent', expectedRun: { runId: 'target-run' }, source: 'user', data: 'ordinary' })
      expect(h.writes).toEqual(['ordinary'])
    } finally { await h.client.dispose() }
  })

  it('binds repeated identical commands to their own adjacent IDs rather than an earlier candidate', async () => {
    const h = await fixture()
    try {
      for (const call of ['actual-call-1', 'actual-call-2']) {
        await ingress(h, call + '-pre', pre('PreToolUse', call))
        await ingress(h, call + '-permission', pre('PermissionRequest', call))
        expect(h.pending()?.request.nativeToolCallId).toBe(call)
        await h.reply()
        await ingress(h, call + '-post', { ...pre('PostToolUse'), tool_use_id: call })
        expect(h.pending()).toBeUndefined()
      }
      expect(h.writes).toEqual(['1', '1'])
    } finally { await h.client.dispose() }
  })
  it('withholds an inferred ID when another authenticated Hook wins the actual Permission CAS', async () => {
    const h = await fixture(), compare = h.store.compareAndSwap.bind(h.store)
    let changed = false
    try {
      await ingress(h, 'actual-pre', pre('PreToolUse'))
      h.store.compareAndSwap = async (expected, next, signal) => {
        if (!changed && next?.hookReceipt?.id === 'actual-permission') {
          changed = true
          // Another Core's normalized authenticated Hook wins the same durable
          // Store CAS. Do not recursively acquire this Core's per-Session lane.
          const normalized = h.client.providers.get('codex').normalizeHook({ receiptId: 'racing-hook', agentSessionId: 'target-agent', providerId: 'codex', runId: 'target-run',
            payload: { hook_event_name: 'UserPromptSubmit', session_id: 'native-exact', turn_id: 'native-turn' } },
          { nativeHandle: expected!.nativeHandle!, processNativeHandle: expected!.nativeHandle!, previousHookReceipt: expected!.hookReceipt! })
          await compare(expected, { ...expected!, hookReceipt: { ...expected!.hookReceipt!, id: 'racing-hook', eventName: normalized.eventName,
            ...(normalized.lifecycleEvent === undefined ? {} : { lifecycleEvent: normalized.lifecycleEvent }), observedAt: normalized.status.observedAt } })
        }
        await compare(expected, next, signal)
      }
      await ingress(h, 'actual-permission', pre('PermissionRequest'))
      expect(changed).toBe(true); expect(h.pending()?.request.nativeToolCallId).toBeUndefined()
      await expect(h.reply()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(h.writes).toEqual([]); expect(h.pending()).not.toHaveProperty('response')
    } finally { await h.client.dispose() }
  })
  it.each(['PermissionRequest', 'PostToolUse'] as const)
  ('retains another Core\'s observed ambiguity when a stale %s wins the next CAS', async eventName => {
    const h = await fixture(), compare = h.store.compareAndSwap.bind(h.store)
    let changed = false
    try {
      await ingress(h, 'actual-pre', pre('PreToolUse'))
      h.store.compareAndSwap = async (expected, next, signal) => {
        if (!changed && next?.hookReceipt?.id === 'stale-hook') {
          changed = true
          const normalized = h.client.providers.get('codex').normalizeHook({ receiptId: 'racing-pre', agentSessionId: 'target-agent', providerId: 'codex', runId: 'target-run',
            payload: pre('PreToolUse', 'actual-call-2') }, { nativeHandle: expected!.nativeHandle!, processNativeHandle: expected!.nativeHandle!, previousHookReceipt: expected!.hookReceipt! })
          await compare(expected, { ...expected!, hookReceipt: { ...expected!.hookReceipt!, id: 'racing-pre', eventName: normalized.eventName,
            toolInvocation: normalized.toolInvocation!, observedAt: normalized.status.observedAt } })
        }
        await compare(expected, next, signal)
      }
      await ingress(h, 'stale-hook', { ...pre(eventName), ...(eventName === 'PostToolUse' ? { tool_use_id: 'actual-call-1' } : {}) })
      expect(changed).toBe(true)
      expect(h.client.agentSession('target-agent').hookReceipt?.toolInvocation).toMatchObject({ nativeToolCallId: 'actual-call-2', ambiguous: true })
      if (eventName === 'PermissionRequest') expect(h.pending()?.request.nativeToolCallId).toBeUndefined()
      await ingress(h, 'third-pre', pre('PreToolUse', 'actual-call-3'))
      expect(h.client.agentSession('target-agent').hookReceipt?.toolInvocation?.ambiguous).toBe(true)
      await ingress(h, 'next-permission', pre('PermissionRequest'))
      expect(h.pending()?.request.nativeToolCallId).toBeUndefined()
      await expect(h.reply()).rejects.toMatchObject({ code: 'AGENT_INTERACTION_UNCONFIRMED' })
      expect(h.writes).toEqual([]); expect(h.pending()).not.toHaveProperty('response')
      await h.client.writeAgent({ agentSessionId: 'target-agent', expectedRun: { runId: 'target-run' }, source: 'user', data: 'ordinary' })
      expect(h.writes).toEqual(['ordinary'])
    } finally { await h.client.dispose() }
  })
})
