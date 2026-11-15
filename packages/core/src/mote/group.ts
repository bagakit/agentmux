import { AgentMuxError } from '../errors.js'
import { rpcRecord } from '../rpc-data.js'
import { parseFileListParams, parseFileListResult, parseFileReadParams, parseFileReadResult,
  type FileListResult, type FileReadResult } from '../public-rpc-files.js'
import { parseMotePreferencesTarget, sameMotePreferencesTarget, type MotePreferencesTarget } from './preferences.js'

/** Maximum message length in UTF-16 code units, shared with Group composers. */
export const MOTE_GROUP_MAX_BODY_LENGTH = 64 * 1024

export type MoteGroupDelivery = {
  moteId: string
  operationId: string
  status: 'pending' | 'accepted' | 'failed' | 'unknown'
  issue?: string
}
export type MoteGroupMember = {
  moteId: string
  name: string
  target: MotePreferencesTarget
  invitation?: MoteGroupDelivery
  role: 'member' | 'admin'
  state: 'active' | 'left' | 'removed'
  thread: { hostId: string; agentSessionId: string } | null
}
export type MoteGroupMessage = {
  id: string
  sequence: number
  groupId: string
  createdAt: number
  body: string
  author: { kind: 'human'; id: string } | { kind: 'mote'; moteId: string; name: string } | { kind: 'system' }
  event?: { kind: 'announcement-updated' }
  replyToMessageId?: string
  deliveries: MoteGroupDelivery[]
}
export type MoteGroupSettings = {
  revision: number
  avatarMoteIds: string[]
  announcement: { body: string; updatedAt: number; operationId: string } | null
  topic: MotePreferencesTarget | null
}
export type MoteGroupSummary = MoteGroupSettings & {
  id: string
  name: string
  members: MoteGroupMember[]
  lastMessage: MoteGroupMessage | null
}
type Page = { beforeSequence?: number; limit?: number }
type GroupEdit = { groupId: string; operationId: string; expectedRevision: number }
type GroupFile = { groupId: string; inputOperationId?: string }
const groupEdits = ['groupId', 'operationId', 'expectedRevision'] as const
const groupFiles = ['groupId', 'inputOperationId'] as const
export type MoteGroupParamsMap = {
  'space.mote.group.list': Page & { moteId?: string }
  'space.mote.group.create': { operationId: string; name: string; members: MotePreferencesTarget[];
    avatarMoteIds?: string[]; announcement?: string; topic?: MotePreferencesTarget; adminMoteIds?: string[] }
  'space.mote.group.update': GroupEdit & { avatarMoteIds?: string[]; announcement?: string | null;
    topic?: MotePreferencesTarget | null; adminMoteIds?: string[] }
  'space.mote.group.members.add': GroupEdit & { members: MotePreferencesTarget[] }
  'space.mote.group.members.remove': GroupEdit & { memberIds: string[] }
  'space.mote.group.members.leave': GroupEdit
  'space.mote.group.file.list': GroupFile & { path?: string; limit?: number }
  'space.mote.group.file.read': GroupFile & { path: string; maxBytes?: number }
  'space.mote.group.inspect': Page & { groupId: string }
  'space.mote.group.send': { groupId: string; operationId: string; body: string; recipientIds: string[]; replyToMessageId?: string }
  'space.mote.group.retry': { groupId: string; messageId: string; memberId: string }
  'space.mote.group.reply': { groupId: string; operationId: string; inputOperationId: string; body: string }
}
export type MoteGroupResultMap = {
  'space.mote.group.list': { groups: MoteGroupSummary[]; nextBeforeSequence: number | null }
  'space.mote.group.create': { group: MoteGroupSummary }
  'space.mote.group.update': { group: MoteGroupSummary }
  'space.mote.group.members.add': { group: MoteGroupSummary }
  'space.mote.group.members.remove': { group: MoteGroupSummary }
  'space.mote.group.members.leave': { group: MoteGroupSummary }
  'space.mote.group.file.list': FileListResult
  'space.mote.group.file.read': FileReadResult
  'space.mote.group.inspect': { group: MoteGroupSummary; messages: MoteGroupMessage[]; nextBeforeSequence: number | null; viewerId: string }
  'space.mote.group.send': { message: MoteGroupMessage }
  'space.mote.group.retry': { delivery: MoteGroupDelivery }
  'space.mote.group.reply': { message: MoteGroupMessage }
}
export type MoteGroupMethod = keyof MoteGroupParamsMap
export const MOTE_GROUP_METHODS = {
  'space.mote.group.list': 'short', 'space.mote.group.create': 'long', 'space.mote.group.inspect': 'short',
  'space.mote.group.send': 'long', 'space.mote.group.retry': 'long', 'space.mote.group.reply': 'short',
  'space.mote.group.update': 'long', 'space.mote.group.members.add': 'long', 'space.mote.group.members.remove': 'short',
  'space.mote.group.members.leave': 'short', 'space.mote.group.file.list': 'long', 'space.mote.group.file.read': 'short'
} as const satisfies Record<MoteGroupMethod, 'short' | 'long'>
export const isMoteGroupMethod = (method: unknown): method is MoteGroupMethod =>
  typeof method === 'string' && Object.hasOwn(MOTE_GROUP_METHODS, method)
export type MoteGroupCallContext = {
  actor: { kind: 'human'; id: string } | { kind: 'agent'; agentSessionId: string; hostId: string; sourceRuns: readonly string[] }
  assertCurrent(): Promise<void>
}
export interface MoteGroupPort {
  call<M extends MoteGroupMethod>(method: M, input: MoteGroupParamsMap[M], context: MoteGroupCallContext): Promise<MoteGroupResultMap[M]>
}

type Code = 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR'
const invalid = (code: Code): never => {
  throw new AgentMuxError('The original Group, member, message or operation is invalid.', code)
}
function string(value: unknown, code: Code, max = 512, lines = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (lines ? /\0/u : /[\0\r\n]/u).test(value)) return invalid(code)
  return value
}
function number(value: unknown, code: Code, minimum: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > max) return invalid(code)
  return value
}
function list<T>(value: unknown, code: Code, maximum: number, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid(code)
  return value.map(parse)
}
function unique(values: readonly string[], code: Code): void {
  if (new Set(values).size !== values.length) invalid(code)
}
function target(value: unknown, code: Code): MotePreferencesTarget {
  return parseMotePreferencesTarget(value, code)
}
function page(p: Record<string, unknown>, code: Code): void {
  if (p.limit !== undefined) number(p.limit, code, 1, 100)
  if (p.beforeSequence !== undefined) number(p.beforeSequence, code, 1)
}
const requestFields = {
  'space.mote.group.list': ['moteId', 'beforeSequence', 'limit'],
  'space.mote.group.create': ['operationId', 'name', 'members', 'avatarMoteIds', 'announcement', 'topic', 'adminMoteIds'],
  'space.mote.group.update': [...groupEdits, 'avatarMoteIds', 'announcement', 'topic', 'adminMoteIds'],
  'space.mote.group.members.add': [...groupEdits, 'members'],
  'space.mote.group.members.remove': [...groupEdits, 'memberIds'],
  'space.mote.group.members.leave': groupEdits,
  'space.mote.group.file.list': [...groupFiles, 'path', 'limit'],
  'space.mote.group.file.read': [...groupFiles, 'path', 'maxBytes'],
  'space.mote.group.inspect': ['groupId', 'beforeSequence', 'limit'],
  'space.mote.group.send': ['groupId', 'operationId', 'body', 'recipientIds', 'replyToMessageId'],
  'space.mote.group.retry': ['groupId', 'messageId', 'memberId'],
  'space.mote.group.reply': ['groupId', 'operationId', 'inputOperationId', 'body']
} as const
function nonemptyUnique<T>(entries: T[], identity: (value: T) => string, code: Code): void {
  if (!entries.length) invalid(code)
  unique(entries.map(identity), code)
}
function editableSettings(p: Record<string, unknown>, code: Code, nullable: boolean) {
  if (p.avatarMoteIds !== undefined) {
    unique(list(p.avatarMoteIds, code, 4, entry => string(entry, code)), code)
  }
  if (p.adminMoteIds !== undefined) unique(list(p.adminMoteIds, code, 32, entry => string(entry, code)), code)
  if (p.announcement !== undefined && (!nullable || p.announcement !== null)) string(p.announcement, code, MOTE_GROUP_MAX_BODY_LENGTH, true)
  if (p.topic !== undefined && (!nullable || p.topic !== null)) target(p.topic, code)
}
function filePath(value: unknown, code: Code, root: boolean): string {
  const path = string(value, code, 8192)
  if (root && path === '.') return path
  if (/[\\]/u.test(path) || /^[A-Za-z]:/u.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) return invalid(code)
  return path
}

export function parseMoteGroupParams<M extends MoteGroupMethod>(method: M, value: unknown): MoteGroupParamsMap[M] {
  const code = 'INVALID_CONTROL_REQUEST', p = rpcRecord(value, requestFields[method], code)
  if (method === 'space.mote.group.list') {
    page(p, code)
    if (p.moteId !== undefined) string(p.moteId, code)
  } else if (method === 'space.mote.group.create') {
    string(p.operationId, code); string(p.name, code, 120)
    nonemptyUnique(list(p.members, code, 32, entry => target(entry, code)), member => member.spaceId, code)
    editableSettings(p, code, false)
  } else {
    string(p.groupId, code)
    if (method === 'space.mote.group.inspect') page(p, code)
    else if (method === 'space.mote.group.retry') {
      string(p.messageId, code); string(p.memberId, code)
    } else if (method === 'space.mote.group.file.list' || method === 'space.mote.group.file.read') {
      if (p.inputOperationId !== undefined) string(p.inputOperationId, code)
      if (method === 'space.mote.group.file.list') {
        if (p.path !== undefined) filePath(p.path, code, true)
        if (p.limit !== undefined) number(p.limit, code, 1, 20000)
      } else {
        filePath(p.path, code, false)
        if (p.maxBytes !== undefined) number(p.maxBytes, code, 1, 512 * 1024)
      }
    } else if (method === 'space.mote.group.update' || method === 'space.mote.group.members.add' ||
        method === 'space.mote.group.members.remove' || method === 'space.mote.group.members.leave') {
      string(p.operationId, code); number(p.expectedRevision, code, 1)
      if (method === 'space.mote.group.update') {
        if (Object.keys(p).every(field => (groupEdits as readonly string[]).includes(field))) return invalid(code)
        editableSettings(p, code, true)
      }
      if (method === 'space.mote.group.members.add') nonemptyUnique(list(p.members, code, 32, entry => target(entry, code)), member => member.spaceId, code)
      if (method === 'space.mote.group.members.remove') nonemptyUnique(list(p.memberIds, code, 32, entry => string(entry, code)), entry => entry, code)
    } else {
      string(p.operationId, code); string(p.body, code, MOTE_GROUP_MAX_BODY_LENGTH, true)
      if (method === 'space.mote.group.reply') string(p.inputOperationId, code)
      else {
        unique(list(p.recipientIds, code, 32, entry => string(entry, code)), code)
        if (p.replyToMessageId !== undefined) string(p.replyToMessageId, code)
      }
    }
  }
  return structuredClone(p) as MoteGroupParamsMap[M]
}
export function parseMoteGroupDelivery(value: unknown): MoteGroupDelivery {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['moteId', 'operationId', 'status', 'issue'], code)
  string(p.moteId, code); string(p.operationId, code)
  if (!['pending', 'accepted', 'failed', 'unknown'].includes(String(p.status))) return invalid(code)
  if (p.issue !== undefined) string(p.issue, code, 4096, true)
  return p as MoteGroupDelivery
}
export function parseMoteGroupMessage(value: unknown): MoteGroupMessage {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['id', 'sequence', 'groupId', 'createdAt', 'body', 'author', 'event', 'replyToMessageId', 'deliveries'], code)
  string(p.id, code); string(p.groupId, code); string(p.body, code, MOTE_GROUP_MAX_BODY_LENGTH, true)
  number(p.sequence, code, 1); number(p.createdAt, code, 0)
  if (p.replyToMessageId !== undefined) string(p.replyToMessageId, code)
  const author = rpcRecord(p.author, undefined, code), deliveries = list(p.deliveries, code, 32, parseMoteGroupDelivery)
  if (author.kind === 'human') {
    rpcRecord(author, ['kind', 'id'], code); string(author.id, code)
  } else if (author.kind === 'mote') {
    rpcRecord(author, ['kind', 'moteId', 'name'], code); string(author.moteId, code); string(author.name, code, 512, true)
    if (!p.replyToMessageId || deliveries.length) return invalid(code)
  } else if (author.kind === 'system') {
    rpcRecord(author, ['kind'], code)
    const event = rpcRecord(p.event, ['kind'], code)
    if (event.kind !== 'announcement-updated' || p.replyToMessageId !== undefined || deliveries.length) return invalid(code)
  } else return invalid(code)
  if (author.kind !== 'system' && p.event !== undefined) return invalid(code)
  unique(deliveries.map(delivery => delivery.moteId), code)
  unique(deliveries.map(delivery => delivery.operationId), code)
  return p as MoteGroupMessage
}
function member(value: unknown): MoteGroupMember {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['moteId', 'name', 'target', 'thread', 'role', 'state', 'invitation'], code)
  string(p.name, code, 512, true)
  const original = target(p.target, code)
  if (p.moteId !== original.spaceId || !['member', 'admin'].includes(String(p.role)) ||
      !['active', 'left', 'removed'].includes(String(p.state))) return invalid(code)
  if (p.invitation !== undefined && parseMoteGroupDelivery(p.invitation).moteId !== p.moteId) return invalid(code)
  if (p.thread !== null) {
    const thread = rpcRecord(p.thread, ['hostId', 'agentSessionId'], code)
    if (thread.hostId !== original.expectedResource.hostId) return invalid(code)
    string(thread.agentSessionId, code)
  }
  return p as MoteGroupMember
}
export function parseMoteGroupSummary(value: unknown): MoteGroupSummary {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['id', 'name', 'members', 'lastMessage', 'revision', 'avatarMoteIds', 'announcement', 'topic'], code)
  string(p.id, code); string(p.name, code, 120)
  number(p.revision, code, 1)
  const members = list(p.members, code, Number.MAX_SAFE_INTEGER, member)
  const avatarMoteIds = list(p.avatarMoteIds, code, 4, entry => string(entry, code))
  unique(avatarMoteIds, code)
  if (avatarMoteIds.some(id => !members.some(entry => entry.moteId === id && entry.state === 'active'))) return invalid(code)
  if (p.announcement !== null) {
    const announcement = rpcRecord(p.announcement, ['body', 'updatedAt', 'operationId'], code)
    string(announcement.body, code, MOTE_GROUP_MAX_BODY_LENGTH, true); number(announcement.updatedAt, code, 0); string(announcement.operationId, code)
  }
  if (p.topic !== null) target(p.topic, code)
  if (!members.length || p.lastMessage !== null && parseMoteGroupMessage(p.lastMessage).groupId !== p.id) return invalid(code)
  unique(members.map(entry => entry.moteId), code)
  return p as MoteGroupSummary
}
export function parseMoteGroupResult<M extends MoteGroupMethod>(method: M, value: unknown, input: MoteGroupParamsMap[M]): MoteGroupResultMap[M] {
  const code = 'CONTROL_PROTOCOL_ERROR'
  if (method === 'space.mote.group.list') {
    const p = rpcRecord(value, ['groups', 'nextBeforeSequence'], code), query = input as MoteGroupParamsMap['space.mote.group.list']
    const groups = list(p.groups, code, query.limit ?? 100, parseMoteGroupSummary)
    unique(groups.map(group => group.id), code)
    if (query.moteId && groups.some(group => !group.members.some(entry => entry.moteId === query.moteId && entry.state === 'active'))) return invalid(code)
    if (p.nextBeforeSequence !== null) number(p.nextBeforeSequence, code, 1, query.beforeSequence === undefined ? Number.MAX_SAFE_INTEGER : query.beforeSequence - 1)
  } else if (method === 'space.mote.group.create') {
    const p = rpcRecord(value, ['group'], code), request = input as MoteGroupParamsMap['space.mote.group.create'], group = parseMoteGroupSummary(p.group)
    if (group.name !== request.name || request.members.some(target =>
      !group.members.some(original => sameMotePreferencesTarget(original.target, target)))) return invalid(code)
  } else if (method === 'space.mote.group.update' || method === 'space.mote.group.members.add' ||
      method === 'space.mote.group.members.remove' || method === 'space.mote.group.members.leave') {
    const p = rpcRecord(value, ['group'], code), request = input as GroupEdit, group = parseMoteGroupSummary(p.group)
    if (group.id !== request.groupId || group.revision <= request.expectedRevision) return invalid(code)
  } else if (method === 'space.mote.group.file.list' || method === 'space.mote.group.file.read') {
    const observed = rpcRecord(value, ['resource', 'result'], code)
    // The Group Host verified the exact current Topic. Reuse the Files wire codec
    // to bind any returned document or entries to the original within-Topic path.
    const resource = observed.resource === null ? null : rpcRecord(observed.resource, undefined, code)
    const request = input as GroupFile & { path?: string; limit?: number; maxBytes?: number }
    const expectedResource = resource ? { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath }
      : { hostId: 'local', workspaceId: 'unavailable', workspacePath: '/' }
    const params = { zoneId: resource?.zoneId ?? 'unavailable', path: request.path ?? '.', expectedResource }
    if (method === 'space.mote.group.file.list') {
      parseFileListResult(value, parseFileListParams({ ...params, mode: 'directory', ...(request.limit === undefined ? {} : { limit: request.limit }) }))
    } else parseFileReadResult(value, parseFileReadParams({ ...params, ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }) }))
  } else if (method === 'space.mote.group.inspect') {
    const p = rpcRecord(value, ['group', 'messages', 'nextBeforeSequence', 'viewerId'], code), query = input as MoteGroupParamsMap['space.mote.group.inspect']
    string(p.viewerId, code)
    const group = parseMoteGroupSummary(p.group), messages = list(p.messages, code, query.limit ?? 100, parseMoteGroupMessage)
    if (group.id !== query.groupId || messages.some((entry, index) => entry.groupId !== group.id ||
      (query.beforeSequence !== undefined && entry.sequence >= query.beforeSequence) ||
      (index > 0 && entry.sequence <= messages[index - 1]!.sequence))) return invalid(code)
    if (p.nextBeforeSequence !== null && (!messages.length || p.nextBeforeSequence !== messages[0]!.sequence)) return invalid(code)
  } else if (method === 'space.mote.group.retry') {
    const p = rpcRecord(value, ['delivery'], code), request = input as MoteGroupParamsMap['space.mote.group.retry']
    if (parseMoteGroupDelivery(p.delivery).moteId !== request.memberId) return invalid(code)
  } else {
    const p = rpcRecord(value, ['message'], code), message = parseMoteGroupMessage(p.message)
    const request = input as MoteGroupParamsMap['space.mote.group.send'] | MoteGroupParamsMap['space.mote.group.reply']
    if (message.groupId !== request.groupId || message.body !== request.body) return invalid(code)
    if ('recipientIds' in request) {
      if (message.author.kind !== 'human' || message.replyToMessageId !== request.replyToMessageId ||
          message.deliveries.length !== request.recipientIds.length ||
          message.deliveries.some((entry, index) => entry.moteId !== request.recipientIds[index])) return invalid(code)
    } else if (message.author.kind !== 'mote') return invalid(code)
  }
  return structuredClone(value) as MoteGroupResultMap[M]
}
