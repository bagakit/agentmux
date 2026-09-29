import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, History, MessageSquare, Minus, Plus, SquareTerminal } from 'lucide-react'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import type { AgentSessionHistoryPage, AgentSessionUserMessage, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentSessionControl, SessionHistoryReference } from '../../../shared/contracts'
import type { AgentFocusHistoryEntry } from '../lib/agent-focus'
import type { FocusContext } from '../lib/focus-context'
import { useAppStore } from '../store'
import { FOCUS_TIMELINE_HEIGHT_MAX, FOCUS_TIMELINE_HEIGHT_MIN } from '../lib/focus-timeline-height'
import { FOCUS_TIMELINE_NAME_WIDTH_MIN, FOCUS_TIMELINE_NAME_WIDTH_MAX } from '../lib/focus-timeline-name-width'
import { useSidebarResize } from '../hooks/useSidebarResize'
import { AgentAvatar } from './AgentAvatar'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { createSpeakerResolver, speakerOfUserMessage } from '../lib/conversation-speaker'
import { agentProviderLabel } from './AgentProviderIcon'
import { ProjectIcon } from './ProjectIcon'
import * as Dialog from '@radix-ui/react-dialog'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { createFocusTimelineOrder, extendFocusTimelineOrder, focusTimelineOrderCandidates, groupFocusTimeline, observeFocusInputTracks, orderFocusTimelineProjects, resolveFocusInputTrack, type FocusTimelineProject, type FocusTimelineTrack } from '../lib/focus-history-timeline'
import { FocusMessagePreview } from './FocusMessagePreview'
import { FocusTimelineRulerSettings, type FocusDateChoice } from './FocusTimelineRulerSettings'
import { createFocusTimeFormatters, focusDateCandidates, focusRulerLabels, focusRulerTicks, focusUtcOffset, resolvedFocusTimeZone, type FocusTimeFormatters } from '../lib/focus-timeline-ruler'
import { useSessionUserMessages } from '../lib/session-user-messages'
import { useFocusHistorySources } from '../lib/focus-history-sources'
import { api } from '../lib/api'
import { presentError } from '../lib/error-presentation'
import type { FocusHierarchyFacts, FocusProjectLane } from '../lib/focus-project-lanes'
import { FOCUS_WINDOW_HOURS, HOUR_MS, focusTimePosition, focusTimeSegments, focusTimeWindow, focusWheelTimeDelta, focusWindowLabel, focusWorkSegment, type FocusTimeSegment, type FocusTimeWindow } from '../lib/focus-time-window'

const describeMessageSpeaker = createSpeakerResolver()

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
  const pinnedNative = pinned?.source.kind === 'native' ? pinned : undefined
  const messages = useMemo(() => {
    const native = latest.messages.filter(item => item.source.kind === 'native')
    const pin = pinnedNative
    const protectedMessage = pin && native.find(item => item.id === pin.id)
    const capacity = pin ? MAX_NATIVE_RECORDS - 1 : MAX_NATIVE_RECORDS
    const retained = protectedMessage ? [...native.filter(item => item !== protectedMessage).slice(-capacity), protectedMessage] : native.slice(-capacity)
    return [...retained, ...latest.messages.filter(item => item.source.kind === 'captured')]
  }, [latest.messages, pinnedNative])
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

const FocusTimeTrack = memo(function FocusTimeTrack({ track, selected, nativeMessages, window, now, lane, time, onSelect, onPreview, onDismiss, onInspect, onPresence }: {
  track: FocusTimelineTrack; selected: boolean; window: FocusTimeWindow; now: number
  nativeMessages?: readonly AgentSessionUserMessage[] | undefined
  lane?: FocusProjectLane | undefined
  time: FocusTimeFormatters
  onSelect(id: string): void; onPreview(message: AgentSessionUserMessage, target: HTMLElement, interactive: boolean, immediate?: boolean): void; onDismiss(messageId: string): void
  onInspect(segment: FocusTimeSegment, anchor: HTMLElement): void; onPresence(key: string, present: boolean): void
}) {
  const { clock, dateClock } = time
  const { current: context, segments, identity, sessionId } = track
  const gutter = useRef<HTMLSpanElement>(null)
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
  const currentPath = lane?.labels.slice(1).join(' / ')
  const project = context ? lane?.labels[0] ?? context.workspaceName : identity?.project?.name
  const disclosure = {
    label: `Inspect ${name} Context`, scope: JSON.stringify([track.key, context?.runId, context?.hostId, context?.workspacePath, context?.topicId]),
    reference: () => {
      const avatar = gutter.current!.querySelector<HTMLElement>('.agent-avatar')!
      const header = gutter.current!.closest('.recent-focus')!.querySelector<HTMLElement>('.recent-focus__header')!
      return { contextElement: header, getBoundingClientRect() {
        const bounds = avatar.getBoundingClientRect()
        return new DOMRect(bounds.left, header.getBoundingClientRect().top, bounds.width, 0)
      } }
    },
    ...(context?.kind === 'terminal' || identity?.kind === 'terminal' ? { mark: <SquareTerminal size={12} /> } : !context && !identity?.providerId ? { mark: <History size={12} /> } : {}),
    content: <><header><strong>{name}</strong><span>{context ? context.stateLabel : 'Retained history'}</span></header>
      <p className="recent-focus__context-location">{project ?? 'Project not recorded'}{(context ? currentPath : path) ? <small>{context ? currentPath : path}</small> : null}</p>
      {context?.detail ? <p className="recent-focus__context-task">{context.detail}</p> : null}
      {context && lane?.summary && lane.summary !== context.detail ? <p className="recent-focus__context-topic"><span>Topic summary</span>{lane.summary}</p> : null}
      <footer>{context?.lastActivityAt ? <span>Last activity <time>{dateClock(context.lastActivityAt)}</time></span> : !context ? <span>Observed identity · Current state not recorded</span> : <span>Current Context</span>}<span>{context ? 'Click to open' : segments.length ? 'Click to inspect' : 'Read-only history'}</span></footer>
    </>
  }
  return <div className="recent-focus__track" data-focus-timeline-id={sessionId} data-history-only={!context ? 'true' : undefined}>
    <span ref={gutter} className="recent-focus__gutter" title={`${name} · ${identity?.workspacePath ?? context?.workspacePath ?? 'Historical identity not recorded'}${path ? ` · ${path}` : ''}`}>
      <AgentAvatar sessionId={context?.kind === 'agent' ? sessionId : undefined} label={name} providerId={context?.providerId ?? identity?.providerId ?? undefined} state={context?.state} size={14} disclosure={disclosure}
        onOpen={context ? () => onSelect(context.id) : segments.length ? () => {
          const anchor = gutter.current?.querySelector<HTMLElement>('.agent-avatar')
          if (anchor) onInspect(segments[0]!, anchor)
        } : undefined} />
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
          onFocus={event => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.recent-focus__message-preview'))) onPreview(message, event.currentTarget, false, true) }} onBlur={() => onDismiss(message.id)}
          onClick={event => onPreview(message, event.currentTarget, true)}><ConversationSpeakerAvatar speaker={speaker} name={described.name} size={10} /></button>
      })}
    </div>
  </div>
})

const FocusTimeProject = memo(function FocusTimeProject({ project, registered, currentSessionId, inputContextId, inputTrackKey, nativeMessages, window, now, lanesByContext, time, onSelect, onPreview, onDismiss, onInspect }: {
  project: FocusTimelineProject; registered: boolean; currentSessionId: string | null; inputContextId: string | undefined
  inputTrackKey?: string | undefined
  nativeMessages: readonly AgentSessionUserMessage[]; window: FocusTimeWindow; now: number
  lanesByContext: ReadonlyMap<string, FocusProjectLane>
  time: FocusTimeFormatters
  onSelect(id: string): void; onPreview(message: AgentSessionUserMessage, target: HTMLElement, interactive: boolean, immediate?: boolean): void
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
      {project.tracks.map(track => <FocusTimeTrack key={track.key} track={track} selected={!!track.current && track.sessionId === currentSessionId} nativeMessages={(inputTrackKey ? track.key === inputTrackKey : track.current && track.sessionId === inputContextId) ? nativeMessages : undefined} window={window} now={now} lane={track.current ? lanesByContext.get(track.sessionId) : undefined} time={time} onSelect={onSelect} onPreview={onPreview} onDismiss={onDismiss} onInspect={onInspect} onPresence={observePresence} />)}
    </div>
  </section>
})

function FocusHistoryObservation({ segment, anchor, time, onClose }: { segment: FocusTimeSegment; anchor: HTMLElement; time: FocusTimeFormatters; onClose(): void }) {
  const identity = segment.identity
  const dateClock = time.detailed
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
  const [dateDraft, setDateDraft] = useState<string | null>(null)
  const [dateError, setDateError] = useState<string | null>(null)
  const [dateChoice, setDateChoice] = useState<FocusDateChoice | null>(null)
  const ruler = useAppStore(state => state.focusTimelineRuler)
  const saveRuler = useAppStore(state => state.setFocusTimelineRuler)
  // System can change while the app is alive. Resolve it once per existing render
  // so the grid, date input and message clocks use the same presentation snapshot.
  const displayedTimeZone = resolvedFocusTimeZone(ruler.timeZone)
  const displayedRuler = useMemo(() => ({ ...ruler, timeZone: displayedTimeZone }), [ruler, displayedTimeZone])
  const time = useMemo(() => createFocusTimeFormatters(displayedTimeZone), [displayedTimeZone])
  const { clock, dateClock } = time
  useEffect(() => { setDateDraft(null); setDateError(null); setDateChoice(null) }, [time.zone])
  const [now, setNow] = useState(Date.now)
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden')
  const [readingContextId, setReadingContextId] = useState<string | null>(null)
  const [readerOpen, setReaderOpen] = useState(false)
  const readerOpenRef = useRef(readerOpen); readerOpenRef.current = readerOpen
  const [earlier, setEarlier] = useState(false)
  const [preview, setPreview] = useState<{ message: AgentSessionUserMessage | undefined; interactive: boolean; anchor: HTMLElement } | null>(null)
  const previewRef = useRef(preview); previewRef.current = preview
  const previewTimers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout>; messageId?: string }>({})
  const cancelPreviewIntent = useCallback(() => {
    clearTimeout(previewTimers.current.open); clearTimeout(previewTimers.current.close)
    previewTimers.current = {}
  }, [])
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
  const lanesByContext = useMemo(() => {
    const result = new Map<string, FocusProjectLane>()
    for (const lane of lanes ?? []) for (const id of lane.contextIds) result.set(id, lane)
    return result
  }, [lanes])
  const savedHeight = useAppStore(state => state.focusTimelineHeight)
  const saveHeight = useAppStore(state => state.setFocusTimelineHeight)
  const savedNameWidth = useAppStore(state => state.focusTimelineNameWidth)
  const saveNameWidth = useAppStore(state => state.setFocusTimelineNameWidth)
  const timelineRef = useRef<HTMLElement>(null)
  const nameHandleRef = useRef<HTMLDivElement>(null)
  const [nameMaximum, setNameMaximum] = useState(FOCUS_TIMELINE_NAME_WIDTH_MAX)
  const nameWidth = Math.min(nameMaximum, Math.max(FOCUS_TIMELINE_NAME_WIDTH_MIN, savedNameWidth))
  const applyNameWidth = useCallback((draft: number) => {
    const rendered = Math.min(nameMaximum, Math.max(FOCUS_TIMELINE_NAME_WIDTH_MIN, draft))
    timelineRef.current?.style.setProperty('--focus-name-width', `${rendered}px`)
    nameHandleRef.current?.setAttribute('aria-valuenow', String(rendered))
  }, [nameMaximum])
  const nameResize = useSidebarResize<HTMLDivElement>({
    isOpen: mode !== 'collapsed', width: savedNameWidth,
    minWidth: FOCUS_TIMELINE_NAME_WIDTH_MIN, maxWidth: nameMaximum, deltaSign: 1,
    setWidth: saveNameWidth, onDraftWidthChange: applyNameWidth
  })
  useLayoutEffect(() => {
    const timeline = timelineRef.current
    if (!timeline || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const available = timeline.getBoundingClientRect().width
      const name = timeline.querySelector('.recent-focus__ruler > .recent-focus__gutter')?.getBoundingClientRect().width ?? 0
      const scale = timeline.querySelector('.recent-focus__time-scale')?.getBoundingClientRect().width ?? 0
      const usable = name + scale || available
      // Measure the canvas after its existing padding and gaps, preserving time
      // space without changing a wider saved preference.
      if (available > 0) setNameMaximum(Math.min(FOCUS_TIMELINE_NAME_WIDTH_MAX, Math.max(FOCUS_TIMELINE_NAME_WIDTH_MIN, Math.floor(usable - 160))))
    }
    const observer = new ResizeObserver(update)
    observer.observe(timeline); update()
    return () => observer.disconnect()
  }, [])
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scaleWidth, setScaleWidth] = useState(0)
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
  const closePreview = useCallback(() => { cancelPreviewIntent(); setPreview(null); setReaderOpen(false) }, [cancelPreviewIntent])
  const inspectMessage = useCallback((message: AgentSessionUserMessage, target: HTMLElement, interactive: boolean, immediate = false) => {
    cancelPreviewIntent()
    if (!interactive && previewRef.current?.interactive) return
    const open = () => {
      if (!target.isConnected || target.closest('[inert]') || document.visibilityState === 'hidden') return
      setPreview(current => !interactive && current?.interactive ? current : { message, interactive, anchor: target })
    }
    if (interactive || immediate) open()
    else { previewTimers.current.messageId = message.id; previewTimers.current.open = setTimeout(open, 180) }
  }, [cancelPreviewIntent])
  const dismissMessage = useCallback((messageId: string) => {
    if (previewTimers.current.messageId === messageId) { clearTimeout(previewTimers.current.open); delete previewTimers.current.open }
    clearTimeout(previewTimers.current.close)
    previewTimers.current.close = setTimeout(() => setPreview(current => current?.message?.id === messageId && !current.interactive ? null : current), 160)
  }, [])
  useEffect(() => cancelPreviewIntent, [cancelPreviewIntent])
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape' && !previewRef.current) cancelPreviewIntent() }
    document.addEventListener('keydown', dismiss)
    return () => document.removeEventListener('keydown', dismiss)
  }, [cancelPreviewIntent])
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
  const observedFocusSession = useRef(currentSessionId)
  useEffect(() => {
    cancelPreviewIntent()
    if (currentSessionId !== null && observedFocusSession.current !== currentSessionId) { setPreview(null); setReaderOpen(false) }
    else setPreview(current => current?.interactive ? current : null)
    observedFocusSession.current = currentSessionId
  }, [currentSessionId, cancelPreviewIntent])
  useEffect(() => {
    cancelPreviewIntent()
    setPreview(current => current?.interactive ? current : null)
  }, [inputReference?.hostId, inputReference?.agentSessionId, inputControl?.run.runId, cancelPreviewIntent])
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
  const inputNativeSource = inputMessages.find(item => item.source.kind === 'native')?.source
  const sourceIdentity = inputNativeSource?.kind === 'native' ? JSON.stringify([inputNativeSource.providerId, inputNativeSource.nativeSessionId]) : undefined
  const observedNativeSource = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!sourceIdentity) return
    if (observedNativeSource.current && observedNativeSource.current !== sourceIdentity) {
      cancelPreviewIntent(); setPreview(current => readerOpenRef.current && current?.interactive ? { ...current, message: undefined } : null)
    }
    observedNativeSource.current = sourceIdentity
  }, [sourceIdentity, cancelPreviewIntent])
  useEffect(() => {
    if (!documentVisible || mode === 'collapsed') { cancelPreviewIntent(); setPreview(null); setObservation(null); setReaderOpen(false); setReadingContextId(null); setEarlier(false) }
  }, [documentVisible, mode, cancelPreviewIntent])
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
  // A window filters facts, not the page's established display order. Read input
  // candidates depend on actual records, never unvisited catalogue metadata.
  const orderInputTrack = readonlyReading && inputMessages.length ? observedInputTrack : undefined
  const orderCandidates = useMemo(() => focusTimelineOrderCandidates(contexts, lanes ?? [], entries, orderInputTrack), [contexts, lanes, entries, orderInputTrack])
  const [timelineOrder, setTimelineOrder] = useState(() => createFocusTimelineOrder(orderCandidates))
  useLayoutEffect(() => { setTimelineOrder(before => extendFocusTimelineOrder(before, orderCandidates)) }, [orderCandidates])
  const projects = useMemo(() => orderFocusTimelineProjects(groupFocusTimeline(contexts, lanes ?? [], tracks, readonlyInputTrack), timelineOrder), [contexts, lanes, tracks, readonlyInputTrack, timelineOrder])
  const ticks = useMemo(() => focusRulerTicks(range, displayedRuler), [range, displayedRuler])
  const tickLabels = useMemo(() => focusRulerLabels(ticks, range, scaleWidth), [ticks, range, scaleWidth])
  useLayoutEffect(() => {
    const scale = viewportRef.current?.querySelector<HTMLElement>('.recent-focus__time-scale')
    if (!scale || typeof ResizeObserver === 'undefined') return
    const labels = [...scale.querySelectorAll<HTMLTimeElement>('.recent-focus__tick > time')]
    const priority = { major: 0, short: 1, shorter: 2, fine: 3 }
    const update = () => {
      const bounds = scale.getBoundingClientRect()
      setScaleWidth(bounds.width)
      // Read every candidate first, including density-hidden text. Visibility
      // preserves border-box size, so these writes do not feed back into resize.
      const measured = labels.map(node => ({ node, rect: node.getBoundingClientRect(),
        tier: node.parentElement!.dataset.tier as keyof typeof priority,
        instant: Number(node.parentElement!.dataset.tickAt)
      })).sort((a, b) => priority[a.tier] - priority[b.tier] || a.instant - b.instant)
      const accepted: DOMRect[] = []
      for (const row of measured) {
        const fits = row.rect.width > 0 && row.rect.left >= bounds.left && row.rect.right <= bounds.right && accepted.every(before => row.rect.right <= before.left || row.rect.left >= before.right)
        if (fits) accepted.push(row.rect)
        row.node.style.visibility = fits ? '' : 'hidden'
        if (fits) row.node.removeAttribute('aria-hidden')
        else row.node.setAttribute('aria-hidden', 'true')
      }
    }
    const observer = new ResizeObserver(update)
    observer.observe(scale)
    for (const label of labels) observer.observe(label, { box: 'border-box' })
    update()
    return () => observer.disconnect()
  }, [mode, tickLabels, time])
  const gridPaths = useMemo(() => (['major', 'short', 'shorter', 'fine'] as const).map(tier => ({ tier,
    path: ticks.filter(tick => tick.tier === tier).map(tick => `M${focusTimePosition(tick.instant, range)} 0V1`).join(' ')
  })), [ticks, range])
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
  const inspectWindow = (next: number | null) => { setAnchor(next); setObservation(null); setDateDraft(null); setDateError(null); setDateChoice(null) }
  const inspectDate = (value: string) => {
    setDateDraft(value); setDateChoice(null)
    const candidates = focusDateCandidates(value, time.zone)
    if (candidates.length === 1) inspectWindow(candidates[0]!.instant)
    else if (candidates.length > 1) { setDateError(null); setDateChoice({ value, candidates }) }
    else setDateError(`This clock time does not exist in ${time.zone}. The current window is unchanged.`)
  }
  const zoomIndex = FOCUS_WINDOW_HOURS.findIndex(size => size === hours)
  const openInputRecords = (target: HTMLElement) => {
    cancelPreviewIntent()
    setReaderOpen(true); setPreview({ message: undefined, interactive: true, anchor: target })
  }
  const inputCoverage = !inputReference ? 'Choose a Context to read its inputs.' : historical ? nativeWindow.page
    ? `${nativeWindow.page.items.length} native records retained${nativeWindow.rotated ? ' · Newer records are outside this reading window' : ''}. ${nativeWindow.page.nextCursor === null ? 'Beginning of this available snapshot reached.' : 'Coverage incomplete. Earlier records can still be read.'}`
    : 'Native history has not been read for this window. Coverage unknown.'
    : 'Latest input view. Earlier coverage is unknown; read earlier records to inspect the native snapshot.'
  return <section ref={timelineRef} style={{ height: mode === 'collapsed' ? 28 : height, '--focus-name-width': `${nameWidth}px` } as CSSProperties} className="recent-focus" aria-label="Recent Focus" data-mode={mode} data-ruler-mode={ruler.mode} data-time-zone={time.zone} data-window-start={range.start} data-window-end={range.end}>
    <FocusLatestInputs control={inputControl} enabled={readingEnabled && !historical} pinned={historical || !preview?.interactive ? undefined : preview.message} onChange={setLatest} />
    {mode !== 'collapsed' ? <div ref={nameResize.containerRef} className="recent-focus__name-column-resize" data-resizing={nameResize.isResizing} style={{ top: headerHeight }}>
      <div ref={nameHandleRef} className="recent-focus__name-separator" role="separator" tabIndex={0} aria-label="Resize timeline names" aria-orientation="vertical" aria-valuemin={FOCUS_TIMELINE_NAME_WIDTH_MIN} aria-valuemax={nameMaximum} aria-valuenow={nameWidth}
        onPointerDownCapture={event => event.stopPropagation()}
        onMouseDown={event => { if (event.button === 0) nameResize.onResizeStart(event) }}
        onKeyDown={event => {
          const next = event.key === 'ArrowLeft' ? nameWidth - 16 : event.key === 'ArrowRight' ? nameWidth + 16 : event.key === 'Home' ? FOCUS_TIMELINE_NAME_WIDTH_MIN : event.key === 'End' ? nameMaximum : null
          if (next === null) return
          event.preventDefault(); event.stopPropagation()
          const rendered = Math.min(nameMaximum, Math.max(FOCUS_TIMELINE_NAME_WIDTH_MIN, next))
          if (rendered !== nameWidth) saveNameWidth(rendered)
        }} />
    </div> : null}
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
        {mode !== 'collapsed' ? <><button type="button" className="icon-button" aria-label="View input records" aria-expanded={readerOpen} title={`Input records${inputSource ? ` · ${inputSource.name}` : ''}, including inputs without a recorded time`} onClick={event => openInputRecords(event.currentTarget)}><MessageSquare size={12} /></button><input data-focus-window-control type="datetime-local" className="recent-focus__date" aria-label="Focus history date and time" aria-invalid={dateError !== null} title={`Clock time in ${time.zone}`} value={dateDraft ?? time.dateInput(anchor ?? now)} onChange={event => inspectDate(event.target.value)} />
        <button data-focus-window-control type="button" className="icon-button" aria-label="Previous focus window" onClick={() => inspectWindow((anchor ?? now) - hours * HOUR_MS)}><ChevronLeft size={12} /></button>
        <button data-focus-window-control type="button" className="icon-button" aria-label="Zoom out Focus timeline" title="Zoom out · wider time window" disabled={zoomIndex === FOCUS_WINDOW_HOURS.length - 1} onClick={() => setHours(FOCUS_WINDOW_HOURS[zoomIndex + 1]!)}><Minus size={12} /></button>
        <select data-focus-window-control aria-label="Focus window size" value={hours} onChange={event => setHours(Number(event.target.value))}>{FOCUS_WINDOW_HOURS.map(size => <option key={size} value={size}>{focusWindowLabel(size)}</option>)}</select>
        <button data-focus-window-control type="button" className="icon-button" aria-label="Zoom in Focus timeline" title="Zoom in · narrower time window" disabled={zoomIndex === 0} onClick={() => setHours(FOCUS_WINDOW_HOURS[zoomIndex - 1]!)}><Plus size={12} /></button>
        <button data-focus-window-control type="button" className="icon-button" aria-label="Next focus window" onClick={() => inspectWindow((anchor ?? now) + hours * HOUR_MS)}><ChevronRight size={12} /></button>
        <button data-focus-window-control type="button" className="recent-focus__now" aria-label="Return to current focus window" aria-pressed={anchor === null} onClick={() => { setNow(Date.now()); inspectWindow(null) }}>Now</button></> : null}
        {mode !== 'collapsed' ? <FocusTimelineRulerSettings preferences={ruler} onChange={saveRuler} dateChoice={dateChoice} onSelectDate={inspectWindow} onCancelDate={() => setDateChoice(null)} /> : null}
        <button type="button" className="icon-button" aria-label={mode === 'expanded' ? 'Compact focus history' : 'Expand focus history'} onClick={() => { saveHeight(mode === 'expanded' ? 96 : Math.min(maximum, 168)); setMode(mode === 'expanded' ? 'compact' : 'expanded') }}><ChevronUp size={12} /></button>
        <button type="button" className="icon-button" aria-label={mode === 'collapsed' ? 'Show focus history' : 'Collapse focus history'} aria-expanded={mode !== 'collapsed'} onClick={() => { cancelPreviewIntent(); setPreview(null); setMode(mode === 'collapsed' ? 'compact' : 'collapsed') }}><ChevronDown size={12} /></button>
      </span>
    </header>
    {dateError ? <p className="recent-focus__date-error" role="status">{dateError}</p> : null}
    {mode !== 'collapsed' ? <div ref={viewportRef} className="recent-focus__viewport">
      <div className="recent-focus__canvas">
        <svg className="recent-focus__grid" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">{gridPaths.filter(item => item.path).map(item => <path key={item.tier} data-tier={item.tier} d={item.path} vectorEffect="non-scaling-stroke" />)}</svg>
        <div className="recent-focus__ruler" aria-label="Focus time ruler"><span className="recent-focus__gutter" title={time.zone}>Context</span><div className="recent-focus__time-scale" title={`Scroll horizontally or Shift+scroll to browse time · ${time.zone}`}>{ticks.map(tick => {
          const position = focusTimePosition(tick.instant, range)
          return <span key={tick.instant} className="recent-focus__tick" data-tier={tick.tier} data-tick-at={tick.instant} title={time.detailed(tick.instant)} style={{ left: `${position}%`, '--focus-tick-x': `${position * scaleWidth / 100}px`, '--focus-time-scale-width': `${scaleWidth}px` } as CSSProperties}>{tickLabels.has(tick.instant) ? <time dateTime={new Date(tick.instant).toISOString()}>{time.ruler(tick.instant)}{tick.repeated ? <small>{focusUtcOffset(tick.offset)}</small> : null}</time> : null}</span>
        })}{position >= 0 && position <= 100 ? <span className="recent-focus__playhead recent-focus__playhead--ruler" data-now={now} style={{ left: `${position}%` }} aria-label={`Current time ${clock(now)}`} /> : null}</div></div>
        <div className="recent-focus__tracks">
          {projects.map(project => <FocusTimeProject key={project.key} project={project} registered={registeredProjects.has(project.key)} currentSessionId={currentSessionId} inputContextId={inputReference?.agentSessionId} inputTrackKey={inputTrackKey} nativeMessages={readonlyReading ? inputMessages : nativeMessages} window={range} now={now} lanesByContext={lanesByContext} time={time} onSelect={onSelect} onPreview={inspectMessage} onDismiss={dismissMessage} onInspect={inspectObservation} />)}
        </div>
        <p className="recent-focus__empty">No read records in this window. Native coverage may be incomplete; use Input records.</p>
      </div>
    </div> : null}
    {observation ? <FocusHistoryObservation segment={observation.segment} anchor={observation.anchor} time={time} onClose={() => setObservation(null)} /> : null}
    {preview ? <FocusMessagePreview describeSpeaker={describePreviewSpeaker} timeFormatters={time} message={preview.message} recipient={previewContext} recipientName={inputSource?.name} workspaceRoot={inputSource?.workspacePath} sender={sender} lane={senderLane} hierarchy={hierarchy} interactive={preview.interactive} anchor={preview.anchor} onSelect={onSelect} onClose={closePreview} onMouseEnter={cancelPreviewIntent} onMouseLeave={() => { if (preview.message) dismissMessage(preview.message.id) }}
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
