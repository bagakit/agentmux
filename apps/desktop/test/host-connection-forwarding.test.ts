import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxFileAgentSessionStore, AgentMuxRpcService, connectAgentMuxRpc, hashAgentCapability, issueAgentCapability } from '@agentmux/core'
import type { ConnectionEnrollmentActionKind, ConnectionEnrollmentView } from '@agentmux/core/connections'
import { startAgentMuxHost } from '../../host/src/host.js'
import { moteConnectionOwner } from './fixtures/mote-connection-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) try { await dispose() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Original Host connection consumer cleanup failed')
})
const result = (value: { code: number | null; stdout: string; stderr: string }) => { expect(value.code, value.stdout + value.stderr).toBe(0); return JSON.parse(value.stdout).result }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-host-bot-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  const stateDirectory = join(root, 'state'), storePath = join(stateDirectory, 'sessions.json')
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', stateDirectory)
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', storePath); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(stateDirectory, 'messages.ndjson'))
  const f = await moteConnectionOwner(root, { generic: true }); cleanup.push(f.close)
  await f.server.stop() // Replace only this fixture's initial public seam with the actual Host/Main topology.
  await mkdir(join(stateDirectory, 'ctxmux'), { recursive: true, mode: 0o700 }); await chmod(join(stateDirectory, 'ctxmux'), 0o700)
  const daemon = spawn(resolve('packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(root, 'ctxmux.sock'), '--state-dir', join(stateDirectory, 'ctxmux'), '--readiness-fd', '3'],
    { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonErrors = ''; daemon.stderr!.on('data', data => { daemonErrors += String(data) })
  cleanup.push(async () => { if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null) { const ended = once(daemon, 'exit'); daemon.kill('SIGTERM'); await ended } })
  await new Promise<void>((yes, no) => {
    const timer = setTimeout(() => no(new Error('Private pinned Native did not become ready: ' + daemonErrors)), 20_000)
    daemon.stdio[3]!.once('data', () => { clearTimeout(timer); yes() })
    daemon.once('error', error => { clearTimeout(timer); no(error) }); daemon.once('exit', code => { clearTimeout(timer); no(new Error(`Private pinned Native exited ${code}: ${daemonErrors}`)) })
  })
  const store = new AgentMuxFileAgentSessionStore(storePath), capability = issueAgentCapability(), agentSessionId = 'original-operator'
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: f.motes[0]!.directory,
    run: { runId: '11111111-1111-4111-8111-111111111111' }, retiredRuns: [], hookBindingId: 'original-hook', hookToken: 'original-token', capabilityHash: hashAgentCapability(capability), createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) })
  const host = await startAgentMuxHost({ store, providers: [], socketPath: join(root, 'control.sock'), desktopSocketPath: join(root, 'control.sock.desktop'), mobilePort: 0 })
  cleanup.push(() => host.dispose())
  const main = new AgentMuxControlServer({ socketPath: join(root, 'control.sock.desktop'), connections: f.connections.connections, moteConnections: f.parent,
    spatialState: f.spatial, coreClients: () => [{ hostId: 'local', client: host.client }] })
  await main.start(); cleanup.push(() => main.stop())
  const env = objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_AGENT_SESSION_ID: agentSessionId, AGENTMUX_AGENT_CAPABILITY: capability })
  // Omit --endpoint deliberately: this is the installed product's default semantic Host path.
  const cli = (args: string[], body?: unknown, managed = true) => runCompiledObjectCli(args,
    managed ? env : { ...env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }, body === undefined ? '' : JSON.stringify(body))
  return { ...f, host, main, cli, env, capability, agentSessionId, storePath }
}

it('actual default Host and Main sockets preserve Agent creation, private receipts and saved Mote binding through compiled CLI', async () => {
  const f = await fixture()
  const discovered = result(await f.cli(['connection', 'enrollment', 'ls', '--limit', '1']))
  expect(discovered.capabilities).toContainEqual(expect.objectContaining({ adapterId: 'signed-profile', domain: 'signed.example' }))
  expect(discovered.operations).toEqual([])
  const input = await f.input('default-host-mote')
  let operation = result(await f.cli(['space', 'mote', 'connection', 'create', '--input', '-'], input))
  expect(operation.enrollment.authentication.stage).toBe('waiting')
  const enrollment = async () => result(await f.cli(['connection', 'enrollment', 'inspect', '--operation-id', operation.enrollmentOperationId])) as ConnectionEnrollmentView
  expect((await enrollment()).challenge?.qrPayload).toBe('original-signed-private-qr')
  for (const kind of ['continue-authentication', 'confirm-account', 'create'] as ConnectionEnrollmentActionKind[]) {
    const view = await enrollment(), action = view.actions.find(action => action.kind === kind)!
    expect(action).toBeDefined()
    operation = result(await f.cli(['space', 'mote', 'connection', 'advance', '--input', '-'], { operationId: input.operationId,
      enrollment: { operationId: operation.enrollmentOperationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind } } }))
  }
  expect(operation.defaultLink.state).toBe('saved')
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values?.connection).toEqual(operation.connection)
  const row = JSON.parse(String(f.connections.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(operation.enrollmentOperationId)!.record_json))
  expect(row.actor).toEqual({ kind: 'agent', id: f.agentSessionId })
  expect(result(await f.cli(['connection', 'ls'])).connections.map((connection: any) => connection.config.connectionId)).toEqual([operation.connection.connectionId])
  expect((await f.cli(['connection', 'service', 'get'])).code).not.toBe(0)
  const humanInput = await f.input('default-host-human-mote')
  const human = result(await f.cli(['space', 'mote', 'connection', 'create', '--input', '-'], humanInput, false))
  const forbidden = await f.cli(['connection', 'enrollment', 'inspect', '--operation-id', human.enrollmentOperationId])
  expect(forbidden.code).not.toBe(0); expect(forbidden.stdout + forbidden.stderr).not.toContain('original-signed-private-qr')
  expect(result(await f.cli(['space', 'mote', 'connection', 'inspect', '--operation-id', humanInput.operationId], undefined, false)).operation.operationId).toBe(humanInput.operationId)
  expect(f.counts).toMatchObject({ begin: 2, authentication: 1, create: 1, credential: 1 })
}, 30_000)

it('actual Host refuses an unpreservable device operator before the Main bridge and retains real headless absence', async () => {
  const f = await fixture(), get = vi.spyOn(f.connections.connections.service!, 'get'), inspect = vi.spyOn(f.parent, 'inspect')
  const frames: any[] = [], channel = f.host.server.openAuthenticatedFrames({ authorization: { principal: { kind: 'device', id: 'original-phone' }, assertCurrent: () => {} }, send: frame => { frames.push(frame) }, close: () => {} })
  cleanup.push(() => channel.dispose())
  await channel.receive({ jsonrpc: '2.0', id: 'device-connection', method: 'connection.service.get', params: {} })
  await channel.receive({ jsonrpc: '2.0', id: 'device-mote', method: 'space.mote.connection.inspect', params: { operationId: 'original-mote' } })
  expect(frames).toHaveLength(2)
  for (const frame of frames) expect(frame.error).toMatchObject({ data: { code: 'CONTROL_UNAVAILABLE' }, message: expect.stringContaining('cannot preserve the original connection operator identity') })
  expect(get).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
  expect(result(await f.cli(['connection', 'enrollment', 'ls'])).capabilities).toHaveLength(1)
  const service = new AgentMuxRpcService(); cleanup.push(() => service.dispose())
  const user = { principal: { kind: 'user' as const, id: 'original-local-operator' }, transport: 'unix' as const }
  await expect(service.call('connection.enrollment.ls', {}, user)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE', message: expect.stringContaining('owner is not enabled') })
  await expect(service.call('space.mote.connection.inspect', { operationId: 'original-mote' }, user)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE', message: expect.stringContaining('unavailable on this Host') })
}, 30_000)
