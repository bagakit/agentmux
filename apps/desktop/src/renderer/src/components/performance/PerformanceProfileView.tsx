import { useMemo, useState } from 'react'
import type { V8ProfileAnalysis } from '@agentmux/core/control'
import { profileFlameRows } from '../../lib/renderer-profile-analysis'

const ms = (value: number) => `${value.toFixed(1)} ms`
const scriptName = (url: string) => url === '' ? '(no source URL)' : url.split(/[\\/]/u).at(-1) || url

export function PerformanceProfileView({ analysis }: { analysis: V8ProfileAnalysis }) {
  const [path, setPath] = useState<number[]>([analysis.root])
  const root = path.at(-1)!, selected = analysis.frames.get(root)!, flame = useMemo(() => profileFlameRows(analysis, root), [analysis, root])
  return <>
    <div className="performance-section-heading"><strong>Module samples</strong><span>{analysis.samples} samples · {ms(analysis.sampledMs)}</span></div>
    <p className="performance-note">Self time from V8 sample weights. Select a module to inspect its hottest call frame. Script modules are not React components; idle and native work may be outside these samples.</p>
    <p className="performance-note" aria-label="V8 sample interpretation">Original profile {ms(analysis.profileDurationMs)} · weighted samples {ms(analysis.sampledMs)} · {analysis.lastSampleTailMs >= 0 ? `unrepresented tail ${ms(analysis.lastSampleTailMs)}` : `sample weights exceed interval by ${ms(-analysis.lastSampleTailMs)}`} · largest sample interval {ms(analysis.maxSampleGapMs)}. Script {ms(analysis.weights.script.selfMs)} · idle {ms(analysis.weights.idle.selfMs)} · GC {ms(analysis.weights.gc.selfMs)} · unattributed {ms(analysis.weights.unattributed.selfMs)}. Percentages below use weighted samples, not process CPU. Locations refer to generated scripts; original source mapping is unavailable.</p>
    <div className="performance-module-list" aria-label="Module sample heatmap">
      {analysis.modules.slice(0, 12).map(module => <button type="button" className="performance-module-row" key={module.url}
        aria-label={`Inspect hottest call frame in ${module.url}`} title={`Inspect hottest call frame in ${module.url}`}
        onClick={() => { const frame = [...analysis.frames.values()].filter(frame => frame.url === module.url).sort((a, b) => b.selfMs - a.selfMs)[0]; if (frame) setPath(frame.id === analysis.root ? [analysis.root] : [analysis.root, frame.id]) }}
        style={{ background: `color-mix(in srgb,var(--green) ${Math.round(4 + 18 * module.selfMs / analysis.sampledMs)}%,transparent)` }}>
        <span title={module.url}>{scriptName(module.url)}</span><strong>{ms(module.selfMs)} <small>{(module.selfMs / analysis.sampledMs * 100).toFixed(1)}%</small></strong>
      </button>)}
    </div>
    {analysis.modules.length > 12 ? <p className="performance-note">Top 12 of {analysis.modules.length} modules. Full data is in the original profile.</p> : null}
    <div className="performance-section-heading"><strong>Call stack flame graph</strong><button type="button" className="performance-inline-action" disabled={path.length === 1} onClick={() => setPath(value => value.slice(0, -1))}>Back</button></div>
    <p className="performance-note">Width is inclusive sampled time, not a timeline. Select a frame to zoom; parent and child time overlap.</p>
    <div className="performance-flame" aria-label="Sampled call stacks" style={{ height: `${(Math.max(0, ...flame.rows.map(row => row.depth)) + 1) * 25}px` }}>
      {flame.rows.map(row => { const frame = analysis.frames.get(row.id)!; return <button key={row.id} type="button"
        title={`${frame.name}\n${frame.url || '(no source URL)'}:${frame.line + 1}:${frame.column + 1}\nSelf ${ms(frame.selfMs)} · inclusive ${ms(frame.totalMs)}`}
        aria-label={`${frame.name}, self ${ms(frame.selfMs)}, inclusive ${ms(frame.totalMs)}`} aria-pressed={row.id === root}
        style={{ left: `${row.left}%`, width: `${row.width}%`, top: `${row.depth * 25}px` }}
        onClick={() => { if (row.id !== root) setPath(value => [...value, row.id]) }}>{frame.name}</button> })}
    </div>
    {flame.omitted ? <p className="performance-note">{flame.omitted} branches outside this view. Select a parent frame to inspect deeper, or export.</p> : null}
    <div className="performance-frame-detail" aria-live="polite"><strong>{selected.name}</strong><span>{selected.url || '(no source URL)'}{selected.line >= 0 ? `:${selected.line + 1}` : ''}</span><small>Self {ms(selected.selfMs)} · inclusive {ms(selected.totalMs)}</small></div>
  </>
}

