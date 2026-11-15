import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, access, mkdir, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { defineRun } from '../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js'
import { AgentMuxClient } from '../../../packages/core/src/client.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { AgentMuxFileAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { AgentProviderRegistry, type AgentProviderPromptExecutionContext } from '../../../packages/core/src/agent-provider.js'
import { readCodexPromptExecutionEvidence } from '../../../packages/core/src/providers/codex-prompt-execution-evidence.js'
import { observeCodexSessionStatus } from '../../../packages/core/src/providers/codex-session-status.js'
import { readGrokPromptExecutionEvidence } from '../../../packages/core/src/providers/grok-history.js'
import { encodeCwdDirname } from '../../../packages/providers/src/grok/native-history.js'
import { grokUser } from '../../../packages/core/test/fixtures/grok-updates.js'
import { captureExecutorInvocation } from '../../../packages/core/src/agent-executor-invocation.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import { createContinuityInputDelivery } from '../../../packages/core/src/agent-session-recovery/input.js'
import { createGoalRuntime } from '../src/goal-runtime.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { deliverContinuousProgress } from '../src/continuous-progress-delivery.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../../../packages/core/src/types.js'

const closes: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function restored(providerId: 'codex' | 'grok' = 'codex', options: { missingOldRun?: boolean; sdkEnv?: boolean; ended?: boolean; oneShot?: boolean } = {}) {
  const root = process.env.RESTORED_FUTURE_ROOT ?? await mkdtemp(join(tmpdir(), 'amux-future-resume-')), reopen = process.env.RESTORED_FUTURE_STAGE === 'restore'
  closes.push(async () => { if (!process.env.RESTORED_FUTURE_ROOT) { await rm(root, { recursive: true, force: true }); await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' }); if (process.env.RESTORED_FUTURE_CLEANUP) await appendFile(process.env.RESTORED_FUTURE_CLEANUP, JSON.stringify({ root, absent: true, pid: process.pid }) + '\n') } })
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const transcriptPath = join(root, 'original-rollout.jsonl')
  if (!reopen) await writeFile(transcriptPath, [ { type: 'session_meta', payload: { id: 'original-native', cwd: root } },
    { type: 'event_msg', ordinal: 1, payload: { type: 'task_started', turn_id: 'old-working-turn' } } ].map(row => JSON.stringify(row)).join('\n') + '\n')
  if (!reopen && options.ended) await appendFile(transcriptPath, JSON.stringify({ type: 'event_msg', ordinal: 2, payload: { type: 'task_complete', turn_id: 'old-working-turn' } }) + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const old: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId, executorId: providerId, hostId: 'local',
    workspacePath: root, run: { runId: 'old-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'old-binding', hookToken: 'old-token',
    nativeHandle: { kind: 'provider', providerId, sessionId: 'original-native', ...(providerId === 'codex' ? { transcriptPath } : {}) } }
  const originalEnv = { GROK_HOME: join(root, 'retained-private-profile'), HOME: join(root, 'retained-home') }
  if (providerId === 'grok') {
    const directory = join(originalEnv.GROK_HOME, 'sessions', encodeCwdDirname(root), 'original-native')
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'original-native', cwd: root } }))
    await writeFile(join(directory, 'updates.jsonl'), JSON.stringify(grokUser('original-native', 'Original unfinished turn', 'old-working-turn')) + '\n')
    const invocation = captureExecutorInvocation(providerId, providerId, 'original-create', 'b'.repeat(64), { env: originalEnv })!
    old.creation = { createOperationId: 'original-create', initialPrompt: 'not-requested', intentDigest: 'b'.repeat(64), executorInvocationDigest: invocation.digest }; old.executorInvocation = invocation.value
    vi.stubEnv('GROK_HOME', join(root, 'unrelated-current-profile'))
  }
  if (!reopen) await store.compareAndSwap(null, old)
  const { observeSessionStatus: _watch, discoverNativeSession: _discover, prepareNativeInput: _native, ...builtin } = new AgentProviderRegistry().get(providerId), send = vi.fn(async () => ({ outcome: 'admitted' as const, queuedSubmissionId: 'original-queued' }))
  const verifyNative = vi.fn(async () => {})
  const queueInput = async (context: unknown, target: { providerId: string; nativeSessionId: string; idleOnly?: boolean }) => {
      return { plan: { kind: 'native-rpc' as const, protocolId: 'private-original-queue', actorId: 'original-actor', sourceId: JSON.stringify([target.providerId,target.nativeSessionId]),
        threadId: target.nativeSessionId, operation: target.idleOnly ? 'queue-idle' as const : 'start-or-steer' as const }, assertCurrent: verifyNative, send, dispose: async () => {} }
    }
  const provider = { ...builtin,
    readPromptExecutionEvidence: vi.fn(providerId === 'codex' ? readCodexPromptExecutionEvidence : readGrokPromptExecutionEvidence), ...(providerId === 'codex' ? { prepareNativeInput: queueInput } : {}) }
  const core = new AgentMuxClient({ store, providers: [provider] }); closes.push(() => core.dispose())
  const inner = core as unknown as { connected: boolean; registry: { load(host: string): Promise<void> }; kernel: Record<string, any>; hookServer: Record<string, any>; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown }
  await inner.registry.load('local'); inner.connected = true
  let byte = 17
  let oldMissing = false
  const run = (id: string) => ({ runId: id, lifecycleOperationId: null, nativeService: null, program: 'codex', args: [], workspacePath: root, pid: id === 'old-run' ? null : 321,
    state: id === 'old-run' ? { type: 'exited', exitCode: 1, signal: null } : { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: byte })
  let originalSpec: any
  const start = vi.fn(async (spec: any) => { originalSpec = spec; return { ...run('resumed-run'), program: spec.program, args: spec.args, lifecycleOperationId: spec.operationKey } })
  Object.assign(inner.kernel, { isConnected: () => true, identity: () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 22, buildIdentity: 'controlled-runtime' }),
    creationRuntimeIdentity: () => ({ runtimeId: 'private-runtime', instanceId: 'private-daemon', protocolVersion: 22, buildIdentity: 'controlled-runtime' }),
    status: vi.fn(async (id: string) => { if (oldMissing && id === 'old-run') throw new AgentMuxError('The original Runtime no longer retains this old process.', 'CTXMUX_run_not_found'); return { ...run(id), ...(id === 'resumed-run' && originalSpec ? { program: originalSpec.program, args: originalSpec.args, lifecycleOperationId: originalSpec.operationKey } : {}) } }), start, stop: vi.fn(),
    input: vi.fn(async (id: string, operation: any) => { expect(operation.expectedByte).toBe(byte); const startByte = byte; byte += Buffer.byteLength(operation.data); return { run: run(id), appliedByteRange: { startByte, endByte: byte } } }), readRunEnvironment: async () => ({}) })
  inner.kernel.launchIdentity = ({ program, args }: any) => ({ program, argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('base64url') })
  inner.kernel.prepareStart = ({ program, args, cwd, env }: any) => defineRun(program, { args, cwd, env, initialSize: { cols: 80, rows: 24 } })
  inner.kernel.startPrepared = (request: any, operationKey: string) => start({ ...request, operationKey })
  inner.kernel.inspectPreparedStart = async () => null
  if (providerId === 'grok') { Object.defineProperty(inner.hookServer, 'port', { value: 0 }); await inner.hookServer.start() }
  else {
    inner.hookServer.isRunning = () => true
    inner.hookServer.createBinding = (_agent: string, _provider: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  }
  vi.spyOn(core as unknown as { probePreparedAgent: typeof core.probeAgent }, 'probePreparedAgent').mockResolvedValue({ providerId, executable: providerId, installed: true, capabilities: provider.catalog.capabilities })
  inner.ensureManagedHooks = async () => {}; inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  const runtime = createGoalRuntime({ clients: () => [{ hostId: 'local', client: core }], checkIn: async () => ({ known: false, reason: 'No quiet check-in in this fixture' }) })
  let now = Date.now()
  const manager = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(root, 'schedule.json')), (...args) => deliverContinuousProgress(runtime, ...args), () => now,
    runtime.observeContinuousProgress, runtime)
  closes.push(() => manager.stop()); await manager.start()
  const created = reopen ? { schedule: manager.list()[0]! } : await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: old.agentSessionId, providerId: old.providerId, workspacePath: root },
    operationId: 'original-arrangement', ...(options.oneShot ? { afterMs: 60_000 } : { everyMs: 60_000 }), prompt: 'Original saved heartbeat' }, { principal: { kind: 'user', id: 'private-person' } })
  const loop = created.schedule
  oldMissing = options.missingOldRun === true
  const recovery = reopen ? { kind: 'resumed' as const } : await core.ensureAgentContinuity({ agentSessionId: old.agentSessionId, expectedRun: old.run, operationId: 'original-resume', trigger: 'manual',
    ...(options.sdkEnv ? { env: { ...originalEnv, ORIGINAL_RESUME_MARKER: 'retained-sdk-source' } } : {}), policy: { continuationEnabled: false, reminderMode: 'off' } })
  if (options.missingOldRun) {
    expect(recovery.kind).toBe('pending'); expect(start).not.toHaveBeenCalled()
    const context = await Reflect.get(core, 'providerNativeContext').call(core, core.agentSession(old.agentSessionId))
    const evidence = await provider.readPromptExecutionEvidence(context)
    expect(evidence?.state).toBe('working'); expect(context.env).toEqual(originalEnv); expect(context.processId).toBeUndefined()
    return { root, core, store, runtime, manager, loop, resumed: core.agentSession(old.agentSessionId), old, send, start, provider, inner, transcriptPath, originalEnv, verifyNative, advance: () => { now = loop.nextCheckAt; return now }, changeByte: () => { byte++ } }
  }
  expect(recovery.kind, JSON.stringify(recovery)).toBe('resumed')
  const resumed = core.agentSession(old.agentSessionId)
  expect(resumed.run.runId).toBe('resumed-run'); expect(resumed.nativePromptPredecessor?.previousRun).toEqual(old.run)
  expect(resumed.semanticStatus).toBeUndefined(); expect(resumed.currentActivity).toBeUndefined()
  const evidence = await provider.readPromptExecutionEvidence({ args: [], env: originalEnv, workspacePath: root, nativeHandle: resumed.nativeHandle!, nativePromptPredecessor: resumed.nativePromptPredecessor! })
  expect(evidence?.state).toBe('idle'); expect(evidence?.nativeTurnId).toBeUndefined()
  return { root, core, store, runtime, manager, loop, resumed, old, send, start, provider, inner, transcriptPath, originalEnv, verifyNative, advance: () => { now = loop.nextCheckAt; return now }, changeByte: () => { byte++ } }
}
it('the original lifecycle restored initial idle admits the exact next Host due without a completed new turn', async () => {
  const f = await restored(); await f.manager.check(f.advance(), f.loop.loopId)
  expect(f.manager.inspectLoop(f.loop.loopId), JSON.stringify({ loop: f.manager.inspectLoop(f.loop.loopId), sends: f.send.mock.calls.length })).toMatchObject({ status: 'active', lastOutcome: 'sent' })
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.core.agentSession(f.old.agentSessionId).semanticStatus).toBeUndefined()
})
it('the real schedule service and source CLI read the same original restored-due input without sending another request', async () => {
  const f = await restored(); await f.manager.check(f.advance(), f.loop.loopId)
  const loop = f.manager.inspectLoop(f.loop.loopId)!, reference = loop.lastInputRef!
  expect(loop.lastOutcome).toBe('sent')
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.core }], schedules: f.manager }); closes.push(() => service.dispose())
  const probe = new ObjectCliProbe(request => service.call(request.method as any, request.params as any)); await probe.start(); closes.push(async () => { await probe.stop(); await expect(access(probe.root)).rejects.toMatchObject({ code: 'ENOENT' }) })
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'schedule', 'inspect', '--data', '-'], probe.environment(), JSON.stringify({ scheduleId: loop.loopId }))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.input.reference).toEqual(reference)
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledTimes(1)
})
it.skipIf(!process.env.RESTORED_FUTURE_STAGE)('isolated original owner restart stage retains the exact schedule and input custody', async () => {
  const f = await restored(), witness = join(f.root, 'owner-stage.json'), factsPath = process.env.RESTORED_FUTURE_FACTS!
  if (process.env.RESTORED_FUTURE_STAGE === 'seed') {
    await f.manager.check(f.advance(), f.loop.loopId)
    const loop = f.manager.inspectLoop(f.loop.loopId)!
    expect(loop.lastOutcome).toBe('sent'); expect(f.send).toHaveBeenCalledTimes(1)
    const record = await f.core.inspectAgentPromptSubmission(loop.lastInputRef!.inputKey)
    await writeFile(witness, JSON.stringify({ loop, record, session: f.core.agentSession(f.old.agentSessionId), pid: process.pid }))
    await appendFile(factsPath, JSON.stringify({ stage: 'seed', pid: process.pid, loopId: loop.loopId, key: loop.lastInputRef!.inputKey, writes: f.send.mock.calls.length }) + '\n')
  } else {
    const original = JSON.parse(await readFile(witness, 'utf8')), loop = f.manager.inspectLoop(f.loop.loopId)!
    expect(process.pid).not.toBe(original.pid); expect(loop).toEqual(original.loop)
    expect(f.core.agentSession(f.old.agentSessionId).run).toEqual(original.session.run)
    expect(await f.core.inspectAgentPromptSubmission(loop.lastInputRef!.inputKey)).toEqual(original.record)
    await f.manager.check(loop.nextCheckAt, loop.loopId)
    expect(f.send).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
    expect(f.manager.inspectLoop(loop.loopId)).toMatchObject({ status: 'active', lastOutcome: 'skipped', lastInputRef: original.loop.lastInputRef })
    await appendFile(factsPath, JSON.stringify({ stage: 'restore', pid: process.pid, previousPid: original.pid, loopId: loop.loopId, key: loop.lastInputRef!.inputKey, starts: f.start.mock.calls.length, writes: f.send.mock.calls.length, reseed: false }) + '\n')
  }
})
it('cold resume retains the original id-only native source environment when the old process is absent', async () => {
  const f = await restored('grok')
  expect(f.resumed.nativePromptPredecessor?.run).toEqual(f.resumed.run)
})
it('a missing old Runtime Run keeps recovery unconfirmed and its finite reader uses only retained environment', async () => {
  const f = await restored('grok', { missingOldRun: true })
  expect(f.resumed.run).toEqual(f.old.run); expect(f.start).not.toHaveBeenCalled()
})
it('native observation of a later SDK resume uses that original resume environment', async () => {
  const f = await restored('grok', { sdkEnv: true }); f.provider.readPromptExecutionEvidence.mockClear()
  const reading = await f.core.readAgentInputActivity({ kind: 'prompt', agentSessionId: f.old.agentSessionId, expectedRun: f.resumed.run, submissionId: 'exact-new-future' })
  expect(reading.state).toBe('idle')
  expect(f.provider.readPromptExecutionEvidence.mock.calls.at(-1)![0].env).toMatchObject({ ORIGINAL_RESUME_MARKER: 'retained-sdk-source' })
})
it('a changed original Host Executor revision does not lend its current environment to native evidence', async () => {
  const f = await restored('grok'), before = (await f.store.readMetadata(f.old.agentSessionId))!
  await f.store.compareAndSwapMetadata(before, { ...before, creation: { ...before.creation!, executorRevision: 'a'.repeat(64) } })
  const resolve = vi.fn(async () => ({ descriptor: { configRevision: 'b'.repeat(64) }, config: { providerId: 'grok', env: { GROK_HOME: '/unrelated-current-source' } } }))
  Reflect.set(f.core, 'hostExecutorOwner', { resolve }); f.provider.readPromptExecutionEvidence.mockClear()
  const reading = await f.core.readAgentInputActivity({ kind: 'prompt', agentSessionId: f.old.agentSessionId, expectedRun: f.resumed.run, submissionId: 'exact-new-future' })
  expect(reading.state).toBe('unconfirmed'); expect(resolve).toHaveBeenCalledTimes(1); expect(f.provider.readPromptExecutionEvidence).not.toHaveBeenCalled()
})
it('a genuine Grok SessionStart qualifies only original main initialization and lets source-bound initial due use its PTY contract', async () => {
  const f = await restored('grok'), current = (await f.store.readMetadata(f.old.agentSessionId))!
  const endpoint = f.inner.hookServer.getEndpoint()
  const response = await fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${current.hookToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId: 'original-main-start', eventName: 'session_start', payload: { hookEventName: 'session_start', sessionId: 'original-native' } }) })
  expect(response.status, await response.text()).toBe(204)
  await vi.waitFor(async () => expect((await f.store.readMetadata(f.old.agentSessionId))?.hookReceipt?.id).toBe('original-main-start'))
  const started = (await f.store.readMetadata(f.old.agentSessionId))!
  expect(started.nativeBinding?.source).toBe('native-hook')
  expect(started.semanticStatus?.state).not.toBe('working')
  expect(started.semanticStatus?.state).not.toBe('done')
  await f.manager.check(f.advance(), f.loop.loopId)
  expect(f.manager.inspectLoop(f.loop.loopId), JSON.stringify(f.manager.inspectLoop(f.loop.loopId))).toMatchObject({ status: 'active', lastOutcome: 'sent' })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled()
})
it.each(['bytes', 'source', 'working', 'disabled', 'recovery-delivery', 'permission'] as const)('a changed %s between Host observation and Core claim sends nothing and keeps future checks active', async change => {
  const f = await restored(), original = f.runtime.submitPrompt
  f.runtime.submitPrompt = async (...args) => {
    if (change === 'bytes') f.changeByte()
    else if (change === 'source') {
      const { rename } = await import('node:fs/promises'), replacement = join(f.root, 'replacement.jsonl')
      const { readFile } = await import('node:fs/promises'); await writeFile(replacement, await readFile(f.transcriptPath)); await rename(replacement, f.transcriptPath)
    } else if (change === 'working') {
      const { appendFile } = await import('node:fs/promises'); await appendFile(f.transcriptPath, JSON.stringify({ type: 'event_msg', ordinal: 2, payload: { type: 'task_started', turn_id: 'new-user-turn' } }) + '\n')
    } else if (change === 'disabled') {
      const saved = (await f.core.readAgentFuturePromptIntent(f.old.agentSessionId, f.loop.futureIntentId!))!
      await f.core.saveAgentFuturePromptIntent({ agentSessionId: f.old.agentSessionId, intentId: f.loop.futureIntentId!, operationId: saved.operationId,
        prompt: saved.message.userContent!, ...(saved.message.systemContext === undefined ? {} : { agentMuxNote: saved.message.systemContext }), active: false })
    } else if (change === 'permission') {
      const before = (await f.store.readMetadata(f.old.agentSessionId))!
      await f.store.compareAndSwapMetadata(before, { ...before, pendingInteraction: { request: { kind: 'permission', id: 'current-permission', agentSessionId: before.agentSessionId,
        title: 'Original permission', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }], evidence: { source: 'native-hook', hookReceiptId: 'current-permission', run: before.run, observedAt: 1 } } } })
    } else {
      const before = (await f.store.readMetadata(f.old.agentSessionId))!, operation = { ...before.continuityOperations!['original-resume']!, interruptedWorking: true,
        recoveryInputs: { reminder: '', continuation: 'Original retained continuation' } }
      const delivery = createContinuityInputDelivery(operation, 17)!
      expect(delivery).toBeDefined(); delivery.phase = 'unknown'
      await f.store.compareAndSwapMetadata(before, { ...before, continuityOperations: { ...before.continuityOperations,
        [operation.operationId]: { ...operation, recoveryDelivery: delivery } } })
    }
    return await original(...args)
  }
  await f.manager.check(f.advance(), f.loop.loopId)
  expect(f.send).not.toHaveBeenCalled()
  expect(f.manager.inspectLoop(f.loop.loopId), JSON.stringify(f.manager.inspectLoop(f.loop.loopId))).toMatchObject({ status: 'active', lastOutcome: 'skipped' })
})
it('a current unknown input retains its original key and body without being retried by the next future occurrence', async () => {
  const f = await restored(); f.inner.kernel.input.mockRejectedValueOnce(new Error('Original PTY ACK is unavailable'))
  const unknown = await f.core.submitAgentPrompt({ agentSessionId: f.old.agentSessionId, expectedRun: f.resumed.run, operationId: 'unknown-original',
    prompt: 'Original unknown question', execution: 'immediate', admissionIntent: { kind: 'manual-actor' }, authorHuman: true })
  await vi.waitFor(async () => expect(await f.core.inspectAgentInput({ key: (unknown as any).key })).toMatchObject({ status: 'unknown' }), { timeout: 5000 })
  const key = { kind: 'prompt' as const, agentSessionId: f.old.agentSessionId, expectedRun: f.resumed.run, submissionId: 'unknown-original' }
  const original = await f.core.inspectAgentPromptSubmission(key)
  expect(original?.admission?.acknowledged).toBe(false)
  await f.manager.check(f.advance(), f.loop.loopId)
  expect(await f.core.inspectAgentPromptSubmission(key)).toEqual(original)
  expect(f.send).not.toHaveBeenCalled(); expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  expect(f.manager.inspectLoop(f.loop.loopId)).toMatchObject({ status: 'active', lastOutcome: 'skipped' })
})
it.each(['working', 'ended'] as const)('two original no-input restores retain the raw %s predecessor without publishing it as the new Run turn', async state => {
  const f = await restored('codex', { ended: state === 'ended' }), status = f.inner.kernel.status
  const previous = f.core.agentSession(f.old.agentSessionId).nativePromptPredecessor?.evidenceId
  f.inner.kernel.status = async (id: string) => id === f.resumed.run.runId ? { ...await status(id), state: { type: 'exited', exitCode: 1, signal: null } } : await status(id)
  f.start.mockImplementation(async (spec: any) => ({ ...await status('next-resumed-run'), runId: 'next-resumed-run', program: spec.program, args: spec.args, lifecycleOperationId: spec.operationKey }))
  const next = await f.core.ensureAgentContinuity({ agentSessionId: f.old.agentSessionId, expectedRun: f.resumed.run, operationId: 'second-no-input-resume', trigger: 'manual', policy: { continuationEnabled: false, reminderMode: 'off' } })
  expect(next.kind, JSON.stringify(next)).toBe('resumed')
  const current = f.core.agentSession(f.old.agentSessionId)
  expect(current.nativePromptPredecessor?.evidenceId).toBe(previous)
  expect(await readCodexPromptExecutionEvidence({ args: [], workspacePath: f.root, nativeHandle: current.nativeHandle!, nativePromptPredecessor: current.nativePromptPredecessor! })).toMatchObject({ state: 'idle' })
  const onStatus = vi.fn(), signal = new AbortController()
  const observation = await observeCodexSessionStatus({ args: [], workspacePath: f.root, nativeHandle: current.nativeHandle!, nativePromptPredecessor: current.nativePromptPredecessor!,
    signal: signal.signal, onStatus, onUnavailable: vi.fn() })
  closes.push(() => { signal.abort(); observation.dispose() }); expect(onStatus).not.toHaveBeenCalled()
  expect(current.semanticStatus).toBeUndefined(); expect(f.send).not.toHaveBeenCalled()
})
it('a confirmed no-input refusal leaves a later independent occurrence eligible without replaying the original operation', async () => {
  const f = await restored()
  f.verifyNative.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Original native source observation is temporarily unavailable'))
  await f.manager.check(f.advance(), f.loop.loopId)
  const first = f.manager.inspectLoop(f.loop.loopId)!, key = first.lastInputRef!.inputKey
  const original = await f.core.inspectAgentPromptSubmission(key)
  expect(original?.admission?.notApplied).toBe(true); expect(f.send).not.toHaveBeenCalled(); expect(first.status).toBe('active')
  expect(first.nextCheckAt).toBe(f.loop.nextCheckAt + first.everyMs!)
  await f.manager.check(first.nextCheckAt - 1, first.loopId)
  expect(f.manager.inspectLoop(first.loopId)).toEqual(first)
  await f.manager.check(first.nextCheckAt + first.everyMs!, first.loopId)
  expect(f.send, JSON.stringify(f.manager.inspectLoop(first.loopId))).toHaveBeenCalledTimes(1)
  expect(f.manager.inspectLoop(first.loopId)?.lastInputRef!.inputKey.submissionId).not.toBe(key.submissionId)
  expect(await f.core.inspectAgentPromptSubmission(key)).toEqual(original)
})
it('a rejected one-shot retains its exact Core claim and remains available for recovery', async () => {
  const f = await restored('codex', { oneShot: true })
  f.verifyNative.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Original native source observation is temporarily unavailable'))
  const due = f.advance()
  await f.manager.check(due, f.loop.loopId)
  const original = f.manager.inspectLoop(f.loop.loopId)!
  expect(original).toMatchObject({ status: 'paused', nextCheckAt: due, pendingCompletion: { futureIntent: { occurrenceAt: due } } })
  const key = original.lastInputRef!.inputKey
  expect(original.pendingCompletion?.operationId).toBe(key.submissionId)
  expect((await f.core.inspectAgentPromptSubmission(key))?.admission?.notApplied).toBe(true)
  await f.manager.check(due + 60_000, f.loop.loopId)
  expect(f.manager.inspectLoop(f.loop.loopId)).toEqual(original)
  expect(f.send).not.toHaveBeenCalled()
})
it('a paused original arrangement does not read native activity or send due input', async () => {
  const f = await restored(), activity = vi.spyOn(f.core, 'readAgentInputActivity')
  await f.manager.call('schedule.pause', { scheduleId: f.loop.loopId, expectedRevision: f.loop.revision!, operationId: 'explicit-pause' })
  await f.manager.check(f.advance(), f.loop.loopId)
  expect(activity).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.manager.inspectLoop(f.loop.loopId)?.status).toBe('paused')
})
it('ordinary completion-driven progress does not gain initial-idle eligibility', async () => {
  const f = await restored(), activity = vi.spyOn(f.core, 'readAgentInputActivity')
  const { decideContinuousProgress } = await import('../../../packages/core/src/continuous-progress.js')
  const observation = await f.runtime.observeContinuousProgress({ hostId: 'local', agentSessionId: f.old.agentSessionId, providerId: f.old.providerId, workspacePath: f.root }, 'ordinary-tick', Date.now())
  expect(decideContinuousProgress(observation)).toEqual({ kind: 'skip', reason: 'unknown-status' }); expect(activity).not.toHaveBeenCalled()
})
it('an existing completed future boundary keeps its original strict current-activity requirement', async () => {
  const f = await restored('grok'), before = (await f.store.readMetadata(f.old.agentSessionId))!, now = Date.now()
  await f.store.compareAndSwapMetadata(before, { ...before, updatedAt: now, semanticStatus: { state: 'done', source: 'native-hook', observedAt: now, nativeTurnId: 'original-completed-turn' } })
  const fact = { state: 'unknown', source: 'native-hook', sourceId: 'original-source', nativeSessionId: 'original-native', sequence: 1, run: f.resumed.run, observedAt: now }
  // The original live-observation port is deliberately unknown while the saved
  // completion remains present; neither fact may substitute for the other.
  Reflect.get(f.core, 'nativeCurrentActivities').set(f.old.agentSessionId, { event: fact, fact, runId: f.resumed.run.runId, admissionId: undefined })
  const saved = (await f.core.readAgentFuturePromptIntent(f.old.agentSessionId, f.loop.futureIntentId!))!
  let issue: unknown
  await f.core.submitAgentPrompt({ agentSessionId: f.old.agentSessionId, expectedRun: f.resumed.run, operationId: 'original-completion-future', afterSubmissionId: null,
    prompt: saved.message.userContent!, ...(saved.message.systemContext === undefined ? {} : { agentMuxNote: saved.message.systemContext }), expectedInputByte: 17,
    expectedFutureIntent: { intentId: f.loop.futureIntentId!, occurrenceAt: f.loop.nextCheckAt } }).catch(error => { issue = error })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  expect(issue).toMatchObject({ code: 'AGENT_PROMPT_PREPARATION_FAILED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
  expect(JSON.parse((issue as AgentMuxError).detail!).code).toBe('AGENT_TURN_END_UNCONFIRMED')
})
it.each(['working', 'not-ready', 'not-running'] as const)('an original %s observation does not add a native source read', async state => {
  const f = await restored(), value = await f.core.statusAgent(f.old.agentSessionId), activity = vi.spyOn(f.core, 'readAgentInputActivity')
  vi.spyOn(f.core, 'statusAgent').mockResolvedValue({ ...value, observation: { ...value.observation,
    ...(state === 'working' ? { semantic: 'active' as const } : state === 'not-ready' ? { readiness: 'unknown' as const } : { process: 'exited' as const }) } })
  await f.runtime.observeContinuousProgress({ ...f.loop }, 'read-only-probe', Date.now())
  expect(activity).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
})
it.each(['codex', 'grok'] as const)('a later real working fact while the final %s evidence read is held vetoes the original claimed future input', async providerId => {
  const f = await restored(providerId), read = f.provider.readPromptExecutionEvidence.getMockImplementation()!
  let changed = false
  f.provider.readPromptExecutionEvidence.mockImplementation(async context => {
    const evidence = await read(context)
    const current = (await f.store.readMetadata(f.old.agentSessionId))!
    if (!changed && current.promptCompletionAdmission) {
      changed = true
      await f.store.compareAndSwapMetadata(current, { ...current, updatedAt: Date.now(), semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now() } })
    }
    return evidence
  })
  await f.manager.check(f.advance(), f.loop.loopId)
  expect(changed).toBe(true); expect(f.send).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
