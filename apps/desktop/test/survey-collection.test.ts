// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { restoredSurveyCollection, surveyInitialZoneSelection, surveyZoneItems } from '../src/renderer/src/lib/survey-workface'

function catalog(): AgentMuxSpaceCatalog {
  const kinds: AgentMuxSpaceCatalog['regions'][number]['kind'][] = ['terminal', 'agent', 'launcher', 'file', 'browser']
  return {
    spaces: [], bindings: [],
    zones: kinds.map(kind => ({ zoneId: `zone-${kind}`, workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: '/project', branch: 'main' })),
    tabs: kinds.map(kind => ({ tabId: `tab-${kind}`, zoneId: `zone-${kind}`, workspaceId: 'resource', name: null, regionIds: [`region-${kind}`] })),
    regions: kinds.map(kind => ({ tabId: `tab-${kind}`, regionId: `region-${kind}`, kind, agentSessionId: null, runId: null, execution: null })),
    locations: kinds.map(kind => ({ spaceId: null, zoneId: `zone-${kind}`, workspaceId: 'resource', displayWorkspaceId: 'display', groupId: 'group', tabId: `tab-${kind}`, regionId: `region-${kind}` }))
  }
}

it('automatically discovers only actual Browser membership, without collecting occupied execution or File Zones', () => {
  const directory = catalog()
  expect(directory.regions.map(region => region.kind)).toEqual(['terminal', 'agent', 'launcher', 'file', 'browser'])
  expect(surveyZoneItems(directory, {}).map(zone => zone.zoneId)).toEqual(['zone-browser'])
})

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))

it('joins Browser facts to exact Tab and layout membership, then deduplicates the original Zone', () => {
  const directory = catalog(), browser = directory.regions[4]!
  directory.regions.push({ ...browser, tabId: 'tab-file', regionId: 'not-in-file-layout' })
  directory.tabs.push({ ...directory.tabs[4]!, tabId: 'second-browser', regionIds: ['second-page'] })
  directory.regions.push({ ...browser, tabId: 'second-browser', regionId: 'second-page' })
  directory.locations.push({ ...directory.locations[4]!, displayWorkspaceId: 'foreign-display', groupId: 'foreign-group' })
  expect(surveyZoneItems(directory, {}).map(zone => zone.zoneId)).toEqual(['zone-browser'])
})
it('retains only explicit members after the last Browser closes, without persisting discovery', () => {
  const directory = catalog(), collected = { 'zone-file': true } satisfies Record<string, true>
  expect(surveyZoneItems(directory, collected).map(zone => zone.zoneId)).toEqual(['zone-file', 'zone-browser'])
  directory.regions = directory.regions.filter(region => region.kind !== 'browser')
  expect(surveyZoneItems(directory, collected).map(zone => zone.zoneId)).toEqual(['zone-file'])
  expect(collected).toEqual({ 'zone-file': true })
})
it('restores exact display references without discovering, deleting unknown IDs or coercing malformed members', () => {
  expect(restoredSurveyCollection({ 'opaque-missing-zone': true, '': true, falseMember: false, stringMember: 'true' })).toEqual({ 'opaque-missing-zone': true })
  const ui = restorePersistedUiState(composerConfig, { workbenchSpaceSelection: null, surveyCollectedZones: { 'opaque-missing-zone': true } })
  expect(ui.surveyCollectedZones).toEqual({ 'opaque-missing-zone': true })
  expect(ui.surveyZoneSelection).toBeNull()
})
function originalStore() {
  const session = composerSession(), tab = createWorkbenchTab('pure-agent', { kind: 'agent', regionId: 'agent-region', phase: 'attached', workspaceId: 'workspace', sessionId: session.id })
  useAppStore.setState({ config: composerConfig, sessions: [session], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('g', [tab.id]) },
    spaceZoneBindings: {}, surveyCollectedZones: {}, surveyZoneSelection: null })
  const directory = spatialCatalog(useAppStore.getState(), [])
  return { session, tab, directory, zoneId: directory.tabs[0]!.zoneId! }
}
it('changes only explicit UI membership, with zero duplicate writes or resource, topology and Run changes', () => {
  const { directory, zoneId } = originalStore(), before = useAppStore.getState()
  expect(surveyZoneItems(directory, before.surveyCollectedZones)).toEqual([])
  expect(before.setSurveyZoneCollected(zoneId, true)).toBe(true)
  const collected = useAppStore.getState().surveyCollectedZones
  expect(collected).toEqual({ [zoneId]: true })
  expect(before.setSurveyZoneCollected(zoneId, true)).toBe(true)
  const current = useAppStore.getState()
  expect(current.surveyCollectedZones).toBe(collected)
  expect([current.tabs, current.layouts, current.sessions, current.config, current.spaceZoneBindings, current.surveyZoneSelection]).toEqual([before.tabs, before.layouts, before.sessions, before.config, before.spaceZoneBindings, before.surveyZoneSelection])
  expect(surveyZoneItems(directory, collected).map(zone => zone.zoneId)).toEqual([zoneId])
  expect(current.setSurveyZoneCollected(zoneId, false)).toBe(true)
  expect(useAppStore.getState().surveyCollectedZones).toEqual({})
})
it('keeps an arbitrary selected execution Zone outside the collection while preserving its accurate selection', () => {
  const { directory, zoneId } = originalStore(), state = useAppStore.getState()
  const selected = surveyInitialZoneSelection(directory, zoneId, state.layouts, state.tabs, 'workspace')
  state.setSurveyZoneSelection(selected)
  expect(selected.active).toEqual({ displayWorkspaceId: 'workspace', groupId: 'g', tabId: 'pure-agent', regionId: 'agent-region' })
  expect(useAppStore.getState().surveyCollectedZones).toEqual({})
  expect(surveyZoneItems(directory, useAppStore.getState().surveyCollectedZones)).toEqual([])
  expect(useAppStore.getState().surveyZoneSelection).toBe(selected)
})
it('does not mint an unknown explicit target or prune a confirmed reference when discovery is unavailable', () => {
  originalStore()
  expect(useAppStore.getState().setSurveyZoneCollected('missing-zone', true)).toBe(false)
  expect(useAppStore.getState().surveyCollectedZones).toEqual({})
  useAppStore.setState({ surveyCollectedZones: { 'missing-zone': true }, config: null })
  expect(useAppStore.getState().setSurveyZoneCollected('missing-zone', true)).toBe(true)
  expect(useAppStore.getState().surveyCollectedZones).toEqual({ 'missing-zone': true })
})
