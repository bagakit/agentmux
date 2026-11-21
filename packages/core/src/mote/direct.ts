import { AgentMuxError } from '../errors.js'
import { rpcRecord } from '../rpc-data.js'
import { parseMoteGroupParams, parseMoteGroupResult, type MoteGroupCallContext, type MoteGroupMember, type MoteGroupMessage, type MoteGroupSummary } from './group.js'
import { parseMotePreferencesTarget, sameMotePreferencesTarget, type MotePreferencesTarget } from './preferences.js'
import { parseAgentScheduleTiming, type AgentScheduleTiming } from '../agent-schedule.js'
import { scheduleMatchesCreation, validateScheduleRpcResult, type ScheduleResultMap } from '../public-rpc-schedules.js'
import type { MoteScheduleContext } from './scheduled-work.js'
import { parseMotePrivateImageRead, parseMotePrivateImageResult, parsePrivateImageMetadata, parsePrivateImageUploads, privateImageMetadata,
  type MotePrivateImage, type MotePrivateImageRead, type MotePrivateImageResult } from './private-images.js'
import type { FileUploadIdentity } from '../public-rpc-files.js'

type Page = { beforeSequence?: number; limit?: number }
export type MoteDirectParticipant = Pick<MoteGroupMember, 'moteId' | 'target' | 'name' | 'thread'>
export type MoteDirectMessage = Omit<MoteGroupMessage, 'groupId' | 'author' | 'event' | 'privateImages' | 'privatePriority'> & {
  threadId: string
  author: Extract<MoteGroupMessage['author'], { kind: 'mote' }>
  images?: MotePrivateImage[]
  priority?: true
}
export type MoteDirectThread = {
  id: string
  participants: MoteDirectParticipant[]
  lastMessage: MoteDirectMessage | null
  lastAssignment?: MoteGroupSummary['lastAssignment']
}
export type MoteDirectMainNotification = {
  messageId: string
  status: 'queued' | 'accepted' | 'failed' | 'unconfirmed'
  issue?: string
}

export type MoteDirectParamsMap = {
  'space.mote.direct.list': Page & { mote: MotePreferencesTarget; includeLastAssignment?: true }
  'space.mote.direct.inspect': Page & { threadId: string; mote?: MotePreferencesTarget; messageId?: string; replyToMessageId?: string }
  'space.mote.direct.send': { mote: MotePreferencesTarget; peer: MotePreferencesTarget; operationId: string; body: string; replyToMessageId?: string; images?: FileUploadIdentity[]; priority?: true }
  'space.mote.direct.schedule': Omit<MoteDirectParamsMap['space.mote.direct.send'], 'replyToMessageId' | 'images' | 'priority'> & AgentScheduleTiming & { checkIn?: never }
  'space.mote.direct.reply': { threadId: string; operationId: string; inputOperationId: string; body: string; images?: FileUploadIdentity[] }
  'space.mote.direct.image.read': MotePrivateImageRead & { mote?: MotePreferencesTarget }
}
export type MoteDirectResultMap = {
  'space.mote.direct.list': { threads: MoteDirectThread[]; nextBeforeSequence: number | null }
  'space.mote.direct.inspect': { thread: MoteDirectThread; messages: MoteDirectMessage[]; nextBeforeSequence: number | null }
  'space.mote.direct.send': { threadId: string; message: MoteDirectMessage }
  'space.mote.direct.schedule': ScheduleResultMap['schedule.create']
  'space.mote.direct.reply': { message: MoteDirectMessage; mainNotification: MoteDirectMainNotification }
  'space.mote.direct.image.read': MotePrivateImageResult
}
export type MoteDirectMethod = keyof MoteDirectParamsMap
export const MOTE_DIRECT_METHODS = {
  'space.mote.direct.list': 'short',
  'space.mote.direct.inspect': 'short',
  'space.mote.direct.send': 'long',
  'space.mote.direct.schedule': 'long',
  'space.mote.direct.reply': 'short',
  'space.mote.direct.image.read': 'short'
} as const satisfies Record<MoteDirectMethod, 'short' | 'long'>

export const isMoteDirectMethod = (method: unknown): method is MoteDirectMethod =>
  typeof method === 'string' && Object.hasOwn(MOTE_DIRECT_METHODS, method)

export interface MoteDirectPort {
  call<M extends MoteDirectMethod>(method: M, input: MoteDirectParamsMap[M], context: MoteDirectCallContext): Promise<MoteDirectResultMap[M]>
}
export type MoteDirectCallContext = MoteGroupCallContext & MoteScheduleContext

function privateAssignmentSource(input: MoteDirectParamsMap['space.mote.direct.schedule']): string {
  const target = ({ spaceId, zoneId, expectedResource: { hostId, workspaceId, workspacePath } }: MotePreferencesTarget) =>
    ({ spaceId, zoneId, expectedResource: { hostId, workspaceId, workspacePath } })
  return JSON.stringify({ operationId: input.operationId, mote: target(input.mote), peer: target(input.peer), body: input.body })
}

/** The original structured suffix qualifies a retry independently of editable guidance. */
export function moteDirectScheduleSourceMatches(prompt: string, input: MoteDirectParamsMap['space.mote.direct.schedule']): boolean {
  return prompt.endsWith('\n\n' + privateAssignmentSource(input))
}

const invalid = (code: 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR'): never => {
  throw new AgentMuxError('The original private Mote thread, participant or message is invalid.', code)
}
export function parseMoteDirectParams<M extends MoteDirectMethod>(method: M, value: unknown): MoteDirectParamsMap[M] {
  const code = 'INVALID_CONTROL_REQUEST'
  if (method === 'space.mote.direct.list') {
    const { mote, ...page } = rpcRecord(value, ['mote', 'beforeSequence', 'limit', 'includeLastAssignment'], code)
    parseMoteGroupParams('space.mote.group.list', { ...page, moteId: parseMotePreferencesTarget(mote, code).spaceId })
  } else if (method === 'space.mote.direct.inspect') {
    const { mote, threadId, ...page } = rpcRecord(value, ['mote', 'threadId', 'beforeSequence', 'limit', 'messageId', 'replyToMessageId'], code)
    if (mote !== undefined) parseMotePreferencesTarget(mote, code)
    parseMoteGroupParams('space.mote.group.inspect', { ...page, groupId: threadId })
  } else if (method === 'space.mote.direct.image.read') {
    const { mote, ...image } = rpcRecord(value, ['mote', 'threadId', 'messageId', 'imageOperationId'], code)
    if (mote !== undefined) parseMotePreferencesTarget(mote, code)
    parseMotePrivateImageRead(image)
  } else if (method === 'space.mote.direct.send' || method === 'space.mote.direct.schedule') {
    const planned = method === 'space.mote.direct.schedule'
    const { mote, peer, calendar, afterMs, everyMs, images, priority, ...send } = rpcRecord(value,
      ['mote', 'peer', 'operationId', 'body', ...(planned ? ['calendar', 'afterMs', 'everyMs'] : ['replyToMessageId', 'images', 'priority'])], code)
    const source = parseMotePreferencesTarget(mote, code), recipient = parseMotePreferencesTarget(peer, code)
    if (source.spaceId === recipient.spaceId) return invalid(code)
    parseMoteGroupParams('space.mote.group.send', { ...send, groupId: 'private-thread', recipientIds: [recipient.spaceId] })
    if (images !== undefined) parsePrivateImageUploads(images, code)
    if (priority !== undefined && priority !== true) return invalid(code)
    if (planned) parseAgentScheduleTiming({ calendar, afterMs, everyMs }, code)
  } else {
    const { threadId, images, ...reply } = rpcRecord(value, ['threadId', 'operationId', 'inputOperationId', 'body', 'images'], code)
    if (images !== undefined) parsePrivateImageUploads(images, code)
    parseMoteGroupParams('space.mote.group.reply', { ...reply, groupId: threadId })
  }
  return value as MoteDirectParamsMap[M]
}

// The same conversation wire checks protect paging, authored mutations and exact
// receipts. The public private-thread boundary has its own audience and shape.
export function parseMoteDirectResult<M extends MoteDirectMethod>(method: M, value: unknown, input: MoteDirectParamsMap[M]): MoteDirectResultMap[M] {
  const code = 'CONTROL_PROTOCOL_ERROR'
  if (method === 'space.mote.direct.image.read') return parseMotePrivateImageResult(value,
    input as MoteDirectParamsMap['space.mote.direct.image.read']) as MoteDirectResultMap[M]
  if (method === 'space.mote.direct.schedule') {
    const request = input as MoteDirectParamsMap['space.mote.direct.schedule']
    const result = validateScheduleRpcResult('schedule.create', value), { schedule } = result
    if (schedule.hostId !== request.mote.expectedResource.hostId) return invalid(code)
    const matches = schedule.moteWork ? schedule.moteWork.kind === 'direct' && sameMotePreferencesTarget(schedule.moteWork.mote, request.mote) &&
      sameMotePreferencesTarget(schedule.moteWork.peer, request.peer) && schedule.prompt === request.body : moteDirectScheduleSourceMatches(schedule.prompt, request)
    const { mote: _, peer: __, body: ___, ...timing } = request
    const target = { hostId: schedule.hostId, agentSessionId: schedule.agentSessionId, providerId: schedule.providerId, workspacePath: schedule.workspacePath }
    if (!matches || !scheduleMatchesCreation(schedule, { ...timing, target, prompt: schedule.prompt,
      ...(schedule.inputEpoch ? { inputEpoch: schedule.inputEpoch } : {}) })) return invalid(code)
    return result as MoteDirectResultMap[M]
  }
  const message = (raw: unknown) => {
    const { threadId, images, priority, ...entry } = rpcRecord(raw, ['threadId', 'id', 'sequence', 'createdAt', 'author', 'body', 'replyToMessageId', 'deliveries', 'images', 'priority'], code)
    if (rpcRecord(entry.author, ['kind', 'moteId', 'name'], code).kind !== 'mote') return invalid(code)
    if (priority !== undefined && priority !== true) return invalid(code)
    if (images !== undefined) {
      if (!Array.isArray(images) || images.length < 1 || images.length > 4) return invalid(code)
      const references = Array.from(images, parsePrivateImageMetadata)
      if (new Set(references.map(image => image.operationId)).size !== references.length) return invalid(code)
    }
    return { ...entry, groupId: threadId }
  }
  const confirmImages = (raw: unknown, selected: FileUploadIdentity[] | undefined) => {
    const images = rpcRecord(raw, undefined, code).images
    if (selected === undefined) return images === undefined
    if (!Array.isArray(images) || images.length !== selected.length) return false
    return selected.every((upload, index) => {
      const image = parsePrivateImageMetadata(images[index]), expected = privateImageMetadata(upload)
      return image.operationId === expected.operationId && image.revision === expected.revision && image.name === expected.name &&
        image.mimeType === expected.mimeType && image.byteLength === expected.byteLength
    })
  }
  const thread = (raw: unknown, mote?: MotePreferencesTarget) => {
    const { id, participants, lastMessage, lastAssignment } = rpcRecord(raw, ['id', 'participants', 'lastMessage', 'lastAssignment'], code)
    if (!Array.isArray(participants) || participants.length !== 2) return invalid(code)
    const members = participants.map(raw => {
      const entry = rpcRecord(raw, ['moteId', 'target', 'name', 'thread'], code)
      return { ...entry, target: parseMotePreferencesTarget(entry.target, code), state: 'active', role: 'member' }
    })
    if (mote && !members.some(entry => sameMotePreferencesTarget(entry.target, mote))) return invalid(code)
    return { id, name: 'Private conversation', members, lastMessage: lastMessage === null ? null : message(lastMessage),
      ...(lastAssignment !== undefined ? { lastAssignment } : {}),
      revision: 1, avatarMoteIds: [], announcement: null, topic: null }
  }
  if (method === 'space.mote.direct.list') {
    const { threads, nextBeforeSequence } = rpcRecord(value, ['threads', 'nextBeforeSequence'], code)
    if (!Array.isArray(threads)) return invalid(code)
    const { mote, ...page } = input as MoteDirectParamsMap['space.mote.direct.list']
    parseMoteGroupResult('space.mote.group.list', { groups: threads.map(raw => thread(raw, mote)), nextBeforeSequence }, { ...page, moteId: mote.spaceId })
  } else if (method === 'space.mote.direct.inspect') {
    const response = rpcRecord(value, ['thread', 'messages', 'nextBeforeSequence'], code)
    if (!Array.isArray(response.messages)) return invalid(code)
    const { mote, threadId, ...page } = input as MoteDirectParamsMap['space.mote.direct.inspect']
    parseMoteGroupResult('space.mote.group.inspect', { group: thread(response.thread, mote), messages: response.messages.map(message),
      nextBeforeSequence: response.nextBeforeSequence, viewerId: mote?.spaceId ?? 'participant' }, { ...page, groupId: threadId })
  } else if (method === 'space.mote.direct.send') {
    const response = rpcRecord(value, ['threadId', 'message'], code), { mote, peer, images, priority, ...send } = input as MoteDirectParamsMap['space.mote.direct.send']
    if (typeof response.threadId !== 'string' || !response.threadId) return invalid(code)
    if (rpcRecord(response.message, undefined, code).priority !== priority || !confirmImages(response.message, images)) return invalid(code)
    parseMoteGroupResult('space.mote.group.send', { message: message(response.message) },
      { ...send, groupId: response.threadId, recipientIds: [peer.spaceId], sourceMote: mote })
  } else {
    const response = rpcRecord(value, ['message', 'mainNotification'], code), { threadId, images, ...reply } = input as MoteDirectParamsMap['space.mote.direct.reply']
    if (!confirmImages(response.message, images)) return invalid(code)
    parseMoteGroupResult('space.mote.group.reply', { message: message(response.message) }, { ...reply, groupId: threadId })
    const notification = rpcRecord(response.mainNotification, ['messageId', 'status', 'issue'], code)
    if (typeof notification.messageId !== 'string' || !notification.messageId || /[\0\r\n]/u.test(notification.messageId) ||
      !['queued', 'accepted', 'failed', 'unconfirmed'].includes(String(notification.status)) ||
      (notification.issue !== undefined && typeof notification.issue !== 'string')) return invalid(code)
  }
  return structuredClone(value) as MoteDirectResultMap[M]
}
