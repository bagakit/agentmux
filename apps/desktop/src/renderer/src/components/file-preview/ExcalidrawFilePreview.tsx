import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import type { ExcalidrawProps, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { mountExcalidrawIcons } from '../../lib/excalidraw-icons'
import { validateExcalidrawScene } from '../../lib/file-formats/excalidraw-scene'

type Scene = Awaited<ReturnType<typeof import('@excalidraw/excalidraw')['loadFromBlob']>>
type Loaded = { owner: object; Component: typeof import('@excalidraw/excalidraw')['Excalidraw']; scene: Scene }

export function ExcalidrawFilePreview({ content, visible = true }: { content: string; path?: string; workspaceId?: string; visible?: boolean }) {
  const { ref, visible: inView } = useVisibleWork<HTMLDivElement>(visible)
  const [attempt, setAttempt] = useState(0)
  const owner = useMemo(() => ({}), [content, inView, attempt])
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<{ owner: object; message: string } | null>(null)
  useEffect(() => {
    setLoaded(null)
    setFailure(null)
    if (!inView) return
    let cancelled = false
    void (async () => {
      validateExcalidrawScene(content)
      // Set before importing the package: its font registry is initialized at module load.
      ;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL('./excalidraw-assets/', document.baseURI).href
      const engine = await import('@excalidraw/excalidraw')
      if (cancelled) return
      const scene = await engine.loadFromBlob(new Blob([content], { type: 'application/vnd.excalidraw+json' }), null, null)
      if (!cancelled) setLoaded({ owner, Component: engine.Excalidraw, scene })
    })().catch(error => { if (!cancelled) setFailure({ owner, message: error instanceof Error ? error.message : String(error) }) })
    return () => { cancelled = true }
  }, [content, inView, owner])
  if (!visible) return null
  return <div ref={ref} style={{ width: '100%', height: '100%', minHeight: 320 }}>
    {inView && failure?.owner === owner ? <div className="file-preview-state" role="alert"><strong>Excalidraw preview could not load</strong><span>{failure.message}</span><button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>
      : inView && loaded?.owner === owner ? <ReadOnlyScene loaded={loaded} />
        : <div className="file-preview-state" role="status">Preparing Excalidraw preview…</div>}
  </div>
}

function ReadOnlyScene({ loaded }: { loaded: Loaded }) {
  useEffect(() => mountExcalidrawIcons(), [])
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
