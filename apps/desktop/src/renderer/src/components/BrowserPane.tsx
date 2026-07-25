import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Camera,
  Check,
  Copy,
  Ellipsis,
  Globe2,
  LoaderCircle,
  Monitor,
  RefreshCw,
  ScanSearch,
  SlidersHorizontal,
  Wrench
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  BROWSER_VIEWPORT_PRESETS,
  type BrowserScreenshotCapture,
  type BrowserElementSelection,
  type BrowserSnapshot,
  type BrowserViewport
} from '../../../shared/contracts'
import { api } from '../lib/api'
import {
  browserAnnotationMarkers,
  formatBrowserElementContext,
  normalizeBrowserAnnotationNote,
  type BrowserAnnotation
} from '../lib/browser-annotations'
import { composeScreenshot } from './browser-screenshot/compose'
import {
  ScreenshotEditor,
  type ScreenshotCompleteInput
} from './browser-screenshot/ScreenshotEditor'
import {
  LatestBrowserBoundsSynchronizer,
  rendererCssBoundsToWindowDip
} from '../lib/browser-bounds-sync'
import type { BrowserWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

const VIEWPORT_LABELS: Record<BrowserViewport, string> = {
  responsive: 'Responsive',
  mobile: 'Mobile',
  tablet: 'Tablet',
  desktop: 'Desktop'
}

const NO_BROWSER_ANNOTATIONS: readonly BrowserAnnotation[] = []

type BrowserIdentity = Pick<BrowserSnapshot, 'id' | 'navigationId'>

export function browserCaptureMatchesIdentity(
  capture: Pick<BrowserScreenshotCapture, 'browserId' | 'navigationId'>,
  identity: BrowserIdentity
): boolean {
  return capture.browserId === identity.id && capture.navigationId === identity.navigationId
}

export function BrowserPane({
  tab,
  visible
}: {
  tab: BrowserWorkbenchSurface
  visible: boolean
}) {
  const applyBrowserEvent = useAppStore((state) => state.applyBrowserEvent)
  const reportError = useAppStore((state) => state.reportError)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const toolbar = useAppStore((state) => state.config?.browser.toolbar)
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  const stageRef = useRef<HTMLDivElement>(null)
  const screenshotToken = useRef(0)
  const selectionToken = useRef(0)
  const browserIdentity = useRef<BrowserIdentity>({ id: tab.browserId, navigationId: tab.navigationId })
  if (browserIdentity.current.id !== tab.browserId || browserIdentity.current.navigationId !== tab.navigationId) {
    browserIdentity.current = { id: tab.browserId, navigationId: tab.navigationId }
    screenshotToken.current += 1
    selectionToken.current += 1
  }
  const [address, setAddress] = useState(tab.url === 'about:blank' ? '' : tab.url)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [screenshot, setScreenshot] = useState<BrowserScreenshotCapture | null>(null)
  const [screenshotBusy, setScreenshotBusy] = useState(false)
  const [elementSelection, setElementSelection] = useState<BrowserElementSelection | null>(null)
  const [selectionBusy, setSelectionBusy] = useState(false)
  const [annotationNote, setAnnotationNote] = useState('')
  const annotations = useAppStore((state) => state.browserAnnotationsByBrowserId[tab.browserId]) ?? NO_BROWSER_ANNOTATIONS
  const addBrowserAnnotation = useAppStore((state) => state.addBrowserAnnotation)

  useEffect(() => {
    setAddress(tab.url === 'about:blank' ? '' : tab.url)
  }, [tab.url])

  useEffect(() => () => {
    screenshotToken.current += 1
    selectionToken.current += 1
    void api.browser.cancelElementSelection(tab.browserId).catch(() => {})
  }, [])

  useEffect(() => {
    setScreenshot(null)
    setScreenshotBusy(false)
    setElementSelection(null)
    setAnnotationNote('')
    setSelectionBusy(false)
    void api.browser.cancelElementSelection(tab.browserId).catch(() => {})
  }, [tab.browserId, tab.navigationId])

  useEffect(() => {
    const current = annotations.filter(({ navigationId }) => navigationId === tab.navigationId)
    void api.browser.setAnnotationMarkers(
      tab.browserId,
      tab.navigationId,
      browserAnnotationMarkers(current)
    ).catch(reportError)
  }, [annotations, reportError, tab.browserId, tab.navigationId])

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let frame = 0
    const synchronizer = new LatestBrowserBoundsSynchronizer(
      async (bounds) => await api.browser.setBounds(tab.browserId, bounds),
      reportError
    )
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const navigatorCoversBrowser = toolsOpen && window.innerWidth <= 900
        if (
          !visible ||
          menuOpen ||
          screenshot !== null ||
          elementSelection !== null ||
          navigatorCoversBrowser ||
          __AGENTMUX_WEB_PREVIEW__ ||
          tab.error ||
          tab.url === 'about:blank'
        ) {
          synchronizer.observe(null)
          return
        }
        const rect = stage.getBoundingClientRect()
        synchronizer.observe(rendererCssBoundsToWindowDip(
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          api.ui.getZoomFactor()
        ))
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    window.addEventListener('resize', update)
    update()
    return () => {
      cancelAnimationFrame(frame)
      synchronizer.dispose()
      observer.disconnect()
      window.removeEventListener('resize', update)
      void api.browser.setBounds(tab.browserId, null).catch(() => {})
    }
  }, [elementSelection, menuOpen, screenshot, toolsOpen, reportError, tab.browserId, tab.error, tab.url, visible])

  async function run(action: () => Promise<BrowserSnapshot>): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const browser = await action()
      applyBrowserEvent({ type: 'updated', browser })
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  async function runCommand(action: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  async function beginScreenshot(): Promise<void> {
    if (elementSelection || selectionBusy || screenshot || screenshotBusy || busy || tab.url === 'about:blank') return
    const token = ++screenshotToken.current
    setScreenshotBusy(true)
    try {
      const captured = await api.browser.captureScreenshot(tab.browserId)
      if (screenshotToken.current !== token) return
      if (!browserCaptureMatchesIdentity(captured, browserIdentity.current)) {
        throw new Error('Browser page changed before the screenshot editor opened')
      }
      setScreenshot(captured)
    } catch (error) {
      if (screenshotToken.current === token) reportError(error)
    } finally {
      if (screenshotToken.current === token) setScreenshotBusy(false)
    }
  }

  async function beginElementSelection(): Promise<void> {
    if (selectionBusy || screenshot || screenshotBusy || busy || tab.url === 'about:blank') return
    const token = ++selectionToken.current
    setElementSelection(null)
    setAnnotationNote('')
    setSelectionBusy(true)
    try {
      const selected = await api.browser.selectElement(tab.browserId)
      if (selectionToken.current !== token || !selected) return
      if (!browserCaptureMatchesIdentity(selected, browserIdentity.current)) {
        throw new Error('Browser page changed before the element selection was delivered')
      }
      setElementSelection(selected)
    } catch (error) {
      if (selectionToken.current === token) reportError(error)
    } finally {
      if (selectionToken.current === token) setSelectionBusy(false)
    }
  }

  function cancelElementSelection(): void {
    selectionToken.current += 1
    setSelectionBusy(false)
    setElementSelection(null)
    setAnnotationNote('')
    void api.browser.cancelElementSelection(tab.browserId).catch(reportError)
  }

  async function copyElementContext(): Promise<void> {
    if (!elementSelection) return
    try {
      await api.ui.writeClipboardText(formatBrowserElementContext(elementSelection))
      cancelElementSelection()
    } catch (error) {
      reportError(error)
    }
  }

  function addElementAnnotation(): void {
    if (!elementSelection) return
    addBrowserAnnotation({
      id: crypto.randomUUID(),
      workspaceId: tab.workspaceId,
      browserId: tab.browserId,
      navigationId: tab.navigationId,
      selection: elementSelection,
      note: normalizeBrowserAnnotationNote(annotationNote)
    })
    cancelElementSelection()
  }

  function cancelScreenshot(): void {
    screenshotToken.current += 1
    setScreenshotBusy(false)
    setScreenshot(null)
  }

  async function copyScreenshot(input: ScreenshotCompleteInput): Promise<void> {
    const captured = screenshot
    if (!captured || screenshotBusy) return
    const token = screenshotToken.current
    setScreenshotBusy(true)
    try {
      const image = await composeScreenshot({
        image: input.image,
        displayWidth: input.displayWidth,
        displayHeight: input.displayHeight,
        outputScale: window.devicePixelRatio || 1,
        shapes: input.shapes
      })
      if (screenshotToken.current !== token) return
      await api.ui.writeClipboardImage(image)
      if (screenshotToken.current !== token) return
      setScreenshot(null)
    } catch (error) {
      if (screenshotToken.current === token) reportError(error)
    } finally {
      if (screenshotToken.current === token) setScreenshotBusy(false)
    }
  }

  return (
    <section className="browser-surface">
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          if (address.trim()) void run(() => api.browser.navigate(tab.browserId, address.trim()))
        }}
      >
        <button
          type="button"
          aria-label="Open in external browser"
          title="Open in external browser"
          disabled={tab.url === 'about:blank' || busy}
          onClick={() => void runCommand(async () => await api.ui.openExternal(tab.url))}
        >
          <ArrowUpRight size={14} />
        </button>
        <button type="button" aria-label="Back" title="Back" disabled={!tab.canGoBack || busy} onClick={() => void run(() => api.browser.back(tab.browserId))}><ArrowLeft size={13} /></button>
        <button type="button" aria-label="Forward" title="Forward" disabled={!tab.canGoForward || busy} onClick={() => void run(() => api.browser.forward(tab.browserId))}><ArrowRight size={13} /></button>
        <button type="button" aria-label="Reload" title="Reload" disabled={busy} onClick={() => void run(() => api.browser.reload(tab.browserId))}>
          {tab.loading || busy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
        </button>
        <label>
          <Globe2 size={13} />
          <input
            aria-label="Browser address"
            value={address}
            placeholder="Search or enter an address"
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        {toolbar?.selectElement ? (
          <button
            type="button"
            aria-label={selectionBusy ? 'Cancel element selection' : 'Select element'}
            title={selectionBusy ? 'Cancel element selection' : 'Select an element for context or annotation'}
            disabled={tab.url === 'about:blank' || busy || screenshotBusy || screenshot !== null || elementSelection !== null}
            onClick={() => selectionBusy ? cancelElementSelection() : void beginElementSelection()}
          >
            {selectionBusy ? <LoaderCircle className="spin" size={14} /> : <ScanSearch size={14} />}
          </button>
        ) : null}
        {toolbar?.screenshot ? (
          <button
            type="button"
            aria-label="Screenshot"
            title="Capture and mark up this viewport"
            disabled={tab.url === 'about:blank' || busy || screenshotBusy || screenshot !== null || selectionBusy || elementSelection !== null}
            onClick={() => void beginScreenshot()}
          >
            {screenshotBusy && !screenshot ? <LoaderCircle className="spin" size={14} /> : <Camera size={14} />}
          </button>
        ) : null}
        {toolbar?.devTools ? (
          <button
            type="button"
            aria-label="Open DevTools"
            title="Open DevTools"
            disabled={tab.url === 'about:blank' || busy}
            onClick={() => void runCommand(async () => await api.browser.openDevTools(tab.browserId))}
          >
            <Wrench size={14} />
          </button>
        ) : null}
        {toolbar?.viewport ? (
          <DropdownMenu.Root onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button type="button" aria-label="Viewport" title="Viewport" disabled={busy}>
                <Monitor size={14} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="browser-menu" align="end" sideOffset={5}>
                <DropdownMenu.Label>Viewport</DropdownMenu.Label>
                <DropdownMenu.RadioGroup
                  value={tab.viewport}
                  onValueChange={(viewport) => void run(() => api.browser.setViewport(tab.browserId, viewport as BrowserViewport))}
                >
                  {(Object.keys(BROWSER_VIEWPORT_PRESETS) as BrowserViewport[]).map((viewport) => {
                    const size = BROWSER_VIEWPORT_PRESETS[viewport]
                    return (
                      <DropdownMenu.RadioItem key={viewport} value={viewport} className="browser-menu__item">
                        <DropdownMenu.ItemIndicator><Check size={12} /></DropdownMenu.ItemIndicator>
                        <span>{VIEWPORT_LABELS[viewport]}</span>
                        <small>{size ? `${size.width} × ${size.height}` : 'Fit pane'}</small>
                      </DropdownMenu.RadioItem>
                    )
                  })}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
        {toolbar?.more ? (
          <DropdownMenu.Root onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button type="button" aria-label="More browser tools" title="More browser tools"><Ellipsis size={14} /></button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="browser-menu" align="end" sideOffset={5}>
                <DropdownMenu.Label>Page</DropdownMenu.Label>
                <DropdownMenu.Item className="browser-menu__item" onSelect={() => void run(() => api.browser.reload(tab.browserId))}>
                  <RefreshCw size={12} /><span>Reload page</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="browser-menu__item" onSelect={() => setWorkspaceTool('browser-tools')}>
                  <SlidersHorizontal size={12} /><span>Customize toolbar…</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </form>
      <div className="browser-stage" ref={stageRef}>
        {screenshot ? (
          <ScreenshotEditor
            image={screenshot.image}
            busy={screenshotBusy}
            onCancel={cancelScreenshot}
            onComplete={(input) => void copyScreenshot(input)}
          />
        ) : elementSelection ? (
          <section className="browser-selection-result" aria-label="Selected element context">
            <header><ScanSearch size={17} /><span><strong>{elementSelection.accessibleName || `<${elementSelection.tagName}>`}</strong><small>{elementSelection.pageTitle || elementSelection.pageUrl}</small></span></header>
            <dl>
              <div><dt>Element</dt><dd>{`<${elementSelection.tagName}>${elementSelection.role ? ` · ${elementSelection.role}` : ''}`}</dd></div>
              <div><dt>Selector</dt><dd>{elementSelection.selector || 'No stable selector'}</dd></div>
              <div><dt>Text</dt><dd>{elementSelection.text || 'No visible text'}</dd></div>
            </dl>
            <label>
              <span>Annotation note</span>
              <textarea
                aria-label="Annotation note"
                value={annotationNote}
                maxLength={1_000}
                placeholder="What should the Agent notice about this element?"
                onChange={(event) => setAnnotationNote(event.target.value)}
              />
            </label>
            <footer>
              <button className="small-button" type="button" onClick={cancelElementSelection}>Cancel</button>
              <button className="small-button" type="button" onClick={() => void copyElementContext()}><Copy size={12} /> Copy context</button>
              <button className="primary-button" type="button" onClick={addElementAnnotation}><Check size={12} /> Add annotation</button>
            </footer>
          </section>
        ) : tab.error ? (
          <div className="pane-state pane-state--error">
            <AlertTriangle size={20} />
            <strong>Page could not be loaded</strong>
            <span>{tab.error}</span>
            <button className="small-button" type="button" onClick={() => void run(() => api.browser.reload(tab.browserId))}><RefreshCw size={12} /> Retry</button>
          </div>
        ) : tab.url === 'about:blank' ? (
          <div className="browser-empty"><Globe2 size={25} /><strong>New browser tab</strong><span>Enter an address above. Electron Main will mount a native WebContentsView.</span></div>
        ) : __AGENTMUX_WEB_PREVIEW__ ? (
          <div className="browser-preview"><Globe2 size={25} /><strong>{tab.title || tab.url}</strong><span>{tab.url}</span><small>Web Preview represents the Main-owned WebContentsView here.</small></div>
        ) : null}
      </div>
    </section>
  )
}
