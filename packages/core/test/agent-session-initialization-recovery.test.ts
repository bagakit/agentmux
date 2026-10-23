import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, type AgentMuxAgentCreateInput } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import { cloneSession } from '../src/agent-session-identity.js'
import { nativeInputSourceId } from '../src/native-input-correlation.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentTerminalFrontendObservation, AgentTerminalInitialization } from '../src/agent-terminal-frontend.js'
import { parseRpcAgentSession } from '../src/rpc-native-codec.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { normalizeAgentContinuityPolicy, type AgentMuxContinuityOperation } from '../src/agent-session-recovery/continuity-contract.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** Actual Core create, Runtime and durable submission owner. Only Provider native protocol leaves are controlled. */
async function fixture(options: { unknownInput?: boolean; preparation?: Promise<void>; preparing?(): void; asserting?(check: number): Promise<void>; explicitContinuation?: boolean; readyAtCreation?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-initial-input-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let diagnostic = ''; daemon.stderr!.on('data', bytes => { diagnostic += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const closed = once(daemon, 'exit'); daemon.kill('SIGTERM'); await closed }
    await rm(root, { recursive: true, force: true })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(diagnostic) })])
  const observations = new Map<string, (value: AgentTerminalFrontendObservation) => void>()
  const phases = new Map<string, AgentTerminalInitialization['phase']>()
  const sends: Array<{ text: string; correlation: string; threadId: string }> = []
  const provider = defineAgentProvider({ catalog: { id: 'initialization-process', label: 'Controlled native process',
    executable: process.execPath, expectedProcess: 'node', promptDelivery: 'positional-argv',
    readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, hookStrategy: { kind: 'none' },
    resumeStrategy: options.readyAtCreation ? { kind: 'provider-native', locator: 'session-id' } : { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: Boolean(options.readyAtCreation), replyCorrelation: 'none' } },
    buildArgs: (prompt, args) => [...args, prompt], hook: { rules: [] },
    ...(options.readyAtCreation ? { assertNativeResumeSource: async () => {}, listNativeSessions: async () => [] } : {}),
    buildResumeArgs: (id, _path, prompt, args) => [...args, 'resume', id, ...(prompt ? ['--', prompt] : [])] })
  const observation = (actor: NonNullable<AgentMuxStoredAgentSession['nativeActor']>): AgentTerminalFrontendObservation => {
    const phase = phases.get(actor.actorId) ?? (options.readyAtCreation ? 'ready' : 'failed')
    return { frontendId: 'frontend-' + actor.actorId, state: 'starting', backendState: 'running', source: 'managed-process', observedAt: Date.now(),
      initialization: { lifecycleOperationId: actor.lifecycleOperationId, phase,
        native: phase === 'ready' ? { state: 'confirmed', sessionId: 'original-native' } : phase === 'unknown' ? { state: 'unknown' } : { state: 'not-created' },
        ...(phase === 'failed' ? { failure: { step: 'preflight', code: -32041, message: 'Original account preflight failed' } as const } : {}) } }
  }
  provider.prepareManagedLaunch = async (plan, lifecycleOperationId) => ({ promptDelivery: 'post-launch',
    nativeActor: { protocolId: 'controlled-native', actorId: randomBytes(8).toString('hex'), token: randomBytes(32).toString('hex'),
      lifecycleOperationId, frontendControl: true, initializationControl: true, launch: { command: plan.command, args: plan.args } },
    plan: { ...plan, args: ['-e', "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));console.log('HEALTHY_BACKEND');setInterval(()=>{},1000)"] } })
  provider.observeTerminalFrontend = async context => {
    observations.set(context.nativeActor.actorId, context.onFrontend)
    context.onFrontend(observation(context.nativeActor))
    return { dispose() { if (observations.get(context.nativeActor.actorId) === context.onFrontend) observations.delete(context.nativeActor.actorId) } }
  }
  provider.prepareNativeInput = async (context, target) => {
    options.preparing?.(); await options.preparation
    let assertions = 0
    return {
      plan: { kind: 'native-rpc', protocolId: 'controlled-native', sourceId: nativeInputSourceId(target), actorId: context.nativeActor!.actorId,
        threadId: target.nativeSessionId, operation: 'start-or-steer' },
      async assertCurrent() {
        context.signal.throwIfAborted()
        if (options.asserting) await options.asserting(++assertions)
        context.signal.throwIfAborted()
      }, dispose() {},
      async send(text, frozen) {
        sends.push({ text, correlation: frozen.clientCorrelation!, threadId: frozen.threadId })
        if (options.unknownInput) throw new Error('Original native input response lost')
        return { outcome: 'admitted', turnId: 'original-turn' }
      }
    }
  }
  const clients: Array<{ client: AgentMuxClient; inner: any }> = []
  const storePath = join(root, 'sessions.sqlite')
  async function reader() {
    const store = new AgentMuxFileAgentSessionStore(storePath), client = new AgentMuxClient({ store, providers: [provider] }), inner = client as any
    Object.defineProperty(inner.hookServer, 'port', { value: 0 })
    await client.connect(); clients.push({ client, inner })
    // These tests select this exact input caller's authority, independently of
    // the recovery service's separate passive producer and its own authority.
    if (options.explicitContinuation) vi.spyOn(inner.recovery, 'observe').mockImplementation(() => {})
    return { store, client, inner, nativeStart: inner.kernel.start.bind(inner.kernel),
      start: vi.spyOn(inner.kernel, 'start'), bytes: vi.spyOn(inner.kernel, 'input'), stop: vi.spyOn(inner.kernel, 'stop') }
  }
  const original = await reader()
  cleanups.push(async () => {
    for (const { client, inner } of clients.slice().reverse()) {
      if (inner.kernel.isConnected()) for (const run of await inner.kernel.list()) if (run.state.type === 'running') await inner.kernel.stop(await inner.kernel.prepareStop(run.runId))
      await client.dispose()
    }
  })
  const request: AgentMuxAgentCreateInput = { createOperationId: 'original-create', providerId: provider.id, executorId: 'original-executor',
    workspacePath: root, injectAgentMuxGuide: false, prompt: 'PRIVATE_ORIGINAL_INITIAL_BODY' }
  const sid = await original.client.resolveAgentCreationSessionId(request.createOperationId!)
  const read = async (id = sid, owner = original) => (await owner.store.readMetadata(id))!
  const create = (changes: Partial<AgentMuxAgentCreateInput> = {}, owner = original) => owner.client.createAgentWithDelivery({ ...request, ...changes })
  async function ready(id = sid, owner = original) {
    const saved = await read(id, owner), actor = saved.nativeActor!
    phases.set(actor.actorId, 'ready')
    const next = await owner.inner.updateExactAgentSession(id, saved.run, (current: AgentMuxStoredAgentSession) => ({ ...current,
      nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' }, updatedAt: current.updatedAt + 1 }))
    observations.get(actor.actorId)?.(observation(actor))
    return next as AgentMuxStoredAgentSession
  }
  async function advance(session: AgentMuxStoredAgentSession, owner = original, assertCurrent?: () => Promise<void>) {
    return await owner.inner.recovery.ports.input.continueInitialInput(session, await owner.inner.kernel.status(session.run.runId), assertCurrent) as AgentMuxStoredAgentSession
  }
  return { ...original, request, sid, root, provider, sends, phases, observations, read, create, ready, advance, reader }
}

it('freezes the original input before Start, binds only the actual Run, and keeps failed bootstrap prepared without claiming or leaking its body', async () => {
  const f = await fixture()
  let beforeStart: { seed: NonNullable<Awaited<ReturnType<typeof f.store.loadCreationCorrelation>>>['preparedCreation']; args: string[] } | undefined
  // A spy wraps the actual Runtime Start; inspect the durable seed at that exact boundary.
  f.start.mockImplementation(async (input: any) => {
    const seed = (await f.store.loadCreationCorrelation(f.sid))!.preparedCreation!
    beforeStart = { seed, args: structuredClone(input.args) }
    return await f.nativeStart(input)
  })
  const created = await f.create(), saved = await f.read()
  expect(beforeStart!.seed!.initialInput).toMatchObject({ state: 'prepared', delivery: 'post-launch', input: { prompt: f.request.prompt } })
  expect(beforeStart!.seed!.initialInput!.key).toBeUndefined(); expect(beforeStart!.seed!.creation!.initialInputKey).toBeUndefined()
  expect(JSON.stringify(beforeStart!.args)).not.toContain(f.request.prompt)
  expect(saved.initialInput).toMatchObject({ state: 'prepared', key: created.creation.initialInputKey })
  expect(created.creation.initialInputKey?.expectedRun).toEqual(created.session.run)
  expect(created.promptConfirmed).toBe(false); expect(f.sends).toHaveLength(0); expect(f.bytes).not.toHaveBeenCalled()
  expect(await f.client.inspectAgentPromptSubmission(created.creation.initialInputKey!)).toBeNull()
  expect(JSON.stringify(created.session)).not.toContain(f.request.prompt)
  expect(created.session).not.toHaveProperty('initialInput'); expect(cloneSession(saved)).not.toHaveProperty('initialInput')
  expect(parseRpcAgentSession(created.session).creation?.initialInputKey).toEqual(created.creation.initialInputKey)
  expect(() => parseRpcAgentSession({ ...created.session, initialInput: saved.initialInput })).toThrow()
  const hosted = await hostedTestClient(f.client); cleanups.push(hosted.dispose)
  const inspection = await hosted.sdk.inspectAgentCreation(f.sid)
  expect(inspection.kind).toBe('agent')
  if (inspection.kind !== 'agent') throw new Error('Expected the original creation')
  expect(inspection.creation?.initialInputKey).toEqual(created.creation.initialInputKey)
  expect(JSON.stringify(inspection)).not.toContain(f.request.prompt)
  expect(inspection).not.toHaveProperty('initialInput')
  expect(await hosted.sdk.inspectAgentPromptSubmission(created.creation.initialInputKey!)).toBeNull()
  expect(f.stop).not.toHaveBeenCalled()
})

it('admits the same frozen input through the existing native submission owner exactly once, while its TUI remains starting', async () => {
  const f = await fixture(), created = await f.create(), saved = await f.ready()
  const [one, two] = await Promise.all([f.advance(saved), f.advance(saved)])
  expect(one.initialInput?.state).toBe('native-admitted'); expect(two.initialInput?.state).toBe('native-admitted')
  expect(f.sends).toEqual([{ text: saved.initialInput!.prompt, correlation: expect.any(String), threadId: 'original-native' }])
  const receipt = await f.client.inspectAgentPromptSubmission(created.creation.initialInputKey!)
  expect(receipt?.admission).toMatchObject({ transport: 'native', acknowledged: true, inputKey: created.creation.initialInputKey,
    native: { outcome: 'admitted' }, intent: { prompt: saved.initialInput!.prompt, message: saved.initialInput!.message } })
  expect((await f.read()).creation?.initialPrompt).toBe('confirmed')
  expect(f.client.agentSession(f.sid).terminalFrontend?.state).toBe('starting')
  expect(f.bytes).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledTimes(1)
})

it('retains an unknown native claim across Client reattachment, then accepts its late original receipt without sending another input', async () => {
  const f = await fixture({ unknownInput: true }), created = await f.create(), saved = await f.ready()
  expect((await f.advance(saved)).initialInput?.state).toBe('unknown'); expect(f.sends).toHaveLength(1)
  const revoked = vi.fn(async () => { throw new Error('This obsolete dispatch authority must not be invoked by a receipt-only read') })
  expect((await f.advance(await f.read(), f, revoked)).initialInput?.state).toBe('unknown')
  expect(revoked).not.toHaveBeenCalled(); expect(f.sends).toHaveLength(1)
  await f.client.dispose()
  const reader = await f.reader(), retained = await f.read(f.sid, reader)
  expect((await f.advance(retained, reader)).initialInput?.state).toBe('unknown'); expect(f.sends).toHaveLength(1)
  const original = (await reader.client.inspectAgentPromptSubmission(created.creation.initialInputKey!))!, late = structuredClone(original)
  if (late.admission?.transport !== 'native') throw new Error('Expected the original native claim')
  late.admission.acknowledged = true; late.admission.native = { ...late.admission.native, outcome: 'admitted', turnId: 'late-original-turn' }
  await reader.store.settlePromptAdmission(original, late)
  expect((await f.advance(retained, reader)).initialInput?.state).toBe('native-admitted')
  expect(f.sends).toHaveLength(1); expect(reader.bytes).not.toHaveBeenCalled()
})

it.each(['stop', 'cancel'] as const)('checks the original authority after native preparation: an accepted %s prevents dispatch and leaves ordinary input available', async action => {
  const prepared = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await fixture({ preparation: release.promise, preparing: prepared.resolve, explicitContinuation: true })
  const created = await f.create(), saved = await f.ready(), run = await f.inner.kernel.status(saved.run.runId)
  const operationId = 'original-input-recovery'
  if (action === 'cancel') {
    const operation: AgentMuxContinuityOperation = { operationId, agentSessionId: f.sid, trigger: 'startup', policy: normalizeAgentContinuityPolicy(),
      previousRun: saved.run, admittedAt: 1, observedAt: 1, rechecks: 0, kind: 'pending', reason: 'provider-unverified',
      evidence: { kind: 'run-running', observedAt: 1 }, supervision: { phase: 'observing', activeAttemptOperationId: operationId,
        attemptCount: 0, attemptLimit: 2, observedAt: 1, reason: 'initialization-pending' } }
    await f.inner.updateExactAgentSession(f.sid, saved.run, (current: AgentMuxStoredAgentSession) => ({ ...current,
      continuity: operation, continuityOperations: { [operationId]: operation }, updatedAt: current.updatedAt + 1 }))
  }
  const authority = async () => {
    await f.inner.assertCreationInputCurrent(saved, run)
    if ((await f.read()).continuityOperations?.[operationId]?.supervision?.phase === 'cancelled') throw new AgentMuxError(
      'The original recovery input was cancelled before native dispatch.', 'AGENT_CONTINUITY_SUPERSEDED', undefined,
      { disposition: 'not_applied', confirmedInputBytes: 0 })
  }
  const pending = f.advance(saved, f, authority)
  await prepared.promise
  try {
    if (action === 'stop') await f.inner.prepareAgentStop(f.sid, saved.run)
    else expect((await f.client.controlAgentContinuity({ agentSessionId: f.sid, expectedRun: saved.run, intentOperationId: operationId,
      operationId: 'cancel-original-input-recovery', action: 'cancel' })).receipt.outcome).toBe('cancelled')
  } finally { release.resolve() }
  expect((await pending).initialInput?.state).toBe('prepared')
  expect(f.sends).toHaveLength(0)
  expect(await f.client.inspectAgentPromptSubmission(created.creation.initialInputKey!)).toBeNull()
  expect((await f.inner.kernel.status(saved.run.runId)).state.type).toBe('running')
  await f.client.writeAgent({ agentSessionId: f.sid, expectedRun: saved.run, source: 'user', data: 'ordinary-input-still-available' })
  await vi.waitFor(async () => expect((await f.client.readRunReplay(saved.run)).replay.map(chunk => chunk.data).join('')).toContain('INPUT:ordinary-input-still-available'))
  expect(f.bytes).toHaveBeenCalledTimes(1)
})

it.each(['stop', 'cancel'] as const)('checks recovery authority after native claim: accepted %s during the final Provider check prevents send', async action => {
  const checking = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await fixture({ explicitContinuation: true, asserting: async check => {
    if (check === 2) { checking.resolve(); await release.promise }
  } })
  const created = await f.create(), saved = await f.ready(), run = await f.inner.kernel.status(saved.run.runId)
  const operationId = 'claimed-input-recovery', now = Date.now()
  const operation: AgentMuxContinuityOperation = { operationId, agentSessionId: f.sid, trigger: 'startup', policy: normalizeAgentContinuityPolicy(),
    previousRun: saved.run, admittedAt: now, observedAt: now, rechecks: 0, kind: 'pending', reason: 'provider-unverified',
    evidence: { kind: 'run-running', observedAt: now }, supervision: { phase: 'observing', activeAttemptOperationId: operationId,
      attemptCount: 0, attemptLimit: 2, observedAt: now, reason: 'initialization-pending' } }
  await f.inner.updateExactAgentSession(f.sid, saved.run, (current: AgentMuxStoredAgentSession) => ({ ...current,
    continuity: operation, continuityOperations: { [operationId]: operation }, updatedAt: current.updatedAt + 1 }))
  // Use the same recovery owner and authority as its passive initial-input producer.
  const authority = () => f.inner.recovery.assertRecoveryInputCurrent(saved, undefined, true)
  const pending = f.advance(saved, f, authority)
  await checking.promise
  const key = created.creation.initialInputKey!
  let original: Awaited<ReturnType<typeof f.client.inspectAgentPromptSubmission>> = null
  try {
    original = await f.client.inspectAgentPromptSubmission(key)
    expect(original?.admission).toMatchObject({ inputKey: key, transport: 'native', native: { outcome: 'claimed' }, acknowledged: false })
    if (action === 'stop') await f.inner.prepareAgentStop(f.sid, saved.run)
    else expect((await f.client.controlAgentContinuity({ agentSessionId: f.sid, expectedRun: saved.run, intentOperationId: operationId,
      operationId: 'cancel-claimed-input-recovery', action: 'cancel' })).receipt.outcome).toBe('cancelled')
  } finally { release.resolve() }
  expect((await pending).initialInput?.state).toBe('not-applied')
  expect(f.sends).toHaveLength(0)
  const retained = await f.client.inspectAgentPromptSubmission(key)
  expect(retained?.admission).toMatchObject({ inputKey: key, transport: 'native', acknowledged: false, notApplied: true,
    native: { outcome: 'not-applied', plan: original!.admission!.transport === 'native' ? original!.admission!.native.plan : undefined } })
  expect((await f.advance(await f.read(), f, authority)).initialInput?.state).toBe('not-applied')
  expect(f.sends).toHaveLength(0); expect(f.start).toHaveBeenCalledTimes(1)
  const current = await f.inner.kernel.status(saved.run.runId)
  expect(current.state.type).toBe('running'); expect(current.pid).toBe(run.pid)
  await f.client.writeAgent({ agentSessionId: f.sid, expectedRun: saved.run, source: 'user', data: 'ordinary-input-after-claimed-cancel' })
  await vi.waitFor(async () => expect((await f.client.readRunReplay(saved.run)).replay.map(chunk => chunk.data).join('')).toContain('INPUT:ordinary-input-after-claimed-cancel'))
  expect(f.bytes).toHaveBeenCalledTimes(1)
})

it('keeps the create caller on its original local authority while a ready native object is preparing its initial input', async () => {
  const prepared = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await fixture({ preparation: release.promise, preparing: prepared.resolve, explicitContinuation: true, readyAtCreation: true })
  const pending = f.create({ nativeResumeSource: { workspacePath: f.root, revision: 'a'.repeat(64),
    nativeHandle: { kind: 'provider', providerId: f.provider.id, sessionId: 'original-native', transcriptPath: join(f.root, 'original-private-source.jsonl') } } })
  await Promise.race([prepared.promise, pending.then(() => { throw new Error('Expected input preparation before creation completes') })])
  const original = await f.read()
  try { await f.inner.prepareAgentStop(f.sid, original.run) } finally { release.resolve() }
  const created = await pending
  expect(created.promptConfirmed).toBe(false)
  expect(f.sends).toHaveLength(0); expect((await f.read()).initialInput?.state).toBe('prepared')
  expect(await f.client.inspectAgentPromptSubmission(created.creation.initialInputKey!)).toBeNull()
  expect((await f.inner.kernel.status(original.run.runId)).state.type).toBe('running')
})

it('keeps the original seed on Start ACK loss and binds its original input during read-only creation reconciliation', async () => {
  const f = await fixture()
  f.start.mockImplementationOnce(async (input: any) => {
    await f.nativeStart(input)
    throw new AgentMuxError('Original Start ACK lost', 'CONTROL_UNAVAILABLE', undefined, { disposition: 'unknown', confirmedInputBytes: null })
  })
  await expect(f.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  const seed = (await f.store.loadCreationCorrelation(f.sid))!.preparedCreation!
  expect(seed.initialInput?.input.prompt).toBe(f.request.prompt); expect(seed.initialInput?.key).toBeUndefined()
  const inspection = await f.client.inspectAgentCreation(f.sid)
  expect(inspection.kind).toBe('agent')
  const retained = await f.read()
  expect(retained.initialInput?.key).toEqual(retained.creation?.initialInputKey)
  expect(retained.initialInput?.state).toBe('prepared'); expect(f.sends).toHaveLength(0)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.bytes).not.toHaveBeenCalled()
})

it('retains the exact initial message author and authored body in the original native input receipt', async () => {
  const f = await fixture(), sender = await f.create({ createOperationId: 'original-sender', prompt: undefined })
  const capability = f.start.mock.calls[0]![0].env.AGENTMUX_AGENT_CAPABILITY
  const created = await f.create({ initialMessage: { callerAgentSessionId: sender.session.agentSessionId, capability } })
  const saved = await f.ready()
  expect(saved.initialInput?.message.authorAgentSessionId).toBe(sender.session.agentSessionId)
  expect(saved.initialInput?.message.userContent).toContain(f.request.prompt)
  await f.advance(saved)
  const receipt = await f.client.inspectAgentPromptSubmission(created.creation.initialInputKey!)
  expect(receipt?.admission?.intent?.message).toEqual(saved.initialInput?.message)
  expect(f.sends[0]?.text).toBe(saved.initialInput?.prompt)
})

it('strictly preserves the initial private packet through persistence and rejects wrong keys, changed bodies and unknown fields', async () => {
  const f = await fixture(); await f.create()
  const saved = await f.read()
  expect(normalizeStoredAgentSession(saved).initialInput).toEqual(saved.initialInput)
  const bad = [{ ...saved.initialInput, extra: true }, { ...saved.initialInput, digest: 'guessed' },
    { ...saved.initialInput, key: { ...saved.initialInput!.key, agentSessionId: 'foreign-session' } },
    { ...saved.initialInput, message: { ...saved.initialInput!.message, userContent: 'changed body' } }]
  for (const initialInput of bad) expect(() => normalizeStoredAgentSession({ ...saved, initialInput })).toThrow()
  const changed = structuredClone(saved); changed.initialInput!.message.authorAgentSessionId = 'another-author'; changed.updatedAt++
  await expect(f.store.compareAndSwapMetadata(saved, changed)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect((await f.read()).initialInput).toEqual(saved.initialInput)
})
