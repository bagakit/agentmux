// @vitest-environment happy-dom
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { isObjectId, mintObjectId } from '@agentmux/core/object-id'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { ScratchTopics } from '@agentmux/host/mote-resources'
import { OrdinaryWorkspaceFiles } from '@agentmux/host/ordinary-files'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { createWorkspaceLayout } from '@agentmux/layout'
import { checkpointAgentOperations, useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { agentOperationKey, beginAgentOperation, type AgentOperationFeedback } from '../src/renderer/src/lib/agent-operation-feedback'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
const initial = useAppStore.getState()
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); useAppStore.setState(initial, true)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'club-preparation-'))); roots.push(root)
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: join(root, '.agentmux/scratch'), kind: 'folder' as const }
  await mkdir(workspace.path, { recursive: true })
  const owner = new ScratchTopics()
  useAppStore.setState({ config: { ...initial.config!, version: 9, workspaces: [workspace], hosts: [], executors: {} },
    activeWorkspaceId: 'other', layouts: { [workspace.id]: createWorkspaceLayout('original-group') }, tabs: {},
    scratchTopicSnapshots: {}, agentComposerDrafts: {}, agentOperations: {}, error: null })
  const ensure = vi.spyOn(api.scratch, 'ensureMote').mockImplementation((_workspaceId, topicId) => owner.ensureMote(workspace, topicId))
  const read = vi.spyOn(api.scratch, 'readTopic').mockImplementation((_workspaceId, topicId) => owner.read(workspace, topicId))
  return { root, workspace, owner, ensure, read }
}
it('creates a durable Topic from a different Project before its independent Tab projection exists', async () => {
  const { root, workspace, owner } = await fixture()
  const spatialState = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const content = new TopicKnowledgeOwner(owner, new OrdinaryWorkspaceFiles(), () => workspace)
  const spatial = new TopicSpatialOwner({ state: spatialState, workspace: () => workspace,
    topics: () => content.listTopicSnapshots(), categories: () => content.listCategories(),
    ensureDefaultCategory: () => content.ensureDefaultCategoryContent() })
  content.setSpatialPort(spatial)
  const create = vi.spyOn(api.topics, 'call').mockImplementation((method, params) => content.call(method, params))
  // This factory test supplies the Host transport and confirms its durable graph;
  // Renderer graph subscriptions have their own original consumer tests.
  useAppStore.setState({ refreshSpatialState: async () => { expect(await spatialState.read()).not.toBeNull() } })
  const created = await useAppStore.getState().createScratchTopic()
  expect(create).toHaveBeenCalledWith('topic.create', { topicId: created.id, title: 'New Topic' })
  expect(isObjectId(created.id)).toBe(true)
  expect(await readdir(created.physicalDirectoryPath!)).toEqual(expect.arrayContaining(['topic.md', 'refs', 'outcome', '.agents']))
  const state = useAppStore.getState()
  const tabs = Object.values(state.tabs)
  expect(tabs).toHaveLength(1)
  expect(tabs[0]?.topicId).toBe(created.id)
  expect(tabs[0]?.id).not.toBe(created.id)
  expect(state.activeWorkspaceId).toBe(SCRATCH_WORKSPACE_ID)
  expect(state.workspaceFileRevisions[SCRATCH_WORKSPACE_ID]).toBeGreaterThan(0)
  useAppStore.setState({ tabs: {}, layouts: {} })
  expect(await api.scratch.readTopic(SCRATCH_WORKSPACE_ID, created.id)).toMatchObject({ id: created.id, directoryPath: created.directoryPath })
})

it('continues a retained Club preparation after a lost ensure receipt without minting a second Topic or replacing its original draft', async () => {
  const f = await fixture(), preparation = { topicId: mintObjectId(), tabId: mintObjectId() }
  f.ensure.mockImplementationOnce(async (_workspaceId, topicId) => {
    await f.owner.ensureMote(f.workspace, topicId)
    throw new Error('Original ensure receipt unavailable')
  })
  const launch = vi.spyOn(api.sessions, 'launchAgent')
  await expect(useAppStore.getState().createScratchTopic('mote', undefined, undefined, {
    reveal: false, preparation: { ...preparation, createPresentation: true }
  })).rejects.toThrow('Original ensure receipt unavailable')
  const original = useAppStore.getState().tabs[preparation.tabId]!, regionId = original.layout.activeRegionId
  expect(original.topicId).toBe(preparation.topicId)
  expect(original.topicPreparation).toBe('mote')
  const originalSurface = original.regions[regionId]
  useAppStore.setState({ agentComposerDrafts: { [regionId]: 'Keep the later original draft' } })
  const selection = useAppStore.getState().workbenchSpaceSelection, layout = useAppStore.getState().layouts[f.workspace.id]
  const resumed = await useAppStore.getState().createScratchTopic('mote', undefined, undefined, { reveal: false, preparation })
  expect(resumed.id).toBe(preparation.topicId)
  expect(f.ensure).toHaveBeenCalledTimes(1)
  expect(Object.keys(useAppStore.getState().tabs)).toEqual([preparation.tabId])
  expect(useAppStore.getState().tabs[preparation.tabId]?.regions[regionId]).toBe(originalSurface)
  expect(useAppStore.getState().tabs[preparation.tabId]?.topicPreparation).toBeUndefined()
  expect(useAppStore.getState().agentComposerDrafts[regionId]).toBe('Keep the later original draft')
  expect(useAppStore.getState().activeWorkspaceId).toBe('other')
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selection)
  expect(useAppStore.getState().layouts[f.workspace.id]).toBe(layout)
  expect((await f.owner.list(f.workspace)).map(topic => topic.id)).toEqual([preparation.topicId])
  expect(launch).not.toHaveBeenCalled()
})

it('reads the retained Club content after its Tab was closed and never recreates that presentation', async () => {
  const f = await fixture(), preparation = { topicId: mintObjectId(), tabId: mintObjectId() }
  const created = await useAppStore.getState().createScratchTopic('mote', undefined, undefined, {
    reveal: false, preparation: { ...preparation, createPresentation: true }
  })
  await writeFile(join(created.physicalDirectoryPath!, 'SOUL.md'), 'Original authored personality')
  useAppStore.setState({ tabs: {}, layouts: {} })
  const resumed = await useAppStore.getState().createScratchTopic('mote', undefined, undefined, { reveal: false, preparation })
  expect(resumed.id).toBe(created.id)
  expect(resumed.soul?.content).toBe('Original authored personality')
  expect(f.ensure).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().tabs).toEqual({})
  expect(useAppStore.getState().layouts).toEqual({})
  expect(useAppStore.getState().scratchTopicSnapshots[f.workspace.id]?.topics).toEqual([resumed])
  expect(await readFile(join(created.physicalDirectoryPath!, 'SOUL.md'), 'utf8')).toBe('Original authored personality')
})

it('can continue the original Club content without a Tab after the first presentation was never admitted', async () => {
  const f = await fixture(), preparation = { topicId: mintObjectId(), tabId: mintObjectId(),
    expectedResource: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path } }
  useAppStore.setState({ tabs: {}, layouts: {} })
  const created = await useAppStore.getState().createScratchTopic('mote', undefined, undefined, { reveal: false, preparation })
  expect(created.id).toBe(preparation.topicId)
  expect(f.ensure).toHaveBeenCalledWith(f.workspace.id, preparation.topicId, preparation.expectedResource)
  expect(useAppStore.getState().tabs).toEqual({})
  expect(useAppStore.getState().layouts).toEqual({})
  expect((await f.owner.list(f.workspace)).map(topic => topic.id)).toEqual([preparation.topicId])
})

it('retains the original Club preparation when its exact content read is unknown instead of treating the gap as a new creation', async () => {
  const f = await fixture(), preparation = { topicId: mintObjectId(), tabId: mintObjectId() }
  await useAppStore.getState().createScratchTopic('mote', undefined, undefined, {
    reveal: false, preparation: { ...preparation, createPresentation: true }
  })
  const original = useAppStore.getState().tabs[preparation.tabId]
  f.read.mockRejectedValueOnce(new Error('Original content read unavailable'))
  await expect(useAppStore.getState().createScratchTopic('mote', undefined, undefined, { reveal: false, preparation }))
    .rejects.toThrow('Original content read unavailable')
  expect(f.ensure).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().tabs[preparation.tabId]).toBe(original)
  expect((await f.owner.list(f.workspace)).map(topic => topic.id)).toEqual([preparation.topicId])
})

it('rejects a retained Club preparation aimed at another original Tab without changing its work', async () => {
  const f = await fixture(), preparation = { topicId: mintObjectId(), tabId: mintObjectId() }
  await useAppStore.getState().createScratchTopic('mote', undefined, undefined, {
    reveal: false, preparation: { ...preparation, createPresentation: true }
  })
  const original = useAppStore.getState()
  await expect(original.createScratchTopic('mote', undefined, undefined, {
    preparation: { ...preparation, topicId: mintObjectId() }
  })).rejects.toThrow('does not own this Tab')
  expect(useAppStore.getState().tabs).toBe(original.tabs)
  expect(useAppStore.getState().layouts).toBe(original.layouts)
  expect(f.ensure).toHaveBeenCalledTimes(1)
})

it('keeps the original operation while its user document is still restoring, without saving unrelated files or accepting a false flush ACK', async () => {
  await fixture()
  const operation: AgentOperationFeedback = { kind: 'fork', operationId: mintObjectId(),
    subject: { hostId: 'local', regionId: mintObjectId() }, phase: 'unconfirmed', startedAt: 1 }
  beginAgentOperation(operation)
  const key = agentOperationKey(operation), references = useAppStore.getState().agentOperations
  const save = vi.spyOn(useAppStore.getState(), 'saveDocument').mockRejectedValue(new Error('Unrelated document save unavailable'))
  const flush = vi.spyOn(api.ui, 'requestStorageFlush')
  await expect(checkpointAgentOperations()).rejects.toThrow('original workbench is still being restored')
  expect(useAppStore.getState().agentOperations).toBe(references)
  expect(useAppStore.getState().agentOperations[key]).toBe(operation)
  expect(flush).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentOperations[key]).toBe(operation)
})
