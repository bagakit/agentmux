import { expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { learningBehaviorFixture } from './agent-learning-behavior-fixture.js'

vi.mock('electron', () => ({ nativeImage: {} }))

it('hands learning to an ordinary Topic created by its actual production owner and topology', async () => {
  const evidence = resolve(process.env.AGENT_LEARNING_BEHAVIOR_TOPIC_EVIDENCE ?? '.local/state/agent-learning/behavior-work/topic-production')
  await mkdir(evidence, { recursive: true })
  const f = await learningBehaviorFixture(evidence)
  const save = async (name: string, value: unknown) => await writeFile(join(evidence, name), JSON.stringify(value, null, 2))
  try {
    const created = await f.behaviorClient.call('topic.create', { topicId: 'view:production-created-topic', title: 'Production-created ordinary Topic' })
    const snapshot = (await f.topics.read(f.workspace, created.topic.topicId))!
    const graph = await f.state.read()
    const descriptor = graph!.graph.resources['zone:' + created.topic.zoneId] as { spaceId: string }
    const target = { kind: 'topic' as const, topicId: created.topic.topicId, spaceId: descriptor.spaceId,
      zoneId: created.topic.zoneId, expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.workspace.path } }
    await save('production-create.json', { created, snapshot, graph, target })
    const operation = await f.propose(await f.prepare('production-topic-control'), 'Declared controlled integration proposal; not a model behavior result. Preserve exact original Files revisions and unknown receipts.')
    try {
      const confirmed = await f.authority.confirm({ ...f.confirmation(operation, target), confirmationId: 'fixture-app-production-topic' })
      await save('learning-confirmation.json', { fixtureAppAction: true, genuineHumanAdoption: false, confirmed })
      expect(confirmed.operation.approved?.target).toEqual(target)
      expect(confirmed.operation.learner?.state).toBe('created')
      const fileTarget = { zoneId: target.zoneId, path: 'topic.md', expectedResource: target.expectedResource }
      const fileBefore = await f.behaviorClient.call('file.read', fileTarget)
      expect(fileBefore.result.status).toBe('read')
      const category = await f.behaviorClient.call('topic.category.create', { categoryId: '22222222-2222-4222-8222-222222222222', title: 'Another display category' })
      const original = await f.behaviorClient.call('topic.inspect', { topicId: created.topic.topicId })
      const moved = await f.behaviorClient.call('topic.move', { topicId: created.topic.topicId, categoryId: category.category.categoryId,
        expectedRevision: original.topic!.spatialRevision })
      const movedGraph = await f.state.read()
      const movedDescriptor = movedGraph!.graph.resources['zone:' + created.topic.zoneId] as { spaceId: string }
      expect(movedDescriptor.spaceId).toBe(target.spaceId)
      expect(moved.topic.zoneId).toBe(target.zoneId)
      const next = await f.propose(await f.prepare('production-topic-after-category-move'), 'Declared controlled integration proposal after category movement; no model outcome claimed.')
      const delivered = await f.authority.confirm({ ...f.confirmation(next, target), confirmationId: 'fixture-app-moved-topic' })
      await save('classification-move.json', { category, original, moved, movedGraph, sameTarget: target, delivered })
      expect(delivered.operation.approved?.target).toEqual(target)
      expect(delivered.operation.learner?.state).toBe('created')
      const fileAfter = await f.behaviorClient.call('file.read', fileTarget)
      expect(fileAfter).toEqual(fileBefore)
      await save('files-through-category-move.json', { fileTarget, fileBefore, fileAfter })
    } catch (error) {
      await save('learning-confirmation.json', { fixtureAppAction: true, genuineHumanAdoption: false,
        error: { code: (error as any).code, message: String(error) },
        original: (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: operation.operationId })).operation })
      throw error
    }
  } finally { await f.closeBehavior() }
})
