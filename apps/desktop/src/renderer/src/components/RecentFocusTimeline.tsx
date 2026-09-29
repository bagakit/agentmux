import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, History, MessageSquare, Minus, Plus, SquareTerminal } from 'lucide-react'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AgentSessionHistoryPage, AgentSessionUserMessage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentSessionControl, SessionHistoryReference } from '../../../shared/contracts'
import type { AgentFocusHistoryEntry } from '../lib/agent-focus'
import type { FocusContext } from '../lib/focus-context'
import { useAppStore } from '../store'
import { FOCUS_TIMELINE_HEIGHT_MAX, FOCUS_TIMELINE_HEIGHT_MIN } from '../lib/focus-timeline-height'
import { AgentAvatar } from './AgentAvatar'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { createSpeakerResolver, speakerOfUserMessage } from '../lib/conversation-speaker'
import { agentProviderLabel } from './AgentProviderIcon'
import { ProjectIcon } from './ProjectIcon'
import * as Dialog from '@radix-ui/react-dialog'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { groupFocusTimeline, observeFocusInputTracks, resolveFocusInputTrack, type FocusTimelineProject, type FocusTimelineTrack } from '../lib/focus-history-timeline'
import { FocusMessagePreview } from './FocusMessagePreview'
import { useSessionUserMessages } from '../lib/session-user-messages'
import { useFocusHistorySources } from '../lib/focus-history-sources'
import { api } from '../lib/api'
import { presentError } from '../lib/error-presentation'
import type { FocusHierarchyFacts, FocusProjectLane } from '../lib/focus-project-lanes'
import { FOCUS_WINDOW_HOURS, HOUR_MS, focusTimePosition, focusTimeSegments, focusTimeWindow, focusWheelTimeDelta, focusWindowLabel, focusWorkSegment, localDateTime, type FocusTimeSegment, type FocusTimeWindow } from '../lib/focus-time-window'

const describeMessageSpeaker = createSpeakerResolver()

function clock(timestamp: number): string { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function dateClock(timestamp: number): string { return new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
const MAX_NATIVE_RECORDS = 90
const MAX_BATCH_PAGES = 3
type LatestInputs = { messages: readonly AgentSessionUserMessage[]; loading: boolean; error: Error | null; refresh(): Promise<void> }
const EMPTY_LATEST_INPUTS: LatestInputs = { messages: [], loading: false, error: null, refresh: async () => {} }
// Subscribe in a memoized leaf: another Context's status/output may update the
// tracks, but cannot reproject this Context's unchanged native/captured inputs.
const FocusLatestInputs = memo(function FocusLatestInputs({ control, enabled, pinned, onChange }: {
  control: AgentSessionControl | undefined; enabled: boolean; pinned: AgentSessionUserMessage | undefined; onChange(value: LatestInputs): void
}) {
  const latest = useSessionUserMessages(control, { enabled })
  const messages = useMemo(() => {
    const native = latest.messages.filter(item => item.source.kind === 'native')
    const pin = pinned?.source.kind === 'native' ? pinned : undefined
    const protectedMessage = pin && native.find(item => item.id === pin.id)
    const capacity = pin ? MAX_NATIVE_RECORDS - 1 : MAX_NATIVE_RECORDS
    const retained = protectedMessage ? [...native.filter(item => item !== protectedMessage).slice(-capacity), protectedMessage] : native.slice(-capacity)
    return [...retained, ...latest.messages.filter(item => item.source.kind === 'captured')]
  }, [latest.messages, pinned])
  useLayoutEffect(() => { onChange({ messages, loading: latest.loading, error: latest.error, refresh: latest.refresh }) }, [messages, latest.loading, latest.error, latest.refresh, onChange])
  return null
})
type NativeWindow = { scope: string; page: AgentSessionHistoryPage | null; timeline: AgentTimelineSnapshot | undefined; loading: boolean; error: string | null; capturedError: string | null; rotated: boolean }
const EMPTY_NATIVE_WINDOW: NativeWindow = { scope: '', page: null, timeline: undefined, loading: false, error: null, capturedError: null, rotated: false }

/** One Focus reading intent, over the existing public page API. No Session cache or polling. */
function useFocusInputWindow(control: SessionHistoryReference | undefined, scope: string, enabled: boolean, pinned: AgentSessionUserMessage | undefined, includeCaptured: boolean) {
  const [reading, setReading] = useState<NativeWindow>(EMPTY_NATIVE_WINDOW)
  const readingRef = useRef(reading); readingRef.current = reading
  const pinnedRef = useRef(pinned); pinnedRef.current = pinned
  const lifetime = useRef(0)
  const pending = useRef(false)
  const enabledRef = useRef(enabled); enabledRef.current = enabled
  const readBatch = useCallback(async (refresh = false) => {
    if (!enabledRef.current || !control || pending.current) return
    const before = readingRef.current.scope === scope ? readingRef.current : EMPTY_NATIVE_WINDOW
    if (!refresh && before.page && before.page.nextCursor === null) return
    const request = lifetime.current
    pending.current = true
    readingRef.current = { ...before, scope, loading: true, error: null }
    setReading(readingRef.current)
    let accepted = refresh ? null : before.page
    let rotated = refresh ? false : before.rotated
    try {
      if (includeCaptured && (refresh || !before.timeline)) {
        try {
          const timeline = await api.sessions.timeline(control)
          if (!enabledRef.current || request !== lifetime.current) return
          if (timeline.agentSessionId !== control.agentSessionId) throw new Error('Captured records belong to another Context.')
          readingRef.current = { ...readingRef.current, scope, timeline, capturedError: null }
          setReading(readingRef.current)
        } catch (cause) {
          if (request !== lifetime.current || !enabledRef.current) return
          readingRef.current = { ...readingRef.current, scope, capturedError: presentError(cause) }
          setReading(readingRef.current)
        }
      }
      for (let index = 0; index < MAX_BATCH_PAGES; index++) {
        if (!enabledRef.current || request !== lifetime.current) return
        const cursor = accepted?.nextCursor ?? undefined
        const page = await api.sessions.historyPage(control, { limit: 30, ...(cursor ? { cursor } : {}) })
        if (!enabledRef.current || request !== lifetime.current) return
        if (page.agentSessionId !== control.agentSessionId) throw new Error('Input records belong to another Context.')
        if (accepted && (accepted.source.providerId !== page.source.providerId || accepted.source.nativeSessionId !== page.source.nativeSessionId)) throw new Error('Native history source changed. Refresh source to read the new snapshot.')
        if (cursor && page.nextCursor === cursor) throw new Error('The input history cursor did not advance. Retry this read.')
        const existing = accepted?.items ?? []
        const existingIds = new Set(existing.map(item => item.id))
        const ids = new Set<string>()
        const combined = [...page.items.filter(item => !existingIds.has(item.id)), ...existing].filter(item => { if (ids.has(item.id)) return false; ids.add(item.id); return true })
        const pin = pinnedRef.current
        const pinSource = pin?.source
        const protectedRecord = pinSource?.kind === 'native' && pin?.agentSessionId === page.agentSessionId && pinSource.providerId === page.source.providerId && pinSource.nativeSessionId === page.source.nativeSessionId ? combined.find(item => item.id === pinSource.recordId) : undefined
        const capacity = pinSource?.kind === 'native' && !protectedRecord ? MAX_NATIVE_RECORDS - 1 : MAX_NATIVE_RECORDS
        const items = combined.length <= capacity ? combined : protectedRecord ? [...combined.filter(item => item !== protectedRecord).slice(0, MAX_NATIVE_RECORDS - 1), protectedRecord] : combined.slice(0, capacity)
        rotated ||= combined.length > capacity
        accepted = { ...page, items }
        const next = { ...readingRef.current, scope, page: accepted, loading: true, error: null, rotated }
        readingRef.current = next; setReading(next)
        if (page.nextCursor === null) break
      }
    } catch (cause) {
      if (request === lifetime.current) setReading(current => ({ ...current, error: presentError(cause) }))
    } finally {
      if (request === lifetime.current) { pending.current = false; setReading(current => ({ ...current, loading: false })) }
    }
  }, [control?.hostId, control?.agentSessionId, scope, includeCaptured])
  useEffect(() => {
    ++lifetime.current; pending.current = false
    readingRef.current = EMPTY_NATIVE_WINDOW; setReading(EMPTY_NATIVE_WINDOW)
    if (enabled) void readBatch(true)
    return () => { ++lifetime.current; pending.current = false }
  }, [enabled, scope, readBatch])
  return { ...(reading.scope === scope ? reading : EMPTY_NATIVE_WINDOW), continueReading: () => void readBatch(), refresh: () => void readBatch(true) }
}

const FocusTimeTrack = memo(function FocusTimeTrack({ track, selected, nativeMessages, window, now, onSelect, onPreview, onDismiss, onInspect, onPresence }: {
  track: FocusTimelineTrack; selected: boolean; window: FocusTimeWindow; now: number
  nativeMessages?: readonly AgentSessionUserMessage[] | undefined
  onSelect(id: string): void; onPreview(message: AgentSessionUserMessage, target: HTMLElement, interactive: boolean): void; onDismiss(messageId: string): void
  onInspect(segment: FocusTimeSegment, anchor: HTMLElement): void; onPresence(key: string, present: boolean): void
}) {
  const { current: context, segments, identity, sessionId } = track
  const name = context?.name ?? identity?.name ?? sessionId
  // A track observes only its own canonical timeline; unrelated output never scans its messages.
  const timeline = useAppStore(state => context ? state.timelines[sessionId] : undefined)
  const captured = useMemo(() => timeline ? projectSessionUserMessages({ agentSessionId: sessionId, timeline }) : EMPTY_LATEST_INPUTS.messages, [sessionId, timeline])
  const messages = useMemo(() => [...(nativeMessages ?? []), ...captured].filter(item => item.recordedAt !== undefined && Number.isFinite(item.recordedAt) && item.recordedAt >= window.start && item.recordedAt <= window.end && item.recordedAt <= now), [captured, nativeMessages, window, now])
  const position = focusTimePosition(now, window)
  const liveNow = context?.processState === 'running' && position >= 0 && position <= 100
  const working = context?.kind === 'agent' && context.processState === 'running' && context.state === 'working'
  const work = working ? focusWorkSegment(context.workingEnteredAt, window, now) : null
  const present = !!(segments.length || messages.length || liveNow || work)
  useLayoutEffect(() => { onPresence(track.key, present); return () => onPresence(track.key, false) }, [track.key, present, onPresence])
  if (!present) return null
  const currentFact = `Run alive · ${context?.stateLabel}${working && !work ? ' · Work start unknown' : ''} · Run start unknown`
  const path = [identity?.branch, identity?.topicId].filter(Boolean).join(' / ')
  return <div className="recent-focus__track" data-focus-timeline-id={sessionId} data-history-only={!context ? 'true' : undefined}>
    <span className="recent-focus__gutter" title={`${name} · ${identity?.workspacePath ?? context?.workspacePath ?? 'Historical identity not recorded'}${path ? ` · ${path}` : ''}`}>
      {context?.kind === 'agent' ? <AgentAvatar sessionId={sessionId} label={name} providerId={context.providerId ?? undefined} state={context.state} size={14} /> : identity?.kind === 'terminal' || context?.kind === 'terminal' ? <SquareTerminal size={13} /> : <History size={13} />}
      <span>{name}{path ? <small>{path}</small> : null}</span>{!context ? <History size={10} aria-label={segments.length ? 'Retained focus observation' : 'Retained input records'} /> : null}</span>
    <div className="recent-focus__lane">
      {position >= 0 && position <= 100 ? <span className="recent-focus__playhead" data-now={now} style={{ left: `${position}%` }} aria-hidden="true" /> : null}
      {work && context ? <button type="button" className="recent-focus__working" data-working-entered-at={work.enteredAt} data-working-through={Math.min(now, window.end)} data-run-id={context.runId}
        style={{ left: `${work.left}%`, width: `${work.width}%` }}
        aria-label={`Return to ${context.name}, working since ${dateClock(work.enteredAt)}, Run start unknown`}
        title={`${context.name} · Working since ${dateClock(work.enteredAt)} · Work state, not Run duration`}
        onClick={() => onSelect(context.id)} /> : null}
      {liveNow && context ? <button type="button" className={`recent-focus__live${working ? ' is-working' : ''}`} data-run-state="running" data-run-id={context.runId}
        style={{ left: `${position}%` }} aria-label={`Return to ${context.name}, ${currentFact}, current time ${clock(now)}`}
        title={`${currentFact} · Current time ${dateClock(now)}`} onClick={() => onSelect(context.id)} /> : null}
      {segments.map((item, index) => <button key={`${item.focusedAt}:${index}`} type="button" className={`recent-focus__segment${selected ? ' is-current' : ''}${item.end === undefined ? ' is-open' : ''}`}
        style={{ left: `${item.left}%`, width: item.width === undefined ? undefined : `${item.width}%` }}
        data-focused-at={item.focusedAt} data-known-end={item.end} aria-current={selected ? 'true' : undefined}
        aria-label={`${context ? 'Return to' : 'Inspect focus in'} ${item.identity?.name ?? name}, focused at ${dateClock(item.focusedAt)}${item.end === undefined ? ', next focus not recorded' : ''}`}
        title={`${item.identity?.name ?? 'Historical name not recorded'} · ${item.identity?.project?.name ?? 'Project not recorded'} · Focused ${dateClock(item.focusedAt)}${item.end === undefined ? ' · Next focus not recorded' : ''}`}
        onClick={event => context ? onSelect(sessionId) : onInspect(item, event.currentTarget)}><span>{clock(item.focusedAt)}</span></button>)}
      {messages.map(message => {
        const speaker = speakerOfUserMessage(message)
        const described = describeMessageSpeaker(speaker)
        const authorLabel = speaker.role === 'agent' ? `Agent message · Sender ${speaker.id}` : speaker.role === 'human' ? 'Human message · You' : 'Prompt · Sender not recorded'
        return <button key={message.id} type="button" className="recent-focus__message" data-message-id={message.id} data-message-raw-id={message.rawId} data-message-source={message.source.kind} data-message-at={message.recordedAt} data-message-author={speaker.role}
          style={{ left: `${focusTimePosition(message.recordedAt!, window)}%` }} aria-label={speaker.role === 'agent' ? `Agent message in ${name} at ${clock(message.recordedAt!)}, sender ${speaker.id}` : speaker.role === 'human' ? `Your message in ${name} at ${clock(message.recordedAt!)}` : `Prompt in ${name} at ${clock(message.recordedAt!)}, sender not recorded`}
          title={`${name} · Record time ${dateClock(message.recordedAt!)} · ${authorLabel}\n${message.content.slice(0, 160)}`}
          onMouseEnter={event => onPreview(message, event.currentTarget, false)} onMouseLeave={() => onDismiss(message.id)}
          onFocus={event => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.recent-focus__message-preview'))) onPreview(message, event.currentTarget, false) }} onBlur={() => onDismiss(message.id)}
          onClick={event => onPreview(message, event.currentTarget, true)}><ConversationSpeakerAvatar speaker={speaker} name={described.name} size={10} /></button>
      })}
    </div>
  </div>
})

const FocusTimeProject = memo(function FocusTimeProject({ project, registered, currentSessionId, inputContextId, inputTrackKey, nativeMessages, window, now, onSelect, onPreview, onDismiss, onInspect }: {
  project: FocusTimelineProject; registered: boolean; currentSessionId: string | null; inputContextId: string | undefined
  inputTrackKey?: string | undefined
  nativeMessages: readonly AgentSessionUserMessage[]; window: FocusTimeWindow; now: number
  onSelect(id: string): void; onPreview(message: AgentSessionUserMessage, target: HTMLElement, interactive: boolean): void
  onDismiss(id: string): void; onInspect(segment: FocusTimeSegment, anchor: HTMLElement): void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const present = useRef(new Set<string>())
  const [, notifyPresence] = useState(0)
  const observePresence = useCallback((key: string, visible: boolean) => {
    if (present.current.has(key) === visible) return
    if (visible) present.current.add(key); else present.current.delete(key)
    notifyPresence(revision => revision + 1)
  }, [])
  const count = project.tracks.filter(track => present.current.has(track.key)).length
  return <section className="recent-focus__project" data-timeline-project={project.key} hidden={count === 0}>
    <button type="button" className="recent-focus__project-heading" aria-label={`${collapsed ? 'Expand' : 'Collapse'} project ${project.name}`} aria-expanded={!collapsed} title={`${project.name} · ${count} Contexts · Project summary, not Run duration${project.tracks.some(track => track.inputProjectObserved) ? ' · Observed Context project; message-time project not recorded' : ''}`} onClick={() => setCollapsed(value => !value)}>
      <span className="recent-focus__gutter">{collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}{registered && project.workspaceId ? <ProjectIcon workspaceId={project.workspaceId} name={project.name} /> : <History size={12} />}<strong>{project.name}</strong><small>{count}</small></span>
      <span className="recent-focus__project-summary" aria-hidden="true" />
    </button>
    <div className="recent-focus__project-tracks" data-collapsed={collapsed} inert={collapsed} aria-hidden={collapsed || undefined}>
      {project.tracks.map(track => <FocusTimeTrack key={track.key} track={track} selected={!!track.current && track.sessionId === currentSessionId} nativeMessages={(inputTrackKey ? track.key === inputTrackKey : track.current && track.sessionId === inputContextId) ? nativeMessages : undefined} window={window} now={now} onSelect={onSelect} onPreview={onPreview} onDismiss={onDismiss} onInspect={onInspect} onPresence={observePresence} />)}
    </div>
  </section>
})

function FocusHistoryObservation({ segment, anchor, onClose }: { segment: FocusTimeSegment; anchor: HTMLElement; onClose(): void }) {
  const identity = segment.identity
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal container={resolveOverlayContainer()}>
    <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
    <Dialog.Content className="confirmation-dialog dialog-surface recent-focus__observation" onCloseAutoFocus={event => { event.preventDefault(); if (anchor.isConnected && document.activeElement === document.body) anchor.focus() }}>
      <Dialog.Title className="confirmation-dialog__title">{identity?.name ?? segment.sessionId}</Dialog.Title>
      <Dialog.Description className="confirmation-dialog__description">Retained focus observation. Reading it does not restore a Session.</Dialog.Description>
      <dl><dt>Focused</dt><dd>{dateClock(segment.focusedAt)}</dd><dt>Next focus</dt><dd>{segment.end === undefined ? 'Not recorded' : dateClock(segment.end)}</dd>
        <dt>Project</dt><dd>{identity?.project?.name ?? 'Not recorded'}</dd><dt>Branch / Topic</dt><dd>{[identity?.branch, identity?.topicId].filter(Boolean).join(' / ') || 'Not recorded'}</dd>
        <dt>Workspace</dt><dd>{identity?.workspacePath ?? 'Not recorded'}</dd><dt>Session</dt><dd>{segment.sessionId}</dd></dl>
      <p>Focus visits are retained here. Message and execution history coverage may be incomplete.</p>
      <footer><Dialog.Close asChild><button type="button" className="small-button">Close</button></Dialog.Close></footer>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
export const RecentFocusTimeline = memo(function RecentFocusTimeline({ entries, currentSessionId, contexts, lanes, hierarchy, onSelect }: {
  entries: readonly AgentFocusHistoryEntry[]; currentSessionId: string | null; contexts: readonly FocusContext[]
  lanes?: readonly FocusProjectLane[]; hierarchy?: FocusHierarchyFacts; onSelect(sessionId: string): void
}) {
  const [mode, setMode] = useState<'compact' | 'expanded' | 'collapsed'>('compact')
  const [hours, setHours] = useState<number>(4)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now)
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden')
  const [readingContextId, setReadingContextId] = useState<string | null>(null)
  const [readerOpen, setReaderOpen] = useState(false)
  const [earlier, setEarlier] = useState(false)
  const [preview, setPreview] = useState<{ message: AgentSessionUserMessage | undefined; interactive: boolean; anchor: HTMLElement } | null>(null)
  const [observation, setObservation] = useState<{ segment: FocusTimeSegment; anchor: HTMLElement } | null>(null)
  const inspectObservation = useCallback((segment: FocusTimeSegment, anchor: HTMLElement) => setObservation({ segment, anchor }), [])
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const observe = () => {
      if (timer) clearInterval(timer)
      const visible = document.visibilityState !== 'hidden'; setDocumentVisible(visible)
      if (visible && mode !== 'collapsed') { setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), 30_000) }
    }
    observe(); document.addEventListener('visibilitychange', observe)
    return () => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', observe) }
  }, [mode])
  const config = useAppStore(state => state.config)
  const registeredProjects = useMemo(() => new Set(config?.workspaces.map(workspace => JSON.stringify([workspace.hostId, workspace.id]))), [config])
  const savedHeight = useAppStore(state => state.focusTimelineHeight)
  const saveHeight = useAppStore(state => state.setFocusTimelineHeight)
  const timelineRef = useRef<HTMLElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const viewportIntent = useRef({ hours, now }); viewportIntent.current = { hours, now }
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const wheel = (event: WheelEvent) => {
      const target = event.target
      if (!(target instanceof Element) || target.closest('button, input, select, textarea, [contenteditable="true"], .recent-focus__gutter') || !target.closest('.recent-focus__time-scale, .recent-focus__lane, .recent-focus__project-summary')) return
      const width = viewport.querySelector('.recent-focus__time-scale')?.getBoundingClientRect().width ?? 0
      const movement = focusWheelTimeDelta(event, width, viewportIntent.current.hours)
      if (!movement) return
      event.preventDefault()
      setAnchor(current => (current ?? viewportIntent.current.now) + movement)
      setObservation(null)
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => viewport.removeEventListener('wheel', wheel)
  }, [mode])
  const closePreview = useCallback(() => { setPreview(null); setReaderOpen(false) }, [])
  const inspectMessage = useCallback((message: AgentSessionUserMessage, target: HTMLElement, interactive: boolean) => {
    setPreview(current => !interactive && current?.interactive ? current : { message, interactive, anchor: target })
  }, [])
  const dismissMessage = useCallback((messageId: string) => setPreview(current => current?.message?.id === messageId && !current.interactive ? null : current), [])
  const catalogue = useFocusHistorySources(mode !== 'collapsed' && documentVisible)
  const [sourceLimit, setSourceLimit] = useState(30)
  const observations = useMemo(() => observeFocusInputTracks(entries), [entries])
  const inputSources = useMemo(() => {
    const available = new Map(contexts.filter(context => context.kind === 'agent').map(context => [context.id, {
      id: context.id, name: context.name, workspaceName: context.workspaceName,
      reference: { hostId: context.hostId, agentSessionId: context.id } satisfies SessionHistoryReference,
      workspacePath: context.workspacePath, details: `Session: ${context.id}\nCurrent workspace: ${context.workspacePath}`
    }]))
    for (const source of catalogue.sources) if (!available.has(source.agentSessionId)) {
      const observation = resolveFocusInputTrack(observations, source).identity
      available.set(source.agentSessionId, { id: source.agentSessionId, name: observation?.name ?? `${source.history ? agentProviderLabel(source.history.providerId) : 'Provider not recorded'} · ${source.agentSessionId.length <= 12 ? source.agentSessionId : `${source.agentSessionId.slice(0, 8)}…${source.agentSessionId.slice(-4)}`}`,
        workspaceName: `${observation?.project ? `${observation.project.name} (observed Context)` : 'Project not recorded'} · ${source.state === 'retired' ? 'Archived' : 'Stored source'}`,
        reference: { hostId: source.hostId, agentSessionId: source.agentSessionId }, workspacePath: source.history?.workspacePath ?? '', details: `Session: ${source.agentSessionId}\nObserved Context project: ${observation?.project?.name ?? 'Not recorded or conflicting'}\nMessage-time project: Not recorded\nProvider: ${source.history ? agentProviderLabel(source.history.providerId) : 'Provider not recorded'}\nStored source workspace: ${source.history?.workspacePath ?? 'Not recorded'}` })
    }
    return [...available.values()]
  }, [contexts, observations, catalogue.sources])
  const inputContextId = readingContextId ?? currentSessionId
  const inputContext = contexts.find(context => context.id === inputContextId && context.kind === 'agent')
  const inputSource = inputSources.find(source => source.id === inputContextId)
  const inputControl = useAppStore(state => {
    const session = state.sessions.find(item => item.id === inputContext?.id)
    return session?.kind === 'agent' ? session.control : undefined
  })
  const inputTimeline = useAppStore(state => inputContext ? state.timelines[inputContext.id] : undefined)
  const inputReference = inputSource?.reference
  const readonlyReading = !!inputReference && !inputControl
  const readingEnabled = mode !== 'collapsed' && documentVisible && !!inputReference
  const historical = anchor !== null || earlier || readonlyReading
  const [latest, setLatest] = useState<LatestInputs>(EMPTY_LATEST_INPUTS)
  // The viewport filters a bounded snapshot; it is not another reading intent.
  const readingScope = JSON.stringify([inputReference?.hostId, inputReference?.agentSessionId, inputControl?.run.runId, historical ? 'snapshot' : 'latest', readonlyReading])
  const nativeWindow = useFocusInputWindow(inputReference, readingScope, readingEnabled && historical, preview?.message, readonlyReading)
  const projected = useMemo(() => inputReference ? historical
    ? projectSessionUserMessages({ agentSessionId: inputReference.agentSessionId, timeline: readonlyReading ? nativeWindow.timeline : inputTimeline, historyPage: nativeWindow.page ?? undefined })
    : inputControl && readingEnabled ? latest.messages : projectSessionUserMessages({ agentSessionId: inputReference.agentSessionId, timeline: inputTimeline }) : [], [inputReference?.agentSessionId, inputControl, readingEnabled, historical, readonlyReading, inputTimeline, nativeWindow.page, nativeWindow.timeline, latest.messages])
  // A changed reading Context never briefly presents the previous leaf's data.
  // Latest is bounded by its leaf; the historical window bounds raw records.
  const inputMessages = useMemo(() => projected.filter(item => item.agentSessionId === inputReference?.agentSessionId), [projected, inputReference?.agentSessionId])
  const nativeMessages = useMemo(() => inputMessages.filter(item => item.source.kind === 'native'), [inputMessages])
  useEffect(() => {
    if (!documentVisible || mode === 'collapsed') { setPreview(null); setObservation(null); setReaderOpen(false); setReadingContextId(null); setEarlier(false) }
  }, [documentVisible, mode])
  const drag = useRef<{ y: number; height: number; next: number } | null>(null)
  const [draftHeight, setDraftHeight] = useState<number | null>(null)
  const [maximum, setMaximum] = useState(FOCUS_TIMELINE_HEIGHT_MAX)
  const [headerHeight, setHeaderHeight] = useState(28)
  const minimum = Math.min(Math.max(FOCUS_TIMELINE_HEIGHT_MIN, headerHeight + 18 + 24 + 1), maximum)
  const height = Math.min(maximum, Math.max(minimum, draftHeight ?? savedHeight))
  useEffect(() => {
    const parent = timelineRef.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const available = parent.getBoundingClientRect().height
      if (available > 0) setMaximum(Math.min(FOCUS_TIMELINE_HEIGHT_MAX, Math.max(28, Math.floor((available - 36) / 2))))
      const measuredHeader = headerRef.current?.getBoundingClientRect().height ?? 0
      if (measuredHeader > 0) setHeaderHeight(Math.ceil(measuredHeader))
    }
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    if (headerRef.current) observer.observe(headerRef.current)
    update()
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
    const cancel = () => {
      if (!drag.current) return
      drag.current = null; setDraftHeight(null)
      document.body.style.cursor = ''; document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', stop)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', stop); if (drag.current) { document.body.style.cursor = ''; document.body.style.userSelect = '' } }
  }, [maximum, minimum, saveHeight])
  const effectiveAnchor = anchor ?? now
  const range = useMemo(() => focusTimeWindow(effectiveAnchor, hours), [effectiveAnchor, hours])
  const tracks = useMemo(() => focusTimeSegments(entries, range, now), [entries, range, now])
  const readonlyInputTrackId = readonlyReading && inputMessages.some(message => message.recordedAt !== undefined && Number.isFinite(message.recordedAt) && message.recordedAt >= range.start && message.recordedAt <= Math.min(now, range.end)) ? inputReference?.agentSessionId : undefined
  const observedInputTrack = useMemo(() => inputReference ? resolveFocusInputTrack(observations, inputReference) : undefined, [observations, inputReference?.hostId, inputReference?.agentSessionId])
  const readonlyInputTrack = readonlyInputTrackId ? observedInputTrack : undefined
  const inputTrackKey = readonlyInputTrack?.key
  const projects = useMemo(() => groupFocusTimeline(contexts, lanes ?? [], tracks, readonlyInputTrack), [contexts, lanes, tracks, readonlyInputTrack])
  const tickTimes = Array.from({ length: 5 }, (_, i) => range.start + (range.end - range.start) * i / 4)
  const position = focusTimePosition(now, range)
  const previewContext = preview?.message ? contexts.find(context => context.id === preview.message!.agentSessionId) : inputContext
  const previewSpeaker = preview?.message ? speakerOfUserMessage(preview.message) : undefined
  const senderId = previewSpeaker?.role === 'agent' ? previewSpeaker.id : undefined
  const sender = senderId ? contexts.find(context => context.id === senderId && context.kind === 'agent') : undefined
  const senderLane = sender ? lanes?.find(lane => lane.contextIds.includes(sender.id)) : undefined
  const describePreviewSpeaker = useMemo(() => createSpeakerResolver({ lookupAgent: id => {
    const context = contexts.find(item => item.id === id && item.kind === 'agent')
    return context ? { label: context.name, ...(context.providerId ? { providerId: context.providerId } : {}) } : undefined
  } }), [contexts])
  const inspectWindow = (next: number | null) => { setAnchor(next); setObservation(null) }
  const zoomIndex = FOCUS_WINDOW_HOURS.findIndex(size => size === hours)
  const openInputRecords = (target: HTMLElement) => {
    setReaderOpen(true); setPreview({ message: undefined, interactive: true, anchor: target })
  }
  const inputCoverage = !inputReference ? 'Choose a Context to read its inputs.' : historical ? nativeWindow.page
    ? `${nativeWindow.page.items.length} native records retained${nativeWindow.rotated ? ' · Newer records are outside this reading window' : ''}. ${nativeWindow.page.nextCursor === null ? 'Beginning of this available snapshot reached.' : 'Coverage incomplete. Earlier records can still be read.'}`
    : 'Native history has not been read for this window. Coverage unknown.'
    : 'Latest input view. Earlier coverage is unknown; read earlier records to inspect the native snapshot.'
  return <section ref={timelineRef} style={{ height: mode === 'collapsed' ? 28 : height } as CSSProperties} className="recent-focus" aria-label="Recent Focus" data-mode={mode} data-window-start={range.start} data-window-end={range.end}>
    <FocusLatestInputs control={inputControl} enabled={readingEnabled && !historical} pinned={historical ? undefined : preview?.message} onChange={setLatest} />
    {mode !== 'collapsed' ? <div className="recent-focus__resize" role="separator" tabIndex={0} aria-label="Resize Focus timeline" aria-orientation="horizontal" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={height}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { y: event.clientY, height, next: height }; document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none' }}
      onKeyDown={event => { const next = event.key === 'ArrowUp' ? height + 16 : event.key === 'ArrowDown' ? height - 16 : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null; if (next !== null) { event.preventDefault(); saveHeight(Math.min(maximum, Math.max(minimum, next))) } }} /> : null}
    <header ref={headerRef} className="recent-focus__header">
      <span className="recent-focus__title"><History size={12} /><strong>Recent Focus</strong><span className="recent-focus__range" title="Work bands show proven working states; Now marks live Runs; thin clips show focus visits. Run start times are unknown. Input markers use recorded times from Core. Unknown-time inputs and incomplete native coverage are available through Input records. Shows up to 2000 retained focus switches within 512 KiB of serialized UTF-16 history; older observations may be outside retention.">{dateClock(range.start)} — {dateClock(range.end)}</span></span>
      <span className="recent-focus__controls" onPointerDownCapture={event => {
        const control = event.target instanceof Element ? event.target.closest('[data-focus-window-control]') : null
        if (!control) return
        // A viewport action is part of inspecting the same input, not an outside
        // click that dismisses it. Native date/select interaction remains intact.
        event.stopPropagation()
        if (control instanceof HTMLButtonElement) event.preventDefault()
      }}>
        {mode !== 'collapsed' ? <><button type="button" className="icon-button" aria-label="View input records" aria-expanded={readerOpen} title={`Input records${inputSource ? ` · ${inputSource.name}` : ''}, including inputs without a recorded time`} onClick={event => openInputRecords(event.currentTarget)}><MessageSquare size={12} /></button><input data-focus-window-control type="datetime-local" className="recent-focus__date" aria-label="Focus history date and time" value={localDateTime(anchor ?? now)} onChange={event => { const next = new Date(event.target.value).getTime(); if (Number.isFinite(next)) inspectWindow(next) }} />
        <button data-focus-window-control type="button" className="icon-button" aria-label="Previous focus window" onClick={() => inspectWindow((anchor ?? now) - hours * HOUR_MS)}><ChevronLeft size={12} /></button>
        <button data-focus-window-control type="button" className="icon-button" aria-label="Zoom out Focus timeline" title="Zoom out · wider time window" disabled={zoomIndex === FOCUS_WINDOW_HOURS.length - 1} onClick={() => setHours(FOCUS_WINDOW_HOURS[zoomIndex + 1]!)}><Minus size={12} /></button>
        <select data-focus-window-control aria-label="Focus window size" value={hours} onChange={event => setHours(Number(event.target.value))}>{FOCUS_WINDOW_HOURS.map(size => <option key={size} value={size}>{focusWindowLabel(size)}</option>)}</select>
        <button data-focus-window-control type="button" className="icon-button" aria-label="Zoom in Focus timeline" title="Zoom in · narrower time window" disabled={zoomIndex === 0} onClick={() => setHours(FOCUS_WINDOW_HOURS[zoomIndex - 1]!)}><Plus size={12} /></button>
        <button data-focus-window-control type="button" className="icon-button" aria-label="Next focus window" onClick={() => inspectWindow((anchor ?? now) + hours * HOUR_MS)}><ChevronRight size={12} /></button>
        <button data-focus-window-control type="button" className="recent-focus__now" aria-label="Return to current focus window" aria-pressed={anchor === null} onClick={() => { setNow(Date.now()); inspectWindow(null) }}>Now</button></> : null}
        <button type="button" className="icon-button" aria-label={mode === 'expanded' ? 'Compact focus history' : 'Expand focus history'} onClick={() => { saveHeight(mode === 'expanded' ? 96 : Math.min(maximum, 168)); setMode(mode === 'expanded' ? 'compact' : 'expanded') }}><ChevronUp size={12} /></button>
        <button type="button" className="icon-button" aria-label={mode === 'collapsed' ? 'Show focus history' : 'Collapse focus history'} aria-expanded={mode !== 'collapsed'} onClick={() => { setPreview(null); setMode(mode === 'collapsed' ? 'compact' : 'collapsed') }}><ChevronDown size={12} /></button>
      </span>
    </header>
    {mode !== 'collapsed' ? <div ref={viewportRef} className="recent-focus__viewport">
      <div className="recent-focus__canvas">
        <div className="recent-focus__ruler" aria-label="Focus time ruler"><span className="recent-focus__gutter">Context</span><div className="recent-focus__time-scale" title="Scroll horizontally or Shift+scroll to browse time">{tickTimes.map((time, i) => <time key={i} style={{ left: `${focusTimePosition(time, range)}%` }}>{clock(time)}</time>)}{position >= 0 && position <= 100 ? <span className="recent-focus__playhead recent-focus__playhead--ruler" data-now={now} style={{ left: `${position}%` }} aria-label={`Current time ${clock(now)}`} /> : null}</div></div>
        <div className="recent-focus__tracks">
          {projects.map(project => <FocusTimeProject key={project.key} project={project} registered={registeredProjects.has(project.key)} currentSessionId={currentSessionId} inputContextId={inputReference?.agentSessionId} inputTrackKey={inputTrackKey} nativeMessages={readonlyReading ? inputMessages : nativeMessages} window={range} now={now} onSelect={onSelect} onPreview={inspectMessage} onDismiss={dismissMessage} onInspect={inspectObservation} />)}
        </div>
        <p className="recent-focus__empty">No read records in this window. Native coverage may be incomplete; use Input records.</p>
      </div>
    </div> : null}
    {observation ? <FocusHistoryObservation segment={observation.segment} anchor={observation.anchor} onClose={() => setObservation(null)} /> : null}
    {preview ? <FocusMessagePreview describeSpeaker={describePreviewSpeaker} message={preview.message} recipient={previewContext} recipientName={inputSource?.name} workspaceRoot={inputSource?.workspacePath} sender={sender} lane={senderLane} hierarchy={hierarchy} interactive={preview.interactive} anchor={preview.anchor} onSelect={onSelect} onClose={closePreview}
      {...(readerOpen ? { reader: {
        contexts: inputSources.slice(0, sourceLimit), contextId: inputReference?.agentSessionId ?? null, messages: inputMessages,
        sourceCoverage: catalogue.loading ? 'Discovering retained input sources…' : `${Math.min(sourceLimit, inputSources.length)} of ${inputSources.length} sources listed. Other sources have not been read for this window.`,
        sourceError: catalogue.error, onRefreshSources: catalogue.refresh,
        onMoreSources: sourceLimit < inputSources.length ? () => setSourceLimit(value => Math.min(inputSources.length, value + 30)) : undefined,
        loading: historical ? nativeWindow.loading : latest.loading, coverage: inputCoverage,
        error: !inputReference ? null : historical ? [nativeWindow.error, nativeWindow.capturedError].filter(Boolean).join(' ') || null : latest.error ? presentError(latest.error) : null,
        canContinue: !!inputReference && (!historical || nativeWindow.page?.nextCursor !== null),
        onContext: (id: string) => { setReadingContextId(id); setEarlier(false); setPreview(current => current ? { ...current, message: undefined } : current) },
        onMessage: (message: AgentSessionUserMessage) => setPreview(current => current ? { ...current, message } : current),
        onContinue: () => { if (!historical) setEarlier(true); else nativeWindow.continueReading() },
        onRefresh: () => { setPreview(current => current ? { ...current, message: undefined } : current); if (historical) nativeWindow.refresh(); else void latest.refresh() }
      } } : {})} /> : null}
  </section>
})
