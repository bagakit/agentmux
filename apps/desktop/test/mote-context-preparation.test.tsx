// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import { directoryIdentity, topicSpatialAddress } from '../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { moteWorkbenchProjection } from '../src/renderer/src/lib/mote-workbench-projection'
import { projectWorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import { useAppStore } from '../src/renderer/src/store'
import { customTab, defaultTab, moteConfig, moteTopic, moteTopics, scratchWorkspace } from './fixtures/mote-workface'

const initial = useAppStore.getState()
const originalTabs = [defaultTab, customTab]
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
function seed(tab = defaultTab, prepared = true) {
  const topic = moteTopics.find(topic => topic.id === tab.topicId)!
  const address = topicSpatialAddress(moteConfig, topic)!
  const original = { ...tab, ...(prepared ? { space: address } : { topicPreparation: 'mote' as const }) }
  const reference = { displayWorkspaceId: 'project', groupId: 'foreign-group', tabId: tab.id, regionId: tab.layout.activeRegionId }
  useAppStore.setState({ config: moteConfig, activeWorkspaceId: 'project', mainSurface: 'board', tabs: { [original.id]: original },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('empty-resource-group'), project: createWorkspaceLayout(reference.groupId, [tab.id]) },
    sessions: [], topicCategories: [], spaceZoneBindings: {}, workbenchSpaceSelection: null,
    agentComposerDrafts: { [reference.regionId]: 'Original edited draft' }, agentComposerNotes: { [reference.regionId]: 'Original note' },
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), topics: [topic], revision: 1, reading: false, error: null } } })
  return { original, topic, reference, address }
}
async function unacknowledgedBirth() {
  seed()
  useAppStore.setState({ tabs: {}, agentComposerDrafts: {}, scratchTopicSnapshots: {},
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('birth-group'), project: createWorkspaceLayout('foreign-group') } })
  vi.spyOn(api.scratch, 'ensureMote').mockRejectedValue(new Error('Original birth receipt unavailable'))
  const creation = useAppStore.getState().createScratchTopic('mote', { prompt: 'Original unsent draft' })
  const original = Object.values(useAppStore.getState().tabs).find(tab => tab.topicPreparation)!
  expect(original).toBeDefined(); await expect(creation).rejects.toThrow('Original birth receipt unavailable')
  const topic = moteTopic(original.topicId!, 'Same original born Mote', true)
  const reference = { displayWorkspaceId: 'project', groupId: 'foreign-group', tabId: original.id, regionId: original.layout.activeRegionId }
  // Model the already-restored foreign occurrence; preparing it must keep this born owner.
  useAppStore.setState({ layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('birth-group'), project: createWorkspaceLayout('foreign-group', [original.id]) } })
  return { original, topic, reference, address: topicSpatialAddress(moteConfig, topic)! }
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear(); useAppStore.setState(initial, true)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
})
afterEach(() => { useAppStore.setState(initial, true); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(originalTabs)('background metadata preparation keeps the exact foreign display owner for $id', async tab => {
  const { original, topic, reference } = seed(tab)
  const before = useAppStore.getState()
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue({ ...topic, title: 'Confirmed current title' })
  await expect(before.openScratchTopic(topic.id, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: original.id })).resolves.toBe(true)
  const after = useAppStore.getState()
  expect(api.scratch.readTopic).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, topic.id)
  expect(after.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics?.[0]?.title).toBe('Confirmed current title')
  expect(after.tabs).toBe(before.tabs); expect(after.tabs[original.id]).toBe(original); expect(after.layouts).toBe(before.layouts)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts); expect(after.agentComposerNotes).toBe(before.agentComposerNotes)
  expect(after.workbenchSpaceSelection).toBe(before.workbenchSpaceSelection); expect(after.agentFocus).toBe(before.agentFocus)
  expect(after.activeWorkspaceId).toBe('project'); expect(after.mainSurface).toBe('board')
  expect(after.agentComposerDrafts[reference.regionId]).toBe('Original edited draft'); expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('confirmed metadata preparation does not turn a still-unobserved display placement into a preparation failure', async () => {
  const { original, topic, reference } = seed()
  useAppStore.setState({ layouts: {} })
  const before = useAppStore.getState()
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  await expect(before.openScratchTopic(topic.id, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: original.id })).resolves.toBe(true)
  const after = useAppStore.getState(), floating = { open: true, preview: false, targetTopicId: topic.id, targetTabId: original.id, reference }
  const resolved = moteWorkbenchProjection(spatialCatalog(after, [topic]), original, floating, vi.fn(), after.layouts)
  expect(resolved.issueKind).toBe('location'); expect(resolved.projection).toBeNull(); expect(floating.reference).toBe(reference)
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts); expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.workbenchSpaceSelection).toBe(before.workbenchSpaceSelection); expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('a background retry binds the same moved Born Tab after confirmation while preserving later input and navigation', async () => {
  const { original, topic, reference, address } = await unacknowledgedBirth()
  const pending = deferred<ScratchTopicSnapshot>(); vi.spyOn(api.scratch, 'readTopic').mockReturnValue(pending.promise)
  const before = useAppStore.getState()
  const job = before.openScratchTopic(topic.id, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: original.id })
  useAppStore.getState().setAgentComposerDraft(reference.regionId, 'Edited while preparing')
  useAppStore.setState({ mainSurface: 'agents' })
  pending.resolve(topic); await expect(job).resolves.toBe(true)
  const after = useAppStore.getState(), bound = after.tabs[original.id]!
  expect(Object.keys(after.tabs)).toEqual([original.id]); expect(bound.space).toEqual(address); expect(bound.topicPreparation).toBeUndefined()
  expect(bound.regions).toBe(original.regions); expect(bound.layout).toBe(original.layout); expect(after.layouts).toBe(before.layouts)
  expect(after.agentComposerDrafts[reference.regionId]).toBe('Edited while preparing'); expect(after.mainSurface).toBe('agents')
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('a delayed background receipt does not reopen an explicitly closed original Tab', async () => {
  const { original, topic, reference } = seed()
  const pending = deferred<ScratchTopicSnapshot>(); vi.spyOn(api.scratch, 'readTopic').mockReturnValue(pending.promise)
  const job = useAppStore.getState().openScratchTopic(topic.id, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: original.id })
  expect(await useAppStore.getState().closeTab(reference.displayWorkspaceId, reference.groupId, original.id, { keepAgentSessions: true })).toBe(true)
  const closed = useAppStore.getState(); pending.resolve(topic)
  await expect(job).rejects.toThrow('original discussion owner')
  const after = useAppStore.getState()
  expect(after.tabs).toBe(closed.tabs); expect(after.tabs[original.id]).toBeUndefined(); expect(after.layouts).toBe(closed.layouts)
  expect(after.scratchTopicSnapshots).toBe(closed.scratchTopicSnapshots); expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('a receipt from a previous resource scope cannot overwrite current metadata or bind the unacknowledged original Tab', async () => {
  const { original, topic } = await unacknowledgedBirth()
  const pending = deferred<ScratchTopicSnapshot>(); vi.spyOn(api.scratch, 'readTopic').mockReturnValue(pending.promise)
  const job = useAppStore.getState().openScratchTopic(topic.id, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: original.id })
  const changedWorkspace = { ...scratchWorkspace, path: scratchWorkspace.path + '/later-scope' }
  const currentSnapshot = { scope: scratchTopicsScope(changedWorkspace), topics: [], revision: 2, reading: false, error: null }
  useAppStore.setState({ config: { ...moteConfig, workspaces: moteConfig.workspaces.map(item => item.id === SCRATCH_WORKSPACE_ID ? changedWorkspace : item) },
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: currentSnapshot } })
  pending.resolve(topic); await expect(job).rejects.toThrow('original Scratch resource changed')
  const after = useAppStore.getState()
  expect(after.tabs[original.id]).toBe(original); expect(after.tabs[original.id]?.space).toBeUndefined()
  expect(after.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]).toBe(currentSnapshot)
  expect(after.agentComposerDrafts[original.layout.activeRegionId]).toBe('Original unsent draft')
})

it.each(['foreign-topic', 'read-error', 'different-owner', 'different-zone'] as const)('background preparation keeps original facts when receipt/owner is %s', async variant => {
  const { original, topic } = seed()
  const pending = deferred<ScratchTopicSnapshot>(); vi.spyOn(api.scratch, 'readTopic').mockReturnValue(pending.promise)
  const job = useAppStore.getState().openScratchTopic(topic.id, SCRATCH_WORKSPACE_ID, { reveal: false, tabId: original.id })
  if (variant === 'different-owner') useAppStore.setState({ tabs: { [original.id]: { ...original, topicId: customTab.topicId } } })
  const before = useAppStore.getState()
  pending.resolve(variant === 'foreign-topic' ? { ...topic, id: customTab.topicId! } : variant === 'read-error' ? { ...topic, readError: 'Original directory read unavailable' }
    : variant === 'different-zone' ? { ...topic, identityDirectoryPath: scratchWorkspace.path + '/other-original-owner', physicalDirectoryPath: scratchWorkspace.path + '/other-original-owner' } : topic)
  await expect(job).rejects.toThrow(variant === 'read-error' ? 'Original directory read unavailable' : /original owner|original discussion owner/)
  const after = useAppStore.getState()
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts); expect(after.scratchTopicSnapshots).toBe(before.scratchTopicSnapshots)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts); expect(api.sessions.stop).not.toHaveBeenCalled()
})

function sharedParent() {
  const seeded = seed()
  const secondSpace = directoryIdentity('local', moteConfig.workspaces.find(item => item.id === 'project')!.path)
  useAppStore.setState({ spaceZoneBindings: { [seeded.address.zoneId]: { ...seeded.address,
    workspaceId: SCRATCH_WORKSPACE_ID, topicId: seeded.topic.id, contentKind: 'mote', relations: { [secondSpace]: true } } } })
  const state = useAppStore.getState(), catalog = spatialCatalog(state, [seeded.topic])
  const reference = { ...seeded.reference, regionId: 'original-region-not-observed' }
  const floating = { open: true, preview: false, targetTopicId: seeded.topic.id, targetTabId: seeded.original.id, reference }
  return { ...seeded, state, catalog, reference, floating }
}

it('the real projector retains an unknown Region parent with several Space bindings and keeps every catalog fact', () => {
  const { state, original, catalog, reference, floating } = sharedParent()
  expect(catalog.locations.filter(location => location.tabId === original.id)).toHaveLength(2)
  const resolved = moteWorkbenchProjection(catalog, original, floating, vi.fn(), state.layouts)
  expect(resolved.issueKind).toBe('parent-available'); expect(resolved.catalog).toBe(catalog); expect(resolved.projection?.catalog).toBe(catalog)
  expect(resolved.projection?.selection).toEqual([reference])
  const composed = projectWorkbenchProjection(state.layouts[reference.displayWorkspaceId], state.tabs, resolved.projection!)
  expect(composed.layout?.groups.find(group => group.id === reference.groupId)?.activeTabId).toBe(original.id)
  expect(composed.selection).toEqual([reference]); expect(composed.issues).toEqual([])
  expect(reference.regionId).toBe('original-region-not-observed'); expect(useAppStore.getState().tabs).toBe(state.tabs)
})

it('consistent duplicate bindings of one exact location stay quiet, while Agent identity remains an independent guard', () => {
  const { state, original, catalog, reference, floating } = sharedParent()
  const exact = { ...reference, regionId: original.layout.activeRegionId }
  const resolved = moteWorkbenchProjection(catalog, original, { ...floating, reference: exact }, vi.fn(), state.layouts)
  expect(resolved.issue).toBeNull(); expect(resolved.issueKind).toBeNull(); expect(resolved.choices).toEqual([exact])
  expect(resolved.projection?.catalog).toBe(catalog)
  const differentAgent = { ...floating, reference: exact, targetAgent: { hostId: 'local', sessionId: 'different-agent', presentationSessionId: 'different-agent' } }
  const guarded = moteWorkbenchProjection(catalog, original, differentAgent, vi.fn(), state.layouts)
  expect(guarded.projection).toBeNull(); expect(guarded.issueKind).toBe('identity'); expect(guarded.issue).toContain('last visited Agent')
  expect(differentAgent.reference).toBe(exact); expect(differentAgent.targetAgent.sessionId).toBe('different-agent')
})

it.each(['zone', 'resource', 'binding', 'tab-facts', 'zone-facts', 'region-membership'] as const)('conflicting %s metadata cannot be swallowed as a repeated physical parent', variant => {
  const { state, original, catalog, reference, floating } = sharedParent()
  const resolved = moteWorkbenchProjection(catalog, original, floating, vi.fn(), state.layouts)
  const broken = variant === 'tab-facts' ? { ...catalog, tabs: [...catalog.tabs, { ...catalog.tabs[0]! }] }
    : variant === 'zone-facts' ? { ...catalog, zones: [...catalog.zones, { ...catalog.zones.find(zone => zone.zoneId === catalog.tabs[0]!.zoneId)! }] }
    : variant === 'region-membership' ? { ...catalog, tabs: catalog.tabs.map(tab => ({ ...tab, regionIds: [] })) }
    : { ...catalog, locations: catalog.locations.map((location, index) => index !== 1 ? location : {
      ...location, ...(variant === 'zone' ? { zoneId: 'unconfirmed-other-zone' }
        : variant === 'resource' ? { workspaceId: 'project' } : { spaceId: 'unconfirmed-other-space' }) }) }
  const unconfirmed = moteWorkbenchProjection(broken, original, floating, vi.fn(), state.layouts)
  expect(unconfirmed.projection).toBeNull(); expect(unconfirmed.issueKind).toBe('location')
  expect(unconfirmed.catalog).toBe(broken); expect(unconfirmed.retainedTabId).toBe(original.id); expect(floating.reference).toBe(reference)
  const composed = projectWorkbenchProjection(state.layouts[reference.displayWorkspaceId], state.tabs, { ...resolved.projection!, catalog: broken })
  expect(composed.selection).toEqual([]); expect(composed.layout?.groups.find(group => group.id === reference.groupId)?.activeTabId).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[original.layout.activeRegionId]).toBe('Original edited draft')
})
