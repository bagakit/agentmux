import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { CtxmuxClient, createOperationKey, defineRun } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { CapsuleRunManager } from '../src/capsule-run-manager.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxError } from '../src/errors.js'
import { decodePreparedTerminal } from '../src/terminal-preparation.js'
import { parseCapsuleRuntimeResult, type CapsuleRuntimeObservation } from '../src/capsule-runtime.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

it('recovers through actual private Native, Core manager, Unix RPC and source compiled CLI without disturbing another Run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amxret-')), state = join(directory, 's'), runtime = join(directory, 'r')
  closes.push(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(state, 'ctxmux'), { recursive: true, mode: 0o700 }); await mkdir(runtime, { mode: 0o700 })
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state); vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime)
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(state, 'sessions.json'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(state, 'messages.ndjson'))
  const socketPath = join(runtime, 'ctxmux.sock')
  // Execute identical qualified bytes at a fresh private inode; in-place signed executable replacement can retain a macOS code-page cache.
  const binary = join(directory, 'ctxmuxd')
  await copyFile(process.env.CAPSULE_RETIREMENT_NATIVE ?? resolve('packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'), binary); await chmod(binary, 0o700)
  const daemon = spawn(binary,
    ['--socket', socketPath, '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  closes.push(async () => { if (daemon.exitCode === null && daemon.signalCode === null) { const closed = once(daemon, 'close'); daemon.kill('SIGTERM'); await closed } })
  await new Promise<void>((yes, no) => {
    let errors = ''; daemon.stderr!.on('data', data => { errors += data })
    const timer = setTimeout(() => no(new Error('Private Native readiness unavailable')), 15000)
    const finish = () => { clearTimeout(timer); yes() }
    daemon.stdio[3]!.once('data', finish)
    daemon.once('error', no); daemon.once('exit', (code, signal) => { clearTimeout(timer); no(new Error('Private Native exited ' + code + '/' + signal + ': ' + errors)) })
  })
  const sdk = new CtxmuxClient({ socketPath }), identity = await sdk.runtimeInfo()
  expect(identity.capabilities['services.creation_retirement'], 'Actual qualified Native must expose retirement').toBe(1)
  const healthy = await sdk.start(defineRun('/bin/sh', { args: ['-c', 'while :; do sleep 1; done'], cwd: directory }), createOperationKey('unrelated-healthy'))
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() }); closes.push(() => client.dispose())
  await client.connectRuntime()
  const manager = new CapsuleRunManager(client, state); closes.push(() => manager.dispose())
  const create = client.createPreparedTerminal.bind(client)
  const lost = vi.spyOn(client, 'createPreparedTerminal').mockRejectedValueOnce(new AgentMuxError('Transport lost before Native acceptance is known', 'CTXMUX_io'))
  const first = await manager.runtime.call('capsule.runtime.start', { operationId: 'native-original-start', expectedRevision: 0 })
  expect(first.operation?.phase).toBe('unknown')
  lost.mockRestore()
  const originalBinding = JSON.parse(await readFile(join(state, 'capsule-service.json'), 'utf8'))
  const originalLaunch = decodePreparedTerminal(originalBinding.launch)
  const originalRecord = await readFile(join(state, 'capsule-service-operations/native-original-start.json'), 'utf8')
  const host = new AgentMuxHostedRuntimeService(client, null, () => ({ runtimeId: 'private-core-runtime', ownerInstanceId: 'private-core-owner',
    protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: client.runtimeIdentity() })); closes.push(() => host.dispose())
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => host, capsules: manager, capsuleRuntime: manager.runtime }, join(runtime, 'public.sock'))
  await server.start(); closes.push(() => server.stop())
  const cli = process.env.CAPSULE_RETIREMENT_CLI
  expect(cli).toBeTruthy()
  const call = async (action: 'inspect' | 'start', input: unknown) => await new Promise<CapsuleRuntimeObservation>((yes, no) => {
    const child = spawn(process.execPath, [cli!, '--endpoint', 'unix:' + server.path, 'capsule', 'runtime', action, '--input', '-'],
      { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_'))), stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(JSON.stringify(input)); let output = '', error = ''
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { error += data }); child.once('error', no)
    child.once('close', code => code === 0 ? yes(parseCapsuleRuntimeResult(JSON.parse(output).result)) : no(new Error(error || output)))
  })
  const inspected = await call('inspect', { operationId: 'native-original-start' })
  expect(inspected.recoveryTarget?.runtime?.runtimeId).toBe(identity.runtimeId)
  const recovered = await call('start', { operationId: 'native-explicit-recovery', expectedRevision: inspected.revision, recovery: inspected.recoveryTarget })
  expect(recovered, 'Actual Native retirement must restore the original Core namespace').toMatchObject({ stateDirectory: manager.stateDirectory, recovery: { phase: 'retired' } })
  await vi.waitFor(async () => expect(await call('inspect', { operationId: 'native-explicit-recovery' }), 'The same Native Run must reach its service handshake without another launch').toMatchObject({ phase: 'running', run: recovered.run }), { timeout: 10000, interval: 100 })
  const serviceRun = recovered.run!.runId
  closes.push(async () => { const p = await client.prepareTerminalStop({ runId: serviceRun }); await client.stopPreparedTerminal(p) })
  expect(await sdk.observeCreationRetirement(createOperationKey(originalLaunch.prepared.createOperationId))).toMatchObject({ observation: { outcome: 'retired' } })
  await expect(sdk.start(originalLaunch.request, createOperationKey(originalLaunch.prepared.createOperationId)), 'Retired original key must never apply later').rejects.toThrow()
  expect((await sdk.status(healthy.id)).state.type, 'A second healthy Run must remain healthy').toBe('running')
  expect(await readFile(join(state, 'capsule-service-operations/native-original-start.json'), 'utf8')).toBe(originalRecord)
  expect((await call('inspect', { operationId: 'native-original-start' })).operation?.phase).toBe('unknown')
  await manager.dispose()
  const replacement = new CapsuleRunManager(client, state); closes.push(() => replacement.dispose())
  expect((await replacement.runtime.call('capsule.runtime.inspect', { operationId: 'native-explicit-recovery' })).run?.runId).toBe(serviceRun)
  expect((await replacement.runtime.call('capsule.runtime.inspect', {})).phase).toBe('running')
  // Real Adapter/SDK retained validation cannot authorize a foreign complete launch.
  const prepared = client.prepareTerminal({ command: '/bin/sh', args: ['-c', 'sleep 30'], workspacePath: directory, createOperationId: 'retained-original' })
  const retainedRun = await create(prepared)
  closes.push(async () => await client.stopPreparedTerminal(await client.prepareTerminalStop({ runId: retainedRun.runId })))
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); closes.push(() => hosted.dispose())
  const hostedIdentity = await hosted.terminalCreationRuntimeIdentity()
  const retained = await hosted.retirePreparedTerminalCreation(prepared, hostedIdentity)
  expect(retained, 'Native retained must preserve the same original Run').toMatchObject({ outcome: 'retained', run: { runId: retainedRun.runId } })
  expect(await hosted.observePreparedTerminalCreationRetirement(originalLaunch.prepared, hostedIdentity)).toMatchObject({ outcome: 'retired' })
  const foreign = structuredClone(prepared), decoded = JSON.parse(foreign.launch); decoded.request.args.push('foreign'); foreign.launch = JSON.stringify(decoded)
  const mismatch = await client.retirePreparedTerminalCreation(foreign, client.terminalCreationRuntimeIdentity()).then(() => null, error => error)
  expect(mismatch, 'Retained full launch mismatch must refuse only this operation').toMatchObject({ code: 'TERMINAL_CREATION_UNCONFIRMED' })
  expect((await sdk.status(retainedRun.runId)).state.type).toBe('running')
}, 45000)
