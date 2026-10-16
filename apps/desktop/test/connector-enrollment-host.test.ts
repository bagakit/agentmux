import { DatabaseSync } from 'node:sqlite'
import { ConnectionHost } from '@agentmux/connectors'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type {
  ConnectionEnrollmentActionKind,
  ConnectionEnrollmentAdvanceInput,
  ConnectionEnrollmentBeginInput,
  ConnectionEnrollmentView
} from '@agentmux/core/connections'
import { createDesktopConnections } from '../src/main/connector-host.js'
import type { CredentialEncryption } from '../src/main/connector-secrets.js'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import {
  defaultFeishuSdkTransport,
  feishuConfig,
  feishuPayload
} from '../../../packages/connectors/test/fixtures/feishu.js'
import {
  objectCliEnvironment,
  runCompiledObjectCli
} from '../../../packages/core/test/helpers/object-cli-rpc.js'

const privateToken = 'private-enrollment-account-token'
const applicationSecret = 'private-enrolled-application-secret'
const pngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const input: ConnectionEnrollmentBeginInput = {
  operationId: 'original-enrollment',
  connectionId: 'enrolled-connection',
  adapterId: 'feishu',
  domain: 'open.feishu.cn',
  label: 'Team assistant',
  preset: { name: 'Team assistant', description: 'Original public profile', avatar: { pngDataUrl } }
}
const cleanup: Array<() => void | Promise<void>> = []
let original: Awaited<ReturnType<typeof ingressFixture>>
let services: Awaited<ReturnType<typeof createDesktopConnections>>
let server: AgentMuxControlServer
let client: Awaited<ReturnType<typeof connectAgentMuxRpc>>
let sdk: ReturnType<typeof defaultFeishuSdkTransport>
let calls: Array<{ url: string; path: string; preclaimed: boolean }>
let authorize: boolean
let clock: number
let secureAvailable: boolean

beforeEach(async () => {
  original = await ingressFixture(true, feishuConfig)
  cleanup.push(() => original.close())
  sdk = defaultFeishuSdkTransport()
  calls = []
  authorize = true
  secureAvailable = true
  clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const key = randomBytes(32)
  const encryption: CredentialEncryption = {
    isEncryptionAvailable: () => secureAvailable,
    encryptString(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(-16))
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8')
    }
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const target = new URL(String(url)),
        row = services
          .database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?')
          .get(input.operationId)
      const originalAttempt = row ? JSON.parse(String(row.record_json)).attemptId : null
      const claim = originalAttempt
        ? services
            .database!.prepare(
              'SELECT state,kind,operation_id FROM connection_enrollment_attempt WHERE attempt_id=?'
            )
            .get(originalAttempt)
        : null
      calls.push({
        url: target.href,
        path: target.pathname,
        preclaimed: claim?.state === 'claimed' && claim.operation_id === input.operationId
      })
      if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init')
        return Response.json(
          { code: 0, data: { step_info: { token: privateToken } } },
          {
            headers: {
              'x-flow-key': 'original-private-flow',
              'set-cookie': 'session=original-private-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly'
            }
          }
        )
      if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/polling')
        return Response.json({
          code: 0,
          data: authorize
            ? {
                next_step: 'enter_app',
                step_info: { cross_login_uri: 'https://accounts.feishu.cn/cross' }
              }
            : { next_step: null, step_info: { status: 1 } }
        })
      if (target.href === 'https://accounts.feishu.cn/cross')
        return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
      if (target.href === 'https://ask.feishu.cn/') return new Response('Landing is not an account identity')
      if (target.href === 'https://open.feishu.cn/app')
        return new Response(
          '<script>window.user={"id":"original-user","tenantId":"original-tenant"};window.csrfToken="original-private-csrf";</script>',
          { headers: { 'content-type': 'text/html' } }
        )
      if (target.pathname === '/developers/v1/app/upload/image')
        return Response.json({ code: 0, data: { url: 'https://images.example.test/original.png' } })
      if (target.pathname === '/developers/v1/manifest/upsert_by_template')
        return Response.json({ code: 0, data: { ClientID: feishuConfig.application.appId } })
      if (target.pathname === '/developers/v1/secret/' + feishuConfig.application.appId)
        return Response.json({ code: 0, data: { secret: applicationSecret } })
      throw new Error('Unexpected bootstrap network request')
    })
  )
  services = await createDesktopConnections({
    directory: join(original.root, 'enrollment-host'),
    encryption,
    bindings: {
      spatial: original.spatial,
      checkpoint: async (ref) => await original.client.conversationCheckpoint(ref)
    },
    ingress: { core: (hostId) => (hostId === 'local' ? original.client : undefined) }
  })
  cleanup.push(() => services.close())
  server = new AgentMuxControlServer({
    socketPath: join(original.root, 'enrollment.sock'),
    connections: services.connections,
    coreClients: original.coreClients
  })
  await server.start()
  cleanup.push(() => server.stop())
  client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => client.dispose())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
})
afterEach(async () => {
  const errors: unknown[] = []
  try {
    for (const close of cleanup.splice(0).reverse()) {
      try {
        await close()
      } catch (error) {
        errors.push(error)
      }
    }
  } finally {
    try {
      vi.restoreAllMocks()
    } catch (error) {
      errors.push(error)
    }
    try {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Enrollment host cleanup failed')
})
function decision(
  view: ConnectionEnrollmentView,
  kind: ConnectionEnrollmentActionKind
): ConnectionEnrollmentAdvanceInput {
  const offered = view.actions.filter((action) => action.kind === kind)
  expect(offered).toHaveLength(1)
  return {
    operationId: view.operation!.operationId,
    ownRevision: offered[0]!.ownRevision,
    decision: { actionId: offered[0]!.actionId, kind }
  }
}
async function cli(args: string[], value?: unknown): Promise<ConnectionEnrollmentView> {
  const result = await runCompiledObjectCli(
    ['--endpoint', 'unix:' + server.path, 'connection', 'enrollment', ...args],
    objectCliEnvironment(original.root),
    value === undefined ? '' : JSON.stringify(value)
  )
  expect(result.code, result.stdout + result.stderr).toBe(0)
  return JSON.parse(result.stdout).result
}
async function account(view: ConnectionEnrollmentView, throughCli = false) {
  for (let count = 0; count < 7 && view.operation?.authentication?.stage !== 'account'; count++) {
    clock = Math.max(clock, view.challenge?.nextPollAt ?? clock) + 1
    const advance = decision(view, 'continue-authentication')
    view = throughCli ? await cli(['advance', '--input', '-'], advance) : await client.call('connection.enrollment.advance', advance)
  }
  expect(view.operation?.authentication?.stage).toBe('account')
  return view
}

it('default Host creates through compiled CLI and the original SDK receiver without exposing private material', async () => {
  const initial = await client.call('connection.enrollment.ls', {})
  expect(initial.operations).toEqual([])
  expect(initial.capabilities).toContainEqual(
    expect.objectContaining({ adapterId: 'feishu', domain: input.domain, availability: 'available' })
  )
  expect(calls).toEqual([])
  const pending = await cli(['begin', '--input', '-'], input)
  expect(
    calls[0]?.preclaimed,
    'The original attempt must be durably claimed before the external request'
  ).toBe(true)
  expect(pending.operation).toMatchObject({
    operationId: input.operationId,
    authorization: 'not-started',
    credential: 'not-started',
    configuration: 'not-started',
    application: null,
    configured: null
  })
  expect(pending.challenge!.qrPayload).toContain(privateToken)
  expect((await client.call('connection.enrollment.begin', input)).operation).toEqual(pending.operation)
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(pending.operation)
  expect((await client.call('connection.enrollment.ls', {})).operations).toContainEqual(pending.operation)
  expect(calls).toHaveLength(1)
  expect((await services.connections.list()).connections).toEqual([])
  services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  expect(
    (await readFile(join(original.root, 'enrollment-host', 'connections.sqlite'))).includes(
      Buffer.from(privateToken)
    )
  ).toBe(false)
  const signedIn = await account(pending, true),
    beforeConfirm = calls.length
  const confirmed = await cli(['advance', '--input', '-'], decision(signedIn, 'confirm-account'))
  expect(calls).toHaveLength(beforeConfirm)
  const create = decision(confirmed, 'create'),
    saved = await cli(['advance', '--input', '-'], create)
  expect(calls.every((call) => call.preclaimed)).toBe(true)
  expect(saved.operation).toMatchObject({
    operationId: input.operationId,
    connectionId: input.connectionId,
    authorization: 'authorized',
    credential: 'stored',
    configuration: 'configured',
    application: feishuConfig.application
  })
  const record = (await client.call('connection.inspect', { connectionId: input.connectionId })).connection!
  expect(record.config).toMatchObject({
    connectionId: input.connectionId,
    adapterId: 'feishu',
    application: feishuConfig.application,
    label: input.label,
    enabled: true
  })
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  await sdk.receive(feishuPayload())
  expect(sdk.ack()).toEqual([{ code: 200 }])
  expect((await services.ingress!.list({ connectionId: input.connectionId })).ingresses).toEqual([
    expect.objectContaining({ externalMessageId: 'platform-message' })
  ])
  const readback = await client.call('connection.enrollment.inspect', { operationId: input.operationId })
  expect(readback.operation).toEqual(saved.operation)
  const wire = JSON.stringify({ initial, operation: saved.operation, record })
  expect(wire).not.toContain(privateToken)
  expect(wire).not.toContain(applicationSecret)
  services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  const stored = await readFile(join(original.root, 'enrollment-host', 'connections.sqlite'))
  expect(stored.includes(Buffer.from(privateToken))).toBe(false)
  expect(stored.includes(Buffer.from(applicationSecret))).toBe(false)
  const beforeDuplicate = calls.length
  expect((await client.call('connection.enrollment.advance', create)).operation).toEqual(saved.operation)
  expect(calls).toHaveLength(beforeDuplicate)
  expect(calls.map((call) => call.path)).not.toContain('/oauth/v1/app/registration')
})

it('pending inspection remains passive and advancing respects the original platform interval', async () => {
  authorize = false
  const pending = await client.call('connection.enrollment.begin', input)
  const early = await client.call(
    'connection.enrollment.advance',
    decision(pending, 'continue-authentication')
  )
  expect(early.operation?.authentication?.stage).toBe('waiting')
  expect(calls).toHaveLength(1)
  clock = pending.challenge!.nextPollAt + 1
  const later = await client.call('connection.enrollment.advance', decision(early, 'continue-authentication'))
  expect(later.operation?.authentication?.stage).toBe('waiting')
  expect(later.challenge!.nextPollAt).toBeGreaterThan(clock)
  expect(later.operation!.revision).toBeGreaterThan(pending.operation!.revision)
  await client.call('connection.enrollment.inspect', { operationId: input.operationId })
  await client.call('connection.enrollment.ls', {})
  expect(calls.map((call) => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling'])
  expect((await services.connections.list()).connections).toEqual([])
  expect(sdk.sockets).toEqual([])
})

it('unavailable encryption refuses only enrollment before any bootstrap effect and preserves manual configuration', async () => {
  secureAvailable = false
  const capabilities = await client.call('connection.enrollment.ls', {})
  expect(capabilities.capabilities).toContainEqual(
    expect.objectContaining({
      adapterId: 'feishu',
      domain: input.domain,
      availability: 'available'
    })
  )
  const attempted = await client.call('connection.enrollment.begin', input)
  expect(attempted.operation).toMatchObject({
    authorization: 'not-started',
    credential: 'not-started',
    configuration: 'not-started',
    diagnostic: { stage: 'secure-storage', code: 'asset-unconfirmed' }
  })
  expect(calls).toEqual([])
  const manual = await client.call('connection.configure', {
    operationId: 'original-manual-configuration',
    expectedRevision: null,
    connection: { ...feishuConfig, enabled: false }
  })
  expect(manual.status).toBe('configured')
  expect(manual.connection.config).toEqual({ ...feishuConfig, enabled: false })
  expect((await client.call('connection.ls', {})).connections).toHaveLength(1)
})

it('the public SDK rejects an enrollment receipt for a different original operation', async () => {
  await client.call('connection.enrollment.begin', input)
  const enrollment = services.connections.enrollment!,
    inspect = enrollment.inspect.bind(enrollment)
  vi.spyOn(enrollment, 'inspect').mockImplementation(async (requested, context) => {
    const value = await inspect(requested, context)
    return {
      ...value,
      operation: value.operation ? { ...value.operation, operationId: 'different-original-operation' } : null
    }
  })
  const read = await client.call('connection.enrollment.inspect', { operationId: input.operationId }).then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  expect(read, 'A response for another operation must never certify the requested enrollment').toHaveProperty(
    'error'
  )
})

it('an enrollment-only schema failure preserves existing connection administration and recovers on the same owner', async () => {
  const database = new DatabaseSync(':memory:')
  cleanup.push(() => database.close())
  const exec = database.exec.bind(database)
  let unavailable = true
  vi.spyOn(database, 'exec').mockImplementation((sql) => {
    if (unavailable && sql.includes('CREATE TABLE IF NOT EXISTS connection_enrollment'))
      throw new Error('Private enrollment storage diagnostic')
    return exec(sql)
  })
  const opening = await Promise.resolve()
    .then(() => new ConnectionHost({ database, secrets: { resolve: async () => null } }))
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    )
  expect(opening).toHaveProperty('value')
  const host = 'value' in opening ? opening.value! : null!
  cleanup.push(() => host.close())
  const manual = await host.configure({
    operationId: 'unaffected-manual-configuration',
    expectedRevision: null,
    connection: { ...feishuConfig, enabled: false }
  })
  const publicServer = new AgentMuxControlServer({
    socketPath: join(original.root, 'isolated-enrollment.sock'),
    connections: host
  })
  await publicServer.start()
  cleanup.push(() => publicServer.stop())
  const publicClient = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: publicServer.path } })
  cleanup.push(() => publicClient.dispose())
  const blocked = await publicClient.call('connection.enrollment.ls', {}).then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  expect(blocked).toHaveProperty('error')
  expect(JSON.stringify(blocked)).not.toContain('Private enrollment storage diagnostic')
  expect((await publicClient.call('connection.ls', {})).connections).toEqual([manual.connection])
  unavailable = false
  expect((await publicClient.call('connection.enrollment.ls', {})).operations).toEqual([])
  expect((await publicClient.call('connection.ls', {})).connections).toEqual([manual.connection])
})
