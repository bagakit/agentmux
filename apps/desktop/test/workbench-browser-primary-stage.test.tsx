// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { BrowserPresentationStage, type BrowserStagePresentation, type useBrowserPresentationCapture } from '../src/renderer/src/components/BrowserPresentationStage'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { api } from '../src/renderer/src/lib/api'

it('a cold primary stage waits for visible ready geometry, then keeps its exact lease while hidden', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  const callbacks = new Map<Element, ResizeObserverCallback>()
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(element: Element) { callbacks.set(element, this.callback) }
    unobserve(element: Element) { callbacks.delete(element) }
    disconnect() { for (const [element, callback] of callbacks) if (callback === this.callback) callbacks.delete(element) }
  })
  let measured = new DOMRect(0, 0, 0, 0)
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => measured)
  const register = vi.spyOn(api.browser, 'registerPresentation').mockResolvedValue({ leaseId: 'original-primary-lease' })
  const update = vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined)
  const remove = vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  const events = vi.spyOn(api.browser, 'onPageKey').mockImplementation(() => () => {})
  const location = { displayWorkspaceId: 'actual-display', groupId: 'actual-group', tabId: 'actual-tab', regionId: 'actual-region' }
  const scope = { windowId: 'actual-window', documentGeneration: 'actual-document' }
  const media = { stream: null, captureId: null, nativeCoverage: null, notice: null, capturePhase: 'idle', ownerClearedRevision: 0,
    readInputIntentRevision: () => 0, registered: vi.fn(async () => {}), ensureCapture: vi.fn(async () => {}), retryCapture: vi.fn(async () => {}) } as ReturnType<typeof useBrowserPresentationCapture>
  const render = async (visible: boolean, blocked: boolean) => {
    const presentation: BrowserStagePresentation = { occurrence: { presentationId: 'original-primary-stage', location },
      stageHostId: 'real-primary-host', visible, active: true, yieldToFocusRing: false,
      target: { hostId: 'real-primary-host', reference: location, active: true, visible, surface: 'space' } }
    await act(async () => root.render(createElement(WorkbenchDocumentContext.Provider, { value: { document, window: scope } },
      createElement(BrowserPresentationStage, { browserId: 'original-cold-page', navigationId: 'original-navigation',
        presentation, inputSelected: true, blocked, media }))))
  }
  try {
    await render(false, true)
    const stage = container.querySelector<HTMLElement>('[data-native-browser-stage]')!
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(register, 'Hidden cold Browser must not be prepared by a presentation read').not.toHaveBeenCalled()
    await render(true, true)
    expect(register, 'Visible recovery is not native readiness').not.toHaveBeenCalled()
    await render(true, false)
    expect(register, 'A zero-size stage is not a consumable page area').not.toHaveBeenCalled()
    expect(callbacks.has(stage), 'Geometry is observed before registration so a real positive size can wake it').toBe(true)
    measured = new DOMRect(12, 20, 640, 360)
    await act(async () => callbacks.get(stage)!([{ target: stage } as ResizeObserverEntry], {} as ResizeObserver))
    await vi.waitFor(() => expect(register).toHaveBeenCalledExactlyOnceWith({ browserId: 'original-cold-page', window: scope,
      occurrence: { presentationId: 'original-primary-stage', location }, geometry: { visible: true, bounds: { x: 12, y: 20, width: 640, height: 360 } } }))
    await render(false, false)
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith('original-primary-lease', { visible: false }))
    expect(container.querySelector('[data-native-browser-stage]')).toBe(stage)
    expect(remove).not.toHaveBeenCalled()
    await render(true, false)
    expect(register).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-native-browser-stage]')).toBe(stage)
  } finally {
    await act(async () => root.unmount()); container.remove()
    for (const spy of [rect, register, update, remove, events]) spy.mockRestore()
    vi.unstubAllGlobals()
  }
})
