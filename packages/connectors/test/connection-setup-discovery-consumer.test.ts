import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionConfig, ConnectionSetupResultMap } from '@agentmux/core/connections'
import type { DatabaseSync } from 'node:sqlite'
import { createConnection, createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli, type CliResult } from '../../core/test/helpers/object-cli-rpc.js'

type Discovery = ConnectionSetupResultMap['connection.setup.ls']
const secret = 'fixture-discovery-private-bot-secret'
const goal = { kind: 'agent-conversation', interaction: 'messages' } as const
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of clean.splice(0).reverse()) await close() })
function result<T = Discovery>(output: CliResult): T { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }
async function fixture(options: { domain?: string; adapterId?: string; paused?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'setup-discovery-')), socketPath = join(root, 'owner.sock'), encryption = enrollmentEncryption()
  const services = await createDesktopConnections({ directory: join(root, 'connections'), encryption })
  const server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Local implementation discovery cannot borrow an Agent Runtime') } })
  await server.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  clean.push(async () => { await sdk.dispose(); await server.stop(); services.close(); await rm(root, { recursive: true, force: true }) })
  const credential = await services.secrets.store({ operationId: 'discovery-credential', secret })
  const config: ConnectionConfig = { connectionId: 'discovery-saved-bot', adapterId: options.adapterId ?? 'feishu', application: { domain: options.domain ?? 'open.feishu.cn', appId: 'cli_discovery_original_bot' }, label: 'Original discovery bot', enabled: !options.paused, credentialRef: credential.credentialRef }
  const saved = await sdk.call('connection.configure', { operationId: 'discovery-original-save', expectedRevision: null, connection: config })
  // Discovery has no network effect. This trap never supplies a protocol response.
  const network = vi.fn(async () => { throw new Error('Discovery attempted an external request') }); vi.stubGlobal('fetch', network)
  const cli = (args: string[], endpoint = socketPath) => runCompiledObjectCli(['--endpoint', 'unix:' + endpoint, 'connection', 'setup', ...args], objectCliEnvironment(root))
  return { root, socketPath, services, sdk, encryption, config, saved, cli, network }
}
function vaultReads() {
  // Call-through observation of the original security boundary, never a fabricated port.
  return [vi.spyOn(DesktopConnectorSecrets.prototype, 'assertAvailable'), vi.spyOn(DesktopConnectorSecrets.prototype, 'inspect'), vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve'), vi.spyOn(DesktopConnectorSecrets.prototype, 'store')]
}
function facts(database: DatabaseSync) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  expect(tables.length).toBeGreaterThan(0)
  const rows = tables.flatMap(table => {
    const values = database.prepare('SELECT * FROM "' + String(table.name).replaceAll('"', '""') + '"').all()
    return values.length ? [{ table: table.name, values }] : []
  })
  return { rows, changes: database.prepare('SELECT total_changes() AS count').get() }
}

it('compiled CLI and SDK discover the original registered implementation with no authentication, Vault probe, native request or new domain fact', async () => {
  const f = await fixture({ paused: true })
  const off = await f.sdk.call('connection.service.configure', { operationId: 'discovery-service-off', expectedRevision: 0, service: { enabled: false } })
  const before = await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId }), originalFacts = facts(f.services.database!)
  const available = vi.spyOn(f.encryption, 'isEncryptionAvailable').mockReturnValue(false), encrypt = vi.spyOn(f.encryption, 'encryptString'), decrypt = vi.spyOn(f.encryption, 'decryptString'), vault = vaultReads()
  const expected: Discovery = { operations: [], next: null, support: { connectionRevision: 1, capabilities: ['management-authentication', 'application-inspection'] } }
  expect(result(await f.cli(['ls', '--connection', f.config.connectionId]))).toEqual(expected)
  expect(await f.sdk.call('connection.setup.ls', { connectionId: f.config.connectionId })).toEqual(expected)
  expect(await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).toEqual(before)
  expect((await f.sdk.call('connection.inspect', { operationId: 'discovery-original-save' })).operation).toEqual(f.saved)
  expect(await f.sdk.call('connection.service.get', {})).toEqual(off.service)
  expect(facts(f.services.database!)).toEqual(originalFacts)
  expect(available).not.toHaveBeenCalled(); expect(encrypt).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled()
  for (const observed of vault) expect(observed).not.toHaveBeenCalled()
  expect(f.network).not.toHaveBeenCalled()
  expect(JSON.stringify(expected)).not.toContain(secret)
}, 20_000)

it('unsupported domain, missing adapter and absent Connection are distinct from supported current revisions without replacing the saved bot', async () => {
  for (const options of [{ domain: 'open.larksuite.com' }, { adapterId: 'unregistered-adapter' }]) {
    const f = await fixture(options), vault = vaultReads(), before = facts(f.services.database!)
    const unsupported: Discovery = { operations: [], next: null, support: { connectionRevision: 1, capabilities: [] } }
    expect(result(await f.cli(['ls', '--connection', f.config.connectionId]))).toEqual(unsupported)
    expect(await f.sdk.call('connection.setup.ls', { connectionId: f.config.connectionId })).toEqual(unsupported)
    expect(await f.sdk.call('connection.setup.ls', { connectionId: 'absent-discovery-bot' })).toEqual({ operations: [], next: null, support: null })
    expect(result(await f.cli(['ls', '--connection', 'absent-discovery-bot']))).toEqual({ operations: [], next: null, support: null })
    expect(facts(f.services.database!)).toEqual(before)
    for (const observed of vault) { expect(observed).not.toHaveBeenCalled(); observed.mockRestore() }
    expect(f.network).not.toHaveBeenCalled()
    expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(f.saved.connection)
  }
}, 20_000)

it('discovery reads the latest saved revision while preserving original safe operations and bounded pagination', async () => {
  const f = await fixture(), available = vi.spyOn(f.encryption, 'isEncryptionAvailable').mockReturnValue(false)
  const originals = []
  for (const operationId of ['discovery-first-original', 'discovery-second-original', 'discovery-third-original']) {
    const view = await f.sdk.call('connection.setup.begin', { operationId, connectionId: f.config.connectionId, expectedConnectionRevision: 1, goal })
    expect(view.operation).toMatchObject({ operationId, request: { state: 'not-dispatched', attemptId: null }, reason: 'secure-storage-unavailable' })
    originals.push(view.operation!)
  }
  expect(available).toHaveBeenCalledTimes(3)
  const revised = await f.sdk.call('connection.configure', { operationId: 'discovery-revised-save', expectedRevision: 1, connection: { ...f.config, label: 'Revised local label', enabled: false } })
  const before = facts(f.services.database!), vault = vaultReads(), expectedSupport = { connectionRevision: 2, capabilities: ['management-authentication', 'application-inspection'] }
  const first = result(await f.cli(['ls', '--connection', f.config.connectionId, '--limit', '1']))
  expect(first).toEqual({ operations: [originals[2]], next: expect.any(String), support: expectedSupport })
  expect(first.next).not.toBe('')
  const second = await f.sdk.call('connection.setup.ls', { connectionId: f.config.connectionId, cursor: first.next!, limit: 1 })
  expect(second).toEqual({ operations: [originals[1]], next: expect.any(String), support: expectedSupport })
  const third = result(await f.cli(['ls', '--connection', f.config.connectionId, '--cursor', second.next!, '--limit', '1']))
  expect(third).toEqual({ operations: [originals[0]], next: null, support: expectedSupport })
  expect((await f.sdk.call('connection.setup.ls', { connectionId: f.config.connectionId })).operations).toEqual([...originals].reverse())
  expect(facts(f.services.database!)).toEqual(before)
  for (const observed of vault) expect(observed).not.toHaveBeenCalled()
  expect(f.network).not.toHaveBeenCalled()
  expect((await f.sdk.call('connection.inspect', { connectionId: f.config.connectionId })).connection).toEqual(revised.connection)
  expect((await f.sdk.call('connection.inspect', { operationId: 'discovery-original-save' })).operation).toEqual(f.saved)
  expect(JSON.stringify([first, second, third])).not.toContain(secret)
}, 20_000)

async function wireFault(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.root, 'wire.sock'), sockets = new Set<Socket>()
  let corrupt: (original: Discovery) => unknown = value => value
  const originals: Discovery[] = []
  const server = createServer(client => {
    const owner = createConnection(f.socketPath); sockets.add(client); sockets.add(owner)
    client.on('error', () => owner.destroy()); owner.on('error', () => client.destroy())
    client.once('close', () => { sockets.delete(client); owner.destroy() }); owner.once('close', () => { sockets.delete(owner); client.end() })
    client.pipe(owner)
    let pending = ''; owner.setEncoding('utf8')
    owner.on('data', chunk => {
      pending += chunk
      for (;;) {
        const newline = pending.indexOf('\n'); if (newline < 0) break
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
        if (!line) continue
        const frame = JSON.parse(line)
        if (frame.result && Object.hasOwn(frame.result, 'support')) { originals.push(frame.result); frame.result = corrupt(frame.result) }
        client.write(JSON.stringify(frame) + '\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  clean.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); clean.push(() => sdk.dispose())
  return { path, sdk, originals, fault: (value: typeof corrupt) => { corrupt = value } }
}

it('real SDK and compiled CLI reject malformed support on the wire without changing the original owner or taking away valid discovery', async () => {
  const f = await fixture(), wire = await wireFault(f), before = facts(f.services.database!)
  const valid: Discovery = { operations: [], next: null, support: { connectionRevision: 1, capabilities: ['management-authentication', 'application-inspection'] } }
  expect(await wire.sdk.call('connection.setup.ls', { connectionId: f.config.connectionId })).toEqual(valid)
  const faults = [
    (value: Discovery) => ({ ...value, support: { ...value.support, capabilities: ['future-platform-authority'] } }),
    (value: Discovery) => ({ ...value, support: { ...value.support, capabilities: ['management-authentication', 'management-authentication'] } }),
    (value: Discovery) => ({ ...value, support: { ...value.support, connectionRevision: 0 } }),
    (value: Discovery) => ({ ...value, support: { ...value.support, qrPayload: 'fixture-forbidden-private-scan' } }),
    (value: Discovery) => { const { support: _missing, ...rest } = value; return rest }
  ]
  for (const fault of faults) {
    wire.fault(fault)
    await expect(wire.sdk.call('connection.setup.ls', { connectionId: f.config.connectionId })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    const output = await f.cli(['ls', '--connection', f.config.connectionId], wire.path)
    expect(output.code).not.toBe(0)
    expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, operation: 'connection.setup.ls', error: { code: 'CONTROL_PROTOCOL_ERROR' } })
    expect(output.stdout + output.stderr).not.toContain('fixture-forbidden-private-scan')
  }
  expect(wire.originals).toEqual(Array.from({ length: 11 }, () => valid))
  wire.fault(value => value)
  expect(result(await f.cli(['ls', '--connection', f.config.connectionId], wire.path))).toEqual(valid)
  expect(await f.sdk.call('connection.setup.ls', { connectionId: f.config.connectionId })).toEqual(valid)
  expect(facts(f.services.database!)).toEqual(before)
  expect((await f.sdk.call('connection.inspect', { operationId: 'discovery-original-save' })).operation).toEqual(f.saved)
  expect(f.network).not.toHaveBeenCalled()
}, 30_000)
