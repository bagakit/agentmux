import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { MoteGroupMessage, MoteGroupSummary } from '@agentmux/core/mote/group'
import { fixtureEpoch, fixturePath } from '../../../../../test/fixture-values.mjs'

export function createMoteGroupCapture(catalog: AgentMuxSpaceCatalog) {
  const second = catalog.spaces.find(space => space.spaceId === 'mote-resources')!
  const secondContent = { zoneId: 'zone-resources', hostId: 'host-original', workspaceId: 'workspace-original', workspacePath: fixturePath('mote-resources') }
  catalog.motePresentation ??= []
  const savedSecond = catalog.motePresentation.find(fact => fact.spaceId === second.spaceId)
  if (savedSecond) savedSecond.content = secondContent
  else catalog.motePresentation.push({ spaceId: second.spaceId, content: secondContent,
    quickMode: { status: 'saved', version: 'capture-group-mote', defaults: {} }, conversation: null })
  const members = catalog.motePresentation.filter(value => value.spaceId === 'mote-original' || value.spaceId === second.spaceId).map(value => {
    const content = value.content!, name = catalog.spaces.find(space => space.spaceId === value.spaceId)!.name
    return { moteId: value.spaceId, name, target: { spaceId: value.spaceId, zoneId: content.zoneId,
      expectedResource: { hostId: content.hostId, workspaceId: content.workspaceId, workspacePath: content.workspacePath } },
      thread: value.spaceId === 'mote-original' ? { hostId: content.hostId, agentSessionId: 'session-waiting' } : null }
  })
  const original: MoteGroupSummary = { id: 'mobile-product-group', name: '下周实验方向', members, lastMessage: null }
  const messages: MoteGroupMessage[] = [
    { id: 'scope-message', groupId: original.id, sequence: 1, body: '我的 Mote，先核对原始材料，再比较两个实验方向。', createdAt: fixtureEpoch(2, 1_000), author: { kind: 'human', id: 'phone-viewer' },
      deliveries: [{ moteId: 'mote-original', operationId: 'scope-delivery', status: 'accepted' }] },
    { id: 'public-reply', groupId: original.id, sequence: 2, body: '原始材料已核对。我整理了成本和验证范围，两份计划都能继续比较。', createdAt: fixtureEpoch(2, 1_200),
      author: { kind: 'mote', moteId: 'mote-original', name: members[0]!.name }, deliveries: [], replyToMessageId: 'scope-message' },
  ]
  original.lastMessage = messages.at(-1)!
  return (method: string, params: Record<string, unknown>) => {
    if (method === 'space.mote.group.list') return { groups: !params.moteId || members.some(member => member.moteId === params.moteId) ? [original] : [], nextBeforeSequence: null }
    if (method === 'space.mote.group.inspect' && params.groupId === original.id) return { group: original, messages, nextBeforeSequence: null, viewerId: 'phone-viewer' }
    return undefined
  }
}
