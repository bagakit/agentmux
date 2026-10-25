import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONTINUITY_POLICY, normalizeAgentContinuityPolicy, parseAgentContinuityControlInput } from '@agentmux/core/agent-session-recovery'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

async function originalSession() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-recovery-module-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  for (const name of Object.keys(process.env).filter(name => name.startsWith('AGENTMUX_'))) vi.stubEnv(name, undefined)
  const runtime = join(directory, 'runtime'); await mkdir(runtime)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'durable'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'module-original', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: directory, run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'module-binding'.padEnd(43, 'B'), hookToken: 'module-token'.padEnd(43, 'T'),
    createdAt: 1, updatedAt: 1, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' }
  }
  const run: CtxmuxAdapterRun = {
    nativeService: null, runId: session.run.runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: directory,
    pid: 123, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0
  }
  const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store }); cleanups.push(() => client.dispose())
  const host = client as unknown as { registry: { load(id: string): Promise<void> }; connected: boolean;
    kernel: { isConnected(): boolean; status(id: string): Promise<CtxmuxAdapterRun>; start(): Promise<CtxmuxAdapterRun> } }
  await host.registry.load('local'); host.connected = true
  host.kernel.isConnected = () => true
  const start = vi.spyOn(host.kernel, 'start').mockRejectedValue(new Error('Unexpected replacement Run'))
  const status = vi.spyOn(host.kernel, 'status').mockResolvedValue(run)
  const probe = vi.spyOn(client as unknown as { probePreparedAgent: typeof client.probeAgent }, 'probePreparedAgent').mockRejectedValue(new Error('Unexpected executable probe'))
  return { client, store, start, status, probe, session }
}

it('publishes one recovery contract without exposing an independently constructible service', async () => {
  const recovery = await import('@agentmux/core/agent-session-recovery')
  expect(recovery).not.toHaveProperty('AgentSessionRecoveryService')
  expect(normalizeAgentContinuityPolicy()).toEqual(DEFAULT_AGENT_CONTINUITY_POLICY)
  expect(parseAgentContinuityControlInput({ agentSessionId: 'original', expectedRun: { runId: 'run' },
    operationId: 'control', intentOperationId: 'intent', action: 'cancel' })).toMatchObject({ action: 'cancel' })
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.exports['./agent-session-recovery']).toEqual({ types: './dist/agent-session-recovery.d.ts', import: './dist/agent-session-recovery.js' })
  expect(manifest.exports).not.toHaveProperty('./agent-session-continuity')
  expect(manifest.exports).not.toHaveProperty('./agent-session-continuity-control')
})

it('routes the public client through recovery while preserving the healthy original Run and receipt', async () => {
  const { client, store, start, probe, session } = await originalSession()
  const input = { agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'healthy-original', trigger: 'manual' as const }
  const result = await client.ensureAgentContinuity(input)
  expect(result).toMatchObject({ kind: 'reattachable', previousRun: session.run, run: { runId: session.run.runId } })
  const durable = await store.readMetadata(session.agentSessionId)
  expect(durable).toMatchObject({ agentSessionId: session.agentSessionId, run: session.run, nativeHandle: session.nativeHandle,
    continuityOperations: { [input.operationId]: { operationId: input.operationId, kind: 'reattachable', previousRun: session.run } } })
  expect(start).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled()
})

it('retains observation failure as unknown on the exact original operation without starting or probing', async () => {
  const { client, store, start, status, probe, session } = await originalSession()
  status.mockRejectedValue(new Error('Read transport unavailable'))
  const input = { agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'unknown-original',
    trigger: 'manual' as const, policy: { recheckMaxAttempts: 0 } }
  const result = await client.ensureAgentContinuity(input)
  expect(result).toMatchObject({ kind: 'pending', reason: 'runtime-unverified', evidence: { kind: 'run-unknown' } })
  expect(await store.readMetadata(session.agentSessionId)).toMatchObject({ agentSessionId: session.agentSessionId, run: session.run,
    nativeHandle: session.nativeHandle, continuityOperations: { [input.operationId]: { operationId: input.operationId, kind: 'pending' } } })
  expect(start).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled()
})
