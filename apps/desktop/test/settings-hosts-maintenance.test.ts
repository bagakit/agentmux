import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxRpcService, remoteCoreUpgradeTargetDigest, parseHostMaintenanceRecord,
  type HostMaintenanceRequest, type RemoteCoreInstallManager, type RemoteCoreInstallReceipt, type RemoteCoreUpgradeManager } from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { SettingsHostsMaintenanceOwner } from '../src/main/settings-hosts-maintenance.js'
import { SettingsHostsInstallOwner } from '../src/main/settings-hosts-install.js'
import { SettingsHostsUpgradeOwner } from '../src/main/settings-hosts-upgrade.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
vi.mock('electron', () => ({ app: { getPath: () => '/fixture' } }))

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'Maintenance fixture cleanup failed.')
})
const host = { id: 'new-host', kind: 'ssh' as const, label: 'New Host', hostname: 'fixture.invalid' }
const expected = { targetDigest: remoteCoreUpgradeTargetDigest(host), prefix: '/home/fixture/core', candidateDigest: 'a'.repeat(64), nodeSha256: 'b'.repeat(64), keepRunning: 'start-script' as const }
const input: HostMaintenanceRequest = { action: 'install', id: host.id, host, expected, operationId: 'install-original' }
const agent = { kind: 'agent' as const, id: 'requesting-agent', runId: 'original-run' }
const user = { kind: 'user' as const, id: 'reviewing-user' }
const current = async () => {}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'host-review-')); cleanups.push(async () => await rm(root, { recursive: true, force: true }))
  let config = { ...structuredClone(DEFAULT_CONFIG), hosts: [host] }
  const configOwner = new ConfigOwner({ read: () => config, save: async next => next, publish: next => { config = next as typeof config } })
  const receipt: RemoteCoreInstallReceipt = { input: host, expected, operationId: input.operationId, status: 'completed', stage: 'completed', detail: 'Fixture deployment confirmed.', updatedAt: 1,
    installed: { remoteCommand: '/home/fixture/core/amux', remoteSocketPath: '/home/fixture/core/control.sock', runtimeId: 'fixture-runtime', startScript: '/home/fixture/core/start', unit: null } }
  const manager = { install: vi.fn(async () => structuredClone(receipt)), inspect: vi.fn(async () => structuredClone(receipt)) }
  const upgrade = { upgrade: vi.fn(), inspect: vi.fn(async () => null) }
  const runtime = { checkHost: vi.fn(async () => ({ detail: 'Fixture connection confirmed.' })) }
  const installs = new SettingsHostsInstallOwner(manager as unknown as RemoteCoreInstallManager, configOwner, runtime)
  const upgrades = new SettingsHostsUpgradeOwner(upgrade as unknown as RemoteCoreUpgradeManager, configOwner, runtime, join(root, 'adoptions.json'))
  const directory = join(root, 'requests'), owner = new SettingsHostsMaintenanceOwner(directory, configOwner, installs, upgrades)
  return { root, directory, owner, installs, upgrades, manager, upgrade, runtime, configOwner, read: () => config,
    file: join(directory, createHash('sha256').update(input.operationId).digest('hex') + '.json') }
}

it('retains the exact Agent request, then executes once through the original installation and configuration owners', async () => {
  const f = await fixture(), requested = await f.owner.request(input, agent, current)
  expect(requested).toMatchObject({ state: 'pending', request: input, requester: agent })
  expect(f.manager.install).not.toHaveBeenCalled(); expect(f.runtime.checkHost).not.toHaveBeenCalled()
  expect(parseHostMaintenanceRecord(JSON.parse(await readFile(f.file, 'utf8')))).toEqual(requested)
  const review = { operationId: input.operationId, requestDigest: requested.requestDigest, decision: 'approve' as const }
  const approved = await f.owner.review(review, user, current)
  expect(approved).toMatchObject({ state: 'finished', review: { actor: user, decision: 'approve' }, result: { status: 'completed', connectionAdoption: { state: 'connected' } } })
  expect(f.manager.install).toHaveBeenCalledExactlyOnceWith(host, expected, input.operationId)
  expect(f.read().hosts[0]).toMatchObject({ id: host.id, runtimeId: 'fixture-runtime' })
  expect(await f.owner.review(review, user, current)).toEqual(approved)
  const restarted = new SettingsHostsMaintenanceOwner(f.directory, f.configOwner, f.installs, f.upgrades)
  expect(await restarted.review(review, user, current)).toEqual(approved)
  expect(f.manager.install).toHaveBeenCalledTimes(1)
  expect((await restarted.inspect(input.operationId, agent))?.requester).toEqual(agent)
})

it('keeps rejection, stale Host CAS, another actor and changed request separate from execution', async () => {
  const f = await fixture(), request = await f.owner.request(input, agent, current)
  await expect(f.owner.request({ ...input, host: { ...host, label: 'Another draft' } }, agent, current)).rejects.toMatchObject({ code: 'HOST_MAINTENANCE_REQUEST_CONFLICT' })
  await expect(f.owner.inspect(input.operationId, { kind: 'agent', id: 'another-agent' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.owner.review({ operationId: input.operationId, requestDigest: request.requestDigest, decision: 'approve' }, agent, current)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await f.configOwner.update(config => ({ ...config, hosts: [{ ...host, hostname: 'later.invalid' }] }))
  await expect(f.owner.review({ operationId: input.operationId, requestDigest: request.requestDigest, decision: 'approve' }, user, current)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  expect((await f.owner.inspect(input.operationId, agent))?.state).toBe('pending')
  expect((await f.owner.review({ operationId: input.operationId, requestDigest: request.requestDigest, decision: 'reject' }, user, current)).state).toBe('rejected')
  expect(f.manager.install).not.toHaveBeenCalled(); expect(f.runtime.checkHost).not.toHaveBeenCalled()
})

it('does not replay a crash between durable approval and the original remote call', async () => {
  const f = await fixture(), pending = await f.owner.request(input, agent, current)
  const executing = { ...pending, state: 'executing', review: { actor: user, decision: 'approve', reviewedAt: Date.now() } }
  await writeFile(f.file, JSON.stringify(executing))
  f.manager.inspect.mockResolvedValue(null as any)
  const restarted = new SettingsHostsMaintenanceOwner(f.directory, f.configOwner, f.installs, f.upgrades)
  const result = await restarted.review({ operationId: input.operationId, requestDigest: pending.requestDigest, decision: 'approve' }, user, current)
  expect(result).toMatchObject({ state: 'unconfirmed', issue: { code: 'HOST_MAINTENANCE_EXECUTION_UNCONFIRMED' } })
  expect(f.manager.install).not.toHaveBeenCalled(); expect(f.manager.inspect).toHaveBeenCalledExactlyOnceWith(host, input.operationId)
  expect(JSON.parse(await readFile(f.file, 'utf8')).state).toBe('executing')
})

it('keeps a retained authenticated requester usable across unknown Runtime observations while refusing a confirmed different source', async () => {
  const f = await fixture(), original = { ...agent, hostId: 'source-route', runtimeId: 'original-runtime' }
  const request = await f.owner.request(input, original, current)
  expect(await f.owner.inspect(input.operationId, { ...agent, hostId: 'source-route' })).toEqual(request)
  await expect(f.owner.inspect(input.operationId, { ...original, runtimeId: 'different-runtime' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.owner.inspect(input.operationId, { ...original, hostId: 'different-route' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.manager.install).not.toHaveBeenCalled()
})

it('preserves unreadable original records and treats uncertain remote execution as inspectable, never replayable', async () => {
  const f = await fixture(), request = await f.owner.request(input, agent, current)
  f.manager.install.mockRejectedValue(new Error('Remote ACK lost'))
  const review = { operationId: input.operationId, requestDigest: request.requestDigest, decision: 'approve' as const }
  expect((await f.owner.review(review, user, current)).state).toBe('unconfirmed')
  f.manager.inspect.mockResolvedValue(null as any)
  expect((await f.owner.review(review, user, current)).state).toBe('unconfirmed')
  expect(f.manager.install).toHaveBeenCalledTimes(1)
  await writeFile(f.file, '{kept')
  await expect(f.owner.request(input, agent, current)).rejects.toMatchObject({ code: 'HOST_MAINTENANCE_RECORD_UNREADABLE' })
  expect(await readFile(f.file, 'utf8')).toBe('{kept')
})

it('fails a missing durable approval before any remote work and preserves the pending request', async () => {
  const f = await fixture(), request = await f.owner.request(input, agent, current)
  const file = f.file, before = await readFile(file, 'utf8')
  const original = (f.owner as any).write.bind(f.owner)
  const write = vi.spyOn(f.owner as any, 'write').mockRejectedValueOnce(new Error('No durable approval ACK'))
  await expect(f.owner.review({ operationId: input.operationId, requestDigest: request.requestDigest, decision: 'approve' }, user, current)).rejects.toThrow('No durable approval ACK')
  expect(f.manager.install).not.toHaveBeenCalled(); expect(await readFile(file, 'utf8')).toBe(before)
  write.mockImplementation(original)
})

it('the real compiled CLI submits with authenticated SID, refuses Agent approval, and lets the Unix person review the exact request', async () => {
  const f = await fixture(), agentOwner = await rpcOwnerFixture(['requesting-agent']); cleanups.push(agentOwner.close)
  const server = new AgentMuxControlServer({ socketPath: join(agentOwner.root, 'control.sock'), coreClients: agentOwner.coreClients, hostMaintenance: f.owner })
  await server.start(); cleanups.push(async () => await server.stop())
  const agentEnvironment = objectCliEnvironment(agentOwner.root, { AGENTMUX_AGENT_SESSION_ID: agentOwner.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: agentOwner.credentials.capability })
  const submit = await runCompiledObjectCli(['settings', 'hosts', 'maintenance-request', '--input', '-'], agentEnvironment, JSON.stringify(input))
  expect(submit.code, submit.stderr).toBe(0)
  const record = JSON.parse(submit.stdout).result.record
  expect(record.requester).toEqual({ kind: 'agent', id: 'requesting-agent', hostId: 'local', runId: 'run-requesting-agent' })
  const review = JSON.stringify({ requestDigest: record.requestDigest, decision: 'approve' })
  const denied = await runCompiledObjectCli(['settings', 'hosts', 'maintenance-review', '--operation-id', input.operationId, '--input', '-'], agentEnvironment, review)
  expect(denied.code).not.toBe(0); expect(JSON.parse(denied.stderr).error.code).toBe('CONTROL_PERMISSION_DENIED')
  expect(f.manager.install).not.toHaveBeenCalled()
  const approved = await runCompiledObjectCli(['settings', 'hosts', 'maintenance-review', '--operation-id', input.operationId, '--input', '-'], objectCliEnvironment(agentOwner.root), review)
  expect(approved.code, approved.stderr).toBe(0)
  expect(JSON.parse(approved.stdout).result.record).toMatchObject({ state: 'finished', requester: { id: 'requesting-agent' }, review: { actor: { kind: 'user' } }, result: { status: 'completed' } })
  const read = await runCompiledObjectCli(['settings', 'hosts', 'maintenance-inspect', '--operation-id', input.operationId], agentEnvironment)
  expect(read.code, read.stderr).toBe(0); expect(JSON.parse(read.stdout).result.record.result.status).toBe('completed')
  expect(f.manager.install).toHaveBeenCalledTimes(1)
})

it('never trusts review actor fields in business params or permits a managed caller plus a user principal', async () => {
  const f = await fixture(), h = await rpcOwnerFixture(['requesting-agent']); cleanups.push(h.close)
  const service = new AgentMuxRpcService({ coreClients: h.coreClients, hostMaintenance: f.owner }); cleanups.push(async () => await service.dispose())
  const requested = await service.call('settings.hosts.maintenance-request', input, { caller: h.credentials })
  const review = { operationId: input.operationId, requestDigest: requested.record!.requestDigest, decision: 'approve' as const }
  await expect(service.call('settings.hosts.maintenance-review', { ...review, actor: user } as any, { principal: user })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(service.call('settings.hosts.maintenance-review', review, { caller: h.credentials, principal: user })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.manager.install).not.toHaveBeenCalled()
})

it('keeps the original upgrade owner and exact reviewed Native replacement Runs, with deployment status separate from finished', async () => {
  const f = await fixture(), bound = { ...host, runtimeId: 'existing-runtime' }
  await f.configOwner.update(config => ({ ...config, hosts: [bound] }))
  const expectedUpgrade = { targetDigest: remoteCoreUpgradeTargetDigest(bound), runtimeId: 'existing-runtime', ownerInstanceId: 'original-owner', processId: 123,
    startTicks: '1234', candidateDigest: 'c'.repeat(64), nativeInstanceId: 'original-native', nativeProcessId: 456, nativeStartTicks: '4567', nativeReplacement: { endingRunIds: ['reviewed-run'] } }
  const upgrade: HostMaintenanceRequest = { action: 'upgrade', id: host.id, host: bound, expected: expectedUpgrade, operationId: 'upgrade-original' }
  f.upgrade.upgrade.mockResolvedValue({ input: bound, expected: expectedUpgrade, operationId: upgrade.operationId, status: 'unknown', stage: 'verifying', detail: 'Owner confirmation is unknown.', updatedAt: 2 })
  const request = await f.owner.request(upgrade, agent, current)
  const result = await f.owner.review({ operationId: upgrade.operationId, requestDigest: request.requestDigest, decision: 'approve' }, user, current)
  expect(result).toMatchObject({ state: 'finished', request: { expected: { nativeReplacement: { endingRunIds: ['reviewed-run'] } } }, result: { status: 'unknown' } })
  expect(parseHostMaintenanceRecord(result)).toEqual(result)
  expect(f.upgrade.upgrade).toHaveBeenCalledExactlyOnceWith(bound, expectedUpgrade, upgrade.operationId)
  f.upgrade.inspect.mockResolvedValue({ ...result.result, status: 'completed', stage: 'completed', detail: 'Original owner now confirmed.', updatedAt: 3 } as any)
  expect((await f.owner.inspect(upgrade.operationId, agent))?.result).toMatchObject({ status: 'completed', detail: 'Original owner now confirmed.' })
  expect(f.upgrade.upgrade).toHaveBeenCalledTimes(1)
  expect(f.manager.install).not.toHaveBeenCalled(); expect(f.runtime.checkHost).not.toHaveBeenCalled()
})
