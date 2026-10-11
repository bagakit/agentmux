import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionSetupAction, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupView } from '@agentmux/core/connections'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const APP = 'cli_publication_original'
const VERSION = 'exact-version-original'
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of clean.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (errors.length) throw new AggregateError(errors, 'Publication consumer cleanup failed')
})
function action(view: ConnectionSetupView, kind: ConnectionSetupAction['kind']): ConnectionSetupAdvance {
  const offered = [...view.continuation?.actions ?? [], ...view.applicationInspection?.actions ?? [], ...view.applicationConfiguration?.actions ?? []].find(a => a.kind === kind)
  expect(offered, kind).toBeDefined()
  return { operationId: view.operation!.operationId, expectedRevision: offered!.expectedRevision, decision: { actionId: offered!.actionId, value: kind === 'confirm-account' || kind === 'enable-messaging' || kind === 'use-persistent-connection' ? 'confirm' : kind === 'renew' ? 'renew' : 'continue' } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'publication-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock')
  const services = await createDesktopConnections({ directory, encryption: enrollmentEncryption() })
  const server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw Error('Publication cannot borrow an Agent Runtime') } })
  await server.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  let closed = false
  const close = async () => { if (closed) return; closed = true; sdk.dispose(); await server.stop(); services.close() }
  clean.push(() => rm(root, { recursive: true, force: true }), close)
  const native: Array<{ path: string; body: unknown }> = []
  let returnedVersion: string | undefined
  const pending = { ChangeScope: { addScopesV2: ['scope-original'], removeScopesV2: [], addUserTypeScopes: [], removeUserTypeScopes: [], addTenantTypeScopes: [], removeTenantTypeScopes: [] }, changeClientSystemScope: { addScopesV2: [], removeScopesV2: [] }, changeEventConfig: { changed: true, eventModeChanged: false }, changeBotCardCallbackConfig: { changed: false }, changeExtension: { changed: true }, changePrivilege: { changed: false }, changeAllowRefreshToken: { changed: false, allowRefreshToken: false }, pcDefaultAbility: 'web-app', mobileDefaultAbility: 'web-app', pcDefaultAbilityList: ['bot', 'web-app'], mobileDefaultAbilityList: ['web-app'], equalToVisible: false, applyReasonConfig: { apiPrivilegeNeedReason: true, dataPrivilegeNeedReason: false, isDataPrivilegeExpandMap: {}, contactPrivilegeNeedReason: false, isContactExpand: false, visibleScopeNeedReason: true } }
  const visibility = { whiteList: { departments: [{ id: 17 }], members: [{ id: 'original-person' }], groups: [{ id: 'original-group' }], isAll: 0 }, blackList: { departments: [{ id: 'excluded-department' }], members: [{ id: 29 }], groups: [{ id: 31 }], isAll: 0 } }
  const versions = [{ versionId: 'unrelated-list-head', appVersion: '1.0.0', versionStatus: 2 }]
  const features = { hitFeatureKeyList: ['openplatform.b2c.bot_b2c_share_switch_split'] }, sharing = { onlineB2CShareSplitConfig: { b2cGroupChatShareEnable: true, b2cP2PChatShareEnable: true, b2cP2PChatNeedAudit: false } }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)); native.push({ path: target.pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'publication-private-token' } } }, { headers: { 'x-flow-key': 'publication-private-flow', 'set-cookie': 'session=publication-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text does not supply an account')
    if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"publication-user","tenantId":"publication-enterprise"};window.csrfToken="publication-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('publication-private-csrf')
    expect(new Headers(init?.headers).get('cookie')).toContain('session=publication-private-cookie')
    expect(init?.method).toBe('POST')
    if (target.pathname === '/developers/v1/developer_panel/config') { expect(JSON.parse(String(init?.body))).toEqual({ clientId: APP }); return Response.json({ code: 0, data: features }) }
    if (target.pathname === '/developers/v1/app_version/change/' + APP) return Response.json({ code: 0, data: pending })
    if (target.pathname === '/developers/v1/app_version/list/' + APP) return Response.json({ code: 0, data: { versions } })
    if (target.pathname === '/developers/v1/visible/online/' + APP) return Response.json({ code: 0, data: visibility })
    if (target.pathname === '/developers/v1/b2c_share/' + APP) return Response.json({ code: 0, data: sharing })
    if (target.pathname === '/developers/v1/app_version/detail/' + APP + '/' + VERSION) return Response.json({ code: 0, data: { ...pending, ChangeScope: undefined, changeScope: pending.ChangeScope, ...(returnedVersion === undefined ? {} : { versionId: returnedVersion }), appVersion: '1.1.0', versionStatus: 4, visibleRange: visibility } })
    throw Error('Unexpected event transport native request')
  }))
  const credential = await services.secrets.store({ operationId: 'publication-credential', secret: 'publication-private-secret' })
  const saved = await sdk.call('connection.configure', { operationId: 'publication-save', expectedRevision: null, connection: { connectionId: 'publication-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Publication bot', enabled: false, credentialRef: credential.credentialRef } })
  const input: ConnectionSetupBegin = { operationId: 'publication-management', connectionId: saved.connection.config.connectionId, expectedConnectionRevision: saved.connection.revision, goal: { kind: 'agent-conversation', interaction: 'messages' } } as const
  const confirm = async (original = input) => {
  let view = await sdk.call('connection.setup.begin', original)
  for (let i = 0; i < 8 && view.continuation?.stage !== 'account'; i++) view = await sdk.call('connection.setup.advance', action(view, 'continue'))
  expect(view.continuation?.stage).toBe('account')
  view = await sdk.call('connection.setup.advance', action(view, 'confirm-account'))
  expect(view.continuation?.stage).toBe('confirmed'); return view
  }
  await confirm()
  const read = async (subject: 'publication-pending' | 'publication-versions' | 'publication-visibility' | 'publication-sharing' | 'publication-features', operationId: string = input.operationId) => {
    const view = await sdk.call('connection.setup.inspect', { operationId, applicationInspection: {} })
    return sdk.call('connection.setup.advance', action(view, ('read-' + subject) as ConnectionSetupAction['kind']))
  }
  const cli = async (args: string[], input?: unknown): Promise<ConnectionSetupView> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { root, directory, services, sdk, native, saved, input, read, cli, confirm, close, pending, visibility, sharing, versions, wrongVersion: (value: string) => { returnedVersion = value } }
}


it('the real Host, SDK and compiled CLI observe independent publication subjects and the explicitly selected exact version with zero writes', async () => {
  const f = await fixture(), before = f.native.length
  for (const subject of ['publication-pending', 'publication-versions', 'publication-visibility', 'publication-sharing', 'publication-features'] as const) {
    const result = await f.read(subject)
    expect(result.applicationInspection!.selected).toMatchObject({ subject, request: 'confirmed', secureStorage: 'stored' })
    expect(result.applicationInspection!.readResult).toEqual({ subject })
  }
  const offered = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-inspection', '--version-id', VERSION])
  const selected = offered.applicationInspection!.actions.find(a => a.kind === 'read-publication-version')!
  expect(selected).toMatchObject({ kind: 'read-publication-version', versionId: VERSION })
  const input: ConnectionSetupAdvance = { ...action(offered, 'read-publication-version'), versionId: VERSION }
  const result = await f.cli(['advance', '--input', '-'], input)
  expect(result.applicationInspection!.selected).toMatchObject({ subject: 'publication-version', versionId: VERSION, input, request: 'confirmed', secureStorage: 'stored' })
  expect(result.applicationInspection!.readResult).toEqual({ subject: 'publication-version', versionId: VERSION, status: 'draft' })
  expect(await f.sdk.call('connection.setup.advance', input)).toEqual(result)
  expect(f.native.slice(before).map(r => r.path)).toEqual(['/developers/v1/app_version/change/' + APP, '/developers/v1/app_version/list/' + APP, '/developers/v1/visible/online/' + APP, '/developers/v1/b2c_share/' + APP, '/developers/v1/developer_panel/config', '/developers/v1/app_version/detail/' + APP + '/' + VERSION])
  expect(JSON.stringify(result)).not.toContain('publication-private')
}, 30_000)

it('an exact version read never accepts another version or replays an unknown original read', async () => {
  const f = await fixture()
  const offered = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: { versionId: VERSION } })
  const input: ConnectionSetupAdvance = { ...action(offered, 'read-publication-version'), versionId: VERSION }
  f.wrongVersion('unrelated-list-head')
  const result = await f.sdk.call('connection.setup.advance', input)
  expect(result.applicationInspection!.selected).toMatchObject({ subject: 'publication-version', versionId: VERSION, request: 'unknown' })
  expect(result.applicationInspection!.readResult).toBeUndefined()
  const count = f.native.length
  await f.sdk.call('connection.setup.advance', input)
  expect(f.native).toHaveLength(count)
  await expect(f.sdk.call('connection.setup.advance', { ...input, versionId: 'unrelated-list-head' })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
}, 30_000)
