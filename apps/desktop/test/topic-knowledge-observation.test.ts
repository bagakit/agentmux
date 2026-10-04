import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import type { SpaceZoneBindings } from '../src/shared/space-addresses'
import { topicKnowledgeObservationKey as key } from '../src/renderer/src/lib/topic-knowledge-observation'

const original: SpaceZoneBindings = {
  'original-zone': { spaceId: 'original-space', workspaceId: '__scratch__', topicId: 'topic-a', directoryPath: _hygiene_fixturePath("topics/a"), contentKind: 'topic', relations: { categoryA: true } }
}

describe('knowledge observation follows its actual scope', () => {
  it('ignores unrelated objects and false relation fill without ignoring its own membership', () => {
    const unrelated = { ...original, project: { spaceId: 'project', workspaceId: 'project' },
      'original-zone': { ...original['original-zone']!, relations: { categoryA: true, project: false } } }
    expect(key(unrelated, 'topic-a')).toBe(key(original, 'topic-a'))
    const moved = { ...original, 'original-zone': { ...original['original-zone']!, relations: { categoryA: false, categoryB: true } } }
    expect(key(moved, 'topic-a')).not.toBe(key(original, 'topic-a'))
    expect(key(moved)).toBe(key(original))
  })

  it('observes original resource and kind changes, including an additional ambiguous candidate', () => {
    for (const changes of [{ directoryPath: _hygiene_fixturePath("topics/new-a") }, { workspaceId: 'other-owner' }, { contentKind: 'mote' as const }]) {
      const changed = { ...original, 'original-zone': { ...original['original-zone']!, ...changes } }
      expect(key(changed, 'topic-a')).not.toBe(key(original, 'topic-a'))
      expect(key(changed)).not.toBe(key(original))
    }
    const ambiguous = { ...original, otherZone: { ...original['original-zone']! } }
    expect(key(ambiguous, 'topic-a')).not.toBe(key(original, 'topic-a'))
    expect(key(ambiguous)).not.toBe(key(original))
    expect(key(Object.fromEntries(Object.entries(ambiguous).reverse()))).toBe(key(ambiguous))
  })

  it('updates whole-library membership for ordinary Topics, excluding Mote and team content', () => {
    const added = { ...original, another: { spaceId: 'other', workspaceId: '__scratch__', topicId: 'topic-b', contentKind: 'topic' as const } }
    expect(key(added)).not.toBe(key(original))
    const excluded = { ...original, mote: { spaceId: 'mote', workspaceId: '__scratch__', topicId: 'mote', contentKind: 'mote' as const },
      teams: { spaceId: 'teams', workspaceId: '__scratch__', topicId: PMO_TEAMS_TOPIC_ID } }
    expect(key(excluded)).toBe(key(original))
    // Unknown kind remains observable until its original identity is confirmed.
    const unknown = { ...original, unknown: { spaceId: 'unknown', workspaceId: '__scratch__', topicId: 'unknown' } }
    expect(key(unknown)).not.toBe(key(original))
  })
})
