import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CtxmuxClient, PROTOCOL_VERSION, type RuntimeIdentity } from '@ctxmux/sdk'
import { AgentMuxError, parseAgentMuxErrorData } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const close: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const action of close.splice(0).reverse()) await action(); vi.restoreAllMocks() })
const storage = { stage: 'start' as const, sqlite_primary_code: 14, sqlite_extended_code: 14,
  system_errno: 2, transaction_outcome: 'not_started' as const }
const projectedStorage = { stage: 'start', sqlitePrimaryCode: 14, sqliteExtendedCode: 14,
  systemErrno: 2, transactionOutcome: 'not_started' }

/** Finite Native wire evidence; real SQLite/PTY fault and restart qualification lives in ctxmux. */
async function fixture(disposition: 'not_applied' | 'unknown') {
  const root = await mkdtemp(join(tmpdir(), 'amx-persistence-wire-')), socketPath = join(root, 'native.sock')
  const runtime: RuntimeIdentity = { daemonInstanceId: randomUUID(), runtimeId: randomUUID(),
    runtimeIdPersistence: 'state_dir', buildId: 'ctxmuxd/failure-wire', protocolGeneration: PROTOCOL_VERSION,
    platform: 'macos', arch: 'aarch64', capabilities: { 'native.recoverable_input': 1, 'services.storage_observation': 1 } }
  const requests: Array<Record<string, any>> = [], sockets = new Set<Socket>()
  const native = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    let pending = ''
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      pending += chunk
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n'), message = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1)
        const send = (value: unknown) => socket.write(JSON.stringify(value) + '\n')
        if (message.type === 'hello') { send({ type: 'hello', runtime }); continue }
        const request = message.request; requests.push(request)
        send({ type: 'error', error: { code: 'io', message: 'Original durable admission failed', storage_failure: storage,
          ...(request.type === 'start' ? { creation_failure: { operation_key: request.operation_key, disposition } } : {}) } })
      }
    })
  })
  await new Promise<void>((resolve, reject) => { native.once('error', reject); native.listen(socketPath, resolve) })
  close.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => native.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const owner = await rpcOwnerFixture(['existing-agent']); close.push(() => owner.close())
  const kernel = owner.inner.kernel as any
  kernel.client = new CtxmuxClient({ socketPath, expectedRuntimeIdentity: runtime }); kernel.runtime = runtime
  // The fixture's independent existing Agent remains loaded. Creation uses the real adapter.
  delete kernel.identity
  const identity = { runtimeId: 'failure-host', ownerInstanceId: 'failure-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: owner.client.runtimeIdentity(), availability: 'connected' as const }
  const hosted = new AgentMuxHostedRuntimeService(owner.client, join(owner.root, 'sessions.json'), () => identity)
  close.push(() => hosted.dispose())
  const control = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'),
    coreClients: owner.coreClients, hostedRuntime: () => hosted })
  await control.start(); close.push(() => control.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } })
  close.push(() => rpc.dispose())
  const reader = await connectHostedAgentMux({ rpc }); close.push(() => reader.dispose())
  return { root, owner, requests, reader }
}

it.each(['not_applied', 'unknown'] as const)('preserves exact creation %s and storage facts through Native SDK, Core and Hosted RPC', async disposition => {
  const f = await fixture(disposition), operationId = 'original-terminal-creation'
  await expect(f.reader.createTerminal({ createOperationId: operationId, workspacePath: f.root,
    command: process.execPath, args: ['-e', 'process.exit(0)'] })).rejects.toMatchObject({
    code: 'CTXMUX_io', creationFailure: { operationId, disposition }, storageFailure: projectedStorage })
  expect(f.requests.filter(value => value.type !== 'list').map(value => value.type)).toEqual(['start'])
  expect(f.requests.find(value => value.type === 'start')!.operation_key).toBe(operationId)
  expect(await f.owner.store.readMetadata('existing-agent')).not.toBeNull()
  expect(f.owner.inner.kernel.stop).not.toHaveBeenCalled()
})

it('carries the original structured storage failure to the compiled system storage CLI', async () => {
  const f = await fixture('unknown')
  const result = await runCompiledObjectCli(['--endpoint', 'unix:' + join(f.root, 'control.sock'),
    'system', 'storage', '--host', 'local', '--run', '12be7432-37cf-4d24-9634-1e1a018bd72c'], objectCliEnvironment(f.root))
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stderr), result.stderr).toMatchObject({ ok: false, error: { code: 'CTXMUX_io', storageFailure: projectedStorage } })
  expect(f.requests.filter(value => value.type !== 'list').map(value => value.type)).toEqual(['observe_storage'])
  expect(f.owner.inner.kernel.stop).not.toHaveBeenCalled()
})

it('rejects malformed failure facts without turning missing facts into a negative receipt', () => {
  expect(parseAgentMuxErrorData({ code: 'IO', message: 'unknown' })).toEqual({ code: 'IO', message: 'unknown' })
  for (const creationFailure of [{ operationId: '', disposition: 'not_applied' }, { operationId: 'original', disposition: 'committed' }]) {
    expect(() => parseAgentMuxErrorData({ code: 'IO', message: 'unknown', creationFailure })).toThrow(AgentMuxError)
  }
  for (const storageFailure of [{ ...projectedStorage, sqlitePrimaryCode: -1 }, { ...projectedStorage, sqliteExtendedCode: 0 },
    { ...projectedStorage, systemErrno: 0 }, { ...projectedStorage, stage: 'display-message' },
    { ...projectedStorage, transactionOutcome: undefined }, { ...projectedStorage, inferredProcessDead: true }]) {
    expect(() => parseAgentMuxErrorData({ code: 'IO', message: 'unknown', storageFailure })).toThrow(AgentMuxError)
  }
})
