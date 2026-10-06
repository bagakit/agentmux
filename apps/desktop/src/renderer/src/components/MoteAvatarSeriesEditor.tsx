import { useEffect, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MOTE_FACE_PARTS, type MoteFace as Face } from '@agentmux/core/mote-face'
import type { MoteAvatarSeriesCatalog, MoteAvatarSeriesChoice, MoteAvatarSeriesDefinition, MoteAvatarSeriesLocator,
  MoteAvatarSeriesParameters, MoteAvatarSeriesPrepared, MoteAvatarSeriesSource } from '@agentmux/core/mote-avatar-series'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { createSeriesGlbRenderer, type SeriesGlbRenderer } from '../lib/mote-avatar-series-renderer'
import { MoteFace } from './MoteFace'
import { MoteAvatarSeriesCreateDialog } from './MoteAvatarSeriesCreateDialog'
import '../styles/mote-avatar-series.css'

const ThemeObjectModel3dIcon = semanticIconComponent('object.model-3d')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeFileImageIcon = semanticIconComponent('file.image')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionResetOptionsIcon = semanticIconComponent('action.reset-options')
const ThemeObjectProfileIcon = semanticIconComponent('object.profile')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')

export type MoteAvatarSeriesDraft = { source: MoteAvatarSeriesSource; definition: MoteAvatarSeriesDefinition;
  parameters: MoteAvatarSeriesParameters; pngDataUrl: string }
type Series = MoteAvatarSeriesCatalog['series'][number]
type Entry = Series['entries'][number]
const locatorKey = (source: MoteAvatarSeriesLocator) => JSON.stringify([source.origin, source.seriesId, source.entryId])
const seriesKey = (source: Pick<MoteAvatarSeriesLocator, 'origin' | 'seriesId'>) => JSON.stringify([source.origin, source.seriesId])
const faceLabels = { shape: 'Face', palette: 'Color', eyes: 'Eyes', brows: 'Brows', mouth: 'Mouth', accessory: 'Detail', nose: 'Nose', marking: 'Marks' }
const materialModes = [{ id: 'hybrid', label: 'Graphic chrome' }, { id: 'chrome', label: 'Chrome' }, { id: 'toon', label: 'Toon' }, { id: 'original', label: 'Original' }] as const
function initialParameters(definition: MoteAvatarSeriesDefinition): MoteAvatarSeriesParameters {
  if (definition.kind === 'image') return { kind: 'image', zoom: 1, offsetX: 0, offsetY: 0 }
  if (definition.kind === 'face2d') return { kind: 'face2d', face: { ...definition.face } }
  return { kind: 'glb', mode: definition.materials?.some(value => value.role === 'shell') ? 'hybrid' : 'original',
    roughness: 0.24, color: '#cbd5dd', yaw: 0, morphs: Object.fromEntries((definition.morphs ?? []).map(value => [value.id, 0])) }
}
function imageLayout(image: HTMLImageElement, parameters: Extract<MoteAvatarSeriesParameters, { kind: 'image' }>) {
  const scale = Math.max(256 / image.naturalWidth, 256 / image.naturalHeight) * parameters.zoom
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale
  return { width, height, x: (256 - width) / 2 + parameters.offsetX * (width - 256) / 2,
    y: (256 - height) / 2 + parameters.offsetY * (height - 256) / 2 }
}

function SeriesEntryThumbnail({ source, entry, visible }: { source: MoteAvatarSeriesLocator; entry: Entry; visible: boolean }) {
  const key = locatorKey(source)
  const [thumbnail, setThumbnail] = useState<{ key: string; image: string | null; unavailable: boolean } | null>(null)
  const image = thumbnail?.key === key ? thumbnail.image : null
  const unavailable = thumbnail?.key === key && thumbnail.unavailable
  const element = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!visible || entry.definition.kind !== 'image' || !element.current) return
    let alive = true, requested = false, inView = false
    setThumbnail(null)
    const request = () => {
      if (requested || document.hidden || !inView) return
      requested = true
      void api.moteAvatars.preview({ source }).then(value => {
        if (alive && value.payload.kind === 'image') setThumbnail({ key, image: value.payload.image.dataUrl, unavailable: false })
      }).catch(() => { if (alive) setThumbnail({ key, image: null, unavailable: true }) })
    }
    const observer = new IntersectionObserver(entries => { inView = entries.some(value => value.isIntersecting); request() })
    observer.observe(element.current)
    document.addEventListener('visibilitychange', request)
    return () => { alive = false; observer.disconnect(); document.removeEventListener('visibilitychange', request) }
  }, [visible, locatorKey(source), entry.definition])
  return <span ref={element} className="mote-series__thumbnail" aria-hidden="true" data-preview-state={unavailable ? 'unavailable' : image ? 'ready' : 'metadata'} title={unavailable ? 'Preview unavailable. Select to retry.' : undefined}>
    {image ? <img src={image} alt="" /> : entry.definition.kind === 'face2d' ? <MoteFace face={entry.definition.face} />
      : entry.definition.kind === 'glb' ? <ThemeObjectModel3dIcon size={21} /> : <ThemeFileImageIcon size={21} />}
    {unavailable ? <span className="mote-series__thumbnail-status"><ThemeStatusUnknownIcon size={11} /></span> : null}
  </span>
}

/** Prepared drafts remain local. Only the original Picker's explicit save may publish them. */
export function MoteAvatarSeriesEditor({ targetKey, visible, disabled, initialChoice, initialImage, savedImageConfirmed = false, onDraft, onPreparing }: {
  targetKey: string; visible: boolean; disabled: boolean; initialChoice?: Pick<MoteAvatarSeriesChoice, 'source' | 'definition' | 'parameters'> | null; initialImage?: string | null; savedImageConfirmed?: boolean;
  onDraft(draft: MoteAvatarSeriesDraft | null): void; onPreparing?(preparing: boolean): void
}) {
  const [catalog, setCatalog] = useState<MoteAvatarSeriesCatalog | null>(null)
  const [selectedSeries, setSelectedSeries] = useState(initialChoice ? seriesKey(initialChoice.source) : '')
  const [prepared, setPrepared] = useState<MoteAvatarSeriesPrepared | null>(null)
  const [parameters, setParameters] = useState<MoteAvatarSeriesParameters | null>(null)
  const [png, setPng] = useState<string | null>(initialImage ?? null)
  const [preparing, setPreparing] = useState(false), [rendering, setRendering] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [canvasGeneration, setCanvasGeneration] = useState(0)
  const [pending, setPending] = useState<string | null>(null)
  const [issue, setIssue] = useState<{ scope: 'catalog' | 'source' | 'render'; detail: string } | null>(null)
  const [renderVersion, setRenderVersion] = useState(0), [paintVersion, setPaintVersion] = useState(0), [renderAttempt, setRenderAttempt] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null), face = useRef<HTMLDivElement>(null), preview = useRef<HTMLDivElement>(null)
  const controller = useRef<SeriesGlbRenderer | null>(null), bitmap = useRef<HTMLImageElement | null>(null)
  const catalogRequest = useRef(0), sourceRequest = useRef(0), frameRequest = useRef(0)
  const selectionIntent = useRef(0)
  const originalTarget = useRef(targetKey); originalTarget.current = targetKey
  const alive = useRef(true), intersecting = useRef(true), raf = useRef<number | null>(null)
  const draftCallback = useRef(onDraft); draftCallback.current = onDraft
  const lastGood = useRef<{ prepared: MoteAvatarSeriesPrepared; parameters: MoteAvatarSeriesParameters; png: string; draft: MoteAvatarSeriesDraft } | null>(null)
  const lastSourceRequest = useRef<{ source: MoteAvatarSeriesLocator; expectedRevision?: string } | null>(null)
  const initial = useRef(initialChoice); initial.current = initialChoice
  const pointer = useRef<{ id: number; x: number; y: number; parameters: MoteAvatarSeriesParameters } | null>(null)
  const cancelPaint = () => { if (raf.current !== null) cancelAnimationFrame(raf.current); raf.current = null }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; catalogRequest.current++; sourceRequest.current++; frameRequest.current++; cancelPaint() }
  }, [targetKey])
  useEffect(() => { onPreparing?.(preparing || rendering); return () => onPreparing?.(false) }, [preparing, rendering, onPreparing])

  async function loadCatalog(prefer?: Pick<MoteAvatarSeriesLocator, 'origin' | 'seriesId'>) {
    const request = ++catalogRequest.current, target = targetKey, intent = selectionIntent.current
    setCatalogLoading(true)
    try {
      const value = await api.moteAvatars.list()
      if (!alive.current || request !== catalogRequest.current || originalTarget.current !== target) return false
      setCatalog(value)
      const chosen = prefer && value.series.find(series => seriesKey(series) === seriesKey(prefer))
      setSelectedSeries(previous => chosen && intent === selectionIntent.current ? seriesKey(chosen) : previous || (value.series[0] ? seriesKey(value.series[0]) : ''))
      setIssue(previous => previous?.scope === 'catalog' ? null : previous)
      return !prefer || Boolean(chosen)
    } catch (error) {
      if (alive.current && request === catalogRequest.current && originalTarget.current === target) setIssue({ scope: 'catalog', detail: presentError(error) })
      return false
    } finally { if (alive.current && request === catalogRequest.current && originalTarget.current === target) setCatalogLoading(false) }
  }
  async function prepareSource(source: MoteAvatarSeriesLocator, expectedRevision?: string) {
    const request = ++sourceRequest.current, target = targetKey
    const locator = { origin: source.origin, seriesId: source.seriesId, entryId: source.entryId }
    const input = { source: locator, ...(expectedRevision ? { expectedRevision } : {}) }; lastSourceRequest.current = input
    setPreparing(true); setPending(locatorKey(source))
    try {
      const value = await api.moteAvatars.preview(input)
      if (!alive.current || request !== sourceRequest.current || originalTarget.current !== target) return
      const saved = initial.current
      const next = saved && locatorKey(saved.source) === locatorKey(value.source) && saved.source.revision === value.source.revision
        ? structuredClone(saved.parameters) : initialParameters(value.definition)
      frameRequest.current++; draftCallback.current(null); setPng(null)
      setCanvasGeneration(generation => generation + 1)
      setPrepared(value); setParameters(next); setIssue(null)
    } catch (error) {
      if (alive.current && request === sourceRequest.current && originalTarget.current === target) setIssue({ scope: 'source', detail: presentError(error) })
    } finally {
      if (alive.current && request === sourceRequest.current && originalTarget.current === target) { setPreparing(false); setPending(null) }
    }
  }
  useEffect(() => {
    if (!visible) { setPreparing(false); setPending(null); setRendering(false); return }
    void loadCatalog()
    if (initialChoice && !prepared) void prepareSource(initialChoice.source, initialChoice.source.revision)
    return () => { sourceRequest.current++; catalogRequest.current++; cancelPaint() }
  }, [visible, targetKey])

  useEffect(() => {
    if (!visible || !preview.current) return
    const observer = new IntersectionObserver(entries => {
      intersecting.current = entries.some(value => value.isIntersecting)
      if (!intersecting.current) cancelPaint()
      else setPaintVersion(value => value + 1)
    })
    observer.observe(preview.current)
    const visibility = () => { if (document.hidden) cancelPaint(); else setPaintVersion(value => value + 1) }
    document.addEventListener('visibilitychange', visibility)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', visibility); cancelPaint() }
  }, [visible, Boolean(prepared)])

  function renderFailure(source: MoteAvatarSeriesPrepared, detail: string) {
    const known = lastGood.current
    if (known && known.prepared !== source) {
      frameRequest.current++; cancelPaint()
      setPrepared(known.prepared); setParameters(structuredClone(known.parameters)); setPng(known.png)
      draftCallback.current(known.draft)
      setIssue({ scope: 'source', detail })
    } else setIssue({ scope: 'render', detail })
    setRendering(false)
  }

  useEffect(() => {
    if (!visible || !prepared || !canvas.current) return
    const target = targetKey, source = prepared, abort = new AbortController()
    let current = true
    setRendering(true)
    const valid = () => current && alive.current && originalTarget.current === target
    const failed = (detail: string) => { if (valid()) renderFailure(source, detail) }
    if (source.definition.kind === 'glb' && source.payload.kind === 'glb') {
      void createSeriesGlbRenderer(canvas.current, source.definition, source.payload.dataBase64, failed,
        () => { if (valid()) { setIssue(null); setRenderVersion(value => value + 1) } }, abort.signal).then(value => {
          if (!valid()) { value.dispose(); return }
          controller.current = value; setRenderVersion(version => version + 1)
        }).catch(error => { if (valid() && !abort.signal.aborted) failed(presentError(error)) })
    } else if (source.payload.kind === 'image') {
      const image = new Image()
      image.onload = () => { if (valid()) { bitmap.current = image; setRenderVersion(version => version + 1) } }
      image.onerror = () => failed('This image could not be decoded. Retry the preview or choose another source.')
      image.src = source.payload.image.dataUrl
    } else setRenderVersion(version => version + 1)
    return () => {
      current = false; abort.abort(); frameRequest.current++; cancelPaint()
      controller.current?.dispose(); controller.current = null; bitmap.current = null
    }
  }, [visible, prepared, renderAttempt, targetKey])

  useEffect(() => {
    if (!visible || !prepared || !parameters || !canvas.current || document.hidden || !intersecting.current) return
    const source = prepared, value = parameters, target = targetKey, request = ++frameRequest.current
    const valid = () => alive.current && request === frameRequest.current && originalTarget.current === target
    function finished(dataUrl: string) {
      if (!valid()) return
      setPng(dataUrl); setRendering(false); setIssue(previous => previous?.scope === 'render' ? null : previous)
      const draft = { source: source.source, definition: source.definition, parameters: structuredClone(value), pngDataUrl: dataUrl }
      lastGood.current = { prepared: source, parameters: structuredClone(value), png: dataUrl, draft }
      draftCallback.current(draft)
    }
    raf.current = requestAnimationFrame(() => {
      raf.current = null
      if (!valid() || document.hidden || !intersecting.current || !canvas.current) return
      try {
        if (value.kind === 'glb') {
          if (!controller.current) return
          const dataUrl = controller.current.render(value), facts = controller.current.snapshot()
          canvas.current.dataset.seriesRenderFacts = JSON.stringify(facts)
          canvas.current.dataset.seriesFrameSource = JSON.stringify(source.source)
          finished(dataUrl)
        } else {
          const context = canvas.current.getContext('2d')
          if (!context) throw new Error('The avatar image canvas is unavailable.')
          if (value.kind === 'image') {
            if (!bitmap.current) return
            const layout = imageLayout(bitmap.current, value)
            context.clearRect(0, 0, 256, 256); context.drawImage(bitmap.current, layout.x, layout.y, layout.width, layout.height)
            finished(canvas.current.toDataURL('image/png'))
          } else {
            const original = face.current?.querySelector('svg')
            if (!original) return
            const svg = original.cloneNode(true) as SVGSVGElement
            // The face's HTML articulation needs its layout outside the page's
            // stylesheet too. Carry the neutral preview's original coordinates.
            const layoutParts = '.mote-face__articulation, .mote-face__model, .mote-face__bone, .mote-face__drawing'
            const copies = svg.querySelectorAll<HTMLElement | SVGElement>(layoutParts)
            original.querySelectorAll<HTMLElement | SVGElement>(layoutParts).forEach((node, index) => {
              const style = getComputedStyle(node)
              for (const property of ['display', 'position', 'left', 'top', 'width', 'height', 'overflow', 'transform', 'transform-origin', 'transform-box']) {
                copies[index]!.style.setProperty(property, style.getPropertyValue(property))
              }
            })
            svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('width', '256'); svg.setAttribute('height', '256')
            const image = new Image()
            image.onload = () => {
              if (!valid() || !canvas.current) return
              context.clearRect(0, 0, 256, 256); context.drawImage(image, 0, 0, 256, 256)
              finished(canvas.current.toDataURL('image/png'))
            }
            image.onerror = () => { if (valid()) renderFailure(source, 'The face image could not be rendered. Retry the preview.') }
            image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg))
          }
        }
      } catch (error) { if (valid()) renderFailure(source, presentError(error)) }
    })
    return () => { frameRequest.current++; cancelPaint() }
  }, [visible, prepared, parameters, renderVersion, paintVersion, targetKey])

  function changeParameters(next: MoteAvatarSeriesParameters) {
    // Editing the retained source is a newer local intent than a pending candidate.
    sourceRequest.current++; setPreparing(false); setPending(null)
    frameRequest.current++; draftCallback.current(null)
    setParameters(next)
  }
  function retry() {
    if (issue?.scope === 'catalog') void loadCatalog()
    else if (issue?.scope === 'source' && lastSourceRequest.current) void prepareSource(lastSourceRequest.current.source, lastSourceRequest.current.expectedRevision)
    else if (controller.current) {
      try { controller.current.retry() } catch (error) { setIssue({ scope: 'render', detail: presentError(error) }) }
    } else setRenderAttempt(value => value + 1)
  }
  const selected = catalog?.series.find(value => seriesKey(value) === selectedSeries)
  // Built-in 2D presets reuse Make a face. Keep original saved/request drafts
  // editable; user collections remain complete, including mixed face/image sets.
  const entries = selected?.entries.filter(entry => selected.origin !== 'builtin' || entry.definition.kind !== 'face2d' ||
    [initialChoice?.source, prepared?.source].some(source => source && locatorKey(source) === locatorKey({ ...selected, entryId: entry.entryId }))) ?? []
  const controlsDisabled = disabled
  const partial = Boolean(catalog?.issues.length || prepared?.issues.length || catalog?.roots.some(root => root.state === 'unavailable' || root.origin === 'builtin' && root.state === 'missing'))
  return <section className="mote-series" hidden={!visible} aria-label="Avatar series" data-series-target={targetKey}>
    <div className="mote-series__catalog">
      <div className="mote-series__selector-row"><label className="mote-series__select">Series<select aria-label="Avatar series" disabled={disabled || catalogLoading} value={selectedSeries}
        onChange={event => { selectionIntent.current++; setSelectedSeries(event.currentTarget.value) }}>
        {!selected ? <option value={selectedSeries}>{initialChoice ? initialChoice.source.seriesId : 'Choose a series'}</option> : null}
        {catalog?.series.map(value => <option key={seriesKey(value)} value={seriesKey(value)}>{value.title}{value.origin === 'user' ? ' · Your collection' : ''}</option>)}
      </select></label>
      <MoteAvatarSeriesCreateDialog disabled={disabled} rootPath={catalog?.roots.find(root => root.origin === 'user')?.path}
        onUse={async created => {
          selectionIntent.current++
          if (!await loadCatalog({ origin: 'user', seriesId: created.seriesId })) throw new Error('The created folder is kept. Refresh its original source to browse it; your current avatar and draft remain available.')
        }} />
      <button type="button" className="small-button mote-series__refresh" aria-label="Refresh avatar series" disabled={disabled || catalogLoading} onClick={() => void loadCatalog()}><ThemeActionRefreshIcon size={12} />Refresh</button>
      </div>
      {catalogLoading ? <p className="mote-series__status" role="status">Loading series…</p> : null}
      {selected ? <div className="mote-series__entries" role="group" aria-label="Series appearances">{entries.map(entry => {
        const source = { origin: selected.origin, seriesId: selected.seriesId, entryId: entry.entryId }
        const active = Boolean(prepared && locatorKey(source) === locatorKey(prepared.source))
        return <button type="button" className="mote-series__entry" key={entry.entryId} aria-pressed={active}
          disabled={disabled} data-series-origin={source.origin} data-series-id={source.seriesId} data-series-entry={source.entryId}
          aria-label={`${entry.title} · ${entry.definition.kind === 'glb' ? '3D' : entry.definition.kind === 'face2d' ? 'Face' : 'Image'}`}
          onClick={() => void prepareSource(source)}>
          <SeriesEntryThumbnail source={source} entry={entry} visible={visible} />
          <span><strong>{entry.title}</strong><small>{pending === locatorKey(source) ? 'Loading…' : entry.definition.kind === 'glb' ? '3D' : entry.definition.kind === 'face2d' ? 'Face' : 'Image'}</small></span>
          {active ? <ThemeStatusSelectedIcon size={13} className="mote-series__check" aria-hidden="true" /> : null}
        </button>
      })}</div> : !catalogLoading && catalog ? <p className="mote-series__status">No series yet. Add PNG or JPG images to your avatar folder.</p> : null}
    </div>
    <div className="mote-series__workspace">
      <div className="mote-series__artwork">
        <div ref={preview} className="mote-series__preview" data-series-preview-kind={prepared?.definition.kind ?? 'empty'}>
          {prepared && visible ? <>
            <canvas key={JSON.stringify(prepared.source) + ':' + canvasGeneration} ref={canvas} width={256} height={256}
              className={parameters?.kind === 'face2d' ? 'mote-series__export' : ''} role="img" aria-label="Current series avatar preview"
              onPointerDown={event => {
                if (controlsDisabled || !parameters || parameters.kind === 'face2d') return
                event.currentTarget.setPointerCapture(event.pointerId)
                pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, parameters: structuredClone(parameters) }
              }} onPointerMove={event => {
                const start = pointer.current
                if (controlsDisabled || !start || start.id !== event.pointerId) return
                const distance = 256 / event.currentTarget.getBoundingClientRect().width
                if (start.parameters.kind === 'glb') changeParameters({ ...start.parameters,
                  yaw: Math.max(-Math.PI, Math.min(Math.PI, start.parameters.yaw + (event.clientX - start.x) * distance / 65)) })
                else if (start.parameters.kind === 'image' && bitmap.current) {
                  const layout = imageLayout(bitmap.current, start.parameters)
                  changeParameters({ ...start.parameters,
                    offsetX: Math.max(-1, Math.min(1, start.parameters.offsetX + (layout.width > 256 ? (event.clientX - start.x) * distance * 2 / (layout.width - 256) : 0))),
                    offsetY: Math.max(-1, Math.min(1, start.parameters.offsetY + (layout.height > 256 ? (event.clientY - start.y) * distance * 2 / (layout.height - 256) : 0))) })
                }
              }} onPointerUp={() => { pointer.current = null }} onPointerCancel={() => { pointer.current = null }} />
            {parameters?.kind === 'face2d' ? <div ref={face} className="mote-series__face" role="img" aria-label="Current series face preview"><MoteFace face={parameters.face} /></div> : null}
          </> : png ? <img src={png} alt="Your saved series avatar" /> : <div className="mote-series__empty"><ThemeObjectProfileIcon size={30} /><span>Choose a character</span></div>}
        </div>
        <div className="mote-series__preview-note"><span>{preparing ? 'Preparing source…' : rendering ? 'Preparing preview…' : parameters?.kind === 'glb' ? 'Drag to turn' : parameters?.kind === 'image' ? 'Drag to position' : savedImageConfirmed && !prepared ? 'Saved avatar' : 'Your draft'}</span>
          {parameters && prepared ? <button type="button" className="small-button" disabled={controlsDisabled} aria-label="Reset series adjustments"
            onClick={() => changeParameters(initialChoice && locatorKey(initialChoice.source) === locatorKey(prepared.source) && initialChoice.source.revision === prepared.source.revision ? structuredClone(initialChoice.parameters) : initialParameters(prepared.definition))}><ThemeActionResetOptionsIcon size={12} />Reset</button> : null}</div>
        <div className="mote-series__sizes" aria-label="Actual avatar sizes">{[24, 34, 48, 104].map(size => <figure key={size}>
          <div className="mote-series__size-slot">{png ? <img src={png} alt={`${size} pixel avatar`} width={size} height={size} /> : <span style={{ width: size, height: size }} />}</div><figcaption>{size} px</figcaption>
        </figure>)}</div>
      </div>
      {parameters ? <div className="mote-series__controls" aria-label="Series adjustments">
        {parameters.kind === 'image' ? <>
          <label>Zoom<input aria-label="Series image zoom" type="range" min="1" max="3" step="0.02" value={parameters.zoom} disabled={controlsDisabled}
            onChange={event => changeParameters({ ...parameters, zoom: Number(event.currentTarget.value) })} /></label>
          <label>Horizontal<input aria-label="Series image horizontal position" type="range" min="-1" max="1" step="0.02" value={parameters.offsetX} disabled={controlsDisabled}
            onChange={event => changeParameters({ ...parameters, offsetX: Number(event.currentTarget.value) })} /></label>
          <label>Vertical<input aria-label="Series image vertical position" type="range" min="-1" max="1" step="0.02" value={parameters.offsetY} disabled={controlsDisabled}
            onChange={event => changeParameters({ ...parameters, offsetY: Number(event.currentTarget.value) })} /></label>
        </> : parameters.kind === 'face2d' ? (Object.keys(MOTE_FACE_PARTS) as Array<keyof typeof MOTE_FACE_PARTS>).map(part =>
          <label key={part}>{faceLabels[part]}<select aria-label={`Series face ${faceLabels[part]}`} value={parameters.face[part] ?? 'none'} disabled={controlsDisabled}
            onChange={event => changeParameters({ kind: 'face2d', face: { ...parameters.face, [part]: event.currentTarget.value } as Face })}>
            {MOTE_FACE_PARTS[part].map(value => <option key={value} value={value}>{value}</option>)}</select></label>) : <>
          <fieldset><legend>Material</legend><div className="mote-series__materials">{materialModes.filter(mode => mode.id !== 'hybrid' || prepared?.definition.kind === 'glb' && prepared.definition.materials?.length).map(mode =>
            <button type="button" className="small-button" key={mode.id} aria-pressed={parameters.mode === mode.id} disabled={controlsDisabled}
              data-series-material={mode.id} onClick={() => changeParameters({ ...parameters, mode: mode.id })}>{mode.label}</button>)}</div></fieldset>
          {prepared?.definition.kind === 'glb' && prepared.definition.materials?.some(value => value.role === 'shell') ? <label>Color<input type="color" aria-label="Series shell color" value={parameters.color} disabled={controlsDisabled || parameters.mode === 'original'} onChange={event => changeParameters({ ...parameters, color: event.currentTarget.value })} /></label> : null}
          <label>Reflection<input aria-label="Series reflection softness" type="range" min="0" max="1" step="0.01" value={parameters.roughness}
            disabled={controlsDisabled || parameters.mode === 'original' || parameters.mode === 'toon'} onChange={event => changeParameters({ ...parameters, roughness: Number(event.currentTarget.value) })} /></label>
          <label>View<input aria-label="Series model rotation" type="range" min={-Math.PI} max={Math.PI} step="0.01" value={parameters.yaw} disabled={controlsDisabled}
            onChange={event => changeParameters({ ...parameters, yaw: Number(event.currentTarget.value) })} /></label>
          {prepared?.definition.kind === 'glb' ? prepared.definition.morphs?.map(control => <label key={control.id}>{control.label}<input aria-label={`Series expression ${control.label}`} data-series-morph={control.id}
            type="range" min="0" max="1" step="0.01" value={parameters.morphs[control.id] ?? 0} disabled={controlsDisabled}
            onChange={event => changeParameters({ ...parameters, morphs: { ...parameters.morphs, [control.id]: Number(event.currentTarget.value) } })} /></label>) : null}
        </>}
      </div> : null}
    </div>
    {issue || partial ? <div className="mote-series__notice">
      <div><span role="status">{issue ? issue.scope === 'catalog' ? 'Series unavailable. Other avatar styles are ready.' : issue.scope === 'source' && savedImageConfirmed && !prepared ? 'Editing source unavailable. Saved avatar kept.' : 'Preview unavailable. Your current draft is kept.' : 'Some sources are unavailable.'}</span>
        {issue ? <button type="button" className="small-button" disabled={disabled || preparing || catalogLoading} onClick={retry}>Retry</button> : null}</div>
      <details><summary>Details</summary>{issue ? <p>{issue.detail}</p> : null}
        {[...(catalog?.issues ?? []), ...(prepared?.issues ?? [])].map((value, index) => <p key={index}>{value.message} {value.recovery}</p>)}
        {catalog?.roots.map(root => <p key={root.origin}>{root.path} · {root.state}</p>)}
      </details>
    </div> : null}
  </section>
}
