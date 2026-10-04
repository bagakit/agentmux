// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { openSessionFileLink } from '../src/renderer/src/lib/session-link-opening'
import { createSessionProjectFileContextSelector } from '../src/renderer/src/lib/session-project-file-context'
import { mainRegionReference } from '../src/renderer/src/lib/desktop-focus-navigation'
import { useAppStore } from '../src/renderer/src/store'
import { startWorkfaceFileFixture } from './helpers/workface-file-fixture'
import { regionIdA, regionIdB, targetSid, tabId } from './helpers/workface-control-fixture'
const initial = useAppStore.getState()
const origin = { workspaceId: 'display', tabGroupId: 'display-group', tabId, regionId: regionIdA, sessionId: targetSid }
const reference = { displayWorkspaceId: origin.workspaceId, groupId: origin.tabGroupId, tabId, regionId: regionIdA }
let fixture: Awaited<ReturnType<typeof startWorkfaceFileFixture>>
beforeEach(async () => {
  useAppStore.setState(initial, true); localStorage.clear(); fixture = await startWorkfaceFileFixture()
  useAppStore.setState({ mainSurface: 'agents', agentFocus: { execution: { sessionId: targetSid, reference, history: [{ sessionId: targetSid, focusedAt: 1 }] }, pmo: { sessionId: null } } })
  expect(useAppStore.getState().selectMainRegion(reference)).toBe(true)
})
afterEach(async () => { await fixture.stop(); useAppStore.setState(initial, true); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('a pending original Focus File consumes the exact main owner, while floating sibling input is only local', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  vi.spyOn(api.files, 'read').mockImplementation(() => new Promise(accept => { resolve = accept }))
  const before = useAppStore.getState(), execution = before.agentFocus.execution
  const context = createSessionProjectFileContextSelector(targetSid, origin)(before)
  const opening = openSessionFileLink(origin, context, 'pending-main.md', undefined, 'right')
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  useAppStore.getState().focusRegion('display', tabId, regionIdB, 'floating-pointer', 'display-group')
  expect(mainRegionReference(useAppStore.getState().workbenchSpaceSelection)).toEqual(reference)
  expect(useAppStore.getState().agentFocus.execution).toBe(execution)
  resolve({ status: 'read', document: { path: 'pending-main.md', content: '# Retained File', revision: 'private-v1' } })
  await opening
  const after = useAppStore.getState(), file = Object.values(after.tabs[tabId]!.regions).find(region => region.kind === 'file' && region.path === 'pending-main.md')!
  expect(file.kind).toBe('file')
  expect(mainRegionReference(after.workbenchSpaceSelection)).toEqual({ ...reference, regionId: file.regionId })
  expect(after.agentFocus.execution).toBe(execution)
  expect(after.mainSurface).toBe('agents'); fixture.noLifecycle()
})
it('an older File reply preserves a later same-SID exact Region choice', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  vi.spyOn(api.files, 'read').mockImplementation(() => new Promise(accept => { resolve = accept }))
  const before = useAppStore.getState(), context = createSessionProjectFileContextSelector(targetSid, origin)(before)
  const outcome = openSessionFileLink(origin, context, 'late-main.md', undefined, 'right').catch(error => error)
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  const later = { ...reference, regionId: regionIdB }
  expect(useAppStore.getState().selectMainRegion(later, before.workbenchSpaceSelection)).toBe(true)
  resolve({ status: 'read', document: { path: 'late-main.md', content: '# Late readable bytes', revision: 'private-v1' } })
  expect(await outcome).toBeInstanceOf(Error)
  expect(mainRegionReference(useAppStore.getState().workbenchSpaceSelection)).toEqual(later)
  expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
  fixture.noLifecycle()
})

it('a new Browser Tab uses the exact display Group and common owner without changing execution MRU', async () => {
  const before = useAppStore.getState(), execution = before.agentFocus.execution
  await before.openHttpLink(origin, 'https://example.org/continuity', 'tab')
  const after = useAppStore.getState(), chosen = mainRegionReference(after.workbenchSpaceSelection)!
  expect(chosen.displayWorkspaceId).toBe(origin.workspaceId)
  expect(chosen.groupId).toBe(origin.tabGroupId)
  expect(chosen.tabId).not.toBe(tabId)
  expect(after.tabs[chosen.tabId]!.regions[chosen.regionId]!.kind).toBe('browser')
  expect(after.tabs[chosen.tabId]!.workspaceId).toBe(before.tabs[tabId]!.workspaceId)
  expect(after.agentFocus.execution).toBe(execution)
  for (const surface of ['agents', 'survey', 'board', 'workbench'] as const) after.setMainSurface(surface)
  expect(mainRegionReference(useAppStore.getState().workbenchSpaceSelection)).toEqual(chosen)
  fixture.noLifecycle()
})
it('a late Browser attachment retains a newer same-Tab main Region choice', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.browser.create>>) => void
  vi.spyOn(api.browser, 'create').mockImplementation(() => new Promise(accept => { resolve = accept }))
  const before = useAppStore.getState()
  const opening = before.openHttpLink(origin, 'https://example.org/late-continuity', 'right')
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  const later = { ...reference, regionId: regionIdB }
  expect(useAppStore.getState().selectMainRegion(later, before.workbenchSpaceSelection)).toBe(true)
  resolve({ id: 'private-browser', navigationId: 'private-navigation', profileId: 'private-profile', url: 'https://example.org/late-continuity', title: 'Late browser', loading: false,
    canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null })
  await opening
  expect(mainRegionReference(useAppStore.getState().workbenchSpaceSelection)).toEqual(later)
  expect(useAppStore.getState().agentFocus.execution).toBe(before.agentFocus.execution)
  fixture.noLifecycle()
})
it('a failed new Browser Tab reclaims only its own pending main mark and retains the original File/Agent workface', async () => {
  const before = useAppStore.getState(), choice = before.workbenchSpaceSelection, execution = before.agentFocus.execution
  vi.spyOn(api.browser, 'create').mockRejectedValue(new Error('Private Browser creation unavailable'))
  await expect(before.openHttpLink(origin, 'https://example.org/unavailable', 'tab')).rejects.toThrow('unavailable')
  const after = useAppStore.getState()
  expect(after.workbenchSpaceSelection).toEqual(choice)
  expect(after.agentFocus.execution).toBe(execution)
  expect(Object.keys(after.tabs)).toEqual(Object.keys(before.tabs))
  expect(mainRegionReference(after.workbenchSpaceSelection)).toEqual(reference)
  fixture.noLifecycle()
})
it('a failed older Browser Tab preserves a newer exact main Region selection', async () => {
  let reject!: (error: Error) => void
  vi.spyOn(api.browser, 'create').mockImplementation(() => new Promise((_accept, fail) => { reject = fail }))
  const before = useAppStore.getState(), opening = before.openHttpLink(origin, 'https://example.org/old-unavailable', 'tab').catch(error => error)
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
  const later = { ...reference, regionId: regionIdB }
  expect(useAppStore.getState().selectMainRegion(later)).toBe(true)
  const execution = useAppStore.getState().agentFocus.execution
  reject(new Error('Private older Browser creation unavailable'))
  expect(await opening).toBeInstanceOf(Error)
  expect(mainRegionReference(useAppStore.getState().workbenchSpaceSelection)).toEqual(later)
  expect(useAppStore.getState().agentFocus.execution).toBe(execution)
  fixture.noLifecycle()
})
