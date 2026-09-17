// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, BrowserSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, documentKey, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const original = useAppStore.getState()
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }], executors: {},
  workspaces: [{ id: 'workspace-a', name: 'Private fixture', hostId: 'local', path: '/private/browser-recovery', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const browser: BrowserSnapshot = {
  id: 'browser-recovery', navigationId: 'actual-navigation', profileId: 'default', url: 'https://recovery.example/page',
  title: 'Recovery page', loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive',
  driving: false, appLinkPrompt: null, error: null
}
let root: Root | undefined
let container: HTMLDivElement
let dispose: (() => void) | undefined
let releaseGate: (() => void) | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState(original, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  releaseGate?.(); releaseGate = undefined
  if (root) await act(async () => { root!.unmount() })
  root = undefined
  dispose?.(); dispose = undefined
  container.remove()
  vi.restoreAllMocks()
  useAppStore.setState(original, true)
  vi.unstubAllGlobals()
})

function savedWorkbench() {
  const surface: BrowserWorkbenchSurface = { ...browser, kind: 'browser', regionId: 'browser-region', browserId: browser.id, workspaceId: 'workspace-a' }
  let tab = createWorkbenchTab('browser-durable-tab', surface)
  tab = addWorkbenchRegion(tab, surface.regionId, 'right', { kind: 'file', regionId: 'dirty-region', workspaceId: 'workspace-a', path: 'draft.md' })
  const layout = createWorkspaceLayout('browser-group', [tab.id])
  const key = documentKey('workspace-a', 'draft.md')
  useAppStore.setState({
    loading: true, tabs: {}, layouts: {}, activeWorkspaceId: 'workspace-a',
    restoredWorkbench: { tabs: { [tab.id]: tab }, layouts: { 'workspace-a': layout } },
    documents: { [key]: { path: 'draft.md', content: 'Unsaved sibling body', revision: 'disk-revision' } }, dirtyDocuments: { [key]: true }
  })
  return { tab, layout, key }
}

function currentSurface(): BrowserWorkbenchSurface {
  const surface = useAppStore.getState().tabs['browser-durable-tab']?.regions['browser-region']
  expect(surface?.kind).toBe('browser')
  return surface as BrowserWorkbenchSurface
}

async function renderPane() {
  function ActualPane() {
    const surface = useAppStore(state => state.tabs['browser-durable-tab']?.regions['browser-region'])
    return surface?.kind === 'browser' ? <BrowserPane tab={surface} visible /> : null
  }
  root = createRoot(container)
  await act(async () => { root!.render(<ActualPane />) })
}

async function clickRetry() {
  const buttons = [...container.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'Retry')
  expect(buttons).toHaveLength(1)
  await act(async () => { buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('Browser durable recovery', () => {
  it('keeps the actual restored split and dirty sibling on startup failure, then actual Retry obtains the same identity', async () => {
    const saved = savedWorkbench()
    const create = vi.spyOn(api.browser, 'create').mockRejectedValueOnce(new Error('Native owner handshake failed')).mockResolvedValue(browser)
    const reload = vi.spyOn(api.browser, 'reload').mockResolvedValue(browser)
    dispose = await useAppStore.getState().initialize()
    const state = useAppStore.getState()
    expect(Object.keys(state.tabs)).toEqual([saved.tab.id])
    expect(Object.keys(state.tabs[saved.tab.id]!.regions)).toEqual(['browser-region', 'dirty-region'])
    expect(state.tabs[saved.tab.id]!.layout).toEqual(saved.tab.layout)
    expect(state.layouts['workspace-a']).toEqual(saved.layout)
    expect(state.documents[saved.key]?.content).toBe('Unsaved sibling body')
    expect(state.dirtyDocuments[saved.key]).toBe(true)
    expect(currentSurface()).toMatchObject({ browserId: browser.id, url: browser.url, error: expect.stringContaining('Browser recovery failed: Native owner handshake failed') })
    expect(state.error).toContain('Their Regions were retained')
    await renderPane()
    expect(container.textContent).toContain('Retry to reopen this page')
    await clickRetry()
    expect(create.mock.calls).toEqual([[browser.id, browser.url], [browser.id, browser.url]])
    expect(reload).not.toHaveBeenCalled()
    expect(currentSurface()).toMatchObject({ id: browser.id, navigationId: browser.navigationId, error: null })
    expect(container.textContent).not.toContain('Native owner handshake failed')
    expect(useAppStore.getState().documents[saved.key]?.content).toBe('Unsaved sibling body')
  })

  it('Retry reloads an actually existing navigation failure after ensuring its owner', async () => {
    const saved = savedWorkbench()
    vi.spyOn(api.browser, 'create').mockResolvedValue({ ...browser, error: 'Page navigation failed' })
    const reload = vi.spyOn(api.browser, 'reload').mockResolvedValue(browser)
    dispose = await useAppStore.getState().initialize()
    await renderPane()
    await clickRetry()
    expect(reload.mock.calls).toEqual([[browser.id]])
    expect(currentSurface().error).toBeNull()
    expect(Object.keys(useAppStore.getState().tabs[saved.tab.id]!.regions)).toEqual(['browser-region', 'dirty-region'])
  })

  it('a failed Retry remains visibly retryable and does not remove the restored Region', async () => {
    savedWorkbench()
    const create = vi.spyOn(api.browser, 'create').mockRejectedValue(new Error('Still unavailable'))
    dispose = await useAppStore.getState().initialize()
    await renderPane()
    await clickRetry()
    expect(create).toHaveBeenCalledTimes(2)
    expect(currentSurface().error).toContain('Still unavailable')
    expect(container.textContent).toContain('Retry')
    expect(useAppStore.getState().error).toContain('Still unavailable')
  })

  it('late startup failure cannot recreate a Browser explicitly closed while the handshake was pending', async () => {
    const saved = savedWorkbench()
    let reject!: (error: Error) => void
    vi.spyOn(api.browser, 'create').mockImplementation(() => new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise; releaseGate = () => rejectPromise(new Error('Fixture cleanup'))
    }))
    const initialized = useAppStore.getState().initialize()
    await vi.waitFor(() => { expect(typeof reject).toBe('function') })
    useAppStore.getState().applyBrowserEvent({ type: 'closed', id: browser.id })
    reject(new Error('Late handshake failure'))
    dispose = await initialized
    expect(Object.keys(useAppStore.getState().tabs[saved.tab.id]!.regions)).toEqual(['dirty-region'])
    expect(useAppStore.getState().documents[saved.key]?.content).toBe('Unsaved sibling body')
  })
})
