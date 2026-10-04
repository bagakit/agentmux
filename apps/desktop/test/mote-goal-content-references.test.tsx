import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { moteGoalContext, goalsForMote } from '../src/renderer/src/lib/mote-goals'
import { customMoteId, customAgent, defaultAgent, ordinaryAgent, moteTopics, scratchWorkspace, seedMoteWorkface } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { previewGoalContentReferences, goalContentSource } from '../src/shared/goal-content-references'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
const initial = useAppStore.getState()
const scope = (id = PMO_TEAMS_TOPIC_ID) => ({ workspace: scratchWorkspace, topic: moteTopics.find(item => item.id === id)!, rootPath: scratchTopicDirectoryName(id) })
beforeEach(() => seedMoteWorkface())
afterEach(() => useAppStore.setState(initial, true))
it('content association uses only the original Mote home tuple, independently of foreign display bindings and new discussion membership', () => {
  const primary = moteGoalContext(useAppStore.getState(), scope()), other = moteGoalContext(useAppStore.getState(), scope(customMoteId))
  expect(primary.contentRef).not.toBeNull(); expect(other.contentRef).not.toEqual(primary.contentRef)
  const goal: DemandRecord = { id: 'retained', title: 'Original result', description: 'Original body', status: 'done', priority: 'normal', projectId: null, projectName: null, sessionIds: ['closed-original'], contentRefs: [primary.contentRef!], createdAt: 1, updatedAt: 2, source: 'session' }
  expect(goalsForMote({ retained: goal }, [], primary.contentRef)).toEqual([goal])
  expect(goalsForMote({ retained: goal }, [], other.contentRef)).toEqual([])
  const spaceId = directoryIdentity('local', _hygiene_fixturePath("topics/") + scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)), customSpace = directoryIdentity('local', _hygiene_fixturePath("topics/") + scratchTopicDirectoryName(customMoteId))
  useAppStore.setState({ spaceZoneBindings: { [homeZoneId(customSpace)]: { workspaceId: scratchWorkspace.id, spaceId: customSpace, topicId: customMoteId, contentKind: 'mote', directoryPath: _hygiene_fixturePath("topics/") + scratchTopicDirectoryName(customMoteId), relations: { [spaceId]: true } } } })
  const afterForeignBinding = moteGoalContext(useAppStore.getState(), scope())
  expect(afterForeignBinding.contentRef).toEqual(primary.contentRef)
  expect(afterForeignBinding.sessionIds).toContain(customAgent.id)
  const explicitExecution = { ...goal, sessionIds: [customAgent.id], contentRefs: [other.contentRef!] }
  expect(goalsForMote({ explicitExecution }, afterForeignBinding.sessionIds, primary.contentRef)).toEqual([explicitExecution])
  expect(goalsForMote({ explicitExecution }, [], other.contentRef)).toEqual([explicitExecution])
  expect(explicitExecution.contentRefs).toEqual([other.contentRef])
  expect(afterForeignBinding.sessionIds).not.toContain(ordinaryAgent.id)
  expect(goalsForMote({ foreign: { ...explicitExecution, sessionIds: [ordinaryAgent.id] } }, afterForeignBinding.sessionIds, primary.contentRef)).toEqual([])
  expect(previewGoalContentReferences(workbenchSelectionCatalog(useAppStore.getState()), [explicitExecution])[0]).toMatchObject({ state: 'already-recorded', contentRefs: [] })
  expect(goalsForMote({ retained: goal }, [], { ...primary.contentRef!, hostId: 'foreign' })).toEqual([])
})
it('existing data preview records only a unique proven resource and explicitly retains missing or ambiguous evidence', () => {
  const catalog = workbenchSelectionCatalog(useAppStore.getState())
  const original = { id: 'known', updatedAt: 5, sessionIds: [defaultAgent.id] }
  const rows = previewGoalContentReferences(catalog, [original, { ...original, id: 'lost', sessionIds: ['closed'] }])
  expect(rows[0]).toMatchObject({ goalId: 'known', expectedUpdatedAt: 5, state: 'confirmed', contentRefs: [moteGoalContext(useAppStore.getState(), scope()).contentRef] })
  expect(rows[1]).toMatchObject({ state: 'unresolved', contentRefs: [], reason: expect.stringContaining('No original') })
  expect(previewGoalContentReferences(catalog, [{ ...original, sessionIds: [defaultAgent.id, 'closed'] }])[0]).toMatchObject({ state: 'unresolved', contentRefs: [], reason: expect.stringContaining('Some original') })
  const another = catalog.regions.find(region => region.agentSessionId && region.agentSessionId !== defaultAgent.id && catalog.tabs.find(tab => tab.tabId === region.tabId)?.zoneId !== rows[0]!.contentRefs[0]!.zoneId)!
  expect(another).toBeTruthy()
  const ambiguous = { ...catalog, regions: [...catalog.regions, { ...another, regionId: 'duplicate-origin', agentSessionId: defaultAgent.id }], tabs: catalog.tabs.map(tab => tab.tabId === another.tabId ? { ...tab, regionIds: [...tab.regionIds, 'duplicate-origin'] } : tab) }
  expect(goalContentSource(ambiguous, [defaultAgent.id])).toMatchObject({ contentRef: null, reason: expect.stringContaining('multiple') })
  expect(previewGoalContentReferences(catalog, [{ ...original, contentRefs: rows[0]!.contentRefs }])[0]).toMatchObject({ state: 'already-recorded', contentRefs: [] })
})
