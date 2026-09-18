import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, History, MessageSquare, SquareTerminal, X } from 'lucide-react'
import type { AgentTimelineItem } from '@agentmux/core/timeline'
import type { AgentFocusHistoryEntry } from '../lib/agent-focus'
import type { FocusContext } from '../lib/focus-context'
import { useAppStore } from '../store'
import { FOCUS_TIMELINE_HEIGHT_MAX, FOCUS_TIMELINE_HEIGHT_MIN } from '../lib/focus-timeline-height'
import { AgentAvatar } from './AgentAvatar'
import { FOCUS_WINDOW_HOURS, HOUR_MS, focusTimePosition, focusTimeSegments, focusTimeWindow, localDateTime, type FocusTimeSegment, type FocusTimeWindow } from '../lib/focus-time-window'

function clock(timestamp: number): string { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function dateClock(timestamp: number): string { return new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
const NO_SEGMENTS: FocusTimeSegment[] = []
const FocusTimeTrack = memo(function FocusTimeTrack({ context, segments, selected, window, now, onSelect, onPreview }: {
  context: FocusContext; segments: readonly FocusTimeSegment[]; selected: boolean; window: FocusTimeWindow; now: number
  onSelect(id: string): void; onPreview(message: AgentTimelineItem): void
}) {
  // A track observes only its own canonical timeline; unrelated output never scans its messages.
  const timeline = useAppStore(state => state.timelines[context.id])
  const messages = useMemo(() => timeline?.items.filter(item => item.kind === 'user_message' && item.createdAt >= window.start && item.createdAt <= window.end && item.createdAt <= now) ?? [], [timeline, window, now])
  if (!segments.length && !messages.length) return null
  const position = focusTimePosition(now, window)
  return <div className="recent-focus__track" data-focus-timeline-id={context.id}>
    <span className="recent-focus__gutter" title={`${context.name} · ${context.workspaceName}`}>{context.kind === 'agent' ? <AgentAvatar sessionId={context.id} label={context.name} providerId={context.providerId ?? undefined} state={context.state} size={14} /> : <SquareTerminal size={13} />}<span>{context.name}</span></span>
    <div className="recent-focus__lane">
      {position >= 0 && position <= 100 ? <span className="recent-focus__playhead" data-now={now} style={{ left: `${position}%` }} aria-hidden="true" /> : null}
      {segments.map((item, index) => <button key={`${item.focusedAt}:${index}`} type="button" className={`recent-focus__segment${selected ? ' is-current' : ''}${item.end === undefined ? ' is-open' : ''}`}
        style={{ left: `${item.left}%`, width: item.width === undefined ? undefined : `${item.width}%` }}
        data-focused-at={item.focusedAt} data-known-end={item.end} aria-current={selected ? 'true' : undefined}
        aria-label={`Return to ${context.name}, focused at ${dateClock(item.focusedAt)}${item.end === undefined ? ', next focus not recorded' : ''}`}
        title={`${context.name} · ${context.workspaceName} · Focused ${dateClock(item.focusedAt)}${item.end === undefined ? ' · Next focus not recorded' : ''}`}
        onClick={() => onSelect(context.id)}><span>{clock(item.focusedAt)}</span></button>)}
      {messages.map(message => <button key={message.id} type="button" className="recent-focus__message" data-message-id={message.id} data-message-at={message.createdAt}
        style={{ left: `${focusTimePosition(message.createdAt, window)}%` }} aria-label={`User message in ${context.name} at ${clock(message.createdAt)}`}
        title={`${context.name} · ${dateClock(message.createdAt)}\n${(message.content ?? message.title).slice(0, 160)}`} onClick={() => onPreview(message)}><MessageSquare size={10} /></button>)}
    </div>
  </div>
})
export const RecentFocusTimeline = memo(function RecentFocusTimeline({ entries, currentSessionId, contexts, onSelect }: {
  entries: readonly AgentFocusHistoryEntry[]; currentSessionId: string | null; contexts: readonly FocusContext[]; onSelect(sessionId: string): void
}) {
  const [mode, setMode] = useState<'compact' | 'expanded' | 'collapsed'>('compact')
  const [hours, setHours] = useState<number>(4)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now)
  const [preview, setPreview] = useState<AgentTimelineItem | null>(null)
  useEffect(() => {
    if (mode === 'collapsed') return
    let timer: ReturnType<typeof setInterval> | undefined
    const observe = () => {
      if (timer) clearInterval(timer)
      if (document.visibilityState !== 'hidden') { setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), 30_000) }
    }
    observe(); document.addEventListener('visibilitychange', observe)
    return () => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', observe) }
  }, [mode])
  const savedHeight = useAppStore(state => state.focusTimelineHeight)
  const saveHeight = useAppStore(state => state.setFocusTimelineHeight)
  const timelineRef = useRef<HTMLElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const acquireOverlay = useAppStore(state => state.acquireNativeSurfaceOverlay)
  const releaseOverlay = useAppStore(state => state.releaseNativeSurfaceOverlay)
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
  const effectiveAnchor = anchor ?? now
  const range = useMemo(() => focusTimeWindow(effectiveAnchor, hours), [effectiveAnchor, hours])
  const tracks = useMemo(() => focusTimeSegments(entries, range, now), [entries, range, now])
  const tickTimes = Array.from({ length: 5 }, (_, i) => range.start + (range.end - range.start) * i / 4)
  const position = focusTimePosition(now, range)
  const previewContext = preview ? contexts.find(context => context.id === preview.agentSessionId) : undefined
  useEffect(() => {
    if (!preview || !previewContext) return
    const previous = document.activeElement as HTMLElement | null
    acquireOverlay(); previewRef.current?.focus()
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null) }
    document.addEventListener('keydown', dismiss)
    return () => { releaseOverlay(); document.removeEventListener('keydown', dismiss); if (previous?.isConnected) previous.focus() }
  }, [preview, previewContext, acquireOverlay, releaseOverlay])
  const inspectWindow = (next: number | null) => { setAnchor(next); setPreview(null) }
  return <section ref={timelineRef} style={{ height: mode === 'collapsed' ? 28 : height } as CSSProperties} className="recent-focus" aria-label="Recent Focus" data-mode={mode} data-window-start={range.start} data-window-end={range.end}>
    {mode !== 'collapsed' ? <div className="recent-focus__resize" role="separator" tabIndex={0} aria-label="Resize Focus timeline" aria-orientation="horizontal" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={height}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { y: event.clientY, height, next: height }; document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none' }}
      onKeyDown={event => { const next = event.key === 'ArrowUp' ? height + 16 : event.key === 'ArrowDown' ? height - 16 : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null; if (next !== null) { event.preventDefault(); saveHeight(Math.min(maximum, Math.max(minimum, next))) } }} /> : null}
    <header className="recent-focus__header">
      <span className="recent-focus__title"><History size={12} /><strong>Recent Focus</strong><span className="recent-focus__range" title="Shows up to 2000 retained focus switches and Core's retained user messages (up to 200 per Session). Earlier unrecorded periods may be empty.">{dateClock(range.start)} — {dateClock(range.end)}</span></span>
      <span className="recent-focus__controls">
        {mode !== 'collapsed' ? <><input type="datetime-local" className="recent-focus__date" aria-label="Focus history date and time" value={localDateTime(anchor ?? now)} onChange={event => { const next = new Date(event.target.value).getTime(); if (Number.isFinite(next)) inspectWindow(next) }} />
        <button type="button" className="icon-button" aria-label="Previous focus window" onClick={() => inspectWindow((anchor ?? now) - hours * HOUR_MS)}><ChevronLeft size={12} /></button>
        <select aria-label="Focus window size" value={hours} onChange={event => { setHours(Number(event.target.value)); setPreview(null) }}>{FOCUS_WINDOW_HOURS.map(size => <option key={size} value={size}>{size}h</option>)}</select>
        <button type="button" className="icon-button" aria-label="Next focus window" onClick={() => inspectWindow((anchor ?? now) + hours * HOUR_MS)}><ChevronRight size={12} /></button>
        <button type="button" className="recent-focus__now" aria-label="Return to current focus window" aria-pressed={anchor === null} onClick={() => { setNow(Date.now()); inspectWindow(null) }}>Now</button></> : null}
        <button type="button" className="icon-button" aria-label={mode === 'expanded' ? 'Compact focus history' : 'Expand focus history'} onClick={() => { saveHeight(mode === 'expanded' ? 96 : Math.min(maximum, 168)); setMode(mode === 'expanded' ? 'compact' : 'expanded') }}><ChevronUp size={12} /></button>
        <button type="button" className="icon-button" aria-label={mode === 'collapsed' ? 'Show focus history' : 'Collapse focus history'} aria-expanded={mode !== 'collapsed'} onClick={() => { setPreview(null); setMode(mode === 'collapsed' ? 'compact' : 'collapsed') }}><ChevronDown size={12} /></button>
      </span>
    </header>
    {mode !== 'collapsed' ? <div className="recent-focus__viewport">
      <div className="recent-focus__canvas">
        <div className="recent-focus__ruler" aria-label="Focus time ruler"><span className="recent-focus__gutter">Context</span><div className="recent-focus__time-scale">{tickTimes.map((time, i) => <time key={i} style={{ left: `${focusTimePosition(time, range)}%` }}>{clock(time)}</time>)}{position >= 0 && position <= 100 ? <span className="recent-focus__playhead recent-focus__playhead--ruler" data-now={now} style={{ left: `${position}%` }} aria-label={`Current time ${clock(now)}`} /> : null}</div></div>
        <div className="recent-focus__tracks">
          {contexts.map(context => <FocusTimeTrack key={context.id} context={context} segments={tracks.get(context.id) ?? NO_SEGMENTS} selected={context.id === currentSessionId} window={range} now={now} onSelect={onSelect} onPreview={setPreview} />)}
        </div>
        <p className="recent-focus__empty">No retained records in this window. Choose another time or return to Now.</p>
      </div>
    </div> : null}
    {preview && previewContext ? <div ref={previewRef} tabIndex={-1} className="recent-focus__message-preview" role="dialog" aria-label="User message">
      <header><strong>{previewContext.name}</strong><time>{dateClock(preview.createdAt)}</time><button type="button" className="icon-button" aria-label="Close user message" onClick={() => setPreview(null)}><X size={12} /></button></header>
      <p>{preview.content ?? preview.title}</p><button type="button" onClick={() => { onSelect(preview.agentSessionId); setPreview(null) }}>Return to Context</button>
    </div> : null}
  </section>
})
