// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { workbenchRegionBounds } from '@agentmux/layout'
import type { AgentMuxControlRequest } from '@agentmux/core/control'
import type { CapsuleInspection } from '@agentmux/core/capsule'
import type { BrowserViewManager } from '../src/main/browser-view-manager'
import { createCapsuleBrowserDocument } from '../src/main/capsule-presentation'
import { api } from '../src/renderer/src/lib/api'
import { zoneContext } from '../src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { FileOpenResult } from '../src/renderer/src/lib/file-workbench-state'
import { useAppStore } from '../src/renderer/src/store'
import { fileTopics, startWorkfaceFileFixture, zoneFor } from './helpers/workface-file-fixture'
import { regionIdC, tabId } from './helpers/workface-control-fixture'

const initial = useAppStore.getState(), capsuleId = '23456789ABCD', uri = `amux://capsule/${capsuleId}`
const endpoint = 'http://127.0.0.1:49152/'
let fixture: Awaited<ReturnType<typeof startWorkfaceFileFixture>>
let create: ReturnType<typeof vi.spyOn>, nativeCreate: ReturnType<typeof vi.fn>
const capsule: CapsuleInspection = {
  record: { capsuleId, title: 'Original published page', revision: 1, storageMode: 'managed',
    contentRoot: '/private/capsule-bookmark-fixture', entry: 'index.html', routing: 'file', mode: 'injected', theme: 'follow',
    port: 49152, createdAt: 1, updatedAt: 1, caller: { hostId: 'local' } },
  endpoint: { status: 'available', url: endpoint, port: 49152, instanceId: 'original-service', observedAt: 1 },
  content: { status: 'available', observedAt: 1 }, issues: []
}

beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(initial, true)
  fixture = await startWorkfaceFileFixture()
  vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url: uri, binary: false })
  vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
  const browserPort = api.browser.create.bind(api.browser)
  // Only the native document port is controlled. The Store and original Main Capsule
  // acquisition helper consume the actual bookmark, placement and published identity.
  nativeCreate = vi.fn(async (...args: Parameters<BrowserViewManager['create']>) => {
    const [id, url, workspaceId, profile, mode, viewport, saved] = args
    const browser = await browserPort(id, url, workspaceId, profile, mode, viewport)
    return { ...browser, ...(saved?.capsule ? { capsuleId: saved.capsule.record.capsuleId,
      capsuleOrigin: saved.capsuleOrigin!, objectLink: uri, capsuleActive: false } : {}) }
  })
  create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, url, workspaceId, profile, mode, viewport, originalCapsuleId) => {
    if (!originalCapsuleId) return await nativeCreate(id, url, workspaceId, profile, mode, viewport)
    return await createCapsuleBrowserDocument({ inspect: async original => { expect(original).toBe(capsuleId); return capsule },
      browsers: { create: nativeCreate as BrowserViewManager['create'] } }, {
      id, url, workspaceId, capsuleId: originalCapsuleId,
      ...(profile === undefined ? {} : { rememberedProfileId: profile }),
      ...(mode === undefined ? {} : { mode }), ...(viewport === undefined ? {} : { viewport })
    })
  })
})
afterEach(async () => {
  await fixture?.stop()
  if (fixture) await rm(fixture.directory, { recursive: true, force: true })
  vi.restoreAllMocks(); useAppStore.setState(initial, true)
})

function selection() {
  const state = useAppStore.getState()
  return { activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface, agentFocus: state.agentFocus,
    selection: state.workbenchSpaceSelection, retained: state.retainedSpatialFocus, caret: state.regionCaretFocus,
    policy: state.workbenchNavigationInputPolicy, drafts: state.agentComposerDrafts, sessions: state.sessions }
}
async function open(path: string, extra: Partial<Extract<AgentMuxControlRequest, { operation: 'open.file' }>> = {}) {
  const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'open.file',
    zoneId: zoneFor('resource').zoneId, path, focus: false, ...extra }, undefined, { fileOpenIntent: 'default' })
  expect(result.operation).toBe('open.file')
  if (result.operation !== 'open.file') throw new Error('The original File operation is required')
  return result
}
function assertCapsuleDocument(regionId: string) {
  expect(create).toHaveBeenCalledExactlyOnceWith(regionId, uri, 'resource', undefined, undefined, undefined, capsuleId)
  expect(nativeCreate).toHaveBeenCalledExactlyOnceWith(regionId, endpoint, 'resource', undefined, 'normal', undefined,
    { capsule, capsuleOrigin: 'http://127.0.0.1:49152' })
  expect(api.ui.openObjectLink).not.toHaveBeenCalled()
  expect(api.files.read).not.toHaveBeenCalled()
  fixture.noLifecycle()
}

it('opens a background Capsule bookmark with its original identity and same-call Browser placement rather than a directory refusal', async () => {
  const before = selection(), layouts = useAppStore.getState().layouts, tabs = useAppStore.getState().tabs
  const result = await open('Original.webloc')
  expect(result).toMatchObject({ data: { kind: 'not-file', reason: null }, navigation: 'background', outcome: 'opened',
    placement: { status: 'created' }, changed: true, issues: [] })
  expect(result.placement.locations).toEqual([expect.objectContaining({ displayWorkspaceId: 'resource', groupId: 'resource-group',
    tabId: result.placement.tabId, regionId: result.placement.regionId })])
  const page = useAppStore.getState().tabs[result.placement.tabId!]!.regions[result.placement.regionId!]
  expect(page).toMatchObject({ kind: 'browser', browserId: result.placement.regionId, capsuleId, objectLink: uri, url: endpoint,
    bookmarkOrigin: { path: 'Original.webloc', binary: false } })
  expect(selection()).toEqual(before)
  for (const [id, tab] of Object.entries(tabs)) expect(useAppStore.getState().tabs[id]).toBe(tab)
  expect(useAppStore.getState().layouts.resource!.groups[0]!.activeTabId).toBe(layouts.resource!.groups[0]!.activeTabId)
  assertCapsuleDocument(result.placement.regionId!)
})

it('opens a Capsule bookmark in the exact background split and preserves every original sibling and selection', async () => {
  const before = selection(), original = useAppStore.getState().tabs[tabId]!, layouts = useAppStore.getState().layouts
  const result = await open('Split.webloc', { displayWorkspaceId: 'display', groupId: 'display-group', tabId, regionId: regionIdC, split: 'down' })
  expect(result).toMatchObject({ navigation: 'background', outcome: 'opened', placement: { status: 'created', tabId }, data: { kind: 'not-file', reason: null }, issues: [] })
  expect(result.placement.locations).toEqual(expect.arrayContaining([expect.objectContaining({ displayWorkspaceId: 'display', groupId: 'display-group',
    tabId, regionId: result.placement.regionId })]))
  const after = useAppStore.getState(), tab = after.tabs[tabId]!, cells = workbenchRegionBounds(tab.layout.root)
  const anchor = cells.find(cell => cell.regionId === regionIdC)!.bounds, page = cells.find(cell => cell.regionId === result.placement.regionId)!.bounds
  expect(page).toMatchObject({ x: anchor.x, width: anchor.width, height: anchor.height, y: anchor.y + anchor.height })
  for (const [id, surface] of Object.entries(original.regions)) expect(tab.regions[id]).toBe(surface)
  expect(tab.layout.activeRegionId).toBe(original.layout.activeRegionId)
  expect(after.layouts).toEqual(layouts); expect(selection()).toEqual(before)
  assertCapsuleDocument(result.placement.regionId!)
})

it('consumes only the exact Capsule bookmark launcher and confirms its same-call background result', async () => {
  const zone = zoneFor('resource'), space = { zoneId: zone.zoneId, spaceId: zoneContext(useAppStore.getState(), fileTopics, zone) }
  const launcher = { ...createWorkbenchTab('original-bookmark-launcher', { kind: 'launcher', regionId: 'original-bookmark-region', workspaceId: 'resource' }), space }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [launcher.id]: launcher }, layouts: { ...state.layouts,
    resource: { ...state.layouts.resource!, groups: state.layouts.resource!.groups.map(group => group.id === 'resource-group'
      ? { ...group, tabOrder: [...group.tabOrder, launcher.id] } : group) } } }))
  const before = selection(), tabIds = Object.keys(useAppStore.getState().tabs), layouts = useAppStore.getState().layouts
  let result: FileOpenResult | undefined
  await useAppStore.getState().openFile('Launcher.webloc', 'resource-group', undefined, 'resource', false, {
    displayWorkspaceId: 'resource', space, resource: { hostId: 'local', path: useAppStore.getState().config!.workspaces.find(item => item.id === 'resource')!.path },
    focus: false, launcher: { tabId: launcher.id, regionId: launcher.layout.activeRegionId }, onResult: value => { result = value }
  })
  expect(result).toEqual({ placement: { status: 'reused', tabId: launcher.id, regionId: launcher.layout.activeRegionId },
    data: { kind: 'not-file', reason: null }, navigation: 'background' })
  expect(useAppStore.getState().tabs[launcher.id]!.regions[launcher.layout.activeRegionId]).toMatchObject({ kind: 'browser', capsuleId, objectLink: uri, url: endpoint })
  expect(Object.keys(useAppStore.getState().tabs)).toEqual(tabIds)
  expect(useAppStore.getState().layouts).toEqual(layouts); expect(selection()).toEqual(before)
  assertCapsuleDocument(launcher.layout.activeRegionId)
})
