import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionEnrollmentBeginInput } from '@agentmux/core/connections'
import type { ConnectionEnrollmentAdapter } from '../../src/connection-enrollment-adapter.js'
import { createDesktopConnections } from '../../../../apps/desktop/src/main/connector-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'

export const fixtureCredential = 'fixture-application-credential'
export const fixturePrivateState = 'private-signed-challenge-state'
export function enrollmentEncryption() {
  const key = Buffer.alloc(32, 9)
  return { isEncryptionAvailable: () => true,
    encryptString: (v: string) => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([c.update(v, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]) },
    decryptString: (v: Buffer) => { const c = createDecipheriv('aes-256-gcm', key, v.subarray(0, 12)); c.setAuthTag(v.subarray(12, 28)); return Buffer.concat([c.update(v.subarray(28)), c.final()]).toString() }
  }
}
export async function enrollmentFixture(options: { begin?: ConnectionEnrollmentAdapter['begin']; poll?: ConnectionEnrollmentAdapter['poll'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'enroll-')), directory = join(root, 'connections'), socketPath = join(root, 'public.sock'), encryption = enrollmentEncryption()
  const begin = vi.fn<ConnectionEnrollmentAdapter['begin']>(options.begin ?? (async input => {
    const signed = createHmac('sha256', fixturePrivateState).update(input.operationId).digest('hex')
    return { kind: 'pending', verificationUrl: 'https://verify.example.invalid/confirm', expiresInMs: null, pollIntervalMs: 0, privateState: JSON.stringify({ signed, operationId: input.operationId }) }
  }))
  const poll = vi.fn<ConnectionEnrollmentAdapter['poll']>(options.poll ?? (async input => {
    const p = JSON.parse(input.privateState)
    if (p.operationId !== input.operationId || p.signed !== createHmac('sha256', fixturePrivateState).update(input.operationId).digest('hex')) throw new Error('Wrong signed challenge')
    return { kind: 'authorized', application: { domain: input.domain, appId: 'application-original' }, secret: fixtureCredential }
  }))
  const adapter = { adapterId: 'signed-challenge', enrollment: { domains: [{ domain: 'verify.example.invalid', label: 'Signed challenge' }], begin, poll }, test: async () => ({ authentication: { state: 'ready' as const }, transport: { state: 'unknown' as const, reason: 'not-started' as const }, intake: { state: 'unknown' as const, reason: 'not-started' as const }, delivery: { state: 'unknown' as const, reason: 'not-started' as const } }) }
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async () => { services = await createDesktopConnections({ directory, encryption, adapters: [adapter] }); server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw new Error('Enrollment cannot borrow an Agent Runtime') } }); await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }) }
  const closeOwner = async () => { await sdk?.dispose(); await server?.stop(); services?.close() }
  await open()
  const input: ConnectionEnrollmentBeginInput = { operationId: 'enrollment-original', connectionId: 'connection-original', adapterId: adapter.adapterId, domain: 'verify.example.invalid', label: 'Original bot' }
  const cli = (args: string[], body?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], objectCliEnvironment(root), body === undefined ? '' : JSON.stringify(body))
  return { root, directory, input, encryption, adapter, begin, poll, cli, get services() { return services }, get sdk() { return sdk }, closeOwner, reopen: open, close: async () => { await closeOwner(); await rm(root, { recursive: true, force: true }) } }
}
