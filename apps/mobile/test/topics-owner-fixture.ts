import { vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxRpcService, type ExecutionHost } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { mintObjectId } from '@agentmux/core/object-id'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { ScratchTopics } from '../../desktop/src/main/scratch-topics'
import { WorkspaceFiles } from '../../desktop/src/main/workspace-files'
import { SCRATCH_WORKSPACE_ID } from '../../host/src/mote-model'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import type { TopicsRpc } from '../src/topics/MobileTopicKnowledge'

export async function createTopicsOwnerFixture() {
  localStorage.clear()
  const path = await realpath(await mkdtemp(join(tmpdir(), 'amx-responsive-topics-')))
  await mkdir(join(path, 'scratch'))
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Private responsive Topics', path: join(path, 'scratch'), kind: 'folder' as const }
  const files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost));
  const owner = new TopicKnowledgeOwner(new ScratchTopics(), files, () => workspace)
  const state = new AgentMuxSpatialStateStore(join(path, 'spatial.json'))
  owner.setSpatialPort(new TopicSpatialOwner({ state, workspace: () => workspace, topics: () => owner.listTopicSnapshots(), categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  const firstCategory = (await owner.call('topic.category.create', { categoryId: mintObjectId(), title: 'First category' })).category
  const category = (await owner.call('topic.category.create', { categoryId: mintObjectId(), title: 'Original category' })).category
  await owner.call('topic.create', { topicId: mintObjectId(), categoryId: firstCategory.categoryId, title: 'Unrelated Topic' })
  const topic = (await owner.call('topic.create', { topicId: mintObjectId(), categoryId: category.categoryId, title: 'Original Topic' })).topic
  const source = { kind: 'file' as const, hostId: workspace.hostId, projectId: 'responsive-project', path: join(workspace.path, 'original-source.md') }
  await writeFile(source.path, '# Exact original source\n\nOriginal file owner bytes.')
  const first = (await owner.call('topic.knowledge.write', { topicId: topic.topicId, entryId: mintObjectId(), title: 'First knowledge', content: 'Do not substitute this first entry.', form: 'derived', certainty: 'fact', sources: [], expectedRevision: null })).entry
  const entry = (await owner.call('topic.knowledge.write', { topicId: topic.topicId, entryId: mintObjectId(), title: 'Original second knowledge', content: 'Original second entry body.', form: 'reference', certainty: 'proposal', sources: [source], expectedRevision: null })).entry
  const zone = { zoneId: mintObjectId(), workspaceId: workspace.id, hostId: workspace.hostId, directoryPath: workspace.path, kind: 'directory' as const, branch: null }
  const catalog: AgentMuxSpaceCatalog = { spaces: [], zones: [zone], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [], motePresentation: [] }
  const fileOwner = new FileReadOwner({ files, workspace: id => id === workspace.id ? workspace : undefined, catalog: async () => catalog })
  const service = new AgentMuxRpcService({ topics: owner, files: fileOwner, coreClients: () => [] })
  // Original discovery metadata selects the same fixture resource; all Topic/file operations consume real owners and public RPC codecs.
  const call = vi.fn(async (method: string, input: any) => method === 'app.snapshot' ? { workspaces: [{ ...workspace, workspaceId: workspace.id, projectId: 'responsive-project', repoPath: null, branch: null }], unavailable: [] }
    : method === 'space.ls' ? { catalog } : service.call(method as any, input, { principal: { kind: 'device', id: 'private-responsive-device' } }))
  const rpc = call as unknown as TopicsRpc
  const origin = location.origin, scope = { origin, runtimeId: 'responsive-runtime', deviceHostId: workspace.hostId }
  await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), hostUrl: origin, host: { origin, hostId: workspace.hostId } })
  const client = { forwardRpc: rpc, runtimeOwnerIdentity: () => ({ runtimeId: scope.runtimeId, ownerInstanceId: 'responsive-process', availability: 'connected' }) } as unknown as AgentMuxHostedClient
  return { owner, topic, category, first, entry, rpc, call, client, scope, source, dispose: async () => { await files.dispose(); await rm(path, { recursive: true, force: true }) } }
}
