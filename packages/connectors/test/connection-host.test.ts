import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../core/src/public-rpc-server.js'
import { AgentMuxRpcService } from '../../core/src/public-rpc-service.js'
import { parseConnectionParams } from '../../core/src/connections-codec.js'
import type { ConnectionConfig, ConnectionObservation } from '../../core/src/connections-contract.js'
import { runCompiledObjectCli, objectCliEnvironment } from '../../core/test/helpers/object-cli-rpc.js'
import { ConnectionHost } from '../src/connection-host.js'

const config: ConnectionConfig = { connectionId: 'connection-a', adapterId: 'sample', application: { domain: 'chat.example', appId: 'app-a' }, label: 'Team application', enabled: true, credentialRef: 'credential-a' }
const observation: ConnectionObservation = { authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }
const hosts: ConnectionHost[] = [], directories: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const host of hosts.splice(0)) host.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function host(options: Partial<ConstructorParameters<typeof ConnectionHost>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'connection-')); directories.push(directory)
  const owner = new ConnectionHost({ databasePath: join(directory, 'connections.sqlite'), secrets: { resolve: async () => 'private-credential' }, ...options }); hosts.push(owner)
  return { owner, directory }
}
const create = (owner: ConnectionHost, operationId = 'save-a') => owner.configure({ operationId, expectedRevision: null, connection: config })

describe('original connection owner', () => {
  it('atomically retains configuration operations, reconciles duplicates and preserves identity during rotation', async () => {
    const { owner, directory } = await host()
    const first = await create(owner)
    expect(await create(owner)).toEqual(first)
    await expect(owner.configure({ operationId: 'save-a', expectedRevision: 1, connection: { ...config, label: 'Different' } })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
    await expect(owner.configure({ operationId: 'wrong-app', expectedRevision: 1, connection: { ...config, application: { ...config.application, appId: 'another-app' } } })).rejects.toMatchObject({ code: 'CONNECTION_IDENTITY_CONFLICT' })
    const rotated = await owner.configure({ operationId: 'rotate-a', expectedRevision: 1, connection: { ...config, credentialRef: 'credential-b' } })
    expect(rotated.connection.revision).toBe(2)
    expect(await create(owner)).toEqual(first)
    owner.close(); hosts.splice(hosts.indexOf(owner), 1)
    const restored = new ConnectionHost({ databasePath: join(directory, 'connections.sqlite'), secrets: { resolve: async () => null } }); hosts.push(restored)
    const result = await restored.inspect({ operationId: 'save-a' })
    expect(result.operation).toEqual(first)
    expect(result.connection?.config.credentialRef).toBe('credential-b')
    expect(result.connection?.observation.authentication.state).toBe('unknown')
    expect(await restored.inspect({ operationId: 'never-saved' })).toEqual({ operation: null, connection: null })
    expect((await readFile(join(directory, 'connections.sqlite'))).includes(Buffer.from('private-credential'))).toBe(false)
  })
  it('reads and saves without resolving secrets; tests exact credentials without claiming receiving or delivery', async () => {
    const resolve = vi.fn(async () => 'private-credential'), test = vi.fn(async () => observation)
    const { owner } = await host({ secrets: { resolve }, adapters: [{ adapterId: 'sample', test }] })
    await create(owner); await owner.list(); await owner.inspect({ connectionId: config.connectionId })
    expect(resolve).not.toHaveBeenCalled()
    const checked = await owner.test({ connectionId: config.connectionId })
    expect(resolve).toHaveBeenCalledExactlyOnceWith('credential-a')
    expect(test).toHaveBeenCalledExactlyOnceWith(config, 'private-credential')
    expect(checked.observation).toEqual(observation)
    expect(JSON.stringify(checked)).not.toContain('private-credential')
  })
  it('does not leak credential values or adapter exceptions and retains all original records', async () => {
    const { owner } = await host({ adapters: [{ adapterId: 'sample', test: async () => { throw new Error('private-credential in a platform response') } }] })
    await create(owner)
    const checked = await owner.test({ connectionId: config.connectionId })
    expect(checked.observation.authentication).toEqual({ state: 'unavailable', reason: 'check-failed' })
    expect(JSON.stringify(checked)).not.toContain('private-credential')
    expect((await owner.list()).connections).toHaveLength(1)
    expect(() => parseConnectionParams('connection.configure', { operationId: 'secret-input', expectedRevision: null, connection: { ...config, secret: 'private-credential' } })).toThrow()
  })
  it('rejects stale config writes and late credential checks without replacing original state', async () => {
    let finish!: (value: ConnectionObservation) => void
    const { owner } = await host({ adapters: [{ adapterId: 'sample', test: () => new Promise(resolve => { finish = resolve }) }] })
    await create(owner)
    const check = owner.test({ connectionId: config.connectionId }); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await owner.configure({ operationId: 'rotate-a', expectedRevision: 1, connection: { ...config, credentialRef: 'credential-b' } })
    finish(observation)
    expect((await check).observation.authentication.state).toBe('unknown')
    await expect(owner.configure({ operationId: 'stale', expectedRevision: 1, connection: config })).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  })
  it('keeps disabled and missing adapter facts distinct', async () => {
    const resolve = vi.fn(async () => null), { owner } = await host({ secrets: { resolve } })
    await create(owner)
    expect((await owner.test({ connectionId: config.connectionId })).observation.transport.reason).toBe('adapter-unavailable')
    expect(resolve).not.toHaveBeenCalled()
    await owner.configure({ operationId: 'disable-a', expectedRevision: 1, connection: { ...config, enabled: false } })
    expect((await owner.test({ connectionId: config.connectionId })).observation.authentication.state).toBe('disabled')
  })
})

describe('real public service and compiled CLI', () => {
  it('configures, lists and reconciles the original connection without another semantic Runtime', async () => {
    const { owner, directory } = await host({ adapters: [{ adapterId: 'sample', test: async () => observation }] })
    const server = new AgentMuxControlServer({ socketPath: join(directory, 'public.sock'), connections: owner, coreClients: () => { throw new Error('Connection configuration must not create or borrow an Agent Runtime.') } }); servers.push(server); await server.start()
    const env = objectCliEnvironment(directory), cli = (args: string[], stdin = '') => runCompiledObjectCli(['--endpoint', 'unix:' + join(directory, 'public.sock'), 'connection', ...args], env, stdin)
    const result = await cli(['configure', '--input', '-'], JSON.stringify({ operationId: 'cli-save', expectedRevision: null, connection: config }))
    expect(result.code, result.stderr || result.stdout).toBe(0)
    expect(JSON.parse(result.stdout).result.operationId).toBe('cli-save')
    const listed = await cli(['ls']); expect(listed.code, listed.stdout).toBe(0); expect(JSON.parse(listed.stdout).result.connections[0].config).toEqual(config)
    const inspected = await cli(['inspect', '--operation-id', 'cli-save']); expect(inspected.code, inspected.stdout).toBe(0); expect(JSON.parse(inspected.stdout).result.operation.operationId).toBe('cli-save')
    const checked = await cli(['test', '--connection', config.connectionId]); expect(checked.code, checked.stdout).toBe(0); expect(JSON.parse(checked.stdout).result.observation).toEqual(observation)
    const leaked = await cli(['configure', '--input', '-'], JSON.stringify({ operationId: 'bad-save', expectedRevision: null, connection: { ...config, secret: 'private-credential' } }))
    expect(leaked.code).not.toBe(0); expect(leaked.stdout + leaked.stderr).not.toContain('private-credential')
  })
  it('refuses forged administration and keeps optional connection absence local to that object', async () => {
    const { owner } = await host(), service = new AgentMuxRpcService({ connections: owner })
    await expect(service.call('connection.configure', { operationId: 'forged', expectedRevision: null, connection: config }, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    const plain = new AgentMuxRpcService(), principal = { principal: { kind: 'user' as const, id: 'test-user' } }
    await expect(plain.call('connection.ls', {}, principal)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(await plain.call('space.state', {}, principal)).toHaveProperty('state.graph')
    await plain.dispose(); await service.dispose()
  })
})
