import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { SettingsTailcatConfiguration } from '../src/main/settings-tailcat-configuration.js'
import { executeSettingsHostsControl } from '../src/main/settings-hosts-control.js'
import { desktopRpcMethods } from '../src/main/desktop-rpc-exposure.js'
import { callOriginalDesktopHost, connectDesktopAgentMuxHost } from '../src/main/desktop-host.js'
vi.mock('electron', () => ({ app: { getPath: () => '/private-tailcat-fixture' } }))

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const release of cleanup.splice(0).reverse()) try { await release() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private Tailcat consumer cleanup failed.')
})
const key = (n: string) => 'nodekey:' + n.repeat(64)
async function fixture() {
  const original = await rpcOwnerFixture(['original-agent'], core); cleanup.push(original.close)
  const bin = join(original.root, 'bin'); await mkdir(bin)
  await writeFile(join(bin, 'tailcat'), '#!' + process.execPath + '\n' + (await readFile(resolve('apps/host/test/fixtures/tailcat-cli.mjs'), 'utf8')).split('\n').slice(1).join('\n'))
  await chmod(join(bin, 'tailcat'), 0o700)
  const trace = join(original.root, 'tailcat-trace.jsonl')
  vi.stubEnv('PATH', bin)
  vi.stubEnv('TAILCAT_FIXTURE_TRACE', trace); vi.stubEnv('TAILCAT_FIXTURE_PORT', join(original.root, 'tailcat-port'))
  const serverKey = join(original.root, 'fixture-server.private.json')
  const privateKey = JSON.stringify({ Private: 'privkey:' + '1'.repeat(64), Public: { PresharedKey: 'psk:' + '2'.repeat(64), RegionID: 7 } })
  await writeFile(serverKey, privateKey, { mode: 0o600 })
  const configPath = join(original.root, 'config.json'), configStore = new ConfigStore(configPath)
  let config = await configStore.save({ ...structuredClone(DEFAULT_CONFIG), workspaces: [] })
  const configOwner = new ConfigOwner({ read: () => config, save: next => configStore.save(next), publish: next => { config = next } })
  const native = original.inner.kernel; await original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['connect', 'isConnected', 'status', 'identity', 'input', 'openInput', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  const path = join(original.root, 'control.sock'), desktopPath = join(original.root, 'desktop.sock')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    // Product Host/watch/CLI child composition is real. PATH contains only the
    // controlled official-CLI boundary, so no installed Tailcat/key is touched.
    host = await startAgentMuxHost({ store: original.store, configurationPath: configPath, socketPath: path,
      desktopSocketPath: desktopPath, mobileBuildDirectory: join(original.root, 'absent-mobile') })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const desktopCore = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Local' }, original.store)
  cleanup.push(() => desktopCore.dispose()); await desktopCore.readAgentSessions()
  const user = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => user.dispose())
  let observationUnavailable = false
  const owner = new SettingsTailcatConfiguration(configOwner, async signal => {
    if (observationUnavailable) throw new Error('Original listener observation unavailable')
    return (await user.call('settings.hosts.inspect', { hostId: 'local' }, { signal })).tailcat
  })
  const options: ConstructorParameters<typeof core.AgentMuxControlServer>[0] = { socketPath: desktopPath, exposedMethods: desktopRpcMethods(), forwardingPeer: { authoritySocketPath: path },
    coreClients: () => [{ hostId: 'local', client: desktopCore }], tailcatConfiguration: owner,
    execute: request => executeSettingsHostsControl(request as core.AgentMuxControlSettingsHostsRequest, configOwner, { checkHost: async () => { throw new Error('No diagnostic should execute') } }),
    callOriginalCore: (_host, method, params, context) => callOriginalDesktopHost(desktopCore, method, params, context) }
  let desktop = new core.AgentMuxControlServer(options); await desktop.start(); cleanup.push(() => desktop.stop())
  const reopen = async () => { desktop = new core.AgentMuxControlServer(options); await desktop.start() }
  const env = objectCliEnvironment(original.root, { AGENTMUX_RPC_ENDPOINT: `unix:${path}` })
  const agentEnv = { ...env, AGENTMUX_AGENT_SESSION_ID: original.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: original.credentials.capability }
  const cli = (args: string[], input?: unknown, agent = false) => runCompiledObjectCli(['settings', 'hosts', 'tailcat', ...args], agent ? agentEnv : env, input === undefined ? '' : JSON.stringify(input))
  const inspect = async (agent = false) => { const result = await cli(['inspect'], undefined, agent); expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout).result as core.TailcatConfigurationObservation }
  const traces = async (): Promise<Array<{ args: string[] }>> => { try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error } }
  return { original, host, native, owner, configOwner, configStore, user, env, cli, inspect, traces, bin, serverKey, privateKey, configPath,
    get desktop() { return desktop }, reopen, unavailable: (value: boolean) => { observationUnavailable = value },
    candidate: { enabled: true, keyFile: serverKey, allowedClients: [key('3')] } }
}

it('compiled CLI uses actual Host/Desktop/ConfigOwner and original controlled listener for enable, allowlist replacement and disable', async () => {
  const f = await fixture(), first = await f.inspect(true)
  expect(first.configuration.value).toBeNull(); expect(first.listener.value.state).toBe('disabled')
  const enabled = await f.cli(['configure', '--input', '-'], { expected: null, candidate: f.candidate })
  expect(enabled.code, enabled.stderr).toBe(0)
  expect(JSON.parse(enabled.stdout).result.configuration.value).toEqual(f.candidate)
  expect(enabled.stdout).not.toContain('privkey:'); expect(enabled.stdout).not.toContain('psk:')
  await vi.waitFor(async () => expect((await f.inspect()).listener.value.state).toBe('listening'), { timeout: 10000 })
  expect((await f.traces())[0]!.args).toContain('--allow=' + key('3'))
  await f.configOwner.update(current => ({ ...current, hosts: current.hosts.map(host => host.kind === 'local' ? { ...host, label: 'Concurrent local label' } : host) }))
  const replacement = { ...f.candidate, allowedClients: [key('4')] }
  const changed = await f.cli(['configure', '--input', '-'], { expected: f.candidate, candidate: replacement })
  expect(changed.code, changed.stderr).toBe(0)
  await vi.waitFor(async () => expect((await f.traces()).at(-1)!.args).toContain('--allow=' + key('4')), { timeout: 10000 })
  expect(f.configOwner.current.hosts.find(host => host.id === 'local')!.label).toBe('Concurrent local label')
  const disabled = { enabled: false, keyFile: '', allowedClients: [] }
  const stopped = await f.cli(['configure', '--input', '-'], { expected: replacement, candidate: disabled })
  expect(stopped.code, stopped.stderr).toBe(0)
  await vi.waitFor(async () => expect((await f.inspect()).listener.value.state).toBe('disabled'), { timeout: 10000 })
  const count = (await f.traces()).length
  for (let i = 0; i < 2; i++) expect((await f.inspect()).configuration.value).toEqual(disabled)
  expect((await f.traces()).length).toBe(count)
  expect(await readFile(f.serverKey, 'utf8')).toBe(f.privateKey)
  await f.host.client.writeAgent({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, data: 'healthy original input', source: 'user' })
  expect(f.original.rawInput).toHaveBeenCalled(); expect(f.native.stop).not.toHaveBeenCalled()
  expect((await f.host.client.readAgentSession('original-agent'))!.run.runId).toBe('run-original-agent')
})

it('original actor, exact slice and generic local-Host boundary remain enforced through the real bridge', async () => {
  const f = await fixture(), before = await readFile(f.configPath)
  const denied = await f.cli(['configure', '--input', '-'], { expected: null, candidate: f.candidate }, true)
  expect(denied.code).not.toBe(0); expect(JSON.parse(denied.stderr).error.code).toBe('CONTROL_PERMISSION_DENIED')
  expect(await readFile(f.configPath)).toEqual(before); expect(await f.traces()).toEqual([])
  expect((await f.inspect(true)).configuration.value).toBeNull()
  await expect(f.user.call('settings.hosts.tailcat.configure', { hostId: 'another-host', expected: null, candidate: f.candidate } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const local = structuredClone(f.configOwner.current.hosts.find(host => host.id === 'local')!)
  await expect(f.user.call('settings.hosts.configure', { id: 'local', expected: local, candidate: { ...local, tailcat: f.candidate } })).rejects.toMatchObject({ code: 'SETTING_IDENTITY_IMMUTABLE' })
  const allowed = await f.cli(['configure', '--input', '-'], { expected: null, candidate: f.candidate }); expect(allowed.code, allowed.stderr).toBe(0)
  const stale = await f.cli(['configure', '--input', '-'], { expected: null, candidate: { ...f.candidate, allowedClients: [key('5')] } })
  expect(stale.code).not.toBe(0); expect(JSON.parse(stale.stderr).error.code).toBe('CONFIG_CONFLICT')
  const invalid = await f.cli(['configure', '--input', '-'], { expected: f.candidate, candidate: { ...f.candidate, allowedClients: ['not-an-original-node-key'] } })
  expect(invalid.code).not.toBe(0)
  expect((await f.inspect()).configuration.value).toEqual(f.candidate)
})

it('saved configuration is not a listener/reachability claim; missing CLI or observation cannot block explicit disable', async () => {
  const f = await fixture()
  vi.stubEnv('PATH', join(f.original.root, 'missing-cli'))
  const saved = await f.cli(['configure', '--input', '-'], { expected: null, candidate: f.candidate })
  expect(saved.code, saved.stderr).toBe(0); expect(JSON.parse(saved.stdout).result.configuration.value).toEqual(f.candidate)
  expect(JSON.parse(saved.stdout).result.listener.value.state).not.toBe('listening')
  await vi.waitFor(async () => expect((await f.inspect()).listener.value.state).toBe('failed'), { timeout: 10000 })
  f.unavailable(true)
  const unknown = await f.inspect()
  expect(unknown.configuration.value).toEqual(f.candidate); expect(unknown.listener.value.state).toBe('unknown')
  const disabled = { enabled: false, keyFile: '', allowedClients: [] }
  const stopped = await f.cli(['configure', '--input', '-'], { expected: f.candidate, candidate: disabled })
  expect(stopped.code, stopped.stderr).toBe(0)
  expect(JSON.parse(stopped.stdout).result.listener.value.state).toBe('unknown')
  f.unavailable(false)
  await vi.waitFor(async () => expect((await f.inspect()).listener.value.state).toBe('disabled'), { timeout: 10000 })
  expect(await f.traces()).toEqual([])
  await f.host.client.writeAgent({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, data: 'still usable', source: 'user' })
  expect(f.original.rawInput).toHaveBeenCalled(); expect(f.native.stop).not.toHaveBeenCalled()
})

it('after an actual lost save reply, inspect reports current facts without reapplying or restarting', async () => {
  const f = await fixture(), original = f.owner.call.bind(f.owner)
  vi.spyOn(f.owner, 'call').mockImplementationOnce(async (method, params, context) => {
    const result = await original(method, params, context)
    await f.desktop.stop()
    return result
  })
  const saved = await f.cli(['configure', '--input', '-'], { expected: null, candidate: f.candidate })
  expect(saved.code).not.toBe(0)
  expect(f.configOwner.current.hosts.find(host => host.kind === 'local')!.tailcat).toEqual(f.candidate)
  await f.reopen()
  await vi.waitFor(async () => expect((await f.inspect()).listener.value.state).toBe('listening'), { timeout: 10000 })
  const saves = vi.spyOn(f.configStore, 'save'), before = (await f.traces()).length
  for (let i = 0; i < 2; i++) expect((await f.inspect()).configuration.value).toEqual(f.candidate)
  expect(saves).not.toHaveBeenCalled(); expect((await f.traces()).length).toBe(before)
  const removed = await f.cli(['configure', '--input', '-'], { expected: f.candidate, candidate: null })
  expect(removed.code, removed.stderr).toBe(0); expect((await f.inspect()).configuration.value).toBeNull()
})
