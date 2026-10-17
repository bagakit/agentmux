import { createHash } from 'node:crypto'
import { CookieJar } from 'tough-cookie'
import { afterEach, expect, it, vi } from 'vitest'
import { FeishuAdapter } from '@agentmux/connectors/adapters/feishu'
import { imagePng } from '../../../apps/desktop/test/fixtures/mote-identity-image.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const appId = 'cli_profile_console', avatar = 'https://images.example.invalid/updated.png'
const png = imagePng(), pngDataUrl = 'data:image/png;base64,' + png.toString('base64'), avatarSha256 = createHash('sha256').update(png).digest('hex')
const base = { name: 'Original name', desc: 'Original summary', primaryLang: 'zh_cn', langs: ['en_us', 'zh_cn'], avatar: 'https://images.example.invalid/original.png', i18n: {
  en_us: { name: 'Original English', description: 'Keep translation', help_use: 'Keep help', extra: { preserved: true } },
  zh_cn: { name: 'Original name', description: 'Original summary', help_use: 'Keep primary help' },
  ja_jp: { name: 'Unconfigured locale', description: 'Keep extra locale block' }
} }
const desired = { name: 'Saved Mote', description: '', avatarSha256 }
const uploaded = JSON.stringify({ url: avatar, width: 256, height: 256, sha256: avatarSha256 })
const leaf = () => new FeishuAdapter().setup.applicationConfiguration!.applicationProfile!
function scope(origin = 'https://open.feishu.cn') {
  const cookies = new CookieJar()
  cookies.setCookieSync('session=synthetic-console-session; Path=/; Secure', origin)
  cookies.setCookieSync('foreign=synthetic-other-domain; Path=/; Secure', 'https://accounts.feishu.cn')
  const input = { operationId: 'original-profile-setup', connectionId: 'original-profile-connection', attemptId: 'original-authentication-attempt', application: { domain: 'open.feishu.cn', appId }, assertCurrent: vi.fn() }
  return { ...input, privateState: JSON.stringify({ ...input, assertCurrent: undefined, version: 2, phase: 'account', hops: 0, flowKey: 'synthetic-flow', token: 'synthetic-token', consoleOrigin: origin, url: origin + '/app', csrf: 'synthetic-csrf', account: { userId: 'synthetic-user', tenantId: 'synthetic-tenant' }, cookieJar: cookies.serializeSync() }) }
}
function wire(response: (path: string, init: RequestInit) => Response | Promise<Response> = () => Response.json({ code: 0, data: {} })) {
  const calls: Array<{ target: URL; init: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init: RequestInit) => {
    const target = new URL(String(url)); calls.push({ target, init })
    return response(target.pathname, init)
  }))
  return calls
}

it('freezes one full multilingual base_info body, changing all configured names and only the primary description', async () => {
  const calls = wire(), original = structuredClone(base)
  const pending = await leaf().plan(desired, JSON.stringify(base))
  expect(pending).toEqual({ baseline: 'confirmed', privateIntent: null, matches: 'unknown' })
  const plan = await leaf().plan(desired, JSON.stringify(base), uploaded)
  expect(plan).toMatchObject({ baseline: 'confirmed', matches: 'different' })
  expect(JSON.parse(plan.privateIntent!)).toEqual({ kind: 'update-application-profile', body: { name: 'Saved Mote', desc: '', languages: ['en_us', 'zh_cn'], avatar, i18n: {
    en_us: { ...base.i18n.en_us, name: 'Saved Mote' },
    zh_cn: { ...base.i18n.zh_cn, name: 'Saved Mote', description: '' },
    ja_jp: base.i18n.ja_jp
  } } })
  expect(base).toEqual(original); expect(calls).toHaveLength(0)
})

it.each([
  { ...base, langs: undefined }, { ...base, langs: ['zh_cn', 'zh_cn'] }, { ...base, primaryLang: undefined },
  { ...base, primaryLang: 'ja_jp' }, { ...base, desc: undefined }, { ...base, i18n: { zh_cn: base.i18n.zh_cn } }
])('never qualifies an upload from an incomplete full replacement source: %j', async source => {
  const calls = wire()
  expect(await leaf().plan(desired, JSON.stringify(source))).toEqual({ baseline: 'unknown', privateIntent: null, matches: 'unknown' })
  expect(calls).toHaveLength(0)
})

it('compares a fresh read independently and never treats a missing or foreign upload receipt as a no-avatar change', async () => {
  const p = leaf(), first = await p.plan(desired, JSON.stringify(base), uploaded), body = JSON.parse(first.privateIntent!).body
  const current = { ...base, name: body.name, desc: body.desc, i18n: body.i18n, avatar: body.avatar }
  expect(await p.plan(desired, JSON.stringify(current), uploaded)).toMatchObject({ matches: 'matched' })
  expect(await p.plan(desired, JSON.stringify({ ...current, avatar: base.avatar }), uploaded)).toMatchObject({ matches: 'different' })
  expect(await p.plan(desired, JSON.stringify(current))).toEqual({ baseline: 'confirmed', privateIntent: null, matches: 'unknown' })
  expect(await p.plan(desired, JSON.stringify(current), JSON.stringify({ url: avatar, sha256: 'f'.repeat(64) }))).toEqual({ baseline: 'confirmed', privateIntent: null, matches: 'unknown' })
  const nameOnly = await p.plan({ name: 'Name only' }, JSON.stringify(base))
  expect(JSON.parse(nameOnly.privateIntent!).body).toMatchObject({ desc: base.desc, avatar: base.avatar, i18n: { en_us: { description: 'Keep translation' }, zh_cn: { description: 'Original summary' } } })
})

it.each(['https://open.feishu.cn', 'https://open.larkoffice.com'])('uses only the original %s Console for exact multipart image and full profile requests', async origin => {
  const calls = wire(path => Response.json({ code: 0, data: path.endsWith('/upload/image') ? { url: avatar } : {} })), input = scope(origin), p = leaf()
  const receipt = await p.uploadAvatar({ ...input, pngDataUrl })
  expect(receipt.kind).toBe('accepted')
  if (receipt.kind !== 'accepted') throw Error('Original upload receipt missing')
  expect(JSON.parse(receipt.privateState)).toEqual({ url: avatar, width: 256, height: 256, sha256: avatarSha256 })
  const plan = await p.plan(desired, JSON.stringify(base), receipt.privateState)
  expect(await p.update({ ...input, privateIntent: plan.privateIntent! })).toMatchObject({ kind: 'accepted' })
  expect(calls.map(call => call.target.href)).toEqual([origin + '/developers/v1/app/upload/image', origin + '/developers/v1/base_info/' + appId])
  for (const { init } of calls) {
    const headers = new Headers(init.headers)
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('manual')
    expect(headers.get('origin')).toBe(origin); expect(headers.get('referer')).toBe(origin + '/app/' + appId)
    expect(headers.get('cookie')).toBe('session=synthetic-console-session'); expect(headers.get('x-csrf-token')).toBe('synthetic-csrf')
  }
  const form = calls[0]!.init.body as FormData, image = form.get('file') as File
  expect(form.get('uploadType')).toBe('4'); expect(form.get('isIsv')).toBe('false')
  expect(JSON.parse(String(form.get('scale')))).toEqual({ width: 256, height: 256 })
  expect(image.name).toBe('avatar.png'); expect(image.type).toBe('image/png'); expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ clientId: appId, ...JSON.parse(plan.privateIntent!).body })
  expect(input.assertCurrent).toHaveBeenCalledTimes(2)
})

it('does not send malformed images, foreign authentication bindings, or invalid frozen profile bodies', async () => {
  const calls = wire(), input = scope(), p = leaf()
  expect(await p.uploadAvatar({ ...input, pngDataUrl: 'data:image/png;base64,aW52YWxpZA==' })).toEqual({ kind: 'unknown' })
  const plan = await p.plan({ name: 'Desired' }, JSON.stringify(base))
  expect(await p.update({ ...input, application: { ...input.application, appId: 'cli_foreign' }, privateIntent: plan.privateIntent! })).toEqual({ kind: 'unknown' })
  expect(await p.update({ ...input, privateIntent: JSON.stringify({ kind: 'update-application-profile', body: { ...JSON.parse(plan.privateIntent!).body, clientId: 'cli_foreign' } }) })).toEqual({ kind: 'unknown' })
  expect(calls).toHaveLength(0)
})

it.each(['upload', 'update'] as const)('retains actual %s HTTP failure facts without raw errors or success claims', async stage => {
  const calls = wire(() => new Response('synthetic private upstream body', { status: 502 })), p = leaf(), input = scope()
  const plan = await p.plan({ name: 'Desired' }, JSON.stringify(base))
  const reply = stage === 'upload' ? await p.uploadAvatar({ ...input, pngDataUrl }) : await p.update({ ...input, privateIntent: plan.privateIntent! })
  expect(reply).toEqual({ kind: 'unknown', diagnostic: { code: 'http-status', httpStatus: 502 } })
  expect(calls).toHaveLength(1); expect(JSON.stringify(reply)).not.toMatch(/private|synthetic|url|headers|body/)
})

it('preserves platform rejection and cancellation as separate finite facts without retrying a leaf', async () => {
  const calls = wire(() => Response.json({ code: 10003, msg: 'synthetic private denial' })), p = leaf(), input = scope()
  expect(await p.uploadAvatar({ ...input, pngDataUrl })).toEqual({ kind: 'unknown', diagnostic: { code: 'platform-error', httpStatus: 200 } })
  expect(calls).toHaveLength(1)
  const controller = new AbortController(); controller.abort()
  expect(await p.uploadAvatar({ ...input, pngDataUrl }, controller.signal)).toEqual({ kind: 'unknown', diagnostic: { code: 'cancelled' } })
  expect(calls).toHaveLength(1)
})

const audience = { whiteList: { departments: [{ id: 7 }], members: [{ id: 'original-member' }], groups: [{ id: 'original-group' }], isAll: 0 }, blackList: { departments: [], members: [{ id: 'excluded-member' }], groups: [], isAll: 0 } }
function publicationStates() {
  const pending = { ChangeScope: { addScopesV2: [], removeScopesV2: [], addTenantTypeScopes: [], removeTenantTypeScopes: [], addUserTypeScopes: [], removeUserTypeScopes: [] }, changeEventConfig: { changed: false, eventModeChanged: false }, changeBotCardCallbackConfig: { abilityEnableState: 2 }, changeExtension: {}, changePrivilege: { changed: false }, changeAllowRefreshToken: { changed: false }, pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot', pcDefaultAbilityList: ['bot'], mobileDefaultAbilityList: ['bot'], equalToVisible: false, applyReasonConfig: { apiPrivilegeNeedReason: false, dataPrivilegeNeedReason: false, isDataPrivilegeExpandMap: {}, contactPrivilegeNeedReason: false, isContactExpand: false, visibleScopeNeedReason: false } }
  return { pending: JSON.stringify(pending), versions: JSON.stringify({ versions: [{ versionId: 'online-original', appVersion: '1.0.9', versionStatus: 2 }, { versionId: 'old-draft', appVersion: '1.0.11', versionStatus: 0 }] }), visibility: JSON.stringify(audience), sharing: JSON.stringify({ onlineB2CShareEnable: false }), features: JSON.stringify({ hitFeatureKeyList: [] }) }
}

function profilePublicationStates() {
  const states = publicationStates(), pending = JSON.parse(states.pending)
  delete pending.pcDefaultAbilityList
  delete pending.mobileDefaultAbilityList
  delete pending.applyReasonConfig
  delete pending.equalToVisible
  return { ...states, pending: JSON.stringify(pending), versions: JSON.stringify({ versions: [{ appVersion: '1.0.9', versionStatus: 2 }, { appVersion: '1.0.11', versionStatus: 0 }] }) }
}

it('creates and submits the original profile version from reliable numbers and unchanged entries without manual form metadata', async () => {
  const configuration = new FeishuAdapter().setup.applicationConfiguration!, states = profilePublicationStates(), p = configuration.applicationProfile!
  const draft = await p.publicationDraft(states, 'Original profile update.')
  expect(draft).toEqual({ kind: 'create-version', version: '1.0.12', notes: 'Original profile update.', visibility: 'current' })
  const provenance = { creatorIsCurrent: false, initialVersion: null, profileUpdate: { readbackStepId: 'original-matched-readback', createdVersion: null } }
  const plan = await configuration.publicationPlan('create-application-version', states, draft, null, provenance)
  expect(plan.review.issues).toEqual([])
  expect(plan.review.reasonRequired).toBeNull()
  expect(plan.review.entries).toEqual({ desktop: { current: 'bot', choices: [] }, mobile: { current: 'bot', choices: [] } })
  const calls = wire(path => Response.json({ code: 0, data: path.includes('/create/') ? { versionId: 'profile-created-version' } : {} })), input = scope()
  expect(await configuration.createVersion({ ...input, privateIntent: plan.privateIntent! })).toMatchObject({ kind: 'accepted', versionId: 'profile-created-version' })
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ appVersion: '1.0.12', changeLog: 'Original profile update.', pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot', visibleSuggest: { departments: [7], members: ['original-member'], groups: ['original-group'], isAll: 0 }, blackVisibleSuggest: { departments: [], members: ['excluded-member'], groups: [], isAll: 0 }, b2cShareSuggest: false })
  const detail = { appVersion: '1.0.12', versionStatus: 0, versionId: 'profile-created-version', visibleRange: audience }
  const submit = await configuration.publicationPlan('submit-application-version', { ...states, version: JSON.stringify(detail) }, { kind: 'submit-version', versionId: detail.versionId, fullRelease: false }, null, { ...provenance, profileUpdate: { ...provenance.profileUpdate, createdVersion: { versionId: detail.versionId, draft: draft! } } })
  expect(await configuration.submitVersion({ ...input, privateIntent: submit.privateIntent! })).toMatchObject({ kind: 'accepted', versionId: detail.versionId })
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ clientId: appId })
  expect(calls.map(call => call.target.pathname)).toEqual(['/developers/v1/app_version/create/' + appId, '/developers/v1/publish/commit/' + appId + '/' + detail.versionId])
})

it('preserves actual current entries and the feature-selected split sharing settings in a profile release', async () => {
  const states = profilePublicationStates(), pending = JSON.parse(states.pending)
  pending.pcDefaultAbility = 'webapp'; pending.mobileDefaultAbility = ''
  states.pending = JSON.stringify(pending)
  states.features = JSON.stringify({ hitFeatureKeyList: ['openplatform.b2c.bot_b2c_share_switch_split'] })
  const split = { b2cGroupChatShareEnable: true, b2cP2PChatShareEnable: false, b2cP2PChatNeedAudit: true }
  states.sharing = JSON.stringify({ onlineB2CShareSplitConfig: split })
  const configuration = new FeishuAdapter().setup.applicationConfiguration!, draft = await configuration.applicationProfile!.publicationDraft(states, 'Original profile update.')
  expect(draft).not.toBeNull()
  const plan = await configuration.publicationPlan('create-application-version', states, draft, null, { creatorIsCurrent: false, initialVersion: null, profileUpdate: { readbackStepId: 'original-readback', createdVersion: null } })
  const body = JSON.parse(plan.privateIntent!).body
  expect(body.pcDefaultAbility).toBe('webapp')
  expect(body).not.toHaveProperty('mobileDefaultAbility')
  expect(body.b2cShareSplitConfigSuggest).toEqual(split)
  expect(body).not.toHaveProperty('b2cShareSuggest')
  expect(body).not.toHaveProperty('applyReasonConfig')
  const changedEntry = await configuration.publicationPlan('create-application-version', states, { ...draft!, desktopEntry: 'bot' }, null, { creatorIsCurrent: false, initialVersion: null, profileUpdate: { readbackStepId: 'original-readback', createdVersion: null } })
  expect(changedEntry.privateIntent).toBeNull()
})

it.each(['versions', 'version-number', 'desktop-entry', 'mobile-entry', 'audience', 'sharing', 'split-sharing', 'features'] as const)('keeps an absent required %s source unconfirmed for profile publication', async missing => {
  const states = profilePublicationStates(), pending = JSON.parse(states.pending)
  if (missing === 'versions') states.versions = '{}'
  if (missing === 'version-number') states.versions = JSON.stringify({ versions: [{}] })
  if (missing === 'desktop-entry') { delete pending.pcDefaultAbility; states.pending = JSON.stringify(pending) }
  if (missing === 'mobile-entry') { delete pending.mobileDefaultAbility; states.pending = JSON.stringify(pending) }
  if (missing === 'audience') states.visibility = JSON.stringify({ whiteList: audience.whiteList })
  if (missing === 'sharing') states.sharing = '{}'
  if (missing === 'features') states.features = '{}'
  if (missing === 'split-sharing') states.features = JSON.stringify({ hitFeatureKeyList: ['openplatform.b2c.bot_b2c_share_switch_split'] })
  const calls = wire()
  expect(await leaf().publicationDraft(states, 'Original profile update.')).toBeNull()
  expect(calls).toHaveLength(0)
})

it.each(['api', 'contact', 'data'] as const)('retains known %s review-reason requirements and additional pending changes despite missing unrelated policy fields', async kind => {
  const states = profilePublicationStates(), pending = JSON.parse(states.pending)
  pending.ChangeScope.addScopesV2 = ['original-added-scope']
  pending.applyReasonConfig = kind === 'api' ? { apiPrivilegeNeedReason: true } : kind === 'contact' ? { contactPrivilegeNeedReason: true, isContactExpand: true } : { dataPrivilegeNeedReason: true, isDataPrivilegeExpandMap: { original: true } }
  states.pending = JSON.stringify(pending)
  const configuration = new FeishuAdapter().setup.applicationConfiguration!, draft = { kind: 'create-version' as const, version: '1.0.12', notes: 'Original profile update.', visibility: 'current' as const }
  const provenance = { creatorIsCurrent: false, initialVersion: null, profileUpdate: { readbackStepId: 'original-readback', createdVersion: null } }
  const review = await configuration.publicationPlan('create-application-version', states, draft, null, provenance)
  expect(review.privateIntent).toBeNull()
  expect(review.review.reasonRequired).toBe(true)
  expect(review.review.changes).toContainEqual({ category: 'permissions', details: ['Add permission: original-added-scope'] })
  const accepted = await configuration.publicationPlan('create-application-version', states, { ...draft, reason: 'Original explicit review reason.' }, null, provenance)
  expect(accepted.review.changes).toEqual(review.review.changes)
  const body = JSON.parse(accepted.privateIntent!).body
  expect(body.remark).toBe('Original explicit review reason.')
  expect(body).not.toHaveProperty('applyReasonConfig')
})

it('keeps the full manual publication form and its source requirements unchanged', async () => {
  const configuration = new FeishuAdapter().setup.applicationConfiguration!, states = publicationStates()
  const draft = { kind: 'create-version' as const, version: '1.0.12', notes: 'Manual review.', visibility: 'current' as const }
  const complete = await configuration.publicationPlan('create-application-version', states, draft, null)
  expect(JSON.parse(complete.privateIntent!).body).toMatchObject({ autoPublish: false, applyReasonConfig: JSON.parse(states.pending).applyReasonConfig })
  const incomplete = await configuration.publicationPlan('create-application-version', profilePublicationStates(), draft, null)
  expect(incomplete.privateIntent).toBeNull()
  expect(incomplete.review.issues).toContain('The exact version list is unconfirmed')
  expect(incomplete.review.issues).toContain('Unconfirmed pc entry choices')
  expect(incomplete.review.issues).toContain('The original application review policy is incomplete')
})

it('derives the next original profile version and preserves full published audience without the initial creator shortcut', async () => {
  const configuration = new FeishuAdapter().setup.applicationConfiguration!, p = configuration.applicationProfile!, states = publicationStates()
  const draft = await p.publicationDraft(states, 'Update original bot identity.')
  expect(draft).toEqual({ kind: 'create-version', version: '1.0.12', notes: 'Update original bot identity.', visibility: 'current' })
  const provenance = { creatorIsCurrent: false, initialVersion: null, profileUpdate: { readbackStepId: 'original-matched-readback', createdVersion: null } }
  const plan = await configuration.publicationPlan('create-application-version', states, draft, null, provenance)
  const intent = JSON.parse(plan.privateIntent!)
  expect(intent.kind).toBe('create-profile-version'); expect(intent.body).not.toHaveProperty('autoPublish')
  expect(intent.body).toMatchObject({ appVersion: '1.0.12', visibleSuggest: { departments: [7], members: ['original-member'], groups: ['original-group'], isAll: 0 }, blackVisibleSuggest: { departments: [], members: ['excluded-member'], groups: [], isAll: 0 } })
  const calls = wire(path => Response.json({ code: 0, data: path.includes('/create/') ? { versionId: 'profile-created-version' } : {} })), input = scope()
  expect(await configuration.createVersion({ ...input, privateIntent: plan.privateIntent! })).toMatchObject({ kind: 'accepted', versionId: 'profile-created-version' })
  const detail = { ...JSON.parse(states.pending), appVersion: draft!.version, versionStatus: 0, versionId: 'profile-created-version', visibleRange: audience, pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot', changeAppShareConfig: { b2cShareSuggest: false } }
  const submission = await configuration.publicationPlan('submit-application-version', { ...states, version: JSON.stringify(detail) }, { kind: 'submit-version', versionId: 'profile-created-version', fullRelease: false }, null, { ...provenance, profileUpdate: { ...provenance.profileUpdate, createdVersion: { versionId: 'profile-created-version', draft: draft! } } })
  expect(JSON.parse(submission.privateIntent!)).toEqual({ kind: 'submit-profile-version', versionId: 'profile-created-version' })
  expect(await configuration.submitVersion({ ...input, privateIntent: submission.privateIntent! })).toMatchObject({ kind: 'accepted', versionId: 'profile-created-version' })
  expect(calls.map(call => call.target.pathname)).toEqual(['/developers/v1/app_version/create/' + appId, '/developers/v1/publish/commit/' + appId + '/profile-created-version'])
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ clientId: appId })
})

it.each([
  { versions: [{ versionId: 'old-label', appVersion: 'old-release', versionStatus: 2 }, { versionId: 'numeric', appVersion: '1.0.11', versionStatus: 0 }], expected: '1.0.12' },
  { versions: [{ versionId: 'old-label', appVersion: 'old-release', versionStatus: 2 }], expected: '0.0.1' },
  { versions: [], expected: '0.0.1' }
])('derives an unoccupied reference version without gating on unrelated historical labels: $expected', async ({ versions, expected }) => {
  const p = leaf(), states = { ...publicationStates(), versions: JSON.stringify({ versions }) }
  expect(await p.publicationDraft(states, 'Original update')).toMatchObject({ version: expected, visibility: 'current' })
  expect(await new FeishuAdapter().setup.applicationConfiguration!.publicationPlan('create-application-version', states, await p.publicationDraft(states, 'Original update'), null, { creatorIsCurrent: false, initialVersion: null, profileUpdate: { readbackStepId: 'original-readback', createdVersion: null } })).toMatchObject({ privateIntent: expect.any(String) })
})

it('does not derive profile publication from missing complete sources or change the original audience', async () => {
  const p = leaf(), states = publicationStates()
  for (const bad of [{ ...states, visibility: '{}' }, { ...states, versions: '{}' }, { ...states, pending: '{}' }]) expect(await p.publicationDraft(bad, 'Original update')).toBeNull()
  const configuration = new FeishuAdapter().setup.applicationConfiguration!, draft = (await p.publicationDraft(states, 'Original update'))!
  const changedAudience = await configuration.publicationPlan('create-application-version', states, { ...draft, visibility: 'creator-only' }, { userId: 'creator', tenantId: 'tenant' }, { creatorIsCurrent: true, initialVersion: null, profileUpdate: { readbackStepId: 'original-readback', createdVersion: null } })
  expect(changedAudience.privateIntent).toBeNull()
})
