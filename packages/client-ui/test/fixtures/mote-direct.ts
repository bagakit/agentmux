import type { MoteDirectThread, MoteDirectMessage } from '@agentmux/core'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'

export function moteDirectCapture(mote: MotePreferencesTarget, now = Date.now()) {
  const threadId = 'private-work-review'
  const peer = { ...mote, spaceId: 'assigned-mote', zoneId: 'assigned-mote-home' }
  const assignment: MoteDirectMessage = { id: 'original-private-assignment', threadId, sequence: 1, createdAt: now - 120_000,
    body: '请核对发布手册里的三处变更，把还需要我决定的问题带回来。',
    author: { kind: 'mote', moteId: mote.spaceId, name: '协调 Mote' },
    deliveries: [{ moteId: peer.spaceId, operationId: 'original-assignment-delivery', status: 'accepted' }] }
  const laterAssignment: MoteDirectMessage = { ...assignment, id: 'another-private-assignment', sequence: 2,
    body: '明天再帮我核对文档目录。', deliveries: [{ ...assignment.deliveries[0]!, operationId: 'another-assignment-delivery', status: 'pending' }] }
  const reply: MoteDirectMessage = { id: 'original-private-report', threadId, sequence: 3, createdAt: now - 60_000,
    body: '三处变更已核对。两处可以直接更新，最后一处需要确认是保留旧入口，还是随这次发布移除。',
    author: { kind: 'mote', moteId: peer.spaceId, name: '资料整理' }, deliveries: [], replyToMessageId: assignment.id }
  const thread: MoteDirectThread = {
    id: threadId, participants: [{ moteId: mote.spaceId, target: mote, name: '协调 Mote', thread: null },
      { moteId: peer.spaceId, target: peer, name: '资料整理', thread: { hostId: peer.expectedResource.hostId, agentSessionId: 'assigned-mote-session' } }],
    lastMessage: reply
  }
  return {
    list: { threads: [thread], nextBeforeSequence: null },
    inspect(id: string, messageId?: string) {
      if (id !== threadId) throw Error('Wrong original private thread')
      const messages = messageId ? [assignment, laterAssignment, reply].filter(message => message.id === messageId) : [laterAssignment, reply]
      return { thread, messages, nextBeforeSequence: null }
    }
  }
}
