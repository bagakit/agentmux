import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, FolderOpen, Minus, Plus, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { revealInFileManagerLabel } from '../lib/host-platform'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

type PreviewResult = Awaited<ReturnType<typeof api.files.readPreview>>
type ReadyPreview = Extract<PreviewResult, { status: 'ready' }>
type LoadedPreview = Omit<ReadyPreview, 'bytes'> & { url: string; owner: string }

export function formatFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`
}

/** Image viewing only: native decoding, one view's geometry and no file/content ownership. */
export function ImageContent({ src, name, byteLength, onDecodeError }: {
  src: string; name: string; byteLength?: number; onDecodeError?: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [failed, setFailed] = useState(false)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  useEffect(() => { setNatural(null); setZoom('fit'); setFailed(false) }, [src])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setBounds({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fit = natural ? Math.min(1, Math.max(1, bounds.width - 32) / natural.width, Math.max(1, bounds.height - 32) / natural.height) : 1
  const scale = zoom === 'fit' ? fit : zoom
  const changeZoom = (value: number | 'fit') => {
    const element = viewport.current
    const nextScale = value === 'fit' ? fit : Math.min(20, Math.max(0.1, value))
    const centerX = element ? (element.scrollLeft + element.clientWidth / 2) / scale : 0
    const centerY = element ? (element.scrollTop + element.clientHeight / 2) / scale : 0
    setZoom(value === 'fit' ? value : nextScale)
    requestAnimationFrame(() => {
      if (viewport.current !== element || !element) return
      element.scrollLeft = centerX * nextScale - element.clientWidth / 2
      element.scrollTop = centerY * nextScale - element.clientHeight / 2
    })
  }
  return (
    <div className="image-preview" data-decode-state={failed ? 'error' : natural ? 'decoded' : 'loading'}>
      <div className="image-preview__viewport" ref={viewport} tabIndex={0} aria-label={`Image ${name}`}
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
          if (event.button !== 0 || (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)) return
          drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
          element.setPointerCapture(event.pointerId)
          element.focus()
          event.preventDefault()
        }}
        onPointerMove={event => {
          const start = drag.current
          if (!start) return
          event.currentTarget.scrollLeft = start.left - event.clientX + start.x
          event.currentTarget.scrollTop = start.top - event.clientY + start.y
        }}
        onPointerUp={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}>
        {failed ? <div className="file-preview-state" role="alert"><strong>Image could not be decoded</strong><span>The current engine cannot display these bytes. The original file is unchanged.</span></div> : <>
          {!natural ? <div className="file-preview-state" role="status">Decoding image…</div> : null}
          <div className="image-preview__stage" style={natural ? { minWidth: natural.width * scale + 32, minHeight: natural.height * scale + 32 } : undefined}>
            <img src={src} alt={name} draggable={false} style={natural ? { width: natural.width * scale, height: natural.height * scale } : { maxWidth: '100%', maxHeight: '100%' }}
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
          <button className="icon-button" aria-label="Zoom out" disabled={!natural || scale <= 0.1} onClick={() => changeZoom(scale / 1.25)}><Minus size={13} /></button>
          <output aria-label="Image zoom level">{natural ? `${Math.round(scale * 100)}%` : '—'}</output>
          <button className="icon-button" aria-label="Zoom in" disabled={!natural || scale >= 20} onClick={() => changeZoom(scale * 1.25)}><Plus size={13} /></button>
        </div>
        <span className="file-preview__metadata">{natural ? `${natural.width.toLocaleString()} × ${natural.height.toLocaleString()}` : 'Dimensions unconfirmed'}{byteLength !== undefined ? ` · ${formatFileBytes(byteLength)}` : ''}</span>
      </footer>
    </div>
  )
}

function MediaContent({ preview, name }: { preview: LoadedPreview; name: string }) {
  const player = useRef<HTMLMediaElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  useEffect(() => {
    setState('loading')
    const element = player.current
    return () => { element?.pause(); element?.removeAttribute('src'); element?.load() }
  }, [preview.url])
  const events = { onLoadedMetadata: () => setState('ready'), onError: () => setState('error') }
  return <div className={`file-media file-media--${preview.kind}`} data-decode-state={state}>
    {state === 'error' ? <div className="file-preview-state" role="alert"><strong>Media could not be decoded</strong><span>The current engine cannot play this file’s format or codec. Try opening it in a system application.</span></div> : null}
    {preview.kind === 'audio'
      ? <audio ref={element => { player.current = element }} aria-label={name} src={preview.url} controls preload="metadata" {...events} />
      : <video ref={element => { player.current = element }} aria-label={name} src={preview.url} controls preload="metadata" {...events} />}
    <span className="file-preview__metadata">{state === 'loading' ? 'Reading media metadata · ' : ''}{formatFileBytes(preview.byteLength)}</span>
  </div>
}

export function FilePreviewPane({ surface, visible = true, onRetryBinary }: { surface: FileWorkbenchSurface; visible?: boolean; onRetryBinary?: () => void }) {
  const key = documentKey(surface.workspaceId, surface.path)
  const binary = useAppStore(state => state.documentIssues[key]?.kind === 'binary' ? state.documentIssues[key] : null)
  const canOpenExternally = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId)?.hostId === 'local')
  const reportError = useAppStore(state => state.reportError)
  const [loaded, setPreview] = useState<LoadedPreview | null>(null)
  const [failed, setFailure] = useState<{ owner: string; status: string; message: string } | null>(null)
  // Render-time identity prevents even the commit before passive cleanup from labeling old bytes as a new file.
  const preview = visible && loaded?.owner === key ? loaded : null
  const failure = visible && failed?.owner === key ? failed : null
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setPreview(null); setFailure(null)
    if (!visible || binary) return
    let cancelled = false, url: string | null = null
    void api.files.readPreview(surface.workspaceId, surface.path).then(result => {
      if (cancelled) return
      if (result.status !== 'ready') {
        setFailure({ owner: key, status: result.status, message: 'message' in result ? result.message : 'This path is a directory, not a file.' })
        return
      }
      url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes).buffer], { type: result.mimeType }))
      const { bytes: _bytes, ...facts } = result
      setPreview({ ...facts, url, owner: key })
    }).catch(error => {
      if (!cancelled) setFailure({ owner: key, status: 'unavailable', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [surface.workspaceId, surface.path, visible, binary, attempt])
  const external = async (action: 'openSystem' | 'reveal') => {
    try { await api.files[action](surface.workspaceId, surface.path) } catch (error) { reportError(error) }
  }
  return <section className="file-preview-pane" data-preview-state={binary ? 'binary' : failure?.status ?? (preview ? 'loaded' : visible ? 'loading' : 'inactive')}>
    <header className="editor-header file-preview__header">
      <span title={surface.path}>{surface.path}</span>
      <div className="editor-header__actions">
        {!binary || onRetryBinary ? <button className="icon-button" aria-label="Reload file preview" title="Reload file preview" onClick={() => binary ? onRetryBinary?.() : setAttempt(value => value + 1)}><RefreshCw size={13} /></button> : null}
        {canOpenExternally ? <>
          <button className="icon-button" aria-label="Open file in system application" title="Open in system application" onClick={() => void external('openSystem')}><ArrowUpRight size={13} /></button>
          <button className="icon-button" aria-label={revealInFileManagerLabel()} title={revealInFileManagerLabel()} onClick={() => void external('reveal')}><FolderOpen size={13} /></button>
        </> : null}
      </div>
    </header>
    {binary ? <div className="file-preview-state"><strong>Binary file</strong><span>This file has no editable text content. Open it in a system application to inspect it.</span>{binary.kind === 'binary' ? <span className="file-preview__metadata">{formatFileBytes(binary.byteLength)}</span> : null}</div>
      : failure ? <div className="file-preview-state" role="alert"><strong>{failure.status === 'too-large' ? 'File exceeds the preview budget' : failure.status === 'deleted' ? 'File was deleted' : failure.status === 'changed' ? 'File changed while reading' : failure.status === 'directory' ? 'This path is a directory' : 'Preview unavailable'}</strong><span>{failure.message}</span><button className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>
      : !preview ? <div className="file-preview-state" role="status">{visible ? 'Reading file…' : 'Preview paused while hidden'}</div>
      : preview.kind === 'image' ? <ImageContent key={preview.url} src={preview.url} name={surface.path} byteLength={preview.byteLength} />
      : preview.kind === 'pdf' ? <embed className="file-preview__pdf" src={preview.url} type="application/pdf" title={`PDF ${surface.path}`} />
      : <MediaContent key={preview.url} preview={preview} name={surface.path} />}
  </section>
}
