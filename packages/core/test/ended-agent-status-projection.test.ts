import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as sourceCore from '../src/index.js'
import * as sourceServer from '../src/public-rpc-server.js'
import * as sourceCodec from '../src/rpc-native-codec.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

const selected = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
const core = selected ? await import(/* @vite-ignore */ selected) as typeof sourceCore : sourceCore
const serverOwner = selected
  ? await import(/* @vite-ignore */ new URL('./public-rpc-server.js', selected).href) as typeof sourceServer : sourceServer
const codec = selected
  ? await import(/* @vite-ignore */ new URL('./rpc-native-codec.js', selected).href) as typeof sourceCodec : sourceCodec
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function fixture(providerId: 'claude' | 'codex', state: 'exited' | 'interrupted' = 'exited') {
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  const root = await mkdtemp(join(tmpdir(), 'amux-ended-status-'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId, executorId: providerId,
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'private-original-binding', hookToken: 'private-original-token', createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId, sessionId: 'original-native', transcriptPath: join(root, 'original-native.jsonl') },
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: reshapeFixtureEpoch(0, 0, 1) } }
  const store = new core.AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  await store.compareAndSwap(null, session)
  const client = new core.AgentMuxClient({ store })
  const inner = client as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, any> }
  await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
  const run: CtxmuxAdapterRun = { runId: session.run.runId, lifecycleOperationId: null, program: providerId, args: [], workspacePath: root,
    pid: null, state: state === 'exited' ? { type: 'exited', exitCode: 0 } : { type: 'interrupted', reason: 'daemon_restart' },
    cols: 80, rows: 24, latestOutputBytes: 3, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }
  inner.kernel.status = vi.fn(async () => run)
  const controls = ['start', 'input', 'resize', 'stop', 'attach'].map(name => vi.spyOn(inner.kernel, name))
  const server = new serverOwner.AgentMuxControlServer({ socketPath: join(root, 'original.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  return { root, session, store, client, inner, rpc, controls,
    close: async () => { await rpc.dispose(); await server.stop(); await client.dispose(); await rm(root, { recursive: true, force: true }) } }
}

it.each([
  ['claude', 'exited'], ['claude', 'interrupted'], ['codex', 'exited'], ['codex', 'interrupted']
] as const)('projects the original %s %s Session through SDK, inspect, context and snapshot without exposing internal hook credentials', async (providerId, state) => {
  const f = await fixture(providerId, state)
  try {
    const status = await f.client.statusAgent(f.session.agentSessionId)
    expect(status.observation).toMatchObject({ process: state, semantic: 'unknown', readiness: 'unknown', source: 'run-process' })
    expect(status.session.nativeHandlePersistence).toBe('confirmed')
    for (const key of ['hookBindingId', 'hookToken', 'activityCommit', 'futurePromptIntents']) expect(Object.hasOwn(status.session, key)).toBe(false)
    const inspected = await f.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: f.session.agentSessionId } })
    const context = await f.rpc.call('agent.context', { hostId: 'local', agentSessionId: f.session.agentSessionId })
    const snapshot = await f.rpc.call('app.snapshot', { include: ['sessions'] })
    for (const value of [inspected.status, context.status, snapshot.sessions[0]]) {
      expect(value).not.toBeNull()
      expect(value!.session.agentSessionId).toBe(f.session.agentSessionId)
      expect(value!.session.run).toEqual(f.session.run)
      expect(value!.session.nativeHandle).toEqual(f.session.nativeHandle)
      expect(value!.session.nativeHandlePersistence).toBe('confirmed')
      expect(value!.run.state).toBe(state)
      expect(Object.hasOwn(value!.session, 'hookBindingId')).toBe(false)
      expect(Object.hasOwn(value!.session, 'hookToken')).toBe(false)
    }
    expect(context.descriptor.state).toBe('active')
    expect((await f.store.readMetadata(f.session.agentSessionId))!.hookToken).toBe(f.session.hookToken)
    for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('keeps the public codec strict when a closed result contains internal Session credentials or another original binding', async () => {
  const f = await fixture('claude')
  try {
    const params = { target: { kind: 'agent-session' as const, agentSessionId: f.session.agentSessionId } }
    const inspected = await f.rpc.call('agent.inspect', params)
    expect(() => codec.parseRpcNativeResult('agent.inspect', inspected, params)).not.toThrow()
    for (const key of ['hookBindingId', 'hookToken']) {
      const bad = structuredClone(inspected)
      Object.assign(bad.status!.session, { [key]: f.session[key as 'hookBindingId' | 'hookToken'] })
      expect(() => codec.parseRpcNativeResult('agent.inspect', bad, params)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
    const bad = structuredClone(inspected)
    bad.status!.session.run = { runId: 'another-run' }
    expect(() => codec.parseRpcNativeResult('agent.inspect', bad, params)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('keeps an unavailable closed Run observation unknown while retaining its exact Session and saved native conversation', async () => {
  const f = await fixture('claude')
  try {
    f.inner.kernel.status.mockRejectedValue(new core.AgentMuxError('Original Run status unavailable', 'CONTROL_UNAVAILABLE'))
    const context = await f.rpc.call('agent.context', { hostId: 'local', agentSessionId: f.session.agentSessionId })
    expect(context.status).toBeNull()
    expect(context.session!.run).toEqual(f.session.run)
    expect(context.session!.nativeHandle).toEqual(f.session.nativeHandle)
    expect(context.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'status', code: 'CONTROL_UNAVAILABLE' })]))
    expect((await f.store.readMetadata(f.session.agentSessionId))!.run).toEqual(f.session.run)
    for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  } finally { await f.close() }
})
