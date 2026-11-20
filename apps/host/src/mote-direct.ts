import { createHash } from 'node:crypto'
import { AgentMuxError, type MoteGroupCallContext, type MoteDirectMethod, type MoteDirectMessage, type MoteDirectParamsMap, type MoteDirectPort,
  type MoteDirectResultMap, type MoteDirectThread, type MoteGroupMessage, type MoteGroupPort, type MoteGroupSummary } from '@agentmux/core'
import { sameMotePreferencesTarget, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'

function privateMessage({ groupId, author, event, ...message }: MoteGroupMessage): MoteDirectMessage {
  if (author.kind !== 'mote' || event) throw new AgentMuxError('The original private message has no authenticated Mote author.', 'CONTROL_PROTOCOL_ERROR')
  return { ...message, author, threadId: groupId }
}

function privateThread(original: MoteGroupSummary): MoteDirectThread {
  return {
    id: original.id,
    participants: original.members.map(({ moteId, target, name, thread }) => ({ moteId, target, name, thread })),
    lastMessage: original.lastMessage ? privateMessage(original.lastMessage) : null
  }
}

const belongsTo = (thread: MoteGroupSummary, mote: MotePreferencesTarget) =>
  thread.members.some(member => sameMotePreferencesTarget(member.target, mote))

/** Only this port can address the two-participant conversation ledger. */
export function createHostMoteDirect(ledger: MoteGroupPort): MoteDirectPort {
  return {
    async call<M extends MoteDirectMethod>(method: M, raw: MoteDirectParamsMap[M], context: MoteGroupCallContext): Promise<MoteDirectResultMap[M]> {
      const { actor } = context
      if (method === 'space.mote.direct.list') {
        const { mote, ...page } = raw as MoteDirectParamsMap['space.mote.direct.list']
        const result = await ledger.call('space.mote.group.list', { ...page, moteId: mote.spaceId,
          ...(actor.kind === 'agent' ? { sourceMote: mote } : {}) }, context)
        return { threads: result.groups.filter(thread => belongsTo(thread, mote)).map(privateThread),
          nextBeforeSequence: result.nextBeforeSequence } as MoteDirectResultMap[M]
      }
      if (method === 'space.mote.direct.inspect') {
        const { threadId, mote, ...page } = raw as MoteDirectParamsMap['space.mote.direct.inspect']
        const result = await ledger.call('space.mote.group.inspect', { ...page, groupId: threadId,
          ...(actor.kind === 'agent' && mote ? { sourceMote: mote } : {}) }, context)
        if (mote && !belongsTo(result.group, mote))
          throw new AgentMuxError('The selected Mote does not participate in this private thread.', 'CONTROL_PERMISSION_DENIED')
        return { thread: privateThread(result.group), messages: result.messages.map(privateMessage),
          nextBeforeSequence: result.nextBeforeSequence } as MoteDirectResultMap[M]
      }
      if (method === 'space.mote.direct.reply') {
        const { threadId, ...reply } = raw as MoteDirectParamsMap['space.mote.direct.reply']
        const { message } = await ledger.call('space.mote.group.reply', { ...reply, groupId: threadId }, context)
        return { message: privateMessage(message) } as MoteDirectResultMap[M]
      }
      const { mote, peer, ...send } = raw as MoteDirectParamsMap['space.mote.direct.send']
      const members = [mote, peer].sort((left, right) => left.spaceId < right.spaceId ? -1 : 1)
      const pair = members.map(target => [target.expectedResource.hostId, target.spaceId])
      const threadId = 'mote-direct-' + createHash('sha256').update(JSON.stringify(pair)).digest('hex')
      await ledger.call('space.mote.group.create', { name: 'Private conversation', operationId: threadId, sourceMote: mote, members }, context)
      const result = await ledger.call('space.mote.group.send', { ...send, groupId: threadId, sourceMote: mote, recipientIds: [peer.spaceId] }, context)
      return { threadId, message: privateMessage(result.message) } as MoteDirectResultMap[M]
    }
  }
}
