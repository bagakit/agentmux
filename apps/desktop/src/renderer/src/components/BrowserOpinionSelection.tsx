import { mintObjectId } from '@agentmux/core/object-id'
import { useEffect, useMemo, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { ConversationImage } from '@agentmux/client-ui/components/ConversationImage'
import type { BrowserInputFrameResult, BrowserInputSelectionPrepare, BrowserInputSelectionReceipt } from '../../../shared/browser-input-context-capture'
import type { BrowserOpinionSource } from '../lib/browser-opinion-draft'
import { browserOpinionSelection } from '../lib/browser-opinion-draft'
import { api } from '../lib/api'
import { composeScreenshot, screenshotCropGeometry } from './image-annotation/compose'
import { ImageAnnotationEditor } from './image-annotation/ImageAnnotationEditor'
import type { ImageAnnotationInput } from './image-annotation/types'
import { getWindowOverlayHost, WindowOverlayPortal } from './WindowOverlayHost'

function sourceKey(source: BrowserOpinionSource | null): string | undefined {
  return source?.scene ? JSON.stringify([source.control, source.scene.reference]) : undefined
}

/** One explicit image intent. Neither opening nor editing this surface touches the live page. */
export function useBrowserOpinionSelection({ source, visible, locked, document, onChange }: {
  source: BrowserOpinionSource | null
  visible: boolean
  locked: boolean
  document: Document | undefined
  onChange(source: BrowserOpinionSource): void
}) {
  const current = useRef(source); current.current = source
  const [frame, setFrame] = useState<BrowserInputFrameResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const prepared = useRef<BrowserInputSelectionPrepare | null>(null)
  const ticket = useRef(0)
  const key = sourceKey(source)
  const same = (original: BrowserOpinionSource) => sourceKey(current.current) === sourceKey(original)
  function change(next: BrowserOpinionSource) { current.current = next; onChange(next) }
  function cancel() { ++ticket.current; setFrame(null); setBusy(false); prepared.current = null }
  useEffect(() => { cancel(); setFailure(null) }, [key])
  useEffect(() => { if (!visible) cancel() }, [visible])
  useEffect(() => () => { ++ticket.current }, [])

  async function capture() {
    if (!source?.scene || locked || busy) return
    const original = source, token = ++ticket.current
    setBusy(true); setFailure(null); prepared.current = null
    try {
      const captured = await api.browser.captureInputFrame(original.browserId)
      if (token === ticket.current && same(original)) setFrame(captured)
    } catch (error) { if (token === ticket.current && same(original)) setFailure(presentError(error)) }
    finally { if (token === ticket.current) setBusy(false) }
  }
  function attach(original: BrowserOpinionSource, receipt: BrowserInputSelectionReceipt, token: number) {
    if (token !== ticket.current || !same(original) || current.current?.selectionPreparation?.operationId !== receipt.operationId) return
    browserOpinionSelection({ ...current.current, selection: receipt })
    const { selectionPreparation: _preparing, ...retained } = current.current
    change({ ...retained, selection: receipt })
    setFrame(null); prepared.current = null; setFailure(null)
  }
  async function save(input?: ImageAnnotationInput) {
    if (!source?.scene || !frame || busy || locked) return
    const original = source, token = ticket.current
    setBusy(true); setFailure(null)
    try {
      let intent = prepared.current
      if (!intent) {
        if (!input) return
        const png = await composeScreenshot({ ...input, outputScale: 1, document: input.image.ownerDocument })
        if (token !== ticket.current || !same(original)) return
        // Record the actual rounded source area used by the shared compositor.
        const geometry = screenshotCropGeometry(input.displayWidth, input.displayHeight, 1, input.crop)
        const region = { x: geometry.left / geometry.scale, y: geometry.top / geometry.scale,
          width: geometry.cropWidth / geometry.scale, height: geometry.cropHeight / geometry.scale, space: 'capture-pixels' as const }
        intent = { scene: original.scene!.reference, frame: frame.scene.reference, operationId: mintObjectId(),
          region, ...(input.crop ? { crop: { x: region.x, y: region.y, width: region.width, height: region.height } } : {}), png }
        prepared.current = intent
        change({ ...current.current!, selectionPreparation: { operationId: intent.operationId, frame: intent.frame } })
      }
      const receipt = await api.browser.prepareInputSelection(intent)
      attach(original, receipt, token)
    } catch (error) { if (token === ticket.current && same(original)) setFailure(presentError(error)) }
    finally { if (token === ticket.current) setBusy(false) }
  }
  async function inspect() {
    const original = source, attempt = original?.selectionPreparation
    if (!original || !attempt || locked || busy) return
    const token = ticket.current
    setBusy(true); setFailure(null)
    try {
      const result = await api.browser.readInputSelection(attempt.operationId)
      if (token !== ticket.current || !same(original)) return
      if (result.state === 'prepared' && result.receipt && result.receipt.operationId === attempt.operationId &&
          result.receipt.scene.inputContext.selection?.frameId === attempt.frame.captureId) attach(original, result.receipt, token)
      else setFailure('The original image is not confirmed. Retry the same prepared image if it is still open, or continue with text. The current page has not been recaptured.')
    } catch (error) { if (token === ticket.current && same(original)) setFailure(presentError(error)) }
    finally { if (token === ticket.current) setBusy(false) }
  }
  let selected: BrowserInputSelectionReceipt | undefined, invalidSelection: string | undefined
  try { if (source) selected = browserOpinionSelection(source) } catch (error) { invalidSelection = presentError(error) }
  const attachment = selected?.scene.inputContext.selection?.attachment
  const imageKey = attachment ? JSON.stringify(attachment) : ''
  const readImage = useMemo(() => () => attachment ? api.browser.readSelectionImage(attachment) : Promise.resolve(null), [imageKey, document])
  return {
    busy,
    controls: <div className="browser-opinion-selection">
      {attachment ? <div className="browser-opinion-selection__attachment">
        <ConversationImage key={imageKey} path={attachment.path} text="Processed Browser image" label="Processed Browser image" readImage={readImage} active={visible} />
        <span>Processed image · {attachment.width} × {attachment.height}<small>Captured at step {selected?.scene.inputContext.selection?.source.stepSequence ?? 'unknown'} · {selected?.scene.inputContext.selection?.source.association === 'unknown' ? 'Source association unknown' : 'Observed during'}</small></span>
        <button className="small-button" type="button" disabled={locked || busy} onClick={() => {
          if (current.current) { const { selection: _selection, ...retained } = current.current; change(retained) }
        }}>Remove image</button>
      </div> : null}
      {selected?.scene.diskDurability === 'unconfirmed' ? <p className="browser-contextual-composer__notice" role="status">Image saved. Its capture details are not yet confirmed on disk. Your text is kept.</p> : null}
      {invalidSelection ? <p className="browser-contextual-composer__notice" role="status">{invalidSelection}<button className="small-button" type="button" disabled={locked || busy} onClick={() => {
        if (current.current) { const { selection: _selection, ...retained } = current.current; change(retained) }
      }}>Remove image</button></p> : null}
      <div className="browser-opinion-selection__actions">
        <button className="small-button" type="button" disabled={!source?.scene || locked || busy} onClick={() => void capture()}>{busy && !frame ? 'Reading image…' : attachment ? 'Replace image…' : 'Mark captured image…'}</button>
        {source?.selectionPreparation ? <button className="small-button" type="button" disabled={locked || busy} onClick={() => void inspect()}>Check original image</button> : null}
        {busy && !frame ? <button className="small-button" type="button" onClick={cancel}>Cancel image</button> : null}
      </div>
      {failure ? <p className="browser-contextual-composer__notice" role="status">Image: {failure} Your text is kept.</p> : null}
    </div>,
    editor: frame && visible && document ? <WindowOverlayPortal container={getWindowOverlayHost(document)}>
      <section className="browser-opinion-selection__editor" data-state="open" aria-label="Captured Browser image">
        <div className="browser-opinion-selection__provenance"><strong>Mark captured image</strong><span title={frame.capture.source.url ?? undefined}>{frame.capture.source.title || frame.capture.source.url}</span>
          <small>Captured at step {frame.scene.frame?.source.stepSequence ?? 'unknown'} · Live Browser continues</small></div>
        {failure ? <div className="browser-opinion-selection__recovery" role="status"><span>{failure}</span>{prepared.current ? <button className="small-button" disabled={busy} onClick={() => void save()}>Retry original image</button> : null}<button className="small-button" disabled={busy} onClick={() => void inspect()}>Check original image</button></div> : null}
        <ImageAnnotationEditor image={frame.capture.image} active={visible} busy={busy || prepared.current !== null} ownerDocument={document}
          title="Captured image" completeLabel="Attach processed image" busyLabel={busy ? 'Preparing image…' : 'Original image unconfirmed'}
          documentStatus={frame.scene.diskDurability === 'unconfirmed' ? 'Capture details are not yet confirmed on disk. Text remains available.' : 'Only the processed PNG is attached. Crop to attach a region.'}
          onCancel={cancel} onComplete={input => void save(input)} onError={error => setFailure(presentError(error))} />
      </section>
    </WindowOverlayPortal> : null
  }
}
