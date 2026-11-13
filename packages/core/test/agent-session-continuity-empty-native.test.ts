import { join } from 'node:path'
import { expect, it } from 'vitest'
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
