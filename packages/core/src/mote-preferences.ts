import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseFileReadParams, parseFileReadResult, type FileDocument, type FileReadResource, type FileReadResult,
  type FileResource } from './public-rpc-files.js'

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
export type MotePreferencesReadInput = { kind: 'quick'; target: MotePreferencesTarget }
export type MotePreferencesReadResult = MotePreferencesReadInput & {
  status: 'ready' | 'unconfirmed'; source: FileReadResult | null; defaults: MoteQuickDefaults | null
  choices: MoteQuickChoices; main: boolean | null; issue: string | null
}
export type MotePreferencesSaveInput = MotePreferencesReadInput & {
  baseline: MoteQuickBaseline; values: MoteQuickDefaults; destination: MotePreferencesDestination
}
export type MotePreferencesSaveParams = MotePreferencesSaveInput & { operationId: string }
export type MotePreferencesSaveResult = MotePreferencesReadInput & {
  operationId: string; status: 'saved' | 'unchanged' | 'refused-before-write' | 'unconfirmed'
  source: MoteQuickBaseline | null; message: string | null
}

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
export function parseMotePreferencesReadInput(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MotePreferencesReadInput {
  const p = fields(value, ['kind', 'target'], ['kind', 'target'], code)
  if (p.kind !== 'quick') fail('This Mote preference kind is not available.', code)
  return { kind: 'quick', target: parseMotePreferencesTarget(p.target, code) }
}
export function parseMotePreferencesSaveInput(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): MotePreferencesSaveInput {
  const p = fields(value, ['kind', 'target', 'baseline', 'values', 'destination'], ['kind', 'target', 'baseline', 'values', 'destination'], code)
  const base = parseMotePreferencesReadInput({ kind: p.kind, target: p.target }, code)
  return { ...base, baseline: parseMoteQuickBaseline(p.baseline, base.target, code), values: parseMoteQuickDefaults(p.values, code), destination: parseMotePreferencesDestination(p.destination, code) }
}
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
export function parseMotePreferencesReadResult(value: unknown, input?: MotePreferencesReadInput): MotePreferencesReadResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = fields(value, ['kind', 'target', 'status', 'source', 'defaults', 'choices', 'main', 'issue'], ['kind', 'target', 'status', 'source', 'defaults', 'choices', 'main', 'issue'], code)
  const base = parseMotePreferencesReadInput({ kind: p.kind, target: p.target }, code)
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
  return { ...base, status: p.status as 'ready' | 'unconfirmed', source, defaults, choices, main: p.main as boolean | null, issue: p.issue as string | null }
}
export function moteQuickBaseline(read: MotePreferencesReadResult): MoteQuickBaseline | null {
  return read.status === 'ready' && read.source?.resource && read.defaults ? {
    resource: read.source.resource, document: read.source.result.status === 'read' ? read.source.result.document : null, defaults: read.defaults
  } : null
}
export function parseMotePreferencesSaveResult(value: unknown, params?: MotePreferencesSaveParams): MotePreferencesSaveResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = fields(value, ['kind', 'target', 'operationId', 'status', 'source', 'message'], ['kind', 'target', 'operationId', 'status', 'source', 'message'], code)
  const base = parseMotePreferencesReadInput({ kind: p.kind, target: p.target }, code), operationId = id(p.operationId, code)
  if (params && (operationId !== params.operationId || !sameMotePreferencesTarget(base.target, params.target) || base.kind !== params.kind)) fail('Mote save receipt belongs to another original request.', code)
  if (!['saved', 'unchanged', 'refused-before-write', 'unconfirmed'].includes(String(p.status)) || !(p.message === null || typeof p.message === 'string')) fail('Mote save receipt is invalid.', code)
  const source = p.source === null ? null : parseMoteQuickBaseline(p.source, base.target, code)
  const confirmed = p.status === 'saved' || p.status === 'unchanged'
  if (confirmed && (!source?.document || params && !sameMoteQuickDefaults(source.defaults, params.values)) || !confirmed && (!p.message || source !== null)) fail('Mote save status lacks its original writer facts.', code)
  return { ...base, operationId, status: p.status as MotePreferencesSaveResult['status'], source, message: p.message as string | null }
}
