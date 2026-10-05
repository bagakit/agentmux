import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExcalidrawProps, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { validateExcalidrawScene } from '../../lib/file-formats/excalidraw-scene'

type Scene = Awaited<ReturnType<typeof import('@excalidraw/excalidraw')['loadFromBlob']>>
type Loaded = { content: string; Component: typeof import('@excalidraw/excalidraw')['Excalidraw']; scene: Scene }

export function ExcalidrawFilePreview({ content, visible = true }: { content: string; path?: string; workspaceId?: string; visible?: boolean }) {
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<{ content: string; message: string } | null>(null)
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoaded(null)
    setFailure(null)
    void (async () => {
      validateExcalidrawScene(content)
      // Set before importing the package: its font registry is initialized at module load.
      ;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL('./excalidraw-assets/', document.baseURI).href
      const engine = await import('@excalidraw/excalidraw')
      if (cancelled) return
      const scene = await engine.loadFromBlob(new Blob([content], { type: 'application/vnd.excalidraw+json' }), null, null)
      if (!cancelled) setLoaded({ content, Component: engine.Excalidraw, scene })
    })().catch(error => { if (!cancelled) setFailure({ content, message: error instanceof Error ? error.message : String(error) }) })
    return () => { cancelled = true }
  }, [content, visible, attempt])
  if (!visible) return null
  if (failure?.content === content) return <div className="file-preview-state" role="alert"><strong>Excalidraw preview could not load</strong><span>{failure.message}</span><button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>
  if (loaded?.content !== content) return <div className="file-preview-state" role="status">Preparing Excalidraw preview…</div>
  return <ReadOnlyScene loaded={loaded} />
}

function ReadOnlyScene({ loaded }: { loaded: Loaded }) {
  const container = useRef<HTMLDivElement>(null), api = useRef<ExcalidrawImperativeAPI | null>(null), frame = useRef<number | null>(null)
  const fit = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      api.current?.refresh()
      // Excalidraw's own viewport observer commits dimensions before fitting.
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        api.current?.scrollToContent(undefined, { fitToContent: true, viewportZoomFactor: .85, animate: false })
      })
    })
  }, [])
  const setApi = useCallback((value: ExcalidrawImperativeAPI) => { api.current = value; fit() }, [fit])
  useEffect(() => {
    const observer = new ResizeObserver(fit)
    if (container.current) observer.observe(container.current)
    fit()
    return () => { observer.disconnect(); if (frame.current !== null) cancelAnimationFrame(frame.current); api.current = null }
  }, [fit])
  const Component = loaded.Component
  const initialData: ExcalidrawProps['initialData'] = { ...loaded.scene, scrollToContent: true }
  return <div ref={container} className="file-excalidraw-preview" style={{ width: '100%', height: '100%', minHeight: 320 }}>
    <Component initialData={initialData} excalidrawAPI={setApi} viewModeEnabled zenModeEnabled handleKeyboardGlobally={false} autoFocus={false} isCollaborating={false}
      validateEmbeddable={false} onPaste={() => false} onLinkOpen={(_element, event) => event.preventDefault()}
      UIOptions={{ canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false, toggleTheme: false } }} />
  </div>
}
