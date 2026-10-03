import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { expect, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry, normalizeAgentSession, type AgentMuxAgentSession, type AgentMuxStoredAgentSession } from '@agentmux/core'

/** Real Core/FileStore; only private Native I/O, probes and hooks are controlled. */
export async function injectedContextCore(root: string, initial?: AgentMuxStoredAgentSession) {
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const path = join(root, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  const sessions = (await store.load()).map(value => normalizeAgentSession(value))
  if (initial && sessions.length === 0) await store.compareAndSwap(null, initial)
  const requests: Array<{ runId: string; operationId: string; expectedByte: number; data: string }> = []
  const writes: string[] = [], receipts = new Map<string, unknown>(), cursors = new Map<string, number>()
  const runs = new Map<string, ReturnType<typeof run>>()
  function run(runId: string, workspacePath = root) {
    return { nativeService: null, runId, lifecycleOperationId: null, program: 'claude', args: [], workspacePath,
      pid: 321, state: { type: 'running' as const }, cols: 80, rows: 24, latestOutputBytes: 0,
      firstAvailableByte: 0, acceptedInputBytes: cursors.get(runId) ?? 0 }
  }
  if (initial) runs.set(initial.run.runId, run(initial.run.runId, initial.workspacePath))
  for (const session of sessions) runs.set(session.run.runId, run(session.run.runId, session.workspacePath))
  // This private Native backend survives the test client process; real Core remains the intent owner.
  const nativePath = join(root, 'private-native.json')
  try {
    const saved = JSON.parse(await readFile(nativePath, 'utf8'))
    for (const [key, value] of saved.receipts) receipts.set(key, value)
    for (const [key, value] of saved.cursors) cursors.set(key, value)
    writes.push(...saved.writes)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const persistNative = async () => writeFile(nativePath, JSON.stringify({ receipts: [...receipts], cursors: [...cursors], writes }))
  let loseAck = false
  const start = vi.fn(async (input: { workspacePath: string }) => {
    const created = run(`private-fresh-run-${start.mock.calls.length}`, input.workspacePath)
    runs.set(created.runId, created); return created
  }), stop = vi.fn()
  const clients: AgentMuxClient[] = []
  const make = async () => {
    const freshStore = new AgentMuxFileAgentSessionStore(path), core = new AgentMuxClient({ store: freshStore })
    clients.push(core)
    const inner = core as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> };
      kernel: Record<string, unknown>; hookServer: Record<string, unknown>;
      ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown }
    await inner.registry.load('local'); inner.connected = true
    vi.spyOn(core, 'connect').mockResolvedValue()
    Object.assign(inner.kernel, { isConnected: () => true,
      identity: () => ({ daemonInstanceId: 'private-original-daemon', protocolVersion: 18, buildIdentity: 'private-io' }),
      status: async (id: string) => { const value = runs.get(id); if (!value) throw new Error(`Unknown private Run ${id}`); return { ...value, acceptedInputBytes: cursors.get(id) ?? 0 } },
      list: async () => [...runs.values()], start, stop,
      input: async (runId: string, input: { operationId: string; expectedByte: number; data: string }) => {
        expect(runs.has(runId)).toBe(true)
        requests.push({ runId, ...structuredClone(input) })
        const key = `${runId}:${input.operationId}`, previous = receipts.get(key)
        if (previous) expect(input).toEqual(previous)
        else {
          expect(input.expectedByte).toBe(cursors.get(runId) ?? 0)
          receipts.set(key, structuredClone(input)); writes.push(input.data)
          cursors.set(runId, input.expectedByte + Buffer.byteLength(input.data))
        }
        await persistNative()
        if (loseAck) { loseAck = false; throw new Error('Private Input accepted; ACK lost') }
        return { run: { ...runs.get(runId)!, acceptedInputBytes: cursors.get(runId)! },
          appliedByteRange: { startByte: input.expectedByte, endByte: input.expectedByte + Buffer.byteLength(input.data) } }
      } })
    inner.hookServer.isRunning = () => true
    inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) },
      bindRun: async () => {}, close: async () => {} })
    vi.spyOn(core, 'probeAgent').mockImplementation(async id => ({ providerId: id, executable: id, installed: true,
      capabilities: new AgentProviderRegistry().get(id).catalog.capabilities }))
    inner.ensureManagedHooks = async () => {}
    inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
    return { core, store: freshStore }
  }
  const first = await make()
  return { ...first, make, requests, writes, start, stop, loseNextAck: () => { loseAck = true },
    dispose: async () => { for (const core of clients.reverse()) await core.dispose() } }
}
