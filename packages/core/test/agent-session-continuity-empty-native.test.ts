import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { cleanups, core, fixture } from './helpers/prepared-resume-fixture.js'

// A Run that ended before its Provider ever saved a conversation: Core never held a native
// identity, candidate or unconfirmed save for it. Core alone names this fact, once.
async function emptyEndedSession(shape: Partial<AgentMuxStoredAgentSession> = {}) {
  const f = await fixture()
  const { nativeHandle: _absent, ...withoutHandle } = f.previous
  await f.inner.registry.update(f.previous.agentSessionId, f.previous.run, () => ({ ...withoutHandle, ...shape, updatedAt: f.previous.updatedAt + 1 }))
  return f
}
// The fixture seeds its ended Run through the real Runtime; that Start is not this recovery's.
const noNewStartOrInput = (f: Awaited<ReturnType<typeof fixture>>) => {
  expect(f.start).not.toHaveBeenCalled(); expect(f.inputCount()).toBe(0); expect(f.stop).not.toHaveBeenCalled()
}
const continuity = (f: Awaited<ReturnType<typeof fixture>>, operationId: string, trigger: 'startup' | 'manual' | 'input') =>
  f.client.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId, trigger })

it.each(['startup', 'manual', 'input'] as const)('answers a %s recovery of an ended Session that never had a native conversation with one dedicated reason', async trigger => {
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

it('keeps the existing pending state when the Session already holds a native identity', async () => {
  const f = await fixture()
  const result = await continuity(f, 'with-handle', 'startup')
  expect(result).toMatchObject({ kind: 'pending', reason: 'idle-unknown' })
})

it('keeps a confirmed native ID without its record locator on the existing identity path', async () => {
  // The Provider's ID is known, only its record is unconfirmed: this is not "no native conversation".
  const f = await emptyEndedSession({ observedNativeHandle: { kind: 'provider', providerId: 'resume-process', sessionId: 'observed-native' } })
  const result = await continuity(f, 'observed-only', 'manual')
  expect(result).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable' })
})

it('keeps native candidates awaiting selection on the existing identity path', async () => {
  const f = await emptyEndedSession()
  const stored = await f.store.readMetadata(f.previous.agentSessionId)
  await f.inner.registry.update(f.previous.agentSessionId, f.previous.run, (value: AgentMuxStoredAgentSession) => ({ ...value, updatedAt: stored!.updatedAt + 1,
    nativeSourceObservation: { state: 'ambiguous', run: { ...value.run }, observedAt: stored!.updatedAt + 1, reason: 'frontend-selection-unconfirmed',
      candidates: [{ kind: 'provider', providerId: 'resume-process', sessionId: 'candidate-a' }, { kind: 'provider', providerId: 'resume-process', sessionId: 'candidate-b' }] } }))
  const result = await continuity(f, 'with-candidates', 'manual')
  expect(result).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable' })
})

it('keeps an unconfirmed identity save on the existing identity path', async () => {
  // A native identity may have been observed and only its save is unconfirmed: not "never had one".
  const f = await emptyEndedSession()
  ;(f.inner.registry as { unconfirmedDurability: Set<string> }).unconfirmedDurability.add(f.previous.agentSessionId)
  const result = await continuity(f, 'save-unconfirmed', 'manual')
  expect(result).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable' })
  noNewStartOrInput(f)
})

it('does not turn an unknown Runtime state into a final answer', async () => {
  const f = await emptyEndedSession()
  const status = f.inner.kernel.status.bind(f.inner.kernel)
  f.inner.kernel.status = async (runId: string) => {
    if (runId === f.previous.run.runId) throw new core.AgentMuxError('Runtime status is unavailable.', 'CTXMUX_DISCONNECTED')
    return await status(runId)
  }
  const result = await continuity(f, 'runtime-unknown', 'startup')
  expect(result).toMatchObject({ kind: 'pending', reason: 'runtime-unverified' })
})

it('reports the dedicated reason through the public empty-text resume, Hosted client and compiled CLI', async () => {
  const f = await emptyEndedSession()
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => ({ runtimeId: 'empty-runtime', ownerInstanceId: 'empty-owner', protocolVersion: 2,
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
  if (process.env.AGENTMUX_TEST_OBJECT_CLI) {
    // The compiled CLI consumes the same public owner; verify-empty-native-recovery.mjs supplies it.
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${socketPath}`, 'agent', 'resume', '--session', f.previous.agentSessionId, '--operation-id', 'cli-empty'], objectCliEnvironment(f.root))
    expect(cli.code, cli.stdout + cli.stderr).toBe(1)
    expect(cli.stdout + cli.stderr).toContain('AGENT_RESUME_UNAVAILABLE')
    expect(cli.stdout + cli.stderr).toContain('native-conversation-absent')
  }
  noNewStartOrInput(f)
})
