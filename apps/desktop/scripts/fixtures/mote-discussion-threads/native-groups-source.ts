import type { MoteGroupMessage, MoteGroupResultMap, MoteGroupSummary } from '@agentmux/core/mote/group'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { api } from '../../../src/renderer/src/lib/api'

export function connectGroupFixture(target: MotePreferencesTarget) {
  const groupId = 'visual-mote-group'
  const viewerId = 'local-owner'
  const createdAt = Date.now() - 120_000
  const calls: { method: string; input: unknown }[] = []
  const members = [
    { moteId: target.spaceId, name: '研究搭档', target, thread: { hostId: 'local', agentSessionId: 'mote-neighbor' } },
    { moteId: 'design-mote', name: '设计搭档', target: { ...target, spaceId: 'design-mote' }, thread: null }
  ]
  const human = { kind: 'human', id: viewerId } as const
  const researcher = { kind: 'mote', moteId: target.spaceId, name: '研究搭档' } as const
  const messages: MoteGroupMessage[] = [
    { id: 'initial', sequence: 1, groupId, createdAt, author: human, body: '我们先把新手第一次找到群聊的路径走一遍。研究搭档，能帮忙对照一下现有会话列表吗？', deliveries: [{ moteId: target.spaceId, operationId: 'original-input', status: 'accepted' }] },
    { id: 'public-reply', sequence: 2, groupId, createdAt: createdAt + 45_000, author: researcher, replyToMessageId: 'initial', body: '看过了。可以先让群聊和其他会话出现在同一个列表里，展开成员时再展示各自的工作进展。', deliveries: [] },
    { id: 'public-only', sequence: 3, groupId, createdAt: createdAt + 90_000, author: human, body: '好，先用这条路径做第一轮体验验证。', deliveries: [] }
  ]
  const group = (): MoteGroupSummary => ({ id: groupId, name: '协作体验研究', members, lastMessage: messages.at(-1) ?? null })
  const created: MoteGroupSummary[] = []
  const sendOperations = new Map<string, MoteGroupMessage>()
  api.moteGroup.call = (async (method: keyof MoteGroupResultMap, input: { groupId?: string; operationId?: string; name?: string; members?: MotePreferencesTarget[]; body?: string; recipientIds?: string[]; replyToMessageId?: string }) => {
    calls.push({ method, input })
    if (method === 'space.mote.group.list') return { groups: [...created, group()], nextBeforeSequence: null }
    if (method === 'space.mote.group.inspect') {
      const original = created.find(item => item.id === input.groupId)
      return { group: original ?? group(), messages: original ? [] : [...messages], nextBeforeSequence: null, viewerId }
    }
    if (method === 'space.mote.group.create') {
      const receipt = { id: 'second-visual-group', name: input.name!, members: input.members!.map(member => ({
        moteId: member.spaceId, name: 'Mote', target: member, thread: null
      })), lastMessage: null }
      created.push(receipt)
      return { group: receipt }
    }
    if (method === 'space.mote.group.send') {
      const operation = input.operationId!
      const existing = sendOperations.get(operation)
      if (existing) return { message: existing }
      const message: MoteGroupMessage = { id: operation, groupId, sequence: messages.length + 1, createdAt: Date.now(), author: human, body: input.body!,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        deliveries: (input.recipientIds ?? []).map(moteId => ({ moteId, operationId: 'delivery:' + operation, status: 'accepted' })) }
      messages.push(message)
      sendOperations.set(operation, message)
      throw new Error('群消息已保存，首次确认响应中断。')
    }
    throw new Error('Unexpected group method: ' + method)
  }) as typeof api.moteGroup.call
  Object.assign(window, { moteNativeGroupsCapture: { calls, groupId } })
}
