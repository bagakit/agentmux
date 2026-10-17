import { parseDesiredConnectionProfile, connectionProfileAvatarDigest } from './connection-profile-codec.js'
import { parseConnectionRequestTrace, parseConnectionRequestTraceSelector, parseConnectionSetupRequestDiagnostic } from './connection-request-trace.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { CONNECTION_SETUP_READ_ACTIONS, connectionSetupPublicationSubjects, connectionSetupConfigurationSubject, connectionSetupPermissionActionPurpose, type ConnectionSetupReadSubject, type ConnectionSetupReadSummary, type ConnectionSetupPermissionReview, type ConnectionSetupMessageReceptionReview, type ConnectionSetupPublicationDraft, type ConnectionSetupPublicationReview, type ConnectionSetupPublicationEffect } from './connection-setup-contract.js'
import type { ConnectionSetupBegin, ConnectionSetupChallenge, ConnectionSetupInspectionReceipt, ConnectionSetupConfigurationReceipt, ConnectionSetupMethod, ConnectionSetupInitialProgress, ConnectionSetupProfileProgress, ConnectionSetupGoal, ConnectionSetupOperationGoal, ConnectionSetupRequestDiagnostic, ConnectionSetupOperation, ConnectionSetupParamsMap, ConnectionSetupResultMap, ConnectionSetupView } from './connection-setup-contract.js'

export const CONNECTION_SETUP_RPC_METHODS = { 'connection.setup.begin': 'long', 'connection.setup.advance': 'long', 'connection.setup.inspect': 'long', 'connection.setup.ls': 'long' } as const
export const isConnectionSetupMethod = (value: unknown): value is ConnectionSetupMethod => typeof value === 'string' && Object.hasOwn(CONNECTION_SETUP_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Setup data does not describe the exact original management intent.', 'INVALID_CONNECTION_SETUP_DATA') }
function object(value: unknown, fields: readonly string[]) { const p = rpcRecord(value); if (Object.keys(p).some(k => !fields.includes(k))) fail(); return p }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value as string }
function id(value: unknown): string { const v = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(v)) fail(); return v }
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(); return value as number }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) fail(); return value as T }
const configurationEffect = (value: unknown) => choice(value, ['enable-messaging', 'use-persistent-connection', 'use-persistent-callback', 'add-card-actions', 'add-application-permissions', 'add-message-reception', 'create-application-version', 'submit-application-version', 'upload-profile-avatar', 'update-application-profile'] as const)
const permissionPurpose = (value: unknown) => choice(value, ['agent-conversation', 'mote-profile-sync'] as const)
const names = (value: unknown): string[] => { if (!Array.isArray(value)) fail(); const result = (value as unknown[]).map(text); if (new Set(result).size !== result.length) fail(); return result }
const stage = (value: unknown) => choice(value, ['waiting', 'scanned', 'handoff', 'account', 'confirmed', 'expired', 'unknown'] as const)
const requestState = (value: unknown) => choice(value, ['dispatching', 'confirmed', 'unknown'] as const)
export function parseConnectionSetupAccount(value: unknown) {
  const p = object(value, ['userId', 'tenantId', 'userName', 'tenantName'])
  return { userId: text(p.userId), tenantId: text(p.tenantId), ...(p.userName === undefined ? {} : { userName: text(p.userName) }), ...(p.tenantName === undefined ? {} : { tenantName: text(p.tenantName) }) }
}
export function parseConnectionSetupAuthentication(value: unknown): NonNullable<ConnectionSetupOperation['authentication']> {
  const a = object(value, ['attemptId', 'stepId', 'stage', 'request', 'secureStorage'])
  const result = { attemptId: id(a.attemptId), stepId: id(a.stepId), stage: stage(a.stage), request: requestState(a.request), secureStorage: choice(a.secureStorage, ['not-started', 'storing', 'stored', 'unknown'] as const) }
  if (result.secureStorage === 'stored' && result.request !== 'confirmed') fail()
  return result
}
export function parseConnectionSetupInitialPublication(value: unknown) {
  const initial = object(value, ['version', 'notes'])
  const result = { version: text(initial.version), notes: text(initial.notes) }
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(result.version) || result.version === '0.0.0' || result.version.length > 64 || result.notes.length > 500) fail()
  return result
}
export function parseConnectionSetupInitialProgress(value: unknown): ConnectionSetupInitialProgress {
  const initial = object(value, ['stage', 'state', 'versionId'])
  const result: ConnectionSetupInitialProgress = { stage: choice(initial.stage, ['authentication', 'messaging', 'event-transport', 'permissions', 'message-reception', 'callback-transport', 'card-actions', 'publication-create', 'publication-submit', 'publication-status']), state: choice(initial.state, ['pending', 'running', 'attention', 'approval-required', 'complete']), ...(initial.versionId === undefined ? {} : { versionId: id(initial.versionId) }) }
  if (['complete', 'approval-required'].includes(result.state) && (result.stage !== 'publication-status' || !result.versionId)) fail()
  return result
}
export function connectionSetupGoalSummary(goal: ConnectionSetupGoal): ConnectionSetupOperationGoal {
  if (goal.kind === 'agent-conversation') return goal
  const { avatar, ...fields } = goal.desired
  return { kind: 'profile-update', desired: { ...fields, ...(avatar ? { avatarSha256: connectionProfileAvatarDigest(avatar.pngDataUrl) } : {}) }, publication: goal.publication }
}
function goal(value: unknown, safe: boolean): ConnectionSetupGoal | ConnectionSetupOperationGoal {
  const g = rpcRecord(value)
  if (g.kind === 'agent-conversation') { object(g, ['kind', 'interaction']); return { kind: 'agent-conversation', interaction: choice(g.interaction, ['messages', 'cards']) } }
  object(g, ['kind', 'desired', 'publication']); choice(g.kind, ['profile-update'])
  const pub = object(g.publication, ['notes']), notes = text(pub.notes)
  if (notes.length > 500) fail()
  if (!safe) return { kind: 'profile-update', desired: parseDesiredConnectionProfile(g.desired), publication: { notes } }
  const d = object(g.desired, ['name', 'description', 'avatarSha256'])
  const desired = { ...(d.name === undefined ? {} : { name: text(d.name) }), ...(d.description === undefined ? {} : { description: typeof d.description === 'string' && !d.description.includes('\0') ? d.description : fail() }), ...(d.avatarSha256 === undefined ? {} : { avatarSha256: text(d.avatarSha256) }) }
  if (!Object.keys(desired).length || desired.avatarSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(desired.avatarSha256)) fail()
  return { kind: 'profile-update', desired, publication: { notes } }
}
function admission(value: unknown, safe: boolean) {
  const p = object(value, ['operationId', 'connectionId', 'expectedConnectionRevision', 'goal', 'source', 'initialPublication'])
  const intent = goal(p.goal, safe), source = p.source === undefined ? undefined : object(p.source, ['kind', 'operationId', 'expectedRevision'])
  const initialPublication = p.initialPublication === undefined ? undefined : parseConnectionSetupInitialPublication(p.initialPublication)
  if (initialPublication && !source || intent.kind === 'profile-update' && (source || initialPublication)) fail()
  return { operationId: id(p.operationId), connectionId: id(p.connectionId), expectedConnectionRevision: integer(p.expectedConnectionRevision), goal: intent, ...(initialPublication ? { initialPublication } : {}), ...(source ? { source: { kind: choice(source.kind, ['enrollment']), operationId: id(source.operationId), expectedRevision: integer(source.expectedRevision) } } : {}) }
}
function begin(value: unknown): ConnectionSetupBegin { return admission(value, false) as ConnectionSetupBegin }
export function parseConnectionSetupProfileProgress(value: unknown): ConnectionSetupProfileProgress {
  const p = object(value, ['stage', 'state', 'versionId', 'actions', 'publicationDraft', 'blockedBy'])
  if (!Array.isArray(p.actions) || p.actions.length > 1) fail()
  const result: ConnectionSetupProfileProgress = { stage: choice(p.stage, ['authentication', 'profile-preflight', 'avatar-upload', 'profile-write', 'profile-readback', 'publication-create', 'publication-submit', 'publication-status']), state: choice(p.state, ['pending', 'running', 'attention', 'approval-required', 'complete']), ...(p.versionId === undefined ? {} : { versionId: id(p.versionId) }), actions: (p.actions as unknown[]).map(value => { const a = object(value, ['kind', 'actionId', 'expectedRevision']); return { kind: choice(a.kind, ['continue-profile-update', 'recover-configuration-effect']), actionId: id(a.actionId), expectedRevision: integer(a.expectedRevision) } }) }
  if (['complete', 'approval-required'].includes(result.state) && (result.stage !== 'publication-status' || !result.versionId)) fail()
  if (p.blockedBy !== undefined) {
    const b = object(p.blockedBy, ['kind', 'operationId', 'connectionId'])
    if (result.stage !== 'profile-write' || result.state !== 'attention' || result.actions.length) fail()
    result.blockedBy = { kind: choice(b.kind, ['profile-operation']), operationId: id(b.operationId), connectionId: id(b.connectionId) }
  }
  if (p.publicationDraft !== undefined) {
    const draft = parseConnectionSetupPublicationDraft(p.publicationDraft)
    if (draft.kind !== 'create-version' || result.stage !== 'publication-create' || result.state !== 'attention' || result.actions.length) fail()
    result.publicationDraft = draft as Extract<ConnectionSetupPublicationDraft, { kind: 'create-version' }>
  }
  return result
}
export function parseConnectionSetupChallenge(value: unknown): ConnectionSetupChallenge {
  const p = object(value, ['qrPayload', 'expiresAt', 'nextPollAt'])
  return { qrPayload: text(p.qrPayload), expiresAt: p.expiresAt === null ? null : integer(p.expiresAt, 0), nextPollAt: integer(p.nextPollAt, 0) }
}
export function parseConnectionSetupOperation(value: unknown): ConnectionSetupOperation {
  const p = object(value, ['operationId', 'connectionId', 'expectedConnectionRevision', 'goal', 'source', 'initialPublication', 'revision', 'adapterId', 'application', 'request', 'secureStorage', 'reason', 'authentication'])
  const input = admission(Object.fromEntries(['operationId', 'connectionId', 'expectedConnectionRevision', 'goal', 'source', 'initialPublication'].map(k => [k, p[k]])), true)
  const a = object(p.application, ['domain', 'appId']), r = object(p.request, ['kind', 'state', 'attemptId']), domain = text(a.domain)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain)) fail()
  const result: ConnectionSetupOperation = { ...input, goal: input.goal as ConnectionSetupOperationGoal, revision: integer(p.revision), adapterId: id(p.adapterId), application: { domain, appId: id(a.appId) }, request: { state: choice(r.state, ['not-dispatched', 'dispatching', 'confirmed', 'unknown', 'refused']), attemptId: r.attemptId === null ? null : id(r.attemptId) }, secureStorage: choice(p.secureStorage, ['not-started', 'storing', 'stored', 'unknown']), ...(p.reason === undefined ? {} : { reason: choice(p.reason, ['adapter-unavailable', 'secure-storage-unavailable', 'request-unconfirmed', 'challenge-unconfirmed']) }) }
  if (result.request.state === 'not-dispatched' && result.request.attemptId !== null || result.request.state !== 'not-dispatched' && result.request.attemptId === null || result.secureStorage === 'stored' && result.request.state !== 'confirmed') fail()
  if (input.source) result.request.kind = choice(r.kind, ['enrollment-handoff'])
  else if (r.kind !== undefined) fail()
  if (p.authentication !== undefined) {
    result.authentication = parseConnectionSetupAuthentication(p.authentication)
  }
  return result
}
export function parseConnectionSetupParams<M extends ConnectionSetupMethod>(method: M, value: unknown): ConnectionSetupParamsMap[M] {
  if (method === 'connection.setup.begin') return begin(value) as ConnectionSetupParamsMap[M]
  if (method === 'connection.setup.advance') {
    const p = object(value, ['operationId', 'expectedRevision', 'decision', 'versionId', 'publicationDraft']), d = object(p.decision, ['actionId', 'value'])
    const actionId = id(d.actionId)
    if (p.versionId !== undefined && !actionId.startsWith('setup-version-read:') && !actionId.startsWith('setup-inspection-recover:')) fail()
    if (p.publicationDraft !== undefined && !['setup-publish-create:', 'setup-publish-submit:', 'setup-effect-recover:'].some(prefix => actionId.startsWith(prefix))) fail()
    return { operationId: id(p.operationId), expectedRevision: integer(p.expectedRevision), decision: { actionId, value: choice(d.value, ['continue', 'confirm', 'renew']) }, ...(p.versionId === undefined ? {} : { versionId: id(p.versionId) }), ...(p.publicationDraft === undefined ? {} : { publicationDraft: parseConnectionSetupPublicationDraft(p.publicationDraft) }) } as ConnectionSetupParamsMap[M]
  }
  if (method === 'connection.setup.ls') { const p = object(value, ['connectionId', 'cursor', 'limit']); return { connectionId: id(p.connectionId), ...(p.cursor === undefined ? {} : { cursor: text(p.cursor) }), ...(p.limit === undefined ? {} : { limit: integer(p.limit, 1, 100) }) } as ConnectionSetupParamsMap[M] }
  const p = object(value, ['operationId', 'applicationInspection', 'applicationConfiguration', 'requestTrace'])
  const result: ConnectionSetupParamsMap['connection.setup.inspect'] = { operationId: id(p.operationId) }
  if (p.requestTrace !== undefined) {
    if (p.applicationInspection !== undefined || p.applicationConfiguration !== undefined) fail()
    result.requestTrace = parseConnectionRequestTraceSelector(p.requestTrace)
  }
  if (p.applicationInspection !== undefined) {
    const s = object(p.applicationInspection, ['selectedStepId', 'cursor', 'limit', 'versionId'])
    result.applicationInspection = { ...(s.versionId === undefined ? {} : { versionId: id(s.versionId) }), ...(s.selectedStepId === undefined ? {} : { selectedStepId: id(s.selectedStepId) }), ...(s.cursor === undefined ? {} : { cursor: text(s.cursor) }), ...(s.limit === undefined ? {} : { limit: integer(s.limit, 1, 100) }) }
  }
  if (p.applicationConfiguration !== undefined) {
    const s = object(p.applicationConfiguration, ['effect', 'purpose', 'draft', 'selectedStepId', 'cursor', 'limit']), effect = configurationEffect(s.effect)
    if (effect !== 'add-application-permissions' && s.purpose !== undefined) fail()
    if (s.draft !== undefined && effect !== 'create-application-version' && effect !== 'submit-application-version') fail()
    const draft = s.draft === undefined ? undefined : parseConnectionSetupPublicationDraft(s.draft)
    if (draft && (effect === 'create-application-version' ? draft.kind !== 'create-version' : draft.kind !== 'submit-version')) fail()
    result.applicationConfiguration = { ...(draft ? { draft } : {}), ...(effect === 'add-application-permissions' ? { effect, purpose: permissionPurpose(s.purpose) } : { effect }), ...(s.selectedStepId === undefined ? {} : { selectedStepId: id(s.selectedStepId) }), ...(s.cursor === undefined ? {} : { cursor: text(s.cursor) }), ...(s.limit === undefined ? {} : { limit: integer(s.limit, 1, 100) }) } as NonNullable<ConnectionSetupParamsMap['connection.setup.inspect']['applicationConfiguration']>
  }
  return result as ConnectionSetupParamsMap[M]
}
const readSubjects = [...Object.keys(CONNECTION_SETUP_READ_ACTIONS), 'publication-version'] as ConnectionSetupReadSubject[]
export function parseConnectionSetupReadSummary(value: unknown): ConnectionSetupReadSummary {
  const raw = rpcRecord(value), subject = choice(raw.subject, readSubjects)
  if (subject === 'application-details') {
    const p = object(value, ['subject', 'name', 'description'])
    const display = (v: unknown, max: number): string | null => {
      if (v === null) return null
      if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) fail()
      return v as string
    }
    return { subject, name: display(p.name, 512), description: display(p.description, 4096) }
  }
  if (subject === 'event-settings') {
    const p = object(value, ['subject', 'transport'])
    return { subject, transport: choice(p.transport, ['persistent-connection', 'webhook', 'function', 'unknown']) }
  }
  if (subject === 'publication-version') {
    const p = object(value, ['subject', 'versionId', 'status']); return { subject, versionId: id(p.versionId), status: versionStatus(p.status) }
  }
  object(value, ['subject'])
  return { subject }
}
export function parseConnectionSetupInspectionReceipt(value: unknown): ConnectionSetupInspectionReceipt {
  const p = object(value, ['stepId', 'input', 'request', 'secureStorage', 'subject', 'versionId'])
  const result: ConnectionSetupInspectionReceipt = { stepId: id(p.stepId), input: parseConnectionSetupParams('connection.setup.advance', p.input), request: requestState(p.request), secureStorage: choice(p.secureStorage, ['not-started', 'storing', 'stored', 'unknown']) }
  if (p.subject !== undefined) result.subject = choice(p.subject, readSubjects)
  if (result.subject === 'publication-version') {
    result.versionId = id(p.versionId)
    if (result.input.versionId !== result.versionId || !result.input.decision.actionId.startsWith('setup-version-read:')) fail()
  } else if (p.versionId !== undefined || result.input.versionId !== undefined || result.input.publicationDraft !== undefined) fail()
  if (result.input.decision.value !== 'continue' || result.secureStorage === 'stored' && !['confirmed', 'unknown'].includes(result.request)) fail()
  return result
}
export function parseConnectionSetupPermissionReview(value: unknown): ConnectionSetupPermissionReview {
  const p = object(value, ['permissions', 'reason'])
  if (!Array.isArray(p.permissions)) fail()
  const permissions = (p.permissions as unknown[]).map(value => { const r = object(value, ['name', 'group', 'state']); return { name: text(r.name), group: choice(r.group, ['messages', 'groups', 'identity'] as const), state: choice(r.state, ['requested', 'missing', 'unknown'] as const) } })
  if (!permissions.length || new Set(permissions.map(p => p.name)).size !== permissions.length) fail()
  const reason = p.reason === undefined ? undefined : choice(p.reason, ['catalog-unconfirmed', 'applied-unconfirmed', 'scope-unavailable', 'scope-ambiguous', 'unsupported-scope-id'] as const)
  if (permissions.some(p => p.state === 'unknown') !== Boolean(reason)) fail()
  return { permissions, ...(reason ? { reason } : {}) }
}
const versionStatus = (value: unknown) => choice(value, ['draft', 'reviewing', 'approved', 'rejected', 'awaiting-release', 'unknown'] as const)
const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') fail(); return value as boolean }
const prose = (value: unknown): string => { if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(); return value as string }
export function parseConnectionSetupPublicationDraft(value: unknown): ConnectionSetupPublicationDraft {
  const kind = choice(rpcRecord(value).kind, ['create-version', 'submit-version'] as const)
  if (kind === 'submit-version') { const p = object(value, ['kind', 'versionId', 'fullRelease']); return { kind, versionId: id(p.versionId), fullRelease: boolean(p.fullRelease) } }
  const p = object(value, ['kind', 'version', 'notes', 'visibility', 'desktopEntry', 'mobileEntry', 'reason'])
  return { kind, version: text(p.version), notes: prose(p.notes), visibility: choice(p.visibility, ['current', 'creator-only']), ...(p.desktopEntry === undefined ? {} : { desktopEntry: text(p.desktopEntry) }), ...(p.mobileEntry === undefined ? {} : { mobileEntry: text(p.mobileEntry) }), ...(p.reason === undefined ? {} : { reason: prose(p.reason) }) }
}
function parsePublicationSourceIds(value: unknown, effect: ConnectionSetupPublicationEffect, draft: ConnectionSetupPublicationDraft | undefined) {
  const keys = connectionSetupPublicationSubjects(effect).map(subject => subject.slice(12)), p = object(value, keys)
  const present = keys.filter(key => p[key] !== undefined)
  if (present.length !== keys.length && !(effect === 'create-application-version' ? present.length === 1 && present[0] === 'versions' && draft?.kind === 'create-version' && draft.visibility === 'creator-only' && draft.desktopEntry && draft.mobileEntry : present.length === 1 && present[0] === 'version')) fail()
  const result = Object.fromEntries(present.map(key => [key, id(p[key])]))
  if (new Set(Object.values(result)).size !== present.length) fail()
  return result
}
function parseSubmission(value: unknown) {
  const p = object(value, ['outcome', 'issues'])
  const outcome = choice(p.outcome, ['accepted', 'action-required', 'unknown'] as const), issues = names(p.issues).map(v => choice(v, ['entry-conflict', 'application-avatar-required', 'response-unconfirmed'] as const))
  if ((outcome === 'accepted') !== (issues.length === 0) || outcome === 'unknown' && !issues.includes('response-unconfirmed')) fail()
  return { outcome, issues }
}
export function parseConnectionSetupPublicationReview(value: unknown): ConnectionSetupPublicationReview {
  const p = object(value, ['versions', 'selectedVersion', 'changes', 'audience', 'proposedAudience', 'entries', 'sharing', 'reasonRequired', 'creatorAudienceAvailable', 'issues'])
  const version = (value: unknown) => { const v = object(value, ['versionId', 'version', 'status']); return { versionId: id(v.versionId), version: text(v.version), status: versionStatus(v.status) } }
  if (!Array.isArray(p.versions) || !Array.isArray(p.changes)) fail()
  const versions = (p.versions as unknown[]).map(version)
  if (new Set(versions.map(v => v.versionId)).size !== versions.length) fail()
  const changes = (p.changes as unknown[]).map(value => { const c = object(value, ['category', 'details']); return { category: choice(c.category, ['events', 'callbacks', 'permissions', 'data-access', 'extensions', 'refresh-tokens', 'sharing'] as const), details: names(c.details) } })
  const audience = (value: unknown) => {
    if (value === null) return null
    const pair = object(value, ['include', 'exclude'])
    const range = (value: unknown) => {
      const r = object(value, ['all', 'departments', 'people', 'groups'])
      const ids = (value: unknown) => { if (!Array.isArray(value)) fail(); return (value as unknown[]).map(v => typeof v === 'string' ? text(v) : integer(v, Number.MIN_SAFE_INTEGER)) }
      return { all: boolean(r.all), departments: ids(r.departments), people: ids(r.people), groups: ids(r.groups) }
    }
    return { include: range(pair.include), exclude: range(pair.exclude) }
  }
  const entry = (value: unknown) => { if (value === null) return null; const e = object(value, ['current', 'choices']); return { current: e.current === null ? null : text(e.current), choices: names(e.choices) } }
  const entries = p.entries === null ? null : (() => { const e = object(p.entries, ['desktop', 'mobile']); return { desktop: entry(e.desktop), mobile: entry(e.mobile) } })()
  let sharing: ConnectionSetupPublicationReview['sharing'] = null
  if (p.sharing !== null) {
    const kind = choice(rpcRecord(p.sharing).kind, ['combined', 'split'] as const)
    if (kind === 'combined') { const s = object(p.sharing, ['kind', 'enabled']); sharing = { kind, enabled: boolean(s.enabled) } }
    else { const s = object(p.sharing, ['kind', 'groups', 'direct', 'directReview']); sharing = { kind, groups: boolean(s.groups), direct: boolean(s.direct), directReview: boolean(s.directReview) } }
  }
  const selectedVersion = p.selectedVersion === null ? null : (() => {
    const v = object(p.selectedVersion, ['versionId', 'version', 'status', 'notes'])
    if (v.notes !== null && (typeof v.notes !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v.notes))) fail()
    return { ...version({ versionId: v.versionId, version: v.version, status: v.status }), notes: v.notes as string | null }
  })()
  return { versions, selectedVersion, changes, audience: audience(p.audience), proposedAudience: audience(p.proposedAudience), entries, sharing, reasonRequired: p.reasonRequired === null ? null : boolean(p.reasonRequired), creatorAudienceAvailable: boolean(p.creatorAudienceAvailable), issues: names(p.issues) }
}
export function parseConnectionSetupMessageReceptionReview(value: unknown): ConnectionSetupMessageReceptionReview {
  const p = object(value, ['reception', 'transport', 'reason'])
  const reception = choice(p.reception, ['subscribed', 'missing', 'unknown'] as const), transport = choice(p.transport, ['persistent-connection', 'webhook', 'function', 'unknown'] as const)
  const reason = p.reason === undefined ? undefined : choice(p.reason, ['catalog-unconfirmed', 'settings-unconfirmed', 'event-unavailable', 'event-ambiguous'] as const)
  if ((reception === 'unknown') !== Boolean(reason)) fail()
  return { reception, transport, ...(reason ? { reason } : {}) }
}
export function parseConnectionSetupConfigurationReceipt(value: unknown): ConnectionSetupConfigurationReceipt {
  const effect = configurationEffect(rpcRecord(value).effect)
  const common = ['effect', 'stepId', 'input', 'request', 'secureStorage', 'diagnostic']
  const p = object(value, [...common, ...(effect === 'add-application-permissions' ? ['purpose', 'sourceStepIds', 'scopeNames', 'requiresDataRangeConfiguration'] : effect === 'add-message-reception' ? ['sourceStepIds', 'transport'] : effect === 'create-application-version' || effect === 'submit-application-version' ? ['sourceStepIds', 'profileReadbackStepId', 'versionId', 'submission'] : ['sourceStepId', ...(effect === 'update-application-profile' ? ['avatarStepId'] : [])])])
  const input = parseConnectionSetupParams('connection.setup.advance', p.input), request = requestState(p.request), secureStorage = choice(p.secureStorage, ['not-started', 'storing', 'stored', 'unknown'] as const), stepId = id(p.stepId)
  if (input.decision.value !== 'confirm' || secureStorage === 'stored' && !['confirmed', 'unknown'].includes(request)) fail()
  if (effect === 'create-application-version' || effect === 'submit-application-version') {
    const sourceStepIds = parsePublicationSourceIds(p.sourceStepIds, effect, input.publicationDraft), versionId = p.versionId === null ? null : id(p.versionId)
    const draft = input.publicationDraft
    if (!draft || (effect === 'create-application-version' ? draft.kind !== 'create-version' || !input.decision.actionId.startsWith('setup-publish-create:') : draft.kind !== 'submit-version' || !input.decision.actionId.startsWith('setup-publish-submit:') || versionId !== draft.versionId) || request === 'confirmed' && versionId === null || input.versionId !== undefined) fail()
    if (Object.values(sourceStepIds).includes(stepId) || p.profileReadbackStepId !== undefined && id(p.profileReadbackStepId) === stepId) fail()
    const submission = p.submission === null ? null : parseSubmission(p.submission)
    if (effect === 'create-application-version' && submission !== null || effect === 'submit-application-version' && (request === 'confirmed') !== (submission !== null)) fail()
    return { effect, stepId, input, request, secureStorage, sourceStepIds, ...(p.profileReadbackStepId === undefined ? {} : { profileReadbackStepId: id(p.profileReadbackStepId) }), versionId, submission }
  }
  if (input.publicationDraft !== undefined || input.versionId !== undefined) fail()
  if (effect === 'upload-profile-avatar' || effect === 'update-application-profile') {
    const sourceStepId = id(p.sourceStepId), avatarStepId = p.avatarStepId === undefined ? undefined : id(p.avatarStepId)
    if ([sourceStepId, avatarStepId].includes(stepId) || !input.decision.actionId.startsWith(effect === 'upload-profile-avatar' ? 'setup-profile-upload:' : 'setup-profile-write:')) fail()
    return { effect, stepId, sourceStepId, ...(avatarStepId ? { avatarStepId } : {}), input, request, secureStorage, ...(p.diagnostic === undefined ? {} : { diagnostic: parseConnectionSetupRequestDiagnostic(p.diagnostic) }) }
  }
  if (effect === 'add-message-reception') {
    const sources = object(p.sourceStepIds, ['catalog', 'settings']), sourceStepIds = { catalog: id(sources.catalog), settings: id(sources.settings) }
    if (new Set([stepId, sourceStepIds.catalog, sourceStepIds.settings]).size !== 3 || !input.decision.actionId.startsWith('setup-reception:')) fail()
    return { effect, stepId, input, request, secureStorage, sourceStepIds, transport: choice(p.transport, ['persistent-connection']) }
  }
  if (effect !== 'add-application-permissions') {
    const sourceStepId = id(p.sourceStepId)
    if (stepId === sourceStepId) fail()
    return { effect, stepId, sourceStepId, input, request, secureStorage }
  }
  const sources = object(p.sourceStepIds, ['catalog', 'applied']), sourceStepIds = { catalog: id(sources.catalog), applied: id(sources.applied) }, scopeNames = names(p.scopeNames)
  if (!scopeNames.length || new Set([stepId, sourceStepIds.catalog, sourceStepIds.applied]).size !== 3 || p.requiresDataRangeConfiguration !== null && typeof p.requiresDataRangeConfiguration !== 'boolean' || request !== 'confirmed' && p.requiresDataRangeConfiguration !== null) fail()
  const purpose = permissionPurpose(p.purpose)
  if (connectionSetupPermissionActionPurpose(input.decision.actionId) !== purpose) fail()
  return { effect, stepId, input, request, secureStorage, purpose, sourceStepIds, scopeNames, requiresDataRangeConfiguration: p.requiresDataRangeConfiguration as boolean | null }
}
export function parseConnectionSetupResult<M extends ConnectionSetupMethod>(method: M, value: unknown, input: ConnectionSetupParamsMap[M]): ConnectionSetupResultMap[M] {
  if (method === 'connection.setup.ls') {
    const p = object(value, ['operations', 'next', 'support']), i = input as ConnectionSetupParamsMap['connection.setup.ls']
    if (!Array.isArray(p.operations) || p.operations.length > (i.limit ?? 25)) fail()
    const operations = (p.operations as unknown[]).map(parseConnectionSetupOperation)
    if (operations.some(o => o.connectionId !== i.connectionId) || new Set(operations.map(o => o.operationId)).size !== operations.length) fail()
    let support: ConnectionSetupResultMap['connection.setup.ls']['support'] = null
    if (p.support !== null) {
      const s = object(p.support, ['connectionRevision', 'capabilities'])
      const supportedCapabilities = ['management-authentication', 'application-inspection', 'messaging-capability', 'persistent-event-transport', 'application-permissions', 'message-reception', 'card-actions', 'application-publication', 'enrollment-continuation', 'initial-setup', 'profile-update'] as const
      if (!Array.isArray(s.capabilities) || s.capabilities.length > supportedCapabilities.length) fail()
      const capabilities = (s.capabilities as unknown[]).map(value => choice(value, supportedCapabilities))
      if (new Set(capabilities).size !== capabilities.length) fail()
      support = { connectionRevision: integer(s.connectionRevision), capabilities }
    }
    return { operations, next: p.next === null ? null : text(p.next), support } as ConnectionSetupResultMap[M]
  }
  const p = object(value, ['operation', 'challenge', 'challengeSource', 'reason', 'continuation', 'receipt', 'applicationInspection', 'applicationConfiguration', 'requestTrace', 'initialSetup', 'profileUpdate']), operation = p.operation === null ? null : parseConnectionSetupOperation(p.operation), challenge = p.challenge === null ? null : parseConnectionSetupChallenge(p.challenge)
  if (operation && operation.operationId !== (input as { operationId: string }).operationId || !operation && (method === 'connection.setup.begin' || challenge !== null)) fail()
  if (method === 'connection.setup.begin' && operation) {
    // Select the admitted fields explicitly: summaries also contain safe result fields.
    const admitted = admission(Object.fromEntries(['operationId', 'connectionId', 'expectedConnectionRevision', 'goal', 'source', 'initialPublication'].map(k => [k, operation[k as keyof ConnectionSetupOperation]])), true)
    const expected = { ...input as ConnectionSetupBegin, goal: connectionSetupGoalSummary((input as ConnectionSetupBegin).goal) }
    if (JSON.stringify(admitted) !== JSON.stringify(expected)) fail()
  }
  const challengeRequest = operation?.authentication?.request ?? operation?.request.state
  const challengeStorage = operation?.authentication?.secureStorage ?? operation?.secureStorage
  if (challenge && p.challengeSource === undefined && (challengeRequest !== 'confirmed' || challengeStorage !== 'stored')) fail()
  if (challenge && operation?.request.kind === 'enrollment-handoff' && !operation.authentication) fail()
  const result: ConnectionSetupView = { operation, challenge, ...(p.reason === undefined ? {} : { reason: choice(p.reason, ['connection-revised', 'challenge-unavailable']) }) }
  if (p.profileUpdate !== undefined) {
    if (operation?.goal.kind !== 'profile-update') fail()
    result.profileUpdate = parseConnectionSetupProfileProgress(p.profileUpdate)
    if (result.profileUpdate.actions.some(a => a.kind === 'continue-profile-update' && a.expectedRevision !== operation!.revision)) fail()
  }
  if (p.initialSetup !== undefined) {
    if (!operation?.initialPublication) fail()
    result.initialSetup = parseConnectionSetupInitialProgress(p.initialSetup)
  }
  const traceSelector = method === 'connection.setup.inspect' ? (input as ConnectionSetupParamsMap['connection.setup.inspect']).requestTrace : undefined
  if ((traceSelector !== undefined) !== (p.requestTrace !== undefined)) fail()
  if (p.requestTrace !== undefined) {
    if (challenge || p.continuation !== undefined || p.applicationInspection !== undefined || p.applicationConfiguration !== undefined || p.receipt !== undefined) fail()
    result.requestTrace = parseConnectionRequestTrace(p.requestTrace, (input as { operationId: string }).operationId, traceSelector)
  }
  if (method === 'connection.setup.inspect' && operation && (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection && p.applicationInspection === undefined) fail()
  if (method === 'connection.setup.inspect' && operation && (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationConfiguration && p.applicationConfiguration === undefined) fail()
  if (p.continuation !== undefined) {
    if (!operation || result.reason === 'connection-revised') fail()
    const c = object(p.continuation, ['stage', 'account', 'actions'])
    if (!Array.isArray(c.actions) || c.actions.length > 2) fail()
    const actions = (c.actions as unknown[]).map(value => { const a = object(value, ['actionId', 'expectedRevision', 'kind']); return { actionId: id(a.actionId), expectedRevision: integer(a.expectedRevision), kind: choice(a.kind, ['continue', 'confirm-account', 'renew'] as const) } })
    if (new Set(actions.map(a => a.actionId)).size !== actions.length || new Set(actions.map(a => a.kind)).size !== actions.length) fail()
    result.continuation = { stage: stage(c.stage), account: c.account === null ? null : parseConnectionSetupAccount(c.account), actions }
    if (result.continuation.account && !['account', 'confirmed'].includes(result.continuation.stage) || ['account', 'confirmed'].includes(result.continuation.stage) && !result.continuation.account) fail()
    if (operation && !operation.authentication && operation.request.kind === 'enrollment-handoff' && result.continuation.account && (result.continuation.stage !== 'account' || operation.request.state !== 'confirmed' || operation.secureStorage !== 'stored')) fail()
  }
  if (p.challengeSource !== undefined) {
    const source = object(p.challengeSource, ['attemptId', 'stepId']), auth = operation?.authentication, continuation = result.continuation
    const attemptId = id(source.attemptId), stepId = id(source.stepId)
    if (!challenge || !auth || !continuation || !['waiting', 'scanned'].includes(continuation.stage) || continuation.actions.length || result.reason || attemptId !== auth.attemptId) fail()
    // A source is only live presentation: the pending step keeps its own request and storage facts.
    const nativePending = auth!.request === 'dispatching' && auth!.secureStorage === 'not-started' && auth!.stage === 'handoff' && stepId !== auth!.stepId
    const storagePending = auth!.request === 'confirmed' && auth!.secureStorage === 'storing' && auth!.stage === continuation!.stage && stepId === auth!.stepId
    if (!nativePending && !storagePending) fail()
    result.challengeSource = { attemptId, stepId }
  }
  if (p.receipt !== undefined) {
    if (method !== 'connection.setup.advance' || !operation) fail()
    const r = object(p.receipt, ['actionId', 'stepId', 'state'])
    result.receipt = { actionId: id(r.actionId), stepId: id(r.stepId), state: requestState(r.state) }
    if (result.receipt.actionId !== (input as ConnectionSetupParamsMap['connection.setup.advance']).decision.actionId) fail()
  }
  if (p.applicationInspection !== undefined) {
    if (!operation || method === 'connection.setup.begin' || method === 'connection.setup.inspect' && !(input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection) fail()
    const s = object(p.applicationInspection, ['observations', 'next', 'selected', 'applicationInfoReadPermission', 'readResult', 'actions'])
    const limit = method === 'connection.setup.inspect' ? (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection?.limit ?? 25 : 25
    if (!Array.isArray(s.observations) || s.observations.length > limit || !Array.isArray(s.actions) || s.actions.length > readSubjects.length + 2) fail()
    const observations = (s.observations as unknown[]).map(parseConnectionSetupInspectionReceipt), selected = s.selected === null ? null : parseConnectionSetupInspectionReceipt(s.selected)
    if (new Set(observations.map(o => o.stepId)).size !== observations.length || new Set(observations.map(o => o.input.decision.actionId)).size !== observations.length) fail()
    if ([...observations, ...(selected ? [selected] : [])].some(o => o.input.operationId !== operation!.operationId)) fail()
    const selector = method === 'connection.setup.inspect' ? (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationInspection : undefined
    if (selector?.selectedStepId && selected && selector.selectedStepId !== selected.stepId) fail()
    if (method === 'connection.setup.advance' && (!result.receipt || !selected || selected.stepId !== result.receipt.stepId)) fail()
    if (method === 'connection.setup.advance') {
      const versionId = (input as ConnectionSetupParamsMap['connection.setup.advance']).versionId
      if ((versionId !== undefined || selected?.subject === 'publication-version') && (selected?.subject !== 'publication-version' || selected.versionId !== versionId)) fail()
    }
    const copy = selected && observations.find(o => o.stepId === selected.stepId)
    if (copy && JSON.stringify(copy) !== JSON.stringify(selected)) fail()
    const actions = (s.actions as unknown[]).map(value => {
      const a = object(value, ['actionId', 'expectedRevision', 'kind', 'versionId'])
      const actionId = id(a.actionId), expectedRevision = integer(a.expectedRevision)
      if (a.kind === 'read-publication-version') {
        const versionId = id(a.versionId)
        if (!actionId.startsWith('setup-version-read:') || method === 'connection.setup.inspect' && selector?.versionId !== versionId) fail()
        return { actionId, expectedRevision, kind: 'read-publication-version' as const, versionId }
      }
      if (a.versionId !== undefined) fail()
      return { actionId, expectedRevision, kind: choice(a.kind, ['inspect-application', 'recover-application-inspection', ...Object.values(CONNECTION_SETUP_READ_ACTIONS)] as const) }
    })
    if (new Set(actions.map(a => a.actionId)).size !== actions.length || new Set(actions.map(a => a.kind)).size !== actions.length) fail()
    if (actions.some(a => a.kind === 'recover-application-inspection') && (!selected || !['confirmed', 'unknown'].includes(selected.request) || !['storing', 'unknown'].includes(selected.secureStorage))) fail()
    const permission = choice(s.applicationInfoReadPermission, ['confirmed', 'unknown'] as const)
    if (permission === 'confirmed' && (!selected || selected.subject !== undefined || selected.request !== 'confirmed' || selected.secureStorage !== 'stored' || result.reason === 'connection-revised' || operation!.authentication?.stage !== 'confirmed' || operation!.authentication.request !== 'confirmed' || operation!.authentication.secureStorage !== 'stored')) fail()
    result.applicationInspection = { observations, selected, next: s.next === null ? null : text(s.next), applicationInfoReadPermission: permission, actions }
    if (s.readResult !== undefined) {
      const readResult = parseConnectionSetupReadSummary(s.readResult)
      if (!selected || selected.subject !== readResult.subject || readResult.subject === 'publication-version' && selected.versionId !== readResult.versionId || selected.request !== 'confirmed' || selected.secureStorage !== 'stored' || result.reason === 'connection-revised' || operation!.authentication?.stage !== 'confirmed' || operation!.authentication.request !== 'confirmed' || operation!.authentication.secureStorage !== 'stored') fail()
      result.applicationInspection.readResult = readResult
    }
  }
  if (p.applicationConfiguration !== undefined) {
    if (!operation || method === 'connection.setup.begin' || method === 'connection.setup.inspect' && !(input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationConfiguration) fail()
    const raw = rpcRecord(p.applicationConfiguration), effect = configurationEffect(raw.effect)
    const c = object(raw, ['effect', 'subject', 'effects', 'next', 'selected', 'capability', 'actions', 'reason', 'unresolved', 'unresolvedProfile', ...(effect === 'add-application-permissions' ? ['purpose', 'sources', 'review'] : effect === 'add-message-reception' ? ['sources', 'review'] : effect === 'create-application-version' || effect === 'submit-application-version' ? ['sources', 'requiredSubjects', 'draft', 'review'] : ['source'])])
    const selector = method === 'connection.setup.inspect' ? (input as ConnectionSetupParamsMap['connection.setup.inspect']).applicationConfiguration : undefined
    if (!Array.isArray(c.effects) || c.effects.length > (selector?.limit ?? 25) || !Array.isArray(c.actions) || c.actions.length > 2 || selector && selector.effect !== effect) fail()
    const effects = (c.effects as unknown[]).map(parseConnectionSetupConfigurationReceipt), selected = c.selected === null ? null : parseConnectionSetupConfigurationReceipt(c.selected)
    if (new Set(effects.map(e => e.stepId)).size !== effects.length || new Set(effects.map(e => e.input.decision.actionId)).size !== effects.length || [...effects, ...(selected ? [selected] : [])].some(e => e.input.operationId !== operation!.operationId || e.effect !== effect)) fail()
    if (selector?.selectedStepId && selected && selector.selectedStepId !== selected.stepId) fail()
    const copy = selected && effects.find(e => e.stepId === selected.stepId)
    if (copy && JSON.stringify(copy) !== JSON.stringify(selected)) fail()
    const capability = choice(c.capability, ['enabled', 'disabled', 'unknown'] as const)
    const qualified = result.reason !== 'connection-revised' && operation!.authentication?.stage === 'confirmed' && operation!.authentication.request === 'confirmed' && operation!.authentication.secureStorage === 'stored'
    const sourceReceipt = (value: unknown, subject: ConnectionSetupReadSubject) => {
      if (value === null) return null
      const source = parseConnectionSetupInspectionReceipt(value)
      if (source.input.operationId !== operation!.operationId || source.subject !== subject || source.request !== 'confirmed' || source.secureStorage !== 'stored') fail()
      return source
    }
    const actions = (c.actions as unknown[]).map(value => { const a = object(value, ['actionId', 'expectedRevision', 'kind']); return { actionId: id(a.actionId), expectedRevision: integer(a.expectedRevision), kind: choice(a.kind, ['enable-messaging', 'use-persistent-connection', 'use-persistent-callback', 'add-card-actions', 'add-application-permissions', 'add-message-reception', 'create-application-version', 'submit-application-version', 'upload-profile-avatar', 'update-application-profile', 'recover-configuration-effect'] as const) } })
    if (new Set(actions.map(a => a.actionId)).size !== actions.length || new Set(actions.map(a => a.kind)).size !== actions.length) fail()
    if (actions.some(a => a.kind !== 'recover-configuration-effect' && (a.kind !== effect || capability !== 'disabled' || a.expectedRevision !== operation!.revision || c.reason !== undefined))) fail()
    if (actions.some(a => a.kind === 'recover-configuration-effect') && (!selected || !['confirmed', 'unknown'].includes(selected.request) || !['storing', 'unknown'].includes(selected.secureStorage))) fail()
    if (method === 'connection.setup.advance' && (!result.receipt || !selected || selected.stepId !== result.receipt.stepId)) fail()
    const common = { effects, next: c.next === null ? null : text(c.next), selected, capability, actions, ...(c.reason === undefined ? {} : { reason: choice(c.reason, ['source-unconfirmed', 'adapter-unavailable', 'original-effect-unconfirmed'] as const) }) }
    if (effect === 'add-application-permissions') {
      const purpose = permissionPurpose(c.purpose), pair = object(c.sources, ['catalog', 'applied'])
      const sources = { catalog: sourceReceipt(pair.catalog, 'permission-catalog'), applied: sourceReceipt(pair.applied, 'application-permissions') }, review = c.review === null ? null : parseConnectionSetupPermissionReview(c.review)
      if (actions.some(action => action.kind === 'add-application-permissions' && connectionSetupPermissionActionPurpose(action.actionId) !== purpose)) fail()
      if (c.subject !== 'application-permissions' || selector?.effect === effect && selector.purpose !== purpose || sources.catalog && sources.applied && sources.catalog.stepId === sources.applied.stepId) fail()
      if (review && (!sources.catalog || !sources.applied || !qualified) || capability !== 'unknown' && (!review || review.reason || !qualified)) fail()
      if (review && capability !== 'unknown' && (review.permissions.some(p => p.state === 'missing') ? 'disabled' : 'enabled') !== capability) fail()
      result.applicationConfiguration = { ...common, effect, subject: 'application-permissions', purpose, sources, review }
    } else if (effect === 'add-message-reception') {
      const pair = object(c.sources, ['catalog', 'settings']), sources = { catalog: sourceReceipt(pair.catalog, 'event-catalog'), settings: sourceReceipt(pair.settings, 'event-settings') }
      const review = c.review === null ? null : parseConnectionSetupMessageReceptionReview(c.review)
      if (c.subject !== 'event-settings' || sources.catalog && sources.settings && sources.catalog.stepId === sources.settings.stepId) fail()
      if (review && (!sources.catalog || !sources.settings || !qualified) || capability !== 'unknown' && (!review || review.reason || !qualified)) fail()
      if (review && capability !== 'unknown' && (review.reception === 'subscribed' ? 'enabled' : review.reception === 'missing' ? 'disabled' : 'unknown') !== capability) fail()
      if (actions.some(a => a.kind === effect && (!a.actionId.startsWith('setup-reception:') || review?.reception !== 'missing' || review.transport !== 'persistent-connection'))) fail()
      result.applicationConfiguration = { ...common, effect, subject: 'event-settings', sources, review }
    } else if (effect === 'create-application-version' || effect === 'submit-application-version') {
      if (operation!.goal.kind === 'profile-update' && [...effects, ...(selected ? [selected] : [])].some(receipt => (receipt.effect === 'create-application-version' || receipt.effect === 'submit-application-version') && !receipt.profileReadbackStepId)) fail()
      const rawSources = object(c.sources, connectionSetupPublicationSubjects(effect).map(subject => subject.slice(12))), sources: Record<string, ConnectionSetupInspectionReceipt> = {}
      for (const subject of connectionSetupPublicationSubjects(effect)) { const key = subject.slice(12); if (rawSources[key] !== undefined) { const source = sourceReceipt(rawSources[key], subject); if (!source) fail(); sources[key] = source! } }
      const draft = c.draft === null ? null : parseConnectionSetupPublicationDraft(c.draft), review = c.review === null ? null : parseConnectionSetupPublicationReview(c.review)
      const allowed = connectionSetupPublicationSubjects(effect) as readonly ConnectionSetupReadSubject[]
      const requiredSubjects = names(c.requiredSubjects).map(subject => choice(subject, allowed))
      const reduced = requiredSubjects.length === 1 && requiredSubjects[0] === (effect === 'create-application-version' ? 'publication-versions' : 'publication-version')
      if (!requiredSubjects.length || requiredSubjects.length !== allowed.length && !reduced || reduced && !operation!.source) fail()
      if (requiredSubjects.length === allowed.length && allowed.some(subject => !requiredSubjects.includes(subject))) fail()
      if (!operation!.source && [...effects, ...(selected ? [selected] : [])].some(receipt => (receipt.effect === 'create-application-version' || receipt.effect === 'submit-application-version') && Object.keys(receipt.sourceStepIds).length !== allowed.length)) fail()
      const initialReview = effect === 'create-application-version' && !!operation!.source && !!sources.versions && review?.versions.length === 0 && review.creatorAudienceAvailable

      if (method === 'connection.setup.advance') {
        const original = (input as ConnectionSetupParamsMap['connection.setup.advance']).publicationDraft
        if (!original || JSON.stringify(selected?.input.publicationDraft) !== JSON.stringify(original) || JSON.stringify(draft) !== JSON.stringify(original)) fail()
      }
      if (draft && (effect === 'create-application-version' ? draft.kind !== 'create-version' : draft.kind !== 'submit-version')) fail()
      if (selector && 'draft' in selector && JSON.stringify(selector.draft ?? null) !== JSON.stringify(draft)) fail()
      if (c.subject !== (effect === 'create-application-version' ? 'publication-pending' : 'publication-version') || review && !qualified || capability !== 'unknown' && (!draft || !review || review.issues.length || !qualified || requiredSubjects.some(subject => !sources[subject.slice(12)]) || reduced && effect === 'create-application-version' && (!initialReview || draft.kind !== 'create-version' || draft.visibility !== 'creator-only' || !draft.desktopEntry || !draft.mobileEntry))) fail()
      if (sources.version && (draft?.kind !== 'submit-version' || sources.version.versionId !== draft.versionId)) fail()
      if (review && (review.versions.length > 0 && !sources.versions || review.selectedVersion && (!sources.version || draft?.kind !== 'submit-version' || review.selectedVersion.versionId !== draft.versionId) || review.changes.length > 0 && !(effect === 'create-application-version' ? sources.pending : sources.version) || review.audience && !(effect === 'create-application-version' ? sources.visibility : sources.version) || review.proposedAudience && !(effect === 'create-application-version' ? sources.visibility || initialReview : sources.version) || review.entries && !(effect === 'create-application-version' ? sources.pending || initialReview : sources.version) || review.sharing && (!(effect === 'create-application-version' ? sources.sharing : sources.version) || !sources.features) || review.reasonRequired !== null && !sources.pending || review.creatorAudienceAvailable && !operation!.source)) fail()
      result.applicationConfiguration = { ...common, effect, subject: effect === 'create-application-version' ? 'publication-pending' : 'publication-version', sources, requiredSubjects, draft, review }
    } else if (effect === 'upload-profile-avatar' || effect === 'update-application-profile') {
      const source = sourceReceipt(c.source, 'application-details')
      if (c.subject !== 'application-details' || operation!.goal.kind !== 'profile-update' || capability !== 'unknown' && (!source || !qualified)) fail()
      result.applicationConfiguration = { ...common, effect, subject: 'application-details', source }
    } else {
      const subject = connectionSetupConfigurationSubject(effect), source = sourceReceipt(c.source, subject)
      if (c.subject !== subject || capability !== 'unknown' && (!source || !qualified)) fail()
      result.applicationConfiguration = { ...common, effect, subject, source }
    }
    if (result.applicationConfiguration.reason === 'original-effect-unconfirmed' && actions.some(a => a.kind !== 'recover-configuration-effect')) fail()
    if (c.unresolvedProfile !== undefined) {
      const u = object(c.unresolvedProfile, ['operationId', 'connectionId'])
      if (effect !== 'update-application-profile' || result.applicationConfiguration.reason !== 'original-effect-unconfirmed') fail()
      result.applicationConfiguration.unresolvedProfile = { operationId: id(u.operationId), connectionId: id(u.connectionId) }
    }
    if (c.unresolved !== undefined) {
      const u = object(c.unresolved, ['operationId', 'connectionId', 'stepId'])
      if (result.applicationConfiguration.reason !== 'original-effect-unconfirmed') fail()
      result.applicationConfiguration.unresolved = { operationId: id(u.operationId), connectionId: id(u.connectionId), stepId: id(u.stepId) }
    }
  }
  return result as ConnectionSetupResultMap[M]
}
