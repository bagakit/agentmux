import { DatabaseSync } from 'node:sqlite'
import { ConnectionHost } from '@agentmux/connectors'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionEnrollmentBeginInput } from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import type { CredentialEncryption } from '../src/main/connector-secrets.js'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import { defaultFeishuSdkTransport, feishuConfig, feishuPayload } from '../../../packages/connectors/test/fixtures/feishu.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const privateDevice = 'private-enrollment-device-material'
const applicationSecret = 'private-enrolled-application-secret'
const input: ConnectionEnrollmentBeginInput = { operationId: 'original-enrollment', connectionId: 'enrolled-connection', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Team assistant' }
const cleanup: Array<() => void | Promise<void>> = []
let original: Awaited<ReturnType<typeof ingressFixture>>
let services: Awaited<ReturnType<typeof createDesktopConnections>>
let server: AgentMuxControlServer
let client: Awaited<ReturnType<typeof connectAgentMuxRpc>>
let sdk: ReturnType<typeof defaultFeishuSdkTransport>
let calls: Array<{ url: string; action: string; fields: Record<string, string>; preclaimed: boolean }>
let authorize: boolean
let clock: number
let secureAvailable: boolean

beforeEach(async () => {
  original = await ingressFixture(true, feishuConfig); cleanup.push(() => original.close())
  sdk = defaultFeishuSdkTransport()
  calls = []; authorize = true; secureAvailable = true; clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const key = randomBytes(32)
  const encryption: CredentialEncryption = {
    isEncryptionAvailable: () => secureAvailable,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(-16))
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8')
    }
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url), fields = Object.fromEntries(new URLSearchParams(String(init?.body)))
    const row = services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(input.operationId)
    const originalAttempt = row ? JSON.parse(String(row.record_json)).attemptId : null
    const claim = originalAttempt ? services.database!.prepare('SELECT state,kind,operation_id FROM connection_enrollment_attempt WHERE attempt_id=?').get(originalAttempt) : null
    const preclaimed = claim?.state === 'claimed' && claim.kind === fields.action && claim.operation_id === input.operationId
    calls.push({ url: target, action: fields.action ?? '', fields, preclaimed })
    if (target !== 'https://accounts.feishu.cn/oauth/v1/app/registration') throw new Error('Unexpected bootstrap network request')
    if (fields.action === 'begin') return Response.json({ device_code: privateDevice, user_code: 'BOT-CODE', verification_uri: 'https://open.feishu.cn/page/cli', verification_uri_complete: 'https://open.feishu.cn/page/cli?user_code=BOT-CODE', interval: 1, expires_in: 600 })
    if (fields.action === 'poll' && fields.device_code === privateDevice) {
      return Response.json(authorize ? { client_id: feishuConfig.application.appId, client_secret: applicationSecret, user_info: { tenant_brand: 'feishu' } } : { error: 'authorization_pending' })
    }
    throw new Error('Unexpected registration action')
  }))
  services = await createDesktopConnections({ directory: join(original.root, 'enrollment-host'), encryption,
    bindings: { spatial: original.spatial, checkpoint: async ref => ({ ...ref, checkpoint: await original.client.sessionHistoryCheckpoint(ref.agentSessionId) }) },
    ingress: { core: hostId => hostId === 'local' ? original.client : undefined } })
  cleanup.push(() => services.close())
  server = new AgentMuxControlServer({ socketPath: join(original.root, 'enrollment.sock'), connections: services.connections, coreClients: original.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => client.dispose())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function cli(args: string[], value?: unknown) {
  const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'enrollment', ...args], objectCliEnvironment(original.root), value === undefined ? '' : JSON.stringify(value))
  expect(result.code, result.stdout + result.stderr).toBe(0)
  return JSON.parse(result.stdout).result
}

it('default Host enrolls through compiled CLI and the original SDK receiver without exposing private material', async () => {
  const initial = await client.call('connection.enrollment.ls', {})
  expect(initial.operations).toEqual([])
  expect(initial.capabilities).toContainEqual(expect.objectContaining({ adapterId: 'feishu', domain: input.domain, availability: 'available' }))
  expect(calls).toEqual([])
  const pending = await cli(['begin', '--input', '-'], input)
  expect(calls[0]?.preclaimed, 'The original attempt must be durably claimed before the external request').toBe(true)
  expect(pending).toMatchObject({ ...input, authorization: 'pending', credential: 'not-started', configuration: 'not-started', application: null, configured: null })
  expect(pending.challenge.verificationUrl).toContain('user_code=BOT-CODE')
  const confirmation = new URL(pending.challenge.verificationUrl)
  expect(confirmation.origin).toBe('https://open.feishu.cn')
  expect(confirmation.searchParams.get('source')).toBe('node-sdk/agentmux')
  expect(confirmation.searchParams.get('createOnly')).toBe('true')
  expect(calls[0]!.fields).toMatchObject({ action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret' })
  expect(await client.call('connection.enrollment.begin', input)).toEqual(pending)
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(pending)
  expect((await cli(['ls'])).operations).toContainEqual(pending)
  expect(calls.map(call => call.action)).toEqual(['begin'])
  expect((await services.connections.list()).connections).toEqual([])
  services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  expect((await readFile(join(original.root, 'enrollment-host', 'connections.sqlite'))).includes(Buffer.from(privateDevice)), 'Private enrollment material must be OS encrypted before the public challenge is returned').toBe(false)
  clock = pending.challenge.nextPollAt + 1
  const saved = await cli(['advance', '--operation-id', input.operationId])
  expect(calls[1]?.preclaimed, 'The original poll must be durably claimed before one-time credential delivery').toBe(true)
  expect(saved, JSON.stringify(saved)).toMatchObject({ operationId: input.operationId, connectionId: input.connectionId, authorization: 'authorized', credential: 'stored', configuration: 'configured', application: feishuConfig.application, challenge: null })
  const record = (await client.call('connection.inspect', { connectionId: input.connectionId })).connection!
  expect(record.config).toMatchObject({ connectionId: input.connectionId, adapterId: 'feishu', application: feishuConfig.application, label: input.label, enabled: true })
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  await sdk.receive(feishuPayload())
  expect(sdk.ack()).toEqual([{ code: 200 }])
  expect((await services.ingress!.list({ connectionId: input.connectionId })).ingresses).toEqual([expect.objectContaining({ externalMessageId: 'platform-message' })])
  const readback = await client.call('connection.enrollment.inspect', { operationId: input.operationId })
  expect(readback.operation).toEqual(saved)
  const wire = JSON.stringify({ initial, pending, saved, readback, record })
  expect(wire).not.toContain(privateDevice); expect(wire).not.toContain(applicationSecret)
  services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  const stored = await readFile(join(original.root, 'enrollment-host', 'connections.sqlite'))
  expect(stored.includes(Buffer.from(privateDevice))).toBe(false)
  expect(stored.includes(Buffer.from(applicationSecret))).toBe(false)
  expect(calls.map(call => call.action)).toEqual(['begin', 'poll'])
  expect(await client.call('connection.enrollment.advance', { operationId: input.operationId })).toEqual(saved)
  expect(calls.map(call => call.action)).toEqual(['begin', 'poll'])
})

it('pending inspection remains passive and advancing respects the original platform interval', async () => {
  authorize = false
  const pending = await client.call('connection.enrollment.begin', input)
  expect(pending.authorization).toBe('pending')
  expect(await client.call('connection.enrollment.advance', { operationId: input.operationId })).toEqual(pending)
  expect(calls.map(call => call.action)).toEqual(['begin'])
  clock = pending.challenge!.nextPollAt + 1
  const later = await client.call('connection.enrollment.advance', { operationId: input.operationId })
  expect(later.authorization).toBe('pending')
  expect(later.challenge!.nextPollAt).toBeGreaterThan(clock)
  expect(later.revision).toBeGreaterThan(pending.revision)
  await client.call('connection.enrollment.inspect', { operationId: input.operationId })
  await client.call('connection.enrollment.ls', {})
  expect(calls.map(call => call.action)).toEqual(['begin', 'poll'])
  expect((await services.connections.list()).connections).toEqual([])
  expect(sdk.sockets).toEqual([])
})

it('unavailable encryption refuses only enrollment before any bootstrap effect and preserves manual configuration', async () => {
  secureAvailable = false
  const capabilities = await client.call('connection.enrollment.ls', {})
  expect(capabilities.capabilities).toContainEqual(expect.objectContaining({ adapterId: 'feishu', domain: input.domain, availability: 'unavailable', reason: 'secure-storage-unavailable' }))
  const attempted = await client.call('connection.enrollment.begin', input).then(value => ({ value }), error => ({ error }))
  expect(attempted).toMatchObject({ value: { authorization: 'not-started', credential: 'not-started', configuration: 'not-started', reason: 'secure-storage-unavailable' } })
  expect(calls).toEqual([])
  const manual = await client.call('connection.configure', { operationId: 'original-manual-configuration', expectedRevision: null, connection: { ...feishuConfig, enabled: false } })
  expect(manual.status).toBe('configured')
  expect(manual.connection.config).toEqual({ ...feishuConfig, enabled: false })
  expect((await client.call('connection.ls', {})).connections).toHaveLength(1)
})

it('the public SDK rejects an enrollment receipt for a different original operation', async () => {
  await client.call('connection.enrollment.begin', input)
  const enrollment = services.connections.enrollment!, inspect = enrollment.inspect.bind(enrollment)
  vi.spyOn(enrollment, 'inspect').mockImplementation(async requested => {
    const value = await inspect(requested)
    return { operation: value.operation ? { ...value.operation, operationId: 'different-original-operation' } : null }
  })
  const read = await client.call('connection.enrollment.inspect', { operationId: input.operationId }).then(value => ({ value }), error => ({ error }))
  expect(read, 'A response for another operation must never certify the requested enrollment').toHaveProperty('error')
})


it('an enrollment-only schema failure preserves existing connection administration and recovers on the same owner', async () => {
  const database = new DatabaseSync(':memory:')
  cleanup.push(() => database.close())
  const exec = database.exec.bind(database)
  let unavailable = true
  vi.spyOn(database, 'exec').mockImplementation(sql => {
    if (unavailable && sql.includes('CREATE TABLE IF NOT EXISTS connection_enrollment')) throw new Error('Private enrollment storage diagnostic')
    return exec(sql)
  })
  const opening = await Promise.resolve().then(() => new ConnectionHost({ database, secrets: { resolve: async () => null } })).then(value => ({ value }), error => ({ error }))
  expect(opening, 'An optional enrollment bookkeeping failure cannot close the original connection owner').toHaveProperty('value')
  if (!('value' in opening)) return
  const connections = opening.value
  cleanup.push(() => connections.close())
  const service = new AgentMuxControlServer({ socketPath: join(original.root, 'optional-enrollment.sock'), connections, coreClients: () => [] })
  await service.start(); cleanup.push(() => service.stop())
  const publicClient = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: service.path } })
  cleanup.push(() => publicClient.dispose())
  const manual = await publicClient.call('connection.configure', { operationId: 'existing-manual-save', expectedRevision: null, connection: { ...feishuConfig, enabled: false } })
  expect(manual.status).toBe('configured')
  const failed = await publicClient.call('connection.enrollment.ls', {}).then(value => ({ value }), error => ({ error }))
  expect(failed).toHaveProperty('error')
  expect(String('error' in failed ? failed.error : '')).not.toContain('Private enrollment storage diagnostic')
  expect((await publicClient.call('connection.ls', {})).connections).toEqual([manual.connection])
  unavailable = false
  expect((await publicClient.call('connection.enrollment.ls', {})).operations).toEqual([])
  expect((await publicClient.call('connection.ls', {})).connections).toEqual([manual.connection])
})
