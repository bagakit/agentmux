import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CtxmuxClient, PROTOCOL_VERSION, type RunInfo, type RunStorageObservation, type RuntimeIdentity } from '@ctxmux/sdk'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import { AGENTMUX_CLI_HELP, AGENTMUX_CLI_SKILL } from '../src/agentmux-cli-help.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { objectCliReceipt } from './helpers/object-cli-receipt.js'

const closes: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const capability = 'services.storage_observation'
const originalRun = '12be7432-37cf-4d24-9634-1e1a018bd72c'
const otherRun = '71a0b623-8d58-4a82-90c2-7b616330b562'
const wireFacts: RunStorageObservation = {
  run_id: originalRun, latest_output_bytes: 140, memory_first_available_byte: 87,
  persistence: { first_failure: 'maintenance COMMIT requires recovery: database or disk is full',
    actor_stopped: false, queued_append_commands: 3, offered_output_bytes: 120, committed_output_bytes: 110 },
  policy: { run_output_bytes: 4194304, hot_output_bytes: 1073741824, durable_run_output_bytes: 4194304,
    durable_replay_bytes: 268435456, database_bytes: 402653184, wal_checkpoint_bytes: 8388608,
    terminal_history_rows: 10000, terminal_checkpoint_bytes: 33554432 }
}
const projected = {
  memory: { firstAvailableByte: 87, latestOutputByte: 140 },
  persistence: { firstFailure: wireFacts.persistence!.first_failure, actorStopped: false,
    queuedAppendCommands: 3, offeredByte: 120, confirmedByte: 110 },
  policy: { memoryPerRunBytes: 4194304, memorySharedBytes: 1073741824, replayPerRunBytes: 4194304,
    replaySharedBytes: 268435456, databaseBytes: 402653184, walCheckpointBytes: 8388608,
    terminalHistoryRows: 10000, terminalCheckpointBytes: 33554432 }
}

/** Finite wire/route qualification. Native's separate real-PTY tests own storage-fault semantics. */
async function nativeWire(storageSupported = true) {
  const root = await mkdtemp(join(tmpdir(), 'amx-storage-wire-')), path = join(root, 'native.sock')
  const runtime: RuntimeIdentity = { daemonInstanceId: randomUUID(), runtimeId: randomUUID(),
    runtimeIdPersistence: 'state_dir', buildId: 'ctxmuxd/private-storage-wire', protocolGeneration: PROTOCOL_VERSION,
    platform: 'macos', arch: 'aarch64', capabilities: { 'native.recoverable_input': 1,
      ...(storageSupported ? { [capability]: 1 } : {}) } }
  const state = { returnedRun: originalRun, persistence: wireFacts.persistence, applied: 0 }
  const requests: Array<Record<string, any>> = [], sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let pending = ''
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      pending += chunk
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n'), message = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1)
        const send = (value: unknown) => socket.write(JSON.stringify(value) + '\n')
        if (message.type === 'hello') { send({ type: 'hello', runtime }); continue }
        requests.push(message.request)
        const request = message.request
        if (request.type === 'observe_storage') {
          send({ type: 'response', response: { type: 'storage_observation',
            observation: { ...wireFacts, run_id: state.returnedRun, persistence: state.persistence } } })
        } else if (request.type === 'recoverable_input') {
          const operation = request.operation
          const start = state.applied; state.applied += Buffer.from(operation.data).byteLength
          const run: RunInfo = { id: operation.id, spec: { program: process.execPath, args: [], cwd: root, env: {},
              initial_size: { cols: 80, rows: 24 }, declared_inputs: [] }, lineage: null, backend: { type: 'native' },
            capabilities: { input: true, resize: true, signal: true, stop: true, fork_level_a: true,
              fork_level_b: true, replay: 'raw_from_start' }, pid: null, state: { type: 'running' },
            native_service: { revision: 1, owner: { type: 'serving' }, output: { type: 'serving' },
              input: { phase: { type: 'open' }, unsettled_commands: 0, unsettled_request_bytes: 0,
                write_blocked: false, completed_input_bytes: state.applied, current_size: { cols: 80, rows: 24 },
                active_confirmed_bytes: 0 }, terminal_fault: null },
            latest_output_bytes: 140, durable_output_bytes: 110, first_available_byte: 87,
            attachments: 0, applied_input_bytes: state.applied, current_size: { cols: 80, rows: 24 } }
          send({ type: 'response', response: { type: 'input_applied', run,
            range: { start_byte: start, end_byte: state.applied } } })
        } else send({ type: 'error', error: { code: 'invalid_request', message: 'Unexpected body in finite storage observer.' } })
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  closes.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const adapter = new CtxmuxRunAdapter()
  const inner = adapter as unknown as { client: CtxmuxClient; runtime: RuntimeIdentity }
  inner.client = new CtxmuxClient({ socketPath: path, expectedRuntimeIdentity: runtime }); inner.runtime = runtime
  return { root, runtime, state, requests, adapter, inner, path }
}
async function owner(storageSupported = true, id = 'storage-agent') {
  const native = await nativeWire(storageSupported), core = await rpcOwnerFixture([id]); closes.push(() => core.close())
  core.inner.kernel.identity = native.adapter.identity.bind(native.adapter)
  core.inner.kernel.observeStorage = native.adapter.observeStorage.bind(native.adapter)
  core.inner.kernel.input = native.adapter.input.bind(native.adapter)
  return { ...core, native, id }
}
async function publicEndpoint(coreClients: ConstructorParameters<typeof AgentMuxControlServer>[0]['coreClients'],
  hostedRuntime?: ConstructorParameters<typeof AgentMuxControlServer>[0]['hostedRuntime']) {
  const root = await mkdtemp(join(tmpdir(), 'amx-storage-rpc-')), path = join(root, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients, ...(hostedRuntime ? { hostedRuntime } : {}) })
  await server.start(); closes.push(async () => { await server.stop(); await rm(root, { recursive: true, force: true }) })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); closes.push(() => rpc.dispose())
  return { root, path, rpc }
}
/** Corrupt only the transport receipt, so the real public decoder must enforce request ownership. */
async function publicReceipt(result: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'amx-storage-receipt-')), path = join(root, 'receipt.sock')
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let pending = ''
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      pending += chunk
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n'), request = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1)
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  closes.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); closes.push(() => rpc.dispose())
  return rpc
}
function noLifecycleChanges(f: Awaited<ReturnType<typeof owner>>) {
  expect(f.inner.kernel.status).not.toHaveBeenCalled()
  expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.client.agentSession(f.id).run).toEqual({ runId: 'run-' + f.id })
  expect(f.native.adapter.isConnected()).toBe(true)
}

describe('exact storage owner through public Core, Hosted, RPC and compiled CLI', () => {
  it('keeps independent facts and null persistence through actual SDK/Adapter/Core without a replay or actor read', async () => {
    const f = await owner()
    const result = await f.client.observeRunStorage({ runId: originalRun })
    expect(result).toMatchObject({ status: 'observed', run: { runId: originalRun },
      runtime: { instanceId: f.native.runtime.daemonInstanceId, protocolVersion: PROTOCOL_VERSION }, storage: projected })
    expect(Number.isSafeInteger(result.observedAt)).toBe(true)
    expect(result.status === 'observed' && result.storage).not.toHaveProperty('durableFirstAvailableByte')
    f.native.state.persistence = null
    expect(await f.client.observeRunStorage({ runId: originalRun })).toMatchObject({ storage: { ...projected, persistence: null } })
    expect(f.native.requests.map(request => request.type)).toEqual(['observe_storage', 'observe_storage'])
    noLifecycleChanges(f)
  })

  it('retains the original queried Runtime identity when a newer owner appears before the observation completes', async () => {
    const f = await owner(), originalIdentity = f.client.runtimeIdentity()
    let release!: () => void, received!: () => void
    const gate = new Promise<void>(yes => { release = yes }), ready = new Promise<void>(yes => { received = yes })
    f.inner.kernel.observeStorage = async runId => {
      const observation = await f.native.adapter.observeStorage(runId)
      received(); await gate; return observation
    }
    const pending = f.client.observeRunStorage({ runId: originalRun })
    await ready
    f.inner.kernel.identity = () => ({ ...f.native.runtime, daemonInstanceId: randomUUID() })
    release()
    expect(await pending).toMatchObject({ status: 'observed', storage: projected, runtime: originalIdentity })
    expect(f.native.requests.map(request => request.type)).toEqual(['observe_storage'])
    noLifecycleChanges(f)
  })

  it('scopes missing optional capability to observation and keeps subsequent Core input on the original owner', async () => {
    const f = await owner(false), identity = f.client.runtimeIdentity()
    expect(await f.client.observeRunStorage({ runId: originalRun })).toMatchObject({ status: 'unsupported',
      run: { runId: originalRun }, message: expect.stringContaining('unknown') })
    expect(f.native.requests).toEqual([])
    const ack = await f.client.writeTerminal({ runId: originalRun }, { ownerInstanceId: identity.instanceId,
      operationId: randomUUID(), expectedByte: 0, data: 'ok\n' })
    expect(ack).toEqual({ runId: originalRun, appliedByteRange: { startByte: 0, endByte: 3 }, acceptedThroughByte: 3 })
    expect(f.native.requests.map(request => request.type)).toEqual(['recoverable_input'])
    expect(f.client.runtimeIdentity()).toEqual(identity)
    noLifecycleChanges(f)
  })

  it('keeps missing SDK observation method local while the existing SDK input path remains usable', async () => {
    const f = await owner(), identity = f.client.runtimeIdentity()
    // Remove only the optional surface, preserving the actual SDK's ordinary input implementation.
    // The per-platform manifest/archive review separately proves which shipped bundle lacks it.
    Object.defineProperty(f.native.inner.client, 'observeStorage', { value: undefined, configurable: true })
    expect(await f.client.observeRunStorage({ runId: originalRun })).toMatchObject({ status: 'unsupported',
      run: { runId: originalRun }, message: expect.stringContaining('client') })
    expect(f.native.requests).toEqual([])
    const ack = await f.client.writeTerminal({ runId: originalRun }, { ownerInstanceId: identity.instanceId,
      operationId: randomUUID(), expectedByte: 0, data: 'ok\n' })
    expect(ack).toEqual({ runId: originalRun, appliedByteRange: { startByte: 0, endByte: 3 }, acceptedThroughByte: 3 })
    expect(f.native.requests.map(request => request.type)).toEqual(['recoverable_input'])
    expect(f.client.runtimeIdentity()).toEqual(identity)
    noLifecycleChanges(f)
  })

  it('does not label another required capability failure as optional storage unavailability', async () => {
    const f = await owner()
    f.native.inner.client = new CtxmuxClient({ socketPath: f.native.path, expectedRuntimeIdentity: f.native.runtime,
      requiredCapabilities: { 'native.recoverable_input': 2 } })
    await expect(f.client.observeRunStorage({ runId: originalRun })).rejects.toMatchObject({
      capability: 'native.recoverable_input', code: 'unsupported_capability' })
    expect(f.native.requests).toEqual([])
    noLifecycleChanges(f)
  })

  it('rejects another Run locally, then reads the original Run without taking away existing capability', async () => {
    const f = await owner(), identity = f.client.runtimeIdentity()
    f.native.state.returnedRun = otherRun
    await expect(f.client.observeRunStorage({ runId: originalRun })).rejects.toThrow('exact Run storage observation')
    f.native.state.returnedRun = originalRun
    expect(await f.client.observeRunStorage({ runId: originalRun })).toMatchObject({ status: 'observed', storage: projected })
    expect(f.client.runtimeIdentity()).toEqual(identity)
    expect(f.native.requests).toHaveLength(2)
    noLifecycleChanges(f)
  })

  it.each(['Run', 'Host'] as const)('rejects a foreign %s in the actual public RPC receipt while original owner input stays usable', async wrongOwner => {
    const f = await owner(), identity = f.client.runtimeIdentity()
    const observation = await f.client.observeRunStorage({ runId: originalRun })
    const result = { ...observation, run: { runId: wrongOwner === 'Run' ? otherRun : originalRun },
      runtime: { ...observation.runtime, hostId: wrongOwner === 'Host' ? 'foreign-host' : 'local' } }
    const foreign = await publicReceipt(result)
    await expect(foreign.call('system.storage', { hostId: 'local', runId: originalRun }))
      .rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    const original = await publicEndpoint(f.coreClients)
    expect(await original.rpc.call('system.storage', { hostId: 'local', runId: originalRun }))
      .toMatchObject({ status: 'observed', run: { runId: originalRun }, runtime: { hostId: 'local' }, storage: projected })
    const ack = await f.client.writeTerminal({ runId: originalRun }, { ownerInstanceId: identity.instanceId,
      operationId: randomUUID(), expectedByte: 0, data: 'ok\n' })
    expect(ack.acceptedThroughByte).toBe(3)
    expect(f.native.requests.map(request => request.type)).toEqual(['observe_storage', 'observe_storage', 'recoverable_input'])
    expect(f.client.runtimeIdentity()).toEqual(identity)
    noLifecycleChanges(f)
  })

  it('uses the original Hosted public method over actual Unix RPC without acquiring attachments or mutating Sessions', async () => {
    const f = await owner()
    const identity: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'private-storage-host', ownerInstanceId: 'private-storage-host-epoch',
      protocolVersion: 1, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }
    const hosted = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => identity)
    closes.push(() => hosted.dispose())
    const endpoint = await publicEndpoint(f.coreClients, () => hosted)
    const reader = await connectHostedAgentMux({ rpc: endpoint.rpc }); closes.push(() => reader.dispose())
    expect(await reader.observeRunStorage({ runId: originalRun })).toMatchObject({ status: 'observed', storage: projected,
      run: { runId: originalRun }, runtime: { instanceId: f.native.runtime.daemonInstanceId } })
    expect(f.native.requests.map(request => request.type)).toEqual(['observe_storage'])
    noLifecycleChanges(f)
  })

  it('routes exactly the chosen Host through native RPC and the compiled discoverable CLI, with no Session fanout', async () => {
    const left = await owner(true, 'storage-left'), right = await owner(true, 'storage-right')
    const endpoint = await publicEndpoint(() => [{ hostId: 'left', client: left.client }, { hostId: 'right', client: right.client }])
    const first = await endpoint.rpc.call('system.storage', { hostId: 'right', runId: originalRun })
    expect(first).toMatchObject({ runtime: { hostId: 'right', instanceId: right.native.runtime.daemonInstanceId }, storage: projected })
    expect(left.native.requests).toEqual([])
    await expect(endpoint.rpc.call('system.storage', { hostId: 'absent', runId: originalRun })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    const args = ['--endpoint', 'unix:' + endpoint.path, 'system', 'storage', '--host', 'right', '--run', originalRun]
    const parsed = await parseAgentMuxCliInvocation(args)
    expect(parsed.command.method).toBe('system.storage')
    expect(parsed.params).toEqual({ hostId: 'right', runId: originalRun })
    for (const text of [AGENTMUX_CLI_HELP, AGENTMUX_CLI_SKILL]) expect(text).toContain('amux system storage --host HOST --run RUN')
    const cli = await runCompiledObjectCli(args, objectCliEnvironment(endpoint.root))
    expect(cli.code, cli.stderr).toBe(0)
    const receipt = objectCliReceipt(JSON.parse(cli.stdout.trim()))
    expect(receipt).toMatchObject({ ok: true, operation: 'system.storage', result: { status: 'observed',
      runtime: { hostId: 'right', instanceId: right.native.runtime.daemonInstanceId }, storage: projected } })
    expect(right.native.requests.map(request => request.type)).toEqual(['observe_storage', 'observe_storage'])
    expect(left.native.requests).toEqual([])
    noLifecycleChanges(left); noLifecycleChanges(right)
  })
})
