import { fixtureClock, fixtureDay } from '../helpers/fixture-values.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'
import type { CtxmuxAdapterRun } from '../../src/ctxmux-run-adapter.js'

/** Actual Provider, FileStore, Registry and Client. Only the private process/Hook seams are controlled. */
export async function retiredReopenFixture(providerId: 'claude' | 'pi' = 'claude', historyItems = 1) {
  const root = await mkdtemp(join(tmpdir(), 'amx-retired-reopen-'))
  for (const key of Object.keys(process.env).filter(key => key.startsWith('AGENTMUX_'))) vi.stubEnv(key, undefined)
  await mkdir(join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(root, 'sessions.json'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const path = join(root, 'native.jsonl')
  const data = providerId === 'claude'
    ? [{ sessionId: 'native-main', uuid: 'input-1', type: 'user', timestamp: fixtureDay(1) + "T" + fixtureClock(0, 0, 0) + "Z", message: { role: 'user', content: 'Original native conversation' } }]
    : [{ type: 'session', version: 3, id: 'native-main', cwd: root, timestamp: fixtureDay(1) + "T" + fixtureClock(0, 0, 0) + "Z" },
      { type: 'message', id: 'input-1', parentId: null, timestamp: fixtureDay(1) + "T" + fixtureClock(0, 1, 0) + "Z", message: { role: 'user', content: 'Original native conversation' } }]
  await writeFile(path, data.map(value => JSON.stringify(value)).join('\n') + '\n')
  const storePath = join(root, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(storePath)
  const old: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId, executorId: providerId,
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 2,
    hookBindingId: 'old-binding', hookToken: 'old-token', nativeHandle: { kind: 'provider', providerId, sessionId: 'native-main', transcriptPath: path } }
  await store.compareAndSwap(null, old)
  for (let index = 0; index < historyItems; index++) await store.applyTimelineMutation({ type: 'append', agentSessionId: old.agentSessionId, item: {
    id: `captured-${index + 1}`, agentSessionId: old.agentSessionId, kind: 'user_message', status: 'complete', source: 'user',
    createdAt: 2, updatedAt: 2, title: 'Original input', content: 'Captured original content' } })
  const stop = { kind: 'stop' as const, reservationId: 'original-stop', ownerId: 'old-owner', ownerPid: process.pid,
    agentSessionId: old.agentSessionId, operationId: 'original-stop', expiresAt: Date.now() + 60_000, expectedRun: old.run,
    stopOperation: { daemonInstance: 'original-daemon', operationKey: 'original-stop', runId: old.run.runId } }
  await store.reserveLifecycle(stop); await store.commitLifecycle(stop, null)
  const retired = (await store.loadRetiredAgentSessions())[0]!
  const client = new AgentMuxClient({ store }), inner = client as unknown as {
    connected: boolean; registry: { load(host: string): Promise<void> }; kernel: Record<string, any>;
    hookServer: Record<string, any>; ensureTerminalHandshakeOrDegrade: (session: AgentMuxStoredAgentSession) => Promise<AgentMuxStoredAgentSession>
  }
  await inner.registry.load('local'); inner.connected = true
  const starts: Record<string, any>[] = [], stops: string[] = [], binds: string[] = [], events: unknown[] = []
  const run = (runId: string, running = runId !== old.run.runId): CtxmuxAdapterRun => ({ nativeService: null,
    runId, lifecycleOperationId: null, program: providerId, args: [], workspacePath: root, pid: running ? 12345 : null,
    state: running ? { type: 'running' } : { type: 'exited', code: 0, signal: null }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 })
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 21, buildIdentity: 'private-b061' })
  inner.kernel.status = vi.fn(async (id: string) => {
    const index = /^new-run-(\d+)$/.exec(id)
    return { ...run(id), lifecycleOperationId: index ? starts[Number(index[1]) - 1]?.operationKey ?? null : null }
  })
  inner.kernel.start = vi.fn(async (input: Record<string, any>) => { starts.push(input); return { ...run(`new-run-${starts.length}`), lifecycleOperationId: input.operationKey } })
  inner.kernel.list = vi.fn(async () => starts.map((input, index) => ({ ...run(`new-run-${index + 1}`), lifecycleOperationId: input.operationKey })))
  inner.kernel.stop = vi.fn(async (operation: { runId: string }) => { stops.push(operation.runId) })
  inner.kernel.prepareStop = vi.fn(async (id: string) => ({ daemonInstance: 'private-daemon', operationKey: `cleanup-${id}`, runId: id }))
  inner.kernel.input = vi.fn(); inner.kernel.disconnect = vi.fn(async () => {})
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = vi.fn(() => ({ bindingId: 'fresh-binding', endpoint: { url: 'http://127.0.0.1:0', token: 'fresh-token' },
    bindRun: vi.fn(async (id: string) => { client.agentSession(old.agentSessionId); binds.push(id) }), close: vi.fn(async () => {}) }))
  vi.spyOn(client, 'connect').mockResolvedValue()
  vi.spyOn(client, 'probeAgent').mockResolvedValue({ providerId, executable: providerId, installed: true, capabilities: client.providers.get(providerId).catalog.capabilities })
  vi.spyOn(client as any, 'ensureManagedHooks').mockResolvedValue(undefined)
  inner.ensureTerminalHandshakeOrDegrade = async session => session
  client.onEvent(event => events.push(event))
  const nativeBefore = await readFile(path), timelineBefore = await store.loadTimeline(old.agentSessionId)
  return { root, path, storePath, store, old, retired, client, inner, starts, stops, binds, events, run, nativeBefore, timelineBefore,
    input: { agentSessionId: old.agentSessionId, expectedRetiredAt: retired.observedAt, operationId: 'explicit-continue' },
    close: async () => { await client.dispose(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() } }
}
