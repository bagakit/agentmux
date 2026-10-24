import { COLLECTED_REPLY_TITLE } from '@agentmux/client-ui/conversation-sources'
import { useConversationView } from '@agentmux/client-ui/use-conversation-view'
import { desktopConversationDiagnostics } from '../lib/conversation-diagnostic-options'
import { FOCUS_READING_BYTES as MAX_WINDOW_BYTES } from '../lib/focus-reading-budget'
import { TextInput } from '@agentmux/client-ui/input'
import { TIMELINE_MARKER_HEIGHT, TIMELINE_MARKER_SIZE } from '../lib/timeline-marker-layout'
import { conversationItemRef, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { focusMessageMarkers } from '../lib/focus-message-markers'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { describeConversationWindow, projectConversationWindow, type ConversationRecord } from '@agentmux/client-ui/conversation-records'
import { EMPTY_FOCUS_WORK_ITEMS, MAX_FOCUS_WORK_RECORDS, clipFocusWorkInterval, createFocusWorkSelector, mergeFocusWorkItems, projectFocusWorkHistory, type FocusWorkFacts, type FocusWorkInterval } from '../lib/focus-work-history'
import { useShallow } from 'zustand/react/shallow'
import type { AgentSessionHistoryPage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentSessionControl, SessionHistoryReference } from '../../../shared/contracts'
import type { AgentFocusHistoryEntry, AgentFocusHistoryIdentity } from '../lib/agent-focus'
import type { FocusContext } from '../lib/focus-context'
import { useAppStore } from '../store'
import { FOCUS_TIMELINE_HEIGHT_MAX, FOCUS_TIMELINE_HEIGHT_MIN } from '../lib/focus-timeline-height'
import { FOCUS_TIMELINE_NAME_WIDTH_DEFAULT, FOCUS_TIMELINE_NAME_WIDTH_MIN, FOCUS_TIMELINE_NAME_WIDTH_MAX } from '../lib/focus-timeline-name-width'
import { useSidebarResize } from '../hooks/useSidebarResize'
import { AgentAvatar } from './AgentAvatar'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { currentConversationSenderDetails, currentConversationSpeakerMetadata, type FocusDescribeSpeaker } from '../lib/conversation-sender-details'
import { agentDisplayName } from '../lib/workbench-tabs'
import { firstPromptFromTimeline } from '@agentmux/client-ui/display-name'
import { sessionPresentationById } from '../lib/session-presentation'
import { observeAgentSession } from '../lib/agent-observation'
import { agentProviderLabel } from './AgentProviderIcon'
import { ProjectIcon } from './ProjectIcon'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { createFocusTimelineOrder, extendFocusTimelineOrder, focusTimelineOrderCandidates, focusTimelineTrackKey, groupFocusTimeline, observeFocusInputTracks, orderFocusTimelineProjects, resolveFocusInputTrack, type FocusTimelineProject, type FocusTimelineTrack } from '../lib/focus-history-timeline'
import { FocusMessagePreview } from './FocusMessagePreview'
import type { RevealConversationItem } from '../lib/mailbox-message-navigation'
import { FocusTimelineEventPreview } from './FocusTimelineEventPreview'
import { focusVisitFacts, focusWorkingFacts, focusLiveFacts, focusGapFacts, type FocusTimelineEventFacts } from '../lib/focus-timeline-event-facts'
import { FocusTimelineRulerSettings, type FocusDateChoice } from './FocusTimelineRulerSettings'
import { createFocusTimeFormatters, focusDateCandidates, focusRulerLabels, focusRulerTicks, focusUtcOffset, resolvedFocusTimeZone, type FocusTimeFormatters } from '../lib/focus-timeline-ruler'
import { useFocusHistorySources, type FocusHistoryCatalogue } from '../lib/focus-history-sources'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { FocusHierarchyFacts, FocusProjectLane } from '../lib/focus-project-lanes'
import { FOCUS_WINDOW_HOURS, HOUR_MS, focusTimePosition, focusTimeSegments, focusTimeWindow, focusWheelTimeDelta, focusWindowLabel, focusWorkSegment, type FocusTimeSegment, type FocusTimeWindow } from '../lib/focus-time-window'

const ThemeStatusPresenceRunningIcon = semanticIconComponent('status.presence-running')
const ThemeConversationMixedIcon = semanticIconComponent('conversation.mixed')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeObjectHistoryIcon = semanticIconComponent('object.history')
const ThemeActionLocateIcon = semanticIconComponent('action.locate')
const ThemeConversationOutgoingIcon = semanticIconComponent('conversation.outgoing')
const ThemeConversationIncomingIcon = semanticIconComponent('conversation.incoming')
const ThemeNavigationNextIcon = semanticIconComponent('navigation.next')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')
const ThemeActionHelpIcon = semanticIconComponent('action.help')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')
const ThemeNavigationPreviousIcon = semanticIconComponent('navigation.previous')
const ThemeActionZoomOutIcon = semanticIconComponent('action.zoom-out')
const ThemeActionZoomInIcon = semanticIconComponent('action.zoom-in')
const ThemeNavigationUpIcon = semanticIconComponent('navigation.up')


// Subscribe only to the canonical authors in this mounted input surface. Session
// output/status and other senders cannot re-render it or start avatar reads.
function useFocusSpeakerResolver(messages: readonly ConversationRecord[]): FocusDescribeSpeaker {
  const ids = useMemo(() => [...new Set(messages.flatMap(message => message.speaker?.role === 'agent' ? [message.speaker.id] : []))], [messages])
  const selectFacts = useMemo(() => {
    let previous: unknown[] = [], result: unknown[] = []
    return (state: ReturnType<typeof useAppStore.getState>) => {
      const sessions = sessionPresentationById(state.sessions)
      const inputs = [state.config, state.scratchTopicSnapshots, state.spaceObjectIcons, ...ids.flatMap(id => {
        const session = sessions.get(id)
        return [session?.kind, session?.label, session?.kind === 'agent' ? session.providerId : undefined,
          session?.hostId, session?.workspacePath, state.agentNames[id], state.timelines[id]]
      })]
      if (inputs.length === previous.length && inputs.every((value, index) => Object.is(value, previous[index]))) return result
      previous = inputs
      result = ids.flatMap(id => {
        const metadata = currentConversationSpeakerMetadata(id, { sessions: state.sessions, config: state.config, workspaces: state.config?.workspaces ?? [], agentNames: state.agentNames, timelines: state.timelines, scratchTopicSnapshots: state.scratchTopicSnapshots, spaceObjectIcons: state.spaceObjectIcons })
        return [id, metadata?.label, metadata?.providerId, metadata?.project?.workspaceId,
          metadata?.project?.name, metadata?.project?.path, metadata?.project?.branch,
          metadata?.mote?.objectKey, metadata?.mote?.workspaceId,
          metadata?.mote?.topicId, metadata?.mote?.icon]
      })
      return result
    }
  }, [ids])
  const facts = useAppStore(useShallow(selectFacts))
  return useMemo(() => {
    const state = useAppStore.getState()
    const metadataById = new Map(ids.map(id => [id, currentConversationSpeakerMetadata(id, { sessions: state.sessions, config: state.config, workspaces: state.config?.workspaces ?? [], agentNames: state.agentNames, timelines: state.timelines, scratchTopicSnapshots: state.scratchTopicSnapshots, spaceObjectIcons: state.spaceObjectIcons })]))
    const original = createSpeakerResolver({ lookupAgent: id => {
      const metadata = metadataById.get(id)
      return metadata ? { ...metadata, readDetails: () => {
        const current = useAppStore.getState()
        return currentConversationSenderDetails(id, { sessions: current.sessions, config: current.config, workspaces: current.config?.workspaces ?? [], agentNames: current.agentNames, timelines: current.timelines, scratchTopicSnapshots: current.scratchTopicSnapshots, spaceObjectIcons: current.spaceObjectIcons, demands: current.demands })
      } } : undefined
    } })
    // Shared ConversationMessage already accepts an avatar ReactNode; Space facts stay Desktop-owned.
    return speaker => {
      if (speaker.role === 'unknown') return { name: 'Author unknown' }
      const described = original(speaker)
      const mote = speaker.role === 'agent' ? metadataById.get(speaker.id)?.mote : undefined
      return mote ? { ...described, mote, avatar: <ConversationMessageAvatar speaker={speaker} name={described.name} mote={mote}
        providerId={described.providerId} project={described.project} /> } : described
    }
  }, [ids, facts])
}

type LatestInputs = { messages: readonly ConversationRecord[]; loading: boolean; error: Error | null; observationError: Error | null; windowFrozen: boolean; windowIncomplete: boolean; refresh(): Promise<void> }
const EMPTY_LATEST_INPUTS: LatestInputs = { messages: [], loading: false, error: null, observationError: null, windowFrozen: false, windowIncomplete: false, refresh: async () => {} }
type NativeWindow = {
  scope: string; reference: SessionHistoryReference | undefined
  frame?: ConversationWindowSnapshot | undefined
  page: AgentSessionHistoryPage | null; timeline: AgentTimelineSnapshot | undefined; messages: readonly ConversationRecord[]
  work: FocusWorkFacts | null; loading: boolean; error: string | null; capturedError: string | null; rotated: boolean; read: boolean
  capturedCursor?: string | null | undefined; latest?: LatestInputs | undefined
  earlier?(): Promise<unknown>; newer?(): Promise<unknown>; refresh?(): Promise<void>
}
const EMPTY_NATIVE_WINDOW: NativeWindow = { scope: '', reference: undefined, page: null, timeline: undefined, messages: [], work: null, loading: false, error: null, capturedError: null, rotated: false, read: false }
const EMPTY_READING_PARTITIONS: ReadonlyMap<string, NativeWindow> = new Map()
type ReadingWindow = { partitions: ReadonlyMap<string, NativeWindow>; trimmed: boolean; nativeCount: number; capturedCount: number; workCount: number; sourceCount: number; readerCount: number; bytes: number }
const EMPTY_READING_WINDOW: ReadingWindow = { partitions: EMPTY_READING_PARTITIONS, trimmed: false, nativeCount: 0, capturedCount: 0, workCount: 0, sourceCount: 0, readerCount: 0, bytes: 0 }

/** Each admitted Context keeps one original public view. Inactive leaves park it without reads. */
const FocusInputSource = memo(function FocusInputSource({ reference, scope, active, historical, pinned, onChange }: {
  reference: SessionHistoryReference; scope: string; active: boolean; historical: boolean; pinned: ConversationRecord | undefined; onChange(part: NativeWindow): void
}) {
  const previous = useRef<readonly ConversationRecord[]>([])
  const view = useConversationView(api.conversation, reference, active, { identity: scope,
    diagnostics: desktopConversationDiagnostics('focus-preview'), beforeCommit: frame => {
    if (!pinned || !previous.current.some(record => record.id === pinned.id)) return true
    return projectConversationWindow(frame).records.some(record => record.id === pinned.id && record.event?.revision === pinned.event?.revision)
  } })
  const projection = useMemo(() => view.reading ? describeConversationWindow(view.reading) : null, [view.reading])
  const messages = useMemo(() => projection?.records.filter(record => record.role !== 'process') ?? EMPTY_LATEST_INPUTS.messages, [projection])
  previous.current = messages
  useEffect(() => { view.acceptHeld() }, [pinned, view.acceptHeld])
  const requestedEarlier = useRef(false)
  useEffect(() => {
    if (!historical) { requestedEarlier.current = false; return }
    if (!active || requestedEarlier.current || !view.snapshot || view.loading) return
    requestedEarlier.current = true; void view.earlier()
  }, [active, historical, view.snapshot, view.loading, view.earlier])
  useLayoutEffect(() => {
    onChange({ ...EMPTY_NATIVE_WINDOW, reference, scope, frame: view.snapshot ?? undefined,
      page: projection?.historyPage ?? null, timeline: projection?.captured, messages,
      loading: view.loading, error: view.error ? presentError(view.error) : null,
      capturedError: view.observationError ? presentError(view.observationError) : view.held ? 'The pinned original frame is retained. Close its preview to accept newer records.' : null,
      rotated: Boolean(view.snapshot?.window.outside.older || view.snapshot?.window.outside.newer), read: !!view.snapshot,
      capturedCursor: view.snapshot?.window.navigation.older ?? (view.snapshot ? null : undefined),
      earlier: view.earlier, newer: view.newer, refresh: view.refresh,
      latest: { messages, loading: view.loading, error: view.error, observationError: view.observationError,
        windowFrozen: view.historical, windowIncomplete: Boolean(view.snapshot?.window.outside.older), refresh: view.refresh } })
  }, [reference, scope, projection, messages, view.snapshot, view.loading, view.error, view.observationError, view.historical, view.held, onChange])
  return null
})

/** Presentation retention of whole accepted frames, never a private native/captured merge. */
function useFocusInputWindow(control: SessionHistoryReference | undefined, scope: string, enabled: boolean, historical: boolean, pinned: ConversationRecord | undefined) {
  const [window, setWindow] = useState<ReadingWindow>(EMPTY_READING_WINDOW)
  const windowRef = useRef(window); windowRef.current = window
  const pin = useRef(pinned); pin.current = pinned
  const selected = useRef(scope); selected.current = scope
  const active = useRef(enabled); active.current = enabled
  const sizes = useRef(new WeakMap<object, number>())
  const admit = useCallback((next: NativeWindow) => {
    const partitions = new Map(windowRef.current.partitions)
    partitions.delete(next.scope); partitions.set(next.scope, next)
    const size = (object: object) => {
      let bytes = sizes.current.get(object)
      if (bytes === undefined) { bytes = new TextEncoder().encode(JSON.stringify(object)).byteLength; sizes.current.set(object, bytes) }
      return bytes
    }
    const totals = () => {
      let nativeCount = 0, capturedCount = 0, workCount = 0, bytes = 0, sourceCount = 0, readerCount = 0
      for (const part of partitions.values()) {
        if (part.reference && !part.work) readerCount++
        if (part.frame) {
          sourceCount++; bytes += size(part.frame)
          for (const unit of part.frame.units) for (const record of unit.records) record.original.kind === 'native' ? nativeCount++ : capturedCount++
        }
        for (const item of part.work?.items ?? []) { workCount++; bytes += size(item); const identity = part.work?.identities?.get(item.id); if (identity) bytes += size(identity) }
      }
      return { nativeCount, capturedCount, workCount, bytes, sourceCount, readerCount }
    }
    let trimmed = windowRef.current.trimmed, count = totals()
    const protectedFrame = (part: NativeWindow) => part.scope === selected.current || Boolean(pin.current && part.messages.some(message => message.id === pin.current!.id))
    // An original frame is indivisible. Release older unselected frames first;
    // the current frame obeys the backend's original record/body bound.
    for (const [key, part] of partitions) {
      if (count.bytes <= MAX_WINDOW_BYTES && count.readerCount <= 16 && count.workCount <= MAX_FOCUS_WORK_RECORDS) break
      if (protectedFrame(part)) continue
      partitions.delete(key); trimmed = true; count = totals()
    }
    const result = { partitions, trimmed, ...count }
    windowRef.current = result; setWindow(result)
  }, [])
  useEffect(() => {
    if (!enabled || !control || windowRef.current.partitions.has(scope)) return
    const old = [...windowRef.current.partitions].filter(([, part]) => part.reference?.hostId === control.hostId && part.reference.agentSessionId === control.agentSessionId && !part.work)
    for (const [key] of old) {
      const partitions = new Map(windowRef.current.partitions); partitions.delete(key)
      windowRef.current = { ...windowRef.current, partitions }
    }
    admit({ ...EMPTY_NATIVE_WINDOW, reference: control, scope })
  }, [control?.hostId, control?.agentSessionId, scope, enabled, admit])
  const observeWork = useCallback((reference: SessionHistoryReference, items: readonly AgentTimelineItem[], identity: AgentFocusHistoryIdentity | undefined) => {
    if (!active.current || !items.length) return
    const workScope = JSON.stringify(['work', reference.hostId, reference.agentSessionId])
    const before = windowRef.current.partitions.get(workScope) ?? { ...EMPTY_NATIVE_WINDOW, scope: workScope, reference }
    const merged = mergeFocusWorkItems(before.work?.items ?? EMPTY_FOCUS_WORK_ITEMS, items)
    if (before.work && merged === before.work.items) return
    const identities = new Map(before.work?.identities)
    for (const item of merged) if (!identities.has(item.id)) identities.set(item.id, identity)
    admit({ ...before, work: { items: merged, identities, trimmed: before.work?.trimmed ?? false, error: before.work?.error ?? null } })
  }, [admit])
  const current = window.partitions.get(scope) ?? EMPTY_NATIVE_WINDOW
  const readers = [...window.partitions].flatMap(([key, part]) => part.reference && !part.work ? [<FocusInputSource key={key}
    reference={part.reference} scope={key} active={enabled && key === scope} historical={key === scope && historical} pinned={pinned} onChange={admit} />] : [])
  return { ...current, window, readers, observeWork, continueReading: () => void current.earlier?.(), refresh: () => void current.refresh?.() }
}

const FocusTimeTrack = memo(function FocusTimeTrack({ track, selected, nativeMessages, recordedMessageTracks, retainedWork, observeWork, observing, window, now, scaleWidth, lane, time, onSelect, onPreview, onDismiss, onInspect, onInspectWork, onPresence, onEvent, onEventChanged, onCurrentPresence }: {
  track: FocusTimelineTrack; selected: boolean; window: FocusTimeWindow; now: number; scaleWidth: number
  onEvent(trackKey: string, key: string, facts: FocusTimelineEventFacts, target: HTMLElement, immediate?: boolean): void
  onEventChanged(trackKey: string): void
  onCurrentPresence(present: boolean): void
  nativeMessages?: readonly ConversationRecord[] | undefined
  recordedMessageTracks?: ReadonlyMap<string, string> | undefined
  retainedWork?: FocusWorkFacts | undefined
  observing: boolean
  observeWork(reference: SessionHistoryReference, items: readonly AgentTimelineItem[], identity: AgentFocusHistoryIdentity | undefined): void
  lane?: FocusProjectLane | undefined
  time: FocusTimeFormatters
  onSelect(id: string): void; onPreview(message: ConversationRecord, target: HTMLElement, interactive: boolean, immediate?: boolean, records?: readonly ConversationRecord[]): void; onDismiss(messageId: string): void
  onInspect(segment: FocusTimeSegment, anchor: HTMLElement): void; onInspectWork(segment: FocusWorkInterval, track: FocusTimelineTrack, anchor: HTMLElement): void; onPresence(key: string, present: boolean): void
}) {
  const displayPath = usePathDisplay()
  const { clock, dateClock } = time
  const { current: context, segments, identity, sessionId } = track
  const gutter = useRef<HTMLSpanElement>(null)
  const session = useAppStore(state => observing ? sessionPresentationById(state.sessions).get(sessionId) : undefined)
  const userName = useAppStore(state => state.agentNames[sessionId])
  // A track observes only its own canonical timeline; unrelated output never scans its messages.
  const timeline = useAppStore(state => state.timelines[sessionId])
  const name = agentDisplayName({ userName,
    firstPrompt: session?.kind === 'agent' ? firstPromptFromTimeline(timeline) : undefined,
    fallbackLabel: session?.kind === 'agent' ? session.label : context?.name ?? identity?.name ?? sessionId,
    providerLabel: agentProviderLabel(context?.providerId ?? identity?.providerId ?? '') })
  const observedName = !context && identity?.name && identity.name !== name ? identity.name : undefined
  const captured = EMPTY_LATEST_INPUTS.messages
  // Record facts are checked when observed; the slowly refreshed playhead is not their arrival fence.
  const messages = useMemo(() => { const observedNow = Date.now(); return (nativeMessages ?? captured).filter(item =>
    (!recordedMessageTracks?.has(item.id) || recordedMessageTracks.get(item.id) === track.key) && item.recordedAt !== undefined && Number.isFinite(item.recordedAt)
    && item.recordedAt >= window.start && item.recordedAt <= window.end && item.recordedAt <= observedNow) }, [captured, nativeMessages, recordedMessageTracks, track.key, window, now])
  const messageGroups = useMemo(() => focusMessageMarkers(messages, window, scaleWidth), [messages, window, scaleWidth])
  const describeMessageSpeaker = useFocusSpeakerResolver(messages)
  const position = focusTimePosition(now, window)
  const liveNow = context?.processState === 'running' && position >= 0 && position <= 100
  const activitySemantic = session?.kind === 'agent' ? observeAgentSession(session, now).semantic : context?.activitySemantic
  const semanticActive = activitySemantic === undefined || activitySemantic === 'active'
  const currentStateLabel = activitySemantic === 'unknown' ? 'Activity unknown' : activitySemantic === 'unsupported' ? 'Activity not reported' : context?.stateLabel
  const working = context?.kind === 'agent' && context.processState === 'running' && context.state === 'working' && semanticActive
  const workSelector = useMemo(() => createFocusWorkSelector(sessionId), [sessionId])
  const ownWorkItems = useAppStore(workSelector)
  const retainedHere = retainedWork
  const workItems = retainedHere?.items ?? (context ? ownWorkItems : EMPTY_FOCUS_WORK_ITEMS)
  const semantic = session?.kind === 'agent' ? session.semanticStatus : undefined
  const runId = session?.kind === 'agent' ? session.control.run.runId : undefined
  const available = working && session?.kind === 'agent' && session.status.state !== 'disconnected'
  // The public projector sees changes to typed facts/current semantic truth.
  // Viewport/Now changes only clip its current/open result below.
  const workHistory = useMemo(() => projectFocusWorkHistory(workItems, context ? ownWorkItems : EMPTY_FOCUS_WORK_ITEMS, { now: Date.now(), ...(runId ? { current: {
    run: { runId }, processState: session!.processState, ...(semantic ? { semanticStatus: semantic } : {}), available
  } } : {}) }), [workItems, ownWorkItems, !!context, runId, session?.processState, semantic?.state, semantic?.stateEnteredAt, available])
  useLayoutEffect(() => {
    if (observing && context && ownWorkItems.length) observeWork({ hostId: context.hostId, agentSessionId: sessionId }, ownWorkItems, identity)
  }, [observing, context?.hostId, sessionId, ownWorkItems, identity?.name, identity?.kind, identity?.hostId, identity?.workspacePath, identity?.providerId, identity?.project?.id, identity?.project?.name, identity?.branch, identity?.topicId, observeWork])
  // Start provenance changes with work facts, not the playhead or viewport.
  // Retained facts win over canonical facts, including duplicate starts.
  const workSegments = useMemo(() => {
    const starts = new Map<string, AgentTimelineItem>()
    for (const items of [workItems, ownWorkItems]) for (const item of items) {
      if (!item.activityState || !('state' in item.activityState) || item.activityState.state !== 'working') continue
      const key = JSON.stringify([item.createdAt, item.activityState.run.runId])
      if (!starts.has(key)) starts.set(key, item)
    }
    return workHistory.segments.flatMap(segment => {
      const start = starts.get(JSON.stringify([segment.startAt, segment.run.runId]))
      if (start && retainedHere?.identities?.has(start.id) && focusTimelineTrackKey(sessionId, retainedHere.identities.get(start.id), track.inputReference?.hostId ?? context?.hostId ?? identity?.hostId) !== track.key) return []
      return [{ segment, identity: start ? retainedHere?.identities?.get(start.id) : undefined }]
    })
  }, [workHistory, workItems, ownWorkItems, retainedHere?.identities, sessionId, track.key, track.inputReference?.hostId, context?.hostId, identity?.hostId])
  const workIntervals = workSegments.flatMap(({ segment, identity }) => {
    const clipped = clipFocusWorkInterval(segment, window, now)
    return clipped ? [{ segment, identity, ...clipped }] : []
  })
  const work = working && !workHistory.coverage.recorded && !workHistory.segments.some(segment => segment.end === 'current')
    ? focusWorkSegment(context.workingEnteredAt, window, now) : null
  const gapAt = workHistory.coverage.gaps && !workIntervals.length ? workItems.at(-1)?.createdAt : undefined
  const gapVisible = gapAt !== undefined && gapAt >= window.start && gapAt <= Math.min(now, window.end)
  const present = !!(segments.length || messages.length || liveNow || work || workIntervals.length || gapVisible)
  useLayoutEffect(() => {
    onPresence(track.key, present)
    if (selected) onCurrentPresence(present)
    return () => { onPresence(track.key, false); if (selected) onCurrentPresence(false) }
  }, [track.key, present, selected, onPresence, onCurrentPresence])
  // This track already owns these subscriptions. Expire its disposable event
  // intent when its facts change; never change the fixed conversation Reader.
  useLayoutEffect(() => {
    onEventChanged(track.key)
    return () => onEventChanged(track.key)
  }, [track.key, runId, session?.processState, semantic?.state, semantic?.stateEnteredAt, activitySemantic, ownWorkItems, retainedWork?.items, segments, time.zone, onEventChanged])
  if (!present) return null
  const currentFact = `Run alive · ${currentStateLabel}${working && !work && !workIntervals.some(item => item.segment.end === 'current') ? ' · Work start unknown' : ''} · Run start unknown`
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
    ...(context?.kind === 'terminal' || identity?.kind === 'terminal' ? { mark: <ThemeObjectTerminalIcon size={12} /> } : !context && !identity?.providerId ? { mark: <ThemeObjectHistoryIcon size={12} /> } : {}),
    content: <><header><strong>{context ? name : identity?.name ?? sessionId}</strong><span>{context ? currentStateLabel : 'Retained history'}</span></header>
      <p className="recent-focus__context-location">{project ?? 'Project not recorded'}{(context ? currentPath : path) ? <small>{context ? currentPath : path}</small> : null}</p>
      {context?.detail ? <p className="recent-focus__context-task">{context.detail}</p> : null}
      {context && lane?.summary && lane.summary !== context.detail ? <p className="recent-focus__context-topic"><span>Topic summary</span>{lane.summary}</p> : null}
      <footer>{context?.lastActivityAt ? <span>Last activity <time>{dateClock(context.lastActivityAt)}</time></span> : !context ? <span>Observed identity · Current state not recorded</span> : <span>Current Context</span>}<span>{context ? 'Click to open' : segments.length ? 'Click to inspect' : 'Read-only history'}</span></footer>
    </>
  }
  const hoverEvent = (key: string, facts: () => FocusTimelineEventFacts) => ({
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => onEvent(track.key, key, facts(), event.currentTarget),
    onMouseLeave: () => onDismiss(key),
    onFocus: (event: React.FocusEvent<HTMLElement>) => onEvent(track.key, key, facts(), event.currentTarget, true),
    onBlur: () => onDismiss(key)
  })
  return <div className="recent-focus__track" data-focus-timeline-id={sessionId} data-focus-current={selected || undefined} data-history-only={!context ? 'true' : undefined}>
    <span ref={gutter} className="recent-focus__gutter" title={`${name} · ${identity?.workspacePath ? displayPath(identity.workspacePath, identity.hostId) : context?.workspacePath ? displayPath(context.workspacePath, context.hostId) : 'Historical identity not recorded'}${path ? ` · ${path}` : ''}`}>
      <AgentAvatar sessionId={observing && context?.kind === 'agent' ? sessionId : undefined} executorId={context?.executorId} visible={observing} label={name} providerId={context?.providerId ?? identity?.providerId ?? undefined} state={context?.state} size={14} disclosure={disclosure}
        onOpen={context ? () => onSelect(context.id) : segments.length ? () => {
          const anchor = gutter.current?.querySelector<HTMLElement>('.agent-avatar')
          if (anchor) onInspect(segments[0]!, anchor)
        } : undefined} />
      <span>{name}{observedName ? <small>Observed as {observedName}</small> : path ? <small>{path}</small> : null}</span>{!context ? <ThemeObjectHistoryIcon size={10} aria-label={segments.length ? 'Retained focus observation' : 'Retained input records'} /> : null}{selected ? <span className="recent-focus__current" aria-label="Current Context"><ThemeActionLocateIcon size={10} aria-hidden="true" /></span> : null}</span>
    <div className="recent-focus__lane" style={{ '--timeline-marker-size': `${TIMELINE_MARKER_SIZE}px`, '--timeline-marker-height': `${TIMELINE_MARKER_HEIGHT}px` } as React.CSSProperties}>
      {position >= 0 && position <= 100 ? <span className="recent-focus__playhead" data-now={now} style={{ left: `${position}%` }} aria-hidden="true" /> : null}
      {work && context ? <button type="button" className="recent-focus__working" data-working-entered-at={work.enteredAt} data-working-through={Math.min(now, window.end)} data-run-id={context.runId}
        style={{ left: `${work.left}%`, width: `${work.width}%` }}
        aria-label={`Return to ${name}, working since ${dateClock(work.enteredAt)}, Run start unknown`}
        {...hoverEvent(`work:${track.key}:${work.enteredAt}`, () => focusWorkingFacts({ startAt: work.enteredAt, startKnown: true, endAt: now, end: 'current' }, time, undefined, { name, project }, now))}
        onClick={() => onSelect(context.id)} /> : null}
      {workIntervals.map(({ segment, identity: workIdentity, left, width, through }) => <button key={`${segment.run.runId}:${segment.startAt}`} type="button"
        className={`recent-focus__working recent-focus__working--history${segment.end === 'current' ? ' is-current' : ''}${!segment.startKnown ? ' has-unknown-start' : ''}${segment.end === 'unknown' || segment.end === 'observation-gap' ? ' has-unknown-end' : ''}`}
        data-work-end={segment.end} data-working-entered-at={segment.startAt} data-working-through={through} data-run-id={segment.run.runId}
        style={{ left: `${left}%`, width: `${width}%` }}
        aria-label={`${segment.end === 'current' && context ? 'Return to' : 'Inspect'} ${name} work observation, ${segment.startKnown ? 'started' : 'observed'} ${dateClock(segment.startAt)}, ${segment.endAt === null ? 'end not recorded' : segment.end === 'current' ? 'currently working' : `through ${dateClock(segment.endAt)}`}`}
        {...hoverEvent(`work:${track.key}:${segment.run.runId}:${segment.startAt}`, () => focusWorkingFacts(segment, time, workIdentity, context ? { name, ...(segment.end === 'current' ? { project } : {}) } : undefined, now))}
        onClick={event => segment.end === 'current' && context ? onSelect(context.id) : onInspectWork(segment, track, event.currentTarget)}
        onContextMenu={event => { event.preventDefault(); onInspectWork(segment, track, event.currentTarget) }} />)}
      {gapVisible ? <span className="recent-focus__work-gap" tabIndex={0} role="img" style={{ left: `${focusTimePosition(gapAt!, window)}%` }} aria-label={`${name}, working history observation gap; working start and end not recorded`} {...hoverEvent(`gap:${track.key}:${gapAt}`, () => focusGapFacts(name, gapAt, time))}><ThemeStatusUnknownIcon size={6} /></span> : null}
      {liveNow && context ? <button type="button" className={`recent-focus__live${working ? ' is-working' : ''}`} data-run-state="running" data-run-id={context.runId}
        style={{ left: `${position}%` }} aria-label={`Return to ${name}, ${currentFact}, current time ${clock(now)}`}
        {...hoverEvent(`live:${track.key}`, () => focusLiveFacts(name, currentStateLabel, project, now, time))} onClick={() => onSelect(context.id)}><ThemeStatusPresenceRunningIcon size={6} /></button> : null}
      {segments.map((item, index) => <button key={`${item.focusedAt}:${index}`} type="button" className={`recent-focus__segment${selected ? ' is-current' : ''}${item.end === undefined ? ' is-open' : ''}`}
        style={{ left: `${item.left}%`, width: item.width === undefined ? undefined : `${item.width}%` }}
        data-focused-at={item.focusedAt} data-known-end={item.end} aria-current={selected ? 'true' : undefined}
        aria-label={`${context ? 'Return to' : 'Inspect focus in'} ${context ? name : item.identity?.name ?? name}, focused at ${dateClock(item.focusedAt)}${item.end === undefined ? ', next focus not recorded' : ''}`}
        {...hoverEvent(`focus:${track.key}:${item.focusedAt}`, () => focusVisitFacts(item, time))}
        onClick={event => context ? onSelect(sessionId) : onInspect(item, event.currentTarget)}><span>{clock(item.focusedAt)}</span></button>)}
      {messageGroups.map(({ records, startAt, endAt, fraction, anchorFraction }) => {
        const message = records[0]!, multiple = records.length > 1
        const inputs = records.filter(record => record.role === 'message' && (record.input || record.author?.kind !== 'agent')).length, replies = records.filter(record => record.role === 'message' && record.author?.kind === 'agent' && !record.input).length
        const observations = records.filter(record => record.role === 'observation').length
        const systems = records.filter(record => record.role === 'notice').length, interactions = records.filter(record => record.role === 'interaction').length
        const recordKind = Number(inputs > 0) + Number(replies > 0) + Number(systems > 0) + Number(observations > 0) + Number(interactions > 0) > 1 ? 'mixed' : observations ? 'observation' : interactions ? 'interaction' : message.kind
        const recordCounts = interactions ? `${inputs} inputs, ${replies} replies, ${observations} observations, ${interactions} recorded interactions and ${systems} system messages` : observations ? `${inputs} inputs, ${replies} replies, ${observations} reply observations and ${systems} system messages` : systems ? `${inputs} inputs, ${replies} replies and ${systems} system messages` : `${inputs} inputs and ${replies} replies`
        const recordedRange = startAt === endAt ? `at ${time.detailed(startAt)}` : `from ${time.detailed(startAt)} through ${time.detailed(endAt)}`
        const speaker = message.speaker!
        const described = describeMessageSpeaker(speaker)
        const anchorOffset = (anchorFraction - fraction) * scaleWidth
        return <button key={message.id} type="button" className={`recent-focus__message${multiple ? ' recent-focus__message--group' : ''}`} data-message-id={message.id} data-message-ids={JSON.stringify(records.map(record => record.id))} data-message-raw-ids={JSON.stringify(records.map(record => record.rawId))} data-conversation-item-refs={JSON.stringify(records.map(conversationItemRef))} data-record-count={records.length} data-message-raw-id={message.rawId} data-message-source={message.source.kind} data-message-at={startAt} data-message-through={endAt} data-message-author={multiple ? undefined : speaker.role} data-record-kind={recordKind} data-input-message-id={message.input?.id}
          style={{ left: `${fraction * 100}%` }} data-anchor-fraction={anchorFraction} data-display-fraction={fraction} aria-label={multiple ? `${records.length} conversation records in ${name} ${recordedRange}, including ${recordCounts}. Open recorded messages.` : message.role === 'interaction' ? `Recorded interaction in ${name} at ${clock(message.recordedAt!)}` : message.role === 'observation' ? `${COLLECTED_REPLY_TITLE} · ${name} at ${clock(message.recordedAt!)}, author ${speaker.role === 'unknown' ? 'not recorded' : speaker.id}` : speaker.role === 'system' ? `System message in ${name} at ${clock(message.recordedAt!)}, from ${speaker.id}` : speaker.role === 'agent' ? `${message.input ? 'Agent input' : 'Agent reply'} in ${name} at ${clock(message.recordedAt!)}, sender ${speaker.id}` : speaker.role === 'human' ? `Your message in ${name} at ${clock(message.recordedAt!)}` : `Prompt in ${name} at ${clock(message.recordedAt!)}, sender not recorded`}

          onMouseEnter={event => { if (!multiple) onPreview(message, event.currentTarget, false) }} onMouseLeave={() => onDismiss(message.id)}
          onFocus={event => { if (!multiple && !(event.relatedTarget instanceof Element && event.relatedTarget.closest('.recent-focus__message-preview'))) onPreview(message, event.currentTarget, false, true) }} onBlur={() => onDismiss(message.id)}
          onClick={event => onPreview(message, event.currentTarget, true, false, multiple ? records : undefined)}>{Math.abs(anchorOffset) > .1 ? <span className="timeline-marker-stem" data-anchor-side={anchorOffset < 0 ? 'left' : 'right'} style={{ left: `calc(50% + ${Math.min(0, anchorOffset)}px)`, width: `${Math.abs(anchorOffset)}px` }} aria-hidden="true" /> : null}{multiple ? <><span className="recent-focus__message-count">{records.length > 99 ? '99+' : records.length}</span>{recordKind !== 'system-message' && recordKind !== 'observation' && recordKind !== 'interaction' ? <span className="recent-focus__message-direction" aria-hidden="true">{recordKind === 'mixed' ? <ThemeConversationMixedIcon size={7} /> : observations ? <ThemeObjectHistoryIcon size={12} /> : replies ? <ThemeConversationOutgoingIcon size={7} /> : <ThemeConversationIncomingIcon size={7} />}</span> : null}</> : <><span className="recent-focus__message-avatar"><ConversationSpeakerAvatar speaker={speaker} name={described.name} mote={described.mote} {...(described.providerId ? { providerId: described.providerId } : {})} size={16} /></span>{recordKind !== 'system-message' && recordKind !== 'observation' && recordKind !== 'interaction' ? <span className="recent-focus__message-direction" aria-hidden="true">{replies ? <ThemeConversationOutgoingIcon size={7} /> : <ThemeConversationIncomingIcon size={7} />}</span> : null}</>}</button>
      })}
    </div>
  </div>
})

const FocusTimeProject = memo(function FocusTimeProject({ project, registered, currentContext, onCurrentPresence, onEvent, onEventChanged, messagesByTrack, messagesByReference, recordedMessageTracks, workByReference, observeWork, observing, window, now, scaleWidth, lanesByContext, time, onSelect, onPreview, onDismiss, onInspect, onInspectWork }: {
  project: FocusTimelineProject; registered: boolean; currentContext: Pick<FocusContext, 'id' | 'hostId'> | null
  onCurrentPresence(present: boolean): void
  onEvent(trackKey: string, key: string, facts: FocusTimelineEventFacts, target: HTMLElement, immediate?: boolean): void
  onEventChanged(trackKey: string): void
  messagesByTrack: ReadonlyMap<string, readonly ConversationRecord[]>; messagesByReference: ReadonlyMap<string, readonly ConversationRecord[]>
  recordedMessageTracks: ReadonlyMap<string, ReadonlyMap<string, string>>
  workByReference: ReadonlyMap<string, FocusWorkFacts>
  observing: boolean
  observeWork(reference: SessionHistoryReference, items: readonly AgentTimelineItem[], identity: AgentFocusHistoryIdentity | undefined): void
  window: FocusTimeWindow; now: number; scaleWidth: number
  lanesByContext: ReadonlyMap<string, FocusProjectLane>
  time: FocusTimeFormatters
  onSelect(id: string): void; onPreview(message: ConversationRecord, target: HTMLElement, interactive: boolean, immediate?: boolean, records?: readonly ConversationRecord[]): void
  onDismiss(id: string): void; onInspect(segment: FocusTimeSegment, anchor: HTMLElement): void
  onInspectWork(segment: FocusWorkInterval, track: FocusTimelineTrack, anchor: HTMLElement): void
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
      <span className="recent-focus__gutter">{collapsed ? <ThemeNavigationDisclosureIcon size={11} /> : <ThemeNavigationDownIcon size={11} />}{registered && project.workspaceId ? <ProjectIcon workspaceId={project.workspaceId} name={project.name} /> : <ThemeObjectHistoryIcon size={12} />}<strong>{project.name}</strong><small>{count}</small></span>
      <span className="recent-focus__project-summary" aria-hidden="true" />
    </button>
    <div className="recent-focus__project-tracks" data-collapsed={collapsed} inert={collapsed} aria-hidden={collapsed || undefined}>
      {project.tracks.map(track => <FocusTimeTrack key={track.key} track={track} selected={!!track.current && track.sessionId === currentContext?.id && track.current.hostId === currentContext.hostId} onEvent={onEvent} onEventChanged={onEventChanged} onCurrentPresence={onCurrentPresence} recordedMessageTracks={recordedMessageTracks.get(JSON.stringify([track.current?.hostId ?? track.inputReference?.hostId ?? track.identity?.hostId, track.sessionId]))} retainedWork={workByReference.get(JSON.stringify([track.current?.hostId ?? track.inputReference?.hostId ?? track.identity?.hostId, track.sessionId]))} observeWork={observeWork} observing={observing && !collapsed} nativeMessages={track.current ? messagesByReference.get(JSON.stringify([track.current.hostId, track.sessionId])) : messagesByTrack.get(track.key)} window={window} now={now} scaleWidth={scaleWidth} lane={track.current ? lanesByContext.get(track.sessionId) : undefined} time={time} onSelect={onSelect} onPreview={onPreview} onDismiss={onDismiss} onInspect={onInspect} onInspectWork={onInspectWork} onPresence={observePresence} />)}
    </div>
  </section>
})

function FocusTimelineLegend({ active, reading, sources, serviceNotice, latestIncomplete, onRead }: { active: boolean; reading: ReadingWindow; sources: number; serviceNotice: string | null; latestIncomplete: boolean; onRead(anchor: HTMLElement): void }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const readingNext = useRef(false)
  const dormantClose = useRef(false)
  if (!active) dormantClose.current = true
  useEffect(() => { if (!active) setOpen(false) }, [active])
  const read = reading.sourceCount
  const incomplete = reading.trimmed || latestIncomplete
  return <Dialog.Root open={active && open} onOpenChange={next => { if (next && active) dormantClose.current = false; setOpen(next) }}>
    <Dialog.Trigger asChild><button ref={trigger} data-focus-window-control type="button" className="recent-focus__coverage-button" aria-label="Timeline meaning and coverage" title={serviceNotice ?? (incomplete ? "Some history is outside this bounded window. Current activity is shown independently." : "Working, focused visits, running processes and history coverage")}><ThemeActionHelpIcon size={12} /><span>{serviceNotice ? "Updates paused" : incomplete ? "Partial history" : read ? `${read} read` : "History"}</span></button></Dialog.Trigger>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="dialog-surface recent-focus__legend-dialog" onEscapeKeyDown={event => { event.preventDefault(); setOpen(false) }} onPointerDownCapture={event => event.stopPropagation()} onCloseAutoFocus={event => { if (dormantClose.current || readingNext.current) { event.preventDefault(); readingNext.current = false } }}>
        <header><Dialog.Title>Timeline meaning and coverage</Dialog.Title><Dialog.Close asChild><button type="button" className="icon-button" aria-label="Close timeline meaning and coverage"><ThemeActionCloseIcon size={14} /></button></Dialog.Close></header>
        <Dialog.Description>Each mark shows a different fact. Empty space does not prove nothing happened.</Dialog.Description>
        <dl className="recent-focus__legend-definitions">
          <dt><i data-focus-fact="now" />Now</dt><dd>The current moment, not an activity interval.</dd>
          <dt><i data-focus-fact="working" />Working</dt><dd>A confirmed current working state with a known start. Recorded work bands come from accepted state observations. Missing older observations are not reconstructed from messages or focus visits.</dd>
          <dt><i data-focus-fact="focus" />Focused</dt><dd>When a Context received focus. This is not its execution duration.</dd>
          <dt><ThemeStatusPresenceRunningIcon size={7} data-focus-fact="alive" />Running</dt><dd>A live Run at Now. Being online does not mean it is working.</dd>
        </dl>
        <section className="recent-focus__legend-coverage" aria-label="Input coverage">
          <strong>{read} {read === 1 ? 'source' : 'sources'} read · {sources} available</strong>
          {serviceNotice ? <p role="status">{serviceNotice}</p> : null}
          <p>Current working states and online markers do not depend on the history reading budget.</p>
          {latestIncomplete ? <p>Some latest conversation records are outside the bounded window. Open conversation records to read earlier pages or refresh the source.</p> : null}
          <p>The current Context can also show latest inputs. This count describes explicitly read history sources.</p>
          <p>Other sources have not been read. Select one in conversation records to add its real records to this window.</p>
          <p>Conversation records without a recorded time remain in the record reader. Earlier pages, missing native identities and unavailable sources are explained there.</p>
          <p>{reading.trimmed ? 'Older read records or sources were released. Re-read a source or continue its earlier pages to inspect them.' : 'The history reading window retains up to 200 state observations, 90 native and 200 captured conversation records within 12 MiB. It does not cover the entire history.'}</p>
          <p>Scroll the tracks to see more Contexts. Focus visits are limited to retained observations.</p>
        </section>
        <footer><button type="button" className="small-button" onClick={() => { readingNext.current = true; setOpen(false); if (trigger.current) onRead(trigger.current) }}>Open conversation records</button></footer>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}

function FocusHistoryObservation({ segment, anchor, time, onClose }: { segment: FocusTimeSegment; anchor: HTMLElement; time: FocusTimeFormatters; onClose(): void }) {
  const displayPath = usePathDisplay()
  const identity = segment.identity
  const dateClock = time.detailed
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}>
    <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
    <Dialog.Content className="confirmation-dialog dialog-surface recent-focus__observation" onCloseAutoFocus={event => { event.preventDefault(); if (anchor.isConnected && anchor.ownerDocument.activeElement === anchor.ownerDocument.body) anchor.focus() }}>
      <Dialog.Title className="confirmation-dialog__title">{identity?.name ?? segment.sessionId}</Dialog.Title>
      <Dialog.Description className="confirmation-dialog__description">Retained focus observation. Reading it does not restore a Session.</Dialog.Description>
      <dl><dt>Focused</dt><dd>{dateClock(segment.focusedAt)}</dd><dt>Next focus</dt><dd>{segment.end === undefined ? 'Not recorded' : dateClock(segment.end)}</dd>
        <dt>Project</dt><dd>{identity?.project?.name ?? 'Not recorded'}</dd><dt>Branch / Topic</dt><dd>{[identity?.branch, identity?.topicId].filter(Boolean).join(' / ') || 'Not recorded'}</dd>
        <dt>Workspace</dt><dd>{identity?.workspacePath ? displayPath(identity.workspacePath, identity.hostId) : 'Not recorded'}</dd><dt>Session</dt><dd>{segment.sessionId}</dd></dl>
      <p>Focus visits are retained here. Message and execution history coverage may be incomplete.</p>
      <footer><Dialog.Close asChild><button type="button" className="small-button">Close</button></Dialog.Close></footer>
    </Dialog.Content>
  </DocumentOverlayPortal></Dialog.Root>
}
function FocusWorkingObservation({ segment, track, anchor, time, onClose }: {
  segment: FocusWorkInterval; track: FocusTimelineTrack; anchor: HTMLElement; time: FocusTimeFormatters; onClose(): void
}) {
  const endings = { 'state-change': 'Another semantic state was observed', 'run-ended': 'Run ended or was interrupted', 'observation-gap': 'Observation became unavailable', unknown: 'No subsequent observation recorded', current: 'Still working in the current confirmed Run' }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}>
    <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
    <Dialog.Content className="confirmation-dialog dialog-surface recent-focus__observation" onCloseAutoFocus={event => {
      event.preventDefault()
      if (anchor.isConnected && !anchor.closest('[inert]') && anchor.ownerDocument.activeElement === anchor.ownerDocument.body) anchor.focus()
    }}>
      <Dialog.Title className="confirmation-dialog__title">{track.current?.name ?? track.identity?.name ?? track.sessionId}</Dialog.Title>
      <Dialog.Description className="confirmation-dialog__description">Recorded working state. Reading this observation does not restore a Session or start a Run.</Dialog.Description>
      <dl><dt>{segment.startKnown ? 'Started' : 'Observed'}</dt><dd>{time.detailed(segment.startAt)}{segment.startKnown ? '' : ' · Start not recorded'}</dd>
        <dt>End</dt><dd>{segment.endAt === null ? 'Not recorded' : segment.end === 'current' ? 'Current confirmed state' : time.detailed(segment.endAt)}</dd>
        <dt>Boundary</dt><dd>{endings[segment.end]}</dd><dt>Run</dt><dd>{segment.run.runId}</dd><dt>Session</dt><dd>{track.sessionId}</dd>
        <dt>Project</dt><dd>{track.identity?.project?.name ?? 'Not recorded'} · Observed Context identity</dd></dl>
      <p>State observations do not measure CPU execution or prove task success. Older history or missing transitions may remain unknown.</p>
      <footer><Dialog.Close asChild><button type="button" className="small-button">Close</button></Dialog.Close></footer>
    </Dialog.Content>
  </DocumentOverlayPortal></Dialog.Root>
}

export const RecentFocusTimeline = memo(function RecentFocusTimeline({ entries, currentSessionId, currentContext = null, contexts, lanes, hierarchy, onSelect, onReveal, historyWindowRequest, catalogue: sharedCatalogue, visible = true }: {
  entries: readonly AgentFocusHistoryEntry[]; currentSessionId: string | null; contexts: readonly FocusContext[]
  /** Pure main-Region presentation input; the Reader continues using currentSessionId. */
  currentContext?: Pick<FocusContext, 'id' | 'hostId'> | null | undefined
  lanes?: readonly FocusProjectLane[]; hierarchy?: FocusHierarchyFacts; onSelect(sessionId: string): void
  onReveal?: RevealConversationItem | undefined
  historyWindowRequest?: { at: number; sequence: number } | undefined
  catalogue?: FocusHistoryCatalogue
  visible?: boolean
}) {
  const [mode, setMode] = useState<'compact' | 'expanded' | 'collapsed'>('compact')
  const [hours, setHours] = useState<number>(4)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [dateDraft, setDateDraft] = useState<string | null>(null)
  const [dateError, setDateError] = useState<string | null>(null)
  const [dateChoice, setDateChoice] = useState<FocusDateChoice | null>(null)
  useEffect(() => {
    if (!historyWindowRequest) return
    setAnchor(historyWindowRequest.at); setMode(current => current === 'collapsed' ? 'compact' : current)
    setObservation(null); setDateDraft(null); setDateError(null); setDateChoice(null)
  }, [historyWindowRequest])
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
  const clockObserved = useRef(false)
  const [documentActive, setDocumentActive] = useState(document.visibilityState !== 'hidden')
  const documentVisible = visible && documentActive
  const [readingContextId, setReadingContextId] = useState<string | null>(null)
  const [readerOpen, setReaderOpen] = useState(false)
  const [currentTrackPresent, setCurrentTrackPresent] = useState(false)
  const onCurrentPresence = useCallback((present: boolean) => setCurrentTrackPresent(present), [])
  const readerOpenRef = useRef(readerOpen); readerOpenRef.current = readerOpen
  const [earlier, setEarlier] = useState(false)
  const previewFocusIntent = useRef(false)
  const [preview, setPreview] = useState<{ message: ConversationRecord | undefined; interactive: boolean; anchor: HTMLElement; records?: readonly ConversationRecord[] | undefined; event?: FocusTimelineEventFacts; eventKey?: string; eventTrack?: string } | null>(null)
  const previewRef = useRef(preview); previewRef.current = preview
  const previewTimers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout>; messageId?: string; eventTrack?: string }>({})
  const cancelPreviewIntent = useCallback(() => {
    clearTimeout(previewTimers.current.open); clearTimeout(previewTimers.current.close)
    previewTimers.current = {}
  }, [])
  const [workObservation, setWorkObservation] = useState<{ segment: FocusWorkInterval; track: FocusTimelineTrack; anchor: HTMLElement } | null>(null)
  const inspectWorkObservation = useCallback((segment: FocusWorkInterval, track: FocusTimelineTrack, anchor: HTMLElement) => setWorkObservation({ segment, track, anchor }), [])
  const [observation, setObservation] = useState<{ segment: FocusTimeSegment; anchor: HTMLElement } | null>(null)
  const inspectObservation = useCallback((segment: FocusTimeSegment, anchor: HTMLElement) => setObservation({ segment, anchor }), [])
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const observe = () => {
      const refresh = clockObserved.current
      clockObserved.current = true
      if (timer) clearInterval(timer)
      const active = document.visibilityState !== 'hidden'; setDocumentActive(active)
      if (visible && active && mode !== 'collapsed') { if (refresh) setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), 30_000) }
    }
    observe(); document.addEventListener('visibilitychange', observe)
    return () => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', observe) }
  }, [mode, visible])
  const displayPath = usePathDisplay()
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
    isOpen: mode !== 'collapsed', resizable: visible && mode !== 'collapsed', defaultWidth: FOCUS_TIMELINE_NAME_WIDTH_DEFAULT, width: savedNameWidth,
    minWidth: FOCUS_TIMELINE_NAME_WIDTH_MIN, maxWidth: nameMaximum, deltaSign: 1,
    setWidth: saveNameWidth, onDraftWidthChange: applyNameWidth
  })
  useLayoutEffect(() => {
    if (!documentVisible || mode === 'collapsed') return
    const timeline = timelineRef.current
    if (!timeline || typeof ResizeObserver === 'undefined') return
    const gutter = timeline.querySelector('.recent-focus__ruler > .recent-focus__gutter')
    const scale = timeline.querySelector('.recent-focus__time-scale')
    const targets = [timeline, gutter, scale].filter((node): node is Element => node !== null)
    const widths = new Map<Element, number>()
    let active = true
    const update: ResizeObserverCallback = entries => {
      if (!active || document.visibilityState === 'hidden') return
      for (const entry of entries) widths.set(entry.target, entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width)
      if (targets.some(target => !widths.has(target))) return
      const available = widths.get(timeline) ?? 0
      const usable = (gutter ? widths.get(gutter) ?? 0 : 0) + (scale ? widths.get(scale) ?? 0 : 0) || available
      // Measure the canvas after its existing padding and gaps, preserving time
      // space without changing a wider saved preference. Initial RO entries
      // already carry layout sizes; do not flush the parked workbench here.
      if (available > 0) setNameMaximum(Math.min(FOCUS_TIMELINE_NAME_WIDTH_MAX, Math.max(FOCUS_TIMELINE_NAME_WIDTH_MIN, Math.floor(usable - 160))))
    }
    const observer = new ResizeObserver(update)
    for (const target of targets) observer.observe(target, { box: 'border-box' })
    return () => { active = false; observer.disconnect() }
  }, [documentVisible, mode])
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scaleWidth, setScaleWidth] = useState(0)
  const headerRef = useRef<HTMLElement>(null)
  const viewportIntent = useRef({ hours, now }); viewportIntent.current = { hours, now }
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const wheel = (event: WheelEvent) => {
      const target = event.target
      if (!(target instanceof Element) || target.closest('button, input, select, textarea, [contenteditable="true"], .recent-focus__gutter')) return
      const timeRect = viewport.querySelector('.recent-focus__time-scale')?.getBoundingClientRect()
      const namedTimeTarget = target.closest('.recent-focus__time-scale, .recent-focus__lane, .recent-focus__project-summary')
      const blankTimeTarget = target.closest('.recent-focus__canvas, .recent-focus__viewport, .recent-focus__tracks, .recent-focus__empty')
        && timeRect && event.clientX >= timeRect.left && event.clientX <= timeRect.right
      if (!namedTimeTarget && !blankTimeTarget) return
      const width = timeRect?.width ?? 0
      const movement = focusWheelTimeDelta(event, width, viewportIntent.current.hours)
      if (!movement) return
      event.preventDefault()
      setAnchor(current => (current ?? viewportIntent.current.now) + movement)
      setObservation(null)
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => viewport.removeEventListener('wheel', wheel)
  }, [mode])
  const locateCurrentTrack = () => {
    const viewport = viewportRef.current
    const track = viewport?.querySelector<HTMLElement>('[data-focus-current="true"]')
    if (!viewport || !track) return
    const heading = track.closest('.recent-focus__project')?.querySelector<HTMLButtonElement>('.recent-focus__project-heading')
    if (heading?.getAttribute('aria-expanded') === 'false') heading.click()
    requestAnimationFrame(() => {
      if (!track.isConnected || track.dataset.focusCurrent !== 'true') return
      const bounds = viewport.getBoundingClientRect(), target = track.getBoundingClientRect()
      const rulerHeight = viewport.querySelector('.recent-focus__ruler')?.getBoundingClientRect().height ?? 0
      if (target.top < bounds.top + rulerHeight) viewport.scrollTop += target.top - bounds.top - rulerHeight
      else if (target.bottom > bounds.bottom) viewport.scrollTop += target.bottom - bounds.bottom
    })
  }
  const closePreview = useCallback(() => { cancelPreviewIntent(); setPreview(null); setReaderOpen(false) }, [cancelPreviewIntent])
  const inspectMessage = useCallback((message: ConversationRecord, target: HTMLElement, interactive: boolean, immediate = false, records?: readonly ConversationRecord[]) => {
    cancelPreviewIntent()
    if (!interactive && previewRef.current?.interactive) return
    const open = () => {
      if (!target.isConnected || target.closest('[inert]') || document.visibilityState === 'hidden') return
      previewFocusIntent.current = interactive
      setPreview(current => !interactive && current?.interactive ? current : { message, interactive, anchor: target, records })
    }
    if (interactive || immediate) open()
    else { previewTimers.current.messageId = message.id; previewTimers.current.open = setTimeout(open, 180) }
  }, [cancelPreviewIntent])
  const inspectEvent = useCallback((trackKey: string, key: string, facts: FocusTimelineEventFacts, target: HTMLElement, immediate = false) => {
    cancelPreviewIntent()
    if (previewRef.current?.interactive) return
    const open = () => {
      if (!target.isConnected || target.closest('[inert]') || document.visibilityState === 'hidden') return
      setPreview(current => current?.interactive ? current : { message: undefined, interactive: false, anchor: target, event: facts, eventKey: key, eventTrack: trackKey })
    }
    if (immediate) open()
    else { previewTimers.current.messageId = key; previewTimers.current.eventTrack = trackKey; previewTimers.current.open = setTimeout(open, 180) }
  }, [cancelPreviewIntent])
  const eventChanged = useCallback((trackKey: string) => {
    if (previewTimers.current.eventTrack === trackKey) cancelPreviewIntent()
    setPreview(current => current?.eventTrack === trackKey ? null : current)
  }, [cancelPreviewIntent])
  useEffect(() => {
    cancelPreviewIntent()
    setPreview(current => current?.event ? null : current)
  }, [currentContext?.id, currentContext?.hostId, cancelPreviewIntent])
  const dismissMessage = useCallback((messageId: string) => {
    if (previewTimers.current.messageId === messageId) { clearTimeout(previewTimers.current.open); delete previewTimers.current.open }
    clearTimeout(previewTimers.current.close)
    previewTimers.current.close = setTimeout(() => setPreview(current => (current?.message?.id === messageId || current?.eventKey === messageId) && !current.interactive ? null : current), 160)
  }, [])
  useEffect(() => cancelPreviewIntent, [cancelPreviewIntent])
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape' && !previewRef.current) cancelPreviewIntent() }
    document.addEventListener('keydown', dismiss)
    return () => document.removeEventListener('keydown', dismiss)
  }, [cancelPreviewIntent])
  const localCatalogue = useFocusHistorySources(!sharedCatalogue && mode !== 'collapsed' && documentVisible)
  const catalogue = sharedCatalogue ?? localCatalogue
  const [sourceLimit, setSourceLimit] = useState(30)
  const observations = useMemo(() => observeFocusInputTracks(entries), [entries])
  const inputSources = useMemo(() => {
    const available = new Map(contexts.filter(context => context.kind === 'agent').map(context => [context.id, {
      id: context.id, name: context.name, workspaceName: context.workspaceName,
      reference: { hostId: context.hostId, agentSessionId: context.id } satisfies SessionHistoryReference,
      workspacePath: context.workspacePath, details: `Session: ${context.id}\nCurrent workspace: ${displayPath(context.workspacePath, context.hostId)}`
    }]))
    for (const source of catalogue.sources) if (!available.has(source.agentSessionId)) {
      const observation = resolveFocusInputTrack(observations, source).identity
      available.set(source.agentSessionId, { id: source.agentSessionId, name: observation?.name ?? `${source.history ? agentProviderLabel(source.history.providerId) : 'Provider not recorded'} · ${source.agentSessionId.length <= 12 ? source.agentSessionId : `${source.agentSessionId.slice(0, 8)}…${source.agentSessionId.slice(-4)}`}`,
        workspaceName: `${observation?.project ? `${observation.project.name} (observed Context)` : 'Project not recorded'} · ${source.state === 'retired' ? 'Archived' : 'Stored source'}`,
        reference: { hostId: source.hostId, agentSessionId: source.agentSessionId }, workspacePath: source.history?.workspacePath ?? '', details: `Session: ${source.agentSessionId}\nObserved Context project: ${observation?.project?.name ?? 'Not recorded or conflicting'}\nMessage-time project: Not recorded\nProvider: ${source.history ? agentProviderLabel(source.history.providerId) : 'Provider not recorded'}\nStored source workspace: ${source.history?.workspacePath ? displayPath(source.history.workspacePath, source.hostId) : 'Not recorded'}` })
    }
    return [...available.values()]
  }, [contexts, observations, catalogue.sources, displayPath])
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
    const selected = currentSessionId ? sessionPresentationById(useAppStore.getState().sessions).get(currentSessionId) : undefined
    const inspected = previewRef.current
    // An explicit return must retain the original body and any unavailable diagnosis.
    const returningToOriginal = inspected?.interactive && inspected.message?.agentSessionId === currentSessionId &&
      selected?.kind === 'agent' && inspected.message.executionHostId === selected.control.hostId
    if (currentSessionId !== null && observedFocusSession.current !== currentSessionId && !returningToOriginal) { setPreview(null); setReaderOpen(false) }
    else setPreview(current => current?.interactive ? current : null)
    observedFocusSession.current = currentSessionId
  }, [currentSessionId, cancelPreviewIntent])
  useEffect(() => {
    cancelPreviewIntent()
    setPreview(current => current?.interactive ? current : null)
  }, [inputReference?.hostId, inputReference?.agentSessionId, inputControl?.run.runId, cancelPreviewIntent])
  const readonlyReading = !!inputReference && !inputControl
  const readingEnabled = mode !== 'collapsed' && documentVisible && !!inputReference
  const historical = earlier || readonlyReading
  // The viewport filters a bounded snapshot; it is not another reading intent.
  const readingScope = JSON.stringify([inputReference?.hostId, inputReference?.agentSessionId, inputControl?.run.runId])
  const nativeWindow = useFocusInputWindow(inputReference, readingScope, mode !== 'collapsed' && documentVisible, historical, preview?.message)
  const latest = nativeWindow.latest ?? EMPTY_LATEST_INPUTS
  const readSources = useMemo(() => [...nativeWindow.window.partitions.values()].filter(part => part.reference && (part.page || part.timeline || part.work)).map(part => ({
    reference: part.reference!, messages: part.messages, conversationRead: !!(part.page || part.timeline), work: part.work, capturedError: part.capturedError
  })), [nativeWindow.window.partitions])
  const readMessagesByReference = useMemo(() => {
    const result = new Map<string, readonly ConversationRecord[]>()
    for (const source of readSources) {
      const key = JSON.stringify([source.reference.hostId, source.reference.agentSessionId])
      if (!source.messages.length && !source.conversationRead) continue
      const ids = new Set<string>()
      result.set(key, [...(result.get(key) ?? []), ...source.messages].filter(item => { if (ids.has(item.id)) return false; ids.add(item.id); return true }))
    }
    return result
  }, [readSources])
  const projected = useMemo(() => inputReference ? historical
    ? readMessagesByReference.get(JSON.stringify([inputReference.hostId, inputReference.agentSessionId])) ?? []
    : latest.messages : [], [inputReference?.hostId, inputReference?.agentSessionId, inputControl, readingEnabled, historical, readMessagesByReference, inputTimeline, latest.messages])
  const inputMessages = useMemo(() => projected.filter(item => item.agentSessionId === inputReference?.agentSessionId), [projected, inputReference?.agentSessionId])
  const messagesByReference = useMemo(() => {
    const result = new Map(readMessagesByReference)
    if (inputReference && !historical) result.set(JSON.stringify([inputReference.hostId, inputReference.agentSessionId]), inputMessages)
    return result
  }, [readMessagesByReference, inputReference?.hostId, inputReference?.agentSessionId, historical, inputMessages])

  const inputNativeSource = inputMessages.find(item => item.source.kind === 'native')?.source
  const sourceIdentity = inputNativeSource?.kind === 'native' ? JSON.stringify([inputNativeSource.providerId, inputNativeSource.nativeSessionId]) : undefined
  const observedNativeSource = useRef<{ reference: string; source: string } | undefined>(undefined)
  useEffect(() => {
    if (!sourceIdentity || !inputReference) return
    const reference = JSON.stringify([inputReference.hostId, inputReference.agentSessionId])
    if (observedNativeSource.current?.reference === reference && observedNativeSource.current.source !== sourceIdentity) {
      cancelPreviewIntent(); setPreview(current => current?.message?.agentSessionId !== inputReference.agentSessionId ? current : readerOpenRef.current && current?.interactive ? { ...current, message: undefined } : null)
    }
    observedNativeSource.current = { reference, source: sourceIdentity }
  }, [sourceIdentity, inputReference?.hostId, inputReference?.agentSessionId, cancelPreviewIntent])
  useEffect(() => {
    if (!documentVisible) { setObservation(null); setWorkObservation(null); previewFocusIntent.current = false; cancelPreviewIntent(); setPreview(current => current?.interactive ? current : null) }
    if (mode === 'collapsed') { cancelPreviewIntent(); setPreview(null); setObservation(null); setWorkObservation(null); setReaderOpen(false); setReadingContextId(null); setEarlier(false) }
  }, [documentVisible, mode, cancelPreviewIntent])
  const drag = useRef<{ y: number; height: number; next: number } | null>(null)
  const [draftHeight, setDraftHeight] = useState<number | null>(null)
  const [maximum, setMaximum] = useState(FOCUS_TIMELINE_HEIGHT_MAX)
  const [headerHeight, setHeaderHeight] = useState(28)
  const minimum = Math.min(Math.max(FOCUS_TIMELINE_HEIGHT_MIN, headerHeight + 8 + 18 + 24 + 32 + 1), maximum)
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
    if (!visible) return
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
    return () => { cancel(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', stop) }
  }, [visible, maximum, minimum, saveHeight])
  const effectiveAnchor = anchor ?? now
  const range = useMemo(() => focusTimeWindow(effectiveAnchor, hours), [effectiveAnchor, hours])
  const tracks = useMemo(() => focusTimeSegments(entries, range, now), [entries, range, now])
  const workByReference = useMemo(() => {
    const result = new Map<string, FocusWorkFacts>()
    for (const source of readSources) {
      const key = JSON.stringify([source.reference.hostId, source.reference.agentSessionId])
      if (source.work) result.set(key, source.work)
      else if (source.capturedError && !result.has(key)) result.set(key, { items: EMPTY_FOCUS_WORK_ITEMS, trimmed: false, error: source.capturedError })
    }
    return result
  }, [readSources])
  const readInputTracks = useMemo(() => {
    const result = new Map<string, ReturnType<typeof resolveFocusInputTrack> & { reference: SessionHistoryReference; messages: readonly ConversationRecord[]; work: FocusWorkFacts | null }>()
    const remember = (source: typeof readSources[number], identity: AgentFocusHistoryIdentity | undefined, messages: readonly ConversationRecord[]) => {
      const key = focusTimelineTrackKey(source.reference.agentSessionId, identity, source.reference.hostId), before = result.get(key)
      // Empty work-only partitions cannot replace previously read inputs. IDs
      // come from the public projector; body/time are never deduplication keys.
      const combined = [...(before?.messages ?? []), ...messages]
      const ids = new Set<string>()
      result.set(key, { sessionId: source.reference.agentSessionId, key, identity, reference: source.reference,
        messages: combined.filter(item => { if (ids.has(item.id)) return false; ids.add(item.id); return true }), work: source.work ?? before?.work ?? null })
    }
    for (const source of readSources) {
      if (source.messages.length) remember(source, resolveFocusInputTrack(observations, source.reference).identity, source.messages)
      if (source.work?.items.length) {
        const identities = new Map<string, AgentFocusHistoryIdentity | undefined>()
        for (const item of source.work.items) {
          const identity = source.work.identities?.get(item.id)
          identities.set(focusTimelineTrackKey(source.reference.agentSessionId, identity, source.reference.hostId), identity)
        }
        for (const identity of identities.values()) remember(source, identity, [])
      }
    }
    return [...result.values()]
  }, [readSources, observations])
  const visibleInputTracks = useMemo(() => {
    const recordedThrough = Math.min(Date.now(), range.end)
    return readInputTracks.filter(source => source.messages.some(message => message.recordedAt !== undefined && Number.isFinite(message.recordedAt) && message.recordedAt >= range.start && message.recordedAt <= recordedThrough) || source.work?.items.some(item => item.createdAt <= Math.min(now, range.end)))
  }, [readInputTracks, range, now])
  const messagesByTrack = useMemo(() => new Map(readInputTracks.map(source => [source.key, source.messages])), [readInputTracks])
  // Presentation routing of existing bounded records, not another fact store.
  // A read input gets one observed/unknown track even while its Session is live.
  const recordedMessageTracks = useMemo(() => {
    const result = new Map<string, Map<string, string>>()
    for (const source of readInputTracks) {
      const key = JSON.stringify([source.reference.hostId, source.reference.agentSessionId]), messages = result.get(key) ?? new Map<string, string>()
      for (const message of source.messages) messages.set(message.id, source.key)
      result.set(key, messages)
    }
    return result
  }, [readInputTracks])
  // A viewport filters facts, not the page's established display order.
  const orderCandidates = useMemo(() => focusTimelineOrderCandidates(contexts, lanes ?? [], entries, readInputTracks), [contexts, lanes, entries, readInputTracks])
  const [timelineOrder, setTimelineOrder] = useState(() => createFocusTimelineOrder(orderCandidates))
  useLayoutEffect(() => { setTimelineOrder(before => extendFocusTimelineOrder(before, orderCandidates)) }, [orderCandidates])
  const projects = useMemo(() => orderFocusTimelineProjects(groupFocusTimeline(contexts, lanes ?? [], tracks, visibleInputTracks), timelineOrder), [contexts, lanes, tracks, visibleInputTracks, timelineOrder])

  const ticks = useMemo(() => focusRulerTicks(range, displayedRuler), [range, displayedRuler])
  // Keep the first labels measurable before the first scale RO. Its actual
  // width selects the same density set below, before any label is revealed.
  const tickLabels = useMemo(() => scaleWidth > 0 ? focusRulerLabels(ticks, range, scaleWidth) : new Set(ticks.map(tick => tick.instant)), [ticks, range, scaleWidth])
  useLayoutEffect(() => {
    if (!documentVisible || mode === 'collapsed') return
    const scale = viewportRef.current?.querySelector<HTMLElement>('.recent-focus__time-scale')
    if (!scale || typeof ResizeObserver === 'undefined') return
    const labels = [...scale.querySelectorAll<HTMLTimeElement>('.recent-focus__tick > time')]
    const priority = { major: 0, short: 1, shorter: 2, fine: 3 }
    const widths = new Map<Element, number>()
    let active = true
    const update: ResizeObserverCallback = entries => {
      if (!active || document.visibilityState === 'hidden') return
      for (const entry of entries) {
        const borderBox = entry.borderBoxSize?.[0]
        const style = borderBox ? null : getComputedStyle(entry.target)
        const edges = style ? (['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'] as const)
          .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0) : 0
        widths.set(entry.target, borderBox?.inlineSize ?? entry.contentRect.width + edges)
      }
      const width = widths.get(scale) ?? 0
      if (width <= 0) return
      if (labels.some(label => !widths.has(label))) return
      const candidates = focusRulerLabels(ticks, range, width)
      // The RO border boxes include real font/padding widths, even for
      // visibility-hidden text. One placement owns both the CSS offset and
      // collision geometry; applying transforms cannot change these sizes.
      const measured = labels.map(node => {
        const tick = node.parentElement!, labelWidth = widths.get(node) ?? 0
        const instant = Number(tick.dataset.tickAt), tickX = focusTimePosition(instant, range) * width / 100
        const left = Math.max(0, Math.min(width - labelWidth, tickX - labelWidth / 2))
        return { node, left, right: left + labelWidth, width: labelWidth, offset: left - tickX,
          tier: tick.dataset.tier as keyof typeof priority, instant }
      }).sort((a, b) => priority[a.tier] - priority[b.tier] || a.instant - b.instant)
      const accepted: Array<{ left: number; right: number }> = []
      const placements = measured.map(row => {
        const fits = candidates.has(row.instant) && row.width > 0 && row.left >= 0 && row.right <= width && accepted.every(before => row.right <= before.left || row.left >= before.right)
        if (fits) accepted.push(row)
        return { ...row, fits }
      })
      for (const row of placements) {
        row.node.style.setProperty('--focus-label-offset', `${row.offset}px`)
        row.node.style.visibility = row.fits ? 'visible' : 'hidden'
        if (row.fits) row.node.removeAttribute('aria-hidden')
        else row.node.setAttribute('aria-hidden', 'true')
      }
      // Publish only after the complete initial measurement: pruning the DOM
      // on a scale-only delivery would defer the first labels another frame.
      setScaleWidth(width)
    }
    const observer = new ResizeObserver(update)
    observer.observe(scale, { box: 'border-box' })
    for (const label of labels) observer.observe(label, { box: 'border-box' })
    return () => { active = false; observer.disconnect() }
  }, [documentVisible, mode, tickLabels, time, range, ticks])
  const gridPaths = useMemo(() => (['major', 'short', 'shorter', 'fine'] as const).map(tier => ({ tier,
    path: ticks.filter(tick => tick.tier === tier).map(tick => `M${focusTimePosition(tick.instant, range)} 0V1`).join(' ')
  })), [ticks, range])
  const position = focusTimePosition(now, range)
  const previewRecordStart = preview?.records ? Math.min(...preview.records.map(record => record.recordedAt!)) : undefined
  const previewRecordEnd = preview?.records ? Math.max(...preview.records.map(record => record.recordedAt!)) : undefined
  const previewContext = preview?.message ? contexts.find(context => context.id === preview.message!.agentSessionId && context.hostId === preview.message!.executionHostId) : inputContext
  const previewSource = preview?.message ? inputSources.find(source => source.id === preview.message!.agentSessionId && source.reference.hostId === preview.message!.executionHostId) : inputSource
  const previewSpeaker = preview?.message ? preview.message.speaker : undefined
  const senderId = previewSpeaker?.role === 'agent' ? previewSpeaker.id : undefined
  const sender = senderId ? contexts.find(context => context.id === senderId && context.kind === 'agent') : undefined
  const senderLane = sender ? lanes?.find(lane => lane.contextIds.includes(sender.id)) : undefined
  const previewMessages = useMemo(() => preview?.message ? [...inputMessages, preview.message] : inputMessages, [inputMessages, preview?.message])
  const describePreviewSpeaker = useFocusSpeakerResolver(previewMessages)
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
    previewFocusIntent.current = true
    cancelPreviewIntent()
    setReaderOpen(true); setPreview({ message: undefined, interactive: true, anchor: target })
  }
  const inputCoverage = !inputReference ? 'Choose a Context to read its conversation records.' : historical ? nativeWindow.page
    ? `${nativeWindow.page.items.length} native records retained${nativeWindow.rotated ? ' · Some records are outside this bounded reading window' : ''}. ${nativeWindow.page.nextCursor === null && nativeWindow.capturedCursor === null ? 'Beginning of these available sources reached.' : 'Coverage incomplete. Earlier records can still be read.'} ${nativeWindow.timeline?.items.length ?? 0} captured records retained.`
    : 'Native history has not been read for this window. Coverage unknown.'
    : latest.windowIncomplete ? 'Some latest conversation records are outside this bounded window. Read earlier records to inspect available history; refresh the source to read latest records.'
      : 'Latest conversation view. Earlier coverage is unknown; read earlier records to inspect the native snapshot.'
  const inputObservationNotice = historical ? null : latest.windowFrozen
    ? 'Automatic updates are paused. The current reading window is kept. Read latest records to open a new window.'
    : latest.observationError ? `Automatic updates unavailable: ${presentError(latest.observationError)} Existing records are kept.` : null
  return <section ref={timelineRef} style={{ height: mode === 'collapsed' ? 28 : height, '--focus-name-width': `${nameWidth}px` } as CSSProperties} className="recent-focus" aria-label="Recent Focus" data-mode={mode} data-ruler-mode={ruler.mode} data-time-zone={time.zone} data-read-source-count={nativeWindow.window.sourceCount} data-mounted-reader-count={nativeWindow.window.readerCount} data-native-record-count={nativeWindow.window.nativeCount} data-captured-record-count={nativeWindow.window.capturedCount} data-work-record-count={nativeWindow.window.workCount} data-read-bytes={nativeWindow.window.bytes} data-reading-trimmed={nativeWindow.window.trimmed || undefined} data-window-start={range.start} data-window-end={range.end}>
    {nativeWindow.readers}
    {mode !== 'collapsed' ? <div ref={nameResize.containerRef} className="recent-focus__name-column-resize" data-resizing={nameResize.isResizing} style={{ top: headerHeight + 8 }}>
      <div ref={nameHandleRef} className="recent-focus__name-separator" role="separator" tabIndex={0} aria-label="Resize timeline names" aria-orientation="vertical" aria-valuemin={FOCUS_TIMELINE_NAME_WIDTH_MIN} aria-valuemax={nameMaximum} aria-valuenow={nameWidth}
        title="Drag to resize timeline names · Double-click or Enter to reset" onDoubleClick={nameResize.onResizeReset}
        onPointerDownCapture={event => event.stopPropagation()}
        onMouseDown={event => { if (event.button === 0) nameResize.onResizeStart(event) }}
        onKeyDown={event => {
          if (event.key === 'Enter') { nameResize.onResizeReset(event); return }
          const next = event.key === 'ArrowLeft' ? nameWidth - 16 : event.key === 'ArrowRight' ? nameWidth + 16 : event.key === 'Home' ? FOCUS_TIMELINE_NAME_WIDTH_MIN : event.key === 'End' ? nameMaximum : null
          if (next === null) return
          event.preventDefault(); event.stopPropagation()
          const rendered = Math.min(nameMaximum, Math.max(FOCUS_TIMELINE_NAME_WIDTH_MIN, next))
          if (rendered !== nameWidth) saveNameWidth(rendered)
        }} />
    </div> : null}
    {mode !== 'collapsed' ? <div className="recent-focus__resize" role="separator" tabIndex={0} aria-label="Resize Focus timeline" title="Drag to resize · Arrow keys adjust height" aria-orientation="horizontal" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={height}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { y: event.clientY, height, next: height }; document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none' }}
      onKeyDown={event => { const next = event.key === 'ArrowUp' ? height + 16 : event.key === 'ArrowDown' ? height - 16 : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : null; if (next !== null) { event.preventDefault(); saveHeight(Math.min(maximum, Math.max(minimum, next))) } }} /> : null}
    <header ref={headerRef} className="recent-focus__header">
      <span className="recent-focus__title"><ThemeObjectHistoryIcon size={12} /><strong>Recent Focus</strong><span className="recent-focus__range" title="Work bands show proven working states; the blue line marks the current moment; Run markers show live Runs; thin clips show focus visits. Run start times are unknown. Conversation markers use recorded times from Core. Unknown-time records and incomplete native coverage are available through conversation records. Shows up to 2000 retained focus switches within 512 KiB of serialized UTF-16 history; older observations may be outside retention.">{dateClock(range.start)} — {dateClock(range.end)}</span>{mode !== 'collapsed' ? <span className="recent-focus__legend-key" aria-label="Timeline marks"><span><i data-focus-fact="now" />Now</span><span><i data-focus-fact="working" />Working</span><span title="When you viewed this Context"><i data-focus-fact="focus" />Focused</span><span title="Run is online now; this does not imply working"><ThemeStatusPresenceRunningIcon size={7} data-focus-fact="alive" />Running</span></span> : null}</span>
      <span className="recent-focus__controls" onPointerDownCapture={event => {
        const control = event.target instanceof Element ? event.target.closest('[data-focus-window-control]') : null
        if (!control) return
        // A viewport action is part of inspecting the same input, not an outside
        // click that dismisses it. Native date/select interaction remains intact.
        event.stopPropagation()
        if (control instanceof HTMLButtonElement) event.preventDefault()
      }}>
        {mode !== 'collapsed' ? <><FocusTimelineLegend active={documentVisible} reading={nativeWindow.window} sources={inputSources.length} serviceNotice={inputObservationNotice} latestIncomplete={!historical && latest.windowIncomplete} onRead={openInputRecords} /><button data-focus-window-control type="button" className="icon-button" aria-label="Locate current Context track" title="Scroll to the current Context without changing the time window" disabled={!currentContext || !currentTrackPresent} onClick={locateCurrentTrack}><ThemeActionLocateIcon size={12} /></button><button type="button" className="icon-button" aria-label="View conversation records" aria-expanded={readerOpen} title={`Conversation records${inputSource ? ` · ${inputSource.name}` : ''}, including speech without a recorded time${inputObservationNotice ? ` · ${inputObservationNotice}` : ''}`} onClick={event => openInputRecords(event.currentTarget)}><ThemeObjectConversationIcon size={12} /></button><TextInput data-focus-window-control type="datetime-local" className="recent-focus__date" aria-label="Focus history date and time" aria-invalid={dateError !== null} title={`Clock time in ${time.zone}`} value={dateDraft ?? time.dateInput(anchor ?? now)} onChange={event => inspectDate(event.target.value)} />
        <button data-focus-window-control type="button" className="icon-button" aria-label="Previous focus window" onClick={() => inspectWindow((anchor ?? now) - hours * HOUR_MS)}><ThemeNavigationPreviousIcon size={12} /></button>
        <button data-focus-window-control type="button" className="icon-button" aria-label="Zoom out Focus timeline" title="Zoom out · wider time window" disabled={zoomIndex === FOCUS_WINDOW_HOURS.length - 1} onClick={() => setHours(FOCUS_WINDOW_HOURS[zoomIndex + 1]!)}><ThemeActionZoomOutIcon size={12} /></button>
        <select data-focus-window-control aria-label="Focus window size" value={hours} onChange={event => setHours(Number(event.target.value))}>{FOCUS_WINDOW_HOURS.map(size => <option key={size} value={size}>{focusWindowLabel(size)}</option>)}</select>
        <button data-focus-window-control type="button" className="icon-button" aria-label="Zoom in Focus timeline" title="Zoom in · narrower time window" disabled={zoomIndex === 0} onClick={() => setHours(FOCUS_WINDOW_HOURS[zoomIndex - 1]!)}><ThemeActionZoomInIcon size={12} /></button>
        <button data-focus-window-control type="button" className="icon-button" aria-label="Next focus window" onClick={() => inspectWindow((anchor ?? now) + hours * HOUR_MS)}><ThemeNavigationNextIcon size={12} /></button>
        <button data-focus-window-control type="button" className="recent-focus__now" aria-label="Return to current focus window" aria-pressed={anchor === null} onClick={() => { setNow(Date.now()); inspectWindow(null) }}>Now</button></> : null}
        {mode !== 'collapsed' ? <FocusTimelineRulerSettings active={documentVisible} preferences={ruler} onChange={saveRuler} dateChoice={dateChoice} onSelectDate={inspectWindow} onCancelDate={() => setDateChoice(null)} /> : null}
        <button type="button" className="icon-button" aria-label={mode === 'expanded' ? 'Compact focus history' : 'Expand focus history'} onClick={() => { saveHeight(mode === 'expanded' ? 96 : Math.min(maximum, 168)); setMode(mode === 'expanded' ? 'compact' : 'expanded') }}><ThemeNavigationUpIcon size={12} /></button>
        <button type="button" className="icon-button" aria-label={mode === 'collapsed' ? 'Show focus history' : 'Collapse focus history'} aria-expanded={mode !== 'collapsed'} onClick={() => { cancelPreviewIntent(); setPreview(null); setMode(mode === 'collapsed' ? 'compact' : 'collapsed') }}><ThemeNavigationDownIcon size={12} /></button>
      </span>
    </header>
    {dateError ? <p className="recent-focus__date-error" role="status">{dateError}</p> : null}
    {mode !== 'collapsed' ? <div ref={viewportRef} className="recent-focus__viewport">
      <div className="recent-focus__canvas">
        <svg className="recent-focus__grid" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">{gridPaths.filter(item => item.path).map(item => <path key={item.tier} data-tier={item.tier} d={item.path} vectorEffect="non-scaling-stroke" />)}</svg>
        <div className="recent-focus__ruler" aria-label="Focus time ruler"><span className="recent-focus__gutter" title={time.zone}>Context</span><div className="recent-focus__time-scale" title={`Scroll horizontally or Shift+scroll to browse time · ${time.zone}`}>{ticks.map(tick => {
          const position = focusTimePosition(tick.instant, range)
          return <span key={tick.instant} className="recent-focus__tick" data-tier={tick.tier} data-tick-at={tick.instant} title={time.detailed(tick.instant)} style={{ left: `${position}%` }}>{tickLabels.has(tick.instant) ? <time dateTime={new Date(tick.instant).toISOString()}>{time.ruler(tick.instant)}{tick.repeated ? <small>{focusUtcOffset(tick.offset)}</small> : null}</time> : null}</span>
        })}{position >= 0 && position <= 100 ? <span className="recent-focus__playhead recent-focus__playhead--ruler" data-now={now} style={{ left: `${position}%` }} aria-label={`Current time ${clock(now)}`} /> : null}</div></div>
        <div className="recent-focus__tracks">
          {projects.map(project => <FocusTimeProject key={project.key} project={project} registered={registeredProjects.has(project.key)} currentContext={currentContext} onCurrentPresence={onCurrentPresence} onEvent={inspectEvent} onEventChanged={eventChanged} messagesByTrack={messagesByTrack} messagesByReference={messagesByReference} recordedMessageTracks={recordedMessageTracks} workByReference={workByReference} observeWork={nativeWindow.observeWork} observing={documentVisible} window={range} now={now} scaleWidth={scaleWidth} lanesByContext={lanesByContext} time={time} onSelect={onSelect} onPreview={inspectMessage} onDismiss={dismissMessage} onInspect={inspectObservation} onInspectWork={inspectWorkObservation} />)}
        </div>
        <p className="recent-focus__empty">No visible records in this window. Use meaning and coverage to see what has been read.</p>
      </div>
    </div> : null}
    {documentVisible && workObservation ? <FocusWorkingObservation {...workObservation} time={time} onClose={() => setWorkObservation(null)} /> : null}
    {documentVisible && observation ? <FocusHistoryObservation segment={observation.segment} anchor={observation.anchor} time={time} onClose={() => setObservation(null)} /> : null}
    {documentVisible && preview?.event ? <FocusTimelineEventPreview facts={preview.event} anchor={preview.anchor} onClose={closePreview}
      onMouseEnter={cancelPreviewIntent} onMouseLeave={() => { if (preview.eventKey) dismissMessage(preview.eventKey) }} /> : (documentVisible || preview?.interactive) && preview ? <FocusMessagePreview active={documentVisible} autoFocus={previewFocusIntent.current} describeSpeaker={describePreviewSpeaker} timeFormatters={time} message={preview.message} recipient={previewContext} recipientName={previewSource?.name} workspaceRoot={previewSource?.workspacePath} sender={sender} lane={senderLane} hierarchy={hierarchy} interactive={preview.interactive} anchor={preview.anchor} onSelect={onSelect} onReveal={onReveal} onClose={closePreview} onMouseEnter={cancelPreviewIntent} onMouseLeave={() => { if (preview.message) dismissMessage(preview.message.id) }}
      {...(preview.records ? { reader: {
        selectionOnly: true, messages: preview.records, loading: false,
        coverage: `${preview.records.length} records ${previewRecordStart === previewRecordEnd ? `at ${time.detailed(previewRecordStart!)}` : `from ${time.detailed(previewRecordStart!)} through ${time.detailed(previewRecordEnd!)}`}. Original source order; select a record to read it.`, error: null,
        onMessage: (message: ConversationRecord) => setPreview(current => current ? { ...current, message } : current)
      } } : readerOpen ? { reader: {
        contexts: inputSources.slice(0, sourceLimit), contextId: inputReference?.agentSessionId ?? null, messages: inputMessages,
        sourceCoverage: catalogue.loading ? 'Discovering retained conversation sources…' : `${Math.min(sourceLimit, inputSources.length)} of ${inputSources.length} sources listed. ${nativeWindow.window.sourceCount} sources read in this window${nativeWindow.window.trimmed ? ' · Older read records or sources were released to keep this window bounded' : ''}. Sources not yet read are not evidence of no records.`,
        sourceError: catalogue.error, onRefreshSources: catalogue.refresh,
        onMoreSources: sourceLimit < inputSources.length ? () => setSourceLimit(value => Math.min(inputSources.length, value + 30)) : undefined,
        loading: historical ? nativeWindow.loading : latest.loading, coverage: inputCoverage,
        serviceNotice: inputObservationNotice, windowFrozen: !historical && latest.windowFrozen,
        error: !inputReference ? null : historical ? [nativeWindow.error, nativeWindow.capturedError].filter(Boolean).join(' ') || null : latest.error ? presentError(latest.error) : null,
        canContinue: !!inputReference && (!historical || nativeWindow.page?.nextCursor !== null || nativeWindow.capturedCursor !== null),
        onContext: (id: string) => { setReadingContextId(id); setEarlier(false) },
        onMessage: (message: ConversationRecord) => setPreview(current => current ? { ...current, message } : current),
        onContinue: () => { if (!historical) setEarlier(true); else nativeWindow.continueReading() },
        onRefresh: () => {
          if (historical) nativeWindow.refresh(); else void latest.refresh()
        }
      } } : {})} /> : null}
  </section>
})
