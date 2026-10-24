import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { ConnectionApplication } from './connections-contract.js'
import type { AgentMuxSpaceFact } from './space-control.js'
import { parseFileReadParams, parseFileReadResult, type FileDocument, type FileReadResource, type FileReadResult,
  type FileResource } from './public-rpc-files.js'

/** Durable home of the default Mote, independent of its name and appearance. */
export const PMO_TEAMS_TOPIC_ID = 'launcher:leader'
export function isPrimaryMoteSpace(space: Pick<AgentMuxSpaceFact, 'kind' | 'topicId'>): boolean {
  return space.kind === 'mote' && space.topicId === PMO_TEAMS_TOPIC_ID
}

/** Values are serialized only by the original MOTE.md owner. No YAML lives here. */
export type MoteDefaultConversation = { hostId: string; sessionId: string; displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }
export type MoteQuickDefaults = { executorId?: string; conversation?: MoteDefaultConversation; recovery?: 'startup' | 'on-open' }
export type MotePreferencesTarget = { spaceId: string; zoneId: string; expectedResource: FileResource }
export type MotePreferencesDestination =
  | { kind: 'occurrence'; displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }
  | { kind: 'empty'; displayWorkspaceId: string; groupId: string }
export type MoteQuickChoices = {
  executors: { id: string; name: string; providerId: string }[]
  conversations: { reference: MoteDefaultConversation; label: string }[]
  destinations: { reference: MotePreferencesDestination; label: string }[]
}
export type MoteQuickBaseline = { resource: FileReadResource; document: FileDocument | null; defaults: MoteQuickDefaults }
export type MoteQuickPreferencesReadInput = { kind: 'quick'; target: MotePreferencesTarget }
export type MoteQuickPreferencesReadResult = MoteQuickPreferencesReadInput & {
  status: 'ready' | 'unconfirmed'; source: FileReadResult | null; defaults: MoteQuickDefaults | null
  choices: MoteQuickChoices; main: boolean | null; issue: string | null
}
export type MoteQuickPreferencesSaveInput = MoteQuickPreferencesReadInput & {
  baseline: MoteQuickBaseline; values: MoteQuickDefaults; destination: MotePreferencesDestination
}
export type MoteQuickPreferencesSaveParams = MoteQuickPreferencesSaveInput & { operationId: string }
export type MoteQuickPreferencesSaveResult = MoteQuickPreferencesReadInput & {
  operationId: string; status: 'saved' | 'unchanged' | 'refused-before-write' | 'unconfirmed'
  source: MoteQuickBaseline | null; message: string | null
}
/** A reference in the original Connection service, never another credential owner. */
export type MoteConnectionRef = { connectionId: string; application: ConnectionApplication }
export type MoteConnectionValues = { connection: MoteConnectionRef | null }
export type MoteConnectionBaseline = { resource: FileReadResource; document: FileDocument | null; values: MoteConnectionValues }
export type MoteConnectionPreferencesReadInput = { kind: 'connection'; target: MotePreferencesTarget }
export type MoteConnectionPreferencesReadResult = MoteConnectionPreferencesReadInput & {
  status: 'ready' | 'unconfirmed'; source: FileReadResult | null; values: MoteConnectionValues | null; issue: string | null
}
export type MoteConnectionPreferencesSaveInput = MoteConnectionPreferencesReadInput & { baseline: MoteConnectionBaseline; values: MoteConnectionValues }
export type MoteConnectionPreferencesSaveParams = MoteConnectionPreferencesSaveInput & { operationId: string }
export type MoteConnectionPreferencesSaveResult = MoteConnectionPreferencesReadInput & {
  operationId: string; status: 'saved' | 'unchanged' | 'refused-before-write' | 'unconfirmed'; source: MoteConnectionBaseline | null; message: string | null
}
/** Borrow the original connection-preference owner without installing a general control handler. */
export interface MoteConnectionPreferencesPort {
  read(input: MoteConnectionPreferencesReadInput): Promise<MoteConnectionPreferencesReadResult>
  save(input: MoteConnectionPreferencesSaveParams, context?: import('./connection-enrollment-contract.js').ConnectionEnrollmentCallContext): Promise<MoteConnectionPreferencesSaveResult>
}
export type MotePreferencesReadInput = MoteQuickPreferencesReadInput | MoteConnectionPreferencesReadInput
export type MotePreferencesReadResult = MoteQuickPreferencesReadResult | MoteConnectionPreferencesReadResult
export type MotePreferencesSaveInput = MoteQuickPreferencesSaveInput | MoteConnectionPreferencesSaveInput
export type MotePreferencesSaveParams = MoteQuickPreferencesSaveParams | MoteConnectionPreferencesSaveParams
export type MotePreferencesSaveResult = MoteQuickPreferencesSaveResult | MoteConnectionPreferencesSaveResult
export type MotePreferencesSaveControlResult = Omit<MoteQuickPreferencesSaveResult, 'operationId'> | Omit<MoteConnectionPreferencesSaveResult, 'operationId'>

type Code = 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR' | 'INVALID_CLI_ARGUMENT'
const fail = (message: string, code: Code): never => { throw new AgentMuxError(message, code) }
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
function text(value: unknown, code: Code): string {
  if (typeof value !== 'string') return fail('Mote preferences text is invalid.', code)
  return value
}
function id(value: unknown, code: Code, spatial = false): string {
  const result = text(value, code)
  if (!result.trim() || result === 'self' || /[\0\r\n]/u.test(result) || bytes(result) > (spatial ? 16384 : 512)) {
    return fail('Mote preferences require an exact original identity.', code)
  }
  return result
}
function fields(value: unknown, allowed: string[], required: string[], code: Code) {
  const result = rpcRecord(value, allowed, code)
  if (required.some(key => !Object.hasOwn(result, key))) fail('Mote preferences are missing original facts.', code)
  return result
}
const tupleFields = ['hostId', 'sessionId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'] as const
export function parseMoteDefaultConversation(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MoteDefaultConversation {
  const c = fields(value, [...tupleFields], [...tupleFields], code)
  return Object.fromEntries(tupleFields.map(key => [key, id(c[key], code, key === 'tabId' || key === 'regionId')])) as MoteDefaultConversation
}
export function sameMoteQuickDefaults(a: MoteQuickDefaults, b: MoteQuickDefaults): boolean {
  return a.executorId === b.executorId && a.recovery === b.recovery && (a.conversation === b.conversation || !!a.conversation && !!b.conversation &&
    tupleFields.every(key => a.conversation![key] === b.conversation![key]))
}
export function sameMotePreferencesTarget(a: MotePreferencesTarget, b: MotePreferencesTarget): boolean {
  return a.spaceId === b.spaceId && a.zoneId === b.zoneId && (['hostId', 'workspaceId', 'workspacePath'] as const)
    .every(key => a.expectedResource[key] === b.expectedResource[key])
}
export function parseMoteConnectionValues(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MoteConnectionValues {
  const p = fields(value, ['connection'], ['connection'], code)
  if (p.connection === null) return { connection: null }
  const ref = fields(p.connection, ['connectionId', 'application'], ['connectionId', 'application'], code)
  const app = fields(ref.application, ['domain', 'appId'], ['domain', 'appId'], code)
  const connectionId = text(ref.connectionId, code), domain = text(app.domain, code), appId = text(app.appId, code)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(connectionId) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(domain) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(appId)) fail('The original Connection reference is invalid.', code)
  return { connection: { connectionId, application: { domain, appId } } }
}
export function sameMoteConnectionValues(a: MoteConnectionValues, b: MoteConnectionValues): boolean {
  return a.connection === b.connection || !!a.connection && !!b.connection && a.connection.connectionId === b.connection.connectionId &&
    a.connection.application.domain === b.connection.application.domain && a.connection.application.appId === b.connection.application.appId
}
export function parseMoteQuickDefaults(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MoteQuickDefaults {
  const p = fields(value, ['executorId', 'conversation', 'recovery'], [], code), result: MoteQuickDefaults = {}
  if (Object.hasOwn(p, 'executorId')) result.executorId = id(p.executorId, code)
  if (Object.hasOwn(p, 'conversation')) {
    result.conversation = parseMoteDefaultConversation(p.conversation, code)
  }
  if (Object.hasOwn(p, 'recovery')) {
    if (p.recovery !== 'startup' && p.recovery !== 'on-open') fail('Mote recovery timing is invalid.', code)
    result.recovery = p.recovery as 'startup' | 'on-open'
  }
  return result
}
export function parseMotePreferencesTarget(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MotePreferencesTarget {
  const p = fields(value, ['spaceId', 'zoneId', 'expectedResource'], ['spaceId', 'zoneId', 'expectedResource'], code)
  const target = { spaceId: id(p.spaceId, code, true), zoneId: id(p.zoneId, code, true), expectedResource: p.expectedResource as FileResource }
  parseFileReadParams({ ...target, path: 'MOTE.md' })
  return structuredClone(target)
}
export function parseMotePreferencesDestination(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MotePreferencesDestination {
  const p = fields(value, ['kind', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'], ['kind', 'displayWorkspaceId', 'groupId'], code)
  const base = { displayWorkspaceId: id(p.displayWorkspaceId, code), groupId: id(p.groupId, code) }
  if (p.kind === 'empty') {
    fields(p, ['kind', 'displayWorkspaceId', 'groupId'], ['kind', 'displayWorkspaceId', 'groupId'], code)
    return { kind: 'empty', ...base }
  }
  if (p.kind !== 'occurrence') fail('Choose an original Mote display or an explicit empty Group.', code)
  return { kind: 'occurrence', ...base, tabId: id(p.tabId, code, true), regionId: id(p.regionId, code, true) }
}
export function parseMoteQuickBaseline(value: unknown, target: MotePreferencesTarget, code: Code = 'INVALID_CONTROL_REQUEST'): MoteQuickBaseline {
  const p = fields(value, ['resource', 'document', 'defaults'], ['resource', 'document', 'defaults'], code)
  const read = parseFileReadResult({ resource: p.resource, result: p.document === null ? { status: 'deleted' } : { status: 'read', document: p.document } }, { ...target, path: 'MOTE.md' })
  if (!read.resource || read.result.status !== 'read' && read.result.status !== 'deleted') fail('The complete original MOTE.md baseline is required.', code)
  return { resource: read.resource!, document: read.result.status === 'read' ? read.result.document : null, defaults: parseMoteQuickDefaults(p.defaults, code) }
}
export function parseMoteConnectionBaseline(value: unknown, target: MotePreferencesTarget, code: Code = 'INVALID_CONTROL_REQUEST'): MoteConnectionBaseline {
  const p = fields(value, ['resource', 'document', 'values'], ['resource', 'document', 'values'], code)
  const read = parseFileReadResult({ resource: p.resource, result: p.document === null ? { status: 'deleted' } : { status: 'read', document: p.document } }, { ...target, path: 'MOTE.md' })
  if (!read.resource || read.result.status !== 'read' && read.result.status !== 'deleted') fail('The complete original MOTE.md baseline is required.', code)
  return { resource: read.resource!, document: read.result.status === 'read' ? read.result.document : null, values: parseMoteConnectionValues(p.values, code) }
}
export function parseMotePreferencesReadInput(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MotePreferencesReadInput {
  const p = fields(value, ['kind', 'target'], ['kind', 'target'], code)
  if (p.kind !== 'quick' && p.kind !== 'connection') fail('This Mote preference kind is not available.', code)
  return { kind: p.kind as 'quick' | 'connection', target: parseMotePreferencesTarget(p.target, code) }
}
export function parseMotePreferencesSaveInput(value: MoteQuickPreferencesSaveInput, code?: Code): MoteQuickPreferencesSaveInput
export function parseMotePreferencesSaveInput(value: MoteConnectionPreferencesSaveInput, code?: Code): MoteConnectionPreferencesSaveInput
export function parseMotePreferencesSaveInput(value: unknown, code?: Code): MotePreferencesSaveInput
export function parseMotePreferencesSaveInput(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MotePreferencesSaveInput {
  const p = fields(value, ['kind', 'target', 'baseline', 'values', 'destination'], ['kind', 'target', 'baseline', 'values'], code)
  const base = parseMotePreferencesReadInput({ kind: p.kind, target: p.target }, code)
  if (base.kind === 'connection') {
    fields(p, ['kind', 'target', 'baseline', 'values'], [], code)
    return { ...base, baseline: parseMoteConnectionBaseline(p.baseline, base.target, code), values: parseMoteConnectionValues(p.values, code) }
  }
  return { ...base, baseline: parseMoteQuickBaseline(p.baseline, base.target, code), values: parseMoteQuickDefaults(p.values, code), destination: parseMotePreferencesDestination(p.destination, code) }
}
export function parseMotePreferencesSaveParams(value: MoteQuickPreferencesSaveParams, code?: Code): MoteQuickPreferencesSaveParams
export function parseMotePreferencesSaveParams(value: MoteConnectionPreferencesSaveParams, code?: Code): MoteConnectionPreferencesSaveParams
export function parseMotePreferencesSaveParams(value: unknown, code?: Code): MotePreferencesSaveParams
export function parseMotePreferencesSaveParams(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MotePreferencesSaveParams {
  const p = fields(value, ['kind', 'target', 'baseline', 'values', 'destination', 'operationId'], ['operationId'], code)
  const { operationId, ...input } = p
  return { ...parseMotePreferencesSaveInput(input, code), operationId: id(operationId, code) }
}
function list<T>(value: unknown, parse: (item: unknown) => T, key: (item: T) => string, code: Code): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail('Mote discovery choices must be a JSON array.', code)
  const result = Array.from({ length: (value as unknown[]).length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, String(index))
    if (!entry?.enumerable || !('value' in entry)) fail('Mote discovery choices must contain only JSON data.', code)
    return parse(entry!.value)
  })
  if (new Set(result.map(key)).size !== result.length) fail('Mote discovery choices contain duplicate original identities.', code)
  return result
}
export function parseMotePreferencesReadResult(value: unknown, input: MoteQuickPreferencesReadInput): MoteQuickPreferencesReadResult
export function parseMotePreferencesReadResult(value: unknown, input: MoteConnectionPreferencesReadInput): MoteConnectionPreferencesReadResult
export function parseMotePreferencesReadResult(value: unknown, input?: MotePreferencesReadInput): MotePreferencesReadResult
export function parseMotePreferencesReadResult(value: unknown, input?: MotePreferencesReadInput): MotePreferencesReadResult {
  if (rpcRecord(value).kind === 'connection') {
    const code = 'CONTROL_PROTOCOL_ERROR', p = fields(value, ['kind', 'target', 'status', 'source', 'values', 'issue'], ['kind', 'target', 'status', 'source', 'values', 'issue'], code)
    const base: MoteConnectionPreferencesReadInput = { kind: 'connection', target: parseMotePreferencesTarget(p.target, code) }
    if (input && (input.kind !== base.kind || !sameMotePreferencesTarget(base.target, input.target))) fail('Mote preference read belongs to another original target.', code)
    const source = p.source === null ? null : parseFileReadResult(p.source, { ...base.target, path: 'MOTE.md' })
    const values = p.values === null ? null : parseMoteConnectionValues(p.values, code)
    if (p.status !== 'ready' && p.status !== 'unconfirmed' || !(p.issue === null || typeof p.issue === 'string') ||
      p.status === 'ready' && (!source?.resource || source.result.status !== 'read' && source.result.status !== 'deleted' || !values || p.issue !== null) ||
      p.status === 'unconfirmed' && !p.issue) fail('Mote connection read lacks its original File facts.', code)
    return { ...base, status: p.status as 'ready' | 'unconfirmed', source, values, issue: p.issue as string | null }
  }
  const code = 'CONTROL_PROTOCOL_ERROR', p = fields(value, ['kind', 'target', 'status', 'source', 'defaults', 'choices', 'main', 'issue'], ['kind', 'target', 'status', 'source', 'defaults', 'choices', 'main', 'issue'], code)
  const base = parseMotePreferencesReadInput({ kind: p.kind, target: p.target }, code)
  if (base.kind !== 'quick') fail('Mote quick read is invalid.', code)
  if (input && (base.kind !== input.kind || !sameMotePreferencesTarget(base.target, input.target))) fail('Mote preference read belongs to another original target.', code)
  const source = p.source === null ? null : parseFileReadResult(p.source, { ...base.target, path: 'MOTE.md' })
  const defaults = p.defaults === null ? null : parseMoteQuickDefaults(p.defaults, code)
  const c = fields(p.choices, ['executors', 'conversations', 'destinations'], ['executors', 'conversations', 'destinations'], code)
  const choices: MoteQuickChoices = {
    executors: list(c.executors, value => { const e = fields(value, ['id', 'name', 'providerId'], ['id', 'name', 'providerId'], code); return { id: id(e.id, code), name: text(e.name, code), providerId: id(e.providerId, code) } }, value => value.id, code),
    conversations: list(c.conversations, value => { const e = fields(value, ['reference', 'label'], ['reference', 'label'], code); return { reference: parseMoteQuickDefaults({ conversation: e.reference }, code).conversation!, label: text(e.label, code) } }, value => JSON.stringify(value.reference), code),
    destinations: list(c.destinations, value => { const e = fields(value, ['reference', 'label'], ['reference', 'label'], code); return { reference: parseMotePreferencesDestination(e.reference, code), label: text(e.label, code) } }, value => JSON.stringify(value.reference), code)
  }
  if (p.status !== 'ready' && p.status !== 'unconfirmed' || !(p.main === null || typeof p.main === 'boolean') || !(p.issue === null || typeof p.issue === 'string')) fail('Mote preference read status is invalid.', code)
  if (p.status === 'ready' && (!source?.resource || !['read', 'deleted'].includes(source.result.status) || defaults === null || p.main === null || p.issue !== null)) fail('Ready Mote preferences require actual original File facts.', code)
  if (p.status === 'unconfirmed' && !p.issue) fail('Unconfirmed Mote preferences require their original reason.', code)
  return { kind: 'quick', target: base.target, status: p.status as 'ready' | 'unconfirmed', source, defaults, choices, main: p.main as boolean | null, issue: p.issue as string | null }
}
export function moteQuickBaseline(read: MotePreferencesReadResult): MoteQuickBaseline | null {
  return read.kind === 'quick' && read.status === 'ready' && read.source?.resource && read.defaults ? {
    resource: read.source.resource, document: read.source.result.status === 'read' ? read.source.result.document : null, defaults: read.defaults
  } : null
}
export function moteConnectionBaseline(read: MoteConnectionPreferencesReadResult): MoteConnectionBaseline | null {
  return read.status === 'ready' && read.source?.resource && read.values ? {
    resource: read.source.resource, document: read.source.result.status === 'read' ? read.source.result.document : null, values: read.values
  } : null
}
export function parseMotePreferencesSaveResult(value: unknown, params: MoteQuickPreferencesSaveParams): MoteQuickPreferencesSaveResult
export function parseMotePreferencesSaveResult(value: unknown, params: MoteConnectionPreferencesSaveParams): MoteConnectionPreferencesSaveResult
export function parseMotePreferencesSaveResult(value: unknown, params?: MotePreferencesSaveParams): MotePreferencesSaveResult
export function parseMotePreferencesSaveResult(value: unknown, params?: MotePreferencesSaveParams): MotePreferencesSaveResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = fields(value, ['kind', 'target', 'operationId', 'status', 'source', 'message'], ['kind', 'target', 'operationId', 'status', 'source', 'message'], code)
  const base = parseMotePreferencesReadInput({ kind: p.kind, target: p.target }, code), operationId = id(p.operationId, code)
  if (params && (operationId !== params.operationId || !sameMotePreferencesTarget(base.target, params.target) || base.kind !== params.kind)) fail('Mote save receipt belongs to another original request.', code)
  if (p.status !== 'saved' && p.status !== 'unchanged' && p.status !== 'refused-before-write' && p.status !== 'unconfirmed' || !(p.message === null || typeof p.message === 'string')) fail('Mote save receipt is invalid.', code)
  if (base.kind === 'connection') {
    const source = p.source === null ? null : parseMoteConnectionBaseline(p.source, base.target, code)
    const confirmed = p.status === 'saved' || p.status === 'unchanged'
    if (confirmed && (!source?.document || params?.kind === 'connection' && !sameMoteConnectionValues(source.values, params.values)) ||
      !confirmed && (!p.message || source !== null)) fail('Mote save status lacks its original writer facts.', code)
    return { ...base, operationId, status: p.status as MoteConnectionPreferencesSaveResult['status'], source, message: p.message as string | null }
  }
  const source = p.source === null ? null : parseMoteQuickBaseline(p.source, base.target, code)
  const confirmed = p.status === 'saved' || p.status === 'unchanged'
  if (confirmed && (!source?.document || params?.kind === 'quick' && !sameMoteQuickDefaults(source.defaults, params.values)) || !confirmed && (!p.message || source !== null)) fail('Mote save status lacks its original writer facts.', code)
  return { ...base, operationId, status: p.status as MotePreferencesSaveResult['status'], source, message: p.message as string | null }
}
