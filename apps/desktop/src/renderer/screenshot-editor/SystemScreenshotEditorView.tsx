import { useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { SystemScreenshotEditorApi, SystemScreenshotEditorInput } from '../../shared/system-screenshot-editor'
import { ImageAnnotationEditor } from '../src/components/image-annotation/ImageAnnotationEditor'
import { composeScreenshot } from '../src/components/image-annotation/compose'
import type { ImageAnnotationInput } from '../src/components/image-annotation/types'

/** Pixel editing is shared with Browser capture; this host owns only final delivery and cancellation. */
export function SystemScreenshotEditorView({ input, api }: { input: SystemScreenshotEditorInput; api: SystemScreenshotEditorApi }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(input.initialIssue ?? null)
  const active = useRef(true), pending = useRef(false)
  useEffect(() => () => { active.current = false }, [])
  async function cancel() {
    active.current = false
    try { await api.cancel(input.requestId) }
    catch (cause) { active.current = true; setBusy(pending.current); setError(presentError(cause)) }
  }
  async function complete(edit: ImageAnnotationInput) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null)
    try {
      const image = await composeScreenshot({ ...edit, outputScale: 1, document: edit.image.ownerDocument })
      if (!active.current) return
      const result = await api.finish(input.requestId, mintObjectId(), image)
      if (active.current && result.status === 'failed') setError(result.message)
    } catch (cause) { if (active.current) setError(presentError(cause)) }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  return <main className="system-screenshot-editor">
    <ImageAnnotationEditor image={input.image} busy={busy} title="Screenshot"
      completeLabel={input.attachToDraft ? 'Copy & attach' : 'Copy'} busyLabel="Copying…"
      documentStatus={input.theme.status === 'unavailable' ? input.theme.message : null}
      onComplete={edit => void complete(edit)} onCancel={() => void cancel()} onError={cause => setError(presentError(cause))} />
    {error ? <div className="system-screenshot-editor__error" role="alert">{error} <span>Your image is kept. You can continue editing or cancel.</span></div> : null}
  </main>
}
