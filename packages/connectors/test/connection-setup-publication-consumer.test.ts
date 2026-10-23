import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, AgentMuxError } from '@agentmux/core'
import { connectionSetupDecisionForAction } from '@agentmux/core/connections'
import type { ConnectionSetupAction, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupConfigurationEffect, ConnectionSetupView } from '@agentmux/core/connections'
import { ConnectionSecrets } from '../src/connection-secrets.js'
import { createConnectionServices } from '../src/connection-services.js'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const APP = 'cli_publication_original', effect = 'create-application-version' as const
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
  return { operationId: view.operation!.operationId, expectedRevision: offered!.expectedRevision, decision: { actionId: offered!.actionId, value: connectionSetupDecisionForAction(offered!) } }
}
async function fixture(options: { enrollment?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'publication-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock')
  const services = await createConnectionServices({ directory, encryption: enrollmentEncryption() })
  const server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw Error('Publication cannot borrow an Agent Runtime') } })
  await server.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  let closed = false
  const close = async () => { if (closed) return; closed = true; sdk.dispose(); await server.stop(); services.close() }
  clean.push(() => rm(root, { recursive: true, force: true }), close)
  const native: Array<{ path: string; body: unknown }> = []
  let currentAccount = { userId: 'publication-user', tenantId: 'publication-enterprise', userName: 'Original creator' }
  let accepted = true, submission: 'accepted' | 'unknown' | 'attention' = 'accepted'
  let catalog: unknown = {}, settings: unknown = {}
  let returnedVersion: string | undefined
  const pending = { ChangeScope: { scopeNames: { 'scope-original': 'Original application permission' }, addScopesV2: ['scope-original'], removeScopesV2: [], addUserTypeScopes: [], removeUserTypeScopes: [], addTenantTypeScopes: [], removeTenantTypeScopes: [] }, changeClientSystemScope: { addScopesV2: [], removeScopesV2: [] }, changeEventConfig: { changed: true, eventModeChanged: false }, changeBotCardCallbackConfig: { abilityEnableState: 0, callbackMode: 1, callbackModeChanged: false }, changeExtension: { status: 1 }, changePrivilege: { changed: false, privileges: [] }, contactRangeDetail: {}, changeAllowRefreshToken: { changed: false, allowRefreshToken: false }, pcDefaultAbility: 'web-app', mobileDefaultAbility: 'web-app', pcDefaultAbilityList: ['bot', 'web-app'], mobileDefaultAbilityList: ['web-app'], equalToVisible: false, applyReasonConfig: { apiPrivilegeNeedReason: true, dataPrivilegeNeedReason: false, isDataPrivilegeExpandMap: {}, contactPrivilegeNeedReason: false, isContactExpand: false, visibleScopeNeedReason: true } }
  const visibility = { whiteList: { departments: [{ id: 17 }], members: [{ id: 'original-person' }], groups: [{ id: 'original-group' }], isAll: 0 }, blackList: { departments: [{ id: 'excluded-department' }], members: [{ id: 29 }], groups: [{ id: 31 }], isAll: 0 } }
  const versions = options.enrollment ? [] : [{ versionId: 'unrelated-list-head', appVersion: '1.0.0', versionStatus: 2 }]
  const features = { hitFeatureKeyList: ['openplatform.b2c.bot_b2c_share_switch_split'] }, sharing = { onlineB2CShareSplitConfig: { b2cGroupChatShareEnable: true, b2cP2PChatShareEnable: true, b2cP2PChatNeedAudit: false } }
  const detail = { ...pending, ChangeScope: undefined, changeScope: pending.ChangeScope, appVersion: '1.1.0', versionStatus: 4, visibleRange: visibility, changeLog: 'Original selected version release notes', pcDefaultAbility: 'desktop-existing', mobileDefaultAbility: '', changeAppShareConfig: { b2cShareSplitConfigSuggest: { b2cGroupChatShareEnable: false, b2cP2PChatShareEnable: true, b2cP2PChatNeedAudit: true } }, changeB2BShareConfig: { changed: true, status: true } }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)); native.push({ path: target.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} })
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'publication-private-token' } } }, { headers: { 'x-flow-key': 'publication-private-flow', 'set-cookie': 'session=publication-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text does not supply an account')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>window.user=${JSON.stringify({ id: currentAccount.userId, tenantId: currentAccount.tenantId, name: currentAccount.userName })};window.csrfToken="publication-private-csrf";</script>`, { headers: { 'content-type': 'text/html' } })
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('publication-private-csrf')
    expect(new Headers(init?.headers).get('cookie')).toContain('session=publication-private-cookie')
    expect(init?.method).toBe('POST')
    if (target.pathname === '/developers/v1/app/upload/image') return Response.json({ code: 0, data: { url: 'https://images.example.test/publication.png' } })
    if (target.pathname === '/developers/v1/manifest/upsert_by_template') return Response.json({ code: 0, data: { ClientID: APP } })
    if (target.pathname === '/developers/v1/secret/' + APP) return Response.json({ code: 0, data: { secret: 'publication-private-secret' } })
    if (target.pathname === '/developers/v1/developer_panel/config') { expect(JSON.parse(String(init?.body))).toEqual({ clientId: APP }); return Response.json({ code: 0, data: features }) }
    if (target.pathname === '/developers/v1/app_version/change/' + APP) return Response.json({ code: 0, data: pending })
    if (target.pathname === '/developers/v1/app_version/list/' + APP) return Response.json({ code: 0, data: { versions } })
    if (target.pathname === '/developers/v1/visible/online/' + APP) return Response.json({ code: 0, data: visibility })
    if (target.pathname === '/developers/v1/b2c_share/' + APP) return Response.json({ code: 0, data: sharing })
    if (target.pathname === '/developers/v1/app_version/detail/' + APP + '/' + VERSION) return Response.json({ code: 0, data: { ...detail, ...(returnedVersion === undefined ? {} : { versionId: returnedVersion }) } })
    if (target.pathname === '/developers/v1/app_version/create/' + APP) { expect(new Headers(init?.headers).get('X-AppPlatform-RequestFrom')).toBeNull(); return accepted ? Response.json({ code: 0, data: { versionId: VERSION } }) : new Response('Unconfirmed', { status: 502 }) }
    if (target.pathname === '/developers/v1/publish/commit/' + APP + '/' + VERSION) { expect(new Headers(init?.headers).get('X-AppPlatform-RequestFrom')).toBe('develop_panel'); return accepted ? Response.json({ code: 0, data: submission === 'unknown' ? {} : submission === 'attention' ? { urlConflict: true } : { urlConflict: false, avatar: 'avatar-original', isOk: true } }) : new Response('Unconfirmed', { status: 502 }) }
    throw Error('Unexpected event transport native request')
  }))
  const { saved, source } = await (async () => {
    if (!options.enrollment) {
      const credential = await services.secrets.store({ operationId: 'publication-credential', secret: 'publication-private-secret' })
      const saved = await sdk.call('connection.configure', { operationId: 'publication-save', expectedRevision: null, connection: { connectionId: 'publication-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Publication bot', enabled: false, credentialRef: credential.credentialRef } })
      return { saved, source: undefined }
    }
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    let view = await sdk.call('connection.enrollment.begin', { operationId: 'publication-enrollment', connectionId: 'publication-bot', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Publication bot', preset: { name: 'Publication bot', avatar: { pngDataUrl: png } } })
    const advance = async (kind: string) => {
      const selected = view.actions.find(action => action.kind === kind)!
      expect(selected, kind).toBeDefined()
      view = await sdk.call('connection.enrollment.advance', { operationId: view.operation!.operationId, ownRevision: selected.ownRevision, decision: { actionId: selected.actionId, kind: selected.kind } })
    }
    for (let hop = 0; hop < 8 && view.operation!.authentication?.stage !== 'account'; hop++) {
      if (view.challenge && view.challenge.nextPollAt > Date.now()) await new Promise(resolve => setTimeout(resolve, view.challenge!.nextPollAt - Date.now()))
      await advance('continue-authentication')
    }
    await advance('confirm-account'); await advance('create')
    expect(view.operation!.configuration).toBe('configured')
    return { saved: { connection: view.operation!.configured!.connection }, source: { kind: 'enrollment' as const, operationId: view.operation!.operationId, expectedRevision: view.operation!.revision } }
  })()
  const input: ConnectionSetupBegin = { operationId: 'publication-management', connectionId: saved.connection.config.connectionId, expectedConnectionRevision: saved.connection.revision, goal: { kind: 'agent-conversation', interaction: 'messages' }, ...(source ? { source } : {}) }
  const confirm = async (original = input) => {
  let view = await sdk.call('connection.setup.begin', original)
  for (let i = 0; i < 8 && view.continuation?.stage !== 'account'; i++) view = await sdk.call('connection.setup.advance', action(view, 'continue'))
  expect(view.continuation?.stage).toBe('account')
  view = await sdk.call('connection.setup.advance', action(view, 'confirm-account'))
  expect(view.continuation?.stage).toBe('confirmed'); return view
  }
  await confirm()
  const inspect = (selectedEffect: Exclude<ConnectionSetupConfigurationEffect, 'add-application-permissions'> = effect, operationId: string = input.operationId) => sdk.call('connection.setup.inspect', { operationId, applicationInspection: {}, applicationConfiguration: { effect: selectedEffect } })
  const read = async (subject: 'publication-pending' | 'publication-versions' | 'publication-visibility' | 'publication-sharing' | 'publication-features', operationId: string = input.operationId) => {
    const view = await sdk.call('connection.setup.inspect', { operationId, applicationInspection: {} })
    return sdk.call('connection.setup.advance', action(view, ('read-' + subject) as ConnectionSetupAction['kind']))
  }
  const cli = async (args: string[], input?: unknown): Promise<ConnectionSetupView> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { root, directory, services, sdk, native, saved, input, inspect, read, cli, confirm, close, account: (value: typeof currentAccount) => { currentAccount = value }, pending, visibility, sharing, versions, detail, wrongVersion: (value: string) => { returnedVersion = value }, catalog: (value: unknown) => { catalog = value }, settings: (value: unknown) => { settings = value }, submission: (value: typeof submission) => { submission = value }, accept: (value: boolean) => { accepted = value } }
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

const createDraft = { kind: 'create-version', version: '1.1.0', notes: 'Receive Agent conversation messages and retain the existing application settings.', visibility: 'current', reason: 'Allow the team to use the Agent in its existing application audience.' } as const
const creationSubjects = ['publication-pending', 'publication-versions', 'publication-visibility', 'publication-sharing', 'publication-features'] as const
async function prepareCreation(f: Awaited<ReturnType<typeof fixture>>, draft = createDraft) {
  for (const subject of creationSubjects) await f.read(subject)
  return f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {}, applicationConfiguration: { effect: 'create-application-version', draft } })
}
async function prepareSubmission(f: Awaited<ReturnType<typeof fixture>>, versionId = VERSION) {
  await f.read('publication-versions'); await f.read('publication-features')
  const offered = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: { versionId } })
  await f.sdk.call('connection.setup.advance', { ...action(offered, 'read-publication-version'), versionId })
  return f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {}, applicationConfiguration: { effect: 'submit-application-version', draft: { kind: 'submit-version', versionId, fullRelease: false } } })
}
it('SDK and compiled CLI create the reviewed complete form then submit only the explicitly selected returned version', async () => {
  const f = await fixture(), reviewed = await prepareCreation(f), configuration = reviewed.applicationConfiguration!
  expect(configuration).toMatchObject({ effect: 'create-application-version', capability: 'disabled', draft: createDraft, review: { reasonRequired: true, creatorAudienceAvailable: false, issues: [], audience: { include: { all: false, departments: [17], people: ['original-person'], groups: ['original-group'] }, exclude: { all: false, departments: ['excluded-department'], people: [29], groups: [31] } }, entries: { desktop: { current: 'web-app', choices: ['bot', 'web-app'] }, mobile: { current: 'web-app', choices: ['web-app'] } }, sharing: { kind: 'split', groups: true, direct: true, directReview: false } } })
  expect(configuration.effect === 'create-application-version' && configuration.review?.changes.map(c => c.category)).toEqual(['events', 'extensions', 'permissions'])
  const cliReviewed = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-inspection', '--application-configuration', 'create-application-version', '--publication-draft', '-'], createDraft)
  expect(cliReviewed.applicationConfiguration).toEqual(reviewed.applicationConfiguration)
  const before = f.native.length, input = { ...action(cliReviewed, 'create-application-version'), publicationDraft: createDraft }
  const created = await f.cli(['advance', '--input', '-'], input)
  expect(created.applicationConfiguration!.selected).toMatchObject({ effect: 'create-application-version', input, versionId: VERSION, submission: null, request: 'confirmed', secureStorage: 'stored' })
  expect(f.native.slice(before)).toEqual([{ path: '/developers/v1/app_version/create/' + APP, body: { autoPublish: false, appVersion: createDraft.version, changeLog: createDraft.notes, visibleSuggest: { departments: [17], members: ['original-person'], groups: ['original-group'], isAll: 0 }, blackVisibleSuggest: { departments: ['excluded-department'], members: [29], groups: [31], isAll: 0 }, pcDefaultAbility: 'web-app', mobileDefaultAbility: 'web-app', b2cShareSplitConfigSuggest: f.sharing.onlineB2CShareSplitConfig, applyReasonConfig: f.pending.applyReasonConfig, remark: createDraft.reason } }])
  expect(created.applicationConfiguration).toMatchObject({ capability: 'unknown', review: null })
  const reviewedSubmit = await prepareSubmission(f)
  expect(reviewedSubmit.applicationConfiguration).toMatchObject({ effect: 'submit-application-version', capability: 'disabled', review: { selectedVersion: { versionId: VERSION, version: '1.1.0', status: 'draft' }, issues: [] } })
  const submit = { ...action(reviewedSubmit, 'submit-application-version'), publicationDraft: { kind: 'submit-version', versionId: VERSION, fullRelease: false } as const }, count = f.native.length
  const accepted = await f.cli(['advance', '--input', '-'], submit)
  expect(f.native.slice(count)).toEqual([{ path: '/developers/v1/publish/commit/' + APP + '/' + VERSION, body: { is_full_release: false } }])
  expect(accepted.applicationConfiguration!.selected).toMatchObject({ effect: 'submit-application-version', versionId: VERSION, request: 'confirmed', secureStorage: 'stored', submission: { outcome: 'accepted', issues: [] } })
  const after = f.native.length
  await f.sdk.call('connection.setup.advance', input); await f.sdk.call('connection.setup.advance', submit)
  expect(f.native).toHaveLength(after)
  expect(JSON.stringify(accepted)).not.toContain('publication-private')
}, 30_000)

it('an unknown create remains original while an explicitly selected existing version can be independently submitted', async () => {
  const f = await fixture(), offered = await prepareCreation(f), input = { ...action(offered, 'create-application-version'), publicationDraft: createDraft }
  f.accept(false)
  const created = await f.sdk.call('connection.setup.advance', input)
  expect(created.applicationConfiguration!.selected).toMatchObject({ request: 'unknown', versionId: null })
  const submitReview = await prepareSubmission(f)
  expect(submitReview.applicationConfiguration!.actions.map(a => a.kind)).toContain('submit-application-version')
  f.accept(true)
  await f.sdk.call('connection.setup.advance', { ...action(submitReview, 'submit-application-version'), publicationDraft: { kind: 'submit-version', versionId: VERSION, fullRelease: false } })
  const again = await prepareCreation(f)
  expect(again.applicationConfiguration).toMatchObject({ reason: 'original-effect-unconfirmed', actions: [], unresolved: { operationId: f.input.operationId, stepId: created.receipt!.stepId } })
  expect(f.native.filter(r => r.path.includes('/app_version/create/'))).toHaveLength(1)
  expect(f.native.filter(r => r.path.includes('/publish/commit/'))).toHaveLength(1)
}, 30_000)

it('the actual SDK rejects a self-consistent response for a different version than its original advance input', async () => {
  const f = await fixture()
  const offered = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: { versionId: VERSION } })
  const input: ConnectionSetupAdvance = { ...action(offered, 'read-publication-version'), versionId: VERSION }
  const original = f.services.connections.setup!.advance.bind(f.services.connections.setup!)
  const corrupt = vi.spyOn(f.services.connections.setup!, 'advance').mockImplementation(async (input, context) => {
    const result = structuredClone(await original(input, context)), inspection = result.applicationInspection!, selected = inspection.selected!
    const replace = (receipt: typeof selected) => { receipt.versionId = 'other-version'; receipt.input.versionId = 'other-version' }
    replace(selected)
    for (const observation of inspection.observations) if (observation.stepId === selected.stepId) replace(observation)
    inspection.readResult = { subject: 'publication-version', versionId: 'other-version', status: 'draft' }
    return result
  })
  await expect(f.sdk.call('connection.setup.advance', input)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_SETUP_DATA' })
  corrupt.mockRestore()
  const count = f.native.length
  const result = await f.sdk.call('connection.setup.advance', input)
  expect(result.applicationInspection!.readResult).toMatchObject({ subject: 'publication-version', versionId: VERSION })
  expect(f.native).toHaveLength(count)
  const historical = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: { selectedStepId: result.receipt!.stepId, versionId: 'other-version' } })
  expect(historical.applicationInspection!.readResult).toMatchObject({ versionId: VERSION })
}, 30_000)

it('a current version-list observation supports explicit existing-version choice without reading unrelated creation sources', async () => {
  const f = await fixture(), before = f.native.length
  const versions = (await f.read('publication-versions')).applicationInspection!.selected!
  await f.read('publication-features')
  const view = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {}, applicationConfiguration: { effect: 'submit-application-version' } })
  expect(view.applicationConfiguration).toMatchObject({ effect: 'submit-application-version', sources: { versions }, capability: 'unknown', actions: [], review: { versions: [{ versionId: 'unrelated-list-head', version: '1.0.0', status: 'approved' }], selectedVersion: null, issues: ['Choose an exact version to review'] } })
  expect(f.native.slice(before).map(r => r.path)).toEqual(['/developers/v1/app_version/list/' + APP, '/developers/v1/developer_panel/config'])
}, 30_000)

it('the actual SDK rejects a different publication draft in a self-consistent original result', async () => {
  const f = await fixture(), offered = await prepareCreation(f), input = { ...action(offered, 'create-application-version'), publicationDraft: createDraft }
  const original = f.services.connections.setup!.advance.bind(f.services.connections.setup!)
  vi.spyOn(f.services.connections.setup!, 'advance').mockImplementation(async (input, context) => {
    const result = structuredClone(await original(input, context)), configuration = result.applicationConfiguration!
    const draft = { ...createDraft, notes: 'Different unapproved release notes' }
    if (configuration.effect !== 'create-application-version') throw Error('Wrong publication consumer')
    configuration.draft = draft
    configuration.selected!.input.publicationDraft = draft
    for (const receipt of configuration.effects) if (receipt.stepId === configuration.selected!.stepId) receipt.input.publicationDraft = draft
    return result
  })
  await expect(f.sdk.call('connection.setup.advance', input)).rejects.toMatchObject({ code: 'INVALID_CONNECTION_SETUP_DATA' })
}, 30_000)

it('a submit claim invalidates earlier online audience and sharing before a later creation review', async () => {
  const f = await fixture(), first = await prepareCreation(f)
  expect(first.applicationConfiguration).toMatchObject({ capability: 'disabled' })
  const submit = await prepareSubmission(f)
  await f.sdk.call('connection.setup.advance', { ...action(submit, 'submit-application-version'), publicationDraft: { kind: 'submit-version', versionId: VERSION, fullRelease: false } })
  await f.read('publication-pending'); await f.read('publication-versions')
  const incomplete = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {}, applicationConfiguration: { effect: 'create-application-version', draft: createDraft } })
  expect(incomplete.applicationConfiguration).toMatchObject({ capability: 'unknown', actions: [] })
  expect(incomplete.applicationConfiguration?.effect === 'create-application-version' && incomplete.applicationConfiguration.sources.visibility).toBeUndefined()
  expect(incomplete.applicationConfiguration?.effect === 'create-application-version' && incomplete.applicationConfiguration.sources.sharing).toBeUndefined()
  await f.read('publication-visibility'); await f.read('publication-sharing')
  const current = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {}, applicationConfiguration: { effect: 'create-application-version', draft: createDraft } })
  expect(current.applicationConfiguration).toMatchObject({ capability: 'disabled' })
  expect(current.applicationConfiguration!.actions.map(a => a.kind)).toContain('create-application-version')
  await f.sdk.call('connection.setup.advance', { ...action(current, 'create-application-version'), publicationDraft: createDraft })
  expect(f.native.filter(call => call.path.includes('/app_version/create/'))).toHaveLength(1)
}, 30_000)

it('a received but unknown submission outcome remains the exact version original without blocking a separate creation', async () => {
  const f = await fixture(), offered = await prepareSubmission(f)
  const input = { ...action(offered, 'submit-application-version'), publicationDraft: { kind: 'submit-version', versionId: VERSION, fullRelease: false } as const }
  f.submission('unknown')
  const accepted = await f.sdk.call('connection.setup.advance', input)
  expect(accepted.applicationConfiguration!.selected).toMatchObject({ request: 'confirmed', secureStorage: 'stored', submission: { outcome: 'unknown', issues: ['response-unconfirmed'] } })
  const current = await prepareSubmission(f)
  expect(current.applicationConfiguration).toMatchObject({ reason: 'original-effect-unconfirmed', actions: [], unresolved: { operationId: f.input.operationId, stepId: accepted.receipt!.stepId } })
  const count = f.native.length
  await f.sdk.call('connection.setup.advance', input)
  expect(f.native).toHaveLength(count)
  const independent = await prepareCreation(f)
  expect(independent.applicationConfiguration!.actions.map(a => a.kind)).toContain('create-application-version')
  expect(f.native.filter(call => call.path.includes('/publish/commit/'))).toHaveLength(1)
}, 30_000)

it('rejected, initial and testing versions do not prevent a version newer than the original native reference', async () => {
  const f = await fixture()
  f.versions.unshift({ versionId: 'rejected-high-version', appVersion: '9.0.0', versionStatus: 3 }, { versionId: 'initial-high-version', appVersion: '8.0.0', versionStatus: 0 }, { versionId: 'testing-high-version', appVersion: '7.0.0', versionStatus: 10 })
  const result = await prepareCreation(f)
  expect(result.applicationConfiguration).toMatchObject({ capability: 'disabled', review: { issues: [] } })
  expect(result.applicationConfiguration!.actions.map(a => a.kind)).toContain('create-application-version')
}, 30_000)

function childMessage(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => { if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind) { child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>) } }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Publication owner exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}

it.each([['create-application-version', 'native-inflight'], ['create-application-version', 'stored-ack'], ['submit-application-version', 'native-inflight'], ['submit-application-version', 'stored-ack']] as const)('a true %s %s writer exit preserves its original child and local ACK without a current adapter or native replay', async (effect, mode) => {
  const f = await fixture(), offered = effect === 'create-application-version' ? await prepareCreation(f) : await prepareSubmission(f)
  const input: ConnectionSetupAdvance = { ...action(offered, effect), publicationDraft: effect === 'create-application-version' ? createDraft : { kind: 'submit-version', versionId: VERSION, fullRelease: false } }
  await f.close()
  const start = async (mode: string) => {
    const child = fork(new URL('./fixtures/connection-setup-publication-owner.mjs', import.meta.url), [f.directory, mode, effect], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    let errors = ''; child.stderr!.on('data', data => { errors += data })
    await childMessage(child, 'ready').catch(error => { throw new Error(errors || String(error)) })
    return child
  }
  const writer = await start(mode), reached = childMessage(writer, mode === 'stored-ack' ? 'stored-ack' : 'native-dispatched')
  const cli = async (args: string[], input?: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + join(f.directory, 'owner.sock'), 'connection', 'setup', ...args], objectCliEnvironment(f.root), input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result as ConnectionSetupView
  }
  const pending = runCompiledObjectCli(['--endpoint', 'unix:' + join(f.directory, 'owner.sock'), 'connection', 'setup', 'advance', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(input))
  await reached
  const original = (await cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect])).applicationConfiguration!.selected!
  expect(original).toMatchObject({ effect, input })
  writer.kill('SIGKILL'); await once(writer, 'exit'); expect((await pending).code).not.toBe(0)
  const native = await readFile(join(f.directory, 'publication-writes.ndjson'), 'utf8')
  await start('recover')
  const local = await cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect, '--configuration-step', original.stepId])
  expect(local.applicationConfiguration!.capability).toBe('unknown')
  const resumed = await cli(['advance', '--input', '-'], mode === 'stored-ack' ? { ...action(local, 'recover-configuration-effect'), publicationDraft: input.publicationDraft } : input)
  expect(resumed.applicationConfiguration!.selected).toEqual({ ...original, request: mode === 'stored-ack' ? 'confirmed' : 'unknown', secureStorage: mode === 'stored-ack' ? 'stored' : 'not-started' })
  expect((await cli(['advance', '--input', '-'], input)).applicationConfiguration!.selected).toEqual(resumed.applicationConfiguration!.selected)
  expect(await readFile(join(f.directory, 'publication-writes.ndjson'), 'utf8')).toBe(native)
  const writes = native.trim().split('\n').map(line => JSON.parse(line))
  expect(writes).toHaveLength(1)
  expect(writes[0].path).toBe(effect === 'create-application-version' ? '/developers/v1/app_version/create/' + APP : '/developers/v1/publish/commit/' + APP + '/' + VERSION)
}, 30_000)


it.each(['pending', 'visibility', 'target', 'actor'] as const)('a %s change during a private source yield refuses only the uncommitted version creation', async change => {
  const f = await fixture(), offered = await prepareCreation(f), input = { ...action(offered, 'create-application-version'), publicationDraft: createDraft }, db = f.services.database!
  const configuration = offered.applicationConfiguration!
  if (configuration.effect !== 'create-application-version') throw Error('Wrong publication source')
  const source = change === 'visibility' ? configuration.sources.visibility! : configuration.sources.pending!
  const ref = db.prepare('SELECT private_ref FROM connection_setup_inspection WHERE step_id=?').get(source.stepId)!.private_ref
  const actor = JSON.parse(String(db.prepare('SELECT actor_json FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!.actor_json))
  let entered!: () => void, release!: () => void, held = false, authorized = true
  const waiting = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done }), resolve = ConnectionSecrets.prototype.resolve
  vi.spyOn(ConnectionSecrets.prototype, 'resolve').mockImplementation(async function (this: ConnectionSecrets, current) {
    const value = await resolve.call(this, current)
    if (!held && current === ref) { held = true; entered(); await gate }
    return value
  })
  const pending = f.services.connections.setup!.advance(input, { actor, assertCurrent: () => { if (!authorized) throw new AgentMuxError('The current actor is no longer authorized', 'CONTROL_PERMISSION_DENIED') } }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  try {
    await waiting
    if (change === 'pending' || change === 'visibility') await f.read(change === 'pending' ? 'publication-pending' : 'publication-visibility')
    else if (change === 'target') await f.sdk.call('connection.configure', { operationId: 'publication-target-revised', expectedRevision: f.saved.connection.revision, connection: { ...f.saved.connection.config, label: 'Revised publication target' } })
    else authorized = false
  } finally { release() }
  expect((await pending).error?.code).toBe(change === 'actor' ? 'CONTROL_PERMISSION_DENIED' : 'CONNECTION_SETUP_ACTION_STALE')
  expect(f.native.filter(call => call.path.includes('/app_version/create/'))).toEqual([])
  expect(db.prepare("SELECT count(*) AS count FROM connection_setup_inspection WHERE json_extract(record_json,'$.effect')='create-application-version'").get()!.count).toBe(0)
}, 30_000)


it('submission reviews the selected version own notes, entries and sharing instead of pending or online values', async () => {
  const f = await fixture(), offered = await prepareSubmission(f)
  expect(offered.applicationConfiguration).toMatchObject({ effect: 'submit-application-version', review: { selectedVersion: { versionId: VERSION, notes: 'Original selected version release notes' }, entries: { desktop: { current: 'desktop-existing' }, mobile: { current: null } }, sharing: { kind: 'split', groups: false, direct: true, directReview: true }, changes: expect.arrayContaining([{ category: 'sharing', details: expect.arrayContaining(['Sharing with other organizations will be enabled']) }]) } })
  const before = f.native.length
  await f.sdk.call('connection.setup.advance', { ...action(offered, 'submit-application-version'), publicationDraft: { kind: 'submit-version', versionId: VERSION, fullRelease: false } })
  expect(f.native.slice(before)).toEqual([{ path: '/developers/v1/publish/commit/' + APP + '/' + VERSION, body: { is_full_release: false } }])
}, 30_000)

const initialDraft = { kind: 'create-version', version: '1.0.0', notes: 'Enable the original creator to use this bot.', visibility: 'creator-only', desktopEntry: 'bot', mobileEntry: 'bot' } as const
it('the original Enrollment creator creates and submits the first bot version through SDK and compiled CLI without unrelated reads', async () => {
  const f = await fixture({ enrollment: true }), before = f.native.length
  const first = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', 'create-application-version'])
  expect(first.applicationConfiguration).toMatchObject({ requiredSubjects: ['publication-versions'], capability: 'unknown' })
  await f.read('publication-versions')
  const reviewed = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', 'create-application-version', '--publication-draft', '-'], initialDraft)
  expect(reviewed.applicationConfiguration).toMatchObject({ capability: 'disabled', requiredSubjects: ['publication-versions'], review: { versions: [], audience: null, proposedAudience: { include: { people: ['publication-user'] } }, sharing: null, reasonRequired: null, issues: [] } })
  expect(Object.keys((reviewed.applicationConfiguration as any).sources)).toEqual(['versions'])
  const input = { ...action(reviewed, 'create-application-version'), publicationDraft: initialDraft }
  const originalStore = ConnectionSecrets.prototype.store
  const ack = vi.spyOn(ConnectionSecrets.prototype, 'store').mockImplementation(async function (value) {
    const result = await originalStore.call(this, value)
    if (value.operationId.startsWith('connection-setup-effect:')) throw Error('Controlled secure acknowledgement loss')
    return result
  })
  const created = await f.sdk.call('connection.setup.advance', input)
  ack.mockRestore()
  expect(created.applicationConfiguration!.selected).toMatchObject({ request: 'confirmed', secureStorage: 'unknown', versionId: VERSION, sourceStepIds: { versions: expect.any(String) } })
  const count = f.native.length
  await f.close()
  const owner = await createConnectionServices({ directory: f.directory, encryption: enrollmentEncryption() })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'owner.sock'), connections: owner.connections, coreClients: () => { throw Error('Publication recovery cannot borrow an Agent Runtime') } })
  await server.start(); clean.push(async () => { await server.stop(); owner.close() })
  const current = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', 'create-application-version'])
  const recovered = await f.cli(['advance', '--input', '-'], { ...action(current, 'recover-configuration-effect'), publicationDraft: initialDraft })
  expect(recovered.applicationConfiguration!.selected).toMatchObject({ request: 'confirmed', secureStorage: 'stored', versionId: VERSION })
  expect(f.native).toHaveLength(count)
  const draft = { kind: 'submit-version', versionId: VERSION, fullRelease: false } as const
  const offered = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-inspection', '--version-id', VERSION, '--application-configuration', 'submit-application-version', '--publication-draft', '-'], draft)
  await f.cli(['advance', '--input', '-'], { ...action(offered, 'read-publication-version'), versionId: VERSION })
  const submit = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', 'submit-application-version', '--publication-draft', '-'], draft)
  expect(submit.applicationConfiguration).toMatchObject({ requiredSubjects: ['publication-version'], capability: 'disabled', review: { issues: [], selectedVersion: { versionId: VERSION, status: 'draft' }, sharing: null } })
  const submitted = await f.cli(['advance', '--input', '-'], { ...action(submit, 'submit-application-version'), publicationDraft: draft })
  expect(submitted.applicationConfiguration!.selected).toMatchObject({ request: 'confirmed', secureStorage: 'stored', sourceStepIds: { version: expect.any(String) }, submission: { outcome: 'accepted' } })
  expect(f.native.slice(before)).toEqual([
    { path: '/developers/v1/app_version/list/' + APP, body: {} },
    { path: '/developers/v1/app_version/create/' + APP, body: { appVersion: initialDraft.version, changeLog: initialDraft.notes, pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot', visibleSuggest: { departments: [], members: ['publication-user'], groups: [], isAll: 0 }, blackVisibleSuggest: { departments: [], members: [], groups: [], isAll: 0 } } },
    { path: '/developers/v1/app_version/detail/' + APP + '/' + VERSION, body: {} },
    { path: '/developers/v1/publish/commit/' + APP + '/' + VERSION, body: { clientId: APP } }
  ])
}, 30_000)

it('missing creator, an unknown list, any existing version and incomplete first intent cannot borrow the reduced create action', async () => {
  const ordinary = await fixture(); ordinary.versions.splice(0)
  await ordinary.read('publication-versions')
  const inspect = (f: Awaited<ReturnType<typeof fixture>>, draft = initialDraft) => f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'create-application-version', draft } })
  expect((await inspect(ordinary)).applicationConfiguration).toMatchObject({ capability: 'unknown', requiredSubjects: [...creationSubjects], actions: [] })
  await ordinary.close()
  const f = await fixture({ enrollment: true })
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (...args) => new URL(String(args[0])).pathname === '/developers/v1/app_version/list/' + APP ? new Response('List unavailable', { status: 502 }) : original(...args))
  await f.read('publication-versions')
  expect((await inspect(f)).applicationConfiguration).toMatchObject({ capability: 'unknown', actions: [] })
  vi.mocked(fetch).mockImplementation(original)
  f.versions.push({ versionId: 'existing-draft', appVersion: '1.0.0', versionStatus: 4 })
  await f.read('publication-versions')
  expect((await inspect(f)).applicationConfiguration).toMatchObject({ capability: 'unknown', requiredSubjects: [...creationSubjects], actions: [] })
  f.versions.splice(0); await f.read('publication-versions')
  for (const draft of [{ ...initialDraft, mobileEntry: 'web-app' }, { ...initialDraft, desktopEntry: undefined }, { ...initialDraft, visibility: 'current' as const }]) {
    const view = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'create-application-version', draft } })
    expect(view.applicationConfiguration).toMatchObject({ capability: 'unknown', actions: [] })
  }
  const ready = await inspect(f); f.accept(false)
  const unknown = await f.sdk.call('connection.setup.advance', { ...action(ready, 'create-application-version'), publicationDraft: initialDraft })
  expect(unknown.applicationConfiguration!.selected).toMatchObject({ request: 'unknown', versionId: null })
  f.accept(true)
  const offered = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: { versionId: VERSION } })
  await f.sdk.call('connection.setup.advance', { ...action(offered, 'read-publication-version'), versionId: VERSION })
  const submission = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'submit-application-version', draft: { kind: 'submit-version', versionId: VERSION, fullRelease: false } } })
  expect(submission.applicationConfiguration).toMatchObject({ capability: 'unknown', requiredSubjects: ['publication-version', 'publication-versions', 'publication-features'], actions: [] })
}, 30_000)

it('renewed current accounts must retain the original creator user and tenant for reduced publication', async () => {
  const f = await fixture({ enrollment: true })
  const renew = async (account: { userId: string; tenantId: string; userName: string }) => {
    f.account(account)
    let view = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId })
    view = await f.sdk.call('connection.setup.advance', action(view, 'renew'))
    for (let hop = 0; hop < 8 && view.continuation?.stage !== 'account'; hop++) {
      if (view.challenge && view.challenge.nextPollAt > Date.now()) await new Promise(resolve => setTimeout(resolve, view.challenge!.nextPollAt - Date.now()))
      view = await f.sdk.call('connection.setup.advance', action(view, 'continue'))
    }
    expect(view.continuation?.account).toMatchObject(account)
    await f.sdk.call('connection.setup.advance', action(view, 'confirm-account'))
    await f.read('publication-versions')
    return f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'create-application-version', draft: initialDraft } })
  }
  for (const account of [{ userId: 'another-user', tenantId: 'publication-enterprise', userName: 'Original creator' }, { userId: 'publication-user', tenantId: 'another-enterprise', userName: 'Original creator' }]) {
    expect((await renew(account)).applicationConfiguration).toMatchObject({ capability: 'unknown', requiredSubjects: [...creationSubjects], actions: [], review: { creatorAudienceAvailable: true } })
  }
  expect((await renew({ userId: 'publication-user', tenantId: 'publication-enterprise', userName: 'Changed display name' })).applicationConfiguration).toMatchObject({ capability: 'disabled', requiredSubjects: ['publication-versions'], actions: [{ kind: 'create-application-version' }] })
}, 30_000)
