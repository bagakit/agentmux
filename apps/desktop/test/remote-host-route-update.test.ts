import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxMemoryAgentSessionStore, AgentMuxControlServer } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { saveRuntimeConfig } from '../src/main/runtime-config-transaction.js'
import { executeSettingsHostsControl } from '../src/main/settings-hosts-control.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { rpcControlRequest, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec.js'
import type { DesktopRuntimeClient } from '../src/main/desktop-host.js'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const host = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'original.invalid', runtimeId: 'original-runtime' }
const next = { ...host, hostname: 'candidate.invalid', port: 2222 }
const control = { kind: 'agent' as const, hostId: host.id, agentSessionId: 'original-session', run: { runId: 'original-run' } }
async function fixture() {
  const candidate = { owner: { runtimeId: host.runtimeId, availability: 'connected' }, activate: vi.fn(), assertCurrent: vi.fn(), dispose: vi.fn(async () => {}) }
  const client = { runtimeOwnerIdentity: () => ({ runtimeId: host.runtimeId, ownerInstanceId: 'core', availability: 'connected' }),
    connect: vi.fn(async () => {}), connectRuntime: vi.fn(async () => {}), setRemoteCommand: vi.fn(), prepareRoute: vi.fn(async () => candidate),
    listRuns: vi.fn(async () => [{ runId: control.run.runId, state: 'running' }]), onEvent: vi.fn(() => () => {}), dispose: vi.fn(async () => {}),
    writeAgent: vi.fn(async () => {}), stopAgent: vi.fn(), stopTerminal: vi.fn(),
    observeSessionHistory: vi.fn(async () => ({ source: { providerId: 'codex', nativeSessionId: 'native' }, dispose: vi.fn() })) }
  const connector = vi.fn(async (_config: HostConfig) => client as unknown as DesktopRuntimeClient)
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), connector)
  let config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [host] }
  runtime.commit(await runtime.prepare(config)); closes.push(() => runtime.dispose())
  const history = await runtime.observeSessionHistory(control, vi.fn(), config, new AbortController().signal)
  const save = vi.fn(async (value: AppConfig) => value)
  const owner = new ConfigOwner({ read: () => config, save: value => saveRuntimeConfig({ runtime, configWriter: { save }, next: value }), publish: value => { config = value } })
  return { client, candidate, runtime, connector, save, owner, history, config: () => config }
}
it('the existing GUI configuration edit repairs a bound route without replacing its consumer or reading the failed old route', async () => {
  const f = await fixture(); f.client.connect.mockRejectedValueOnce(new Error('Old route has disappeared'))
  await f.owner.edit(f.config(), { ...f.config(), hosts: [next] })
  expect(f.config().hosts).toEqual([next]); expect(f.runtime.rpcClients()[0]!.client).toBe(f.client)
  expect(f.client.prepareRoute).toHaveBeenCalledWith({ ...next, hostId: host.id })
  expect(f.connector).toHaveBeenCalledTimes(1); expect(f.client.listRuns).not.toHaveBeenCalled(); expect(f.client.dispose).not.toHaveBeenCalled()
  expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.candidate.activate.mock.invocationCallOrder[0]!)
  expect((await f.client.observeSessionHistory.mock.results[0]!.value).dispose).not.toHaveBeenCalled()
  f.client.connect.mockReset().mockResolvedValue(undefined)
  await f.runtime.write(control, 'same original Run', 'user')
  expect(f.client.writeAgent).toHaveBeenCalledOnce(); expect(f.client.stopAgent).not.toHaveBeenCalled(); expect(f.client.stopTerminal).not.toHaveBeenCalled()
})
it('candidate confirmation cannot reserve healthy input, and a failed save releases only the candidate', async () => {
  const f = await fixture(); let release!: () => void
  f.client.prepareRoute.mockImplementationOnce(async () => { await new Promise<void>(yes => { release = yes }); return f.candidate })
  f.save.mockRejectedValueOnce(new Error('Disk unavailable'))
  const pending = f.owner.edit(f.config(), { ...f.config(), hosts: [next] }); const rejected = expect(pending).rejects.toThrow('Disk unavailable')
  await vi.waitFor(() => expect(f.client.prepareRoute).toHaveBeenCalledOnce())
  await f.runtime.write(control, 'input while checking', 'user'); expect(f.client.writeAgent).toHaveBeenCalledOnce()
  release(); await rejected
  expect(f.candidate.activate).not.toHaveBeenCalled(); expect(f.candidate.dispose).toHaveBeenCalledOnce()
  expect(f.config().hosts).toEqual([host]); expect(f.client.dispose).not.toHaveBeenCalled()
})
it('stale candidate or wrong identity refuses only this save and keeps the original work', async () => {
  const f = await fixture(); f.candidate.assertCurrent.mockImplementationOnce(() => { throw new Error('Source changed') })
  await expect(f.owner.edit(f.config(), { ...f.config(), hosts: [next] })).rejects.toThrow('Source changed')
  expect(f.save).not.toHaveBeenCalled(); expect(f.candidate.dispose).toHaveBeenCalledOnce(); expect(f.candidate.activate).not.toHaveBeenCalled()
  f.client.prepareRoute.mockRejectedValueOnce(Object.assign(new Error('Wrong Runtime'), { code: 'RUNTIME_OWNER_MISMATCH' }))
  await expect(f.owner.edit(f.config(), { ...f.config(), hosts: [next] })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(f.save).not.toHaveBeenCalled(); expect(f.config().hosts).toEqual([host]); expect(f.client.dispose).not.toHaveBeenCalled()
})
it('the compiled public CLI discovers, updates and reads the same exact configuration owner', async () => {
  const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'amux-route-cli-'))
  closes.push(() => rm(root, { recursive: true, force: true }))
  const requests: string[] = []
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => {
    requests.push(request.operation)
    if (!request.operation.startsWith('settings.hosts.')) throw new Error('Unexpected operation')
    return executeSettingsHostsControl(request as Parameters<typeof executeSettingsHostsControl>[0], f.owner, f.runtime)
  } }); await server.start(); closes.push(() => server.stop())
  const env = objectCliEnvironment(root), input = join(root, 'update.json')
  await writeFile(input, JSON.stringify({ expected: host, candidate: next }))
  const help = await runCompiledObjectCli(['settings', 'hosts', '--help'], env)
  expect(help.code).toBe(0); expect(help.stdout).toContain('settings hosts update')
  const result = await runCompiledObjectCli(['settings', 'hosts', 'update', host.id, '--input', input], env)
  expect(result.code, result.stderr + result.stdout).toBe(0)
  expect(JSON.parse(result.stdout).result.host).toEqual(next)
  const read = await runCompiledObjectCli(['settings', 'hosts', 'ls'], env)
  expect(JSON.parse(read.stdout).result.hosts).toEqual([next]); expect(f.candidate.activate).toHaveBeenCalledOnce()
  expect(requests).toEqual(['settings.hosts.update', 'settings.hosts.list'])
  if (process.env.AGENTMUX_ROUTE_PROOF_DIRECTORY) await writeFile(join(process.env.AGENTMUX_ROUTE_PROOF_DIRECTORY, 'public-cli-receipt.json'), JSON.stringify({ requests, committedHost: f.config().hosts[0], originalConsumerRetained: f.runtime.rpcClients()[0]!.client === f.client, oldRouteRunQueries: f.client.listRuns.mock.calls.length, originalClientDisposals: f.client.dispose.mock.calls.length }))
  await executeSettingsHostsControl({ schemaVersion: 1, requestId: 'readback-retry', operation: 'settings.hosts.update', id: host.id, expected: host, candidate: next }, f.owner, f.runtime)
  expect(f.candidate.activate).toHaveBeenCalledOnce()
  await expect(executeSettingsHostsControl({ schemaVersion: 1, requestId: 'stale', operation: 'settings.hosts.update', id: host.id, expected: host, candidate: { ...next, port: 3333 } }, f.owner, f.runtime)).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
})
it('public DTO refuses wrong-object results and an unbound or different Runtime update', async () => {
  const f = await fixture()
  expect(() => rpcControlRequest('settings.hosts.update', { id: host.id, candidate: next })).toThrow()
  expect(() => parseRpcControlResult('settings.hosts.update', { host: { ...next, id: 'other' } }, { id: host.id, expected: host, candidate: next })).toThrow()
  for (const candidate of [{ ...next, runtimeId: 'other' }, { ...next, runtimeId: undefined }, { id: host.id, kind: 'local', label: 'Local' }]) {
    await expect(executeSettingsHostsControl({ schemaVersion: 1, requestId: 'wrong', operation: 'settings.hosts.update', id: host.id, expected: host, candidate: candidate as never }, f.owner, f.runtime)).rejects.toThrow()
  }
  expect(f.save).not.toHaveBeenCalled(); expect(f.candidate.activate).not.toHaveBeenCalled()
})
