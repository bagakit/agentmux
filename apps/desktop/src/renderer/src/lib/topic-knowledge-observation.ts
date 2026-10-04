import { PMO_TEAMS_TOPIC_ID } from '../../../shared/scratch-topics'
import type { SpaceZoneBindings } from '../../../shared/space-addresses'

type ObservationKeys = { topics: Map<string, string>; all: string }
const cache = new WeakMap<SpaceZoneBindings, ObservationKeys>()

/** Derived query dependencies, never a second membership or resource registry. */
export function topicKnowledgeObservationKey(bindings: SpaceZoneBindings, topicId?: string): string {
  let keys = cache.get(bindings)
  if (!keys) {
    const candidates = new Map<string, unknown[][]>(), motes = new Set<string>()
    for (const [zoneId, binding] of Object.entries(bindings)) {
      if (!binding.topicId) continue
      if (binding.contentKind === 'mote') motes.add(binding.topicId)
      const rows = candidates.get(binding.topicId) ?? []
      // The Desktop projection fills false relations for unrelated Spaces. Only
      // effective membership changes the observed Topic, not that fill operation.
      rows.push([zoneId, binding.spaceId, binding.workspaceId, binding.directoryPath,
        binding.contentKind, Object.keys(binding.relations ?? {}).filter(id => binding.relations?.[id] === true).sort()])
      candidates.set(binding.topicId, rows)
    }
    const topics = new Map([...candidates].map(([id, rows]) => [id, JSON.stringify(rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]))))]))
    // Whole-library search does not inspect Category membership. Its scope only
    // changes with ordinary Topic members and their original resources/kind.
    const all = [...candidates].filter(([id]) => id !== PMO_TEAMS_TOPIC_ID && !motes.has(id))
      .map(([id, rows]) => [id, rows.map(row => row.slice(0, -1))] as const).sort(([a], [b]) => a.localeCompare(b))
    keys = { topics, all: JSON.stringify(all) }
    cache.set(bindings, keys)
  }
  return topicId === undefined ? keys.all : keys.topics.get(topicId) ?? '[]'
}
