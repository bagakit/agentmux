import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionEnrollmentBeginInput, ConnectionEnrollmentView } from '@agentmux/core/connections'
import { createConnectionServices } from '../../src/connection-services.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'

const APP = 'cli_initial_conversations', VERSION = 'initial-version', USER = 'original-creator'
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const SCOPES = ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only', 'application:application:self_manage', 'im:message.reactions:write_only']
const EVENT = 'im.message.receive_v1'
export const enrollmentInitialCleanup: Array<() => unknown | Promise<unknown>> = []
export async function closeEnrollmentInitialFixtures() {
  const errors: unknown[] = []
  for (const close of enrollmentInitialCleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (errors.length) throw new AggregateError(errors, 'Initial setup consumer cleanup failed')
}
export function enrollmentInitialWeb(options: { unknownEffect?: string | null; versionStatus?: number; name?: string; description?: string } = {}) {
  let messaging = false, eventMode = 1, callbackMode = 0, received = false, cardActions = false, scopes: unknown[] = [], versionCreated = false, submitted = false
  let blocked = options.unknownEffect ?? null
  const requests: Array<{ path: string; body: unknown }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)), path = target.pathname, body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ path, body })
    if (path === '/accounts/qrlogin/init') {
      const response = Response.json({ code: 0, data: { step_info: { token: 'initial-private-qr' } } }, { headers: { 'x-flow-key': 'initial-private-flow' } })
      // happy-dom removes Set-Cookie supplied to the Response constructor.
      response.headers.append('set-cookie', 'session=initial-private-cookie; Domain=.feishu.cn; Path=/; Secure')
      return response
    }
    if (path === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing is not identity')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>window.user={"id":"${USER}","tenantId":"original-tenant"};window.csrfToken="initial-private-csrf";</script>`, { headers: { 'content-type': 'text/html' } })
    const reply = (data: unknown) => Response.json({ code: 0, data })
    if (path === '/developers/v1/app/upload/image') return reply({ url: 'https://images.example.test/amux.png' })
    if (path === '/developers/v1/manifest/upsert_by_template') { expect(body.createAppUserCustomField.i18n['zh_cn'].name).toBe(options.name ?? 'AMUX identity'); expect(body.createAppUserCustomField.i18n['zh_cn'].description).toBe(options.description ?? 'Saved Mote description'); return reply({ ClientID: APP }) }
    if (path === '/developers/v1/secret/' + APP) return reply({ secret: 'initial-private-secret' })
    expect(target.origin).toBe('https://open.feishu.cn')
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('initial-private-csrf')
    expect(new Headers(init?.headers).get('cookie')).toContain('session=initial-private-cookie')
    if (blocked === 'read-event-settings' && path.endsWith('/event/' + APP)) return new Response(null, { status: 502 })
    if (path.endsWith('/robot/' + APP)) return reply({ enable: messaging })
    if (path.endsWith('/event/' + APP)) return reply({ eventMode, appEventDetails: received ? [{ items: [{ id: EVENT }] }] : [] })
    if (path.endsWith('/callback/' + APP)) return reply({ callbackMode, callbacks: cardActions ? ['card.action.trigger'] : [] })
    if (path.endsWith('/scope/all/' + APP)) return reply({ scopes: SCOPES.map((name, i) => ({ name, id: i + 10, scopeType: [2] })) })
    if (path.endsWith('/scope/applied/' + APP)) return reply({ scopes })
    if (path.endsWith('/event/all/' + APP)) return reply({ events: [{ items: [{ id: EVENT, supportIdentityTypes: [2] }] }] })
    if (path.endsWith('/app_version/list/' + APP)) return reply({ versions: versionCreated ? [{ versionId: VERSION, appVersion: '1.0.0', versionStatus: submitted ? (options.versionStatus ?? 2) : 0 }] : [] })
    if (path.endsWith('/app_version/detail/' + APP + '/' + VERSION)) return reply({ versionId: VERSION, appVersion: '1.0.0', versionStatus: submitted ? (options.versionStatus ?? 2) : 0 })
    if (blocked && path.includes(blocked)) return new Response(null, { status: 502 })
    if (path.endsWith('/robot/switch/' + APP)) { messaging = true; return reply({}) }
    if (path.endsWith('/event/switch/' + APP)) { eventMode = 4; return reply({}) }
    if (path.endsWith('/scope/update/' + APP)) { scopes = body.appScopeIDs.map((id: number) => ({ id, scopeIdentityType: 2 })); return reply({ needConfigurePrivilege: false }) }
    if (path.endsWith('/event/update/' + APP)) { received = true; return reply({}) }
    if (path.endsWith('/callback/switch/' + APP)) { callbackMode = 4; return reply({}) }
    if (path.endsWith('/callback/update/' + APP)) { cardActions = true; return reply({}) }
    if (path.endsWith('/app_version/create/' + APP)) { versionCreated = true; return reply({ versionId: VERSION }) }
    if (path.endsWith('/publish/commit/' + APP + '/' + VERSION)) { submitted = true; return reply({}) }
    throw Error('Unexpected initial setup native request: ' + path)
  })
  return { fetch, requests, unblock: () => { blocked = null } }
}

export async function enrollmentInitialFixture(unknownEffect: string | null = null, versionStatus = 2, initialPublication: { version: string; notes: string } | null = { version: '1.0.0', notes: 'Enable AMUX conversations.' }) {
  const root = await mkdtemp(join(tmpdir(), 'initial-setup-')), socketPath = join(root, 'owner.sock')
  let services: Awaited<ReturnType<typeof createConnectionServices>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async () => {
    services = await createConnectionServices({ directory: join(root, 'connections') })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw Error('Initial setup cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  }
  const close = async () => { sdk.dispose(); await server.stop(); services.close() }
  await open(); enrollmentInitialCleanup.push(() => rm(root, { recursive: true, force: true }), close)
  const web = enrollmentInitialWeb({ unknownEffect, versionStatus })
  vi.stubGlobal('fetch', web.fetch)
  const requests = web.requests
  const enrollmentInput: ConnectionEnrollmentBeginInput = { operationId: 'initial-creation', connectionId: 'initial-bot', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'AMUX identity', preset: { name: 'AMUX identity', description: 'Saved Mote description', avatar: { pngDataUrl: PNG } }, ...(initialPublication ? { initialPublication } : {}) }
  const initialReply = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'enrollment', 'begin', '--input', '-'], objectCliEnvironment(root), JSON.stringify(enrollmentInput))
  expect(initialReply.code, initialReply.stdout + initialReply.stderr).toBe(0)
  let enrollment = JSON.parse(initialReply.stdout).result as ConnectionEnrollmentView
  const admitted = structuredClone(enrollment)
  const enrollmentAction = async (kind: string) => {
    const action = enrollment.actions.find(action => action.kind === kind)!
    expect(action, kind).toBeDefined()
    enrollment = await sdk.call('connection.enrollment.advance', { operationId: enrollment.operation!.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: action.kind } })
  }
  const finishCreation = async () => {
  for (let i = 0; i < 8 && enrollment.operation!.authentication?.stage !== 'account'; i++) {
    if (enrollment.challenge && enrollment.challenge.nextPollAt > Date.now()) await new Promise(done => setTimeout(done, enrollment.challenge!.nextPollAt - Date.now()))
    await enrollmentAction('continue-authentication')
  }
  await enrollmentAction('confirm-account'); await enrollmentAction('create')
  expect(enrollment.operation!.configuration).toBe('configured')
    return enrollment
  }
  const cli = async (args: string[], value?: unknown): Promise<ConnectionEnrollmentView> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'enrollment', ...args], objectCliEnvironment(root), value === undefined ? '' : JSON.stringify(value))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  const connectionCli = async (args: string[]) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], objectCliEnvironment(root))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { input: enrollmentInput, admitted, finishCreation, enrollmentAction, get enrollment() { return enrollment }, get sdk() { return sdk }, requests, cli, connectionCli, get services() { return services }, reopen: async () => { await close(); await open() }, unblock: web.unblock }
}

