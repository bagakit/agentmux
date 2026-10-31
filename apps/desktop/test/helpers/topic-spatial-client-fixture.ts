import { vi } from 'vitest'
import type { ScratchTopicSnapshot } from '../../src/shared/contracts'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { providerCatalogReader } from './startup-observation-api-fixture'

/** Start the real client over the caller's original spatial port and exact arranged workface. */
export async function initializeTopicSpatialClient(topics: () => Promise<ScratchTopicSnapshot[]>): Promise<() => void> {
  const arranged = useAppStore.getState()
  if (!arranged.config) throw new Error('Arrange the original Topic workface and configuration before initializing its client.')
  vi.spyOn(api.config, 'get').mockResolvedValue(arranged.config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(topics)
  // This test owns ordinary Topic navigation, not primary-Mote provisioning.
  vi.spyOn(api.scratch, 'ensureMote').mockResolvedValue((await topics())[0]!)
  const snapshot = await api.sessions.snapshot()
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, sessions: arranged.sessions, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  return useAppStore.getState().initialize()
}
