import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { MoteGroupMember, MoteGroupMessage, MoteGroupSummary } from '@agentmux/core/mote/group'
import { fixtureEpoch, fixturePath } from '../../../../../test/fixture-values.mjs'

export function createMoteGroupCapture(catalog: AgentMuxSpaceCatalog) {
  const second = catalog.spaces.find(space => space.spaceId === 'mote-resources')!
  const secondContent = { zoneId: 'zone-resources', hostId: 'host-original', workspaceId: 'workspace-original', workspacePath: fixturePath('mote-resources') }
  catalog.motePresentation ??= []
  const savedSecond = catalog.motePresentation.find(fact => fact.spaceId === second.spaceId)
  if (savedSecond) savedSecond.content = secondContent
  else catalog.motePresentation.push({ spaceId: second.spaceId, content: secondContent,
    quickMode: { status: 'saved', version: 'capture-group-mote', defaults: {} }, conversation: null })
  const filesWorkspace = { workspaceId: 'workspace-group-files', hostId: 'host-original', path: fixturePath('group-project'),
    name: '实验项目', kind: 'folder' as const, projectId: null, repoPath: null, branch: null }
  const commonZone = { workspaceId: filesWorkspace.workspaceId, hostId: filesWorkspace.hostId, kind: 'directory' as const, branch: null }
  const filesZone = { ...commonZone, zoneId: 'zone-group-files', directoryPath: fixturePath('group-project/实验资料') }
  catalog.zones.push({ ...commonZone, zoneId: 'zone-group-project', directoryPath: filesWorkspace.path }, filesZone)
  const topic = { topicId: 'topic-group-files', hostId: filesWorkspace.hostId, zoneId: filesZone.zoneId, workspaceId: filesWorkspace.workspaceId,
    directoryPath: filesZone.directoryPath, title: '实验资料', summary: '', categorySpaceIds: [], chatIds: [], spatialRevision: 1, contentKind: 'topic' as const }
  const expectedResource = { hostId: filesWorkspace.hostId, workspaceId: filesWorkspace.workspaceId, workspacePath: filesWorkspace.path }
  const topicTarget = { spaceId: topic.topicId, zoneId: topic.zoneId, expectedResource }
  catalog.appearance?.push({ spaceId: second.spaceId, glyph: 'book' })
  const members: MoteGroupMember[] = catalog.motePresentation.filter(value => value.spaceId === 'mote-original' || value.spaceId === second.spaceId).map(value => {
    const content = value.content!, name = catalog.spaces.find(space => space.spaceId === value.spaceId)!.name
    return { moteId: value.spaceId, name, target: { spaceId: value.spaceId, zoneId: content.zoneId,
      expectedResource: { hostId: content.hostId, workspaceId: content.workspaceId, workspacePath: content.workspacePath } },
      role: value.spaceId === 'mote-original' ? 'admin' : 'member', state: 'active',
      thread: value.spaceId === 'mote-original' ? { hostId: content.hostId, agentSessionId: 'session-waiting' } : null }
  })
  const original: MoteGroupSummary = { id: 'mobile-product-group', name: '下周实验方向', members, lastMessage: null,
    revision: 3, avatarMoteIds: members.map(member => member.moteId), topic: topicTarget,
    announcement: { body: '本周先核对来源与成本，每个方向保留一份可以重做的验证计划。', updatedAt: fixtureEpoch(2), operationId: 'announcement-initial' } }
  const messages: MoteGroupMessage[] = [
    { id: 'announcement-initial', groupId: original.id, sequence: 1, body: original.announcement!.body, createdAt: fixtureEpoch(2),
      author: { kind: 'system' }, event: { kind: 'announcement-updated' }, deliveries: [] },
    { id: 'scope-message', groupId: original.id, sequence: 2, body: '我的 Mote，先核对原始材料，再比较两个实验方向。', createdAt: fixtureEpoch(2, 1_000), author: { kind: 'human', id: 'phone-viewer' },
      deliveries: [{ moteId: 'mote-original', operationId: 'scope-delivery', status: 'accepted' }] },
    { id: 'public-reply', groupId: original.id, sequence: 3, body: '原始材料已核对。我整理了成本和验证范围，两份计划都能继续比较。', createdAt: fixtureEpoch(2, 1_200),
      author: { kind: 'mote', moteId: 'mote-original', name: members[0]!.name }, deliveries: [], replyToMessageId: 'scope-message' },
  ]
  original.lastMessage = messages.at(-1)!
  return (method: string, params: Record<string, unknown>) => {
    if (method === 'app.snapshot') return { agents: [], projects: [], executors: [], workspaces: [filesWorkspace], unavailable: [] }
    if (method === 'topic.ls') return { topics: [topic], unavailable: [] }
    if (method === 'topic.inspect' && params.topicId === topic.topicId) return { topic, unavailable: [] }
    if ((method === 'file.read' || method === 'file.list') && params.zoneId !== 'zone-mote') {
      const requested = params.expectedResource as typeof expectedResource | undefined
      if (params.zoneId !== topic.zoneId || requested?.hostId !== expectedResource.hostId ||
          requested?.workspaceId !== expectedResource.workspaceId || requested?.workspacePath !== expectedResource.workspacePath) {
        throw new Error('群文件必须使用同一原 Topic 的文件授权。')
      }
      const path = params.path
      const resource = { ...expectedResource, zoneId: filesZone.zoneId, zonePath: filesZone.directoryPath, path }
      if (method === 'file.list' && path === '.') return { resource, result: { status: 'listed', complete: true, partialReason: null, omitted: 'none',
        files: ['实验决策.md', '验证范围.md', '资料索引.md'] } }
      if (method === 'file.read' && path === '.') return { resource, result: { status: 'directory' } }
      if (method === 'file.read' && path === '实验决策.md') return { resource, result: { status: 'read', document: {
        path, revision: 'sha256:' + 'e'.repeat(64),
        content: '# 实验决策\n\n先核对原始成本，再选一项本周能验证的实验。\n\n## 本周交付\n\n- 保留每份材料的来源与更新时间。\n- 记录比较范围、验证结果和未解决的疑点。'
      } } }
      throw new Error('Unexpected exact Topic file request')
    }
    if (method === 'space.mote.group.list') return { groups: !params.moteId || members.some(member => member.moteId === params.moteId) ? [original] : [], nextBeforeSequence: null }
    if (method === 'space.mote.group.inspect' && params.groupId === original.id) return { group: original, messages, nextBeforeSequence: null, viewerId: 'phone-viewer' }
    return undefined
  }
}
