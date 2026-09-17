import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronUp, History, Minus, Plus, SquareTerminal } from 'lucide-react'
import type { AgentFocusHistoryEntry } from '../lib/agent-focus'
import type { FocusContext } from '../lib/focus-context'
import { useAppStore } from '../store'
import { FOCUS_TIMELINE_HEIGHT_MAX, FOCUS_TIMELINE_HEIGHT_MIN } from '../lib/focus-timeline-height'
import { AgentAvatar } from './AgentAvatar'

function clock(timestamp: number): string { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
export const RecentFocusTimeline = memo(function RecentFocusTimeline({ entries, currentSessionId, contexts, onSelect }: {
  entries: readonly AgentFocusHistoryEntry[]; currentSessionId: string | null; contexts: readonly FocusContext[]; onSelect(sessionId: string): void
}) {
  const [mode, setMode] = useState<'compact' | 'expanded' | 'collapsed'>('compact')
  const [zoom, setZoom] = useState(1)
  const savedHeight = useAppStore(state => state.focusTimelineHeight)
  const saveHeight = useAppStore(state => state.setFocusTimelineHeight)
  const timelineRef = useRef<HTMLElement>(null)
  const drag = useRef<{ y: number; height: number; next: number } | null>(null)
  const [draftHeight, setDraftHeight] = useState<number | null>(null)
  const [maximum, setMaximum] = useState(FOCUS_TIMELINE_HEIGHT_MAX)
  const minimum = Math.min(FOCUS_TIMELINE_HEIGHT_MIN, maximum)
  const height = Math.min(maximum, Math.max(minimum, draftHeight ?? savedHeight))
  useEffect(() => {
    const parent = timelineRef.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return
    const update = () => { const available = parent.getBoundingClientRect().height; if (available > 0) setMaximum(Math.min(FOCUS_TIMELINE_HEIGHT_MAX, Math.max(28, Math.floor((available - 36) / 2)))) }
    const observer = new ResizeObserver(update)
    observer.observe(parent); update()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return
      drag.current.next = Math.min(maximum, Math.max(minimum, drag.current.height + drag.current.y - event.clientY))
      setDraftHeight(drag.current.next)
    }
    const stop = () => {
      if (!drag.current) return
      saveHeight(drag.current.next); drag.current = null; setDraftHeight(null)
      document.body.style.cursor = ''; document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('blur', stop)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('blur', stop); if (drag.current) { document.body.style.cursor = ''; document.body.style.userSelect = '' } }
  }, [maximum, minimum, saveHeight])
  const ordered = useMemo(() => {
    const byId = new Map(contexts.map(context => [context.id, context]))
    return entries.flatMap(entry => { const context = byId.get(entry.sessionId); return context ? [{ ...entry, context }] : [] }).sort((a, b) => a.focusedAt - b.focusedAt)
  }, [contexts, entries])
  const start = ordered[0]?.focusedAt ?? 0, end = ordered.at(-1)?.focusedAt ?? start, span = Math.max(1, end - start)
  const current = ordered.find(item => item.sessionId === currentSessionId)
  const tickTimes = start === end ? [start] : Array.from({ length: 5 }, (_, i) => start + (end - start) * i / 4)
  return <section ref={timelineRef} style={{ height: mode === 'collapsed' ? 28 : height } as CSSProperties} className="recent-focus" aria-label="Recent Focus" data-mode={mode} data-empty={ordered.length === 0 ? 'true' : undefined}>
    {mode !== 'collapsed' ? <div className="recent-focus__resize" role="separator" tabIndex={0} aria-label="Resize Focus timeline" aria-orientation="horizontal" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={height}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { y: event.clientY, height, next: height }; document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none' }}
      onKeyDown={event => { const next = event.key === 'ArrowUp' ? height + 16 : event.key === 'ArrowDown' ? height - 16 : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null; if (next !== null) { event.preventDefault(); saveHeight(Math.min(maximum, Math.max(minimum, next))) } }} /> : null}
    <header className="recent-focus__header">
      <span className="recent-focus__title"><History size={12} /><strong>Recent Focus</strong><span className="recent-focus__range">{ordered.length ? (start === end ? clock(start) : `${clock(start)} — ${clock(end)}`) : ''}</span></span>
      <span className="recent-focus__controls">
        <button type="button" className="icon-button" aria-label="Zoom out focus history" disabled={zoom === 1} onClick={() => setZoom(Math.max(1, zoom - 1))}><Minus size={12} /></button>
        <span aria-label="Timeline zoom">{zoom}×</span>
        <button type="button" className="icon-button" aria-label="Zoom in focus history" disabled={zoom === 4} onClick={() => setZoom(Math.min(4, zoom + 1))}><Plus size={12} /></button>
        <button type="button" className="icon-button" aria-label={mode === 'expanded' ? 'Compact focus history' : 'Expand focus history'} onClick={() => { saveHeight(mode === 'expanded' ? 96 : Math.min(maximum, 168)); setMode(mode === 'expanded' ? 'compact' : 'expanded') }}><ChevronUp size={12} /></button>
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
