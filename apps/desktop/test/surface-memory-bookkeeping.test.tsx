// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, type RefObject } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { RendererResourceOwners } from '../src/renderer/src/components/RendererResourceOwners'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../src/renderer/src/store'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { createWorkbenchTab, documentKey, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig } from './helpers/composer-dom-fixture'

// Capture the original owner refs; no production export or substitute bookkeeping algorithm.
const captured = vi.hoisted(() => new Set<RefObject<unknown>>())
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useRef: <T,>(initial: T) => {
    const ref = actual.useRef(initial)
    if (initial instanceof Map) captured.add(ref)
    return ref
  } }
})
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Only native leaf rendering is controlled. ResourceOwners, hook, Provider and Workbench stay real.
vi.mock('../src/renderer/src/components/BrowserPane', () => ({
  BrowserPane: ({ tab, released }: { tab: { regionId: string }; released: boolean }) =>
    <output data-budget-region={tab.regionId} data-released={String(released)} />
}))
vi.mock('../src/renderer/src/components/FileSurfaceView', () => ({
  FileSurfaceView: ({ surface, released }: { surface: { regionId: string }; released: boolean }) =>
    <output data-budget-region={surface.regionId} data-released={String(released)} />
}))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/NewTabSurface', () => ({ NewTabSurface: () => null }))

type RecordFacts = { hiddenSinceMs: number | null; lastActivatedSeq: number; navigationContextActive: boolean }
let container: HTMLDivElement, root: Root, records: Map<string, RecordFacts> | undefined
const initial = useAppStore.getState()
const workspaceId = 'workspace'
function file(id: string): WorkbenchTab {
  return createWorkbenchTab(id, { regionId: 'region:' + id, kind: 'file', workspaceId, path: 'src/' + id + '.ts' })
}
function browser(id: string): WorkbenchTab {
  return createWorkbenchTab(id, { regionId: 'region:' + id, kind: 'browser', workspaceId,
    id: 'browser:' + id, browserId: 'browser:' + id, navigationId: 'navigation:' + id, profileId: 'default',
    url: 'https://example.test/' + id, title: id, loading: false, driving: false,
    appLinkPrompt: null, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null })
}
async function project(tabs: WorkbenchTab[], active = tabs[0]?.id) {
  const layout = createWorkspaceLayout('group', tabs.map(tab => tab.id))
  layout.groups[0]!.activeTabId = active ?? null
  await act(async () => useAppStore.setState({
    tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])), layouts: { [workspaceId]: layout },
    documents: Object.fromEntries(tabs.flatMap(tab => Object.values(tab.regions).flatMap(surface =>
      surface.kind === 'file' ? [[documentKey(workspaceId, surface.path), { path: surface.path, content: 'original', revision: 'rev' }]] : [])))
  }))
}
async function render(measurementActive = false, workbenchVisible = true) {
  await act(async () => root.render(<RendererResourceOwners measurementActive={measurementActive} workbenchVisible={workbenchVisible}>
    <WorkspaceWorkbench workspaceId={workspaceId} visible={workbenchVisible} />
  </RendererResourceOwners>))
  if (!records) {
    const refs = [...captured].map(ref => ref.current).filter((value): value is Map<string, RecordFacts> =>
      value instanceof Map && [...value.values()].some(facts => facts && typeof facts === 'object' &&
        'lastActivatedSeq' in facts && 'navigationContextActive' in facts && 'hiddenSinceMs' in facts))
    expect(refs).toHaveLength(1)
    records = refs[0]!
  }
}
function ledger() { expect(records).toBeDefined(); return records! }
function released(id: string) {
  const leaf = container.querySelector<HTMLOutputElement>('[data-budget-region="region:' + id + '"]')
  expect(leaf, 'Actual Workbench leaf must consume released for ' + id).not.toBeNull()
  return leaf!.dataset.released === 'true'
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(rendererPerformance, 'observeMainThread').mockImplementation(() => () => {})
  captured.clear(); records = undefined
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container)
  useAppStore.setState({ config: composerConfig, sessions: [], tabs: {}, layouts: {}, documents: {},
    dirtyDocuments: {}, savingDocuments: {}, activeWorkspaceId: workspaceId, mainSurface: 'workbench',
    workbenchNavigationInputPolicy: null, retainedSpatialFocus: null })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

it('actual ResourceOwners → Workbench retires visible Region records across repeated churn without clearing the survivor', async () => {
  const survivor = file('survivor')
  await project([browser('current-0'), survivor])
  await render()
  const survivorRecord = ledger().get('region:survivor')!
  expect(survivorRecord).toEqual({ hiddenSinceMs: 1000, lastActivatedSeq: 0, navigationContextActive: true })
  for (let index = 1; index <= 32; index++) {
    const current = index % 2 ? file('current-' + index) : browser('current-' + index)
    await project([current, survivor])
    expect([...ledger().keys()].sort()).toEqual(['region:current-' + index, 'region:survivor'].sort())
    expect(ledger().get('region:survivor')).toBe(survivorRecord)
    expect(ledger().get('region:current-' + index)).toMatchObject({ hiddenSinceMs: null, lastActivatedSeq: index + 1 })
    expect(released('current-' + index)).toBe(false)
  }
})

it('hidden removal deletes the entire record while existing visible and hidden facts retain identity', async () => {
  const active = file('active'), hidden = browser('hidden'), survivor = file('survivor')
  await project([active, hidden, survivor]); await render()
  const visibleRecord = ledger().get('region:active'), hiddenRecord = ledger().get('region:survivor')
  await project([active, survivor])
  expect([...ledger().keys()].sort()).toEqual(['region:active', 'region:survivor'])
  expect(ledger().get('region:active')).toBe(visibleRecord)
  expect(ledger().get('region:survivor')).toBe(hiddenRecord)
  expect(released('active')).toBe(false)
})

it('activation sequence and return to an inactive navigation context keep their original hidden-time semantics', async () => {
  const a = file('a'), b = browser('b')
  await project([a, b]); await render()
  const aRecord = ledger().get('region:a')!, bRecord = ledger().get('region:b')!
  await advance(1000); await project([a, b], b.id)
  expect(aRecord).toEqual({ hiddenSinceMs: 2000, lastActivatedSeq: 1, navigationContextActive: true })
  expect(bRecord).toEqual({ hiddenSinceMs: null, lastActivatedSeq: 2, navigationContextActive: true })
  await act(async () => useAppStore.setState({ activeWorkspaceId: 'other' }))
  await advance(1000)
  expect(bRecord.navigationContextActive).toBe(false)
  expect(bRecord.hiddenSinceMs).toBe(2000)
  await act(async () => useAppStore.setState({ activeWorkspaceId: workspaceId }))
  expect(aRecord).toEqual({ hiddenSinceMs: 3000, lastActivatedSeq: 1, navigationContextActive: true })
  expect(bRecord).toEqual({ hiddenSinceMs: null, lastActivatedSeq: 3, navigationContextActive: true })
  expect(released('a')).toBe(false)
})

it('the actual Workbench receives independent 60s/90s hot limits and five-minute release', async () => {
  const tabs = [file('active'), ...Array.from({ length: 6 }, (_, n) => file('m' + n)),
    ...Array.from({ length: 5 }, (_, n) => browser('b' + n))]
  await project(tabs); await render()
  await advance(60_000)
  expect(released('m4')).toBe(true); expect(released('m3')).toBe(false)
  expect(released('b4')).toBe(false); expect(released('active')).toBe(false)
  await advance(30_000)
  expect(released('b3')).toBe(true); expect(released('b2')).toBe(false)
  await advance(210_000)
  for (const tab of tabs.slice(1)) expect(released(tab.id)).toBe(true)
  expect(released('active')).toBe(false)
})

it('dirty, saving, missing rebuild inputs and measurement still protect the original surfaces', async () => {
  const tabs = [file('active'), file('dirty'), file('saving'), file('missing'), browser('loading'), browser('clear')]
  await project(tabs)
  await act(async () => useAppStore.setState(state => {
    const documents = { ...state.documents }; delete documents[documentKey(workspaceId, 'src/missing.ts')]
    const loading = tabs.find(tab => tab.id === 'loading')!
    return { documents, dirtyDocuments: { [documentKey(workspaceId, 'src/dirty.ts')]: true },
      savingDocuments: { [documentKey(workspaceId, 'src/saving.ts')]: true },
      tabs: { ...state.tabs, loading: { ...loading, regions: Object.fromEntries(Object.entries(loading.regions).map(([id, surface]) =>
        [id, surface.kind === 'browser' ? { ...surface, loading: true } : surface])) } } }
  }))
  await render(true)
  await advance(300_000)
  expect(released('clear')).toBe(false)
  await render(false)
  // The original one-deadline scheduler resumes at the first eligible Browser deadline.
  await advance(90_000)
  expect(released('clear')).toBe(true)
  for (const id of ['active', 'dirty', 'saving', 'missing', 'loading']) expect(released(id)).toBe(false)
  expect(useAppStore.getState().documents[documentKey(workspaceId, 'src/dirty.ts')]!.content).toBe('original')
})
