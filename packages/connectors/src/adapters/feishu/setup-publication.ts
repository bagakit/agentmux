import { connectionSetupPublicationSubjects } from '@agentmux/core/connections'
import type { ConnectionSetupAccount, ConnectionSetupPublicationAudience, ConnectionSetupPublicationDraft, ConnectionSetupPublicationEffect, ConnectionSetupPublicationReview, ConnectionSetupSubmissionResponse, ConnectionSetupVersionStatus } from '@agentmux/core/connections'
import type { SetupPublicationPlan, SetupPublicationProvenance } from '../../connection-setup-adapter.js'

const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const nativeId = (v: unknown): v is string | number => typeof v === 'string' && !!v.trim() || typeof v === 'number' && Number.isSafeInteger(v)
const label = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\u0000-\u001f\u007f]/u.test(v)
export const feishuVersionStatus = (v: unknown): ConnectionSetupVersionStatus => v === 0 || v === 4 ? 'draft' : v === 1 ? 'reviewing' : v === 2 ? 'approved' : v === 3 ? 'rejected' : v === 5 ? 'awaiting-release' : 'unknown'
const read = (v: string | undefined) => { try { return v === undefined ? null : record(JSON.parse(v)) } catch { return null } }
function range(value: unknown): { native: Record<string, unknown>; public: ConnectionSetupPublicationAudience } | null {
  const r = record(value)
  if (!r || r.isAll !== 0 && r.isAll !== 1) return null
  const ids = (v: unknown) => {
    if (!Array.isArray(v)) return null
    const result = v.map(item => record(item)?.id)
    return result.every(nativeId) && new Set(result).size === result.length ? result : null
  }
  const departments = ids(r.departments), members = ids(r.members), groups = ids(r.groups)
  return departments && members && groups ? { native: { departments, members, groups, isAll: r.isAll }, public: { all: r.isAll === 1, departments, people: members, groups } } : null
}
function versionList(data: Record<string, unknown> | null): ConnectionSetupPublicationReview['versions'] | null {
  if (!Array.isArray(data?.versions)) return null
  const versions = data.versions.map(v => { const r = record(v); return r && label(r.versionId) && label(r.appVersion) ? { versionId: r.versionId, version: r.appVersion, status: feishuVersionStatus(r.versionStatus) } : null })
  return versions.every(v => v !== null) && new Set(versions.map(v => v.versionId)).size === versions.length ? versions : null
}
function changes(data: Record<string, unknown>, scopeKey: 'ChangeScope' | 'changeScope'): ConnectionSetupPublicationReview['changes'] {
  const result: ConnectionSetupPublicationReview['changes'] = []
  const note = (category: ConnectionSetupPublicationReview['changes'][number]['category'], detail: string) => { const current = result.find(item => item.category === category); if (current) { if (!current.details.includes(detail)) current.details.push(detail) } else result.push({ category, details: [detail] }) }
  // Diff-only fields are not write parameters. Missing optional metadata is disclosed, never invented.
  const event = record(data.changeEventConfig)
  if (!event || typeof event.changed !== 'boolean' || typeof event.eventModeChanged !== 'boolean') note('events', 'Event change details were not provided')
  else if (event.changed || event.eventModeChanged) note('events', 'Event subscriptions or delivery settings change')
  const callback = record(data.changeBotCardCallbackConfig), callbackCloud = record(callback?.cloudFuncConfig)
  if (!callback || ![0, 1, 2].includes(callback.abilityEnableState as number)) note('callbacks', 'Bot card callback change details were not provided')
  else if (callback.abilityEnableState !== 2 && callback.callbackMode !== 0) {
    if (![1, 2].includes(callback.callbackMode as number) || typeof callback.callbackModeChanged !== 'boolean' || callback.cloudFuncConfig !== undefined && (!callbackCloud || typeof callbackCloud.codeVersionChanged !== 'boolean')) note('callbacks', 'Bot card callback delivery or cloud function details were not provided')
    else if (callback.callbackModeChanged || callbackCloud?.codeVersionChanged) note('callbacks', 'Bot card callback delivery or cloud function changes')
  }
  const extension = record(data.changeExtension)
  if (!extension || Object.keys(extension).length && typeof extension.status !== 'boolean' && !(typeof extension.status === 'number' && Number.isSafeInteger(extension.status))) note('extensions', 'Application extension change details were not provided')
  else if (extension.status) note('extensions', 'Application extensions change')
  const privilege = record(data.changePrivilege)
  if (!privilege || typeof privilege.changed !== 'boolean') note('data-access', 'Data permission change details were not provided')
  else if (privilege.changed) {
    note('data-access', 'Data permissions change')
    if (Array.isArray(privilege.privileges)) for (const item of privilege.privileges) { const name = record(item)?.name; note('data-access', label(name) ? name : 'A changed data permission has no supplied name') }
    else note('data-access', 'Individual data permission details were not provided')
  }
  const contacts = record(data.contactRangeDetail)
  if (contacts && Object.keys(contacts).length) note('data-access', 'Contact access range changes')
  const refresh = record(data.changeAllowRefreshToken)
  if (!refresh || typeof refresh.changed !== 'boolean') note('refresh-tokens', 'Token refresh change details were not provided')
  else if (refresh.changed) note('refresh-tokens', refresh.allowRefreshToken === true ? 'User token refresh will be enabled' : refresh.allowRefreshToken === false ? 'User token refresh will be disabled' : 'The changed token refresh setting was not provided')
  const scope = record(data[scopeKey]), system = record(data.changeClientSystemScope)
  const diff = (value: Record<string, unknown> | null, key: string, title: string) => {
    const list = value?.[key]
    if (list === undefined) return
    if (!Array.isArray(list) || !list.every(nativeId)) { note('permissions', title + ' details were not provided in a supported form'); return }
    for (const id of list) note('permissions', title + ': ' + String(id))
  }
  if (!scope) note('permissions', 'Permission change lists were not provided')
  else {
    const keys = ['addScopesV2', 'removeScopesV2', 'addTenantTypeScopes', 'removeTenantTypeScopes', 'addUserTypeScopes', 'removeUserTypeScopes']
    for (const key of keys) diff(scope, key, key.startsWith('add') ? 'Add permission' : 'Remove permission')
    if (keys.some(key => scope[key] === undefined)) note('permissions', 'Some optional permission change lists were not provided')
  }
  if (system) { diff(system, 'addScopesV2', 'Add system permission'); diff(system, 'removeScopesV2', 'Remove system permission') }
  const sharing = record(data.changeAppShareConfig)
  if (sharing?.changed === true) note('sharing', 'External sharing settings change')
  const organizations = record(data.changeB2BShareConfig)
  if (organizations?.changed === true) note('sharing', organizations.status === true ? 'Sharing with other organizations will be enabled' : organizations.status === false ? 'Sharing with other organizations will be disabled' : 'The changed sharing setting for other organizations was not provided')
  return result
}
const validVersion = (v: string) => v.length <= 64 && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(v) && v !== '0.0.0'
const compare = (a: string, b: string) => { const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt); for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! > bb[i]! ? 1 : -1; return 0 }

/** The finite sourced form is interpreted here; the Host never fills native defaults. */
function reviewPublication(effect: ConnectionSetupPublicationEffect, states: Record<string, string>, draft: ConnectionSetupPublicationDraft | null, creator: ConnectionSetupAccount | null, provenance: SetupPublicationProvenance, profilePlanning = false): SetupPublicationPlan {
  const pending = read(states.pending), detail = read(states.version), features = read(states.features), versions = versionList(read(states.versions)), issues: string[] = []
  const review: ConnectionSetupPublicationReview = { versions: versions ?? [], selectedVersion: null, changes: [], audience: null, proposedAudience: null, entries: null, sharing: null, reasonRequired: null, creatorAudienceAvailable: creator !== null, issues }
  const { initialVersion, creatorIsCurrent, profileUpdate } = provenance
  const profileMode = Boolean(profileUpdate) || profilePlanning
  const profileVersion = profileMode ? nextProfileVersion(read(states.versions)) : null
  if (profileUpdate && !label(profileUpdate.readbackStepId)) issues.push('The original profile readback is unconfirmed')
  const requiredSubjects = [...connectionSetupPublicationSubjects(effect)]
  const initialDraft = (value: ConnectionSetupPublicationDraft | null) => value?.kind === 'create-version' && value.visibility === 'creator-only' && value.desktopEntry === 'bot' && value.mobileEntry === 'bot'
  // Only the original creator and a reliable empty list offer this finite first-version form.
  if (!profileMode && effect === 'create-application-version' && creator && creatorIsCurrent && (!states.versions || versions?.length === 0)) {
    if (!versions) { issues.push('The exact version list is unconfirmed'); return { review, privateIntent: null, requiredSubjects: ['publication-versions'] } }
    const empty = { all: false, departments: [], people: [], groups: [] }
    if (!draft || draft.kind === 'create-version' && draft.visibility === 'creator-only') {
      review.entries = { desktop: { current: null, choices: ['bot'] }, mobile: { current: null, choices: ['bot'] } }
      review.proposedAudience = { include: { ...empty, people: [creator.userId] }, exclude: empty }
      if (!initialDraft(draft)) issues.push('Explicitly choose creator-only visibility and bot entries for both platforms')
      if (draft?.kind === 'create-version') {
        if (!validVersion(draft.version)) issues.push('Use a new three-part version')
        if (!draft.notes.trim() || draft.notes.length > 500) issues.push('Release notes must contain between 1 and 500 characters')
        if (draft.reason !== undefined && (!draft.reason.trim() || draft.reason.length > 1000)) issues.push('Provide a valid application review reason')
      }
      return { review, requiredSubjects: ['publication-versions'], privateIntent: draft?.kind === 'create-version' && !issues.length ? JSON.stringify({ kind: 'create-initial-version', body: { appVersion: draft.version, changeLog: draft.notes, pcDefaultAbility: 'bot', mobileDefaultAbility: 'bot', visibleSuggest: { departments: [], members: [creator.userId], groups: [], isAll: 0 }, blackVisibleSuggest: { departments: [], members: [], groups: [], isAll: 0 }, ...(draft.reason === undefined ? {} : { remark: draft.reason }) } }) : null }
    }
  }
  // The Host supplies only its own confirmed, securely stored first-create receipt.
  if (!profileMode && effect === 'submit-application-version' && creator && creatorIsCurrent && initialVersion && initialDraft(initialVersion.draft) && draft?.kind === 'submit-version' && draft.versionId === initialVersion.versionId) {
    if (!detail || detail.versionId !== undefined && detail.versionId !== draft.versionId || !label(detail.appVersion)) issues.push('The exact selected version is unconfirmed')
    else {
      review.selectedVersion = { versionId: draft.versionId, version: detail.appVersion, status: feishuVersionStatus(detail.versionStatus), notes: typeof detail.changeLog === 'string' ? detail.changeLog : null }
      review.changes = changes(detail, 'changeScope')
      const visible = record(detail.visibleRange), include = range(visible?.whiteList), exclude = range(visible?.blackList)
      if (include && exclude) review.audience = review.proposedAudience = { include: include.public, exclude: exclude.public }
      if (![0, 3, 4].includes(detail.versionStatus as number)) issues.push('The selected version is not in a supported submittable state')
    }
    review.versions = []
    return { review, requiredSubjects: ['publication-version'], privateIntent: !issues.length ? JSON.stringify(draft.fullRelease ? { kind: 'submit-version', versionId: draft.versionId, body: { is_full_release: true } } : { kind: 'submit-initial-version', versionId: draft.versionId }) : null }
  }
  if (profileMode ? profileVersion === null : !versions) issues.push('The exact version list is unconfirmed')
  const featureReady = Array.isArray(features?.hitFeatureKeyList) && features.hitFeatureKeyList.every(label)
  const split = featureReady && (features!.hitFeatureKeyList as string[]).includes('openplatform.b2c.bot_b2c_share_switch_split')
  const splitSharing = (value: unknown): Extract<NonNullable<ConnectionSetupPublicationReview['sharing']>, { kind: 'split' }> | null => {
    const config = record(value)
    return config && ['b2cGroupChatShareEnable', 'b2cP2PChatShareEnable', 'b2cP2PChatNeedAudit'].every(k => typeof config[k] === 'boolean')
      ? { kind: 'split', groups: config.b2cGroupChatShareEnable as boolean, direct: config.b2cP2PChatShareEnable as boolean, directReview: config.b2cP2PChatNeedAudit as boolean } : null
  }
  if (!featureReady) issues.push('Application feature configuration is unconfirmed')
  if (effect === 'submit-application-version') {
    if (draft?.kind !== 'submit-version') { issues.push('Choose an exact version to review'); return { review, requiredSubjects, privateIntent: null } }
    if (!detail || detail.versionId !== undefined && detail.versionId !== draft.versionId || !label(detail.appVersion)) issues.push('The exact selected version is unconfirmed')
    else {
      review.selectedVersion = { versionId: draft.versionId, version: detail.appVersion, status: feishuVersionStatus(detail.versionStatus), notes: typeof detail.changeLog === 'string' ? detail.changeLog : null }
      const selectedEntry = (value: unknown) => typeof value === 'string' && (value === '' || label(value)) ? { current: value || null, choices: [] } : null
      review.entries = { desktop: selectedEntry(detail.pcDefaultAbility), mobile: selectedEntry(detail.mobileDefaultAbility) }
      const selectedShare = record(detail.changeAppShareConfig)
      if (featureReady) review.sharing = split ? splitSharing(selectedShare?.b2cShareSplitConfigSuggest) : typeof selectedShare?.b2cShareSuggest === 'boolean' ? { kind: 'combined', enabled: selectedShare.b2cShareSuggest } : null
      review.changes = changes(detail, 'changeScope')
      const visible = record(detail.visibleRange), include = range(visible?.whiteList), exclude = range(visible?.blackList)
      if (!include || !exclude) issues.push('The selected version visibility is incomplete')
      else review.audience = review.proposedAudience = { include: include.public, exclude: exclude.public }
      if (![0, 3, 4].includes(detail.versionStatus as number)) issues.push('The selected version is not in a supported submittable state')
    }
    if (profileUpdate && (!profileUpdate.createdVersion || profileUpdate.createdVersion.versionId !== draft.versionId || draft.fullRelease)) issues.push('Submit only this original profile version without changing its release scope')
    return { review, requiredSubjects, privateIntent: !issues.length ? JSON.stringify(profileUpdate ? { kind: 'submit-profile-version', versionId: draft.versionId } : { kind: 'submit-version', versionId: draft.versionId, body: { is_full_release: draft.fullRelease } }) : null }
  }
  if (!pending) issues.push('Pending application changes are unconfirmed')
  else review.changes = changes(pending, 'ChangeScope')
  const visible = read(states.visibility), include = range(visible?.whiteList), exclude = range(visible?.blackList)
  if (!include || !exclude) issues.push('Both complete current visibility ranges are required')
  else review.audience = review.proposedAudience = { include: include.public, exclude: exclude.public }
  const body: Record<string, unknown> = { autoPublish: false }
  if (draft?.kind === 'create-version' && draft.visibility === 'creator-only') {
    if (!creator) issues.push('The original application creator is unconfirmed')
    else {
      const empty = { all: false, departments: [], people: [], groups: [] }
      if (include && exclude) review.proposedAudience = { include: { ...empty, people: [creator.userId] }, exclude: empty }
      body.visibleSuggest = { departments: [], members: [creator.userId], groups: [], isAll: 0 }
      body.blackVisibleSuggest = { departments: [], members: [], groups: [], isAll: 0 }
    }
  } else if (include && exclude) { body.visibleSuggest = include.native; body.blackVisibleSuggest = exclude.native }
  const entry = (platform: 'pc' | 'mobile', desired: string | undefined) => {
    const choices = pending?.[platform + 'DefaultAbilityList'], current = pending?.[platform + 'DefaultAbility']
    if (profileMode) {
      if (typeof current !== 'string' || current !== '' && !label(current)) { issues.push('Unconfirmed current ' + platform + ' entry'); return null }
      if (desired !== undefined && desired !== current) issues.push('Retain the current ' + platform + ' entry for this profile update')
      body[platform + 'DefaultAbility'] = current
      return { current: current || null, choices: [] }
    }
    if (!Array.isArray(choices) || !choices.every(label) || new Set(choices).size !== choices.length) { issues.push('Unconfirmed ' + platform + ' entry choices'); return null }
    const selected = desired ?? (label(current) && choices.includes(current) ? current : undefined)
    if (choices.length && (!selected || !choices.includes(selected))) issues.push('Choose a valid ' + platform + ' entry')
    else if (choices.length) body[platform + 'DefaultAbility'] = selected
    else if (desired !== undefined) issues.push('No ' + platform + ' entry is offered')
    return { current: label(current) ? current : null, choices }
  }
  review.entries = pending ? { desktop: entry('pc', draft?.kind === 'create-version' ? draft.desktopEntry : undefined), mobile: entry('mobile', draft?.kind === 'create-version' ? draft.mobileEntry : undefined) } : null
  const share = read(states.sharing)
  if (!featureReady) { /* The original feature read chooses the sharing schema. */ }
  else if (split) {
    const config = record(share?.onlineB2CShareSplitConfig)
    if (!splitSharing(config)) issues.push('Split external sharing settings are unconfirmed')
    else { body.b2cShareSplitConfigSuggest = config; review.sharing = splitSharing(config) }
  } else if (typeof share?.onlineB2CShareEnable !== 'boolean') issues.push('External sharing setting is unconfirmed')
  else { body.b2cShareSuggest = share.onlineB2CShareEnable; review.sharing = { kind: 'combined', enabled: share.onlineB2CShareEnable } }
  const policy = record(pending?.applyReasonConfig), scope = record(pending?.ChangeScope), refresh = record(pending?.changeAllowRefreshToken)
  const policyKeys = ['apiPrivilegeNeedReason', 'dataPrivilegeNeedReason', 'contactPrivilegeNeedReason', 'isContactExpand', 'visibleScopeNeedReason']
  const expansion = record(policy?.isDataPrivilegeExpandMap)
  const policyComplete = policy && policyKeys.every(k => typeof policy[k] === 'boolean') && expansion && Object.values(expansion).every(v => typeof v === 'boolean') && typeof pending?.equalToVisible === 'boolean'
  if (profileMode) {
    // The unchanged audience needs no expansion form; known extra-change reasons still apply.
    const added = scope && ['addScopesV2', 'addTenantTypeScopes', 'addUserTypeScopes'].some(key => Array.isArray(scope[key]) && (scope[key] as unknown[]).length > 0)
    const required = policy?.apiPrivilegeNeedReason === true && added || policy?.contactPrivilegeNeedReason === true && policy.isContactExpand === true || policy?.dataPrivilegeNeedReason === true && expansion && Object.values(expansion).some(value => value === true)
    review.reasonRequired = required ? true : policyComplete ? false : null
  } else if (!policyComplete) issues.push('The original application review policy is incomplete')
  else {
    const before = review.audience?.include, after = review.proposedAudience?.include
    const expanded = !!before && !!after && (after.all && !before.all || !before.all && !after.all && (after.people.some(id => !before.people.includes(id)) || after.departments.some(id => !before.departments.includes(id))))
    const added = scope && ['addScopesV2', 'addTenantTypeScopes', 'addUserTypeScopes'].some(key => Array.isArray(scope[key]) && (scope[key] as unknown[]).length > 0)
    review.reasonRequired = Boolean(policy.apiPrivilegeNeedReason && added || policy.contactPrivilegeNeedReason && (policy.isContactExpand || pending?.equalToVisible && expanded) || policy.visibleScopeNeedReason && expanded || policy.dataPrivilegeNeedReason && Object.values(expansion).some(Boolean))
    body.applyReasonConfig = policy
  }
  if (refresh?.changed === true && refresh.allowRefreshToken === true) {
    review.reasonRequired = null
    if (draft?.kind !== 'create-version' || !draft.reason) issues.push('Provide a review reason for the token refresh change')
  }
  if (!draft) issues.push('Confirm a version and release notes')
  else if (draft.kind === 'create-version') {
    if (profileMode && draft.visibility !== 'current') issues.push('Retain the original published application audience')
    const originalVersions = read(states.versions)?.versions
    const reference = Array.isArray(originalVersions) ? originalVersions.map(record).find(version => version && ![0, 3, 10].includes(version.versionStatus as number)) : undefined
    if (profileMode ? draft.version !== profileVersion : !validVersion(draft.version) || reference && (!label(reference.appVersion) || !validVersion(reference.appVersion) || compare(draft.version, reference.appVersion) <= 0)) issues.push('Use a new three-part version greater than the platform reference version')
    if (!draft.notes.trim() || draft.notes.length > 500) issues.push('Release notes must contain between 1 and 500 characters')
    if (draft.reason !== undefined && (!draft.reason.trim() || draft.reason.length > 1000) || review.reasonRequired && !draft.reason) issues.push('Provide the required application review reason')
    body.appVersion = draft.version; body.changeLog = draft.notes
    if (draft.reason !== undefined) body.remark = draft.reason
  }
  if (profileMode) delete body.autoPublish
  return { review, requiredSubjects, privateIntent: draft && !issues.length ? JSON.stringify({ kind: profileMode ? 'create-profile-version' : 'create-version', body }) : null }
}

/** The reference derives from parseable three-part versions, not every historical display label. */
function nextProfileVersion(data: Record<string, unknown> | null): string | null {
  if (!Array.isArray(data?.versions)) return null
  const versions = data.versions.map(value => record(value)?.appVersion).filter(label)
  const triples = versions.map(value => value.split('.').map(part => Number.parseInt(part, 10))).filter(parts => parts.length === 3 && parts.every(Number.isFinite))
  const max = triples.length ? triples.reduce((left, right) => { for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? left : right; return left }) : [0, 0, 0]
  const version = [max[0], max[1], max[2]! + 1].join('.')
  return validVersion(version) && !versions.includes(version) ? version : null
}

/** Pure preflight only. It returns no write intent or invented readback identity. */
export function feishuProfilePublicationDraft(states: Record<string, string>, notes: string): Extract<ConnectionSetupPublicationDraft, { kind: 'create-version' }> | null {
  const version = nextProfileVersion(read(states.versions))
  if (!version) return null
  const draft = { kind: 'create-version' as const, version, notes, visibility: 'current' as const }
  return reviewPublication('create-application-version', states, draft, null, { creatorIsCurrent: false, initialVersion: null }, true).privateIntent ? draft : null
}

export function reviewFeishuPublication(effect: ConnectionSetupPublicationEffect, states: Record<string, string>, draft: ConnectionSetupPublicationDraft | null, creator: ConnectionSetupAccount | null, provenance: SetupPublicationProvenance = { creatorIsCurrent: false, initialVersion: null }): SetupPublicationPlan {
  return reviewPublication(effect, states, draft, creator, provenance)
}

/** The original caller-dependent isOk branch is not a universal success/failure oracle. */
export function feishuSubmissionResponse(data: Record<string, unknown> | null): ConnectionSetupSubmissionResponse {
  if (data?.urlConflict === true) return { outcome: 'action-required', issues: ['entry-conflict'] }
  if (data && Object.hasOwn(data, 'avatar') && !data.avatar) return { outcome: 'action-required', issues: ['application-avatar-required'] }
  if (data?.urlConflict === false && data.avatar && data.isOk === true) return { outcome: 'accepted', issues: [] }
  return { outcome: 'unknown', issues: ['response-unconfirmed'] }
}
