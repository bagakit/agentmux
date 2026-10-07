import { useId, useRef, useState } from 'react'

type Point = { id: string; at: number; value: number | null }
type Selection = Pick<Point, 'id' | 'at'>
const available = (value: number | null): value is number => value !== null && Number.isFinite(value)
const sampleTime = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })

/** A local reader of the original owner's bounded samples; it never collects history. */
export function PerformanceTrend({ points, color, label, unit }: { points: Point[]; color: string; label: string; unit: '%' | 'KiB' }) {
  const detailId = useId()
  const chart = useRef<SVGSVGElement>(null)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [hover, setHover] = useState<Selection | null>(null)
  const reading = selected ?? hover
  const at = reading?.at ?? null
  const index = reading === null ? -1 : points.findIndex(point => point.id === reading.id)
  const point = points[index]
  const expired = selected !== null && !point
  const valid = points.filter(point => available(point.value))
  const max = valid.length ? Math.max(1, ...valid.map(point => point.value!)) * 1.12 : 1
  const x = (index: number) => points.length > 1 ? index / (points.length - 1) * 180 : 180
  const y = (value: number) => 42 - value / max * 34
  let d = '', connected = false
  for (let index = 0; index < points.length; index++) {
    const value = points[index]!.value
    if (!available(value)) { connected = false; continue }
    d += `${connected ? 'L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)} `; connected = true
  }
  const nearest = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const index = Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (points.length - 1))
    const point = points[index]
    return point ? { id: point.id, at: point.at } : null
  }
  const clear = () => { setSelected(null); setHover(null) }
  const value = point ? available(point.value) ? `${String(point.value)}${unit === '%' ? '%' : ' KiB'}` : 'Unavailable' : expired ? 'Sample expired' : 'Explore samples'
  return <div className="performance-trend-reader" style={{ color }}>
    <svg ref={chart} className="performance-trend" viewBox="0 0 180 48" role="group" aria-roledescription="sample chart" tabIndex={points.length ? 0 : undefined}
      aria-label={`${label} history`} aria-describedby={detailId} data-toolkit-local-escape={selected !== null || hover !== null ? '' : undefined}
      onPointerMove={event => { if (selected === null && event.pointerType !== 'touch') setHover(nearest(event)) }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={event => { if (event.button !== 0) return; setSelected(nearest(event)); setHover(null); event.currentTarget.focus({ preventScroll: true }) }}
      onFocus={() => { if (selected === null) setHover(points.at(-1) ?? null) }} onBlur={() => setHover(null)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return
        if (event.key === 'Escape' && (selected !== null || hover !== null)) { event.preventDefault(); event.stopPropagation(); clear(); return }
        if (!points.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const current = index < 0 ? points.length - 1 : index
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : event.key === 'ArrowLeft' ? Math.max(0, current - 1) : event.key === 'ArrowRight' ? Math.min(points.length - 1, current + 1) : current
        setSelected({ id: points[next]!.id, at: points[next]!.at }); setHover(null)
      }}>
      <path className="performance-trend__baseline" d="M0 43H180" />
      {valid.length > 1 ? <path d={d} /> : <text x="0" y="32">Collecting history</text>}
      {point ? <g className="performance-trend__cursor" aria-hidden="true"><line x1={x(index)} x2={x(index)} y1="4" y2="43" />
        {available(point.value) ? <circle cx={x(index)} cy={y(point.value)} r="2.5" /> : null}</g> : null}
    </svg>
    <div className="performance-trend-detail" id={detailId} data-sample-state={expired ? 'expired' : selected !== null ? 'selected' : point ? 'preview' : 'idle'} aria-live={selected !== null ? 'polite' : 'off'}>
      <span>{value}</span><small>{at === null ? 'Hover or use ← → to inspect' : `${selected === null ? 'Preview' : expired ? 'Left retained history' : 'Selected'} · ${sampleTime(at)}`}</small>
      {selected !== null ? <button type="button" aria-label={`Clear ${label} sample selection`} onClick={event => {
        const restore = document.activeElement === event.currentTarget
        clear()
        if (restore && event.currentTarget.isConnected && chart.current?.isConnected) chart.current.focus({ preventScroll: true })
      }}>Clear</button> : null}
    </div>
  </div>
}
