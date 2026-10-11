import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { ConnectionHost } from '@agentmux/connectors'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { enrollmentFixture } from './fixtures/connection-enrollment.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'Metadata consumer cleanup failed')
})
async function fixture() { const f = await enrollmentFixture(); cleanup.push(f.close); return f }
function vaultReads() {
  return [vi.spyOn(DesktopConnectorSecrets.prototype, 'assertAvailable'), vi.spyOn(DesktopConnectorSecrets.prototype, 'inspect'),
    vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve'), vi.spyOn(DesktopConnectorSecrets.prototype, 'store')]
}

it('SDK and compiled CLI discover enrollment metadata without probing a locked vault, while begin still uses the original secure owner', async () => {
  const f = await fixture(), available = vi.spyOn(f.encryption, 'isEncryptionAvailable').mockReturnValue(false)
  const encrypt = vi.spyOn(f.encryption, 'encryptString'), decrypt = vi.spyOn(f.encryption, 'decryptString'), vault = vaultReads()
  const page = await f.sdk.call('connection.enrollment.ls', {})
  expect(available).not.toHaveBeenCalled(); expect(encrypt).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled()
  for (const read of vault) expect(read).not.toHaveBeenCalled()
  expect(page).toMatchObject({ operations: [], capabilities: [{ adapterId: f.input.adapterId, domain: f.input.domain, availability: 'available' }] })
  const cli = await f.cli(['enrollment', 'ls'])
  expect(cli.code, cli.stdout + cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(page)
  expect(available).not.toHaveBeenCalled(); for (const read of vault) expect(read).not.toHaveBeenCalled()
  const attempted = await f.sdk.call('connection.enrollment.begin', f.input)
  expect(available).toHaveBeenCalled(); expect(vault[0]).toHaveBeenCalled()
  expect(attempted.operation).toMatchObject({ operationId: f.input.operationId, authentication: { stage: 'not-started' }, diagnostic: { stage: 'secure-storage', code: 'asset-unconfirmed' } })
  expect(f.begin).not.toHaveBeenCalled(); expect(encrypt).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled()
  for (const read of vault) read.mockClear(); available.mockClear()
  expect((await f.sdk.call('connection.enrollment.ls', {})).operations).toEqual([attempted.operation])
  expect(available).not.toHaveBeenCalled(); for (const read of vault) expect(read).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
})

it('saved metadata remains readable while locked, but an explicit private inspection still resolves its original encrypted snapshot', async () => {
  const f = await fixture(), waiting = await f.sdk.call('connection.enrollment.begin', f.input)
  const saved = await f.sdk.call('connection.configure', { operationId: 'metadata-saved-configuration', expectedRevision: null,
    connection: { connectionId: 'metadata-saved-bot', adapterId: f.input.adapterId, application: { domain: f.input.domain, appId: 'metadata-original-application' },
      label: 'Metadata bot', credentialRef: 'metadata-retained-ref', enabled: false } })
  const available = vi.spyOn(f.encryption, 'isEncryptionAvailable').mockReturnValue(false)
  const encrypt = vi.spyOn(f.encryption, 'encryptString'), decrypt = vi.spyOn(f.encryption, 'decryptString'), vault = vaultReads()
  expect((await f.sdk.call('connection.enrollment.ls', {})).operations).toEqual([waiting.operation])
  expect((await f.sdk.call('connection.ls', {})).connections).toEqual([saved.connection])
  expect((await f.sdk.call('connection.inspect', { connectionId: saved.connection.config.connectionId })).connection).toEqual(saved.connection)
  expect(await f.sdk.call('connection.setup.ls', { connectionId: saved.connection.config.connectionId })).toMatchObject({ operations: [], next: null })
  expect(await f.sdk.call('connection.service.get', {})).toMatchObject({ enabled: true })
  expect(available).not.toHaveBeenCalled(); expect(encrypt).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled()
  for (const read of vault) expect(read).not.toHaveBeenCalled()
  const locked = await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId })
  expect(available).toHaveBeenCalled(); expect(locked.challenge).toBeNull()
  expect(locked.operation).toMatchObject({ operationId: f.input.operationId, authentication: waiting.operation!.authentication, diagnostic: { stage: 'secure-storage', code: 'challenge-unconfirmed' } })
  available.mockReturnValue(true); for (const read of vault) read.mockClear(); decrypt.mockClear()
  const original = await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId })
  expect(original).toEqual(waiting); expect(vault[0]).toHaveBeenCalled(); expect(vault[2]).toHaveBeenCalled(); expect(decrypt).toHaveBeenCalled()
  expect(f.begin).toHaveBeenCalledTimes(1); expect(f.authentication).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
  expect((await f.sdk.call('connection.ls', {})).connections).toEqual([saved.connection])
})

it('a Host without the complete enrollment security port does not advertise creation or borrow another secret owner', async () => {
  const f = await fixture(), database = new DatabaseSync(':memory:'), resolve = vi.fn(async () => null)
  const host = new ConnectionHost({ database, secrets: { resolve }, adapters: [f.adapter] })
  cleanup.push(() => { host.close(); database.close() })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'no-secret-port.sock'), connections: host, coreClients: () => { throw Error('Metadata cannot borrow an Agent Runtime') } })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sdk.dispose())
  expect((await sdk.call('connection.enrollment.ls', {})).capabilities).toEqual([{ adapterId: f.input.adapterId, domain: f.input.domain, label: 'Signed challenge', availability: 'unavailable', reason: 'secure-storage-unavailable' }])
  expect((await sdk.call('connection.enrollment.begin', f.input)).operation).toMatchObject({ authentication: { stage: 'not-started' }, diagnostic: { stage: 'secure-storage', code: 'asset-unconfirmed' } })
  expect(resolve).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled()
})
