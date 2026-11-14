// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { openSystemUrlInSurvey } from '../src/renderer/src/lib/survey-system-url'
import { createSurveyBrowser } from '../src/renderer/src/lib/survey-browser-creation'

function fixture() {
  const original = { kind: 'browser', browserId: 'original-browser', profileId: 'ordinary-profile', url: 'https://original.example.test/', draft: 'Keep original draft' }
  const listeners = new Set<() => void>(), state: Record<string, any> = {
    config: { workspaces: [{ id: SCRATCH_WORKSPACE_ID }] }, layouts: { [SCRATCH_WORKSPACE_ID]: { activeGroupId: 'scratch-group' } },
    tabs: { original: { regions: { original } } }, mainSurface: 'workbench', surveyZoneSelection: null,
    surveyPageReferences: [],
    setSurveyZoneCollected: vi.fn(() => true),
    openLauncher: vi.fn(() => { state.tabs['new-tab'] = { id: 'new-tab', space: { zoneId: 'new-survey-zone' }, layout: { activeRegionId: 'new-region' }, regions: { 'new-region': { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'new-region' } } }; return 'new-tab' }),
    createBrowser: vi.fn(async (_group: string, location: { tabId: string; regionId: string }, url: string, _bookmark: unknown, workspaceId: string,
      _display: string, mode: string, _capsule: unknown, _profile: unknown, receipt: { onCreated(browser: unknown): void }) => {
      const browser = { id: location.regionId, profileId: 'ordinary-profile', mode, navigationId: 'original-native-navigation', url }
      receipt.onCreated(browser)
      state.tabs[location.tabId].regions[location.regionId] = { ...browser, kind: 'browser', regionId: location.regionId, browserId: location.regionId, workspaceId }
    }),
    registerSurveyBrowserPage: vi.fn(async (reference: { regionId: string; browserId: string }, _profile: string, onApplied: (pages: unknown[]) => void) => {
      state.surveyPageReferences = [...state.surveyPageReferences, reference]; onApplied(state.surveyPageReferences)
      return { outcome: 'registered', reference, save: null, issues: [] }
    }),
    setSurveyZoneSelection: vi.fn((value: unknown) => { state.surveyZoneSelection = value }),
    setMainSurface: vi.fn((value: string) => { state.mainSurface = value })
  }
  const get = () => state as never
  const ports = { get, prepareZone: vi.fn(() => ({ workspaceId: SCRATCH_WORKSPACE_ID, zoneId: 'new-survey-zone' }) as never), checkpointPreparation: vi.fn(async () => {}) }
  state.createSurveyBrowser = (input: Parameters<typeof createSurveyBrowser>[1]) => createSurveyBrowser(ports, input)
  let navigation = 'original-position'
  const host = { get, navigation: () => navigation, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  return { state, ports, original, host, listeners, move() { navigation = 'later-user-position'; state.mainSurface = 'workbench'; for (const listener of listeners) listener() } }
}
const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'original-system-event', operation: 'browser.openFromSystem', url: 'https://external.example.test/?query=original%20value#source' } as const

it('the system URL consumer uses the real Survey preparation and exact Scratch Browser creation without changing the original page', async () => {
  const f = fixture(), result = await openSystemUrlInSurvey(f.host, request, new AbortController().signal)
  expect(result).toMatchObject({ state: 'opened', browserId: 'new-region', reference: { displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'scratch-group', tabId: 'new-tab', regionId: 'new-region' } })
  expect(f.state.createBrowser).toHaveBeenCalledExactlyOnceWith('scratch-group', { tabId: 'new-tab', regionId: 'new-region' }, request.url, undefined, SCRATCH_WORKSPACE_ID, SCRATCH_WORKSPACE_ID, 'normal', undefined, undefined, expect.objectContaining({ onCreated: expect.any(Function) }))
  expect(f.state.surveyZoneSelection).toEqual({ kind: 'page', regionId: 'new-region', browserId: 'new-region' }); expect(f.state.mainSurface).toBe('survey')
  expect(f.ports.prepareZone).toHaveBeenCalledExactlyOnceWith(SCRATCH_WORKSPACE_ID); expect(f.ports.checkpointPreparation).toHaveBeenCalledOnce()
  expect(f.state.tabs.original.regions.original).toBe(f.original); expect(f.original.draft).toBe('Keep original draft'); expect(f.original.profileId).toBe('ordinary-profile')
  expect(f.listeners.size).toBe(0)
})
it('later user navigation wins even when the real preparation completes successfully', async () => {
  const f = fixture(); let finish!: () => void
  const attach = f.state.createBrowser.getMockImplementation()!
  f.state.createBrowser.mockImplementationOnce(async (...args: unknown[]) => { await new Promise<void>(resolve => { finish = resolve }); await attach(...args) })
  const result = openSystemUrlInSurvey(f.host, request, new AbortController().signal)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  f.move(); const selections = f.state.setSurveyZoneSelection.mock.calls.length, surfaces = f.state.setMainSurface.mock.calls.length
  finish(); expect(await result).toMatchObject({ state: 'opened' })
  expect(f.state.setSurveyZoneSelection).toHaveBeenCalledTimes(selections); expect(f.state.setMainSurface).toHaveBeenCalledTimes(surfaces)
  expect(f.state.mainSurface).toBe('workbench'); expect(f.listeners.size).toBe(0)
})
it('failed creation retains its original Survey reference and does not retry or replace the healthy original Browser', async () => {
  const f = fixture(); f.state.createBrowser.mockRejectedValueOnce(new Error('Original native create failed'))
  expect(await openSystemUrlInSurvey(f.host, request, new AbortController().signal)).toMatchObject({ state: 'unconfirmed', reference: { tabId: 'new-tab', regionId: 'new-region' }, message: expect.stringContaining('Original native create failed') })
  expect(f.state.createBrowser).toHaveBeenCalledTimes(1); expect(f.state.tabs['new-tab'].regions['new-region'].kind).toBe('launcher')
  expect(f.state.tabs.original.regions.original).toBe(f.original); expect(f.listeners.size).toBe(0)
})

it('keeps the exact known Survey Zone when creation fails before a Tab reference exists', async () => {
  const f = fixture(); f.state.openLauncher.mockReturnValueOnce(undefined)
  expect(await openSystemUrlInSurvey(f.host, request, new AbortController().signal)).toMatchObject({ state: 'unconfirmed', reference: null, message: expect.stringContaining('amux://zone/new-survey-zone') })
  expect(f.ports.prepareZone).toHaveBeenCalledTimes(1); expect(f.state.openLauncher).toHaveBeenCalledOnce(); expect(f.state.createBrowser).not.toHaveBeenCalled()
})
