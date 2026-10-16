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
let pollReply: (() => Response) | undefined
let authorize: boolean
let clock: number
let secureAvailable: boolean
let rejectedCookieStage: 'initialize' | 'console' | 'creation' | null
let sentCookies: Array<{ path: string; cookie: string }>

function cookies(stage: 'initialize' | 'console' | 'creation', initial?: HeadersInit): Headers {
  const headers = new Headers(initial)
  if (rejectedCookieStage === stage) {
    headers.append('set-cookie', 'foreign=discard; Domain=unrelated.invalid; Path=/; Secure')
    headers.append('set-cookie', 'invalid-cookie')
    headers.append('set-cookie', 'continued=valid-' + stage + '; Path=/; Secure; HttpOnly')
  }
  return headers
}

beforeEach(async () => {
  original = await ingressFixture(true, feishuConfig)
  cleanup.push(() => original.close())
  sdk = defaultFeishuSdkTransport()
  calls = []
  authorize = true
  pollReply = undefined
  secureAvailable = true
  rejectedCookieStage = null
  sentCookies = []
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
    vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
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
      sentCookies.push({ path: target.pathname, cookie: new Headers(options?.headers).get('cookie') ?? '' })
      calls.push({
        url: target.href,
        path: target.pathname,
        preclaimed: claim?.state === 'claimed' && claim.operation_id === input.operationId
      })
      if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/init')
        return Response.json(
          { code: 0, data: { step_info: { token: privateToken } } },
          {
            headers: cookies('initialize', {
              'x-flow-key': 'original-private-flow',
              'set-cookie': 'session=original-private-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly'
            })
          }
        )
      if (target.origin === 'https://accounts.feishu.cn' && target.pathname === '/accounts/qrlogin/polling' && pollReply) return pollReply()
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
      if (target.href === 'https://ask.feishu.cn/cross') return new Response('Cross-login is not account authority')
      if (target.href === 'https://accounts.feishu.cn/cross')
        return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
      if (target.href === 'https://ask.feishu.cn/') return new Response('Landing is not an account identity')
      if (target.href === 'https://open.feishu.cn/app')
        return new Response(
          '<script>window.user={"id":"original-user","tenantId":"original-tenant"};window.csrfToken="original-private-csrf";</script>',
          { headers: cookies('console', { 'content-type': 'text/html' }) }
        )
      if (target.pathname === '/developers/v1/app/upload/image')
        return Response.json({ code: 0, data: { url: 'https://images.example.test/original.png' } })
      if (target.pathname === '/developers/v1/manifest/upsert_by_template')
        return Response.json({ code: 0, data: { ClientID: feishuConfig.application.appId } }, { headers: cookies('creation') })
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

it.each(['initialize', 'console', 'creation'] as const)('preserves the original application after rejected %s cookies', async stage => {
  rejectedCookieStage = stage
  const signedIn = await account(await client.call('connection.enrollment.begin', input), true)
  expect(signedIn.account).toMatchObject({ userId: 'original-user', tenantId: 'original-tenant' })
  const confirmed = await cli(['advance', '--input', '-'], decision(signedIn, 'confirm-account'))
  const create = decision(confirmed, 'create')
  const saved = await cli(['advance', '--input', '-'], create)
  expect(saved.operation).toMatchObject({ application: feishuConfig.application, configuration: 'configured', credential: 'stored' })
  const continuedRequest = stage === 'initialize' ? '/accounts/qrlogin/polling' : '/developers/v1/secret/' + feishuConfig.application.appId
  expect(sentCookies.find(call => call.path === continuedRequest)?.cookie).toContain('continued=valid-' + stage)
  expect(sentCookies.every(call => !call.cookie.includes('foreign=') && !call.cookie.includes('invalid-cookie'))).toBe(true)
  const beforeReadback = calls.length
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(saved.operation)
  expect((await cli(['advance', '--input', '-'], create)).operation).toEqual(saved.operation)
  expect(calls).toHaveLength(beforeReadback)
  expect(calls.filter(call => call.path === '/developers/v1/manifest/upsert_by_template')).toHaveLength(1)
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


it.each([
  ['missing-cross', {}], ['null-cross', { cross_login_uri: null }],
  ['direct-landing', { cross_login_uri: 'https://ask.feishu.cn/cross' }],
  ['accounts-handoff', { cross_login_uri: 'https://accounts.feishu.cn/cross' }],
  ['missing-step', undefined], ['null-step', null],
  ['empty-cross-local-only', { mode: 'dual_domain_sync', cross_login_uri: '', local_login_uri: 'https://unqualified.invalid/not-authorized' }],
  ['array-step', []]
] as const)('follows original native handoff %s through Host, SDK and compiled CLI before account consent', async (name, info) => {
  pollReply = () => Response.json({ code: 0, data: { next_step: 'enter_app', step_info: info } })
  const pending = await client.call('connection.enrollment.begin', input)
  clock = pending.challenge!.nextPollAt + 1
  const next = await cli(['advance', '--input', '-'], decision(pending, 'continue-authentication'))
  expect(next.operation!.authentication!.stage).toBe('handoff')
  expect(next.account).toBeNull()
  expect(calls.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling'])
  const handoffSteps = name === 'accounts-handoff' ? ['/cross', '/', '/', '/app']
    : name === 'direct-landing' ? ['/cross', '/', '/app'] : ['/', '/app']
  let signedIn = next
  for (const path of handoffSteps) {
    const before = calls.length
    signedIn = await cli(['advance', '--input', '-'], decision(signedIn, 'continue-authentication'))
    expect(calls).toHaveLength(before + 1)
    expect(calls.at(-1)!.path).toBe(path)
    expect(signedIn.operation!.authentication!.stage).toBe(path === '/app' ? 'account' : 'handoff')
    if (path !== '/app') expect(signedIn.account).toBeNull()
    expect(signedIn.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
  }
  expect(signedIn.account).toMatchObject({ userId: 'original-user', tenantId: 'original-tenant' })
  expect(signedIn.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
  expect(calls.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', ...handoffSteps])
  expect(calls.filter(call => call.path === '/accounts/qrlogin/polling')).toHaveLength(1)
  expect(calls.some(call => call.url.startsWith('https://unqualified.invalid/'))).toBe(false)
  expect(signedIn.actions.map(action => action.kind)).toContain('confirm-account')
  expect((await client.call('connection.enrollment.inspect', { operationId: input.operationId })).operation).toEqual(signedIn.operation)
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(signedIn.operation)
})

it.each([
  ['json', 'invalid-response', () => new Response('not-json', { status: 200 })],
  ['transition', 'invalid-response', () => Response.json({ code: 0, data: { next_step: 'unrecognized-native-step', step_info: {} } })],
  ['handoff', 'redirect-unconfirmed', () => Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { cross_login_uri: 'https://foreign.example/private-token' } } })]
] as const)('preserves the actual %s failure boundary through the original public owner and CLI without replay', async (boundary, failure, response) => {
  pollReply = response
  const pending = await client.call('connection.enrollment.begin', input)
  clock = pending.challenge!.nextPollAt + 1
  const advance = decision(pending, 'continue-authentication')
  const unknown = await client.call('connection.enrollment.advance', advance)
  expect(unknown.operation!.diagnostic).toMatchObject({ stage: 'authentication', step: 'poll', failure, httpStatus: 200, boundary })
  expect(calls.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling'])
  const count = calls.length
  const observed = await cli(['inspect', '--operation-id', input.operationId])
  expect(observed.operation).toEqual(unknown.operation)
  expect((await client.call('connection.enrollment.advance', advance)).operation).toEqual(unknown.operation)
  expect(calls).toHaveLength(count)
  expect(observed.actions.map(action => action.kind)).not.toContain('continue-authentication')
  expect(JSON.stringify(observed)).not.toContain('private-token')
  expect(observed.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
})

it('continues native zero waiting through Host, SDK and compiled CLI to the original account', async () => {
  const replies = [
    () => Response.json({ code: 0, data: { next_step: 'qr_login_polling', step_info: { status: 0 } } }, {
      headers: { 'set-cookie': 'continued-zero=original-observation; Domain=.feishu.cn; Path=/; Secure; HttpOnly' }
    }),
    () => Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { cross_login_uri: '' } } })
  ]
  pollReply = () => {
    const reply = replies.shift()
    expect(reply).toBeDefined()
    return reply!()
  }
  const pending = await client.call('connection.enrollment.begin', input)
  const originalAttempt = pending.operation!.authentication!.attemptId
  clock = pending.challenge!.nextPollAt + 1
  const zeroInput = decision(pending, 'continue-authentication')
  const waiting = await cli(['advance', '--input', '-'], zeroInput)
  expect(waiting.operation!.operationId).toBe(input.operationId)
  expect(waiting.operation!.authentication).toEqual({ attemptId: originalAttempt, stage: 'waiting' })
  expect(waiting.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
  expect(waiting.account).toBeNull()
  expect(waiting.challenge).toEqual({ ...pending.challenge, nextPollAt: clock + 1500 })
  expect(waiting.receipt!.state).toBe('confirmed')
  expect(waiting.actions.map(action => action.kind)).toEqual(['recover-local', 'continue-authentication'])
  expect(calls.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling'])
  const repeated = await client.call('connection.enrollment.advance', zeroInput)
  expect(repeated.receipt).toEqual(waiting.receipt)
  expect(repeated.challenge).toEqual(waiting.challenge)
  expect(calls).toHaveLength(2)

  clock = waiting.challenge!.nextPollAt - 1
  const earlyInput = decision(waiting, 'continue-authentication')
  expect(earlyInput.decision.actionId).not.toBe(zeroInput.decision.actionId)
  const early = await client.call('connection.enrollment.advance', earlyInput)
  expect(early.operation!.authentication).toEqual({ attemptId: originalAttempt, stage: 'waiting' })
  expect(early.account).toBeNull()
  expect(early.challenge).toEqual(waiting.challenge)
  expect(early.receipt!.state).toBe('confirmed')
  expect(calls).toHaveLength(2)

  clock = waiting.challenge!.nextPollAt
  const nextInput = decision(early, 'continue-authentication')
  expect(nextInput.decision.actionId).not.toBe(earlyInput.decision.actionId)
  const handoff = await cli(['advance', '--input', '-'], nextInput)
  expect(handoff.operation!.authentication).toEqual({ attemptId: originalAttempt, stage: 'handoff' })
  expect(handoff.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
  expect(handoff.challenge).toBeNull()
  expect(handoff.account).toBeNull()
  expect(calls.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/accounts/qrlogin/polling'])
  expect(sentCookies.filter(call => call.path === '/accounts/qrlogin/polling')[1]!.cookie).toContain('continued-zero=original-observation')
  let signedIn = handoff
  for (const path of ['/', '/app']) {
    const before = calls.length
    signedIn = await cli(['advance', '--input', '-'], decision(signedIn, 'continue-authentication'))
    expect(calls).toHaveLength(before + 1)
    expect(calls.at(-1)!.path).toBe(path)
    expect(signedIn.operation!.authentication!.stage).toBe(path === '/app' ? 'account' : 'handoff')
    if (path !== '/app') expect(signedIn.account).toBeNull()
    expect(signedIn.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
  }
  expect(signedIn.account).toMatchObject({ userId: 'original-user', tenantId: 'original-tenant' })
  expect(signedIn.actions.map(action => action.kind)).toContain('confirm-account')
  expect(calls.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/accounts/qrlogin/polling', '/', '/app'])
  expect(calls.every(call => call.preclaimed)).toBe(true)
  expect(replies).toHaveLength(0)
  expect((await client.call('connection.enrollment.inspect', { operationId: input.operationId })).operation).toEqual(signedIn.operation)
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(signedIn.operation)
  expect(calls).toHaveLength(5)
})
