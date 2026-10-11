import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

export const APPLICATION_ACCESS_SCHEMA = 'agentmux.application-access.v1'
export type ApplicationAccessEndpoint = { hostId: string; runtimeId: string; osAccount: string; command: string; args: string[] }
export type ApplicationAccessProfile = { label: string; applicationId: string; source: ApplicationAccessEndpoint; target: ApplicationAccessEndpoint; accountId: string; scopes: string[] }
export type ApplicationAccessConfiguration = { profileId: string; revision: string; profile: ApplicationAccessProfile }
export type ApplicationAccessObservation = {
  hostId: string; runtimeId: string | null; osAccount: string | null
  status: 'ready' | 'login-required' | 'unsupported' | 'unknown'; applicationId: string
  accountId: string | null; scopes: string[]; revision: string | null; transferable: boolean
  cause?: { code: string; message: string }
}
export type ApplicationAccessPlan = {
  planId: string; profileId: string; configurationRevision: string; createdAt: string
  source: ApplicationAccessObservation; target: ApplicationAccessObservation
  disposition: 'transfer' | 'reuse' | 'source-login-required' | 'target-login-required' | 'conflict' | 'unsupported' | 'unknown'
  accountId: string; scopes: string[]
}
export type ApplicationAccessOperation = {
  operationId: string; profileId: string; planId: string; configurationRevision: string; applicationId: string
  source: Pick<ApplicationAccessEndpoint, 'hostId' | 'runtimeId' | 'osAccount'>; target: Pick<ApplicationAccessEndpoint, 'hostId' | 'runtimeId' | 'osAccount'>
  accountId: string; scopes: string[]; createdAt: string; updatedAt: string
  status: 'pending' | 'succeeded' | 'failed' | 'unknown'; stage: 'prepared' | 'exporting' | 'import-dispatched' | 'verifying' | 'complete'
  targetObservation?: ApplicationAccessObservation; cause?: { code: string; message: string }
}
export const APPLICATION_ACCESS_METHODS = {
  'settings.applications.ls': 'long', 'settings.applications.configure': 'long', 'settings.applications.delete': 'long',
  'settings.applications.plan': 'long', 'settings.applications.apply': 'long', 'settings.applications.operation': 'long'
} as const
export type ApplicationAccessMethod = keyof typeof APPLICATION_ACCESS_METHODS
export type ApplicationAccessParameterMap = {
  'settings.applications.ls': { hostId?: string }
  'settings.applications.configure': { profileId: string; profile: ApplicationAccessProfile; expectedRevision: string | null }
  'settings.applications.delete': { profileId: string; expectedRevision: string }
  'settings.applications.plan': { profileId: string; expectedRevision: string }
  'settings.applications.apply': { profileId: string; planId: string; operationId: string }
  'settings.applications.operation': { operationId: string }
}
export type ApplicationAccessResultMap = {
  'settings.applications.ls': { configurations: ApplicationAccessConfiguration[]; operations: ApplicationAccessOperation[] }
  'settings.applications.configure': ApplicationAccessConfiguration
  'settings.applications.delete': { profileId: string; deleted: true }
  'settings.applications.plan': ApplicationAccessPlan
  'settings.applications.apply': ApplicationAccessOperation
  'settings.applications.operation': ApplicationAccessOperation
}
export type ApplicationAccessPort = { call<M extends ApplicationAccessMethod>(method: M, params: ApplicationAccessParameterMap[M], signal?: AbortSignal): Promise<ApplicationAccessResultMap[M]> }
export function isApplicationAccessMethod(value: unknown): value is ApplicationAccessMethod { return typeof value === 'string' && Object.hasOwn(APPLICATION_ACCESS_METHODS, value) }
export function applicationAccessText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) throw new AgentMuxError('Application access requires a nonempty single-line identifier.', 'INVALID_APPLICATION_ACCESS')
  return value
}
export function applicationAccessScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(scope => typeof scope !== 'string')) throw new AgentMuxError('Application scopes must be an array of distinct identifiers.', 'INVALID_APPLICATION_ACCESS')
  const scopes = value.map(applicationAccessText)
  if (new Set(scopes).size !== scopes.length) throw new AgentMuxError('Application scopes must be distinct.', 'INVALID_APPLICATION_ACCESS')
  return [...scopes].sort()
}
function endpoint(value: unknown, commands = true): ApplicationAccessEndpoint {
  const p = rpcRecord(value, ['hostId', 'runtimeId', 'osAccount', ...(commands ? ['command', 'args'] : [])])
  const identity = { hostId: applicationAccessText(p.hostId), runtimeId: applicationAccessText(p.runtimeId), osAccount: applicationAccessText(p.osAccount) }
  if (!commands) return identity as ApplicationAccessEndpoint
  if (!Array.isArray(p.args) || p.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new AgentMuxError('Connector argv must be literal strings without NUL.', 'INVALID_APPLICATION_ACCESS')
  const command = applicationAccessText(p.command)
  if (!command.startsWith('/')) throw new AgentMuxError('Use the absolute connector executable path on its execution Host.', 'INVALID_APPLICATION_ACCESS')
  return { ...identity, command, args: [...p.args] as string[] }
}
export function parseApplicationAccessProfile(value: unknown): ApplicationAccessProfile {
  const p = rpcRecord(value, ['label', 'applicationId', 'source', 'target', 'accountId', 'scopes']), scopes = applicationAccessScopes(p.scopes)
  if (!scopes.length) throw new AgentMuxError('Select at least one explicit application scope.', 'INVALID_APPLICATION_ACCESS')
  return { label: applicationAccessText(p.label), applicationId: applicationAccessText(p.applicationId), source: endpoint(p.source), target: endpoint(p.target), accountId: applicationAccessText(p.accountId), scopes }
}
export function parseApplicationAccessParams<M extends ApplicationAccessMethod>(method: M, value: unknown): ApplicationAccessParameterMap[M] {
  const fields = method === 'settings.applications.ls' ? ['hostId'] : method === 'settings.applications.configure' ? ['profileId', 'profile', 'expectedRevision'] : method === 'settings.applications.apply' ? ['profileId', 'planId', 'operationId'] : method === 'settings.applications.operation' ? ['operationId'] : ['profileId', 'expectedRevision']
  const p = rpcRecord(value, fields), text = applicationAccessText
  if (method === 'settings.applications.ls') return (p.hostId === undefined ? {} : { hostId: text(p.hostId) }) as ApplicationAccessParameterMap[M]
  if (method === 'settings.applications.operation') return { operationId: text(p.operationId) } as ApplicationAccessParameterMap[M]
  const profileId = text(p.profileId)
  if (method === 'settings.applications.configure') return { profileId, profile: parseApplicationAccessProfile(p.profile), expectedRevision: p.expectedRevision === null ? null : text(p.expectedRevision) } as ApplicationAccessParameterMap[M]
  if (method === 'settings.applications.apply') return { profileId, planId: text(p.planId), operationId: text(p.operationId) } as ApplicationAccessParameterMap[M]
  return { profileId, expectedRevision: text(p.expectedRevision) } as ApplicationAccessParameterMap[M]
}
const member = <T extends string>(value: unknown, values: readonly T[]): T => { if (!values.includes(value as T)) throw new AgentMuxError('Application result contains an invalid state.', 'CONTROL_PROTOCOL_ERROR'); return value as T }
function cause(value: unknown): { code: string; message: string } { const p = rpcRecord(value, ['code', 'message']); return { code: applicationAccessText(p.code), message: applicationAccessText(p.message) } }
export function parseApplicationAccessObservation(value: unknown): ApplicationAccessObservation {
  const p = rpcRecord(value, ['hostId', 'runtimeId', 'osAccount', 'status', 'applicationId', 'accountId', 'scopes', 'revision', 'transferable', 'cause'])
  if (typeof p.transferable !== 'boolean') throw new AgentMuxError('Application transfer capability is unconfirmed.', 'CONTROL_PROTOCOL_ERROR')
  const nullable = (value: unknown) => value === null ? null : applicationAccessText(value)
  return { hostId: applicationAccessText(p.hostId), runtimeId: nullable(p.runtimeId), osAccount: nullable(p.osAccount), status: member(p.status, ['ready', 'login-required', 'unsupported', 'unknown']), applicationId: applicationAccessText(p.applicationId), accountId: nullable(p.accountId), scopes: applicationAccessScopes(p.scopes), revision: nullable(p.revision), transferable: p.transferable, ...(p.cause === undefined ? {} : { cause: cause(p.cause) }) }
}
export function parseApplicationAccessPlan(value: unknown): ApplicationAccessPlan {
  const p = rpcRecord(value, ['planId', 'profileId', 'configurationRevision', 'createdAt', 'source', 'target', 'disposition', 'accountId', 'scopes'])
  return { planId: applicationAccessText(p.planId), profileId: applicationAccessText(p.profileId), configurationRevision: applicationAccessText(p.configurationRevision), createdAt: applicationAccessText(p.createdAt), source: parseApplicationAccessObservation(p.source), target: parseApplicationAccessObservation(p.target), disposition: member(p.disposition, ['transfer', 'reuse', 'source-login-required', 'target-login-required', 'conflict', 'unsupported', 'unknown']), accountId: applicationAccessText(p.accountId), scopes: applicationAccessScopes(p.scopes) }
}
export function parseApplicationAccessOperation(value: unknown): ApplicationAccessOperation {
  const p = rpcRecord(value, ['operationId', 'profileId', 'planId', 'configurationRevision', 'applicationId', 'source', 'target', 'accountId', 'scopes', 'createdAt', 'updatedAt', 'status', 'stage', 'targetObservation', 'cause'])
  return { operationId: applicationAccessText(p.operationId), profileId: applicationAccessText(p.profileId), planId: applicationAccessText(p.planId), configurationRevision: applicationAccessText(p.configurationRevision), applicationId: applicationAccessText(p.applicationId), source: endpoint(p.source, false), target: endpoint(p.target, false), accountId: applicationAccessText(p.accountId), scopes: applicationAccessScopes(p.scopes), createdAt: applicationAccessText(p.createdAt), updatedAt: applicationAccessText(p.updatedAt), status: member(p.status, ['pending', 'succeeded', 'failed', 'unknown']), stage: member(p.stage, ['prepared', 'exporting', 'import-dispatched', 'verifying', 'complete']), ...(p.targetObservation === undefined ? {} : { targetObservation: parseApplicationAccessObservation(p.targetObservation) }), ...(p.cause === undefined ? {} : { cause: cause(p.cause) }) }
}
function parseApplicationAccessResultValue<M extends ApplicationAccessMethod>(method: M, value: unknown, input: ApplicationAccessParameterMap[M]): ApplicationAccessResultMap[M] {
  const fail = (): never => { throw new AgentMuxError('Application access response belongs to another original object.', 'CONTROL_PROTOCOL_ERROR') }
  const configuration = (value: unknown): ApplicationAccessConfiguration => { const p = rpcRecord(value, ['profileId', 'revision', 'profile']); return { profileId: applicationAccessText(p.profileId), revision: applicationAccessText(p.revision), profile: parseApplicationAccessProfile(p.profile) } }
  if (method === 'settings.applications.ls') {
    const p = rpcRecord(value, ['configurations', 'operations']); if (!Array.isArray(p.configurations) || !Array.isArray(p.operations)) fail()
    const configurations = (p.configurations as unknown[]).map(configuration), operations = (p.operations as unknown[]).map(parseApplicationAccessOperation), hostId = (input as ApplicationAccessParameterMap['settings.applications.ls']).hostId
    if (new Set(configurations.map(c => c.profileId)).size !== configurations.length || new Set(operations.map(o => o.operationId)).size !== operations.length || hostId && (configurations.some(c => c.profile.source.hostId !== hostId && c.profile.target.hostId !== hostId) || operations.some(o => o.source.hostId !== hostId && o.target.hostId !== hostId))) fail()
    return { configurations, operations } as ApplicationAccessResultMap[M]
  }
  if (method === 'settings.applications.configure') { const result = configuration(value); if (result.profileId !== (input as ApplicationAccessParameterMap['settings.applications.configure']).profileId) fail(); return result as ApplicationAccessResultMap[M] }
  if (method === 'settings.applications.delete') { const p = rpcRecord(value, ['profileId', 'deleted']); if (p.profileId !== (input as ApplicationAccessParameterMap['settings.applications.delete']).profileId || p.deleted !== true) fail(); return { profileId: p.profileId, deleted: true } as ApplicationAccessResultMap[M] }
  if (method === 'settings.applications.plan') { const result = parseApplicationAccessPlan(value), query = input as ApplicationAccessParameterMap['settings.applications.plan']; if (result.profileId !== query.profileId || result.configurationRevision !== query.expectedRevision) fail(); return result as ApplicationAccessResultMap[M] }
  const result = parseApplicationAccessOperation(value), query = input as ApplicationAccessParameterMap['settings.applications.apply']
  if (result.operationId !== query.operationId || method === 'settings.applications.apply' && (result.profileId !== query.profileId || result.planId !== query.planId)) fail()
  return result as ApplicationAccessResultMap[M]
}

/** Only these original service rejections establish that this apply was not admitted. */
export const APPLICATION_ACCESS_NOT_APPLIED_CODES: readonly string[] = ['INVALID_APPLICATION_ACCESS','INVALID_CONTROL_REQUEST','CONTROL_PERMISSION_DENIED','APPLICATION_ACCESS_NOT_FOUND','APPLICATION_ACCESS_PLAN_NOT_FOUND','APPLICATION_ACCESS_CONFIGURATION_CHANGED','APPLICATION_ACCESS_PLAN_CHANGED','APPLICATION_ACCESS_PLAN_NOT_APPLICABLE','APPLICATION_ACCESS_OPERATION_CONFLICT','APPLICATION_ACCESS_OPERATION_UNRESOLVED']

/** Invalid result data follows an operation, so it can never establish that no side effect occurred. */
export function parseApplicationAccessResult<M extends ApplicationAccessMethod>(method: M,value: unknown,input: ApplicationAccessParameterMap[M]): ApplicationAccessResultMap[M] {
  try { return parseApplicationAccessResultValue(method,value,input) }
  catch { throw new AgentMuxError('The original application access response is unconfirmed. Keep its operation ID and query the original result.', 'CONTROL_PROTOCOL_ERROR') }
}
