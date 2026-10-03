import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { WorkbenchBrowserPresentation } from '../src/renderer/src/components/BrowserPresentationStage'
import { installDesktopPresentationOwner, readDesktopPresentation } from '../src/renderer/src/lib/desktop-presentation'
import { workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'

async function settle() { await act(async () => { await new Promise(done => setTimeout(done, 15)) }) }

it.each(['error', 'blank', 'page'] as const)('retains the original %s Browser when a secondary destination arrives after its owner', async shape => {
  await withPane(shape, false, async ({ root, primary, host, render, browser, create }) => {
    expect(primary.querySelector('.browser-toolbar')).not.toBeNull()
    expect(host.querySelector('.browser-surface')).toBeNull()
    const otherInput = document.createElement('input'); document.body.append(otherInput); otherInput.focus()
    try {
      // The original Workbench may attach a destination after the Browser owner committed.
      await act(async () => { document.body.append(host) }); await settle()
      assertPane(host, shape)
      expect(document.activeElement).toBe(otherInput)
      const content = host.querySelector('.browser-surface')
      await render(); expect(host.querySelector('.browser-surface')).toBe(content)
      expect(useAppStore.getState().tabs['original-tab']?.regions['original-region']).toBe(browser)
      expect(create).not.toHaveBeenCalled()
      await act(async () => root.render(null)); await settle()
      expect(host.querySelector('.browser-surface')).toBeNull()
    } finally { otherInput.remove() }
  })
})

it.each(['error', 'blank', 'page'] as const)('reconfirms the exact same-id destination on the original %s Browser commit', async shape => {
  await withPane(shape, true, async ({ host, render, browser, create }) => {
    assertPane(host, shape)
    const originalContent = host.querySelector('.browser-surface')
    const address = host.querySelector<HTMLInputElement>('input')
    const caretStart = Math.min(2, address?.value.length ?? 0), caretEnd = Math.min(4, address?.value.length ?? 0)
    if (address) { address.focus(); address.setSelectionRange(caretStart, caretEnd) }
    const replacement = document.createElement('div'); replacement.id = host.id
    try {
      host.remove(); document.body.append(replacement)
      // Existing presentation identities are unchanged; a normal React commit confirms its DOM.
      await render(); await settle()
      assertPane(replacement, shape)
      expect(replacement.querySelector('.browser-surface')).toBe(originalContent)
      expect(host.querySelector('.browser-surface')).toBeNull()
      if (address) {
        expect(replacement.querySelector('input')).toBe(address)
        expect(document.activeElement).toBe(document.body) // External host removal already blurred the detached input; do not steal focus back.
        expect(address.selectionStart).toBe(caretStart); expect(address.selectionEnd).toBe(caretEnd)
      }
      expect(useAppStore.getState().tabs['original-tab']?.regions['original-region']).toBe(browser)
      expect(create).not.toHaveBeenCalled()
    } finally { replacement.remove() }
  })
})

it('keeps a connected original destination through unrelated commits and removes only its own content', async () => {
  await withPane('error', true, async ({ host, render, root }) => {
    assertPane(host, 'error'); const original = host.querySelector('.browser-surface')
    const other = document.createElement('div'); other.textContent = 'Unrelated workface'; document.body.append(other)
    try {
      await render(); await render(); expect(host.querySelector('.browser-surface')).toBe(original)
      await act(async () => root.render(null)); await settle()
      expect(host.querySelector('.browser-surface')).toBeNull(); expect(other.textContent).toBe('Unrelated workface')
    } finally { other.remove() }
  })
})

it('does not revive an unmounted Browser when its absent destination arrives later', async () => {
  await withPane('error', false, async ({ root, host }) => {
    await act(async () => root.render(null))
    await act(async () => document.body.append(host)); await settle()
    expect(host.querySelector('.browser-surface')).toBeNull()
    expect(host.childElementCount).toBe(0)
  })
})

it('moves only the exact secondary target while keeping the original content and identity', async () => {
  await withPane('error', true, async ({ host, render, presentations, browser }) => {
    const next = document.createElement('div'); next.id = 'next-exact-slot'; document.body.append(next)
    const original = host.querySelector('.browser-surface')
    try {
      const secondary = { ...presentations[1]!, stageHostId: next.id }
      await render([presentations[0]!, secondary]); await settle()
      assertPane(next, 'error'); expect(next.querySelector('.browser-surface')).toBe(original)
      expect(host.querySelector('.browser-surface')).toBeNull()
      expect(useAppStore.getState().tabs['original-tab']?.regions['original-region']).toBe(browser)
    } finally { next.remove() }
  })
})

it('keeps the public Desktop reader on its unique original primary occurrence', async () => {
  await withPane('error', true, async ({ primary, render }) => {
    const main = document.createElement('main'); main.dataset.desktopSurface = 'space'; document.body.append(main)
    const reference = { displayWorkspaceId: 'original-workspace', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
    primary.hidden = false; primary.dataset.workbenchPrimaryTabId = reference.tabId
    primary.dataset.workbenchPrimaryReference = workbenchRegionProjectionSlotId('primary', reference)
    primary.dataset.workbenchRegionId = reference.regionId; main.append(primary)
    const release = installDesktopPresentationOwner(() => ({ loading: false, overlays: { settings: false, quickSwitcher: false }, floating: null }))
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 320))
    try {
      await render(); await settle()
      const selection: Parameters<typeof readDesktopPresentation>[0] = { surface: 'space', mainSurface: 'workbench', goalId: null,
        space: { spaceId: null, zoneId: null, workspaceId: reference.displayWorkspaceId, tabId: reference.tabId, groupId: reference.groupId, regionId: reference.regionId, topicId: null } }
      expect(document.querySelectorAll('[data-workbench-region-id="original-region"]')).toHaveLength(2)
      expect(readDesktopPresentation(selection, useAppStore.getState().tabs).presentation.state).toBe('main-visible')
    } finally { release(); rect.mockRestore(); document.body.append(primary); main.remove() }
  })
})

it('keeps a positive-size parked stage invisible until its exact destination exists', async () => {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 320))
  const activate = vi.spyOn(api.browser, 'activatePresentation').mockResolvedValue({ outcome: 'selected' })
  const arm = vi.spyOn(api.browser, 'armPresentationCapture').mockResolvedValue({ captureId: 'original-capture', browserId: 'original-browser' })
  const ack = vi.spyOn(api.browser, 'ackPresentationCapture').mockResolvedValue(undefined)
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const stop = vi.fn(), stream = new MediaStream()
  Object.defineProperty(stream, 'getTracks', { value: () => [{ id: 'original-track', stop }] })
  const getDisplayMedia = vi.fn(async () => stream)
  const previousMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia } })
  try {
    await withPane('page', false, async ({ host }) => {
      const registrations = vi.mocked(api.browser.registerPresentation).mock.calls.map(([request]) => request)
      expect(registrations.length).toBeGreaterThan(0)
      expect(registrations.find(request => request.occurrence.presentationId === 'survey-original')?.geometry).toEqual({ visible: false })
      expect(vi.mocked(api.browser.updatePresentation).mock.calls.every(([, geometry]) => !geometry.visible)).toBe(true)
      expect(activate).not.toHaveBeenCalled(); expect(arm).not.toHaveBeenCalled(); expect(getDisplayMedia).not.toHaveBeenCalled()
      await act(async () => document.body.append(host)); await settle()
      assertPane(host, 'page')
      expect(vi.mocked(api.browser.updatePresentation).mock.calls.some(([leaseId, geometry]) => leaseId === 'survey-original-lease' && geometry.visible)).toBe(true)
      expect(activate).toHaveBeenCalledWith('survey-original-lease', { kind: 'select', focus: 'preserve' })
      expect(activate.mock.calls.every(([leaseId]) => leaseId === 'survey-original-lease')).toBe(true)
      expect(arm).toHaveBeenCalledTimes(1); expect(getDisplayMedia).toHaveBeenCalledTimes(1)
      expect(ack).toHaveBeenCalledWith('original-capture', { outcome: 'ready', trackIds: ['original-track'] })
    })
    expect(stop).toHaveBeenCalledOnce()
  } finally {
    if (previousMedia) Object.defineProperty(navigator, 'mediaDevices', previousMedia)
    else Reflect.deleteProperty(navigator, 'mediaDevices')
    rect.mockRestore(); activate.mockRestore(); arm.mockRestore(); ack.mockRestore(); play.mockRestore()
  }
})

type Shape = 'error' | 'blank' | 'page'
function assertPane(host: HTMLElement, shape: Shape) {
  expect(host.querySelectorAll('.browser-surface')).toHaveLength(1)
  expect(host.querySelectorAll('.browser-toolbar')).toHaveLength(1)
  expect(host.querySelector(shape === 'blank' ? '[aria-label="Search or enter a web address"]' : '[aria-label="Browser address"]')).not.toBeNull()
  if (shape === 'error') {
    expect(host.textContent).toContain('Page could not be loaded')
    expect(host.textContent).toContain('ERR_NAME_NOT_RESOLVED')
    expect([...host.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Retry')).toBe(true)
  }
}
async function withPane(shape: Shape, early: boolean, check: (fixture: {
  root: ReturnType<typeof createRoot>; primary: HTMLElement; host: HTMLElement;
  render: (next?: WorkbenchBrowserPresentation[]) => Promise<void>;
  browser: ReturnType<typeof createWorkbenchTab>['regions'][string];
  create: ReturnType<typeof vi.spyOn>; presentations: WorkbenchBrowserPresentation[]
}) => Promise<void>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), config = await api.config.get()
  const workspace = { id: 'original-workspace', hostId: 'local', path: _hygiene_fixturePath("source-fixture"), name: 'Research', kind: 'folder' as const }
  const page = await api.browser.create('original-browser', shape === 'blank' ? 'about:blank' : 'https://example.invalid/', workspace.id)
  const browser = { ...page, kind: 'browser' as const, browserId: page.id, regionId: 'original-region', workspaceId: workspace.id,
    error: shape === 'error' ? 'ERR_NAME_NOT_RESOLVED (-105)' : null, loading: false }
  const tab = createWorkbenchTab('original-tab', browser)
  const reference = { displayWorkspaceId: workspace.id, groupId: 'original-group', tabId: tab.id, regionId: browser.regionId }
  const make = (surface: 'space' | 'survey', visible: boolean): WorkbenchBrowserPresentation => ({
    occurrence: { presentationId: surface + '-original', location: reference }, stageHostId: surface + '-original-slot', visible,
    active: visible, yieldToFocusRing: false, target: { hostId: surface + '-original-host', surface, active: visible, visible, reference,
      projection: { entity: { kind: 'region', regionId: reference.regionId }, presentationId: surface + '-original',
        displayWorkspaceId: workspace.id, catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
        selection: [reference], onSelect: () => {} } }
  })
  const presentations = [make('space', false), make('survey', true)]
  useAppStore.setState({ ...initial, config: { ...config, workspaces: [workspace] }, mainSurface: 'survey', tabs: { [tab.id]: tab },
    layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) }, toolsOpen: false,
    surveyZoneSelection: { zoneId: 'original-zone', selection: [reference], active: reference } }, true)
  const create = vi.spyOn(api.browser, 'create')
  const spies = [create, vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => ({ leaseId: request.occurrence.presentationId + '-lease' })),
    vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined), vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined),
    vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => () => {})]
  const primary = document.createElement('div'); primary.hidden = true; document.body.append(primary); const root = createRoot(primary)
  const host = document.createElement('div'); host.id = presentations[1]!.stageHostId; if (early) document.body.append(host)
  const render = (next = presentations) => act(async () => root.render(createElement(BrowserPane, {
    tab: browser, presentations: next, visible: false, presentationTargetId: 'space-original-host',
    renderPresentationFrame: content => createElement('section', { 'data-workbench-region-id': browser.regionId }, content)
  })))
  try { await render(); await settle(); await check({ root, primary, host, render, browser, create, presentations }) }
  catch (error) { if (error instanceof AggregateError) throw new Error(error.errors.map(entry => entry?.stack ?? String(entry)).join("\n")); throw error }
  finally { await act(async () => root.unmount()); primary.remove(); host.remove(); useAppStore.setState(initial, true); spies.forEach(spy => spy.mockRestore()); vi.unstubAllGlobals() }
}
