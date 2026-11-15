import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { mintObjectId } from '@agentmux/core/object-id'
import type { BrowserSnapshot, BrowserScreenshotCapture, BrowserElementSelection } from '../../../shared/contracts'
import type { BrowserWorkbenchSurface } from '../lib/workbench-tabs'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useScreenshotPin } from '../lib/use-screenshot-pin'
import { formatBrowserElementContext, normalizeBrowserAnnotationNote } from '../lib/browser-annotations'
import { useAppStore } from '../store'
import { composeScreenshot } from './image-annotation/compose'
import { formatScreenshotContext } from './browser-screenshot/context'
import { ScreenshotEditor, type ScreenshotEditorHandle, type ScreenshotCompleteInput } from './browser-screenshot/ScreenshotEditor'
import * as DropdownMenu from './HoverDropdownMenu'

const ThemeActionAddAnnotationIcon = semanticIconComponent('action.add-annotation')
const ThemeActionInspectIcon = semanticIconComponent('action.inspect')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeActionCaptureIcon = semanticIconComponent('action.capture')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')

type BrowserIdentity = Pick<BrowserSnapshot, 'id' | 'navigationId'>
type CapturePreferences = { selectElement?: boolean; screenshot?: boolean }

export function browserCaptureMatchesIdentity(
  capture: Pick<BrowserScreenshotCapture, 'browserId' | 'navigationId'>,
  identity: BrowserIdentity
): boolean {
  return capture.browserId === identity.id && capture.navigationId === identity.navigationId
}

export function useBrowserCaptureTools(
  tab: Pick<BrowserWorkbenchSurface, 'browserId' | 'navigationId' | 'workspaceId' | 'url'>,
  browserIdentity: RefObject<BrowserIdentity>,
  busy: boolean,
  reportError: (error: unknown) => void
) {
  const addBrowserAnnotation = useAppStore(state => state.addBrowserAnnotation)
  const [annotationNote, setAnnotationNote] = useState('')
  const screenshotToken = useRef(0)
  const selectionToken = useRef(0)
  const [screenshot, setScreenshot] = useState<{ kind: 'capture'; capture: BrowserScreenshotCapture; key: number; capturedAt: number } | { kind: 'open'; key: number } | null>(null)
  const previousSource = useRef(browserIdentity.current)
  if (previousSource.current !== browserIdentity.current) {
    previousSource.current = browserIdentity.current
    if (screenshot?.kind !== 'open') screenshotToken.current += 1
    selectionToken.current += 1
  }
  const screenshotEditor = useRef<ScreenshotEditorHandle>(null)
  const [screenshotBusy, setScreenshotBusy] = useState(false)
  const [screenshotCopied, setScreenshotCopied] = useState<string | null>(null)
  const screenshotEdited = useCallback(() => setScreenshotCopied(null), [])
  const screenshotPin = useScreenshotPin({ pin: input => api.ui.pinScreenshot(input), inspect: operationId => api.ui.inspectScreenshotPin(operationId) })
  const [elementSelection, setElementSelection] = useState<BrowserElementSelection | null>(null)
  const [selectionBusy, setSelectionBusy] = useState(false)
  useEffect(() => () => {
    screenshotToken.current += 1
    selectionToken.current += 1
    void api.browser.cancelElementSelection(tab.browserId).catch(() => {})
  }, [])

  useEffect(() => {
    if (screenshot?.kind !== 'open') { setScreenshot(null); setScreenshotBusy(false) }
    setElementSelection(null)
    setAnnotationNote('')
    setSelectionBusy(false)
    void api.browser.cancelElementSelection(tab.browserId).catch(() => {})
  }, [tab.browserId, tab.navigationId])

  async function beginScreenshot(): Promise<void> {
    if (elementSelection || selectionBusy || screenshot || screenshotBusy || busy || tab.url === 'about:blank') return
    const token = ++screenshotToken.current
    setScreenshotCopied(null)
    setScreenshotBusy(true)
    try {
      const capturedAt = Date.now(), captured = await api.browser.captureScreenshot(tab.browserId)
      if (screenshotToken.current !== token) return
      if (!browserCaptureMatchesIdentity(captured, browserIdentity.current)) {
        throw new Error('Browser page changed before the screenshot editor opened')
      }
      setScreenshot({ kind: 'capture', capture: captured, key: token, capturedAt })
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
    // 成功才收起选区：复制失败要把选区留着让用户重试，而不是既没进剪贴板又丢了选中目标。
    const token = selectionToken.current
    if (await copyTextToClipboard(formatBrowserElementContext(elementSelection), reportError) && selectionToken.current === token) {
      cancelElementSelection()
    }
  }

  function addElementAnnotation(): void {
    if (!elementSelection) return
    addBrowserAnnotation({
      id: mintObjectId(),
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
    setScreenshotCopied(null)
  }

  // Resolves true only when the clipboard, file or pin owner confirms this exact output.
  async function copyScreenshot(input: ScreenshotCompleteInput, kind: 'png' | 'context' | 'save-png' | 'pin' = 'png'): Promise<boolean> {
    if (!screenshot || screenshotBusy) return false
    const token = screenshotToken.current
    setScreenshotBusy(true)
    setScreenshotCopied(null)
    try {
      const image = await composeScreenshot({
        image: input.image,
        displayWidth: input.displayWidth,
        displayHeight: input.displayHeight,
        outputScale: 1,
        shapes: input.shapes,
        crop: input.crop
      })
      if (screenshotToken.current !== token) return false
      let feedback = kind === 'png' ? 'PNG copied' : 'Context copied'
      if (kind === 'save-png') {
        const result = await api.ui.exportScreenshot({ image, capturedAt: screenshot.kind === 'capture' ? screenshot.capturedAt : Date.now() })
        if (result.status === 'cancelled') return false
        if (result.status !== 'saved') throw new Error(result.message)
        feedback = 'PNG saved · ' + result.path
      } else if (kind === 'pin') {
        const result = await screenshotPin.pin(image)
        if (result.recordedOperation?.state !== 'completed') throw new Error(result.recordedOperation?.message ?? 'The original pin is unconfirmed. Inspect that operation before another pin.')
        feedback = result.state === 'open' ? 'Reference pinned' : 'Pinned reference closed'
      } else if (kind === 'png') await api.ui.writeClipboardImage(image)
      else if (!await copyTextToClipboard(formatScreenshotContext(input.capture, input, image, input.source), error => { if (screenshotToken.current === token) reportError(error) })) return false
      if (screenshotToken.current !== token) return false
      setScreenshotCopied(feedback)
      return true
    } catch (error) {
      if (screenshotToken.current === token) reportError(error)
      return false
    } finally {
      if (screenshotToken.current === token) setScreenshotBusy(false)
    }
  }

  async function checkScreenshotPin(): Promise<void> {
    if (screenshotBusy) return
    const token = screenshotToken.current
    setScreenshotBusy(true)
    try {
      const result = await screenshotPin.checkPin()
      if (screenshotToken.current !== token || !result) return
      if (result.recordedOperation?.state === 'completed') setScreenshotCopied(result.state === 'open' ? 'Original reference pinned' : 'Original pinned reference closed')
      else reportError(new Error(result.recordedOperation?.message ?? 'The original pin did not complete. Your image is kept.'))
    } catch (cause) { if (screenshotToken.current === token) reportError(cause) }
    finally { if (screenshotToken.current === token) setScreenshotBusy(false) }
  }

  const selectElementDisabled = tab.url === 'about:blank' || busy || screenshotBusy || screenshot !== null || elementSelection !== null
  const screenshotDisabled = tab.url === 'about:blank' || busy || screenshotBusy || screenshot !== null || selectionBusy || elementSelection !== null
  const selectElement = () => selectionBusy ? cancelElementSelection() : void beginElementSelection()

  function openOriginal(): void {
    if (screenshot) {
      screenshotEditor.current?.openOriginal()
      return
    }
    const key = ++screenshotToken.current
    setScreenshotCopied(null)
    setScreenshot({ kind: 'open', key })
  }

  const openOriginalDisabled = screenshotBusy || selectionBusy || elementSelection !== null

  return {
    screenshotOpen: screenshot !== null,
    selectionOpen: elementSelection !== null,
    screenshotView: (visible: boolean) => screenshot ? (
      <ScreenshotEditor
        ref={screenshotEditor}
        key={screenshot.key}
        {...(screenshot.kind === 'capture' ? { capture: screenshot.capture } : {})}
        workspaceId={tab.workspaceId}
        active={visible}
        busy={screenshotBusy}
        copied={screenshotCopied}
        onCancel={cancelScreenshot}
        onComplete={(input) => copyScreenshot(input)}
        onCopyContext={(input) => copyScreenshot(input, 'context')}
        onSavePng={(input) => copyScreenshot(input, 'save-png')}
        onPin={(input) => copyScreenshot(input, 'pin')}
        {...(screenshotPin.uncertain ? { onCheckPin: () => void checkScreenshotPin() } : {})}
        onEdited={screenshotEdited}
        onOriginalOpened={() => setScreenshot(current => current ? { kind: 'open', key: current.key } : null)}
        onError={reportError}
      />
    ) : null,
    selectionView: elementSelection ? (
      <section className="browser-selection-result" aria-label="Selected element context">
        <header><ThemeActionInspectIcon size={17} /><span><strong>{elementSelection.accessibleName || `<${elementSelection.tagName}>`}</strong><small>{elementSelection.pageTitle || elementSelection.pageUrl}</small></span></header>
        <dl>
          <div><dt>Element</dt><dd>{`<${elementSelection.tagName}>${elementSelection.role ? ` · ${elementSelection.role}` : ''}`}</dd></div>
          <div><dt>Selector</dt><dd>{elementSelection.selector || 'No stable selector'}</dd></div>
          <div><dt>Text</dt><dd>{elementSelection.text || 'No visible text'}</dd></div>
        </dl>
        <label>
          <span>Annotation note</span>
          <ComposerTextarea
            aria-label="Annotation note"
            value={annotationNote}
            maxLength={1_000}
            placeholder="What should the Agent notice about this element?"
            onValueChange={setAnnotationNote}
          />
        </label>
        <footer>
          <Button type="button" onClick={cancelElementSelection}>Cancel</Button>
          <Button type="button" onClick={() => void copyElementContext()}><ThemeActionCopyIcon size={12} /> Copy context</Button>
          <Button variant="primary" type="button" onClick={addElementAnnotation}><ThemeActionAddAnnotationIcon size={12} /> Add annotation</Button>
        </footer>
      </section>
    ) : null,
    toolbarActions: (toolbar: CapturePreferences | undefined) => <>
      {toolbar?.selectElement ? (
        <button
          type="button"
          className="browser-toolbar__secondary browser-toolbar__priority-tool"
          aria-label={selectionBusy ? 'Cancel element selection' : 'Select element'}
          title={selectionBusy ? 'Cancel element selection' : 'Select an element for context or annotation'}
          disabled={selectElementDisabled}
          onClick={selectElement}
        >
          {selectionBusy ? <ThemeStatusLoadingIcon animation="spin" size={14} /> : <ThemeActionInspectIcon size={14} />}
        </button>
      ) : null}
      {toolbar?.screenshot ? (
        <button
          type="button"
          className="browser-toolbar__secondary browser-toolbar__priority-tool"
          aria-label="Screenshot"
          title="Capture and mark up this viewport"
          disabled={screenshotDisabled}
          onClick={() => void beginScreenshot()}
        >
          {screenshotBusy && !screenshot ? <ThemeStatusLoadingIcon animation="spin" size={14} /> : <ThemeActionCaptureIcon size={14} />}
        </button>
      ) : null}
    </>,
    menuActions: (toolbar: CapturePreferences | undefined) => <>
      {toolbar?.selectElement ? <DropdownMenu.Item className="browser-menu__item" aria-label={selectionBusy ? 'Cancel element selection' : 'Select element'} disabled={selectElementDisabled} onSelect={selectElement}>
        <ThemeActionInspectIcon size={12} /><span>{selectionBusy ? 'Cancel element selection' : 'Select element'}</span>
      </DropdownMenu.Item> : null}
      {toolbar?.screenshot ? <DropdownMenu.Item className="browser-menu__item" aria-label="Screenshot" disabled={screenshotDisabled} onSelect={() => void beginScreenshot()}>
        <ThemeActionCaptureIcon size={12} /><span>Screenshot</span>
      </DropdownMenu.Item> : null}
      {toolbar?.screenshot ? <DropdownMenu.Item className="browser-menu__item" aria-label="Open annotation original" disabled={openOriginalDisabled}
        onSelect={openOriginal}>
        <ThemeActionOpenExternalIcon size={12} /><span>Open annotation original…</span>
      </DropdownMenu.Item> : null}
    </>
  }
}
