import { TextInput } from '@agentmux/client-ui/input'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import './VegaFilePreview.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VegaMode } from '../../lib/file-formats/vega-spec'
import type { ChartBinding, ChartEvent, ChartSnapshot } from '../../lib/file-formats/vega-chart-protocol'
import { createVegaPreview } from '../../lib/file-formats/vega-worker'
import { createWorkspaceVegaLoader } from '../../lib/file-formats/workspace-vega-loader'
import { useAppStore } from '../../store'

export function VegaFilePreview({ content, path, workspaceId, visible = true, mode }: { content: string; path: string; workspaceId: string; visible?: boolean; mode: VegaMode }) {
  const { ref: container, visible: inView } = useVisibleWork<HTMLDivElement>(visible)
  const image = useRef<HTMLImageElement>(null)
  const chart = useRef<ReturnType<typeof createVegaPreview> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const resource = useAppStore(state => {
    const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
    return JSON.stringify([workspaceId, workspace?.hostId, workspace?.path])
  })
  const owner = useMemo(() => ({}), [content, path, workspaceId, inView, mode, attempt, resource])
  const [state, setState] = useState<{ owner: typeof owner; url?: string; snapshot?: ChartSnapshot; message?: string }>({ owner })
  useEffect(() => {
    setState({ owner })
    if (!inView || !container.current || !image.current) return
    const target = container.current, element = image.current, controller = new AbortController()
    const loader = createWorkspaceVegaLoader(workspaceId, path, controller.signal)
    let url: string | undefined, dimensions = [1, 1], removeEvents = () => {}, cleaned = false
    let preview: ReturnType<typeof createVegaPreview> | undefined, observer: ResizeObserver | undefined
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      controller.abort(); preview?.dispose(); removeEvents(); observer?.disconnect(); loader.dispose()
      if (url) URL.revokeObjectURL(url)
      if (chart.current === preview) chart.current = null
    }
    const attachEvents = (snapshot: ChartSnapshot) => {
      removeEvents()
      const removals: (() => void)[] = []
      for (const { source, type } of [...new Map(snapshot.events.map(event => [`${event.source}:${event.type}`, event])).values()]) {
        if (source === 'container') continue
        const surface = source === 'window' ? window : element
        const listener = (event: Event) => {
          if (controller.signal.aborted) return
          const native = event as PointerEvent & WheelEvent & KeyboardEvent & TouchEvent
          const rect = element.getBoundingClientRect(), touch = native.changedTouches?.[0]
          const packet: ChartEvent = { source, type, x: ((touch?.clientX ?? native.clientX ?? rect.left) - rect.left) * dimensions[0]! / Math.max(1, rect.width), y: ((touch?.clientY ?? native.clientY ?? rect.top) - rect.top) * dimensions[1]! / Math.max(1, rect.height) }
          for (const key of ['button', 'buttons', 'clientX', 'clientY', 'deltaX', 'deltaY', 'deltaMode', 'key', 'code', 'keyCode', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'detail', 'timeStamp', 'pointerId', 'pointerType', 'isPrimary', 'pressure'] as const) if (native[key] !== undefined) packet[key] = native[key]
          for (const key of ['touches', 'changedTouches'] as const) if (native[key]) packet[key] = Array.from(native[key]).map(touch => ({ clientX: touch.clientX, clientY: touch.clientY, identifier: touch.identifier }))
          if (type === 'wheel') event.preventDefault()
          chart.current?.event(packet)
        }
        surface.addEventListener(type, listener, { passive: false })
        removals.push(() => surface.removeEventListener(type, listener))
      }
      removeEvents = () => removals.forEach(remove => remove())
    }
    try { preview = createVegaPreview(content, mode, loader, controller.signal, {
      snapshot(snapshot) {
        if (controller.signal.aborted) return
        const next = URL.createObjectURL(new Blob([snapshot.svg], { type: 'image/svg+xml' }))
        if (url) URL.revokeObjectURL(url)
        url = next; dimensions = [snapshot.width, snapshot.height]
        attachEvents(snapshot)
        setState({ owner, url, snapshot })
      },
      error(error) { if (!controller.signal.aborted) { cleanup(); setState({ owner, message: error.message }) } }
    }) } catch (error) {
      cleanup(); setState({ owner, message: error instanceof Error ? error.message : String(error) }); return cleanup
    }
    chart.current = preview
    observer = new ResizeObserver(entries => {
      if (!controller.signal.aborted && entries[0]?.contentRect.width) preview?.resize(entries[0].contentRect.width, entries[0].contentRect.height)
    })
    observer.observe(target)
    return cleanup
  }, [owner, content, path, workspaceId, inView, mode])
  if (!visible) return null
  const current = state.owner === owner ? state : { owner }
  return <div ref={container} className="file-vega-preview" style={{ height: '100%', overflow: 'auto', padding: 16 }}>
    {!current.url && <div className="file-preview-state" role={current.message ? 'alert' : 'status'}>
      {current.message ? <><strong>Chart preview could not load</strong><span>{current.message}</span><button type="button" className="small-button" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></> : 'Preparing chart preview…'}
    </div>}
    {current.snapshot?.bindings.map(binding => <ChartControl key={binding.signal} binding={binding} onChange={value => chart.current?.setSignal(binding.signal, value)} />)}
    <img ref={image} src={current.url} alt={`${path} chart`} tabIndex={0} title={current.snapshot?.tooltip} style={{ display: current.url ? 'block' : 'none', maxWidth: '100%' }} />
  </div>
}

function ChartControl({ binding, onChange }: { binding: ChartBinding; onChange(value: unknown): void }) {
  const label = binding.name ?? binding.signal
  if (binding.options) return <label className="file-chart-control">{label}<select aria-label={label} value={binding.options.findIndex(value => JSON.stringify(value) === JSON.stringify(binding.value))} onChange={event => onChange(binding.options![Number(event.target.value)])}>
    {binding.options.map((value, index) => <option key={index} value={index}>{binding.labels?.[index] ?? String(value)}</option>)}
  </select></label>
  if (binding.input === 'checkbox') return <label className="file-chart-control"><input type="checkbox" checked={Boolean(binding.value)} onChange={event => onChange(event.target.checked)} />{label}</label>
  if (binding.input === 'text' || binding.input === 'number' || binding.input === 'date') {
    return <label className="file-chart-control">{label}<TextInput aria-label={label} type={binding.input} min={binding.min} max={binding.max} step={binding.step} value={String(binding.value ?? '')} onChange={event => onChange(['range', 'number'].includes(binding.input) ? Number(event.target.value) : event.target.value)} /></label>
  }
  return <label className="file-chart-control">{label}<input aria-label={label} type={binding.input} min={binding.min} max={binding.max} step={binding.step} value={String(binding.value ?? '')} onChange={event => onChange(['range', 'number'].includes(binding.input) ? Number(event.target.value) : event.target.value)} /></label>
}
