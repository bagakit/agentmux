import { createHmac } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionEnrollmentBeginInput } from '@agentmux/core/connections'
import type { ConnectionEnrollmentAdapter } from '../../src/connection-enrollment-adapter.js'
import { createConnectionServices } from '../../src/connection-services.js'
import { ConnectionSecrets } from '../../src/connection-secrets.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../../test/fixture-values.mjs'


export const fixtureCredential = 'fixture-application-credential'
export const fixturePrivateState = 'private-signed-challenge-state'
export async function privateCredentialValues(database: DatabaseSync): Promise<string[]> {
  const secrets = new ConnectionSecrets(database)
  const rows = database.prepare('SELECT credential_ref FROM connection_credential ORDER BY operation_id').all()
  return await Promise.all(rows.map(async row => {
    const value = await secrets.resolve(String(row.credential_ref))
    expect(value).not.toBeNull()
    return value!
  }))
}
export async function assertPrivateCredentialFiles(directory: string): Promise<void> {
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  expect((await stat(join(directory, 'connections.sqlite'))).mode & 0o777).toBe(0o600)
}
export const enrollmentAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
export async function enrollmentFixture(options: Partial<Pick<ConnectionEnrollmentAdapter, 'begin' | 'advance' | 'upload' | 'create' | 'credential'>> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'enroll-')), directory = join(root, 'connections'), socketPath = join(root, 'public.sock')
  const begin = vi.fn<ConnectionEnrollmentAdapter['begin']>(options.begin ?? (async input => {
    const signed = createHmac('sha256', fixturePrivateState).update(input.operationId).digest('hex')
    return { kind: 'authentication', stage: 'waiting', challenge: { qrPayload: 'original-private-qr', expiresAt: null, nextPollAt: _historyFixtureEpoch(0, 0, 0) }, account: null, privateState: JSON.stringify({ signed, operationId: input.operationId }) }
  }))
  const authentication = vi.fn<ConnectionEnrollmentAdapter['advance']>(options.advance ?? (async input => {
    const p = JSON.parse(input.privateState)
    if (p.operationId !== input.operationId || p.signed !== createHmac('sha256', fixturePrivateState).update(input.operationId).digest('hex')) throw new Error('Wrong signed challenge')
    return { kind: 'authentication', stage: 'account', challenge: null, account: { userId: 'original-user', tenantId: 'original-tenant' }, privateState: input.privateState }
  }))
  const upload = vi.fn<ConnectionEnrollmentAdapter['upload']>(options.upload ?? (async input => ({ kind: 'uploaded', privateState: input.privateState })))
  const create = vi.fn<ConnectionEnrollmentAdapter['create']>(options.create ?? (async input => ({ kind: 'created', application: { domain: input.domain, appId: 'application-original' }, privateState: input.privateState })))
  const credential = vi.fn<ConnectionEnrollmentAdapter['credential']>(options.credential ?? (async input => ({ kind: 'credential', secret: fixtureCredential, privateState: input.privateState })))
  const adapter = { adapterId: 'signed-challenge', enrollment: { domains: [{ domain: 'verify.example.invalid', label: 'Signed challenge' }], begin, advance: authentication, upload, create, credential }, test: async () => ({ authentication: { state: 'ready' as const }, transport: { state: 'unknown' as const, reason: 'not-started' as const }, intake: { state: 'unknown' as const, reason: 'not-started' as const }, delivery: { state: 'unknown' as const, reason: 'not-started' as const } }) }
  let services: Awaited<ReturnType<typeof createConnectionServices>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async () => { services = await createConnectionServices({ directory, adapters: [adapter] }); server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Enrollment cannot borrow an Agent Runtime') } }); await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }) }
  const closeOwner = async () => { const errors: unknown[] = []; for (const close of [async () => { await sdk?.dispose() }, async () => { await server?.stop() }, () => { services?.close() }]) { try { await close() } catch (error) { errors.push(error) } }; if (errors.length) throw new AggregateError(errors, 'Enrollment owner cleanup failed') }
  await open()
  const input: ConnectionEnrollmentBeginInput = { operationId: 'enrollment-original', connectionId: 'connection-original', adapterId: adapter.adapterId, domain: 'verify.example.invalid', label: 'Original bot', preset: { name: 'Original bot', avatar: { pngDataUrl: enrollmentAvatar } } }
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, input, adapter, begin, authentication, upload, create, credential, cli, get services() { return services }, get sdk() { return sdk }, closeOwner, reopen: open, close: async () => { const errors: unknown[] = []; try { await closeOwner() } catch (error) { errors.push(error) }; try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }; if (errors.length) throw new AggregateError(errors, 'Enrollment fixture cleanup failed') } }
}
