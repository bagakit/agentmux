import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CtxmuxClient, PROTOCOL_VERSION, type RunInfo, type RuntimeIdentity } from '@ctxmux/sdk'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import type { AgentMuxClient as SourceClient } from '../src/client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
const { AgentMuxClient } = await import(process.env.AGENTMUX_TEST_CONNECTION_CORE_ENTRY ?? '../src/client.js') as typeof import('../src/client.js')
const { connectHostedAgentMux } = await import(process.env.AGENTMUX_TEST_CONNECTION_HOSTED_ENTRY ?? '../dist/hosted-client.js') as typeof import('../src/hosted-client.js')
const { connectAgentMuxRpc } = await import('../dist/public-rpc-client.js') as typeof import('../src/public-rpc-client.js')
const { AgentMuxHostedRuntimeService } = await import('../dist/hosted-runtime-service.js') as typeof import('../src/hosted-runtime-service.js')
const { AgentMuxControlServer } = await import('../dist/public-rpc-server.js') as typeof import('../src/public-rpc-server.js')

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const runId = '12be7432-37cf-4d24-9634-1e1a018bd72c'
const nativeService: RunInfo['native_service'] = { revision: 1, owner: { type: 'serving' }, output: { type: 'serving' },
  input: { phase: { type: 'open' }, unsettled_commands: 0, unsettled_request_bytes: 0, write_blocked: false,
    completed_input_bytes: 0, current_size: { cols: 80, rows: 24 }, active_confirmed_bytes: 0 }, terminal_fault: null }

it('reports real Native attachment EOF through the original Core connection producer without inventing a Run exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-native-connection-'))
  const runtime: RuntimeIdentity = { daemonInstanceId: randomUUID(), runtimeId: randomUUID(), runtimeIdPersistence: 'state_dir',
    buildId: 'private-connection-fixture', protocolGeneration: PROTOCOL_VERSION, platform: 'macos', arch: 'aarch64', capabilities: {} }
  const nativeRun: RunInfo = { id: runId, spec: { program: process.execPath, args: [], cwd: root, env: {},
    initial_size: { cols: 80, rows: 24 }, declared_inputs: [] }, lineage: null, backend: { type: 'native' },
    capabilities: { input: true, resize: true, signal: true, stop: true, fork_level_a: true, fork_level_b: true, replay: 'raw_from_start' },
    pid: process.pid, state: { type: 'running' }, current_size: { cols: 80, rows: 24 }, latest_output_bytes: 0,
    durable_output_bytes: 0, first_available_byte: 0, attachments: 1, applied_input_bytes: 0, native_service: nativeService }
  const sockets = new Set<Socket>(); let attached: Socket | undefined
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    let pending = ''; socket.setEncoding('utf8'); socket.on('data', chunk => {
      pending += chunk
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n'), frame = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1)
        const send = (value: unknown) => socket.write(JSON.stringify(value) + '\n')
        if (frame.type === 'hello') send({ type: 'hello', runtime })
        else if (frame.request.type === 'attach') {
          attached = socket
          send({ type: 'attached', snapshot: { run: nativeRun, resize_revision: 0, terminal: { type: 'not_requested' },
            replay: { truncated: false, first_available_byte: 0, latest_output_bytes: 0 } } })
        } else if (frame.request.type === 'status') send({ type: 'response', response: { type: 'status', run: nativeRun } })
        else send({ type: 'error', error: { code: 'invalid_request', message: 'Unexpected fixture request' } })
      }
    })
  })
  const path = join(root, 'native.sock')
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const adapter = new CtxmuxRunAdapter(), sdk = new CtxmuxClient({ socketPath: path, expectedRuntimeIdentity: runtime })
  Object.assign(adapter, { client: sdk, runtime, ownership: 'unverified' })
  // Activation/owner receipt is outside this finite wire fixture. Core admission and
  // adapter attachment/pump/lost notification are production implementations.
  vi.spyOn(adapter, 'connect').mockResolvedValue(undefined)
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  Object.assign(client, { kernel: adapter })
  cleanup.push(() => client.dispose())
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => { events.push(event) })
  await client.connectRuntime()
  const snapshot = await client.attachTerminal(runId)
  expect(snapshot.run).toMatchObject({ runId, state: 'running', nativeService: { revision: 1 } })
  expect(attached).toBeDefined(); attached!.end()
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'connection-state', state: 'lost',
    observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' }, evidence: { source: 'run-process', observedAt: expect.any(Number) } })))
  expect(events.filter(event => event.type === 'process-state' && event.state !== 'running')).toEqual([])
  // The listener remains responsive and the same Run can still be read independently:
  // EOF does not establish a daemon/child/storage death or a business receipt.
  expect(await sdk.status(runId)).toMatchObject({ id: runId, state: { type: 'running' }, native_service: { revision: 1 } })
})

it('keeps a real Unix Hosted reader loss separate from Native facts and restores only that connection boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-host-connection-'))
  let publishCore: ((event: AgentMuxClientEvent) => void) | undefined
  const run = { nativeService: null, runId, kind: 'terminal' as const, providerId: null, executorId: null, agentSessionId: null,
    workspacePath: root, pid: process.pid, state: 'running' as const, cols: 80, rows: 24, observedAt: reshapeFixtureEpoch(0, 0, 1), latestOutputBytes: 0, acceptedInputBytes: 0 }
  const core = { connect: vi.fn(async () => {}), connectRuntime: vi.fn(async () => {}),
    onEvent: (listener: typeof publishCore) => { publishCore = listener; return () => { publishCore = undefined } },
    catalog: () => [], agentSessions: () => [], agentMessageQueuePath: () => join(root, 'messages'),
    runtimeIdentity: () => ({ hostId: 'local', instanceId: 'native-original', buildIdentity: 'private-fixture', protocolVersion: 22, processId: 42, ownership: 'unverified' as const }),
    runtimeProjection: vi.fn(async () => ({ hostId: 'local', subjects: [] })), listRuns: vi.fn(async () => [run]),
    stopTerminal: vi.fn(), createTerminal: vi.fn() }
  const service = new AgentMuxHostedRuntimeService(core as unknown as SourceClient, join(root, 'sessions.json'), () => hostedTestOwner(core as unknown as SourceClient))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'core.sock'), hostedRuntime: () => service })
  await server.start()
  cleanup.push(async () => { await server.stop(); await service.dispose(); await rm(root, { recursive: true, force: true }) })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc }); cleanup.push(() => client.dispose())
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => { events.push(event) })
  expect(publishCore).toBeDefined()
  publishCore!({ type: 'connection-state', state: 'lost', observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' },
    evidence: { source: 'run-process', observedAt: reshapeFixtureEpoch(0, 0, 111) } })
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ state: 'lost', observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' } })))
  const sockets = (server as unknown as { sockets: Set<Socket> }).sockets
  expect(sockets.size).toBeGreaterThan(0)
  for (const socket of [...sockets]) socket.destroy()
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'connection-state', state: 'lost',
    observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: expect.any(Number) } })))
  await client.connect()
  expect(await client.listRuns()).toEqual([run])
  expect(events).toContainEqual(expect.objectContaining({ state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' } }))
  expect(events.filter(event => event.type === 'connection-state' && event.state === 'restored' && event.observationOrigin.boundary === 'core-ctxmux')).toEqual([])
  expect(core.createTerminal).not.toHaveBeenCalled(); expect(core.stopTerminal).not.toHaveBeenCalled()
})
