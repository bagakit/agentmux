import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentMuxClient as SourceClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore as SourceStore } from '../src/agent-session-store.js'
import { AgentMuxError as SourceError } from '../src/errors.js'
import { composeAgentResumePrompt } from '../src/agent-outbound-message.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxContinuityInputRequest } from '../src/agent-session-recovery/continuity-contract.js'


const owner = process.env.AGENTMUX_TEST_GUIDANCE_CORE ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_GUIDANCE_CORE)
  : { AgentMuxClient: SourceClient, AgentMuxFileAgentSessionStore: SourceStore, AgentMuxError: SourceError }
const { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxError } = owner as {
  AgentMuxClient: typeof SourceClient; AgentMuxFileAgentSessionStore: typeof SourceStore; AgentMuxError: typeof SourceError }
type AgentMuxClient = SourceClient

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const fresh: AgentMuxContinuityInputRequest = { submissionId: 'original-user-input', prompt: 'New user intent exactly.', agentMuxNote: 'Original platform context.', authorHuman: true, sourceChannel: 'api' }
async function fixture(options: { providerId?: 'codex' | 'claude' | 'gemini'; lostStart?: boolean; noRun?: boolean; failedStart?: boolean; postLaunch?: boolean } = {}) {
  const providerId = options.providerId ?? 'codex'
  const h = await rpcOwnerFixture(['recipient'], { AgentMuxClient, AgentMuxFileAgentSessionStore }, () => ({ providerId, executorId: providerId,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'native-original' } }))
  const core = h.client as any, originalProvider = h.client.providers.get(providerId)
  // This port's Start returns the plan verbatim, without the real adapter's
  // same-PID env wrapper. Its physical launch identity must describe that port.
  core.kernel.launchIdentity = ({ program, args }: { program: string; args: readonly string[] }) => ({ program,
    argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('base64url') })
  const provider = { ...originalProvider, catalog: { ...originalProvider.catalog, ...(options.postLaunch ? { promptDelivery: 'post-launch-only' as const } : {}) }, prepareManagedLaunch: async (plan: any) => ({ plan }) }
  h.client.providers.replace(provider)
  const previousRun = { runId: 'run-recipient' }, newRun = { runId: 'new-run' }
  const started: any[] = []
  const currentRun = () => ({ ...h.run(newRun.runId), program: started[0]?.program ?? provider.executable,
    args: started[0]?.args ?? [], lifecycleOperationId: started[0]?.operationKey ?? null })
  core.kernel.status = vi.fn(async (id: string) => id === previousRun.runId
    ? { ...h.run(id), state: { type: 'exited', code: 0, signal: null } } : currentRun())
  core.kernel.list = vi.fn(async () => options.noRun ? [] : started.length ? [currentRun()] : [])
  core.kernel.inspectCreation = vi.fn(async (operationKey: string) => options.noRun || started[0]?.operationKey !== operationKey ? null : currentRun())
  core.kernel.start = vi.fn(async (spec: any) => {
    if (options.failedStart) throw new AgentMuxError('Start rejected before creating a Run', 'CTXMUX_START_REJECTED', undefined, undefined, undefined,
      { operationId: spec.operationKey, disposition: 'not_applied' })
    started.push(spec)
    if (options.lostStart) throw new AgentMuxError('Start applied; original ACK lost', 'CTXMUX_START_UNKNOWN', undefined, { disposition: 'unknown', confirmedInputBytes: null })
    return currentRun()
  })
  core.probePreparedAgent = vi.fn(async () => ({ providerId, executable: provider.executable, installed: true, capabilities: provider.catalog.capabilities }))
  core.ensureTerminalHandshakeOrDegrade = async (session: any) => session
  core.hookServer.isRunning = () => true
  core.hookServer.createBinding = () => ({ bindingId: 'binding'.padEnd(43, 'B'), endpoint: { url: 'http://127.0.0.1:0', token: 'token'.padEnd(43, 'T') }, bindRun: async () => {}, close: async () => {} })
  vi.spyOn(core.screenEvidence, 'wait').mockResolvedValue(1)
  await core.registry.update('recipient', previousRun, (value: AgentMuxStoredAgentSession) => {
    const observedAt = Math.max(value.updatedAt + 1, Date.now())
    return { ...value, updatedAt: observedAt, semanticStatus: { state: 'working', source: 'native-hook', observedAt } }
  })
  const request = { agentSessionId: 'recipient', expectedRun: previousRun, operationId: 'original-resume', trigger: 'input' as const, input: fresh }
  const op = () => h.client.agentSession('recipient').continuityOperations?.[request.operationId]
  return { ...h, core, provider, request, op, started, currentRun, newRun }
}

it.each(['codex', 'claude', 'gemini'] as const)('carries the original fresh input by the actual Provider resume argv contract (%s)', async providerId => {
  const h = await fixture({ providerId })
  try {
    const result = await h.client.ensureAgentContinuity(h.request)
    expect(result.kind).toBe('resumed')
    const packet = h.op()!.launchInput!, composed = composeAgentResumePrompt(fresh.prompt, fresh.agentMuxNote)
    expect(packet).toMatchObject({ input: fresh, prompt: composed.text, state: 'launch-carried', delivery: 'launch',
      key: { kind: 'prompt', agentSessionId: 'recipient', expectedRun: h.newRun, submissionId: fresh.submissionId },
      receipt: { kind: 'runtime-launch', operationId: h.started[0].operationKey, run: h.newRun } })
    const nativeArgs = h.provider.buildResumeLaunch({ workspacePath: h.root, nativeHandle: { kind: 'provider', providerId, sessionId: 'native-original' }, prompt: composed.text, args: [], env: {} }).args
    expect(h.started[0].args).toEqual(nativeArgs)
    expect(h.core.kernel.input).not.toHaveBeenCalled()
    expect(h.op()!.recoveryInputs).toEqual({ reminder: '', continuation: '' })
    expect(await h.client.inspectAgentPromptSubmission(packet.key!)).toMatchObject({ launch: packet })
    await expect(h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: h.newRun, operationId: fresh.submissionId,
      prompt: fresh.prompt, execution: 'immediate', admissionIntent: { kind: 'manual-actor' } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_LAUNCH_CARRIED' })
    expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('reads the original launch key through the real public RPC input.inspect wire without fabricating a waiting journal ACK', async () => {
  const h = await fixture(), path = join(h.root, 'launch-input.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients }); let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await h.client.ensureAgentContinuity(h.request); await server.start()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
    const key = h.op()!.launchInput!.key!, inspected = await rpc.call('agent.input.inspect', { key })
    expect(inspected.record).toMatchObject({ agentSessionId: key.agentSessionId, run: key.expectedRun, launch: { key, state: 'launch-carried', input: fresh } })
    expect(inspected.input).toBeUndefined(); expect(inspected.record?.admission).toBeUndefined()
    const history = await h.store.loadTimeline('recipient')
    expect(history.items.find(item => item.id === 'prompt:' + fresh.submissionId)).toMatchObject({ content: fresh.prompt, authorHuman: true, sourceChannel: fresh.sourceChannel })
    expect(history.items.find(item => item.id === 'system-context:' + fresh.submissionId)).toMatchObject({ content: composeAgentResumePrompt(fresh.prompt, fresh.agentMuxNote).systemContext })
    expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await rpc?.dispose(); await server.stop(); await h.close() }
})

it('restores recent automatic work without carrying synthesized input in native resume argv', async () => {
  const h = await fixture()
  try {
    const { input: _fresh, ...startup } = h.request
    await h.client.ensureAgentContinuity({ ...startup, trigger: 'startup' })
    const op = h.op()!
    expect(op.newRun).toEqual(h.newRun)
    expect(op.interruption).toMatchObject({ support: 'provider', state: 'unknown' })
    expect(op.launchInput).toBeUndefined(); expect(op.recoveryDelivery).toBeUndefined()
    expect(op.recoveryInputs).toEqual({ reminder: '', continuation: '' })
    expect(h.started[0].args).toEqual(h.provider.buildResumeLaunch({ workspacePath: h.root,
      nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-original' }, args: [], env: {} }).args)
    expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('reconciles an applied Start with lost ACK from the original reservation and args into one new Client without another start or PTY input', async () => {
  const h = await fixture({ lostStart: true }); let next: AgentMuxClient | undefined
  try {
    expect((await h.client.ensureAgentContinuity(h.request)).kind).toBe('pending')
    const pending = h.op()!.launchInput!
    expect(pending.state).toBe('unknown'); expect(pending.key).toBeUndefined(); expect(pending.receipt).toBeUndefined()
    const prepared = await h.store.loadResumeCorrelation('recipient', pending.lifecycleOperationId)
    expect(prepared?.preparedSession?.continuity?.launchInput?.input).toEqual(fresh)
    next = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) })
    const core = next as any; await core.registry.load('local'); core.connected = true
    core.kernel.isConnected = () => true; core.kernel.list = h.core.kernel.list; core.kernel.inspectCreation = h.core.kernel.inspectCreation; core.kernel.status = h.core.kernel.status
    core.kernel.start = vi.fn(() => { throw new Error('An unknown Start must not repeat') }); core.kernel.input = vi.fn(() => { throw new Error('A launch must not repeat via PTY') })
    core.recovery.lifecycle.restoreReopenObservation = async () => {}; core.ensureTerminalHandshakeOrDegrade = h.core.ensureTerminalHandshakeOrDegrade
    const restored = await next.ensureAgentContinuity(h.request)
    expect(restored.kind, JSON.stringify(restored)).toBe('resumed')
    const packet = next.agentSession('recipient').continuityOperations!['original-resume']!.launchInput!
    expect(packet).toMatchObject({ input: fresh, digest: pending.digest, state: 'launch-carried', key: { expectedRun: h.newRun } })
    expect(await next.inspectAgentPromptSubmission(packet.key!)).toMatchObject({ launch: packet })
    expect((await h.store.loadTimeline('recipient')).items.find(item => item.id === 'prompt:' + fresh.submissionId)).toMatchObject({ content: fresh.prompt, authorHuman: true, sourceChannel: fresh.sourceChannel })
    expect(h.started).toHaveLength(1); expect(core.kernel.start).not.toHaveBeenCalled(); expect(core.kernel.input).not.toHaveBeenCalled()
  } finally { await next?.dispose(); await h.close() }
})

it.each(['runtime', 'provider'] as const)('retains the same frozen fresh input across an initial %s observation failure', async observation => {
  const h = await fixture()
  try {
    if (observation === 'runtime') h.core.kernel.status.mockRejectedValueOnce(new Error('Original Runtime observation failed'))
    else h.core.probePreparedAgent.mockRejectedValueOnce(new Error('Original Provider observation failed'))
    expect((await h.client.ensureAgentContinuity(h.request)).kind).toBe('pending')
    expect(h.op()!.launchInput).toMatchObject({ state: 'prepared', input: fresh })
    expect(h.started).toHaveLength(0)
    expect((await h.client.ensureAgentContinuity(h.request)).kind).toBe('resumed')
    expect(h.op()!.launchInput).toMatchObject({ state: 'launch-carried', input: fresh, key: { submissionId: fresh.submissionId } })
    expect(h.started).toHaveLength(1); expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('keeps the original launch proof after a lost lifecycle commit ACK and a new reader', async () => {
  const h = await fixture(); let reader: AgentMuxClient | undefined
  try {
    const commit = h.store.commitLifecycle.bind(h.store)
    vi.spyOn(h.store, 'commitLifecycle').mockImplementationOnce(async (...args) => { await commit(...args); throw new Error('Original durable commit ACK lost') })
    await h.client.ensureAgentContinuity(h.request)
    reader = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) })
    const core = reader as any; await core.registry.load('local'); core.connected = true; core.kernel.isConnected = () => true
    core.kernel.status = h.core.kernel.status
    const packet = reader.agentSession('recipient').continuityOperations!['original-resume']!.launchInput!
    expect(packet.state).toBe('launch-carried')
    expect(await reader.inspectAgentPromptSubmission(packet.key!)).toMatchObject({ launch: { input: fresh, key: packet.key } })
    expect(h.started).toHaveLength(1); expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await reader?.dispose(); await h.close() }
})

it('allows a distinct explicit intent after a confirmed not-applied Start without replaying the old input', async () => {
  const h = await fixture()
  try {
    h.core.kernel.start.mockImplementationOnce(async (spec: any) => { throw new AgentMuxError('Original Start was not applied', 'START_REJECTED', undefined, undefined, undefined,
      { operationId: spec.operationKey, disposition: 'not_applied' }) })
    expect((await h.client.ensureAgentContinuity(h.request)).kind).toBe('pending')
    expect(h.op()!.launchInput?.state).toBe('not-applied')
    const next = { ...h.request, operationId: 'explicit-new-op', input: { ...fresh, submissionId: 'explicit-new-input', prompt: 'Explicit new body' } }
    expect((await h.client.ensureAgentContinuity(next)).kind).toBe('resumed')
    expect(h.started).toHaveLength(1); expect(h.started[0].args).toContain(composeAgentResumePrompt(next.input.prompt, next.input.agentMuxNote).text)
    expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it.each(['foreign-operation', 'input-receipt', 'unknown-start'] as const)('keeps frozen continuity input unknown for a %s creation failure', async kind => {
  const h = await fixture()
  try {
    h.core.kernel.start.mockImplementationOnce(async (spec: any) => { throw new AgentMuxError('Original Start has no exact negative receipt', 'START_UNCONFIRMED', undefined,
      kind === 'input-receipt' ? { disposition: 'not_applied', confirmedInputBytes: 0 } : undefined, undefined,
      kind === 'input-receipt' ? undefined : { operationId: kind === 'foreign-operation' ? 'another-start' : spec.operationKey,
        disposition: kind === 'unknown-start' ? 'unknown' : 'not_applied' }) })
    expect((await h.client.ensureAgentContinuity(h.request)).kind).toBe('pending')
    expect(h.op()!.launchInput).toMatchObject({ state: 'unknown', input: fresh })
    const packet = h.op()!.launchInput!
    expect((await h.store.loadResumeCorrelation('recipient', packet.lifecycleOperationId))?.preparedSession).toBeDefined()
    expect((await h.client.ensureAgentContinuity(h.request)).kind).toBe('pending')
    expect(h.core.kernel.start).toHaveBeenCalledTimes(1)
    expect(h.core.kernel.input).not.toHaveBeenCalled(); expect(h.core.kernel.stop).not.toHaveBeenCalled()
    expect((await h.store.readMetadata('recipient'))!.run).toEqual(h.request.expectedRun)
  } finally { await h.close() }
})

it('keeps admitted deferred input unknown when its error carries a creation receipt', async () => {
  const h = await fixture({ postLaunch: true })
  try {
    const input = h.core.kernel.input
    h.core.kernel.input = vi.fn(async (...args: any[]) => {
      await input(...args)
      throw new AgentMuxError('The input result is unknown despite an unrelated Start receipt', 'INPUT_UNCONFIRMED', undefined, undefined, undefined,
        { operationId: h.started[0].operationKey, disposition: 'not_applied' })
    })
    await h.client.ensureAgentContinuity(h.request)
    expect(h.op()!.launchInput?.state).toBe('unknown')
    await h.client.ensureAgentContinuity(h.request)
    expect(h.op()!.launchInput?.state).toBe('unknown')
    expect(h.started).toHaveLength(1); expect(h.core.kernel.input).toHaveBeenCalledTimes(1)
    expect(h.core.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('does not adopt different Runtime arguments while reconciling an unknown original launch', async () => {
  const h = await fixture({ lostStart: true })
  try {
    await h.client.ensureAgentContinuity(h.request)
    h.core.kernel.inspectCreation = vi.fn(async () => ({ ...h.currentRun(), args: ['resume', 'foreign-native', 'Another body'] }))
    expect((await h.client.ensureAgentContinuity(h.request)).kind).toBe('pending')
    expect(h.op()!.launchInput?.key).toBeUndefined(); expect(h.started).toHaveLength(1)
    expect(h.core.kernel.input).not.toHaveBeenCalled(); expect(h.core.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('does not interpret a missing retained creation as permission to repeat an unknown original Start', async () => {
  const h = await fixture({ lostStart: true, noRun: true })
  try {
    await h.client.ensureAgentContinuity(h.request); await h.client.ensureAgentContinuity(h.request)
    expect(h.started).toHaveLength(1); expect(h.op()!.launchInput?.key).toBeUndefined(); expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('does not reconcile an unknown original launch to another lifecycle operation with identical launch arguments', async () => {
  const h = await fixture({ lostStart: true })
  try {
    await h.client.ensureAgentContinuity(h.request)
    const foreignRun = { ...h.currentRun(), runId: 'foreign-run', lifecycleOperationId: 'foreign-lifecycle-operation' }
    h.core.kernel.inspectCreation = vi.fn(async () => foreignRun)
    const result = await h.client.ensureAgentContinuity(h.request)
    expect(result).toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed' })
    expect(h.client.agentSession('recipient').run).toEqual(h.request.expectedRun)
    expect(h.op()!.launchInput).toMatchObject({ state: 'unknown', input: fresh })
    expect(h.op()!.launchInput?.key).toBeUndefined(); expect(h.op()!.launchInput?.receipt).toBeUndefined()
    expect((await h.store.readMetadata('recipient'))!.run).toEqual(h.request.expectedRun)
    expect(h.started).toHaveLength(1); expect(h.core.kernel.input).not.toHaveBeenCalled(); expect(h.core.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it.each(['body', 'source'] as const)('rejects changed %s under the original prepared input identity', async change => {
  const h = await fixture({ lostStart: true })
  try {
    await h.client.ensureAgentContinuity(h.request)
    await expect(h.client.ensureAgentContinuity({ ...h.request, input: { ...fresh, ...(change === 'body' ? { prompt: 'Another body' } : { sourceChannel: 'cli' as const }) } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect(h.started).toHaveLength(1); expect(h.op()!.launchInput?.input).toEqual(fresh)
  } finally { await h.close() }
})

it('keeps the second concurrent fresh intent distinct from the one original launch winner', async () => {
  const h = await fixture()
  try {
    const [winner, loser] = await Promise.all([h.client.ensureAgentContinuity(h.request), h.client.ensureAgentContinuity({ ...h.request, operationId: 'second-op', input: { ...fresh, submissionId: 'second-input', prompt: 'Second authored intent' } })])
    expect(winner.kind).toBe('resumed'); expect(loser.kind).toBe('conflict')
    expect(loser.continuity?.launchInput?.state).toBe('not-applied'); expect(loser.continuity?.launchInput?.key).toBeUndefined(); expect(h.started).toHaveLength(1)
    expect(h.started[0].args).toContain(composeAgentResumePrompt(fresh.prompt, fresh.agentMuxNote).text)
  } finally { await h.close() }
})

it('does not add a fresh input to a healthy Run already won by ordinary startup', async () => {
  const h = await fixture()
  try {
    const { input: _fresh, ...startup } = h.request
    await h.client.ensureAgentContinuity({ ...startup, trigger: 'startup', policy: { reminderMode: 'off', continuationEnabled: false } })
    const freshResult = await h.client.ensureAgentContinuity({ ...h.request, operationId: 'fresh-loser' })
    expect(freshResult.kind).toBe('conflict'); expect(freshResult.continuity?.launchInput?.state).toBe('not-applied'); expect(freshResult.continuity?.launchInput?.key).toBeUndefined()
    expect(h.started).toHaveLength(1); expect(h.core.kernel.input).not.toHaveBeenCalled(); expect(h.core.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it.each(['fresh', 'plain-startup'] as const)('preserves both original decisions under two FileStore clients competing with a %s winner', async winnerKind => {
  const h = await fixture(); let other: AgentMuxClient | undefined, release = () => {}, winning: ReturnType<AgentMuxClient['ensureAgentContinuity']> | undefined
  try {
    other = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) })
    const core = other as any; await core.registry.load('local'); core.connected = true
    core.kernel.isConnected = () => true
    for (const key of ['status', 'list', 'input', 'identity']) core.kernel[key] = h.core.kernel[key]
    core.probePreparedAgent = h.core.probePreparedAgent; core.ensureTerminalHandshakeOrDegrade = h.core.ensureTerminalHandshakeOrDegrade
    core.hookServer.isRunning = h.core.hookServer.isRunning; core.hookServer.createBinding = h.core.hookServer.createBinding
    const start = h.core.kernel.start, entered = Promise.withResolvers<void>(), blocked = new Promise<void>(resolve => { release = resolve })
    h.core.kernel.start = vi.fn(async (spec: any) => { const result = await start(spec); entered.resolve(); await blocked; return result })
    core.kernel.start = vi.fn(() => { throw new Error('Another Client cannot start over the original lease') })
    const { input: _fresh, ...startup } = h.request
    winning = h.client.ensureAgentContinuity(winnerKind === 'fresh' ? h.request : { ...startup, trigger: 'startup', policy: { reminderMode: 'off', continuationEnabled: false } })
    await entered.promise
    const losing = await other.ensureAgentContinuity({ ...h.request, operationId: 'other-client-op', input: { ...fresh, submissionId: 'other-client-input', prompt: 'Other original body' } })
    expect(losing.kind).toBe('conflict'); expect(losing.continuity?.launchInput?.key).toBeUndefined(); expect(losing.continuity?.launchInput?.receipt).toBeUndefined()
    release(); expect((await winning).kind).toBe('resumed')
    const stored = (await h.store.readMetadata('recipient'))!
    expect(stored.continuityOperations!['other-client-op']).toMatchObject({ kind: 'conflict', launchInput: { input: { submissionId: 'other-client-input', prompt: 'Other original body' } } })
    expect(stored.continuityOperations!['original-resume']!.newRun).toEqual(h.newRun)
    expect(h.started).toHaveLength(1); expect(core.kernel.start).not.toHaveBeenCalled(); expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { release(); await winning?.catch(() => {}); await other?.dispose(); await h.close() }
})

it('does not replace a same-op frozen input when two pending observations race in different FileStore clients', async () => {
  const h = await fixture(); let other: AgentMuxClient | undefined
  try {
    other = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) })
    const core = other as any; await core.registry.load('local'); core.connected = true; core.kernel.isConnected = () => true
    const barrier = Promise.withResolvers<void>(); let observed = 0
    const status = vi.fn(async () => { if (++observed === 2) barrier.resolve(); await barrier.promise; throw new Error('Same original Runtime observation unavailable') })
    core.kernel.status = status; h.core.kernel.status = status
    const inputB = { ...fresh, prompt: 'Another pending authored body' }
    const results = await Promise.allSettled([h.client.ensureAgentContinuity(h.request), other.ensureAgentContinuity({ ...h.request, input: inputB })])
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(item => item.status === 'rejected')).toMatchObject([{ reason: { code: 'AGENT_PROMPT_OPERATION_CONFLICT' } }])
    const winner = results.findIndex(item => item.status === 'fulfilled')
    expect((await h.store.readMetadata('recipient'))!.continuityOperations!['original-resume']!.launchInput?.input).toEqual(winner === 0 ? fresh : inputB)
    expect(h.started).toHaveLength(0); expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await other?.dispose(); await h.close() }
})

it('continues the original post-launch-only input after a lost Start ACK through its real original owner', async () => {
  const h = await fixture({ postLaunch: true, lostStart: true })
  try {
    expect((await h.client.ensureAgentContinuity(h.request)).kind).toBe('pending')
    expect(h.core.kernel.input).not.toHaveBeenCalled()
    expect((await h.client.ensureAgentContinuity(h.request)).kind).toBe('resumed')
    expect(h.op()!.launchInput).toMatchObject({ state: 'terminal-confirmed', key: { submissionId: fresh.submissionId, expectedRun: h.newRun } })
    expect(h.started).toHaveLength(1); expect(h.core.kernel.input).toHaveBeenCalledTimes(2)
    const record = await h.client.inspectAgentPromptSubmission(h.op()!.launchInput!.key!)
    expect(record?.admission).toMatchObject({ submissionId: fresh.submissionId, acknowledged: true, intent: { prompt: h.op()!.launchInput!.prompt, message: h.op()!.launchInput!.message } })
    expect(record?.terminalPromptSubmission).toMatchObject({ payload: { acknowledged: true }, submit: { acknowledged: true } })
  } finally { await h.close() }
})

it('rejoins a committed unclaimed deferred packet on the same operation instead of returning a permanent prepared dead end', async () => {
  const h = await fixture({ postLaunch: true })
  try {
    vi.spyOn(h.core, 'deliverPostLaunchPrompt').mockResolvedValueOnce(false)
    await h.client.ensureAgentContinuity(h.request)
    expect(h.op()!.launchInput?.state).toBe('prepared'); expect(h.core.kernel.input).not.toHaveBeenCalled()
    // No submission owner was entered, so this original packet is still known
    // unsent. Unknown is reserved for an admitted claim with an unconfirmed result.
    expect((await h.client.inspectAgentPromptSubmission(h.op()!.launchInput!.key!))?.admission).toBeUndefined()
    await h.client.ensureAgentContinuity(h.request)
    expect(h.op()!.launchInput?.state).toBe('terminal-confirmed')
    expect(h.started).toHaveLength(1); expect(h.core.kernel.input).toHaveBeenCalledTimes(2)
  } finally { await h.close() }
})

it('only inspects an existing unknown deferred input and never enters its submission owner again', async () => {
  const h = await fixture({ postLaunch: true })
  try {
    const input = h.core.kernel.input
    h.core.kernel.input = vi.fn(async (...args: any[]) => { await input(...args); throw new AgentMuxError('Applied payload ACK lost', 'CTXMUX_INPUT_UNKNOWN', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
    await h.client.ensureAgentContinuity(h.request)
    expect(h.op()!.launchInput?.state).toBe('unknown'); expect(h.core.kernel.input).toHaveBeenCalledTimes(1)
    const submit = vi.spyOn(h.core.promptSubmission, 'submitInputPlan')
    await h.client.ensureAgentContinuity(h.request)
    expect(submit).not.toHaveBeenCalled(); expect(h.core.kernel.input).toHaveBeenCalledTimes(1)
    expect(h.op()!.launchInput?.state).toBe('unknown'); expect(h.core.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('projects only the original exact deferred refusal as not-applied without submitting again', async () => {
  const h = await fixture({ postLaunch: true })
  try {
    h.core.kernel.input = vi.fn(async () => { throw new AgentMuxError('Original payload rejected before any bytes', 'CTXMUX_INPUT_NOT_APPLIED', 'not_applied',
      { disposition: 'not_applied', confirmedInputBytes: 0 }) })
    await h.client.ensureAgentContinuity(h.request)
    const packet = h.op()!.launchInput!, record = await h.client.inspectAgentPromptSubmission(packet.key!)
    expect(record?.admission).toMatchObject({ acknowledged: false, notApplied: true, inputKey: packet.key,
      intent: { prompt: packet.prompt, message: packet.message } })
    const submit = vi.spyOn(h.core.promptSubmission, 'submitInputPlan')
    await h.client.ensureAgentContinuity(h.request)
    expect(h.op()!.launchInput).toMatchObject({ state: 'not-applied', key: packet.key, input: fresh })
    expect(submit).not.toHaveBeenCalled(); expect(h.core.kernel.input).toHaveBeenCalledTimes(1)
    expect((await h.store.readMetadata('recipient'))!.continuityOperations!['original-resume']!.launchInput?.state).toBe('not-applied')
    const inspect = vi.spyOn(h.client, 'inspectAgentPromptSubmission').mockRejectedValue(new Error('Later observation unavailable'))
    await h.client.ensureAgentContinuity(h.request)
    expect(h.op()!.launchInput?.state).toBe('not-applied'); expect(inspect).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled(); expect(h.core.kernel.input).toHaveBeenCalledTimes(1)
    expect(h.core.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})

it('does not replay a deferred claim when a second FileStore owner holds a stale unclaimed observation', async () => {
  const h = await fixture({ postLaunch: true, lostStart: true }); let other: AgentMuxClient | undefined
  const firstRead = Promise.withResolvers<void>(), secondRead = Promise.withResolvers<void>(), releaseFirst = Promise.withResolvers<void>(), releaseSecond = Promise.withResolvers<void>()
  let first: ReturnType<AgentMuxClient['ensureAgentContinuity']> | undefined, second: ReturnType<AgentMuxClient['ensureAgentContinuity']> | undefined
  try {
    await h.client.ensureAgentContinuity(h.request)
    const input = h.core.kernel.input
    h.core.kernel.input = vi.fn(async (...args: any[]) => { await input(...args); throw new AgentMuxError('Original deferred ACK lost', 'CTXMUX_INPUT_UNKNOWN', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
    const inspect = h.client.inspectAgentPromptSubmission.bind(h.client)
    vi.spyOn(h.client, 'inspectAgentPromptSubmission').mockImplementationOnce(async key => { const value = await inspect(key); firstRead.resolve(); await releaseFirst.promise; return value })
    first = h.client.ensureAgentContinuity(h.request); await firstRead.promise
    other = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path) })
    const core = other as any; await core.registry.load('local'); core.connected = true; core.kernel.isConnected = () => true
    for (const key of ['status', 'list', 'input', 'identity']) core.kernel[key] = h.core.kernel[key]
    const read = other.inspectAgentPromptSubmission.bind(other)
    vi.spyOn(other, 'inspectAgentPromptSubmission').mockImplementationOnce(async key => { const value = await read(key); secondRead.resolve(); await releaseSecond.promise; return value })
    second = other.ensureAgentContinuity(h.request); await secondRead.promise
    releaseFirst.resolve(); await first
    expect(h.core.kernel.input).toHaveBeenCalledTimes(1)
    releaseSecond.resolve(); await second
    expect(h.core.kernel.input).toHaveBeenCalledTimes(1)
    expect((await h.store.readMetadata('recipient'))!.continuityOperations!['original-resume']!.launchInput?.state).toBe('unknown')
    expect(h.started).toHaveLength(1)
  } finally { releaseFirst.resolve(); releaseSecond.resolve(); await first?.catch(() => {}); await second?.catch(() => {}); await other?.dispose(); await h.close() }
})

it('uses the original submission ID and real terminal owner for post-launch-only input', async () => {
  const h = await fixture({ postLaunch: true })
  try {
    await h.client.ensureAgentContinuity(h.request)
    expect(h.started[0].args).not.toContain(composeAgentResumePrompt(fresh.prompt, fresh.agentMuxNote).text)
    expect(h.op()!.launchInput).toMatchObject({ state: 'terminal-confirmed', delivery: 'post-launch', key: { submissionId: fresh.submissionId, expectedRun: h.newRun } })
    const record = await h.client.inspectAgentPromptSubmission(h.op()!.launchInput!.key!)
    expect(record?.admission).toMatchObject({ submissionId: fresh.submissionId, acknowledged: true, intent: { prompt: h.op()!.launchInput!.prompt, message: h.op()!.launchInput!.message } })
    expect(record?.terminalPromptSubmission).toMatchObject({ payload: { acknowledged: true }, submit: { acknowledged: true } })
    expect(record?.launch).toBeUndefined(); expect(h.core.kernel.input).toHaveBeenCalledTimes(2)
  } finally { await h.close() }
})

it('lists only the newly accepted launch in the original mailbox without fabricating controlled waiting', async () => {
  const h = await fixture()
  try {
    await h.client.ensureAgentContinuity(h.request)
    const key = h.op()!.launchInput!.key!, page = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ kind: 'item', item: { kind: 'submission', key,
      record: { launch: { key, input: fresh, state: 'launch-carried', receipt: { kind: 'runtime-launch', run: h.newRun } } } } })
    expect(await h.client.inspectAgentInput({ key })).toBeNull()
    await expect(h.client.stopAgentInputWaiting({ ref: { key, waitGeneration: 1 }, cancelOperationId: 'not-a-wait' })).rejects.toMatchObject({ code: 'AGENT_INPUT_NOT_FOUND' })
    const before = h.started.length
    await h.client.ensureAgentContinuity(h.request)
    expect(h.started).toHaveLength(before)
    expect((await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })).items).toHaveLength(1)
    expect(h.core.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})
