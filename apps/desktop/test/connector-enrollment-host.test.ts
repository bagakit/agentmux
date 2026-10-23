import { DatabaseSync } from 'node:sqlite'
import { ConnectionHost } from '@agentmux/connectors'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type {
  ConnectionEnrollmentActionKind,
  ConnectionEnrollmentAdvanceInput,
  ConnectionEnrollmentBeginInput,
  ConnectionEnrollmentView,
  ConnectionSetupView
} from '@agentmux/core/connections'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { assertPrivateCredentialFiles, privateCredentialValues } from '../../../packages/connectors/test/fixtures/connection-enrollment.js'
import { AgentMuxError } from '@agentmux/core'
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
const originalConsoleScript = 'window.user={"id":"original-user","tenantId":"original-tenant"};window.csrfToken="original-private-csrf";'
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
let services: Awaited<ReturnType<typeof createConnectionServices>>
let server: AgentMuxControlServer
let client: Awaited<ReturnType<typeof connectAgentMuxRpc>>
let sdk: ReturnType<typeof defaultFeishuSdkTransport>
let calls: Array<{ url: string; path: string; preclaimed: boolean; cookie: string; referer: string | null; origin: string | null; csrf: string | null; method?: string; attemptId: string | null; stepKind: string | null }>
let pollReply: (() => Response) | undefined
let authorize: boolean
let clock: number
let privateAvailable: boolean
let rejectedCookieStage: 'initialize' | 'console' | 'creation' | null
let sentCookies: Array<{ path: string; cookie: string }>
let consoleDocument: string
let consoleResponses: Map<string, () => Response>

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
  privateAvailable = true
  rejectedCookieStage = null
  sentCookies = []
  consoleDocument = `<script>${originalConsoleScript}</script>`
  consoleResponses = new Map()
  clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const available = ConnectionSecrets.prototype.assertAvailable
  vi.spyOn(ConnectionSecrets.prototype, 'assertAvailable').mockImplementation(async function () {
    if (!privateAvailable) throw new AgentMuxError('Original private credential storage unavailable.', 'CONNECTION_CREDENTIAL_UNAVAILABLE')
    await available.call(this)
  })
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
      const headers = new Headers(options?.headers)
      sentCookies.push({ path: target.pathname, cookie: headers.get('cookie') ?? '' })
      calls.push({
        url: target.href,
        path: target.pathname,
        preclaimed: claim?.state === 'claimed' && claim.operation_id === input.operationId,
        cookie: headers.get('cookie') ?? '',
        referer: headers.get('referer'),
        origin: headers.get('origin'),
        csrf: headers.get('x-csrf-token'),
        method: options?.method,
        attemptId: originalAttempt,
        stepKind: claim ? String(claim.kind) : null
      })
      const consoleResponse = consoleResponses.get(target.href)
      if (consoleResponse) return consoleResponse()
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
          consoleDocument,
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
  services = await createConnectionServices({
    directory: join(original.root, 'enrollment-host'),
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
  await assertPrivateCredentialFiles(join(original.root, 'enrollment-host'))
  expect((await privateCredentialValues(services.database!)).some(value => value.includes(privateToken))).toBe(true)
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
  await assertPrivateCredentialFiles(join(original.root, 'enrollment-host'))
  const privateValues = await privateCredentialValues(services.database!)
  for (const value of [privateToken, applicationSecret]) expect(privateValues.some(original => original.includes(value))).toBe(true)
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

it('unavailable private storage refuses only enrollment before any bootstrap effect and preserves manual configuration', async () => {
  privateAvailable = false
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

it('follows the original Console callback and issuer chain through SDK and compiled CLI before account confirmation', async () => {
  const targets = [
    'https://open.feishu.cn/app',
    'https://open.feishu.cn/auth/callback?ticket=private-console-ticket',
    'https://accounts.feishu.cn/console-login?ticket=private-account-ticket',
    'https://ask.feishu.cn/console-handoff?ticket=private-landing-ticket',
    'https://open.larkoffice.com/console-callback?ticket=private-alternate-ticket',
    'https://open.feishu.cn/console/profile?ticket=private-final-ticket'
  ]
  const statuses = [302, 303, 307, 308, 301]
  for (const [index, target] of targets.slice(0, -1).entries()) {
    consoleResponses.set(target, () => new Response('', { status: statuses[index], headers: {
      location: targets[index + 1] + (index === 0 || index === 4 ? '#private-client-fragment' : ''),
      ...(index === 0 ? { 'set-cookie': 'console-host=private-host-cookie; Path=/; Secure; HttpOnly' } : {})
    } }))
  }
  consoleResponses.set(targets.at(-1)!, () => new Response(consoleDocument, { headers: { 'content-type': 'text/html' } }))
  const pending = await client.call('connection.enrollment.begin', input)
  const attemptId = pending.operation!.authentication!.attemptId
  clock = pending.challenge!.nextPollAt + 1
  let view = pending
  const expected = ['/accounts/qrlogin/polling', '/cross', '/', '/', ...targets.map(target => new URL(target).pathname)]
  for (const [index, path] of expected.entries()) {
    const advance = decision(view, 'continue-authentication'), before = calls.length
    view = await cli(['advance', '--input', '-'], advance)
    expect(calls).toHaveLength(before + 1)
    expect(calls.at(-1)!.path).toBe(path)
    expect(view.operation!.authentication!.attemptId).toBe(attemptId)
    expect(view.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
    expect(view.operation!.authentication!.stage).toBe(index === expected.length - 1 ? 'account' : 'handoff')
    if (index < expected.length - 1) {
      expect(view.account).toBeNull()
      expect(view.actions.map(action => action.kind)).not.toContain('confirm-account')
    }
    expect(view.actions.map(action => action.kind)).not.toContain('create')
    if (path === '/app') {
      expect((await client.call('connection.enrollment.advance', advance)).operation).toEqual(view.operation)
      expect(calls).toHaveLength(before + 1)
    }
  }
  expect(calls.slice(-targets.length).map(call => call.url)).toEqual(targets)
  expect(calls.slice(-targets.length).map(call => call.referer)).toEqual(['https://ask.feishu.cn/', ...targets.slice(0, -1)])
  expect(calls.slice(-targets.length).every(call => !call.url.includes('#'))).toBe(true)
  expect(calls.find(call => call.path === '/auth/callback')!.cookie).toContain('console-host=private-host-cookie')
  expect(calls.find(call => call.path === '/console-login')!.cookie).not.toContain('console-host=')
  expect(calls.find(call => call.path === '/console-callback')!.cookie).not.toContain('session=')
  expect(calls.at(-1)!.cookie).toContain('console-host=private-host-cookie')
  expect(view.account).toMatchObject({ userId: 'original-user', tenantId: 'original-tenant' })
  const before = calls.length
  expect((await client.call('connection.enrollment.inspect', { operationId: input.operationId })).operation).toEqual(view.operation)
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(view.operation)
  const confirmed = await client.call('connection.enrollment.advance', decision(view, 'confirm-account'))
  expect(calls).toHaveLength(before)
  expect(confirmed.actions.map(action => action.kind)).toContain('create')
  expect(confirmed.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
  const wire = JSON.stringify({ view, confirmed })
  for (const value of ['private-console-ticket', 'private-account-ticket', 'private-landing-ticket', 'private-alternate-ticket', 'private-final-ticket', 'private-client-fragment', 'private-host-cookie']) expect(wire).not.toContain(value)
})

it.each([
  ['unexpected-host', 'https://unqualified.invalid/private-account?token=private-redirect-token#private-fragment'],
  ['missing-location', null]
] as const)('preserves the exact safe Console %s reason through SDK and compiled CLI without replay', async (redirectReason, location) => {
  consoleResponses.set('https://open.feishu.cn/app', () => new Response('private-redirect-body', { status: 302, ...(location ? { headers: { location } } : {}) }))
  const pending = await client.call('connection.enrollment.begin', input)
  clock = pending.challenge!.nextPollAt + 1
  let view = pending
  for (const path of ['/accounts/qrlogin/polling', '/cross', '/', '/']) {
    const before = calls.length
    view = await cli(['advance', '--input', '-'], decision(view, 'continue-authentication'))
    expect(calls).toHaveLength(before + 1)
    expect(calls.at(-1)!.path).toBe(path)
    expect(view.operation!.authentication!.stage).toBe('handoff')
  }
  const advance = decision(view, 'continue-authentication'), before = calls.length
  const unknown = await client.call('connection.enrollment.advance', advance)
  expect(calls).toHaveLength(before + 1)
  expect(calls.at(-1)!.url).toBe('https://open.feishu.cn/app')
  expect(unknown.operation!.diagnostic).toEqual({ stage: 'authentication', code: 'native-unconfirmed', step: 'console', failure: 'redirect-unconfirmed', boundary: 'handoff', httpStatus: 302, redirectReason })
  expect(unknown.operation!.authentication).toMatchObject({ attemptId: pending.operation!.authentication!.attemptId, stage: 'unknown' })
  expect(unknown.account).toBeNull()
  expect(unknown.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
  for (const kind of ['continue-authentication', 'confirm-account', 'create']) expect(unknown.actions.map(action => action.kind)).not.toContain(kind)
  const observed = await cli(['inspect', '--operation-id', input.operationId])
  expect(observed.operation).toEqual(unknown.operation)
  expect((await client.call('connection.enrollment.inspect', { operationId: input.operationId })).operation).toEqual(unknown.operation)
  expect((await client.call('connection.enrollment.advance', advance)).operation).toEqual(unknown.operation)
  expect((await cli(['advance', '--input', '-'], advance)).operation).toEqual(unknown.operation)
  expect(calls).toHaveLength(before + 1)
  const wire = JSON.stringify({ unknown, observed })
  for (const value of ['unqualified.invalid', 'private-account', 'private-redirect-token', 'private-fragment', 'private-redirect-body']) expect(wire).not.toContain(value)
})

it('creates and configures the original bot from its final alternate Console through public SDK and compiled CLI', async () => {
  const origin = 'https://open.larkoffice.com', finalDocument = origin + '/console/profile?ticket=private-alternate-login'
  const appId = feishuConfig.application.appId, readPath = '/developers/v1/robot/' + appId
  let enabled = false
  consoleResponses.set('https://open.feishu.cn/app', () => new Response('', { status: 302, headers: { location: finalDocument } }))
  consoleResponses.set(finalDocument, () => new Response(consoleDocument, { headers: { 'content-type': 'text/html', 'set-cookie': 'alternate-session=private-alternate-cookie; Path=/; Secure; HttpOnly' } }))
  consoleResponses.set(origin + '/developers/v1/app/upload/image', () => Response.json({ code: 0, data: { url: 'https://images.example.test/alternate.png' } }, { headers: { 'set-cookie': 'alternate-continuation=private-continued-cookie; Path=/; Secure; HttpOnly' } }))
  consoleResponses.set(origin + '/developers/v1/manifest/upsert_by_template', () => Response.json({ code: 0, data: { ClientID: appId } }))
  consoleResponses.set(origin + '/developers/v1/secret/' + appId, () => Response.json({ code: 0, data: { secret: applicationSecret } }))
  consoleResponses.set(origin + readPath, () => Response.json({ code: 0, data: { enable: enabled } }))
  consoleResponses.set(origin + '/developers/v1/robot/switch/' + appId, () => { enabled = true; return Response.json({ code: 0, data: {} }) })
  const pending = await client.call('connection.enrollment.begin', input), signedIn = await account(pending, true)
  expect(signedIn.operation!.authentication!.attemptId).toBe(pending.operation!.authentication!.attemptId)
  expect(signedIn.account).toMatchObject({ userId: 'original-user', tenantId: 'original-tenant' })
  expect(signedIn.actions.map(action => action.kind)).not.toContain('create')
  const beforeConfirm = calls.length
  const confirmed = await client.call('connection.enrollment.advance', decision(signedIn, 'confirm-account'))
  expect(calls).toHaveLength(beforeConfirm)
  const create = decision(confirmed, 'create'), saved = await cli(['advance', '--input', '-'], create)
  expect(saved.operation).toMatchObject({ operationId: input.operationId, connectionId: input.connectionId, application: feishuConfig.application, authorization: 'authorized', credential: 'stored', configuration: 'configured', creation: { upload: 'confirmed', create: 'confirmed' } })
  const creation = calls.slice(beforeConfirm)
  expect(creation.map(call => call.path)).toEqual(['/developers/v1/app/upload/image', '/developers/v1/manifest/upsert_by_template', '/developers/v1/secret/' + appId])
  expect(creation.map(call => call.stepKind)).toEqual(['upload', 'create', 'credential'])
  expect(new Set(creation.map(call => call.attemptId)).size).toBe(3)
  expect(creation.every(call => call.preclaimed && call.referer === finalDocument)).toBe(true)
  const record = (await client.call('connection.inspect', { connectionId: input.connectionId })).connection!
  expect(record.config.application).toEqual(feishuConfig.application)
  const credential = services.database!.prepare('SELECT ciphertext FROM connection_credential WHERE credential_ref=?').get(record.config.credentialRef)
  expect(credential?.ciphertext).toBeInstanceOf(Uint8Array)
  expect(Buffer.from(credential!.ciphertext as Uint8Array).equals(Buffer.from('amux.connection-credential.raw.v1\0' + applicationSecret))).toBe(true)
  expect(await new ConnectionSecrets(services.database!).resolve(record.config.credentialRef)).toBe(applicationSecret)
  await assertPrivateCredentialFiles(join(original.root, 'enrollment-host'))
  const beforeAdoption = calls.length
  expect((await client.call('connection.enrollment.advance', create)).operation).toEqual(saved.operation)
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(saved.operation)
  expect(calls).toHaveLength(beforeAdoption)
  const setupInput = { operationId: 'alternate-origin-management', connectionId: input.connectionId, expectedConnectionRevision: record.revision, goal: { kind: 'agent-conversation', interaction: 'messages' }, source: { kind: 'enrollment', operationId: input.operationId, expectedRevision: saved.operation!.revision } } as const
  const setupCli = async (args: string[], body?: unknown): Promise<ConnectionSetupView> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'setup', ...args], objectCliEnvironment(original.root), body === undefined ? '' : JSON.stringify(body))
    expect(result.code, result.stdout + result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const adopted = await client.call('connection.setup.begin', setupInput)
  expect(adopted.operation).toMatchObject({ ...setupInput, application: feishuConfig.application, request: { kind: 'enrollment-handoff', state: 'confirmed' }, secureStorage: 'stored' })
  expect(adopted.continuation).toMatchObject({ stage: 'account', account: signedIn.account })
  expect(adopted.challenge).toBeNull()
  expect((await setupCli(['begin', '--input', '-'], setupInput)).operation).toEqual(adopted.operation)
  const confirmAccount = adopted.continuation!.actions.find(action => action.kind === 'confirm-account')!
  expect(confirmAccount).toBeDefined()
  const setupConfirmed = await setupCli(['advance', '--input', '-'], { operationId: setupInput.operationId, expectedRevision: confirmAccount.expectedRevision, decision: { actionId: confirmAccount.actionId, value: 'confirm' } })
  expect(setupConfirmed.continuation!.stage).toBe('confirmed')
  expect(calls).toHaveLength(beforeAdoption)
  const inspection = await client.call('connection.setup.inspect', { operationId: setupInput.operationId, applicationInspection: {} })
  const read = inspection.applicationInspection!.actions.find(action => action.kind === 'read-bot-settings')!
  expect(read).toBeDefined()
  const observed = await setupCli(['advance', '--input', '-'], { operationId: setupInput.operationId, expectedRevision: read.expectedRevision, decision: { actionId: read.actionId, value: 'continue' } })
  expect(calls).toHaveLength(beforeAdoption + 1)
  expect(observed.applicationInspection!.selected).toMatchObject({ subject: 'bot-settings', request: 'confirmed', secureStorage: 'stored' })
  const offered = await client.call('connection.setup.inspect', { operationId: setupInput.operationId, applicationConfiguration: { effect: 'enable-messaging' } })
  expect(offered.applicationConfiguration!.capability).toBe('disabled')
  const enable = offered.applicationConfiguration!.actions.find(action => action.kind === 'enable-messaging')!
  expect(enable).toBeDefined()
  const enableInput = { operationId: setupInput.operationId, expectedRevision: enable.expectedRevision, decision: { actionId: enable.actionId, value: 'confirm' } } as const
  const accepted = await client.call('connection.setup.advance', enableInput)
  expect(calls).toHaveLength(beforeAdoption + 2)
  expect(accepted.applicationConfiguration!.selected).toMatchObject({ effect: 'enable-messaging', request: 'confirmed', secureStorage: 'stored' })
  expect(accepted.applicationConfiguration!.capability).not.toBe('enabled')
  expect((await setupCli(['advance', '--input', '-'], enableInput)).receipt).toEqual(accepted.receipt)
  expect(calls).toHaveLength(beforeAdoption + 2)
  const latest = await client.call('connection.setup.inspect', { operationId: setupInput.operationId, applicationInspection: {} })
  const readBack = latest.applicationInspection!.actions.find(action => action.kind === 'read-bot-settings')!
  const readAgain = await client.call('connection.setup.advance', { operationId: setupInput.operationId, expectedRevision: readBack.expectedRevision, decision: { actionId: readBack.actionId, value: 'continue' } })
  expect(readAgain.applicationInspection!.selected).toMatchObject({ request: 'confirmed', secureStorage: 'stored' })
  expect(calls).toHaveLength(beforeAdoption + 3)
  const configured = await setupCli(['inspect', '--operation-id', setupInput.operationId, '--application-configuration', 'enable-messaging'])
  expect(configured.applicationConfiguration!.capability).toBe('enabled')
  const business = calls.slice(beforeConfirm)
  expect(business.map(call => call.path)).toEqual([...creation.map(call => call.path), readPath, '/developers/v1/robot/switch/' + appId, readPath])
  expect(business.every(call => call.method === 'POST' && new URL(call.url).origin === origin && call.origin === origin && call.csrf === 'original-private-csrf')).toBe(true)
  expect(business.every(call => call.cookie.includes('alternate-session=private-alternate-cookie') && !call.cookie.includes('session=original-private-cookie'))).toBe(true)
  expect(business.slice(1).every(call => call.cookie.includes('alternate-continuation=private-continued-cookie'))).toBe(true)
  expect(calls.slice(beforeAdoption).every(call => call.referer === origin + '/app/' + appId)).toBe(true)
  expect((await client.call('connection.enrollment.inspect', { operationId: input.operationId })).operation).toEqual(saved.operation)
  expect(calls).toHaveLength(beforeAdoption + 3)
  const wire = JSON.stringify({ saved, record, adopted, accepted, configured })
  for (const value of [applicationSecret, 'private-alternate-login', 'private-alternate-cookie', 'private-continued-cookie', 'original-private-csrf']) expect(wire).not.toContain(value)
  services.database!.exec('PRAGMA wal_checkpoint(FULL)')
  await assertPrivateCredentialFiles(join(original.root, 'enrollment-host'))
  const privateValues = await privateCredentialValues(services.database!)
  for (const value of [applicationSecret, 'private-alternate-cookie', 'private-continued-cookie', 'original-private-csrf']) expect(privateValues.some(original => original.includes(value))).toBe(true)
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

it.each([
  ['declaration', `<script>var pageVersion=1;${originalConsoleScript}</script>`],
  ['nonliteral-metadata', `<script>"use strict";(function(){"use strict";${originalConsoleScript}window.runtimeMetadata=readRuntimeMetadata();})();</script>`]
] as const)('reads authoritative bootstrap fields with unrelated %s through Host, SDK and compiled CLI', async (_name, html) => {
  consoleDocument = html
  pollReply = () => Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { cross_login_uri: '' } } })
  let view = await client.call('connection.enrollment.begin', input)
  const originalAttempt = view.operation!.authentication!.attemptId
  let lastInput: ConnectionEnrollmentAdvanceInput | undefined
  for (const path of ['/accounts/qrlogin/polling', '/', '/app']) {
    clock = Math.max(clock, view.challenge?.nextPollAt ?? clock) + 1
    lastInput = decision(view, 'continue-authentication')
    const before = calls.length
    view = await cli(['advance', '--input', '-'], lastInput)
    expect(calls).toHaveLength(before + 1)
    expect(calls.at(-1)!.path).toBe(path)
    expect(view.operation!.authentication).toEqual({ attemptId: originalAttempt, stage: path === '/app' ? 'account' : 'handoff' })
    if (path !== '/app') expect(view.account).toBeNull()
    expect(view.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
  }
  expect(view.operation).toMatchObject({ operationId: input.operationId, connectionId: input.connectionId, label: input.label, preset: { name: input.preset!.name, description: input.preset!.description }, application: null, authorization: 'not-started' })
  expect(view.account).toEqual({ userId: 'original-user', tenantId: 'original-tenant' })
  expect(view.actions.map(action => action.kind)).toContain('confirm-account')
  expect(view.actions.map(action => action.kind)).not.toContain('create')
  expect(calls.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/', '/app'])
  expect(calls.every(call => call.preclaimed)).toBe(true)
  expect((await client.call('connection.enrollment.advance', lastInput!)).receipt).toEqual(view.receipt)
  expect((await client.call('connection.enrollment.inspect', { operationId: input.operationId })).operation).toEqual(view.operation)
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(view.operation)
  expect(calls).toHaveLength(4)
})

it('retains unknown when a later active script dynamically writes the authoritative user', async () => {
  consoleDocument = `<script>${originalConsoleScript}</script><script>window.user=readDynamicUser();</script>`
  let view = await client.call('connection.enrollment.begin', input)
  const originalAttempt = view.operation!.authentication!.attemptId
  let lastInput: ConnectionEnrollmentAdvanceInput | undefined
  for (const path of ['/accounts/qrlogin/polling', '/cross', '/', '/', '/app']) {
    clock = Math.max(clock, view.challenge?.nextPollAt ?? clock) + 1
    lastInput = decision(view, 'continue-authentication')
    const before = calls.length
    view = await cli(['advance', '--input', '-'], lastInput)
    expect(calls).toHaveLength(before + 1)
    expect(calls.at(-1)!.path).toBe(path)
    if (path !== '/app') {
      expect(view.operation!.authentication!.stage).toBe('handoff')
      expect(view.account).toBeNull()
    }
  }
  expect(view.operation!.authentication).toEqual({ attemptId: originalAttempt, stage: 'unknown' })
  expect(view.account).toBeNull()
  expect(view.operation!.diagnostic).toMatchObject({ stage: 'authentication', step: 'console', failure: 'bootstrap-unconfirmed', httpStatus: 200, boundary: 'bootstrap' })
  expect(view.operation!.creation).toEqual({ upload: 'not-started', create: 'not-started' })
  expect(view.actions.map(action => action.kind)).not.toContain('continue-authentication')
  expect(view.actions.map(action => action.kind)).not.toContain('confirm-account')
  expect(calls.map(call => call.path)).toEqual(['/accounts/qrlogin/init', '/accounts/qrlogin/polling', '/cross', '/', '/', '/app'])
  expect((await client.call('connection.enrollment.advance', lastInput!)).receipt).toEqual(view.receipt)
  expect((await cli(['inspect', '--operation-id', input.operationId])).operation).toEqual(view.operation)
  expect(JSON.stringify(view)).not.toContain('readDynamicUser')
  expect(JSON.stringify(view)).not.toContain('original-private-csrf')
  expect(calls).toHaveLength(6)
})
