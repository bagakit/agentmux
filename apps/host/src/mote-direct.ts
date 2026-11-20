import { createHash } from 'node:crypto'
import { AgentMuxError, moteDirectSchedulePrompt, moteDirectScheduleSourceMatches, type AgentMuxClient, type MoteDirectCallContext, type MoteDirectMethod, type MoteDirectMessage, type MoteDirectParamsMap, type MoteDirectPort,
  type MoteDirectResultMap, type MoteDirectThread, type MoteGroupMessage, type MoteGroupPort, type MoteGroupSummary } from '@agentmux/core'
import { sameMotePreferencesTarget, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { MoteMainReader } from '@agentmux/core/mote-dialogue'
import { authorizeMoteConversationMain } from './mote-group.js'

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
export function createHostMoteDirect(ledger: MoteGroupPort, owner: {
  main: MoteMainReader
  readPeer(target: MotePreferencesTarget): Promise<unknown>
  client: Pick<AgentMuxClient, 'readAgentSession'>
}): MoteDirectPort {
  return {
    async call<M extends MoteDirectMethod>(method: M, raw: MoteDirectParamsMap[M], context: MoteDirectCallContext): Promise<MoteDirectResultMap[M]> {
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
      if (method === 'space.mote.direct.schedule') {
        const request = raw as MoteDirectParamsMap['space.mote.direct.schedule']
        const { mote, peer, operationId, body: _, ...timing } = request
        const main = await authorizeMoteConversationMain(owner.main, mote, context)
        await owner.readPeer(peer)
        const session = await owner.client.readAgentSession(main.reference.sessionId)
        if (!session || session.agentSessionId !== main.reference.sessionId || session.hostId !== main.reference.hostId)
          throw new AgentMuxError('The original Main schedule target is unconfirmed.', 'CONTROL_UNAVAILABLE')
        const target = { hostId: session.hostId, agentSessionId: session.agentSessionId, providerId: session.providerId, workspacePath: session.workspacePath }
        const { schedule: observed } = await context.readSchedule({ operationId })
        const original = observed?.creationOperationId === operationId ? observed : null
        if (original && !moteDirectScheduleSourceMatches(original.prompt, request))
          throw new AgentMuxError('The original private assignment differs from this retry.', 'SCHEDULE_OPERATION_CONFLICT')
        const prompt = original?.prompt ?? moteDirectSchedulePrompt(request)
        const result = await main.commit(() => context.schedule({ ...timing, target, prompt, operationId,
          ...(session.inputEpoch ? { inputEpoch: session.inputEpoch } : {}) }))
        return result as MoteDirectResultMap[M]
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
