import { vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ScratchTopicSnapshot } from '../../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../src/shared/scratch-topics'
import { api } from '../../src/renderer/src/lib/api'
import { spatialCatalog } from '../../src/renderer/src/lib/space-agent-control'
import { scratchTopicsScope } from '../../src/renderer/src/lib/scratch-topic-snapshots'
import { prepareRendererUpdate, useAppStore } from '../../src/renderer/src/store'
import { config, startWorkfaceFixture } from './workface-control-fixture'
import { initializeSpatialControlFixture } from './spatial-control-owner-fixture'

export const fileConfig = { ...config, workspaces: [...config.workspaces,
  { id: SCRATCH_WORKSPACE_ID, name: 'Private Topics', hostId: 'local', path: '/private/workface-scratch', kind: 'folder' as const }] }
export const fileTopics: ScratchTopicSnapshot[] = [{ id: 'view:workface-topic', directoryPath: 'topic--view--workface-topic',
  topicPath: 'topic--view--workface-topic/topic.md', title: 'Original Topic', summary: '', collaborators: [] }]
export function fileCatalog() { return spatialCatalog(useAppStore.getState(), fileTopics) }
export function zoneFor(workspaceId: string, topic = false) {
  const catalog = fileCatalog()
  const zone = topic ? catalog.zones.find(zone => zone.directoryPath?.endsWith('/' + fileTopics[0]!.directoryPath))
    : catalog.zones.find(zone => zone.workspaceId === workspaceId)
  if (!zone) throw new Error('The original nonempty Zone fixture is missing.')
  return zone
}
export async function startWorkfaceFileFixture() {
  const fixture = await startWorkfaceFixture()
  useAppStore.setState({ config: fileConfig, layouts: { ...useAppStore.getState().layouts,
    [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('topic-group') },
    documents: {}, dirtyDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {},
    savingDocuments: {}, documentRevealTargets: {}, editorRegionModes: {}, editorRegionDiffs: {}, fileExplorerStates: {},
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(fileConfig.workspaces[2]!),
      revision: 0, topics: fileTopics, error: null, reading: false } } })
  await initializeSpatialControlFixture(fileTopics)
  await prepareRendererUpdate(); fixture.flush.mockClear(); fixture.snapshot.mockClear()
  for (const call of fixture.lifecycle) call.mockClear()
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => ({ status: 'read', document: { path,
    content: '# Original file\n\nCurrent readable source.', revision: 'original-revision' } }))
  vi.spyOn(api.files, 'readPreview').mockResolvedValue({ status: 'unavailable', code: 'PRIVATE_BYTES_UNAVAILABLE', message: 'Private preview byte boundary.' })
  return { ...fixture, flush: vi.mocked(api.ui.requestStorageFlush), snapshot: vi.mocked(api.sessions.snapshot) }
}
