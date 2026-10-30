import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentTerminalFrontend, AgentTerminalFrontendRecoveryRequest } from '../src/agent-terminal-frontend.js'

const cleanups: Array<() => Promise<unknown>> = []
const waitFor = (check: () => unknown | Promise<unknown>, options: { timeout?: number } = {}) => vi.waitFor(check, { timeout: 5000, ...options })
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(options: { creation?: boolean; native?: boolean } = {}) {
  const h = await rpcOwnerFixture(['recipient']), sid = 'recipient', run = { runId: 'run-recipient' }
  cleanups.push(h.close)
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
  const actor = { protocolId: 'private-managed-frontend', actorId: 'original-actor',
    lifecycleOperationId: agentLifecycleOperationIdentity('create', sid, 'original-create'), token: 'a'.repeat(64),
    frontendControl: true as const, initializationControl: true as const, launch: { command: 'codex', args: [] } }
  let frontend: AgentTerminalFrontend = { run, frontendId: 'first-frontend', state: 'attached', backendState: 'running',
    source: 'managed-process', observedAt: 1, initialization: { lifecycleOperationId: actor.lifecycleOperationId,
      phase: options.native === false ? 'preparing' : 'ready', native: options.native === false ? { state: 'not-created' } : { state: 'confirmed', sessionId: nativeHandle.sessionId } } }
  const requests: AgentTerminalFrontendRecoveryRequest[] = [], spawns: string[] = [], failures: unknown[] = []
  let client = h.client, inner = client as any, backendState: any = { type: 'running' }
  const readers: Array<() => void> = []
  let loseReply = false
  const results = new Map<string, Omit<AgentTerminalFrontend, 'run'>>()
  const configure = (value: AgentMuxClient) => {
    client = value; inner = value as any
    inner.connected = true; inner.kernel.isConnected = () => true
    inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), state: backendState, pid: 123 }))
    inner.kernel.start = vi.fn(); inner.kernel.stop = vi.fn(); inner.kernel.input = vi.fn()
    inner.kernel.prepareStop = vi.fn(async (runId: string, operationKey: string) => ({ daemonInstance: 'fixture-runtime', runId, operationKey }))
    inner.kernel.observeLifecycle = vi.fn(async (_run: unknown, changed: () => void) => { readers.push(changed); return async () => {} })
    inner.queueNativeIdentityCapture = vi.fn(); inner.ensureTerminalFrontendObservation = vi.fn(async () => true)
    inner.ensureTerminalHandshakeOrDegrade = vi.fn(async (session: AgentMuxStoredAgentSession) => session)
    inner.terminalFrontendWatches.set(sid, { key: JSON.stringify([run.runId, actor]), controller: new AbortController(),
      frontend, pending: Promise.resolve(true), ready: new Set() })
    vi.spyOn(client.providers.get('codex'), 'reconnectTerminalFrontend').mockImplementation(async (_context, request) => {
      requests.push(structuredClone(request))
      const previous = results.get(request.operationId)
      if (previous) return structuredClone(previous)
      if (request.target.kind === 'initialization') {
        const { run: _run, ...observed } = frontend
        return structuredClone(observed)
      }
      spawns.push(request.operationId)
      frontend = { ...frontend, frontendId: 'frontend-' + spawns.length, state: 'attached', observedAt: Date.now() }
      delete frontend.exitCode
      inner.terminalFrontendWatches.get(sid).frontend = frontend
      const { run: _run, ...observed } = frontend
      results.set(request.operationId, observed)
      if (loseReply) { loseReply = false; throw new AgentMuxError('Private original reply lost after one frontend spawn', 'PRIVATE_REPLY_LOST') }
      return structuredClone(observed)
    })
    client.onEvent(event => { if (event.type === 'agent-error') failures.push(event) })
  }
  configure(client)
  await inner.registry.update(sid, run, (session: AgentMuxStoredAgentSession) => ({ ...session, nativeActor: actor,
    ...(options.native === false ? {} : { nativeHandle }), ...(options.creation === false ? {} : {
      creation: { createOperationId: 'original-create', initialPrompt: 'not-requested', createdRun: run } }) }))
  const stored = () => h.store.readMetadata(sid)
  const observe = async (retry = true) => { const session = await stored(); inner.recovery.observe(session, retry); inner.recovery.wake(sid) }
  const updateFrontend = async (change: Partial<AgentTerminalFrontend>) => {
    frontend = { ...frontend, ...change }; inner.terminalFrontendWatches.get(sid).frontend = frontend; await observe()
  }
  const root = async () => { const session = (await stored())!; const pointer = session.continuity!;
    return session.continuityOperations![pointer.intentOperationId ?? pointer.operationId]! }
  return { h, actor, run, requests, spawns, failures, stored, root, observe, updateFrontend,
    get client() { return client }, get inner() { return inner }, get frontend() { return frontend },
    loseNextReply: () => { loseReply = true },
    manual: (operationId = 'manual-original', policy = {}) => client.ensureAgentContinuity({ agentSessionId: sid, expectedRun: run, operationId,
      trigger: 'manual', policy: { retryInitialDelayMs: 5, retryMaxDelayMs: 5, ...policy } }),
    restart: async () => { await client.dispose(); const reader = new AgentMuxClient({ store: h.store });
      cleanups.push(() => reader.dispose()); await (reader as any).registry.load('local'); configure(reader);
      inner.recovery.restore([(await stored())!]) },
    exitBackend: () => { backendState = { type: 'exited', code: 1, signal: null }; readers.at(-1)?.() } }
}

it('seeds one durable original creation frontend observer without claiming a resume or reconnect', async () => {
  const f = await fixture(); await f.observe()
  await waitFor(async () => expect((await f.stored())!.continuity).toBeDefined())
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  const before = (await f.root())!
  expect(before).toMatchObject({ kind: 'reattachable', previousRun: f.run, supervision: { attemptCount: 1, attemptLimit: 4, phase: 'observing' } })
  expect(before.newRun).toBeUndefined(); expect(before.frontendReconnect).toBeUndefined()
  const writes = vi.spyOn(f.inner, 'updateExactAgentSession')
  for (let i = 0; i < 20; i++) { await f.observe(false); f.inner.recovery.wake('unrelated-session') }
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(writes).not.toHaveBeenCalled(); expect(f.spawns).toHaveLength(0)
  await f.updateFrontend({ state: 'detached', exitCode: 31 })
  await waitFor(() => expect(f.spawns).toHaveLength(1), { timeout: 3500 })
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  expect((await f.root()).operationId).toBe(before.operationId)
  expect((await f.root()).supervision).toMatchObject({ attemptCount: 2, attemptLimit: 4 })
  expect((await f.stored())!.run).toEqual(f.run)
  expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('retains the original finite creation budget across a new Core owner and never resumes an ended backend', async () => {
  const f = await fixture(); await f.observe()
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  const before = structuredClone(await f.root())
  await f.restart()
  await waitFor(() => expect(f.inner.kernel.observeLifecycle).toHaveBeenCalledOnce())
  expect(await f.root()).toEqual(before)
  await f.updateFrontend({ state: 'detached', exitCode: 23 })
  await waitFor(() => expect(f.spawns).toHaveLength(1), { timeout: 3500 })
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  f.exitBackend()
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-backend-ended'))
  expect((await f.root()).supervision?.phase).toBe('settled')
  expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect((await f.stored())!.run).toEqual(f.run)
})

it.each(['creation', 'manual'] as const)('closes %s frontend-only observation when its backend ends during an unknown reconnect receipt', async origin => {
  const f = await fixture({ creation: origin === 'creation' })
  if (origin === 'creation') {
    await f.observe(); await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  }
  f.loseNextReply(); await f.updateFrontend({ state: 'detached', exitCode: 23 })
  if (origin === 'manual') await f.manual()
  await waitFor(() => expect(f.spawns).toHaveLength(1), { timeout: 3500 })
  f.inner.probePreparedAgent = vi.fn(async () => { throw new Error('An ended frontend-only backend must not enter native resume preflight') })
  f.exitBackend()
  await waitFor(async () => {
    expect(f.inner.probePreparedAgent, 'A frontend-only receipt must not authorize native resume preflight').not.toHaveBeenCalled()
    expect((await f.root()).supervision).toMatchObject({ phase: 'settled', reason: 'frontend-backend-ended' })
  }, { timeout: 3500 })
  expect(f.inner.probePreparedAgent).not.toHaveBeenCalled(); expect(f.inner.kernel.start).not.toHaveBeenCalled()
  expect((await f.stored())!.run).toEqual(f.run); expect(f.spawns).toHaveLength(1)
})

it.each(['other-created-run', 'no-original-binding'] as const)('does not seed a creation observer from %s', async reason => {
  const f = await fixture()
  await f.inner.registry.update('recipient', f.run, (session: AgentMuxStoredAgentSession) => ({ ...session,
    creation: { ...session.creation!, createdRun: reason === 'other-created-run' ? { runId: 'different-run' } : undefined } }))
  await f.observe(); await new Promise(resolve => setTimeout(resolve, 25))
  expect((await f.stored())!.continuity).toBeUndefined(); expect(f.requests).toHaveLength(0)
})

it('joins repeated manual recovery to the existing creation root instead of starting another budget', async () => {
  const f = await fixture(); await f.observe()
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  const original = await f.root()
  await f.updateFrontend({ state: 'detached', exitCode: 23 })
  await Promise.all([f.manual('manual-a'), f.manual('manual-b'), f.manual('manual-c')])
  await waitFor(() => expect(f.spawns).toHaveLength(1), { timeout: 3500 })
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  const saved = (await f.stored())!
  expect((await f.root()).operationId).toBe(original.operationId)
  expect(Object.values(saved.continuityOperations!).filter(op => op.supervision && op.supervision.phase === 'observing')).toHaveLength(1)
  for (const operationId of ['manual-a', 'manual-b', 'manual-c']) {
    expect(saved.continuityOperations![operationId]).toMatchObject({ operationId, intentOperationId: original.operationId, kind: 'pending', reason: 'recovery-supervised' })
    expect(saved.continuityOperations![operationId]!.supervision).toBeUndefined()
    expect(saved.continuityOperations![operationId]!.frontendReconnect).toBeUndefined()
    expect(saved.continuityOperations![operationId]!.newRun).toBeUndefined()
  }
  expect((await f.root()).supervision?.attemptCount).toBe(2)
  await f.updateFrontend({ state: 'detached', exitCode: 0 })
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-normal-exit'))
  await f.updateFrontend({ state: 'detached', exitCode: 31 })
  await f.manual('manual-a')
  expect(f.spawns).toHaveLength(1)
  expect((await f.root()).supervision?.phase).toBe('settled')
})

it('supervises a manual reconnect and rejoins its lost original receipt without a second spawn', async () => {
  const f = await fixture({ creation: false }); await f.updateFrontend({ state: 'detached', exitCode: 23 })
  f.loseNextReply()
  expect(await f.manual()).toMatchObject({ kind: 'pending' })
  expect((await f.root()).supervision).toMatchObject({ attemptCount: 1, attemptLimit: 4 })
  await f.manual('another-manual-click')
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  expect(new Set(f.requests.map(request => request.operationId)).size).toBe(1); expect(f.spawns).toHaveLength(1)
  await f.updateFrontend({ state: 'detached', exitCode: 31 })
  await waitFor(() => expect(f.spawns).toHaveLength(2))
  expect((await f.root()).supervision?.attemptCount).toBe(2)
})

it('promotes the original count-zero initialization wait to quiet same-Run supervision', async () => {
  const f = await fixture({ creation: false, native: false })
  await f.updateFrontend({ state: 'starting' })
  expect(await f.client.ensureAgentContinuity({ agentSessionId: 'recipient', expectedRun: f.run, operationId: 'slow-original',
    trigger: 'startup', policy: { recheckMaxAttempts: 0, retryInitialDelayMs: 5, retryMaxDelayMs: 5 } })).toMatchObject({ kind: 'pending' })
  expect((await f.root()).supervision?.attemptCount).toBe(0)
  await f.updateFrontend({ state: 'attached', initialization: { lifecycleOperationId: f.actor.lifecycleOperationId,
    phase: 'ready', native: { state: 'confirmed', sessionId: 'original-native' } } })
  await waitFor(async () => { const root = await f.root(); expect(root.supervision, JSON.stringify(root)).toMatchObject({ attemptCount: 1, phase: 'observing', reason: 'frontend-attached' }) })
  await f.updateFrontend({ state: 'detached', exitCode: 23 })
  await waitFor(() => expect(f.spawns).toHaveLength(1))
  expect((await f.root()).operationId).toBe('slow-original')
  expect((await f.root()).supervision?.attemptCount).toBe(2)
})

it('retains a queued exact initialization wake through an ordinary Session publication', async () => {
  const f = await fixture({ creation: false, native: false })
  await f.updateFrontend({ state: 'starting' })
  await f.client.ensureAgentContinuity({ agentSessionId: 'recipient', expectedRun: f.run, operationId: 'slow-published-original',
    trigger: 'startup', policy: { recheckMaxAttempts: 0 } })
  await waitFor(async () => expect((await f.root()).supervision).toMatchObject({ phase: 'paused', attemptCount: 0, reason: 'operation-unconfirmed' }))
  const supervisor = f.inner.recovery.continuitySupervisor
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
  const occupied = supervisor.serialize('recipient', async () => { enter(); await barrier })
  await entered
  try {
    // Provider ready queues the exact wake. An ordinary identity publication can
    // arrive before its SID owner reads metadata; that publication is not a revoke.
    await f.updateFrontend({ state: 'attached', initialization: { lifecycleOperationId: f.actor.lifecycleOperationId,
      phase: 'ready', native: { state: 'confirmed', sessionId: 'original-native' } } })
    f.inner.recovery.observe((await f.stored())!, false)
  } finally { release() }
  await occupied
  await supervisor.serialize('recipient', async () => {})
  await waitFor(async () => expect((await f.root()).supervision).toMatchObject({
    phase: 'observing', attemptCount: 1, reason: 'frontend-attached'
  }))
  expect((await f.root()).operationId).toBe('slow-published-original')
  expect(f.spawns).toHaveLength(0); expect(f.inner.kernel.start).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('does not resurrect cancelled creation supervision on repeated observations or restore', async () => {
  const f = await fixture(); await f.observe()
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  const original = await f.root()
  await f.client.controlAgentContinuity({ agentSessionId: 'recipient', expectedRun: f.run, intentOperationId: original.operationId,
    operationId: 'cancel-original', action: 'cancel' })
  const cancelled = structuredClone(await f.root())
  await f.restart(); await f.updateFrontend({ state: 'detached', exitCode: 23 }); await f.observe()
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(await f.root()).toEqual(cancelled); expect(f.spawns).toHaveLength(0)
  await f.manual('explicit-new-recovery')
  expect((await f.root()).operationId).toBe('explicit-new-recovery')
  expect((await f.stored())!.continuityOperations![cancelled.operationId]).toEqual(cancelled)
  expect(f.spawns).toHaveLength(1)
})

it('keeps a new authored input separate without losing the original frontend owner', async () => {
  const f = await fixture(); await f.observe()
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  const original = await f.root()
  const result = await f.client.ensureAgentContinuity({ agentSessionId: 'recipient', expectedRun: f.run, operationId: 'authored-input',
    trigger: 'input', input: { submissionId: 'new-submission', prompt: 'New real authored content' } })
  expect(result.continuity).toMatchObject({ operationId: 'authored-input', launchInput: { input: { prompt: 'New real authored content' } } })
  expect(result.continuity!.intentOperationId).toBeUndefined()
  await f.manual('manual-after-input')
  const saved = (await f.stored())!
  expect(saved.continuityOperations!['manual-after-input']).toMatchObject({ intentOperationId: original.operationId, reason: 'recovery-supervised' })
  expect(Object.values(saved.continuityOperations!).filter(op => op.supervision && op.supervision.phase === 'observing')).toHaveLength(1)
  expect(f.spawns).toHaveLength(0)
})

it('does not let a later frontend failure bypass an exact prepared Stop', async () => {
  const f = await fixture(); await f.observe()
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  await f.inner.prepareAgentStop('recipient', f.run)
  await f.updateFrontend({ state: 'detached', exitCode: 31 })
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('user-stop'))
  expect(f.spawns).toHaveLength(0); expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('keeps an exhausted manual frontend budget unchanged across restore until explicit continuation', async () => {
  const f = await fixture({ creation: false }); await f.updateFrontend({ state: 'detached', exitCode: 23 })
  await f.manual('finite-original', { retryMaxAttempts: 0 })
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  await f.updateFrontend({ state: 'detached', exitCode: 31 })
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-retry-budget-exhausted'))
  const paused = structuredClone(await f.root()); await f.restart(); await f.observe()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await f.root()).toEqual(paused); expect(f.spawns).toHaveLength(1)
  await f.client.controlAgentContinuity({ agentSessionId: 'recipient', expectedRun: f.run, intentOperationId: paused.operationId,
    operationId: 'continue-finite-original', action: 'continue', additionalAttempts: 1 })
  await waitFor(() => expect(f.spawns).toHaveLength(2))
  expect((await f.root()).supervision).toMatchObject({ attemptCount: 2, attemptLimit: 2 })
})

it('refuses only the ambiguous new frontend action while retaining healthy input and both old owners', async () => {
  const f = await fixture(); await f.observe()
  await waitFor(async () => expect((await f.root()).supervision?.reason).toBe('frontend-attached'))
  const original = await f.root(), second = { ...structuredClone(original), operationId: 'other-original',
    supervision: { ...original.supervision!, activeAttemptOperationId: 'other-original' } }
  await f.inner.registry.update('recipient', f.run, (session: AgentMuxStoredAgentSession) => {
    const next = { ...session, continuityOperations: { ...session.continuityOperations, [second.operationId]: second } }
    delete next.continuity; return next
  })
  await expect(f.manual('ambiguous-action')).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  const saved = (await f.stored())!
  expect(saved.continuityOperations![original.operationId]).toEqual(original)
  expect(saved.continuityOperations![second.operationId]).toEqual(second)
  expect(saved.continuityOperations!['ambiguous-action']).toBeUndefined()
  await f.client.writeAgent({ agentSessionId: 'recipient', expectedRun: f.run, source: 'user', data: 'private healthy input' })
  expect(f.h.rawInput).toHaveBeenCalledOnce(); expect(f.spawns).toHaveLength(0)
})
