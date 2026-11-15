import type { MoteGroupMessage, MoteGroupParamsMap, MoteGroupResultMap, MoteGroupSummary } from '@agentmux/core/mote/group'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { originalTopicAddress } from '../../../src/shared/space-addresses'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'

export function connectGroupFixture(target: MotePreferencesTarget) {
  const workspace = useAppStore.getState().config!.workspaces.find(item => item.id === target.expectedResource.workspaceId)!
  const topicId = 'launcher:group-shared-files'
  const directoryPath = workspace.path + '/' + scratchTopicDirectoryName(topicId)
  const topic = { id: topicId, directoryPath, topicPath: directoryPath + '/topic.md', kind: 'topic' as const, title: '群研究资料', summary: '', collaborators: [] }
  const savedTopics = api.scratch.listTopics
  api.scratch.listTopics = async (workspaceId, ...options) => {
    const list = await savedTopics(workspaceId, ...options)
    return workspaceId === workspace.id ? [...list, topic] : list
  }
  useAppStore.setState(state => {
    const snapshot = state.scratchTopicSnapshots[workspace.id]!
    return { scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [workspace.id]: { ...snapshot, topics: [...(snapshot.topics ?? []), topic] } } }
  })
  const topicTarget = { ...originalTopicAddress(workspace, topic, useAppStore.getState().spaceZoneBindings)!, expectedResource: target.expectedResource }
  const fileList = api.files.listPublic, fileRead = api.files.readPublic
  api.files.listPublic = input => input.zoneId !== topicTarget.zoneId ? fileList(input) : Promise.resolve({
    resource: { ...topicTarget.expectedResource, zoneId: topicTarget.zoneId, zonePath: directoryPath, path: input.path },
    result: { status: 'directory-listed', complete: true, partialReason: null,
      entries: [{ name: '研究记录.md', path: '研究记录.md', isDirectory: false, isSymlink: false }] }
  })
  api.files.readPublic = input => input.zoneId !== topicTarget.zoneId ? fileRead(input) : Promise.resolve({
    resource: { ...topicTarget.expectedResource, zoneId: topicTarget.zoneId, zonePath: directoryPath, path: input.path },
    result: { status: 'read', document: { path: input.path, content: '这一份资料来自群绑定的原 Topic。', revision: 'sha256:' + '1'.repeat(64) } }
  })
  const groupId = 'visual-mote-group'
  const viewerId = 'local-owner'
  const createdAt = Date.now() - 120_000
  const calls: { method: string; input: unknown }[] = []
  const members = [
    { moteId: target.spaceId, name: '研究搭档', target, role: 'member' as const, state: 'active' as const, thread: { hostId: 'local', agentSessionId: 'mote-neighbor' } },
    { moteId: 'design-mote', name: '设计搭档', target: { ...target, spaceId: 'design-mote' }, role: 'member' as const, state: 'active' as const, thread: null }
  ]
  const human = { kind: 'human', id: viewerId } as const
  const researcher = { kind: 'mote', moteId: target.spaceId, name: '研究搭档' } as const
  const messages: MoteGroupMessage[] = [
    { id: 'initial', sequence: 1, groupId, createdAt, author: human, body: '我们先把新手第一次找到群聊的路径走一遍。研究搭档，能帮忙对照一下现有会话列表吗？', deliveries: [{ moteId: target.spaceId, operationId: 'original-input', status: 'accepted' }] },
    { id: 'public-reply', sequence: 2, groupId, createdAt: createdAt + 45_000, author: researcher, replyToMessageId: 'initial', body: '看过了。可以先让群聊和其他会话出现在同一个列表里，展开成员时再展示各自的工作进展。', deliveries: [] },
    { id: 'public-only', sequence: 3, groupId, createdAt: createdAt + 90_000, author: human, body: '好，先用这条路径做第一轮体验验证。', deliveries: [] }
  ]
  const group = (): MoteGroupSummary => ({ id: groupId, name: '协作体验研究', members, revision: 1, avatarMoteIds: [], announcement: null, topic: null, lastMessage: messages.at(-1) ?? null })
  const created: MoteGroupSummary[] = []
  const notifications = new Map<string, MoteGroupMessage[]>()
  let revisionConflict = false
  const sendOperations = new Map<string, MoteGroupMessage>()
  api.moteGroup.call = (async (method: keyof MoteGroupResultMap, input: MoteGroupParamsMap[keyof MoteGroupParamsMap]) => {
    calls.push({ method, input })
    if (method === 'space.mote.group.list') return { groups: [...created, group()], nextBeforeSequence: null }
    if (method === 'space.mote.group.inspect') {
      const original = created.find(item => item.id === (input as MoteGroupParamsMap['space.mote.group.inspect']).groupId)
      return { group: original ?? group(), messages: original ? notifications.get(original.id) ?? [] : [...messages], nextBeforeSequence: null, viewerId }
    }
    if (method === 'space.mote.group.create') {
      const request = input as MoteGroupParamsMap['space.mote.group.create']
      const receipt: MoteGroupSummary = { id: 'second-visual-group', name: request.name, members: request.members.map((member, index) => ({
        moteId: member.spaceId, name: index ? '设计搭档' : '研究搭档', target: member, role: 'member', state: 'active', thread: null
      })), revision: 1, avatarMoteIds: request.avatarMoteIds ?? [], topic: request.topic ?? null,
        announcement: request.announcement ? { body: request.announcement, updatedAt: Date.now(), operationId: request.operationId } : null,
        lastMessage: null }
      created.push(receipt)
      return { group: receipt }
    }
    if (method === 'space.mote.group.update') {
      const request = input as MoteGroupParamsMap['space.mote.group.update']
      const original = created.find(item => item.id === request.groupId)!
      if (revisionConflict) {
        revisionConflict = false
        const removed = original.members[1]!.moteId
        original.members = original.members.map(member => member.moteId === removed ? { ...member, state: 'removed' } : member)
        original.avatarMoteIds = (original.avatarMoteIds ?? []).filter(id => id !== removed)
        ++original.revision
        throw Object.assign(new Error('群资料已因另一个操作更新。'), { code: 'MOTE_GROUP_REVISION_CONFLICT' })
      }
      if (request.expectedRevision !== original.revision) throw Error('Wrong original revision')
      if (request.avatarMoteIds !== undefined) original.avatarMoteIds = request.avatarMoteIds
      if (request.topic !== undefined) original.topic = request.topic
      if (request.adminMoteIds !== undefined) original.members = original.members.map(member => ({
        ...member, role: request.adminMoteIds!.includes(member.moteId) ? 'admin' : 'member'
      }))
      if (request.announcement !== undefined) {
        const time = Date.now()
        original.announcement = request.announcement ? { body: request.announcement, updatedAt: time, operationId: request.operationId } : null
        const system: MoteGroupMessage = { id: request.operationId, groupId: original.id, sequence: 1, createdAt: time,
          author: { kind: 'system' }, event: { kind: 'announcement-updated' }, body: request.announcement ?? '公告已清空', deliveries: [] }
        original.lastMessage = system
        notifications.set(original.id, [system])
      }
      ++original.revision
      return { group: structuredClone(original) }
    }
    if (method === 'space.mote.group.members.remove') {
      const request = input as MoteGroupParamsMap['space.mote.group.members.remove']
      const original = created.find(item => item.id === request.groupId)!
      if (request.expectedRevision !== original.revision) throw Error('Wrong original revision')
      original.members = original.members.map(member => request.memberIds.includes(member.moteId) ? { ...member, state: 'removed' } : member)
      original.avatarMoteIds = (original.avatarMoteIds ?? []).filter(id => !request.memberIds.includes(id))
      ++original.revision
      return { group: structuredClone(original) }
    }
    if (method === 'space.mote.group.members.add') {
      const request = input as MoteGroupParamsMap['space.mote.group.members.add']
      const original = created.find(item => item.id === request.groupId)!
      if (request.expectedRevision !== original.revision) throw Error('Wrong original revision')
      original.members = original.members.map(member => request.members.some(candidate => candidate.spaceId === member.moteId)
        ? { ...member, state: 'active', role: 'member' } : member)
      ++original.revision
      return { group: structuredClone(original) }
    }
    if (method === 'space.mote.group.send') {
      const request = input as MoteGroupParamsMap['space.mote.group.send']
      const operation = request.operationId
      const existing = sendOperations.get(operation)
      if (existing) return { message: existing }
      const message: MoteGroupMessage = { id: operation, groupId, sequence: messages.length + 1, createdAt: Date.now(), author: human, body: request.body,
        ...(request.replyToMessageId ? { replyToMessageId: request.replyToMessageId } : {}),
        deliveries: request.recipientIds.map(moteId => ({ moteId, operationId: 'delivery:' + operation, status: 'accepted' })) }
      messages.push(message)
      sendOperations.set(operation, message)
      throw new Error('群消息已保存，首次确认响应中断。')
    }
    throw new Error('Unexpected group method: ' + method)
  }) as typeof api.moteGroup.call
  Object.assign(window, { moteNativeGroupsCapture: { calls, groupId, conflictNextUpdate() { revisionConflict = true } } })
}
