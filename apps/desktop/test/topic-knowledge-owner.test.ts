import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxRpcService } from '@agentmux/core'
import { connectAgentMuxRpc, type ExecutionHost } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { TopicKnowledgeOwner } from '../src/main/topic-knowledge'
import { TopicSpatialOwner } from '../src/main/topic-spatial-owner'
import { UNCLASSIFIED_TOPIC_CATEGORY_ID } from '../src/shared/topic-categories'
import { SCRATCH_WORKSPACE_ID, scratchTopicStorageRoots } from '../src/shared/scratch-topics'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'

vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw new Error('Avatar decoding is outside this content-only test.') } } }))

const roots: string[] = [], servers: AgentMuxControlServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const CATEGORY = '11111111-1111-4111-8111-111111111111'
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-topic-owner-'))); roots.push(root)
  const path = join(root, 'scratch'); await mkdir(path)
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', path, kind: 'folder' }
  const scratch = new ScratchTopics(), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
  const state = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const owner = new TopicKnowledgeOwner(scratch, files, () => workspace)
  const spatial = new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(),
    categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() })
  owner.setSpatialPort(spatial)
  return { root, workspace, scratch, files, state, owner, spatial }
}

describe('Topic knowledge content owner uses original files and Core membership', () => {
  it('keeps category directory identity and rejects stale title saves through the original file CAS', async () => {
    const f = await fixture()
    const first = await f.owner.call('topic.category.create', { categoryId: CATEGORY, title: '工作' })
    const source = await readFile(join(first.category.directoryPath, 'category.md'), 'utf8')
    const renamed = await f.owner.call('topic.category.rename', { categoryId: CATEGORY, title: '学习', expectedRevision: first.category.revision! })
    expect(renamed.category).toMatchObject({ categoryId: CATEGORY, spaceId: first.category.spaceId, directoryPath: first.category.directoryPath, title: '学习' })
    await expect(f.owner.call('topic.category.rename', { categoryId: CATEGORY, title: 'stale', expectedRevision: first.category.revision! })).rejects.toMatchObject({ code: 'TOPIC_CONTENT_CONFLICT' })
    expect(await readFile(join(first.category.directoryPath, 'category.md'), 'utf8')).toBe('# 学习\n')
    expect(source).toBe('# 工作\n')
    expect((await f.state.read())!.graph.spaces.find(space => space.spaceId === first.category.spaceId)?.name).toBe('学习')
  })
  it('creates a Topic in 未分类, discovers only ordinary Topics and moves its original Zone', async () => {
    const f = await fixture()
    await f.scratch.ensureMote(f.workspace, 'view:actual-mote')
    const created = await f.owner.call('topic.create', { topicId: 'view:knowledge', title: '人才心得' })
    const category = (await f.owner.call('topic.category.ls', {})).categories.find(category => category.categoryId === UNCLASSIFIED_TOPIC_CATEGORY_ID)!
    expect(category.title).toBe('未分类')
    expect(created.topic.categorySpaceIds).toEqual([category.spaceId])
    const target = await f.owner.call('topic.category.create', { categoryId: CATEGORY, title: '工作' })
    const before = await f.owner.call('topic.inspect', { topicId: created.topic.topicId })
    const graph = (await f.state.read())!.graph
    graph.tabs.push({ tabId: 'original-chat', zoneId: created.topic.zoneId, workspaceId: SCRATCH_WORKSPACE_ID, name: null, regionIds: ['original-thread'] })
    graph.regions.push({ regionId: 'original-thread', tabId: 'original-chat', kind: 'agent', agentSessionId: 'healthy-session', runId: 'healthy-run', execution: { hostId: 'local', cwd: created.topic.directoryPath } })
    await f.state.commit({ expectedRevision: before.topic!.spatialRevision, graph })
    const current = await f.owner.call('topic.inspect', { topicId: created.topic.topicId })
    const moved = await f.owner.call('topic.move', { topicId: created.topic.topicId, categoryId: CATEGORY, expectedRevision: current.topic!.spatialRevision })
    expect(moved.topic).toMatchObject({ topicId: created.topic.topicId, zoneId: created.topic.zoneId, directoryPath: created.topic.directoryPath, categorySpaceIds: [target.category.spaceId], chatIds: ['original-chat'] })
    expect(moved.previousCategorySpaceIds).toEqual([category.spaceId])
    const repeated = await f.owner.call('topic.create', { topicId: created.topic.topicId, title: 'ignored duplicate', categoryId: UNCLASSIFIED_TOPIC_CATEGORY_ID })
    expect(repeated.topic.categorySpaceIds).toEqual([target.category.spaceId])
    expect(repeated.topic.title).toBe('人才心得')
    expect((await f.state.read())!.graph.regions).toEqual(graph.regions)
    expect((await f.owner.call('topic.ls', {})).topics.map(topic => topic.topicId)).toEqual(['view:knowledge'])
    expect((await f.owner.call('topic.ls', { categoryId: UNCLASSIFIED_TOPIC_CATEGORY_ID })).topics).toEqual([])
    expect((await f.owner.call('topic.ls', { categoryId: CATEGORY })).topics).toHaveLength(1)
    await expect(f.owner.call('topic.create', { topicId: 'view:actual-mote', title: 'wrong target' })).rejects.toMatchObject({ code: 'TOPIC_TARGET_IS_MOTE' })
    await expect(f.owner.call('topic.move', { topicId: created.topic.topicId, categoryId: CATEGORY, expectedRevision: current.topic!.spatialRevision })).rejects.toMatchObject({ code: 'SPATIAL_STATE_CONFLICT' })
    expect(await readFile(join(created.topic.directoryPath, 'topic.md'), 'utf8')).toContain('# 人才心得')
  })
  it('retains readable categories beside unavailable or symlinked metadata without following another directory', async () => {
    const f = await fixture()
    await f.owner.call('topic.category.create', { categoryId: CATEGORY, title: 'Readable' })
    const id = '22222222-2222-4222-8222-222222222222', directory = join(scratchTopicStorageRoots(f.workspace.path).topics, 'category--' + id)
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'category.md'), '# Outside\n')
    await symlink(outside, directory)
    const result = await f.owner.call('topic.category.ls', {})
    expect(result.categories).toHaveLength(2)
    expect(result.categories.find(category => category.categoryId === CATEGORY)?.title).toBe('Readable')
    expect(result.categories.find(category => category.categoryId === id)?.readError).toContain('regular directory')
    expect(result.unavailable).toHaveLength(1)
    await expect(f.owner.call('topic.category.rename', { categoryId: id, title: 'Changed', expectedRevision: 'sha256:' + 'a'.repeat(64) })).rejects.toThrow()
    expect(await readFile(join(outside, 'category.md'), 'utf8')).toBe('# Outside\n')
  })
  it('uses the real public service and compiled CLI against the same durable content owner', async () => {
    const f = await fixture(), socketPath = join(f.root, 'rpc.sock')
    const server = new AgentMuxControlServer({ socketPath, spatialState: f.state, coreClients: () => [], topics: f.owner })
    servers.push(server); await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    try {
      const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath })
      const categoryCli = await runCompiledObjectCli(['topic', 'category', 'create', '--category', CATEGORY, '--title', '工作'], env)
      expect(categoryCli.code, categoryCli.stderr).toBe(0)
      const viaSdk = { category: (await client.call('topic.category.ls', {})).categories.find(category => category.categoryId === CATEGORY)! }
      const created = await runCompiledObjectCli(['topic', 'create', '--topic', 'view:cli-topic', '--title', 'CLI knowledge', '--category', CATEGORY], env)
      expect(created.code, created.stderr).toBe(0)
      expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, operation: 'topic.create', result: { topic: { topicId: 'view:cli-topic', categorySpaceIds: [viaSdk.category.spaceId] }, diskDurability: 'confirmed' } })
      const inspected = await runCompiledObjectCli(['topic', 'inspect', '--topic', 'view:cli-topic'], env)
      expect(inspected.code, inspected.stderr).toBe(0)
      const topic = JSON.parse(inspected.stdout).result.topic
      const actual = await f.owner.call('topic.inspect', { topicId: 'view:cli-topic' })
      expect(topic).toEqual(actual.topic)
      const categories = await runCompiledObjectCli(['topic', 'category', 'ls'], env)
      expect(categories.code, categories.stderr).toBe(0)
      expect(JSON.parse(categories.stdout).result.categories).toEqual((await f.owner.call('topic.category.ls', {})).categories)
      const stale = await runCompiledObjectCli(['topic', 'move', '--topic', 'view:cli-topic', '--category', CATEGORY, '--revision', '0'], env)
      expect(stale.code).toBe(1); expect(JSON.parse(stale.stderr)).toMatchObject({ error: { code: 'SPATIAL_STATE_CONFLICT' } })
      const forgedCaller = new AgentMuxRpcService({ coreClients: () => [], topics: f.owner })
      await expect(forgedCaller.call('topic.create', { topicId: 'view:forged', title: 'Unauthorized' }, { caller: { agentSessionId: 'unverified-session', capability: 'unverified-capability' } })).rejects.toThrow()
      expect(await f.scratch.read(f.workspace, 'view:forged')).toBeNull()
      const missingPort = new AgentMuxRpcService({ coreClients: () => [] })
      await expect(missingPort.call('topic.category.ls', {})).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    } finally { await client.dispose() }
  })
})
