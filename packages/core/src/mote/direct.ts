import { AgentMuxError } from '../errors.js'
import { rpcRecord } from '../rpc-data.js'
import { parseMoteGroupParams, parseMoteGroupResult, type MoteGroupCallContext, type MoteGroupMember, type MoteGroupMessage } from './group.js'
import { parseMotePreferencesTarget, sameMotePreferencesTarget, type MotePreferencesTarget } from './preferences.js'

type Page = { beforeSequence?: number; limit?: number }
export type MoteDirectParticipant = Pick<MoteGroupMember, 'moteId' | 'target' | 'name' | 'thread'>
export type MoteDirectMessage = Omit<MoteGroupMessage, 'groupId' | 'author' | 'event'> & {
  threadId: string
  author: Extract<MoteGroupMessage['author'], { kind: 'mote' }>
}
export type MoteDirectThread = {
  id: string
  participants: MoteDirectParticipant[]
  lastMessage: MoteDirectMessage | null
}

export type MoteDirectParamsMap = {
  'space.mote.direct.list': Page & { mote: MotePreferencesTarget }
  'space.mote.direct.inspect': Page & { threadId: string; mote?: MotePreferencesTarget }
  'space.mote.direct.send': { mote: MotePreferencesTarget; peer: MotePreferencesTarget; operationId: string; body: string; replyToMessageId?: string }
  'space.mote.direct.reply': { threadId: string; operationId: string; inputOperationId: string; body: string }
}
export type MoteDirectResultMap = {
  'space.mote.direct.list': { threads: MoteDirectThread[]; nextBeforeSequence: number | null }
  'space.mote.direct.inspect': { thread: MoteDirectThread; messages: MoteDirectMessage[]; nextBeforeSequence: number | null }
  'space.mote.direct.send': { threadId: string; message: MoteDirectMessage }
  'space.mote.direct.reply': { message: MoteDirectMessage }
}
export type MoteDirectMethod = keyof MoteDirectParamsMap
export const MOTE_DIRECT_METHODS = {
  'space.mote.direct.list': 'short',
  'space.mote.direct.inspect': 'short',
  'space.mote.direct.send': 'long',
  'space.mote.direct.reply': 'short'
} as const satisfies Record<MoteDirectMethod, 'short' | 'long'>

export const isMoteDirectMethod = (method: unknown): method is MoteDirectMethod =>
  typeof method === 'string' && Object.hasOwn(MOTE_DIRECT_METHODS, method)

export interface MoteDirectPort {
  call<M extends MoteDirectMethod>(method: M, input: MoteDirectParamsMap[M], context: MoteGroupCallContext): Promise<MoteDirectResultMap[M]>
}

const invalid = (code: 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR'): never => {
  throw new AgentMuxError('The original private Mote thread, participant or message is invalid.', code)
}
export function parseMoteDirectParams<M extends MoteDirectMethod>(method: M, value: unknown): MoteDirectParamsMap[M] {
  const code = 'INVALID_CONTROL_REQUEST'
  if (method === 'space.mote.direct.list') {
    const { mote, ...page } = rpcRecord(value, ['mote', 'beforeSequence', 'limit'], code)
    parseMotePreferencesTarget(mote, code)
    parseMoteGroupParams('space.mote.group.list', page)
  } else if (method === 'space.mote.direct.inspect') {
    const { mote, threadId, ...page } = rpcRecord(value, ['mote', 'threadId', 'beforeSequence', 'limit'], code)
    if (mote !== undefined) parseMotePreferencesTarget(mote, code)
    parseMoteGroupParams('space.mote.group.inspect', { ...page, groupId: threadId })
  } else if (method === 'space.mote.direct.send') {
    const { mote, peer, ...send } = rpcRecord(value, ['mote', 'peer', 'operationId', 'body', 'replyToMessageId'], code)
    const source = parseMotePreferencesTarget(mote, code), recipient = parseMotePreferencesTarget(peer, code)
    if (source.spaceId === recipient.spaceId) return invalid(code)
    parseMoteGroupParams('space.mote.group.send', { ...send, groupId: 'private-thread', recipientIds: [recipient.spaceId] })
  } else {
    const { threadId, ...reply } = rpcRecord(value, ['threadId', 'operationId', 'inputOperationId', 'body'], code)
    parseMoteGroupParams('space.mote.group.reply', { ...reply, groupId: threadId })
  }
  return value as MoteDirectParamsMap[M]
}

// The same conversation wire checks protect paging, authored mutations and exact
// receipts. The public private-thread boundary has its own audience and shape.
export function parseMoteDirectResult<M extends MoteDirectMethod>(method: M, value: unknown, input: MoteDirectParamsMap[M]): MoteDirectResultMap[M] {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const message = (raw: unknown) => {
    const { threadId, ...entry } = rpcRecord(raw, ['threadId', 'id', 'sequence', 'createdAt', 'author', 'body', 'replyToMessageId', 'deliveries'], code)
    if (rpcRecord(entry.author, ['kind', 'moteId', 'name'], code).kind !== 'mote') return invalid(code)
    return { ...entry, groupId: threadId }
  }
  const thread = (raw: unknown, mote?: MotePreferencesTarget) => {
    const { id, participants, lastMessage } = rpcRecord(raw, ['id', 'participants', 'lastMessage'], code)
    if (!Array.isArray(participants) || participants.length !== 2) return invalid(code)
    const members = participants.map(raw => {
      const entry = rpcRecord(raw, ['moteId', 'target', 'name', 'thread'], code)
      return { ...entry, target: parseMotePreferencesTarget(entry.target, code), state: 'active', role: 'member' }
    })
    if (mote && !members.some(entry => sameMotePreferencesTarget(entry.target, mote))) return invalid(code)
    return { id, name: 'Private conversation', members, lastMessage: lastMessage === null ? null : message(lastMessage),
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
    const response = rpcRecord(value, ['threadId', 'message'], code), { mote, peer, ...send } = input as MoteDirectParamsMap['space.mote.direct.send']
    if (typeof response.threadId !== 'string' || !response.threadId) return invalid(code)
    parseMoteGroupResult('space.mote.group.send', { message: message(response.message) },
      { ...send, groupId: response.threadId, recipientIds: [peer.spaceId], sourceMote: mote })
  } else {
    const response = rpcRecord(value, ['message'], code), { threadId, ...reply } = input as MoteDirectParamsMap['space.mote.direct.reply']
    parseMoteGroupResult('space.mote.group.reply', { message: message(response.message) }, { ...reply, groupId: threadId })
  }
  return structuredClone(value) as MoteDirectResultMap[M]
}
