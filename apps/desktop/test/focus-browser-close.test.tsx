// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNativePopover } from './fixtures/mote-workface'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { App } from '../src/renderer/src/App'

vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
const leaves = vi.hoisted(() => ({ unmounts: [] as string[] }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => {
  useEffect(() => () => { leaves.unmounts.push(sessionId) }, [sessionId])
  return createElement('p', { 'data-original-agent': sessionId }, 'Original Agent reading')
} }))
// Isolate native Browser painting; the original App/Workbench/selection, close
// request and Browser event transaction are the actual product consumers.
vi.mock('../src/renderer/src/components/BrowserPane', () => ({ BrowserPane: () => createElement('div', { 'data-native-browser-paint': '' }) }))
const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, session = composerSession('survivor')
let restorePopover: () => void
beforeEach(() => { restorePopover = installNativePopover(); leaves.unmounts = [] })
afterEach(() => restorePopover())
async function fixture(extra = false) {
  const browser = await api.browser.create('close-case', 'https://example.test/original', workspace.id)
  const makeBrowser = (regionId: string) => ({ ...browser, regionId, workspaceId: workspace.id, kind: 'browser' as const, browserId: browser.id })
  let tab = createWorkbenchTab('exact-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'agent-region', sessionId: session.id })
  tab = addWorkbenchRegion(tab, 'agent-region', 'right', makeBrowser('browser-region'))
  if (extra) tab = addWorkbenchRegion(tab, 'browser-region', 'down', makeBrowser('browser-copy'))
  const decoy = createWorkbenchTab('decoy-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'decoy-region', sessionId: session.id })
  const reference = { displayWorkspaceId: workspace.id, groupId: 'exact-group', tabId: tab.id, regionId: 'browser-region' }
  useAppStore.setState({ initialize: async () => () => {}, loading: false, sessions: [session], timelines: {},
    tabs: { [decoy.id]: decoy, [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('exact-group', [decoy.id, tab.id]) },
    scratchTopicSnapshots: {}, mainSurface: 'agents', activeWorkspaceId: workspace.id, workbenchSpaceSelection: null,
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [session.id]: 'Keep this original draft' } })
  useAppStore.getState().selectMainRegion(reference, null)
  await dom.render(<App />)
  expect(dom.container.querySelector('.focused-tab-workspace')).not.toBeNull()
  const original = dom.container.querySelector('[data-original-agent="survivor"]')!
  expect(original).not.toBeNull()
  const initial = useAppStore.getState(), publications: string[] = []
  const stop = useAppStore.subscribe(current => {
    const choice = current.workbenchSpaceSelection
    if (choice?.tabId && choice.regionId && !current.tabs[choice.tabId]?.regions[choice.regionId]) publications.push(choice.regionId)
  })
  return { browser, tab, reference, original, initial, publications, stop }
}

it.each(['event-first', 'response-first', 'event-then-error', 'duplicate', 'multiple-regions'] as const)('actual Focus keeps its original Agent after %s Browser closure', async order => {
  const h = await fixture(order === 'multiple-regions')
  try {
    vi.spyOn(api.browser, 'close').mockImplementation(async id => {
      expect(id).toBe(h.browser.id)
      if (order !== 'response-first') useAppStore.getState().applyBrowserEvent({ type: 'closed', id })
      if (order === 'event-then-error') throw new Error('Browser storage cleanup failed after confirmed closure')
    })
    await act(async () => useAppStore.getState().closeRegion(workspace.id, h.tab.id, 'browser-region'))
    if (order === 'response-first' || order === 'duplicate') await act(async () => useAppStore.getState().applyBrowserEvent({ type: 'closed', id: h.browser.id }))
    const after = useAppStore.getState()
    expect(h.publications).toEqual([])
    expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: workspace.id, groupId: 'exact-group', tabId: h.tab.id, regionId: 'agent-region' })
    expect(after.tabs[h.tab.id]!.layout.root).toEqual({ type: 'leaf', regionId: 'agent-region' })
    expect(Object.keys(after.tabs[h.tab.id]!.regions)).toEqual(['agent-region'])
    expect(dom.container.querySelector('.focus-location-recovery')).toBeNull()
    expect(dom.container.querySelector('[data-original-agent="survivor"]')).toBe(h.original)
    expect(leaves.unmounts).toEqual([])
    expect(after.sessions).toBe(h.initial.sessions); expect(after.sessions[0]!.control).toBe(session.control)
    expect(after.agentComposerDrafts).toBe(h.initial.agentComposerDrafts)
    if (order === 'event-then-error') expect(after.error).toContain('Browser storage cleanup failed')
  } finally { h.stop() }
})

it('a later exact main choice is preserved when the old Browser confirmation arrives', async () => {
  const h = await fixture()
  try {
    let release!: () => void
    vi.spyOn(api.browser, 'close').mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const closing = useAppStore.getState().closeRegion(workspace.id, h.tab.id, 'browser-region')
    await act(async () => useAppStore.getState().selectMainRegion({ ...h.reference, tabId: 'decoy-tab', regionId: 'decoy-region' }, useAppStore.getState().workbenchSpaceSelection))
    const later = useAppStore.getState().workbenchSpaceSelection
    await act(async () => { useAppStore.getState().applyBrowserEvent({ type: 'closed', id: h.browser.id }); release(); await closing })
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(later)
    expect(h.publications).toEqual([])
  } finally { h.stop() }
})

it.each(['unknown', 'released', 'unavailable'] as const)('%s Browser observation retains the original workface and main choice', async kind => {
  const h = await fixture()
  try {
    await act(async () => useAppStore.getState().applyBrowserEvent(kind === 'unknown' ? { type: 'closed', id: 'another-browser' }
      : kind === 'released' ? { type: 'released', id: h.browser.id, navigationId: h.browser.navigationId }
        : { type: 'unavailable', id: h.browser.id, error: 'Original connection unavailable' }))
    const after = useAppStore.getState()
    expect(after.workbenchSpaceSelection).toBe(h.initial.workbenchSpaceSelection)
    expect(after.tabs[h.tab.id]!.regions['browser-region']).toBeDefined()
    expect(after.tabs[h.tab.id]!.layout).toBe(h.initial.tabs[h.tab.id]!.layout)
    expect(dom.container.querySelector('.focus-location-recovery')).toBeNull()
    expect(dom.container.querySelector('[data-original-agent="survivor"]')).toBe(h.original)
    expect(h.publications).toEqual([])
  } finally { h.stop() }
})
