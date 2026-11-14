import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { callOriginalDesktopHost, connectDesktopAgentMuxHost } from '../src/main/desktop-host.js'
import { desktopRpcMethods } from '../src/main/desktop-rpc-exposure.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { SettingsHostsMaintenanceOwner } from '../src/main/settings-hosts-maintenance.js'
import { SettingsHostsInstallOwner } from '../src/main/settings-hosts-install.js'
import { SettingsHostsUpgradeOwner } from '../src/main/settings-hosts-upgrade.js'
import { executeSettingsHostsControl } from '../src/main/settings-hosts-control.js'
vi.mock('electron', () => ({ app: { getPath: () => '/fixture' } }))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Original service fixture cleanup failed.')
})
const target = { id: 'fixture-host', kind: 'ssh' as const, label: 'Fixture', hostname: 'fixture.invalid' }
const expected = { targetDigest: core.remoteCoreUpgradeTargetDigest(target), prefix: '/home/fixture/core', candidateDigest: 'a'.repeat(64), nodeSha256: 'b'.repeat(64), keepRunning: 'start-script' as const }
const input: core.HostMaintenanceRequest = { action: 'install', id: target.id, host: target, expected, operationId: 'fixture-original-install' }
async function fixture() {
  const original = await rpcOwnerFixture(['original-agent', 'other-agent'], core); cleanup.push(original.close)
  const native = original.inner.kernel
  await original.client.dispose()
  // Only the Native byte/process port is controlled. Host composition, public
  // service, credentials, bridge, borrowed Desktop client and Main owners are real.
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  const path = join(original.root, 'control.sock'), desktopPath = join(original.root, 'desktop.sock')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath: path, desktopSocketPath: desktopPath, mobileBuildDirectory: join(original.root, 'absent-mobile') })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const desktopCore = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Local' }, original.store)
  cleanup.push(() => desktopCore.dispose()); await desktopCore.readAgentSessions()
  let config = { ...structuredClone(DEFAULT_CONFIG), hosts: [target] }
  const configOwner = new ConfigOwner({ read: () => config, save: async next => next, publish: next => { config = next as typeof config } })
  const manager = { install: vi.fn(), inspect: vi.fn(async () => null) }
  const upgrades = { upgrade: vi.fn(), inspect: vi.fn(async () => null) }
  const runtime = { checkHost: vi.fn() }
  const directory = join(original.root, 'requests')
  const installs = new SettingsHostsInstallOwner(manager as unknown as core.RemoteCoreInstallManager, configOwner, runtime)
  const upgradeOwner = new SettingsHostsUpgradeOwner(upgrades as unknown as core.RemoteCoreUpgradeManager, configOwner, runtime, join(original.root, 'adoptions.json'))
  const owner = new SettingsHostsMaintenanceOwner(directory, configOwner, installs, upgradeOwner)
  const request = vi.spyOn(owner, 'request')
  const desktop = new core.AgentMuxControlServer({ socketPath: desktopPath, exposedMethods: desktopRpcMethods(), forwardingPeer: { authoritySocketPath: path },
    coreClients: () => [{ hostId: 'local', client: desktopCore }], hostMaintenance: owner,
    execute: request => executeSettingsHostsControl(request as core.AgentMuxControlSettingsHostsRequest, configOwner, runtime, upgradeOwner, installs),
    callOriginalCore: (_hostId, method, params, context) => callOriginalDesktopHost(desktopCore, method, params, context) })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path }, credentials: original.credentials }); cleanup.push(() => rpc.dispose())
  const env = objectCliEnvironment(original.root, { AGENTMUX_RPC_ENDPOINT: `unix:${path}`, AGENTMUX_AGENT_SESSION_ID: original.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: original.credentials.capability })
  const cli = (args: string[], data = '', person = false) => runCompiledObjectCli(['settings', 'hosts', ...args], person ? objectCliEnvironment(original.root, { AGENTMUX_RPC_ENDPOINT: `unix:${path}` }) : env, data)
  const file = (operationId: string) => join(directory, createHash('sha256').update(operationId).digest('hex') + '.json')
  return { original, native, host, desktop, owner, request, manager, upgrades, runtime, rpc, cli, env, file }
}

it('compiled CLI crosses actual Host and Desktop services with original Agent attribution and person review', async () => {
  const f = await fixture(), before = await readFile(f.original.store.path)
  const submit = await f.cli(['maintenance-request', '--input', '-'], JSON.stringify(input))
  expect(submit.code, submit.stderr).toBe(0)
  const record = JSON.parse(submit.stdout).result.record
  expect(record).toMatchObject({ state: 'pending', request: input, requester: { kind: 'agent', id: 'original-agent', hostId: 'local', runId: 'run-original-agent' } })
  expect(core.parseHostMaintenanceRecord(JSON.parse(await readFile(f.file(input.operationId), 'utf8')))).toEqual(record)
  const inspect = await f.cli(['maintenance-inspect', '--operation-id', input.operationId])
  expect(inspect.code, inspect.stderr).toBe(0); expect(JSON.parse(inspect.stdout).result.record).toEqual(record)
  const review = JSON.stringify({ requestDigest: record.requestDigest, decision: 'reject' })
  const reviewed = await f.cli(['maintenance-review', '--operation-id', input.operationId, '--input', '-'], review, true)
  expect(reviewed.code, reviewed.stderr).toBe(0)
  expect(JSON.parse(reviewed.stdout).result.record).toMatchObject({ state: 'rejected', requester: record.requester, review: { actor: { kind: 'user' }, decision: 'reject' } })
  expect(f.request).toHaveBeenCalledTimes(1)
  expect(f.manager.install).not.toHaveBeenCalled(); expect(f.upgrades.upgrade).not.toHaveBeenCalled(); expect(f.runtime.checkHost).not.toHaveBeenCalled()
  expect(await readFile(f.original.store.path)).toEqual(before)
  expect(f.native.input).not.toHaveBeenCalled(); expect(f.native.stop).not.toHaveBeenCalled()
})

it('the ordinary install CLI keeps its authenticated Agent caller through the original Host control and install owners', async () => {
  const f = await fixture()
  f.manager.install.mockResolvedValue({ input: target, expected, operationId: input.operationId, status: 'completed', stage: 'completed', detail: 'Private original direct installation completed.', updatedAt: 1,
    installed: { remoteCommand: '/fixture/core/amux', remoteSocketPath: '/fixture/core/control.sock', runtimeId: 'fixture-installed-runtime', startScript: '/fixture/core/start', unit: null } })
  f.runtime.checkHost.mockResolvedValue({ detail: 'Private original Host adopted.' })
  const limited = new core.AgentMuxRpcService({coreClients:()=>[{hostId:'local',client:f.host.client}]})
  cleanup.push(()=>limited.dispose())
  const denied = limited.call('settings.hosts.install', { id:target.id, expected, operationId:input.operationId }, { caller:f.original.credentials, principal:{kind:'device',id:'limited-device'} })
  await expect(denied).rejects.toMatchObject({ code:'CONTROL_PERMISSION_DENIED' })
  expect(f.manager.install).not.toHaveBeenCalled()
  const result = await f.cli(['install', target.id, '--input', '-'], JSON.stringify({ expected, operationId:input.operationId }))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result.receipt).toMatchObject({ operationId:input.operationId, status:'completed', connectionAdoption:{state:'connected'} })
  expect(f.manager.install).toHaveBeenCalledExactlyOnceWith(target, expected, input.operationId)
  expect(f.native.stop).not.toHaveBeenCalled()
})

it('the authenticated operator Agent completes its original request through the compiled CLI and persists its real reviewer once', async () => {
  const f = await fixture()
  f.manager.install.mockResolvedValue({ input: target, expected, operationId: input.operationId, status: 'completed', stage: 'completed', detail: 'Private original installer completed.', updatedAt: 1,
    installed: { remoteCommand: '/fixture/core/amux', remoteSocketPath: '/fixture/core/control.sock', runtimeId: 'fixture-installed-runtime', startScript: '/fixture/core/start', unit: null } })
  f.runtime.checkHost.mockResolvedValue({ detail: 'Private original Host adopted.' })
  const submit = await f.cli(['maintenance-request', '--input', '-'], JSON.stringify(input))
  expect(submit.code, submit.stderr).toBe(0)
  const record = JSON.parse(submit.stdout).result.record
  const review = JSON.stringify({ requestDigest: record.requestDigest, decision: 'approve' })
  const approved = await f.cli(['maintenance-review', '--operation-id', input.operationId, '--input', '-'], review)
  expect(approved.code, approved.stderr).toBe(0)
  const result = JSON.parse(approved.stdout).result.record
  expect(result).toMatchObject({ state: 'finished', review: { actor: { kind: 'agent', id: 'original-agent', hostId: 'local', runId: 'run-original-agent' } }, result: { status: 'completed' } })
  expect(core.parseHostMaintenanceRecord(JSON.parse(await readFile(f.file(input.operationId), 'utf8')))).toEqual(result)
  expect((await f.cli(['maintenance-review', '--operation-id', input.operationId, '--input', '-'], review)).code).toBe(0)
  expect(f.manager.install).toHaveBeenCalledExactlyOnceWith(target, expected, input.operationId)
  expect(f.native.stop).not.toHaveBeenCalled()
})

it('original Core rejects invalid capability and stale owner fence before Main admission, and another Agent cannot read the request', async () => {
  const f = await fixture(), identity = (await f.host.hosted.call('runtime.owner.identity', {})).owner
  const fence = { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId }
  await expect(f.rpc.call('settings.hosts.maintenance-request', input, { runtimeFence: { ...fence, ownerInstanceId: 'stale-original-owner' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  await expect(f.rpc.call('settings.hosts.maintenance-request', input, { credentials: { ...f.original.credentials, capability: 'invalid-capability' } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(f.request).not.toHaveBeenCalled(); expect(await f.owner.inspect(input.operationId, { kind: 'user', id: 'reader' })).toBeNull()
  const pending = await f.rpc.call('settings.hosts.maintenance-request', input, { runtimeFence: fence })
  expect(pending.record?.request.operationId).toBe(input.operationId)
  await expect(f.rpc.call('settings.hosts.maintenance-inspect', { operationId: input.operationId }, { credentials: { ...f.original.credentials, agentSessionId: 'other-agent' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.manager.install).not.toHaveBeenCalled()
})

it('the original device crosses the trusted Host grant without becoming a local person', async () => {
  const f = await fixture(), authority = await f.host.deviceAuthority()
  const key = Buffer.alloc(32, 7).toString('base64'), device = await authority.authorizeKey(key)
  const actor = { kind: 'device' as const, id: `${authority.hostId}:${device.deviceId}` }
  const observation = authority.observe(device); cleanup.push(async () => observation.dispose())
  let receive: ((frame: any) => void) | undefined
  const frames = f.host.server.openAuthenticatedFrames({
    authorization: { principal: actor, signal: observation.signal, assertCurrent: () => authority.assertCurrentKey(device, key) },
    send: frame => { receive?.(frame) }, close: () => {} })
  cleanup.push(async () => frames.dispose())
  let id = 0
  const call = (method: core.AgentMuxRpcMethod, params: unknown) => new Promise<any>((resolve, reject) => {
    const current = ++id
    receive = frame => { if (frame.id === current) frame.error ? reject(frame.error) : resolve(frame.result) }
    void frames.receive({ jsonrpc: '2.0', id: current, method, params }).catch(reject)
  })
  const { record } = await call('settings.hosts.maintenance-request', input)
  expect(record.requester).toEqual(actor)
  const reviewed = await call('settings.hosts.maintenance-review', { operationId: input.operationId, requestDigest: record.requestDigest, decision: 'reject' })
  expect(reviewed.record).toMatchObject({ state: 'rejected', requester: actor, review: { actor, decision: 'reject' } })
  expect(f.manager.install).not.toHaveBeenCalled(); expect(f.native.stop).not.toHaveBeenCalled()
})

it('unknown execution is inspected through both services without replay; an unavailable Main never redirects to another owner', async () => {
  const f = await fixture(), { record } = await f.rpc.call('settings.hosts.maintenance-request', input)
  const executing = { ...record!, state: 'executing', review: { actor: { kind: 'user', id: 'fixture-reviewer' }, decision: 'approve', reviewedAt: Date.now() } }
  await writeFile(f.file(input.operationId), JSON.stringify(executing))
  const result = await f.cli(['maintenance-inspect', '--operation-id', input.operationId])
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result.record).toMatchObject({ state: 'unconfirmed', request: input })
  expect(f.manager.inspect).toHaveBeenCalledExactlyOnceWith(target, input.operationId)
  expect(f.manager.install).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledTimes(1)
  await f.desktop.stop()
  const missing = await f.cli(['maintenance-inspect', '--operation-id', input.operationId])
  expect(missing.code).not.toBe(0)
  expect(JSON.parse(await readFile(f.file(input.operationId), 'utf8'))).toEqual(executing)
  expect(f.manager.install).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledTimes(1)
})

it('explicit local owner wins; absent owner stays unavailable; forwarded results must match the original operation', async () => {
  const request = vi.fn(async () => null), inspect = vi.fn(async () => null), review = vi.fn(async () => null)
  const forward = vi.fn(async () => ({ record: null }))
  const principal = { kind: 'user' as const, id: 'fixture-person' }
  const local = new core.AgentMuxRpcService({ hostMaintenance: { request, inspect, review } as never, forwardControl: forward as never })
  cleanup.push(() => local.dispose())
  expect(await local.call('settings.hosts.maintenance-inspect', { operationId: input.operationId }, { principal })).toEqual({ record: null })
  expect(inspect).toHaveBeenCalledTimes(1); expect(forward).not.toHaveBeenCalled()
  const absent = new core.AgentMuxRpcService({}); cleanup.push(() => absent.dispose())
  await expect(absent.call('settings.hosts.maintenance-inspect', { operationId: input.operationId }, { principal })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const origin = { request: { ...input, operationId: 'another-operation' }, requester: principal, createdAt: 1 }
  const record = { ...origin, requestDigest: core.hostMaintenanceRequestDigest(origin), state: 'pending' }
  const bridge = vi.fn(async () => ({ record }))
  const service = new core.AgentMuxRpcService({ forwardControl: bridge as never }); cleanup.push(() => service.dispose())
  const context = { principal, assertCurrent: vi.fn(async () => {}) }
  await expect(service.call('settings.hosts.maintenance-inspect', { operationId: input.operationId }, context)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(bridge).toHaveBeenCalledExactlyOnceWith('settings.hosts.maintenance-inspect', { operationId: input.operationId }, context)
})
