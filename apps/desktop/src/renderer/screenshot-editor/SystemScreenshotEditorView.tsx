import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { SystemScreenshotEditorApi, SystemScreenshotEditorInput } from '../../shared/system-screenshot-editor'
import { ImageAnnotationEditor } from '../src/components/image-annotation/ImageAnnotationEditor'
import { composeScreenshot } from '../src/components/image-annotation/compose'
import type { ImageAnnotationInput } from '../src/components/image-annotation/types'
import { useSystemScreenshotOriginal } from './use-system-screenshot-original'
import { useScreenshotPin } from '../src/lib/use-screenshot-pin'
import { formatScreenshotContext } from '../src/components/browser-screenshot/context'

/** Pixel editing is shared with Browser capture; this host owns only final delivery and cancellation. */
export function SystemScreenshotEditorView({ input, api }: { input: SystemScreenshotEditorInput; api: SystemScreenshotEditorApi }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [delivered, setDelivered] = useState(false)
  const active = useRef(true), pending = useRef(false), editVersion = useRef(0)
  useEffect(() => () => { active.current = false }, [])
  useEffect(() => api.onNotice(setStatus), [api])
  const pin = useScreenshotPin({ pin: request => api.pin(input.requestId, request.operationId, request.image), inspect: operationId => api.inspectPin(input.requestId, operationId) })
  const original = useSystemScreenshotOriginal({ image: input.image,
    api: {
      open: () => api.openOriginal(input.requestId, mintObjectId()),
      save: (document, operationId) => api.saveOriginal(input.requestId, operationId ?? mintObjectId(), document),
      inspect: grantId => api.inspectOriginal(input.requestId, grantId),
      reconcile: operationId => api.inspectOriginalOperation(input.requestId, operationId)
    }, onError: message => setError(message), onStatus: setStatus, onEdited: () => { editVersion.current++ } })
  async function cancel() {
    active.current = false
    try { await api.cancel(input.requestId) }
    catch (cause) { active.current = true; setBusy(pending.current); setError(presentError(cause)) }
  }
  // A cancelled retake brings this editor back with its marks; a completed one closes it from Main.
  async function retake() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null)
    try {
      const result = await api.retake(input.requestId)
      if (active.current && result.status === 'failed') setError(result.message)
    } catch (cause) { if (active.current) setError(presentError(cause)) }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  // Each output resolves true only when its owner confirms that exact output.
  async function complete(edit: ImageAnnotationInput): Promise<boolean> {
    if (pending.current) return false
    const version = editVersion.current
    pending.current = true; setBusy(true); setError(null)
    try {
      const image = await composeScreenshot({ ...edit, outputScale: 1, document: edit.image.ownerDocument })
      if (!active.current) return false
      const result = await api.finish(input.requestId, mintObjectId(), image)
      if (active.current && result.status === 'failed') setError(result.message)
      else if (active.current) { setDelivered(true); if (editVersion.current === version) setStatus(input.attachToDraft && !delivered ? 'PNG copied · Original draft attachment prepared' : 'PNG copied') }
      return result.status === 'completed'
    } catch (cause) { if (active.current) setError(presentError(cause)); return false }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  async function output(edit: ImageAnnotationInput, kind: 'save' | 'pin' | 'context'): Promise<boolean> {
    if (pending.current) return false
    const version = editVersion.current
    pending.current = true; setBusy(true); setError(null)
    try {
      const image = await composeScreenshot({ ...edit, outputScale: 1, document: edit.image.ownerDocument })
      if (!active.current) return false
      if (kind === 'context') {
        const text = formatScreenshotContext(null, edit, image, original.source, original.initialState ? 'saved-document' : 'system')
        const result = await api.copyContext(input.requestId, mintObjectId(), text)
        if (active.current) { if (result.status === 'completed') { if (editVersion.current === version) setStatus('Context copied') } else setError(result.message) }
        return result.status === 'completed'
      }
      const result = kind === 'save' ? await api.savePng(input.requestId, image) : await pin.pin(image)
      if (!active.current) return false
      if ('state' in result) {
        if (result.recordedOperation?.state === 'completed') { if (editVersion.current === version) setStatus(result.state === 'open' ? 'Reference pinned' : 'Pinned reference closed') }
        else setError(result.recordedOperation?.message ?? 'The original pin operation is unconfirmed. Keep that operation before another pin.')
        return result.recordedOperation?.state === 'completed'
      }
      if (result.status === 'saved') { if (editVersion.current === version) setStatus('PNG saved · ' + result.path) }
      else if (result.status !== 'cancelled') setError(result.message)
      return result.status === 'saved'
    } catch (cause) { if (active.current) setError(presentError(cause)); return false }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  async function checkPin() {
    if (pending.current) return
    const version = editVersion.current
    pending.current = true; setBusy(true); setError(null)
    try {
      const result = await pin.checkPin()
      if (!active.current || !result) return
      if (result.recordedOperation?.state === 'completed') { if (editVersion.current === version) setStatus(result.state === 'open' ? 'Original reference pinned' : 'Original pinned reference closed') }
      else setError(result.recordedOperation?.message ?? 'The original pin did not complete. Your image is kept.')
    } catch (cause) { if (active.current) setError(presentError(cause)) }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  return <main className="system-screenshot-editor">
    <ImageAnnotationEditor key={original.generation} image={original.image} busy={busy}
      {...(original.initialState ? { initialState: original.initialState } : input.initialState ? { initialState: input.initialState, initialStateKept: input.initialState.shapes.length === 0, initialTool: input.initialTool } : {})} title="Screenshot"
      textTools={{ unavailableReason: input.textUnavailableReason, recognize: image => api.recognizeText(input.requestId, image), copy: async text => { const result = await api.copyContext(input.requestId, mintObjectId(), text); if (result.status === 'failed') throw new Error(result.message) } }}
      completeLabel={input.attachToDraft && !delivered ? 'Copy & attach' : 'Copy'} busyLabel="Copying…"
      documentStatus={status ?? (input.theme.status === 'unavailable' ? input.theme.message : null)}
      {...(pin.uncertain ? { onCheckPin: () => void checkPin() } : {})} {...(input.retakable ? { onRetake: () => void retake() } : {})}
      onSavePng={edit => output(edit, 'save')} onPin={edit => output(edit, 'pin')} onCopyContext={edit => output(edit, 'context')}
      onOpenOriginal={() => void original.openOriginal()} onSaveOriginal={edit => void original.saveOriginal(edit)} onEdited={original.edited}
      onComplete={complete} onCancel={() => void cancel()} onError={cause => setError(presentError(cause))} />
    {error ? <div className="system-screenshot-editor__error" role="alert">{error} <span>Your image is kept. You can continue editing or cancel.</span></div> : null}
    {original.uncertain ? <div className="system-screenshot-editor__recovery"><span>Original save unconfirmed · current edits kept</span><button disabled={original.busy} onClick={() => void original.checkOriginal()}>Check original</button></div> : null}
  </main>
}
