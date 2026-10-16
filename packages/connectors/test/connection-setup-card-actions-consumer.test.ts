import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { connectionSetupDecisionForAction, type ConnectionSetupAction, type ConnectionSetupAdvance, type ConnectionSetupScalarEffect, type ConnectionSetupView } from '@agentmux/core/connections'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const APP = 'cli_card_actions', connectionId = 'card-actions-bot', operationId = 'card-actions-setup'
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of clean.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (errors.length) throw new AggregateError(errors, 'Card action consumer cleanup failed')
})
function action(view: ConnectionSetupView, kind: ConnectionSetupAction['kind']): ConnectionSetupAdvance {
  const offered = [...view.continuation?.actions ?? [], ...view.applicationInspection?.actions ?? [], ...view.applicationConfiguration?.actions ?? []].find(action => action.kind === kind)
  expect(offered, kind).toBeDefined()
  return { operationId: view.operation!.operationId, expectedRevision: offered!.expectedRevision, decision: { actionId: offered!.actionId, value: connectionSetupDecisionForAction(offered!) } }
}
async function fixture(initialMode = 1) {
  const root = await mkdtemp(join(tmpdir(), 'card-actions-')), socketPath = join(root, 'owner.sock')
  const services = await createDesktopConnections({ directory: join(root, 'connections'), encryption: enrollmentEncryption() })
  clean.push(() => rm(root, { recursive: true, force: true }), () => services.close())
  const server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw Error('Setup cannot borrow an Agent Runtime') } })
  await server.start(); clean.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); clean.push(() => sdk.dispose())
  let mode: unknown = initialMode, callbacks: unknown = ['unrelated.callback'], accepted = true
  const requests: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)), headers = new Headers(init?.headers)
    requests.push({ path: target.pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'card-private-qr' } } }, { headers: { 'x-flow-key': 'card-private-flow', 'set-cookie': 'session=card-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing')
    if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"card-user","tenantId":"card-tenant"};window.csrfToken="card-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
    expect(target.origin).toBe('https://open.feishu.cn')
    expect(headers.get('origin')).toBe(target.origin); expect(headers.get('referer')).toBe(target.origin + '/app/' + APP)
    expect(headers.get('user-agent')).toContain('Chrome/145.0.0.0')
    expect(headers.get('x-csrf-token')).toBe('card-private-csrf'); expect(headers.get('cookie')).toContain('card-private-cookie')
    if (target.pathname === '/developers/v1/callback/' + APP) return Response.json({ code: 0, data: { callbackMode: mode, callbacks } })
    if (target.pathname === '/developers/v1/robot/' + APP) return Response.json({ code: 0, data: { enable: false } })
    if (target.pathname === '/developers/v1/callback/switch/' + APP) { mode = 4; return accepted ? Response.json({ code: 0, data: {} }) : new Response(null, { status: 502 }) }
    if (target.pathname === '/developers/v1/callback/update/' + APP) { callbacks = ['unrelated.callback', 'card.action.trigger']; return accepted ? Response.json({ code: 0, data: {} }) : new Response(null, { status: 502 }) }
    throw Error('Unexpected card action request')
  }))
  const credential = await services.secrets.store({ operationId: 'card-credential', secret: 'card-private-secret' })
  const saved = await sdk.call('connection.configure', { operationId: 'card-save', expectedRevision: null, connection: { connectionId, adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Cards', enabled: false, credentialRef: credential.credentialRef } })
  let view = await sdk.call('connection.setup.begin', { operationId, connectionId, expectedConnectionRevision: saved.connection.revision, goal: { kind: 'agent-conversation', interaction: 'cards' } })
  for (let i = 0; i < 8 && view.continuation?.stage !== 'account'; i++) view = await sdk.call('connection.setup.advance', action(view, 'continue'))
  expect(view.continuation?.stage).toBe('account')
  await sdk.call('connection.setup.advance', action(view, 'confirm-account'))
  const inspect = (effect: ConnectionSetupScalarEffect) => sdk.call('connection.setup.inspect', { operationId, applicationInspection: {}, applicationConfiguration: { effect } })
  const read = async (effect: ConnectionSetupScalarEffect) => {
    const view = await inspect(effect)
    return sdk.call('connection.setup.advance', action(view, effect === 'enable-messaging' ? 'read-bot-settings' : 'read-callback-settings'))
  }
  const cli = async (args: string[], input?: unknown): Promise<ConnectionSetupView> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { sdk, requests, inspect, read, cli, setMode: (value: unknown) => { mode = value }, setCallbacks: (value: unknown) => { callbacks = value }, accept: (value: boolean) => { accepted = value } }
}

it('public SDK and compiled CLI separately confirm callback transport and additive card actions with current exact readback', async () => {
  const f = await fixture(0)
  await f.read('use-persistent-callback')
  const before = f.requests.length
  let view = await f.cli(['inspect', '--operation-id', operationId, '--application-configuration', 'use-persistent-callback'])
  expect(f.requests).toHaveLength(before)
  expect(view.applicationConfiguration).toMatchObject({ effect: 'use-persistent-callback', subject: 'callback-settings', capability: 'disabled' })
  const changeMode = action(view, 'use-persistent-callback')
  view = await f.cli(['advance', '--input', '-'], changeMode)
  expect(view.applicationConfiguration?.selected).toMatchObject({ request: 'confirmed', secureStorage: 'stored' })
  expect(view.applicationConfiguration?.capability).toBe('unknown')
  expect(f.requests.slice(before)).toEqual([{ path: '/developers/v1/callback/switch/' + APP, body: { clientId: APP, callbackMode: 4 } }])
  expect((await f.inspect('add-card-actions')).applicationConfiguration?.actions).toEqual([])
  await f.read('add-card-actions')
  view = await f.inspect('add-card-actions')
  const add = action(view, 'add-card-actions'), beforeAdd = f.requests.length
  view = await f.cli(['advance', '--input', '-'], add)
  expect(f.requests.slice(beforeAdd)).toEqual([{ path: '/developers/v1/callback/update/' + APP, body: { clientId: APP, operation: 'add', callbacks: ['card.action.trigger'], callbackMode: 4 } }])
  expect(view.applicationConfiguration?.selected).toMatchObject({ request: 'confirmed', secureStorage: 'stored' })
  await f.sdk.call('connection.setup.advance', changeMode); await f.sdk.call('connection.setup.advance', add)
  expect(f.requests).toHaveLength(beforeAdd + 1)
  await f.read('add-card-actions')
  expect((await f.inspect('add-card-actions')).applicationConfiguration).toMatchObject({ capability: 'enabled', actions: [] })
  const support = await f.sdk.call('connection.setup.ls', { connectionId })
  expect(support.support?.capabilities).toContain('card-actions')
  for (const value of ['card-private-qr', 'card-private-flow', 'card-private-cookie', 'card-private-csrf', 'card-private-secret']) expect(JSON.stringify({ support, view })).not.toContain(value)
}, 30_000)

it('unknown callback effects retain their original identity without replay and keep independent messaging available', async () => {
  const f = await fixture(); await f.read('use-persistent-callback')
  const input = action(await f.inspect('use-persistent-callback'), 'use-persistent-callback')
  f.accept(false)
  const result = await f.sdk.call('connection.setup.advance', input)
  expect(result.applicationConfiguration?.selected).toMatchObject({ request: 'unknown' })
  const before = f.requests.length
  await f.sdk.call('connection.setup.advance', input)
  expect(f.requests).toHaveLength(before)
  await f.read('use-persistent-callback')
  expect((await f.inspect('use-persistent-callback')).applicationConfiguration).toMatchObject({ capability: 'enabled', reason: 'original-effect-unconfirmed', actions: [] })
  await f.read('enable-messaging')
  expect((await f.inspect('enable-messaging')).applicationConfiguration?.actions.map(a => a.kind)).toEqual(['enable-messaging'])
  expect(f.requests.filter(request => request.path.includes('/callback/switch/'))).toHaveLength(1)
}, 20_000)

it('only a complete persistent callback source qualifies card additions and newer reads invalidate old actions', async () => {
  const f = await fixture(4)
  for (const value of [undefined, null, [{ id: 4 }], ['card.action.trigger', 'card.action.trigger']]) {
    f.setCallbacks(value); await f.read('add-card-actions')
    expect((await f.inspect('add-card-actions')).applicationConfiguration).toMatchObject({ capability: 'unknown', actions: [] })
  }
  f.setCallbacks([]); f.setMode(1); await f.read('add-card-actions')
  expect((await f.inspect('add-card-actions')).applicationConfiguration?.actions).toEqual([])
  f.setMode(4); await f.read('add-card-actions')
  const offered = action(await f.inspect('add-card-actions'), 'add-card-actions')
  await f.read('add-card-actions')
  const before = f.requests.length
  await expect(f.sdk.call('connection.setup.advance', offered)).rejects.toMatchObject({ code: 'CONNECTION_SETUP_ACTION_STALE' })
  expect(f.requests).toHaveLength(before)
  expect(f.requests.filter(request => request.path.includes('/callback/update/'))).toEqual([])
}, 20_000)
