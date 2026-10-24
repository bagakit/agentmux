import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { ScratchTopics } from '../../desktop/src/main/scratch-topics.js'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { learningBehaviorFixture } from './agent-learning-behavior-fixture.js'

vi.mock('electron', () => ({ nativeImage: {} }))

it.each([false, true])('keeps the original public Topic and learning target across alias-root maintenance (legacy missing record: %s)', async legacy => {
  const evidence = resolve(process.env.AGENT_LEARNING_BEHAVIOR_IDENTITY_EVIDENCE ?? '.local/state/agent-learning/behavior-work/topic-identity', legacy ? 'legacy' : 'birth')
  await mkdir(evidence, { recursive: true })
  const f = await learningBehaviorFixture(evidence)
  let server: AgentMuxControlServer | undefined, client: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  const save = async (name: string, value: unknown) => writeFile(join(evidence, name), JSON.stringify(value, null, 2))
  try {
    // The configured namespace remains this exact alias throughout create, maintenance and cold read.
    const physicalHome = join(f.root, 'original-topic-home'), logicalHome = join(f.root, 'configured-topic-home')
    await mkdir(join(physicalHome, 'scratch'), { recursive: true }); await symlink(physicalHome, logicalHome)
    f.workspace.path = join(logicalHome, 'scratch')
    f.config.workspaces.find((workspace: { id: string }) => workspace.id === f.workspace.id)!.path = f.workspace.path
    await writeFile(f.configurationPath, JSON.stringify(f.config))
    const created = await f.behaviorClient.call('topic.create', { topicId: 'view:stable-alias-topic', title: 'Original alias Topic' })
    const before = (await f.topics.read(f.workspace, created.topic.topicId))!, graph = (await f.state.read())!
    const descriptor = graph.graph.resources['zone:' + created.topic.zoneId] as { spaceId: string }
    const target = { kind: 'topic' as const, topicId: created.topic.topicId, spaceId: descriptor.spaceId, zoneId: created.topic.zoneId,
      expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.workspace.path } }
    const recordPath = join(before.physicalDirectoryPath!, '.agentmux/directory-identity.json')
    const birthRecord = JSON.parse(await readFile(recordPath, 'utf8'))
    expect(before.identityDirectoryPath).not.toBe(await realpath(before.physicalDirectoryPath!))
    expect(birthRecord.identityPathHash).toBe(createHash('sha256').update(before.identityDirectoryPath!).digest('hex'))
    // Represent a previously published old Topic that predates birth records. Only this fixture's new record is removed.
    if (legacy) await rm(recordPath)
    const inode = (await stat(before.physicalDirectoryPath!)).ino
    const operation = await f.propose(await f.prepare(legacy ? 'legacy-alias-learning' : 'birth-alias-learning'))
    await save('before.json', { created, before, graph, target, birthRecord, legacyMissingRecord: legacy })
    const maintenance = new ScratchTopics()
    await maintenance.normalizeDirectoryIdentities(f.workspace, process.env.AGENT_LEARNING_BEHAVIOR_HELPER ? { helperPath: process.env.AGENT_LEARNING_BEHAVIOR_HELPER } : {})
    const cold = new ScratchTopics(), after = (await cold.read(f.workspace, created.topic.topicId))!
    const owner = new TopicKnowledgeOwner(cold, f.files, () => f.workspace)
    owner.setSpatialPort(new TopicSpatialOwner({ state: f.state, workspace: () => f.workspace, topics: () => owner.listTopicSnapshots(),
      categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
    server = new AgentMuxControlServer({ socketPath: join(f.root, 'cold-topic.sock'), topics: owner, spatialState: f.state, coreClients: f.coreClients })
    await server.start(); client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const listed = await client.call('topic.ls', {}), observed = listed.topics.find(topic => topic.topicId === created.topic.topicId)!
    await save('after.json', { after, listed, graph: await f.state.read(), record: JSON.parse(await readFile(recordPath, 'utf8')) })
    const confirmation = await f.authority.confirm({ ...f.confirmation(operation, target), confirmationId: legacy ? 'fixture-legacy-alias' : 'fixture-birth-alias' })
      .then(delivered => ({ delivered, rejected: null }), error => ({ delivered: null, rejected: { code: error.code, message: String(error) } }))
    await save('same-target-confirmation.json', { fixtureAppAction: true, genuineHumanAdoption: false, target, ...confirmation })
    expect(confirmation.rejected, 'The original reviewed target must still reach its original learning owner.').toBeNull()
    expect(after.identityDirectoryPath).toBe(before.identityDirectoryPath)
    expect(after.physicalDirectoryPath).toBe(before.physicalDirectoryPath)
    expect((await stat(after.physicalDirectoryPath!)).ino).toBe(inode)
    expect(observed.zoneId).toBe(target.zoneId)
    expect(observed.categorySpaceIds).toEqual(created.topic.categorySpaceIds)
    expect(await f.state.read()).toEqual(graph)
    expect(confirmation.delivered?.operation.approved?.target).toEqual(target)
    expect(confirmation.delivered?.operation.learner?.state).toBe('created')
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await client?.dispose(); await server?.stop(); await f.closeBehavior() }
})
