import { useEffect, useRef } from 'react'
import type { BrowserPng } from '../../../../shared/contracts'
import { ImageAnnotationEditor } from '../image-annotation/ImageAnnotationEditor'
import type { ImageAnnotationInput } from '../image-annotation/types'

export type ScreenshotCompleteInput = ImageAnnotationInput

/** Browser owns its surrounding menu/focus; image editing has no Browser identity. */
export function ScreenshotEditor(props: {
  image: BrowserPng
  busy: boolean
  copied?: string | null
  active?: boolean
  onCancel(): void
  onComplete(input: ImageAnnotationInput): void
  onCopyContext?(input: ImageAnnotationInput): void
  onEdited?(): void
  onError?(error: unknown): void
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (props.active === false) return
    const transferFocus = () => {
      const pane = host.current?.closest('.browser-surface')
      const focused = document.activeElement
      if (pane && focused instanceof HTMLButtonElement && focused.closest('.browser-surface') === pane && !host.current?.contains(focused)) {
        host.current?.querySelector<HTMLCanvasElement>('canvas')?.focus({ preventScroll: true })
      }
    }
    transferFocus()
    const frame = requestAnimationFrame(transferFocus)
    return () => cancelAnimationFrame(frame)
  }, [props.active])
  return <div ref={host} style={{ display: 'contents' }}><ImageAnnotationEditor {...props} /></div>
}
