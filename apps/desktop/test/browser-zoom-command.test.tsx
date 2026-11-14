// @vitest-environment happy-dom
import { tmpdir } from 'node:os'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions, WebContents } from 'electron'
import type { AppConfig, BrowserSnapshot } from '../src/shared/contracts.js'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => tmpdir() } }))

import { applicationMenuTemplate } from '../src/main/application-menu.js'
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { ZoomCommands } from '../src/main/zoom-commands.js'
import { ZOOM_COMMAND_CHANNEL } from '../src/shared/contracts.js'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane.js'
import { api } from '../src/renderer/src/lib/api.js'
import { isMacPlatform } from '../src/renderer/src/lib/host-platform.js'
import { runZoomCommand } from '../src/renderer/src/lib/zoom-command.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'

describe('View menu zoom commands', () => {
  it('binds Actual Size, Zoom In with its hidden Cmd+= alias, and Zoom Out to the one zoom callback', () => {
    const zoom = vi.fn()
    const view = applicationMenuTemplate(true, { zoom }).find(item => item.label === 'View')!.submenu as MenuItemConstructorOptions[]
    const items = view.filter(item => item.accelerator)
    expect(items.map(item => [item.label, item.accelerator, item.visible !== false || item.acceleratorWorksWhenHidden === true])).toEqual([
      ['Actual Size', 'CommandOrControl+0', true],
      ['Zoom In', 'CommandOrControl+Plus', true],
      ['Zoom In', 'CommandOrControl+=', true],
      ['Zoom Out', 'CommandOrControl+-', true]
    ])
    expect(items[2]!.visible, 'the alias stays out of the menu').toBe(false)
    for (const item of items) item.click!({} as never, undefined, {} as never)
    expect(zoom.mock.calls).toEqual([['reset'], ['in'], ['in'], ['out']])
    expect(view.filter(item => item.role === 'resetZoom' || item.role === 'zoomIn' || item.role === 'zoomOut'),
      'a zoom role would zoom the focused contents by itself').toEqual([])
  })
})

// Main: the Browser manager's own lookup of the page it shows, with its zoom observed.
function mainRouting() {
  const page = () => ({ isDestroyed: () => false, zoomLevel: 0, send: vi.fn() })
  const first = page(), second = page(), workbench = page(), devTools = page()
  const entry = (id: string, contents: object) => ({ id, view: { webContents: contents } })
  const firstEntry = entry('browser-1', first), secondEntry = entry('browser-2', second)
  const manager = Object.assign(Object.create(BrowserViewManager.prototype), {
    entries: new Map([[firstEntry.id, firstEntry], [secondEntry.id, secondEntry]]),
    entriesByContents: new WeakMap<object, unknown>([[first, firstEntry], [second, secondEntry]]),
    inputSurfaces: new WeakMap<object, unknown>(), inputSurfacesByContents: new WeakMap<object, unknown>(),
    zoom: vi.fn()
  }) as BrowserViewManager & { zoom: ReturnType<typeof vi.fn> }
  const commands = new ZoomCommands()
  commands.attach({
    browserIdFor: contents => manager.browserIdForContents(contents),
    zoomBrowser: (browserId, step) => { manager.zoom(browserId, step) },
    isWorkbench: contents => contents === (workbench as object),
    workbench: workbench as unknown as WebContents
  })
  const run = (step: 'in' | 'out' | 'reset', focused: object | null) => commands.run(step, focused as WebContents | null)
  return { first, second, secondEntry, workbench, devTools, manager, run }
}

describe('Main routes View menu zoom by focus', () => {
  it('zooms a focused page through its exact Browser, never by itself', () => {
    const { first, second, workbench, manager, run } = mainRouting()
    run('in', second)
    expect(manager.zoom).toHaveBeenCalledExactlyOnceWith('browser-2', 'in')
    run('reset', first)
    expect(manager.zoom).toHaveBeenLastCalledWith('browser-1', 'reset')
    expect([first.zoomLevel, second.zoomLevel]).toEqual([0, 0])
    expect(workbench.send).not.toHaveBeenCalled()
  })

  it('does not take a page its Browser has replaced for that Browser', () => {
    const { second, secondEntry, manager, run } = mainRouting()
    secondEntry.view = { webContents: {} }
    run('in', second)
    expect(manager.zoom).not.toHaveBeenCalled()
  })

  it('routes the native input shield to its original page, including after a Profile replacement', () => {
    const { secondEntry, manager, run } = mainRouting()
    const shield = { isDestroyed: () => false, zoomLevel: 0 }
    const surface = { entry: secondEntry, page: secondEntry.view }
    const owner = manager as unknown as { inputSurfaces: WeakMap<object, unknown>; inputSurfacesByContents: WeakMap<object, unknown> }
    owner.inputSurfaces.set(secondEntry.view, surface)
    owner.inputSurfacesByContents.set(shield, surface)
    run('in', shield)
    expect(manager.zoom).toHaveBeenCalledExactlyOnceWith('browser-2', 'in')
    secondEntry.view = { webContents: {} }
    run('reset', shield)
    expect(manager.zoom).toHaveBeenCalledOnce()
  })

  it('lets the renderer of a focused workbench window choose, and zooms other pages as the roles did', () => {
    const { workbench, devTools, manager, run } = mainRouting()
    run('out', workbench)
    expect(workbench.send).toHaveBeenCalledExactlyOnceWith(ZOOM_COMMAND_CHANNEL, { kind: 'step', step: 'out' })
    expect(workbench.zoomLevel).toBe(0)
    run('in', devTools)
    expect(devTools.zoomLevel).toBe(0.5)
    run('reset', devTools)
    expect(devTools.zoomLevel).toBe(0)
    run('in', null)
    expect(manager.zoom).not.toHaveBeenCalled()
    expect(workbench.send).toHaveBeenCalledOnce()
  })

  it('reports a failed page zoom without changing control or taking another zoom path', () => {
    const { second, workbench, manager, run } = mainRouting()
    manager.zoom.mockImplementation(() => { throw new Error('Viewport could not be refitted') })
    run('in', second)
    expect(workbench.send).toHaveBeenCalledExactlyOnceWith(ZOOM_COMMAND_CHANNEL, {
      kind: 'failed', message: 'Page zoom could not finish: Viewport could not be refitted. The page is kept; retry the zoom command.'
    })
    expect(second.zoomLevel).toBe(0)
    expect(manager.zoom).toHaveBeenCalledExactlyOnceWith('browser-2', 'in')
  })
})

// Renderer: two real Browser panes, with Main replaced at the preload boundary.
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const tab = (browserId: string) => ({
  id: browserId, navigationId: `${browserId}-document`, browserId, regionId: `${browserId}-region`, workspaceId: 'workspace-1',
  kind: 'browser' as const, mode: 'normal' as const, profileId: 'profile-1', url: 'https://example.test/', title: 'Example',
  loading: false, canGoBack: true, canGoForward: true, viewport: 'responsive' as const, driving: false, appLinkPrompt: null, error: null
})

async function mountPanes() {
  const container = document.createElement('div')
  const elsewhere = document.createElement('button')
  elsewhere.textContent = 'Terminal'
  document.body.append(container, elsewhere)
  const root = createRoot(container)
  await act(async () => root.render(<><BrowserPane tab={tab('browser-1')} visible /><BrowserPane tab={tab('browser-2')} visible /></>))
  const surfaces = [...container.querySelectorAll<HTMLElement>('.browser-surface')]
  const address = (index: number) => surfaces[index]!.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
  const openFind = (index: number) => act(async () => {
    surfaces[index]!.querySelector<HTMLElement>('.browser-toolbar button')!.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'f', bubbles: true, cancelable: true, metaKey: isMacPlatform(), ctrlKey: !isMacPlatform() }))
  })
  const findInput = (index: number) => surfaces[index]!.querySelector<HTMLInputElement>('.browser-find input')
  const cleanup = async () => { await act(async () => root.unmount()); container.remove(); elsewhere.remove() }
  return { surfaces, address, openFind, findInput, elsewhere, cleanup }
}

describe('the renderer zooms what holds focus', () => {
  beforeEach(() => { useAppStore.setState({ config: structuredClone(config) }) })
  afterEach(() => vi.restoreAllMocks())

  it('zooms the Browser whose toolbar or find row holds focus, and the interface from anywhere else', async () => {
    const zoomBrowser = vi.spyOn(api.browser, 'zoom').mockResolvedValue({} as BrowserSnapshot)
    const zoomInterface = vi.spyOn(api.ui, 'zoomInterface').mockResolvedValue()
    const panes = await mountPanes()
    try {
      expect(panes.surfaces).toHaveLength(2)
      panes.address(1).focus()
      await runZoomCommand('in')
      expect(zoomBrowser).toHaveBeenCalledExactlyOnceWith('browser-2', 'in')
      panes.address(0).focus()
      await runZoomCommand('reset')
      expect(zoomBrowser).toHaveBeenLastCalledWith('browser-1', 'reset')

      await panes.openFind(1)
      expect(document.activeElement, 'the find row holds focus').toBe(panes.findInput(1))
      await runZoomCommand('out')
      expect(zoomBrowser).toHaveBeenLastCalledWith('browser-2', 'out')
      expect(zoomInterface).not.toHaveBeenCalled()

      panes.elsewhere.focus()
      await runZoomCommand('in')
      expect(zoomInterface).toHaveBeenCalledExactlyOnceWith('in', undefined)
      expect(zoomBrowser).toHaveBeenCalledTimes(3)
    } finally { await panes.cleanup() }
  })
})
