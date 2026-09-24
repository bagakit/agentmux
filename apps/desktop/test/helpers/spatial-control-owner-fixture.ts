import { webcrypto } from 'node:crypto'
import { vi } from 'vitest'
import type { ScratchTopicSnapshot } from '../../src/shared/scratch-topics'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'

/** Admit through the real restore/write owner, then retain the test's arranged workbench. */
export async function initializeSpatialControlFixture(topics: ScratchTopicSnapshot[] = []): Promise<void> {
  const arranged = useAppStore.getState()
  if (!arranged.config) throw new Error('Arrange the explicit configuration before spatial Control.')
  vi.stubGlobal('crypto', webcrypto)
  vi.spyOn(api.config, 'get').mockResolvedValue(arranged.config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({
    sessions: arranged.sessions, timelines: arranged.timelines, recoveryCandidates: []
  })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  const dispose = await useAppStore.getState().initialize()
  dispose()
  useAppStore.setState(arranged, true)
}
