import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises'
import { createServer, createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentSessionObservationRetries } from '../src/session-observation-retry.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import { stageMoteSourceListener } from '../../../apps/desktop/test/helpers/mote-diagnostics-cli.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

async function until(check: () => boolean | Promise<boolean>, description: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Private observation proof did not satisfy: ' + description)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const transcript = (id: string, turn = 'original-turn') => [
  { type: 'session_meta', payload: { id } },
  { type: 'event_msg', ordinal: 1, payload: { type: 'task_started', turn_id: turn, thread_id: id } },
  { type: 'event_msg', ordinal: 2, payload: { type: 'task_complete', turn_id: turn, thread_id: id } }
].map(row => JSON.stringify(row)).join('\n') + '\n'

it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('exact Session observation retry: actual Native and public Hosted consumers retain healthy work without global reopening', async () => {
  const receiptPath = process.env.AGENTMUX_SESSION_OBSERVATION_RECEIPT
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-obs-'))), state = join(root, 'state')
  await mkdir(state)
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(state, 'messages.ndjson'))
  const backend = join(root, 'native.sock'), endpoint = join(root, 'ctxmux.sock')
  const daemon = spawn(resolve('packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd'),
    ['--socket', backend, '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  const closed = once(daemon, 'close'); let ready = '', stderr = ''
  daemon.stdio[3]!.on('data', data => { ready += data }); daemon.stderr!.on('data', data => { stderr += data })
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); return socket }
  const proxy = createServer({ allowHalfOpen: true }, socket => {
    const front = track(socket), back = track(createConnection({ path: backend, allowHalfOpen: true }))
    front.pipe(back); back.pipe(front); front.once('close', () => back.destroy()); back.once('error', () => front.destroy())
  })
  const native = new AgentProviderRegistry().get('codex')
  const { terminalHandshake: _handshake, terminalPromptRender: _composer, ...withoutHandshake } = native
  const observations = new Map<string, number>()
  const provider = { ...withoutHandshake, observeSessionStatus: async (context: Parameters<NonNullable<typeof native.observeSessionStatus>>[0]) => {
    const id = context.nativeHandle!.kind === 'provider' ? context.nativeHandle!.sessionId : 'unknown'
    observations.set(id, (observations.get(id) ?? 0) + 1)
    return await native.observeSessionStatus!(context)
  } }
  const store = new AgentMuxMemoryAgentSessionStore(), core = new AgentMuxClient({ store, providers: [provider] }), inner = core as any
  Object.assign(inner.hookServer, { port: 0 })
  const runs: Array<{ runId: string; pid: number | null }> = [], events: AgentMuxClientEvent[] = []
  core.onEvent(event => events.push(event))
  let server: AgentMuxControlServer | undefined, service: AgentMuxHostedRuntimeService | undefined
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, sdk: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  const product = { schema: 'agentmux.session-observation-retry.v1', userRuntimeTouched: false, claim: 'generic-terminal-runs-and-private-native-protocol-files',
    originalRuns: [] as unknown[], sourceObservations: {} as Record<string, number>, globalCounts: {} as Record<string, number>, automaticRetry: false,
    readerLossRetainsRuntime: false, explicitNativeReconnect: false, unexpectedOwnedDaemonExit: 'not-exercised' }
  try {
    await until(() => ready.includes('\n'), 'exact test daemon readiness: ' + stderr)
    proxy.listen(endpoint); await once(proxy, 'listening')
    await core.connect()
    const records: AgentMuxStoredAgentSession[] = []
    const add = async (id: string, available = true) => {
      const run = await core.createTerminal({ createOperationId: 'private-' + id, workspacePath: root, command: process.execPath,
        args: ['-e', `process.stdin.setEncoding('utf8');process.stdin.on('data',s=>process.stdout.write('private-echo:'+s))`] })
      runs.push(run)
      const path = join(root, id + '.jsonl')
      if (available) await writeFile(path, transcript(id))
      const record: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: id, hostId: 'local', providerId: 'codex', executorId: 'private',
        workspacePath: root, run: { runId: run.runId }, retiredRuns: [], hookBindingId: id + '-binding', hookToken: id + '-token',
        capabilityHash: 'c'.repeat(43), createdAt: 1, updatedAt: 1,
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: id, transcriptPath: path },
        nativeBinding: { source: 'native-hook', run: { runId: run.runId }, observedAt: 1 } }
      await store.compareAndSwap(null, record); records.push(record); return record
    }
    const slow = await add('slow', false), healthy = await add('healthy'), peer = await add('peer')
    const owner = { runtimeId: 'private-observation-runtime', ownerInstanceId: 'private-observation-owner', protocolVersion: 2 as const,
      processId: process.pid, availability: 'connected' as const, ctxmux: core.runtimeIdentity() }
    service = new AgentMuxHostedRuntimeService(core, null, () => owner)
    await stageMoteSourceListener()
    server = new AgentMuxControlServer({ socketPath: join(root, 'core.sock'), coreClients: () => [{ hostId: 'local', client: core }], hostedRuntime: () => service })
    await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'core.sock') } })
    sdk = await connectHostedAgentMux({ rpc })
    const load = vi.spyOn(inner.registry, 'load'), list = vi.spyOn(inner.kernel, 'list'), lifecycle = vi.spyOn(inner, 'recoverStaleLifecycles')
    const handshakes = vi.spyOn(inner, 'ensureTerminalHandshakeOrDegrade')
    // Seed an actual initial full observation of newly saved durable Sessions.
    inner.connectionNeedsObservation = true; await sdk.refreshAgentSession('healthy', healthy.run)
    try { await until(() => observations.get('slow') === 1 && core.agentSession('healthy').semanticStatus?.state === 'done', 'original exact unknown and healthy native source') }
    catch (error) { console.error(JSON.stringify({ counts: Object.fromEntries(observations), errors: events.filter(event => event.type === 'agent-error'),
      needsObservation: inner.connectionNeedsObservation, sessions: core.agentSessions().map(s => ({ id: s.agentSessionId, semanticStatus: s.semanticStatus, nativeHandle: s.nativeHandle })) })); throw error }
    const counts = () => ({ load: load.mock.calls.length, list: list.mock.calls.length, lifecycle: lifecycle.mock.calls.length, handshake: handshakes.mock.calls.length })
    const original = counts(), healthyReads = observations.get('healthy'), peerReads = observations.get('peer')
    for (let index = 0; index < 20; index++) { await sdk.statusAgent('healthy'); await sdk.statusAgent('slow'); await sdk.refreshAgentSession('healthy', healthy.run) }
    expect(counts(), 'auxiliary unknown must not reopen global recovery').toEqual(original)
    expect(observations.get('slow'), 'passive reads share the pending original reader retry').toBe(1)
    expect(observations.get('healthy')).toBe(healthyReads); expect(observations.get('peer')).toBe(peerReads)
    const attachment = await sdk.attachTerminal(healthy.run.runId, 0), cursor = attachment.run.acceptedInputBytes!
    expect(attachment.run.pid).toBe(runs.find(run => run.runId === healthy.run.runId)!.pid)
    const input = 'original-healthy-input\n'
    await sdk.writeTerminal(healthy.run, { ownerInstanceId: core.runtimeIdentity().instanceId, operationId: 'private-healthy-input', expectedByte: cursor, data: input })
    await until(async () => (await sdk!.readRunReplay(healthy.run, 0, 'raw')).replay.some(chunk => Buffer.from(chunk.dataBytes).toString().includes('private-echo:original-healthy-input')), 'real original input and live output')
    // Adding unrelated real Runs requires one deliberate membership observation, then no more.
    for (const id of ['extra-one', 'extra-two', 'extra-three']) await add(id)
    inner.connectionNeedsObservation = true; await sdk.refreshAgentSession('healthy', healthy.run)
    const expanded = counts(), unaffected = Object.fromEntries([...observations].filter(([id]) => id !== 'slow'))
    for (let index = 0; index < 12; index++) { await sdk.statusAgent('healthy'); await sdk.refreshAgentSession('healthy', healthy.run) }
    expect(counts()).toEqual(expanded)
    expect(Object.fromEntries([...observations].filter(([id]) => id !== 'slow'))).toEqual(unaffected)
    // No public refresh/connect is made after materialization: the original timer must recover it.
    await writeFile(slow.nativeHandle!.kind === 'provider' ? slow.nativeHandle!.transcriptPath! : '', transcript('slow'))
    await until(() => core.agentSession('slow').semanticStatus?.state === 'done', 'automatic exact source retry', 35000)
    product.automaticRetry = true
    expect(observations.get('slow')).toBe(2)
    expect(counts()).toEqual(expanded)
    expect(Object.fromEntries([...observations].filter(([id]) => id !== 'slow'))).toEqual(unaffected)
    await sdk.refreshAgentSession('healthy', healthy.run)
    expect(counts()).toEqual(expanded)
    // One external-owner reader ending is not Runtime death and must retain healthy capability.
    const epoch = inner.connectionEpoch, lostCount = events.filter(event => event.type === 'connection-state' && event.state === 'lost').length
    for (const socket of sockets) socket.destroy()
    await sdk.statusAgent('healthy')
    expect(inner.connectionEpoch).toBe(epoch)
    expect(events.filter(event => event.type === 'connection-state' && event.state === 'lost')).toHaveLength(lostCount)
    product.readerLossRetainsRuntime = true
    // Explicit Core release really closes its Native transport/readers. The original public
    // Session request then performs full recovery against the same still healthy owner.
    core.disconnect()
    expect(inner.connectionEpoch).toBeGreaterThan(epoch)
    await sdk.refreshAgentSession('healthy', healthy.run)
    expect(inner.connected).toBe(true); expect(inner.connectionNeedsObservation).toBe(false)
    expect(load.mock.calls.length, 'explicit reconnection still performs full Store recovery').toBeGreaterThan(expanded.load)
    const after = await sdk.statusAgent('healthy')
    expect(after.run).toMatchObject({ runId: healthy.run.runId, pid: attachment.run.pid, state: 'running', acceptedInputBytes: cursor + Buffer.byteLength(input) })
    expect(after.session.run).toEqual(healthy.run); expect(core.agentSession('peer').run).toEqual(peer.run)
    expect(core.runtimeIdentity().instanceId).toBe(owner.ctxmux.instanceId)
    product.explicitNativeReconnect = true; product.originalRuns = runs; product.sourceObservations = Object.fromEntries(observations); product.globalCounts = counts()
    if (receiptPath) await writeFile(receiptPath, JSON.stringify(product, null, 2))
  } finally {
    await sdk?.dispose(); await rpc?.dispose(); await server?.stop(); await service?.dispose()
    for (const run of runs) await core.stopTerminal(run).catch(() => {})
    await core.dispose()
    for (const socket of sockets) socket.destroy()
    if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()))
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM')
    await closed
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

it('exact Session observation retry: late source/epoch work, coalescing and owner disposal cannot settle another observation', async () => {
  const session = { agentSessionId: 'original', hostId: 'local', run: { runId: 'original-run' }, providerId: 'codex', workspacePath: '/private-fixture', hookBindingId: 'binding' } as AgentMuxStoredAgentSession
  let epoch = 1, current = session, release!: (complete: boolean) => void, calls = 0, confirmed = 0
  const signals: AbortSignal[] = []
  const retry = new AgentSessionObservationRetries(target => target.epoch === epoch && target.session === current,
    async (_target, _kind, signal) => { calls++; signals.push(signal); const complete = await new Promise<boolean>(resolve => { release = resolve }); return complete && !signal.aborted }, () => { confirmed++ })
  try {
    retry.queue({ session, epoch }, 'native-status')
    const first = retry.refresh({ session, epoch }), joined = retry.refresh({ session, epoch })
    expect(calls).toBe(1)
    retry.settle({ session: { ...session, run: { runId: 'other-run' } }, epoch }, 'native-status')
    expect(confirmed).toBe(0); expect(retry.has({ session, epoch }, 'native-status')).toBe(true)
    current = { ...session, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'replacement-native' } }
    retry.prune({ session: current, epoch })
    retry.queue({ session: current, epoch }, 'native-status')
    release(true); await first; await joined
    expect(confirmed, 'old source result must not settle the later source').toBe(0)
    expect(retry.has({ session: current, epoch }, 'native-status')).toBe(true)
    const later = retry.refresh({ session: current, epoch })
    epoch++; release(true); await later
    expect(confirmed, 'old connection epoch must not confirm current observation').toBe(0)
    retry.queue({ session: current, epoch }, 'native-status')
    const disposed = retry.refresh({ session: current, epoch })
    retry.clear(); expect(signals.at(-1)!.aborted, 'owner release cancels its original pending reader').toBe(true)
    release(true); await disposed
    expect(confirmed).toBe(0); expect(retry.has()).toBe(false)
  } finally { retry.clear() }
})

it('exact Session observation retry: the next connection waits for the old Hook owner then restores its own binding', async () => {
  const h = await rpcOwnerFixture(['retained']), inner = h.client as any
  const [initial] = await h.store.load() as AgentMuxStoredAgentSession[]
  const stored = { ...initial!, hookBindingId: 'b'.repeat(43), hookToken: 't'.repeat(43) }
  await h.store.compareAndSwap(initial!, stored)
  Object.assign(inner.hookServer, { port: 0 })
  let release!: () => void, entered = false, connected = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const start = inner.hookServer.start.bind(inner.hookServer)
  const starts = vi.spyOn(inner.hookServer, 'start').mockImplementationOnce(async () => { entered = true; await gate; return await start() })
  const create = vi.spyOn(inner.hookServer, 'createBinding'), load = vi.spyOn(inner.registry, 'load')
  inner.kernel.connect = vi.fn(async () => { connected = true })
  inner.kernel.isConnected = () => connected
  inner.kernel.resetConnection = () => { connected = false }
  inner.kernel.list = async () => [h.run(stored.run.runId)]
  inner.reconnectSleep = async () => {}; inner.connected = false
  const old = h.client.connect(); void old.catch(() => {})
  try {
    await until(() => entered, 'old Hook opening barrier')
    connected = false; inner.handleConnectionLost(inner.connectionEpoch)
    await until(() => load.mock.calls.length === 2, 'new full connection observation reaches original Hook owner')
    expect(create).not.toHaveBeenCalled()
    release(); await old.catch(() => {})
    await until(() => inner.hookBindings.has(stored.run.runId), 'new connection Hook binding')
    expect(starts).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledOnce()
    expect(h.client.agentSession(stored.agentSessionId)).toMatchObject({ run: stored.run })
    expect(h.client.agentSession(stored.agentSessionId).hookIngressObservation).toBeUndefined()
  } finally { release(); await old.catch(() => {}); await h.close(); vi.restoreAllMocks() }
})
