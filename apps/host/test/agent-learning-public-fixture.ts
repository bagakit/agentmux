import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxSpatialStateStore, AgentMuxError, connectAgentMuxRpc, spatialCatalog, type AgentMuxHeadlessRuntime } from '@agentmux/core'
import { AgentLearningAuthority } from '../../desktop/src/main/agent-learning-authority.js'
import { createHostAgentLearning } from '../src/agent-learning.js'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { learningCore } from './agent-learning-fixture.js'
import type { AgentLearningOperation, AgentLearningTarget } from '@agentmux/core/agent-learning'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files.js'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
export async function learningPublicFixture(ownerRuntimeId = 'original-host') {
  const h = await learningCore(); cleanup.push(h.close)
  const workspace = { id: SCRATCH_WORKSPACE_ID, name: 'Original knowledge homes', hostId: 'local', path: join(h.root, 'homes'), kind: 'folder' }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(), mote = await topics.ensureMote(workspace, 'view:experience-mote')
  const spaces = [mote].map(snapshot => ({ spaceId: directoryIdentity('local', snapshot.identityDirectoryPath!), kind: snapshot.kind, name: 'Same displayed destination', hostId: 'local', directoryPath: snapshot.physicalDirectoryPath!, projectId: null, topicId: snapshot.id }))
  const zones = spaces.map(space => ({ zoneId: homeZoneId(space.spaceId), workspaceId: workspace.id, kind: 'home' as const, hostId: 'local', directoryPath: space.directoryPath, branch: null }))
  const spatial = new AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces, zones, bindings: spaces.map((space, index) => ({ spaceId: space.spaceId, zoneId: zones[index]!.zoneId })), tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  cleanup.push(() => files.dispose())
  const knowledge = new TopicKnowledgeOwner(topics as never, files, () => workspace as never)
  knowledge.setSpatialPort(new TopicSpatialOwner({ state: spatial, workspace: () => workspace as never,
    topics: () => knowledge.listTopicSnapshots(), categories: () => knowledge.listCategories(), ensureDefaultCategory: () => knowledge.ensureDefaultCategoryContent() }))
  const targets = spaces.map((space, index): AgentLearningTarget => ({ kind: space.kind as 'mote' | 'topic', topicId: space.topicId, spaceId: space.spaceId, zoneId: zones[index]!.zoneId,
    expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }))
  const configurationPath = join(h.root, 'original-app.json')
  await writeFile(configurationPath, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'Original Host' }], workspaces: [workspace], executors: { saved: { label: 'Original saved Executor', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } } }))
  const desktopPath = join(h.root, 'desktop.sock')
  const options = { directory: join(h.root, 'learning'), configurationPath, spatial,
    runtime: () => ({ client: h.client, ownerIdentity: () => ({ runtimeId: ownerRuntimeId }) }) as AgentMuxHeadlessRuntime,
    desktop: () => connectAgentMuxRpc({ endpoint: { transport: 'unix' as const, path: desktopPath } }) }
  const owner = createHostAgentLearning(options), server = new AgentMuxControlServer({ socketPath: join(h.root, 'public.sock'), agentLearning: owner, spatialState: spatial, topics: knowledge, coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => client.dispose())
  const created = await client.call('topic.create', { topicId: 'view:experience-topic', title: 'Same displayed destination' })
  const topic = (await topics.read(workspace, created.topic.topicId))!
  targets.push({ kind: 'topic', topicId: created.topic.topicId, spaceId: directoryIdentity('local', topic.identityDirectoryPath!), zoneId: created.topic.zoneId,
    expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } })
  const authority = new AgentLearningAuthority({ callOriginalCore: async (_host: string, method: any, input: any) => client.call(method, input) } as any)
  const desktop = new AgentMuxControlServer({ socketPath: desktopPath, agentLearning: authority, coreClients: h.coreClients })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const credentials = (operation: AgentLearningOperation) => ({ agentSessionId: operation.proposer.agentSessionId,
    capability: h.started.find(spec => spec.env?.AGENTMUX_AGENT_SESSION_ID === operation.proposer.agentSessionId)!.env.AGENTMUX_AGENT_CAPABILITY })
  const prepare = async (operationId = 'original-experience') => (await client.call('agent.learning.prepare', { operationId, source: { hostId: 'local', agentSessionId: 'source' }, executorId: 'saved' })).operation
  const propose = async (operation: AgentLearningOperation, content = 'Evidence source/source-turn; applicable only after source confirmation. Method: preserve unknown receipts. Counterexample: conflicting original target. Uncertainty: no broader pattern established.') =>
    (await client.call('agent.learning.propose', { hostId: 'local', operationId: operation.operationId, expectedRevision: operation.revision, content }, { credentials: credentials(operation) })).operation
  const confirmation = (operation: AgentLearningOperation, target = targets[0]!) => ({ hostId: 'local', operationId: operation.operationId, expectedRevision: operation.revision,
    ownerRuntimeId: operation.ownerRuntimeId, candidateDigest: createHash('sha256').update(operation.candidate!.content).digest('hex'), target, executorId: 'saved', confirmationId: 'original-human-action' })
  return { config: JSON.parse(await readFile(configurationPath, 'utf8')), catalog: spatialCatalog((await spatial.read())!.graph), spatial, knowledge, ...h, core: h.client, sourceCredentials: h.credentials, workspace, topics, targets, configurationPath, owner, client, authority, server, prepare, propose, confirmation, credentials, reopen: () => createHostAgentLearning(options) }
}
