import { expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller'
import { readFileSync } from 'node:fs'
import type { AgentMuxContinuityControlInput } from '@agentmux/core'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


it('Main forwards the exact original Core metadata control without waiting for presentation or invoking lifecycle methods', async () => {
  const packet: AgentMuxContinuityControlInput = { agentSessionId: 'original', intentOperationId: 'original-intent', expectedRun: { runId: 'original-run' }, operationId: 'original-cancel', action: 'cancel' }
  const receipt = { request: packet }, reply = { receipt, state: 'retired', retirement: { agentSessionId: 'original', hostId: 'original-host', run: packet.expectedRun, source: 'user', observedAt: _historyFixtureEpoch(0, 0, 1) } }
  const client = { controlAgentContinuity: vi.fn(async () => reply), stopAgentSession: vi.fn(), ensureAgentContinuity: vi.fn() }
  const runtime = Object.create(RuntimeController.prototype) as RuntimeController
  const connect = vi.fn(() => client), projection = vi.fn(async () => { throw new Error('Display unavailable') })
  Object.assign(runtime, { configuredClient: connect, sessionByTarget: projection })
  const outcome = runtime.controlContinuity('original-host', packet)
  await expect(outcome).resolves.toEqual({ hostId: 'original-host', result: reply })
  expect(connect).toHaveBeenCalledWith('original-host'); expect(client.controlAgentContinuity).toHaveBeenCalledWith(packet)
  expect(projection).not.toHaveBeenCalled(); expect(client.stopAgentSession).not.toHaveBeenCalled(); expect(client.ensureAgentContinuity).not.toHaveBeenCalled()
})

it('the actual typed IPC and preload route keep the exact request and structured failure code', () => {
  const main = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8'), preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  expect(main).toContain("handle('sessions:controlContinuity'")
  expect(main).toContain('sessionObservationResult(() => args.runtime.controlContinuity(hostId, input))')
  expect(preload).toContain("ipcRenderer.invoke('sessions:controlContinuity', hostId, input)")
  expect(preload).toContain("unwrapSessionObservationResult<{ hostId: string; result: import('@agentmux/core').AgentMuxContinuityControlResult }>")
})

it('the actual Main and Hosted Core cancel metadata while Native readiness is unavailable and preserve remote route scope', async () => {
  const { AgentMuxClient, AgentMuxMemoryAgentSessionStore, DEFAULT_AGENT_CONTINUITY_POLICY } = await import('@agentmux/core')
  const { AgentMuxHostedRuntimeService } = await import('../../../packages/core/src/hosted-runtime-service')
  const { AgentMuxControlServer } = await import('../../../packages/core/src/public-rpc-server')
  const { connectAgentMuxRpc } = await import('../../../packages/core/src/public-rpc-client')
  const { connectHostedAgentMux } = await import('../../../packages/core/src/hosted-client')
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'continuity-main-')), store = new AgentMuxMemoryAgentSessionStore()
  const nativeTarget = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }
  const root = { operationId: 'original-root', agentSessionId: 'original-session', trigger: 'startup' as const,
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: { runId: 'previous-run' }, newRun: { runId: 'current-run' }, nativeTarget,
    admittedAt: _historyFixtureEpoch(0, 0, 1), observedAt: _historyFixtureEpoch(0, 0, 2), rechecks: 0, kind: 'resumed' as const, reason: 'interrupted-working',
    evidence: { kind: 'run-ended' as const, state: 'interrupted' as const, observedAt: _historyFixtureEpoch(0, 0, 1) },
    supervision: { phase: 'paused' as const, activeAttemptOperationId: 'original-root', attemptCount: 1, attemptLimit: 1, observedAt: _historyFixtureEpoch(0, 0, 2), reason: 'retry-budget-exhausted' } }
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: root.agentSessionId, providerId: 'codex', executorId: 'original',
    hostId: 'local', workspacePath: directory, run: root.newRun, retiredRuns: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2),
    hookBindingId: 'original-binding', hookToken: 'original-token', nativeHandle: nativeTarget,
    continuity: root, continuityOperations: { [root.operationId]: root } })
  const client = new AgentMuxClient({ store }), connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Native readiness unavailable'))
  const hosted = new AgentMuxHostedRuntimeService(client, null, () => ({ runtimeId: 'private-main-owner', ownerInstanceId: 'private-main-instance',
    protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => hosted })
  let reader: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined, rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, 'control.sock') } }); reader = await connectHostedAgentMux({ rpc })
    const nativeConnect = vi.spyOn(reader, 'connect').mockRejectedValue(new Error('Reader Native readiness unavailable'))
    const runtime = Object.create(RuntimeController.prototype) as RuntimeController
    Object.assign(runtime, { hosts: new Map([['saved-remote', { client: reader }]]), hostReconfigurationReservations: new Set() })
    const packet: AgentMuxContinuityControlInput = { agentSessionId: root.agentSessionId, intentOperationId: root.operationId,
      expectedRun: root.newRun, operationId: 'original-remote-cancel', action: 'cancel' }
    const pending = runtime.controlContinuity('saved-remote', packet)
    await expect(pending).resolves.toMatchObject({ hostId: 'saved-remote', result: { receipt: { request: packet, outcome: 'cancelled' }, state: 'active', session: { hostId: 'local', agentSessionId: root.agentSessionId } } })
    expect(nativeConnect).not.toHaveBeenCalled(); expect((client as unknown as { kernel: { isConnected(): boolean } }).kernel.isConnected()).toBe(false)
    expect((await store.readMetadata(root.agentSessionId))?.run).toEqual(root.newRun)
    expect((await store.readMetadata(root.agentSessionId))?.continuityOperations?.[root.operationId]?.supervision?.phase).toBe('cancelled')
    await expect(runtime.controlContinuity('unknown-route', packet)).rejects.toThrow('not configured')
    await expect(runtime.controlContinuity('saved-remote', { ...packet, agentSessionId: 'foreign-session', operationId: 'foreign-control' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    ;(runtime as unknown as { hostReconfigurationReservations: Set<string> }).hostReconfigurationReservations.add('saved-remote')
    await expect(runtime.controlContinuity('saved-remote', packet)).rejects.toThrow('reconfigured')
  } finally { await reader?.dispose(); await rpc?.dispose(); await server.stop(); await hosted.dispose(); await client.dispose(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() }
})
