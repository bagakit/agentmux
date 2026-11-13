import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { cleanups, core, fixture } from './helpers/prepared-resume-fixture.js'

type Fixture = Awaited<ReturnType<typeof fixture>>

// An ended Run whose Session record holds no native conversation evidence, for a Provider whose
// identity channel Core installs itself. Core alone names this fact, once.
/** The same Provider with an identity channel Core installs itself; this fixture installs no files. */
const managedChannel = (f: Fixture) => f.client.providers.replace({ ...f.provider, planManagedHooks: () => null,
  catalog: { ...f.provider.catalog, hookStrategy: { kind: 'native', installation: 'explicit-managed' } } })
type Shape = Partial<AgentMuxStoredAgentSession> | ((run: AgentMuxStoredAgentSession['run']) => Partial<AgentMuxStoredAgentSession>)
async function emptyEndedSession(shape: Shape = {}, managed = true) {
  const f = await fixture()
  if (managed) managedChannel(f)
  const { nativeHandle: _absent, ...withoutHandle } = f.previous
  const facts = typeof shape === 'function' ? shape({ ...f.previous.run }) : shape
  await f.inner.registry.update(f.previous.agentSessionId, f.previous.run, () => ({ ...withoutHandle,
    creation: { createOperationId: 'original-create', initialPrompt: 'not-requested', createdRun: { ...f.previous.run } }, ...facts, updatedAt: f.previous.updatedAt + 1 }))
  return f
}
// The fixture seeds its ended Run through the real Runtime; that Start is not this recovery's.
const noNewStartOrInput = (f: Fixture) => {
  expect(f.start).not.toHaveBeenCalled(); expect(f.inputCount()).toBe(0); expect(f.stop).not.toHaveBeenCalled()
}
const continuity = (f: Fixture, operationId: string, trigger: 'startup' | 'manual' | 'input', extra: Record<string, unknown> = {}) =>
  f.client.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId, trigger, ...extra })
/** The Runtime's own input counter for this exact Run, as ctxmux reports it. */
function reportInputBytes(f: Fixture, bytes: number | null) {
  const status = f.inner.kernel.status.bind(f.inner.kernel)
  f.inner.kernel.status = async (runId: string) => {
    const run = await status(runId)
    return runId === f.previous.run.runId ? { ...run, acceptedInputBytes: bytes } : run
  }
}
const stillIdentityPath = async (f: Fixture, operationId: string) =>
  expect(await continuity(f, operationId, 'manual')).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable' })

it.each(['startup', 'manual', 'input'] as const)('answers a %s recovery of an ended Session Core holds no native conversation for with one dedicated reason', async trigger => {
  const f = await emptyEndedSession()
  const result = await continuity(f, 'empty-' + trigger, trigger)
  expect(result).toMatchObject({ kind: 'unavailable', reason: 'native-conversation-absent', previousRun: f.previous.run })
  const stored = await f.store.readMetadata(f.previous.agentSessionId)
  expect(stored?.continuityOperations?.['empty-' + trigger]).toMatchObject({ kind: 'unavailable', reason: 'native-conversation-absent' })
  // An unavailable fact is final for this operation: no supervision, recheck, reservation, Start or input.
  expect(stored?.continuityOperations?.['empty-' + trigger]).not.toHaveProperty('supervision')
  expect(stored?.continuityOperations?.['empty-' + trigger]).not.toHaveProperty('nextActionAt')
  expect(await f.correlation()).toBeUndefined()
  noNewStartOrInput(f)
})

it('converges equal startup observations without metadata writes or duplicate publication', async () => {
  const f = await emptyEndedSession()
  const first = await continuity(f, 'first-startup', 'startup'), saved = await f.store.readMetadata(f.previous.agentSessionId)
  const writes = vi.spyOn(f.store, 'compareAndSwapMetadata'), events = vi.spyOn(f.inner, 'publishSession')
  const status = vi.spyOn(f.inner.kernel, 'status')
  for (let index = 0; index < 5; index++) {
    const result = await continuity(f, 'fresh-startup-' + index, 'startup')
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'native-conversation-absent', continuity: first.continuity })
    expect(await f.store.readMetadata(f.previous.agentSessionId)).toEqual(saved)
  }
  expect(Object.keys(saved!.continuityOperations!)).toEqual(['first-startup'])
  expect(Object.keys(saved!.continuityExecutors!)).toEqual(['first-startup'])
  expect(writes).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled()
  expect(status.mock.calls.filter(args => args[0] === f.previous.run.runId).length).toBeGreaterThanOrEqual(5)
  noNewStartOrInput(f)
})

it('converges startup observations across distinct real Core owner processes', async () => {
  const f = await emptyEndedSession()
  const first = await continuity(f, 'process-original', 'startup'), saved = await f.store.readMetadata(f.previous.agentSessionId)
  const providerCatalog = f.client.providers.get(f.provider.id).catalog
  await f.client.dispose()
  const worker = process.env.AGENTMUX_TEST_EMPTY_NATIVE_OBSERVATION_WORKER
  expect(worker, 'Run the source proof driver so the current Core worker is compiled.').toBeTruthy()
  const outputs = []
  for (const operationId of ['process-second', 'process-third']) {
    const { stdout } = await promisify(execFile)(process.execPath, [worker!, JSON.stringify({ storePath: join(f.root, 'sessions.sqlite'),
      providerCatalog, agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId })], { env: process.env, timeout: 30_000 })
    const output = JSON.parse(stdout.trim().split('\n').at(-1)!)
    expect(output.result).toMatchObject({ kind: 'unavailable', reason: 'native-conversation-absent', continuity: first.continuity })
    expect(output.stored).toEqual(saved); expect(output.counters).toEqual({ start: 0, input: 0, stop: 0 })
    expect(output.pid).not.toBe(process.pid); outputs.push(output)
  }
  expect(outputs[0].pid).not.toBe(outputs[1].pid)
  expect(process.env.AGENTMUX_TEST_EMPTY_NATIVE_OBSERVATION_RECEIPT).toBeTruthy()
  await writeFile(process.env.AGENTMUX_TEST_EMPTY_NATIVE_OBSERVATION_RECEIPT!, JSON.stringify({
    pids: outputs.map(output => output.pid), originalReceipt: first.continuity!.operationId,
    operationCounts: outputs.map(output => Object.keys(output.stored.continuityOperations).length),
    executorCounts: outputs.map(output => Object.keys(output.stored.continuityExecutors).length),
    counters: outputs.map(output => output.counters), metadataUnchanged: true
  }))
})

it('converges the first concurrent startup observations from independent Core owners', async () => {
  const f = await emptyEndedSession(), other = await f.reader()
  managedChannel({ ...f, ...other })
  const [a, b] = await Promise.all([continuity(f, 'owner-a', 'startup'), other.client.ensureAgentContinuity({
    agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'owner-b', trigger: 'startup' })])
  expect(a).toMatchObject({ kind: 'unavailable', reason: 'native-conversation-absent' })
  expect(b.continuity).toEqual(a.continuity)
  const saved = await f.store.readMetadata(f.previous.agentSessionId)
  expect(Object.keys(saved!.continuityOperations!)).toEqual([a.continuity!.operationId])
  expect(Object.keys(saved!.continuityExecutors!)).toEqual([a.continuity!.operationId])
  noNewStartOrInput(f); expect(other.start).not.toHaveBeenCalled(); expect(other.inputCount()).toBe(0)
})

it('keeps explicit manual and input identities between equal startup observations', async () => {
  const f = await emptyEndedSession(), first = await continuity(f, 'automatic-original', 'startup')
  const manual = await continuity(f, 'explicit-manual', 'manual')
  expect(manual.continuity?.operationId).toBe('explicit-manual')
  const input = await continuity(f, 'authored-input', 'input', { input: { submissionId: 'authored-body', prompt: 'Keep this exact new draft.' } })
  expect(input.continuity).toMatchObject({ operationId: 'authored-input', launchInput: { input: { prompt: 'Keep this exact new draft.' } } })
  const before = await f.store.readMetadata(f.previous.agentSessionId)
  const again = await continuity(f, 'automatic-after-input', 'startup')
  expect(again.continuity).toEqual(first.continuity)
  expect(await f.store.readMetadata(f.previous.agentSessionId)).toEqual(before)
  expect(Object.keys(before!.continuityOperations!)).toEqual(['automatic-original', 'explicit-manual', 'authored-input'])
  noNewStartOrInput(f)
})

it('retains changed startup policy rather than aliasing an older observation', async () => {
  const f = await emptyEndedSession()
  await continuity(f, 'policy-original', 'startup')
  const changed = await continuity(f, 'policy-changed', 'startup', { policy: { activeRecovery: 'manual' } })
  expect(changed.continuity?.operationId).toBe('policy-changed')
  const before = await f.store.readMetadata(f.previous.agentSessionId)
  expect((await continuity(f, 'policy-equal', 'startup', { policy: { activeRecovery: 'manual' } })).continuity).toEqual(changed.continuity)
  expect(await f.store.readMetadata(f.previous.agentSessionId)).toEqual(before)
  expect(Object.keys(before!.continuityOperations!)).toHaveLength(2)
  noNewStartOrInput(f)
})

it('converges equal SDK execution options while preserving a changed execution source', async () => {
  const f = await emptyEndedSession(), options = { commandOverride: process.execPath, args: ['original'], env: { PRIVATE_SETTING: 'one' } }
  const first = await continuity(f, 'sdk-original', 'startup', options)
  expect((await continuity(f, 'sdk-equal', 'startup', options)).continuity).toEqual(first.continuity)
  const changed = await continuity(f, 'sdk-changed', 'startup', { ...options, env: { PRIVATE_SETTING: 'two' } })
  expect(changed.continuity?.operationId).toBe('sdk-changed')
  const saved = await f.store.readMetadata(f.previous.agentSessionId)
  expect(Object.keys(saved!.continuityExecutors!)).toEqual(['sdk-original', 'sdk-changed'])
  noNewStartOrInput(f)
})

it('rechecks current native evidence before reusing an older startup observation', async () => {
  const f = await emptyEndedSession()
  await continuity(f, 'old-absence', 'startup')
  const update = f.inner.updateExactAgentSession.bind(f.inner)
  let changed = false
  f.inner.updateExactAgentSession = async (...args: Parameters<typeof update>) => {
    if (!changed) {
      changed = true
      await f.inner.registry.update(f.previous.agentSessionId, f.previous.run, (value: AgentMuxStoredAgentSession) => ({ ...value,
        nativeHandle: f.previous.nativeHandle, updatedAt: value.updatedAt + 1 }))
    }
    return await update(...args)
  }
  const result = await continuity(f, 'current-observation', 'startup')
  expect(result).toMatchObject({ kind: 'pending', reason: 'idle-unknown', continuity: { operationId: 'current-observation' } })
  expect((await f.store.readMetadata(f.previous.agentSessionId))!.nativeHandle).toEqual(f.previous.nativeHandle)
  noNewStartOrInput(f)
})

it('keeps Runtime unknown after an old startup absence instead of returning cached certainty', async () => {
  const f = await emptyEndedSession()
  await continuity(f, 'old-absence', 'startup')
  vi.spyOn(f.inner.kernel, 'status').mockRejectedValue(new Error('Private Runtime observation unavailable'))
  const result = await continuity(f, 'unknown-observation', 'startup')
  expect(result).toMatchObject({ kind: 'pending', reason: 'runtime-unverified', continuity: { operationId: 'unknown-observation' } })
  noNewStartOrInput(f)
})

it('checks a revoked standing source even after an old startup absence', async () => {
  const f = await emptyEndedSession()
  await continuity(f, 'old-absence', 'startup')
  await expect(continuity(f, 'revoked-observation', 'startup', { standingIntent: { intentId: 'missing', operationId: 'revoked', sourceId: 'source', revision: 'revoked' } }))
    .rejects.toMatchObject({ code: 'AGENT_STANDING_INTENT_CHANGED' })
  noNewStartOrInput(f)
})

it('does not confirm reuse when the original observation Store fence failed', async () => {
  const f = await emptyEndedSession()
  await continuity(f, 'old-absence', 'startup')
  const update = f.inner.updateExactAgentSession.bind(f.inner)
  f.inner.updateExactAgentSession = async (...args: Parameters<typeof update>) => {
    // Run the actual updater selection, then reject the unconfirmed Store fence.
    args[2](f.inner.registry.get(f.previous.agentSessionId))
    throw new core.AgentMuxError('Private Store fence unavailable.', 'PRIVATE_STORE_FENCE_UNAVAILABLE')
  }
  const result = await continuity(f, 'unconfirmed-observation', 'startup')
  expect(result.continuity).toMatchObject({ operationId: 'unconfirmed-observation' })
  expect(result.continuity?.error).toContain('receipt persistence is unconfirmed')
  f.inner.updateExactAgentSession = update
  expect(Object.keys((await f.store.readMetadata(f.previous.agentSessionId))!.continuityOperations!)).toEqual(['old-absence'])
  noNewStartOrInput(f)
})

it('counts only the acknowledged terminal handshake reply as input that carries no conversation', async () => {
  const f = await emptyEndedSession(run => ({ terminalHandshake: { run, operationId: 'handshake', inputByteRange: { startByte: 0, endByte: 5 }, acknowledged: true } }))
  reportInputBytes(f, 5)
  expect(await continuity(f, 'handshake-only', 'manual')).toMatchObject({ kind: 'unavailable', reason: 'native-conversation-absent' })
})

it('keeps the identity path when the Run accepted typed input beyond the handshake', async () => {
  // Typing straight into the terminal leaves no Session field; ctxmux's input counter is the fact.
  const f = await emptyEndedSession()
  reportInputBytes(f, 12)
  await stillIdentityPath(f, 'typed-input')
})

it('keeps the identity path when the Runtime cannot report the Run input count', async () => {
  const f = await emptyEndedSession()
  reportInputBytes(f, null)
  await stillIdentityPath(f, 'input-unknown')
})

it('keeps the identity path for a Provider whose identity channel Core does not install', async () => {
  // Without a Core-managed Hook, a Provider identity may exist that Core was never told about.
  const f = await emptyEndedSession({}, false)
  await stillIdentityPath(f, 'unmanaged-channel')
})

it.each([
  ['an authored first prompt', { creation: { createOperationId: 'original-create', initialPrompt: 'confirmed' } }],
  ['a first prompt of unknown outcome', { creation: { createOperationId: 'original-create', initialPrompt: 'unknown' } }],
  ['no creation record', { creation: undefined }],
  ['an earlier Run', { retiredRuns: [{ runId: 'earlier-run' }] }],
  ['a fork parent', { forkedFrom: { agentSessionId: 'parent', expectedRun: { runId: 'parent-run' }, expectedNativeHandle: { kind: 'provider', providerId: 'resume-process', sessionId: 'parent-native' } } }],
  ['a native status', { semanticStatus: { state: 'done', source: 'native-hook', observedAt: 1 } }],
  ['a native Hook receipt', (run: AgentMuxStoredAgentSession['run']) => ({ hookReceipt: { id: 'receipt', providerId: 'resume-process', agentSessionId: 'original-session', run, eventName: 'Stop', observedAt: 1 } })],
  ['a native activity observation', (run: AgentMuxStoredAgentSession['run']) => ({ activityCommit: { latest: { id: 'activity', source: 'native-hook', createdAt: 1, activityState: { run, state: 'done' } }, latestCommitted: true } })]
] as const)('keeps the identity path when the Session record holds %s', async (_label, shape) => {
  const f = await emptyEndedSession(shape as Shape)
  await stillIdentityPath(f, 'evidence-' + _label.replace(/\W+/gu, '-'))
})

it('keeps the identity path when a native initialization may have created an object before its identity was bound', async () => {
  const f = await emptyEndedSession({ nativeActor: { protocolId: 'fixture', actorId: 'actor', lifecycleOperationId: 'create', token: 'a'.repeat(64),
    frontendControl: true, initializationControl: true, launch: { command: 'node', args: [] } } })
  await stillIdentityPath(f, 'initialization')
})

it('keeps the existing pending state when the Session already holds a native identity', async () => {
  const f = await fixture()
  expect(await continuity(f, 'with-handle', 'startup')).toMatchObject({ kind: 'pending', reason: 'idle-unknown' })
})

it('keeps a confirmed native ID without its record locator on the existing identity path', async () => {
  const f = await emptyEndedSession({ observedNativeHandle: { kind: 'provider', providerId: 'resume-process', sessionId: 'observed-native' } })
  await stillIdentityPath(f, 'observed-only')
})

it('keeps native candidates awaiting selection on the existing identity path', async () => {
  const f = await emptyEndedSession()
  await f.inner.registry.update(f.previous.agentSessionId, f.previous.run, (value: AgentMuxStoredAgentSession) => ({ ...value, updatedAt: value.updatedAt + 1,
    nativeSourceObservation: { state: 'ambiguous', run: { ...value.run }, observedAt: value.updatedAt + 1, reason: 'frontend-selection-unconfirmed',
      candidates: [{ kind: 'provider', providerId: 'resume-process', sessionId: 'candidate-a' }, { kind: 'provider', providerId: 'resume-process', sessionId: 'candidate-b' }] } }))
  await stillIdentityPath(f, 'with-candidates')
})

it('keeps an unconfirmed identity save on the existing identity path', async () => {
  const f = await emptyEndedSession()
  ;(f.inner.registry as { unconfirmedDurability: Set<string> }).unconfirmedDurability.add(f.previous.agentSessionId)
  await stillIdentityPath(f, 'save-unconfirmed')
  noNewStartOrInput(f)
})

it.each(['native identity', 'native candidates', 'unconfirmed identity save'] as const)(
  're-decides the same startup operation when %s is committed before the no-conversation receipt', async fact => {
    const f = await emptyEndedSession()
    const update = f.inner.updateExactAgentSession.bind(f.inner)
    let changed = false
    f.inner.updateExactAgentSession = async (...args: Parameters<typeof update>) => {
      if (!changed && args[0] === f.previous.agentSessionId) {
        changed = true
        // This is after the Runtime observation and just before the real receipt CAS. An earlier
        // refresh cannot close this window; the Store updater must check its own current value.
        if (fact === 'unconfirmed identity save') {
          ;(f.inner.registry as { unconfirmedDurability: Set<string> }).unconfirmedDurability.add(f.previous.agentSessionId)
        } else await f.inner.registry.update(f.previous.agentSessionId, f.previous.run, (value: AgentMuxStoredAgentSession) => ({
          ...value, updatedAt: value.updatedAt + 1, ...(fact === 'native identity' ? { nativeHandle: f.previous.nativeHandle } : {
            nativeSourceObservation: { state: 'ambiguous', run: value.run, observedAt: value.updatedAt + 1, reason: 'frontend-selection-unconfirmed',
              candidates: [{ kind: 'provider', providerId: f.provider.id, sessionId: 'candidate-a' }, { kind: 'provider', providerId: f.provider.id, sessionId: 'candidate-b' }] }
          })
        }))
      }
      return await update(...args)
    }
    const operationId = 'original-startup'
    const result = await continuity(f, operationId, 'startup')
    expect(changed).toBe(true)
    expect(result).toMatchObject({ kind: 'pending', reason: 'idle-unknown', continuity: { operationId } })
    const stored = await f.store.readMetadata(f.previous.agentSessionId)
    expect(Object.keys(stored!.continuityOperations!)).toEqual([operationId])
    expect(stored!.continuity).toMatchObject({ operationId, kind: 'pending', reason: 'idle-unknown' })
    if (fact === 'native identity') expect(stored!.nativeHandle).toEqual(f.previous.nativeHandle)
    if (fact === 'native candidates') expect(stored!.nativeSourceObservation?.state).toBe('ambiguous')
    expect(await f.correlation()).toBeUndefined()
    noNewStartOrInput(f)
  })

it('re-decides the same startup operation after a rejected no-conversation receipt fence', async () => {
  const f = await emptyEndedSession()
  const update = f.inner.updateExactAgentSession.bind(f.inner)
  let rejected = false
  f.inner.updateExactAgentSession = async (...args: Parameters<typeof update>) => {
    if (!rejected && args[0] === f.previous.agentSessionId) {
      rejected = true
      await f.inner.registry.update(f.previous.agentSessionId, f.previous.run, (value: AgentMuxStoredAgentSession) => ({
        ...value, nativeHandle: f.previous.nativeHandle, updatedAt: value.updatedAt + 1
      }))
      // The original exact receipt update rejected its fence after this same Session changed.
      throw new core.AgentMuxError('Original receipt fence changed.', 'STALE_AGENT_SESSION')
    }
    return await update(...args)
  }
  const operationId = 'original-fenced-startup'
  const result = await continuity(f, operationId, 'startup')
  expect(rejected).toBe(true)
  expect(result).toMatchObject({ kind: 'pending', reason: 'idle-unknown', continuity: { operationId } })
  const stored = await f.store.readMetadata(f.previous.agentSessionId)
  expect(stored!.nativeHandle).toEqual(f.previous.nativeHandle)
  expect(Object.keys(stored!.continuityOperations!)).toEqual([operationId])
  expect(stored!.continuity).toMatchObject({ operationId, kind: 'pending', reason: 'idle-unknown' })
  expect(await f.correlation()).toBeUndefined()
  noNewStartOrInput(f)
})

it('does not turn an unknown Runtime state into a final answer', async () => {
  const f = await emptyEndedSession()
  const status = f.inner.kernel.status.bind(f.inner.kernel)
  f.inner.kernel.status = async (runId: string) => {
    if (runId === f.previous.run.runId) throw new core.AgentMuxError('Runtime status is unavailable.', 'CTXMUX_DISCONNECTED')
    return await status(runId)
  }
  expect(await continuity(f, 'runtime-unknown', 'startup')).toMatchObject({ kind: 'pending', reason: 'runtime-unverified' })
})

it('still refuses a revoked standing source before answering for the Session', async () => {
  // The fact never replaces authorization: a revoked maintenance source is refused as itself.
  const f = await emptyEndedSession()
  await expect(continuity(f, 'standing-revoked', 'startup', { standingIntent: { sourceId: 'maintenance', revision: 'r1', intentId: 'missing-intent', operationId: 'standing-op' } }))
    .rejects.toMatchObject({ code: 'AGENT_STANDING_INTENT_CHANGED' })
  const stored = await f.store.readMetadata(f.previous.agentSessionId)
  expect(stored?.continuityOperations?.['standing-revoked']?.reason).not.toBe('native-conversation-absent')
  noNewStartOrInput(f)
})

it('re-decides at the next startup a Session an earlier startup parked as idle-unknown', async () => {
  // Sessions saved before this fact existed hold a paused idle-unknown startup root. A new
  // application startup must still reach the final answer instead of rejoining that root.
  const f = await emptyEndedSession({}, false)
  const parked = await continuity(f, 'earlier-startup', 'startup')
  expect(parked).toMatchObject({ kind: 'pending', reason: 'idle-unknown' })
  managedChannel(f)
  const result = await continuity(f, 'later-startup', 'startup')
  expect(result).toMatchObject({ kind: 'unavailable', reason: 'native-conversation-absent' })
  noNewStartOrInput(f)
})

it('reports the dedicated reason through the public empty-text resume, Hosted client and compiled CLI', async () => {
  const f = await emptyEndedSession()
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.sqlite'), () => ({ runtimeId: 'empty-runtime', ownerInstanceId: 'empty-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const socketPath = join(f.root, 'control.sock')
  const server = new core.AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanups.push(() => rpc.dispose())
  const failure = await rpc.call('agent.resume', { target: { kind: 'agent-session', agentSessionId: f.previous.agentSessionId }, operationId: 'public-empty', text: '' })
    .then(() => null, (error: unknown) => error as { code?: string; message?: string; detail?: string })
  expect(failure?.code).toBe('AGENT_RESUME_UNAVAILABLE')
  expect(failure?.message).not.toMatch(/retry the same operation/iu)
  expect(failure?.detail).toContain('native-conversation-absent')
  const reader = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => reader.dispose())
  await expect(reader.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'hosted-empty', trigger: 'manual' }))
    .resolves.toMatchObject({ kind: 'unavailable', reason: 'native-conversation-absent' })
  const startup = await reader.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'hosted-startup-original', trigger: 'startup' })
  const beforeRepeat = await f.store.readMetadata(f.previous.agentSessionId)
  expect((await reader.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'hosted-startup-next', trigger: 'startup' })).continuity).toEqual(startup.continuity)
  expect(await f.store.readMetadata(f.previous.agentSessionId)).toEqual(beforeRepeat)
  // The compiled CLI is the real consumer: resume refuses with the reason, inspect reads it back.
  const env = objectCliEnvironment(f.root)
  const resume = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'agent', 'resume', '--session', f.previous.agentSessionId, '--operation-id', 'cli-empty'], env)
  expect(resume.code, resume.stdout + resume.stderr).toBe(1)
  expect(resume.stdout + resume.stderr).toContain('AGENT_RESUME_UNAVAILABLE')
  expect(resume.stdout + resume.stderr).toContain('native-conversation-absent')
  const inspect = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'agent', 'inspect', '--session', f.previous.agentSessionId], env)
  expect(inspect.code, inspect.stdout + inspect.stderr).toBe(0)
  expect(inspect.stdout).toContain('native-conversation-absent')
  noNewStartOrInput(f)
})
