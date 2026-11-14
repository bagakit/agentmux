import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { fitImageScale, imageOffsetAtScale, type ImageViewPoint } from '@agentmux/client-ui/image-view-geometry'
import { useImagePan } from '@agentmux/client-ui/use-image-pan'
import { formatFileBytes } from '../format-file-bytes'
import '../styles/preview-common.css'
import '../styles/image-preview.css'
const ThemeActionZoomOutIcon = semanticIconComponent('action.zoom-out')
const ThemeActionZoomInIcon = semanticIconComponent('action.zoom-in')

/** Image viewing only. Decode, zoom and failure state belong to one content mount;
 * both file routes key it by source URL. Native load can finish before passive effects. */
export function ImageContent({ src, name, byteLength, onDecodeError }: {
  src: string; name: string; byteLength?: number; onDecodeError?: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [failed, setFailed] = useState(false)
  const { begin, move, end, dragging } = useImagePan()
  const zoomOffset = useRef<ImageViewPoint | null>(null)
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setBounds({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fit = natural ? fitImageScale(Math.max(1, bounds.width - 32), Math.max(1, bounds.height - 32), natural.width, natural.height) : 1
  const scale = zoom === 'fit' ? fit : zoom
  useLayoutEffect(() => {
    const offset = zoomOffset.current
    zoomOffset.current = null
    if (!offset || !viewport.current || !image.current) return
    viewport.current.scrollLeft = image.current.offsetLeft - offset.x
    viewport.current.scrollTop = image.current.offsetTop - offset.y
  }, [zoom])
  const changeZoom = (value: number | 'fit') => {
    end()
    const nextZoom = value === 'fit' ? value : Math.min(20, Math.max(0.1, value))
    if (nextZoom === zoom) return
    const element = viewport.current
    const picture = image.current
    const nextScale = nextZoom === 'fit' ? fit : nextZoom
    if (element && picture) zoomOffset.current = imageOffsetAtScale(
      { x: picture.offsetLeft - element.scrollLeft, y: picture.offsetTop - element.scrollTop },
      { x: element.clientWidth / 2, y: element.clientHeight / 2 }, nextScale / scale,
    )
    setZoom(nextZoom)
  }
  return (
    <div className="image-preview" data-decode-state={failed ? 'error' : natural ? 'decoded' : 'loading'}>
      <div className="image-preview__viewport" ref={viewport} tabIndex={0} aria-label={`Image ${name}`} data-dragging={dragging || undefined}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return
          if (event.key === '+' || event.key === '=') changeZoom(scale * 1.25)
          else if (event.key === '-') changeZoom(scale / 1.25)
          else if (event.key === '0' || event.key.toLowerCase() === 'f') changeZoom('fit')
          else if (event.key === '1') changeZoom(1)
          else return
          event.preventDefault()
        }}
        onPointerDown={event => {
          const element = event.currentTarget
          if (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) return
          if (!begin(event, { x: -element.scrollLeft, y: -element.scrollTop })) return
          element.focus({ preventScroll: true })
          event.preventDefault()
        }}
        onPointerMove={event => {
          const offset = move(event)
          if (!offset) return
          event.currentTarget.scrollLeft = -offset.x
          event.currentTarget.scrollTop = -offset.y
        }}
        onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
        {failed ? <div className="file-preview-state" role="alert"><strong>Image could not be decoded</strong><span>The current engine cannot display these bytes. The original file is unchanged.</span></div> : <>
          {!natural ? <div className="file-preview-state" role="status">Decoding image…</div> : null}
          <div className="image-preview__stage" style={natural ? { minWidth: natural.width * scale + 32, minHeight: natural.height * scale + 32 } : undefined}>
            <img ref={image} src={src} alt={name} draggable={false} style={natural ? { width: natural.width * scale, height: natural.height * scale } : { maxWidth: '100%', maxHeight: '100%' }}
              onLoad={event => {
                const image = event.currentTarget
                // SVG without intrinsic dimensions has a rendered viewport; do not invent natural pixels.
                const width = image.naturalWidth, height = image.naturalHeight
                if (width && height) setNatural({ width, height })
                else { setFailed(true); onDecodeError?.() }
              }} onError={() => { setFailed(true); onDecodeError?.() }} />
          </div>
        </>}
      </div>
      <footer className="image-preview__tools">
        <div className="file-preview__controls" role="group" aria-label="Image zoom">
          <button className="small-button" aria-pressed={zoom === 'fit'} disabled={!natural} title="Fit image (F or 0)" onClick={() => changeZoom('fit')}>Fit</button>
          <button className="small-button" aria-pressed={zoom === 1} disabled={!natural} title="Original size (1)" onClick={() => changeZoom(1)}>1:1</button>
          <button className="icon-button" aria-label="Zoom out" title="Zoom out (-)" disabled={!natural || scale <= 0.1} onClick={() => changeZoom(scale / 1.25)}><ThemeActionZoomOutIcon size={13} /></button>
          <output aria-label="Image zoom level">{natural ? `${Math.round(scale * 100)}%` : '—'}</output>
          <button className="icon-button" aria-label="Zoom in" title="Zoom in (+)" disabled={!natural || scale >= 20} onClick={() => changeZoom(scale * 1.25)}><ThemeActionZoomInIcon size={13} /></button>
        </div>
        <span className="file-preview__metadata">{natural ? `${natural.width.toLocaleString()} × ${natural.height.toLocaleString()}` : 'Dimensions unconfirmed'}{byteLength !== undefined ? ` · ${formatFileBytes(byteLength)}` : ''}</span>
      </footer>
    </div>
  )
}

