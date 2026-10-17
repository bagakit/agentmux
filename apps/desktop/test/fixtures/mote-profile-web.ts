import { moteEnrollmentWeb } from './mote-enrollment-web'

/** Real Console HTTP boundary, controlled accounts and app state; never contacts the platform. */
export function moteProfileWeb() {
  const original = moteEnrollmentWeb(), requests: Array<{ path: string; body: any }> = []
  const base = { name: 'Before', desc: 'Before description', primaryLang: 'zh_cn', langs: ['zh_cn', 'en_us'], avatar: 'https://images.example.invalid/before.png', i18n: { zh_cn: { name: 'Before', description: 'Before description', help: 'keep' }, en_us: { name: 'Before English', description: 'Keep translation' } } }
  let current = structuredClone(base), uploaded = false, written = false, submitted = false, failed: string | null = null
  let hold: { stage: string; entered: () => void; released: Promise<void> } | null = null
  const oldVersion = { versionId: 'original-online', appVersion: '1.0.0', versionStatus: 2 }
  const newVersion = { versionId: 'profile-version', appVersion: '1.0.1', versionStatus: 0 }
  let created = false
  const audience = { isAll: 0, departments: [{ id: 'original-department' }], members: [{ id: 'original-member' }], groups: [{ id: 'original-group' }] }
  const excluded = { isAll: 0, departments: [{ id: 'excluded-department' }], members: [], groups: [] }
  const pending = { pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot', pcDefaultAbilityList: ['bot'], mobileDefaultAbilityList: ['bot'], equalToVisible: true,
    applyReasonConfig: { apiPrivilegeNeedReason: false, dataPrivilegeNeedReason: false, contactPrivilegeNeedReason: false, isContactExpand: false, visibleScopeNeedReason: false, isDataPrivilegeExpandMap: {} },
    changeEventConfig: { changed: false, eventModeChanged: false }, changeBotCardCallbackConfig: { abilityEnableState: 2 }, changeExtension: {}, changePrivilege: { changed: false }, changeAllowRefreshToken: { changed: false },
    ChangeScope: { addScopesV2: [], removeScopesV2: [], addTenantTypeScopes: [], removeTenantTypeScopes: [], addUserTypeScopes: [], removeUserTypeScopes: [] }, changeAppShareConfig: { changed: false }
  }
  const fetch = async (url: string | URL | Request, input: RequestInit = {}) => {
    const target = new URL(url instanceof Request ? url.url : String(url)), path = target.pathname
    if (!path.startsWith('/developers/v1/') || path === '/developers/v1/manifest/upsert_by_template' || path.includes('/secret/')) return original.fetch(url, input)
    const headers = new Headers(input.headers)
    if (target.origin !== 'https://open.feishu.cn' || input.method !== 'POST' || !headers.get('cookie')?.includes('mote-session=') || !headers.get('x-csrf-token')?.startsWith('private-mote-csrf-')) throw Error('Unqualified profile management request')
    const body = typeof input.body === 'string' ? JSON.parse(input.body) : input.body
    requests.push({ path, body })
    if (hold && path.includes(hold.stage)) { hold.entered(); await hold.released }
    if (failed && path.includes(failed)) return new Response(null, { status: 502 })
    const reply = (data: unknown) => Response.json({ code: 0, data })
    if (path === '/developers/v1/app/upload/image') { uploaded = true; return reply({ url: 'https://images.example.invalid/profile-upload.png' }) }
    if (/\/developers\/v1\/app\/[^/]+$/u.test(path)) return reply(current)
    if (path.includes('/app_role/permission/')) return reply({ roleType: 1, permission: { '1': { readResource: { 'app.info': true }, writeResource: { 'app.info': true } } } })
    if (path.includes('/visible/online/')) return reply({ whiteList: audience, blackList: excluded })
    if (path.includes('/app_version/list/')) return reply({ versions: created ? [{ ...newVersion, versionStatus: submitted ? 2 : 0 }, oldVersion] : [oldVersion] })
    if (path.includes('/base_info/')) { current = { ...current, name: body.name, desc: body.desc, langs: body.languages, i18n: body.i18n, avatar: body.avatar ?? current.avatar }; written = true; return reply({}) }
    if (path.includes('/app_version/change/')) return reply(pending)
    if (path.includes('/b2c_share/')) return reply({ onlineB2CShareEnable: false })
    if (path === '/developers/v1/developer_panel/config') return reply({ hitFeatureKeyList: [] })
    if (path.includes('/app_version/create/')) { created = true; return reply({ versionId: newVersion.versionId }) }
    if (path.includes('/publish/commit/')) { submitted = true; return reply({ isOk: true, avatar: current.avatar, urlConflict: false }) }
    if (path.includes('/app_version/detail/')) return reply({ ...pending, ...newVersion, versionStatus: submitted ? 2 : 0, visibleRange: { whiteList: audience, blackList: excluded }, changeScope: pending.ChangeScope, b2cShareEnable: false })
    throw Error('Unexpected controlled profile route: ' + path)
  }
  return { ...original, fetch, requests, audience, excluded, base,
    get begins() { return original.begins }, get authentications() { return original.authentications }, get creates() { return original.creates },
    get current() { return current }, get uploaded() { return uploaded }, get written() { return written }, get submitted() { return submitted },
    fail(stage: string | null) { failed = stage },
    hold(stage: string) { let entered!: () => void, release!: () => void; const arrived = new Promise<void>(resolve => { entered = resolve }), released = new Promise<void>(resolve => { release = resolve }); hold = { stage, entered, released }; return { arrived, release: () => { hold = null; release() } } }
  }
}
