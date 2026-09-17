import { memo, useMemo, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronUp, History, Minus, Plus, SquareTerminal } from 'lucide-react'
import type { AgentFocusHistoryEntry } from '../lib/agent-focus'
import type { FocusContext } from '../lib/focus-context'
import { AgentAvatar } from './AgentAvatar'

function clock(timestamp: number): string { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
export const RecentFocusTimeline = memo(function RecentFocusTimeline({ entries, currentSessionId, contexts, onSelect }: {
  entries: readonly AgentFocusHistoryEntry[]; currentSessionId: string | null; contexts: readonly FocusContext[]; onSelect(sessionId: string): void
}) {
  const [mode, setMode] = useState<'compact' | 'expanded' | 'collapsed'>('compact')
  const [zoom, setZoom] = useState(1)
  const ordered = useMemo(() => {
    const byId = new Map(contexts.map(context => [context.id, context]))
    return entries.flatMap(entry => { const context = byId.get(entry.sessionId); return context ? [{ ...entry, context }] : [] }).sort((a, b) => a.focusedAt - b.focusedAt)
  }, [contexts, entries])
  const start = ordered[0]?.focusedAt ?? 0, end = ordered.at(-1)?.focusedAt ?? start, span = Math.max(1, end - start)
  const current = ordered.find(item => item.sessionId === currentSessionId)
  const tickTimes = start === end ? [start] : Array.from({ length: 5 }, (_, i) => start + (end - start) * i / 4)
  return <section className="recent-focus" aria-label="Recent Focus" data-mode={mode} data-empty={ordered.length === 0 ? 'true' : undefined}>
    <header className="recent-focus__header">
      <span className="recent-focus__title"><History size={12} /><strong>Recent Focus</strong><span className="recent-focus__range">{ordered.length ? (start === end ? clock(start) : `${clock(start)} — ${clock(end)}`) : ''}</span></span>
      <span className="recent-focus__controls">
        <button type="button" className="icon-button" aria-label="Zoom out focus history" disabled={zoom === 1} onClick={() => setZoom(Math.max(1, zoom - 1))}><Minus size={12} /></button>
        <span aria-label="Timeline zoom">{zoom}×</span>
        <button type="button" className="icon-button" aria-label="Zoom in focus history" disabled={zoom === 4} onClick={() => setZoom(Math.min(4, zoom + 1))}><Plus size={12} /></button>
        <button type="button" className="icon-button" aria-label={mode === 'expanded' ? 'Compact focus history' : 'Expand focus history'} onClick={() => setMode(mode === 'expanded' ? 'compact' : 'expanded')}><ChevronUp size={12} /></button>
        <button type="button" className="icon-button" aria-label={mode === 'collapsed' ? 'Show focus history' : 'Collapse focus history'} aria-expanded={mode !== 'collapsed'} onClick={() => setMode(mode === 'collapsed' ? 'compact' : 'collapsed')}><ChevronDown size={12} /></button>
      </span>
    </header>
    {mode !== 'collapsed' && (ordered.length === 0 ? <p className="recent-focus__empty">Select a context to start your history.</p> : <div className="recent-focus__viewport">
      <div className="recent-focus__canvas" style={{ '--timeline-zoom': zoom } as CSSProperties}>
        <div className="recent-focus__ruler" aria-hidden="true"><span className="recent-focus__gutter">Context</span><div className="recent-focus__time-scale">{tickTimes.map((time, i) => <time key={i} style={{ left: `${((time - start) / span) * 100}%` }}>{clock(time)}</time>)}</div></div>
        <div className="recent-focus__tracks">
          {ordered.map((item, index) => {
            const next = ordered[index + 1]?.focusedAt, left = (item.focusedAt - start) / span * 100, selected = item.sessionId === currentSessionId
            return <div className="recent-focus__track" data-focus-timeline-id={item.sessionId} key={item.sessionId}>
              <span className="recent-focus__gutter" title={`${item.context.name} · ${item.context.workspaceName}`}>{item.context.kind === 'agent' ? <AgentAvatar sessionId={item.sessionId} label={item.context.name} providerId={item.context.providerId ?? undefined} state={item.context.state} size={14} /> : <SquareTerminal size={13} />}<span>{item.context.name}</span></span>
              <div className="recent-focus__lane">
                {current ? <span className="recent-focus__playhead" style={{ left: `${(current.focusedAt - start) / span * 100}%` }} aria-hidden="true" /> : null}
                <button type="button" className={`recent-focus__segment${selected ? ' is-current' : ''}${next === undefined ? ' is-open' : ''}`}
                  style={{ left: `${left}%`, width: next === undefined ? undefined : `${(next - item.focusedAt) / span * 100}%` }}
                  data-focused-at={item.focusedAt} data-known-end={next} aria-current={selected ? 'true' : undefined}
                  aria-label={`Return to ${item.context.name}, focused at ${clock(item.focusedAt)}${next === undefined ? ', next focus not recorded' : ''}`}
                  title={`${item.context.name} · ${item.context.workspaceName} · Focused ${clock(item.focusedAt)}${next === undefined ? ' · Next focus not recorded' : ''}`}
                  onClick={() => onSelect(item.sessionId)}><span>{clock(item.focusedAt)}</span></button>
              </div>
            </div>
          })}
        </div>
      </div>
    </div>)}
  </section>
})
