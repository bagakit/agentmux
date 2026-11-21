import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, checkpointSpatialWorkbench } from '../../../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopUserFragments } from '../../../src/renderer/src/lib/desktop-user-state'
import { startWorkfaceFixture } from '../../../test/helpers/workface-control-fixture'

const initial = useAppStore.getState()
let fixture: Awaited<ReturnType<typeof startWorkfaceFixture>>
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(initial, true)
  fixture = await startWorkfaceFixture()
  useAppStore.setState({ surveyPageReferences: [], surveyPageReadRecovery: null, surveyCollectedZones: {}, surveyProfileView: { kind: 'default' } })
})
afterEach(async () => {
  await fixture?.stop(); if (fixture) await rm(fixture.directory, { recursive: true, force: true })
  vi.restoreAllMocks(); useAppStore.setState(initial, true)
})

it('survey-opening boundary: the actual Store prepares and persists its original page without starting generic Zone saving or unrelated fragment aggregation', async () => {
  const generic = vi.spyOn(useAppStore.getState(), 'createWorkbenchZone')
  const fragments = vi.spyOn(desktopUserFragments, 'checkpoint')
  const topics = vi.mocked(api.scratch.listTopics); topics.mockClear()
  const native = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => ({
    id, url, title: 'Original prepared page', mode: 'normal', profileId: '11111111-1111-4111-8111-111111111111',
      navigationId: id + '-navigation', canGoBack: false, canGoForward: false, loading: true,
    viewport: 'responsive', error: null, driving: false, appLinkPrompt: null
  }))
  const result = await useAppStore.getState().createSurveyBrowser({ workspaceId: 'resource', url: 'https://opening.example.test/original',
    preparation: null, onPrepared() {} })
  expect(generic).not.toHaveBeenCalled()
  expect(fragments).not.toHaveBeenCalled()
  expect(topics).not.toHaveBeenCalled()
  expect(native).toHaveBeenCalledTimes(1)
  expect(result.admission?.outcome).toBe('registered')
  const graph = (await api.spatial.read())!.graph
  expect(graph.regions.find(region => region.regionId === result.reference.regionId)).toMatchObject({ kind: 'browser', tabId: result.reference.tabId })
  expect(graph.tabs.find(tab => tab.tabId === result.reference.tabId)?.zoneId).toBe(result.zone.zoneId)
  expect(useAppStore.getState().surveyPageReferences).toEqual([{ regionId: result.reference.regionId, browserId: result.createdBrowser!.id }])
  fixture.noLifecycle()
})

it('survey-opening boundary: original URL presentation does not start unrelated fragment saving when it selects the prepared page', async () => {
  const before = useAppStore.getState(), workspace = { ...before.config!.workspaces[0]!, id: SCRATCH_WORKSPACE_ID,
    name: 'Private opening Scratch', path: fixture.directory + '/scratch' }
  useAppStore.setState({ config: { ...before.config!, workspaces: [...before.config!.workspaces, workspace] },
    layouts: { ...before.layouts, [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('opening-group') } })
  await checkpointSpatialWorkbench()
  const fragments = vi.spyOn(desktopUserFragments, 'checkpoint'), generic = vi.spyOn(useAppStore.getState(), 'createWorkbenchZone')
  vi.spyOn(api.browser, 'create').mockImplementation(async (id, url) => ({ id, url, title: 'Original external page', mode: 'normal',
    profileId: '11111111-1111-4111-8111-111111111111', navigationId: id + '-navigation', canGoBack: false, canGoForward: false,
    loading: true, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null }))
  const result = await useAppStore.getState().openUrlInSurvey('https://opening.example.test/external')
  expect(result.state).toBe('opened')
  expect(useAppStore.getState().mainSurface).toBe('survey')
  expect(useAppStore.getState().surveyZoneSelection).toMatchObject({ kind: 'page', browserId: result.browserId })
  expect(generic).not.toHaveBeenCalled()
  expect(fragments).not.toHaveBeenCalled()
  fixture.noLifecycle()
})
