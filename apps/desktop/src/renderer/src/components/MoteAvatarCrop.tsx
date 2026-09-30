import { useEffect, useRef, useState, type RefObject } from 'react'
import { MOTE_AVATAR_EDGE } from '../../../shared/mote-avatars'

/** The canvas is the exact square saved on confirmation; CSS shows its circular avatar mask. */
export function MoteAvatarCrop({ source, canvasRef, disabled, onReady, onError }: { source: string; canvasRef: RefObject<HTMLCanvasElement | null>; disabled: boolean; onReady(): void; onError(message: string): void }) {
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const image = useRef<HTMLImageElement | null>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; offset: typeof offset } | null>(null)
  const paint = () => {
    const canvas = canvasRef.current, bitmap = image.current
    if (!canvas || !bitmap) return false
    const context = canvas.getContext('2d')
    if (!context) { onError('The avatar canvas is unavailable. Select another image or retry the editor.'); return false }
    const scale = Math.max(MOTE_AVATAR_EDGE / bitmap.width, MOTE_AVATAR_EDGE / bitmap.height) * zoom
    const w = bitmap.width * scale, h = bitmap.height * scale
    const x = Math.max(-(w - MOTE_AVATAR_EDGE) / 2, Math.min((w - MOTE_AVATAR_EDGE) / 2, offset.x))
    const y = Math.max(-(h - MOTE_AVATAR_EDGE) / 2, Math.min((h - MOTE_AVATAR_EDGE) / 2, offset.y))
    context.clearRect(0, 0, MOTE_AVATAR_EDGE, MOTE_AVATAR_EDGE)
    context.drawImage(bitmap, (MOTE_AVATAR_EDGE - w) / 2 + x, (MOTE_AVATAR_EDGE - h) / 2 + y, w, h)
    return true
  }
  useEffect(() => {
    let current = true
    const bitmap = new Image()
    bitmap.onload = () => { if (current) { image.current = bitmap; if (paint()) onReady() } }
    bitmap.onerror = () => { if (current) onError('This image preview could not be decoded. Select another image.') }
    bitmap.src = source
    return () => { current = false; image.current = null }
  }, [source])
  useEffect(() => { paint() }, [zoom, offset])
  return <div className="mote-avatar-crop">
    <canvas ref={canvasRef} width={MOTE_AVATAR_EDGE} height={MOTE_AVATAR_EDGE} className="mote-avatar-crop__preview"
      aria-label="Circular avatar preview" onPointerDown={event => {
        if (disabled) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset }
      }} onPointerMove={event => {
        const start = drag.current
        if (!start || start.pointerId !== event.pointerId) return
        const scale = MOTE_AVATAR_EDGE / event.currentTarget.getBoundingClientRect().width
        setOffset({ x: start.offset.x + (event.clientX - start.x) * scale, y: start.offset.y + (event.clientY - start.y) * scale })
      }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
    <label className="mote-avatar-crop__zoom">Zoom<input aria-label="Avatar zoom" type="range" min="1" max="3" step="0.05" value={zoom}
      disabled={disabled} onChange={event => setZoom(Number(event.currentTarget.value))} /></label>
    <span className="space-icon-picker__description">Drag the preview to position your image.</span>
  </div>
}
