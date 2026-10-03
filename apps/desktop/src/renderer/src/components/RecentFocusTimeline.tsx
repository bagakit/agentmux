import { usePathDisplay } from '../hooks/usePathDisplay'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleHelp, History, LocateFixed, MessageSquare, Minus, Plus, SquareTerminal, X } from 'lucide-react'
import { projectConversationRecords, type ConversationRecord } from '@agentmux/client-ui/conversation-records'
import { EMPTY_FOCUS_WORK_ITEMS, MAX_FOCUS_WORK_RECORDS, clipFocusWorkInterval, createFocusWorkSelector, mergeFocusWorkItems, projectFocusWorkHistory, type FocusWorkFacts, type FocusWorkInterval } from '../lib/focus-work-history'
import { useShallow } from 'zustand/react/shallow'
import type { AgentSessionHistoryPage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentSessionControl, SessionHistoryReference } from '../../../shared/contracts'
import type { AgentFocusHistoryEntry, AgentFocusHistoryIdentity } from '../lib/agent-focus'
import type { FocusContext } from '../lib/focus-context'
import { useAppStore } from '../store'
import { FOCUS_TIMELINE_HEIGHT_MAX, FOCUS_TIMELINE_HEIGHT_MIN } from '../lib/focus-timeline-height'
import { FOCUS_TIMELINE_NAME_WIDTH_MIN, FOCUS_TIMELINE_NAME_WIDTH_MAX } from '../lib/focus-timeline-name-width'
import { useSidebarResize } from '../hooks/useSidebarResize'
import { AgentAvatar } from './AgentAvatar'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'
import { ConversationMessageAvatar } from './ConversationMessageAvatar'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { currentConversationSenderDetails, currentConversationSpeakerMetadata, type FocusDescribeSpeaker } from '../lib/conversation-sender-details'
import { agentDisplayName, firstPromptFromTimeline } from '../lib/workbench-tabs'
import { sessionPresentationById } from '../lib/session-presentation'
import { observeAgentSession } from '../lib/agent-observation'
import { agentProviderLabel } from './AgentProviderIcon'
import { ProjectIcon } from './ProjectIcon'
import * as Dialog from '@radix-ui/react-dialog'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { createFocusTimelineOrder, extendFocusTimelineOrder, focusTimelineOrderCandidates, focusTimelineTrackKey, groupFocusTimeline, observeFocusInputTracks, orderFocusTimelineProjects, resolveFocusInputTrack, type FocusTimelineProject, type FocusTimelineTrack } from '../lib/focus-history-timeline'
import { FocusMessagePreview } from './FocusMessagePreview'
import { FocusTimelineRulerSettings, type FocusDateChoice } from './FocusTimelineRulerSettings'
import { createFocusTimeFormatters, focusDateCandidates, focusRulerLabels, focusRulerTicks, focusUtcOffset, resolvedFocusTimeZone, type FocusTimeFormatters } from '../lib/focus-timeline-ruler'
import { useSessionUserMessages } from '../lib/session-user-messages'
import { useFocusHistorySources, type FocusHistoryCatalogue } from '../lib/focus-history-sources'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { FocusHierarchyFacts, FocusProjectLane } from '../lib/focus-project-lanes'
import { FOCUS_WINDOW_HOURS, HOUR_MS, focusTimePosition, focusTimeSegments, focusTimeWindow, focusWheelTimeDelta, focusWindowLabel, focusWorkSegment, type FocusTimeSegment, type FocusTimeWindow } from '../lib/focus-time-window'

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
      const described = original(speaker)
      const mote = speaker.role === 'agent' ? metadataById.get(speaker.id)?.mote : undefined
      return mote ? { ...described, mote, avatar: <ConversationMessageAvatar speaker={speaker} name={described.name} mote={mote}
        providerId={described.providerId} project={described.project} /> } : described
    }
  }, [ids, facts])
}

const MAX_NATIVE_RECORDS = 90
const MAX_BATCH_PAGES = 3
type LatestInputs = { messages: readonly ConversationRecord[]; loading: boolean; error: Error | null; observationError: Error | null; windowFrozen: boolean; windowIncomplete: boolean; refresh(): Promise<void> }
const EMPTY_LATEST_INPUTS: LatestInputs = { messages: [], loading: false, error: null, observationError: null, windowFrozen: false, windowIncomplete: false, refresh: async () => {} }
// Subscribe in a memoized leaf: another Context's status/output may update the
// tracks, but cannot reproject this Context's unchanged native/captured inputs.
const FocusLatestInputs = memo(function FocusLatestInputs({ control, enabled, pinned, timeline, onChange }: {
  control: AgentSessionControl | undefined; enabled: boolean; pinned: ConversationRecord | undefined; timeline: AgentTimelineSnapshot | undefined; onChange(value: LatestInputs): void
}) {
  const latest = useSessionUserMessages(control, { enabled })
  const reading = useMemo(() => {
    const page = latest.nativeHistoryPage
    const pin = pinned?.source.kind === 'native' && pinned.agentSessionId === control?.agentSessionId && pinned.executionHostId === control?.hostId ? pinned : undefined
    const protectedItem = pin?.source.kind === 'native' && page?.source.providerId === pin.source.providerId && page.source.nativeSessionId === pin.source.nativeSessionId
      ? page.items.find(item => item.id === pin.rawId) : undefined
    const capacity = pin ? MAX_NATIVE_RECORDS - 1 : MAX_NATIVE_RECORDS
    const selected = protectedItem ? new Set([...page!.items.filter(item => item !== protectedItem).slice(-capacity), protectedItem]) : undefined
    const retained = selected ? page!.items.filter(item => selected.has(item)) : page?.items.slice(-capacity)
    return { messages: projectConversationRecords({ agentSessionId: control?.agentSessionId ?? '', executionHostId: control?.hostId,
      ...(page && retained ? { historyPage: { ...page, items: retained } } : {}), timeline }).filter(record => record.kind !== 'activity'),
      clipped: !!page && !!retained && retained.length < page.items.length }
  }, [latest.nativeHistoryPage, control?.hostId, control?.agentSessionId, pinned, timeline])
  useLayoutEffect(() => { onChange({ messages: reading.messages, loading: latest.loading, error: latest.error, observationError: latest.observationError, windowFrozen: latest.windowFrozen, windowIncomplete: latest.windowIncomplete === true || reading.clipped, refresh: latest.refresh }) }, [reading, latest.loading, latest.error, latest.observationError, latest.windowFrozen, latest.windowIncomplete, latest.refresh, onChange])
  return null
})
type NativeWindow = {
  scope: string; reference: SessionHistoryReference | undefined
  page: AgentSessionHistoryPage | null; timeline: AgentTimelineSnapshot | undefined
  messages: readonly ConversationRecord[]
  work: FocusWorkFacts | null
  loading: boolean; error: string | null; capturedError: string | null; rotated: boolean; read: boolean
}
const EMPTY_NATIVE_WINDOW: NativeWindow = { scope: '', reference: undefined, page: null, timeline: undefined, messages: [], work: null, loading: false, error: null, capturedError: null, rotated: false, read: false }
const MAX_CAPTURED_RECORDS = 200
const MAX_WINDOW_BYTES = 12 * 1024 * 1024
const EMPTY_READING_PARTITIONS: ReadonlyMap<string, NativeWindow> = new Map()
type ReadingWindow = { partitions: ReadonlyMap<string, NativeWindow>; trimmed: boolean; nativeCount: number; capturedCount: number; workCount: number; sourceCount: number; bytes: number }
const EMPTY_READING_WINDOW: ReadingWindow = { partitions: EMPTY_READING_PARTITIONS, trimmed: false, nativeCount: 0, capturedCount: 0, workCount: 0, sourceCount: 0, bytes: 0 }

/** The one mounted reading window. Viewport changes filter it; explicit reads admit raw facts. */
function useFocusInputWindow(control: SessionHistoryReference | undefined, scope: string, enabled: boolean, snapshot: boolean, pinned: ConversationRecord | undefined, includeCaptured: boolean, captured: AgentTimelineSnapshot | undefined) {
  const [window, setWindow] = useState<ReadingWindow>(EMPTY_READING_WINDOW)
  const windowRef = useRef(window); windowRef.current = window
  const pinnedRef = useRef(pinned); pinnedRef.current = pinned
  const lifetime = useRef(0), pending = useRef(false)
  const enabledRef = useRef(enabled); enabledRef.current = enabled
  // Sizes belong to the raw records in this holder, not a second message cache.
  // Only admission/pruning consults them; viewport/Now renders never stringify.
  const sizes = useRef(new WeakMap<object, number>())
  const admit = useCallback((next: NativeWindow) => {
    const partitions = new Map(windowRef.current.partitions)
    // Typed work shares this reading holder, but not the captured-input budget
    // or the native Run/read-mode scope. A closed projection can disappear from
    // Store without erasing what this page has already observed.
    const observed = next.timeline?.items.filter(item => item.activityState !== undefined) ?? EMPTY_FOCUS_WORK_ITEMS
    if (next.timeline) next = { ...next, timeline: { ...next.timeline, items: next.timeline.items.filter(item => item.kind === 'user_message' || item.kind === 'assistant_message') } }
    if (next.reference && observed.length) {
      const workScope = JSON.stringify(['work', next.reference.hostId, next.reference.agentSessionId])
      const before = partitions.get(workScope) ?? { ...EMPTY_NATIVE_WINDOW, scope: workScope, reference: next.reference }
      const identities = new Map(before.work?.identities)
      for (const item of observed) if (!identities.has(item.id)) identities.set(item.id, undefined)
      partitions.set(workScope, { ...before, work: { items: mergeFocusWorkItems(before.work?.items ?? EMPTY_FOCUS_WORK_ITEMS, observed), identities, trimmed: before.work?.trimmed ?? false, error: null }, read: before.read || next.read })
    }
    partitions.delete(next.scope); partitions.set(next.scope, next)
    let trimmed = windowRef.current.trimmed
    const pin = pinnedRef.current
    const protects = (part: NativeWindow, item: { id: string }, kind: 'native' | 'captured') => {
      if (!pin || pin.agentSessionId !== part.reference?.agentSessionId || pin.executionHostId !== part.reference?.hostId) return false
      return kind === 'native' ? pin.source.kind === 'native' && pin.source.recordId === item.id && pin.source.providerId === part.page?.source.providerId && pin.source.nativeSessionId === part.page?.source.nativeSessionId
        : pin.source.kind === 'captured' && pin.source.recordId === item.id
    }
    const isPinned = (part: NativeWindow) => !!(part.page?.items.some(item => protects(part, item, 'native')) || part.timeline?.items.some(item => protects(part, item, 'captured')))
    for (const [key, part] of partitions) {
      if (partitions.size <= MAX_NATIVE_RECORDS) break
      if (key !== next.scope && !isPinned(part)) { partitions.delete(key); trimmed = true }
    }
    const byteSize = (item: object) => {
      let bytes = sizes.current.get(item)
      if (bytes === undefined) { bytes = new TextEncoder().encode(JSON.stringify(item)).byteLength; sizes.current.set(item, bytes) }
      return bytes
    }
    let nativeCount = 0, capturedCount = 0, workCount = 0, bytes = 0
    const readReferences = new Set<string>()
    for (const part of partitions.values()) {
      if (part.read && part.reference) readReferences.add(JSON.stringify([part.reference.hostId, part.reference.agentSessionId]))
      for (const item of part.page?.items ?? []) { nativeCount++; bytes += byteSize(item) }
      for (const item of part.timeline?.items ?? []) { capturedCount++; bytes += byteSize(item) }
      for (const item of part.work?.items ?? []) { workCount++; bytes += byteSize(item); const identity = part.work?.identities?.get(item.id); if (identity) bytes += byteSize(identity) }
    }
    // Trim complete records in least-recently-read partitions first. The active
    // identity is retained, but its pages receive no exemption from the budget.
    while (nativeCount > MAX_NATIVE_RECORDS || capturedCount > MAX_CAPTURED_RECORDS || workCount > MAX_FOCUS_WORK_RECORDS || bytes > MAX_WINDOW_BYTES) {
      let removed = false
      // Work admissions must not evict already read inputs while work itself
      // can release bytes. Choose the category across the whole holder before
      // visiting its partitions, rather than according to partition order.
      const kinds: readonly ('native' | 'captured' | 'work')[] = nativeCount > MAX_NATIVE_RECORDS ? ['native'] : capturedCount > MAX_CAPTURED_RECORDS ? ['captured'] : workCount > MAX_FOCUS_WORK_RECORDS ? ['work'] : ['work', 'native', 'captured']
      trim: for (const kind of kinds) for (const [key, part] of partitions) {
        const items = kind === 'native' ? part.page?.items : kind === 'work' ? part.work?.items : part.timeline?.items
        if (!items?.length) continue
        let index = kind === 'work' ? 0 : items.length - 1
        while (index >= 0 && kind !== 'work' && protects(part, items[index]!, kind)) index--
        if (index < 0) continue
        bytes -= byteSize(items[index]!)
        if (kind === 'work') { const identity = part.work?.identities?.get(items[index]!.id); if (identity) bytes -= byteSize(identity) }
        if (kind === 'native') {
          nativeCount--; partitions.set(key, { ...part, page: { ...part.page!, items: part.page!.items.filter((_, i) => i !== index) }, rotated: true })
        } else if (kind === 'work') {
          const identities = new Map(part.work!.identities); identities.delete(items[index]!.id)
          workCount--; partitions.set(key, { ...part, work: { ...part.work!, items: part.work!.items.filter((_, i) => i !== index), identities, trimmed: true } })
        } else {
          capturedCount--; partitions.set(key, { ...part, timeline: { ...part.timeline!, items: part.timeline!.items.filter((_, i) => i !== index) }, rotated: true })
        }
        removed = true; trimmed = true; break trim
      }
      if (!removed) break // The one previously admitted pin is already within the bound.
    }
    // Memoize only the derived view alongside this holder's raw facts. Updating
    // B's page/status cannot reproject unchanged A; pruned facts do reproject.
    for (const [key, part] of partitions) {
      const before = windowRef.current.partitions.get(key)
      if (before && part.page === before.page && part.timeline === before.timeline) {
        if (part.messages !== before.messages) partitions.set(key, { ...part, messages: before.messages })
      } else if (part.reference) partitions.set(key, { ...part, messages: projectConversationRecords({ agentSessionId: part.reference.agentSessionId, executionHostId: part.reference.hostId, historyPage: part.page ?? undefined, timeline: part.timeline }).filter(record => record.kind !== 'activity') })
    }
    const value = { partitions, trimmed, nativeCount, capturedCount, workCount, sourceCount: readReferences.size, bytes }
    windowRef.current = value; setWindow(value)
  }, [])
  const readBatch = useCallback(async (refresh = false) => {
    if (!enabledRef.current || !snapshot || !control || pending.current) return
    const before = windowRef.current.partitions.get(scope) ?? { ...EMPTY_NATIVE_WINDOW, scope, reference: control }
    if (!refresh && before.page && before.page.nextCursor === null) return
    const request = lifetime.current
    pending.current = true
    admit({ ...before, loading: true, error: null })
    let accepted = refresh ? null : before.page
    let rotated = refresh ? false : before.rotated
    const valid = () => enabledRef.current && request === lifetime.current
    const commit = (change: Partial<NativeWindow>) => {
      if (valid()) admit({ ...(windowRef.current.partitions.get(scope) ?? before), ...change })
    }
    try {
      if (includeCaptured && (refresh || !before.timeline)) {
        try {
          const timeline = await api.sessions.timeline(control)
          if (!valid()) return
          if (timeline.agentSessionId !== control.agentSessionId) throw new Error('Captured records belong to another Context.')
          commit({ timeline, capturedError: null, read: true })
        } catch (cause) { if (!valid()) return; commit({ capturedError: presentError(cause) }) }
      }
      for (let index = 0; index < MAX_BATCH_PAGES; index++) {
        if (!valid()) return
        const cursor = accepted?.nextCursor ?? undefined
        const page = await api.sessions.historyPage(control, { limit: 30, ...(cursor ? { cursor } : {}) })
        if (!valid()) return
        if (page.agentSessionId !== control.agentSessionId) throw new Error('Input records belong to another Context.')
        if (accepted && (accepted.source.providerId !== page.source.providerId || accepted.source.nativeSessionId !== page.source.nativeSessionId)) throw new Error('Native history source changed. Refresh source to read the new snapshot.')
        if (cursor && page.nextCursor === cursor) throw new Error('The input history cursor did not advance. Retry this read.')
        const existing = accepted?.items ?? [], ids = new Set(existing.map(item => item.id))
        const combined = [...page.items.filter(item => { if (ids.has(item.id)) return false; ids.add(item.id); return true }), ...existing]
        commit({ page: { ...page, items: combined }, loading: true, error: null, rotated, read: true })
        accepted = windowRef.current.partitions.get(scope)!.page
        rotated = windowRef.current.partitions.get(scope)!.rotated
        if (page.nextCursor === null) break
      }
    } catch (cause) { commit({ error: presentError(cause) }) }
    finally { if (valid()) { pending.current = false; commit({ loading: false }) } }
  }, [control?.hostId, control?.agentSessionId, scope, snapshot, includeCaptured, admit])
  useEffect(() => {
    ++lifetime.current; pending.current = false
    if (!enabled) {
      const partitions = new Map([...windowRef.current.partitions].map(([key, part]) => [key, part.loading ? { ...part, loading: false } : part]))
      const next = { ...windowRef.current, partitions }; windowRef.current = next; setWindow(next)
    }
    else if (control && snapshot) {
      // A new Run/read mode invalidates only this Context's old reading intent.
      const partitions = new Map(windowRef.current.partitions)
      let stopped = false
      for (const [key, part] of partitions) if (part.loading) { partitions.set(key, { ...part, loading: false }); stopped = true }
      for (const [key, part] of partitions) if (key !== scope && !part.work && part.reference?.hostId === control.hostId && part.reference.agentSessionId === control.agentSessionId) partitions.delete(key)
      if (partitions.size !== windowRef.current.partitions.size || stopped) {
        windowRef.current = { ...windowRef.current, partitions }
        const next = partitions.get(scope) ?? { ...EMPTY_NATIVE_WINDOW, scope, reference: control }
        admit(next)
      }
      const retained = partitions.get(scope)
      if (!retained || (!retained.page && !retained.error)) void readBatch(!retained)
    }
    return () => { ++lifetime.current; pending.current = false }
  }, [enabled, scope, snapshot, readBatch, admit])
  useEffect(() => {
    if (!enabled || !snapshot || !control || includeCaptured || !captured || captured.agentSessionId !== control.agentSessionId) return
    const part = windowRef.current.partitions.get(scope) ?? { ...EMPTY_NATIVE_WINDOW, scope, reference: control }
    admit({ ...part, timeline: captured, read: true })
  }, [captured, enabled, snapshot, control?.hostId, control?.agentSessionId, scope, includeCaptured, admit])
  const observeWork = useCallback((reference: SessionHistoryReference, items: readonly AgentTimelineItem[], identity: AgentFocusHistoryIdentity | undefined) => {
    if (!enabledRef.current || !items.length) return
    const workScope = JSON.stringify(['work', reference.hostId, reference.agentSessionId])
    const before = windowRef.current.partitions.get(workScope) ?? { ...EMPTY_NATIVE_WINDOW, scope: workScope, reference }
    const merged = mergeFocusWorkItems(before.work?.items ?? EMPTY_FOCUS_WORK_ITEMS, items)
    if (before.work && merged === before.work.items) return
    const identities = new Map(before.work?.identities)
    for (const item of items) if (!identities.has(item.id)) identities.set(item.id, identity)
    admit({ ...before, work: { items: merged, identities, trimmed: before.work?.trimmed ?? false, error: before.work?.error ?? null } })
  }, [admit])
  return { ...(window.partitions.get(scope) ?? EMPTY_NATIVE_WINDOW), window, observeWork, continueReading: () => void readBatch(), refresh: () => void readBatch(true) }
}

const FocusTimeTrack = memo(function FocusTimeTrack({ track, selected, nativeMessages, recordedMessageTracks, retainedWork, observeWork, observing, window, now, lane, time, onSelect, onPreview, onDismiss, onInspect, onInspectWork, onPresence }: {
  track: FocusTimelineTrack; selected: boolean; window: FocusTimeWindow; now: number
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
  const session = useAppStore(state => sessionPresentationById(state.sessions).get(sessionId))
  const userName = useAppStore(state => state.agentNames[sessionId])
  // A track observes only its own canonical timeline; unrelated output never scans its messages.
  const timeline = useAppStore(state => state.timelines[sessionId])
  const name = agentDisplayName({ userName,
    firstPrompt: session?.kind === 'agent' ? firstPromptFromTimeline(timeline) : undefined,
    fallbackLabel: session?.kind === 'agent' ? session.label : context?.name ?? identity?.name ?? sessionId,
    providerLabel: agentProviderLabel(context?.providerId ?? identity?.providerId ?? '') })
  const observedName = !context && identity?.name && identity.name !== name ? identity.name : undefined
  const captured = useMemo(() => context && timeline ? projectConversationRecords({ agentSessionId: sessionId, executionHostId: context?.hostId, timeline }).filter(record => record.kind !== 'activity') : EMPTY_LATEST_INPUTS.messages, [sessionId, !!context, context?.hostId, timeline])
  // Record facts are checked when observed; the slowly refreshed playhead is not their arrival fence.
  const messages = useMemo(() => { const observedNow = Date.now(), seen = new Set<string>(); return [...(nativeMessages ?? []), ...captured].filter(item => { if (seen.has(item.id) || recordedMessageTracks?.has(item.id) && recordedMessageTracks.get(item.id) !== track.key) return false; seen.add(item.id); return true }).filter(item => item.recordedAt !== undefined && Number.isFinite(item.recordedAt) && item.recordedAt >= window.start && item.recordedAt <= window.end && item.recordedAt <= observedNow) }, [captured, nativeMessages, recordedMessageTracks, track.key, window, now])
  const messageGroups = useMemo(() => {
    const groups = new Map<number, ConversationRecord[]>()
    for (const message of messages) { const at = message.recordedAt!, group = groups.get(at) ?? []; group.push(message); groups.set(at, group) }
    return [...groups.values()]
  }, [messages])
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
  const workIntervals = workHistory.segments.flatMap(segment => {
    const matchesStart = (item: AgentTimelineItem) => item.createdAt === segment.startAt && item.activityState?.run.runId === segment.run.runId && 'state' in item.activityState && item.activityState.state === 'working'
    const start = workItems.find(matchesStart) ?? ownWorkItems.find(matchesStart)
    if (start && retainedHere?.identities?.has(start.id) && focusTimelineTrackKey(sessionId, retainedHere.identities.get(start.id), track.inputReference?.hostId ?? context?.hostId ?? identity?.hostId) !== track.key) return []
    const clipped = clipFocusWorkInterval(segment, window, now)
    return clipped ? [{ segment, ...clipped }] : []
  })
  const work = working && !workHistory.coverage.recorded && !workHistory.segments.some(segment => segment.end === 'current')
    ? focusWorkSegment(context.workingEnteredAt, window, now) : null
  const gapAt = workHistory.coverage.gaps && !workIntervals.length ? workItems.at(-1)?.createdAt : undefined
  const gapVisible = gapAt !== undefined && gapAt >= window.start && gapAt <= Math.min(now, window.end)
  const present = !!(segments.length || messages.length || liveNow || work || workIntervals.length || gapVisible)
  useLayoutEffect(() => { onPresence(track.key, present); return () => onPresence(track.key, false) }, [track.key, present, onPresence])
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
    ...(context?.kind === 'terminal' || identity?.kind === 'terminal' ? { mark: <SquareTerminal size={12} /> } : !context && !identity?.providerId ? { mark: <History size={12} /> } : {}),
    content: <><header><strong>{context ? name : identity?.name ?? sessionId}</strong><span>{context ? currentStateLabel : 'Retained history'}</span></header>
      <p className="recent-focus__context-location">{project ?? 'Project not recorded'}{(context ? currentPath : path) ? <small>{context ? currentPath : path}</small> : null}</p>
      {context?.detail ? <p className="recent-focus__context-task">{context.detail}</p> : null}
      {context && lane?.summary && lane.summary !== context.detail ? <p className="recent-focus__context-topic"><span>Topic summary</span>{lane.summary}</p> : null}
      <footer>{context?.lastActivityAt ? <span>Last activity <time>{dateClock(context.lastActivityAt)}</time></span> : !context ? <span>Observed identity · Current state not recorded</span> : <span>Current Context</span>}<span>{context ? 'Click to open' : segments.length ? 'Click to inspect' : 'Read-only history'}</span></footer>
    </>
  }
  return <div className="recent-focus__track" data-focus-timeline-id={sessionId} data-focus-current={selected || undefined} data-history-only={!context ? 'true' : undefined}>
    <span ref={gutter} className="recent-focus__gutter" title={`${name} · ${identity?.workspacePath ? displayPath(identity.workspacePath, identity.hostId) : context?.workspacePath ? displayPath(context.workspacePath, context.hostId) : 'Historical identity not recorded'}${path ? ` · ${path}` : ''}`}>
      <AgentAvatar sessionId={context?.kind === 'agent' ? sessionId : undefined} label={name} providerId={context?.providerId ?? identity?.providerId ?? undefined} state={context?.state} size={14} disclosure={disclosure}
        onOpen={context ? () => onSelect(context.id) : segments.length ? () => {
          const anchor = gutter.current?.querySelector<HTMLElement>('.agent-avatar')
          if (anchor) onInspect(segments[0]!, anchor)
        } : undefined} />
      <span>{name}{observedName ? <small>Observed as {observedName}</small> : path ? <small>{path}</small> : null}</span>{!context ? <History size={10} aria-label={segments.length ? 'Retained focus observation' : 'Retained input records'} /> : null}</span>
    <div className="recent-focus__lane">
      {position >= 0 && position <= 100 ? <span className="recent-focus__playhead" data-now={now} style={{ left: `${position}%` }} aria-hidden="true" /> : null}
      {work && context ? <button type="button" className="recent-focus__working" data-working-entered-at={work.enteredAt} data-working-through={Math.min(now, window.end)} data-run-id={context.runId}
        style={{ left: `${work.left}%`, width: `${work.width}%` }}
        aria-label={`Return to ${name}, working since ${dateClock(work.enteredAt)}, Run start unknown`}
        title={`${name} · Working since ${dateClock(work.enteredAt)} · Work state, not Run duration`}
        onClick={() => onSelect(context.id)} /> : null}
      {workIntervals.map(({ segment, left, width, through }) => <button key={`${segment.run.runId}:${segment.startAt}`} type="button"
        className={`recent-focus__working recent-focus__working--history${segment.end === 'current' ? ' is-current' : ''}${!segment.startKnown ? ' has-unknown-start' : ''}${segment.end === 'unknown' || segment.end === 'observation-gap' ? ' has-unknown-end' : ''}`}
        data-work-end={segment.end} data-working-entered-at={segment.startAt} data-working-through={through} data-run-id={segment.run.runId}
        style={{ left: `${left}%`, width: `${width}%` }}
        aria-label={`${segment.end === 'current' && context ? 'Return to' : 'Inspect'} ${name} work observation, ${segment.startKnown ? 'started' : 'observed'} ${dateClock(segment.startAt)}, ${segment.endAt === null ? 'end not recorded' : segment.end === 'current' ? 'currently working' : `through ${dateClock(segment.endAt)}`}`}
        title={`${name} · Observed work state · ${segment.startKnown ? 'Started' : 'Start unknown; observed'} ${dateClock(segment.startAt)} · ${segment.endAt === null ? 'End not recorded' : segment.end === 'current' ? 'Current working state' : `Through ${dateClock(segment.endAt)}`} · Click to ${segment.end === 'current' && context ? 'open; right-click for facts' : 'inspect facts'}`}
        onClick={event => segment.end === 'current' && context ? onSelect(context.id) : onInspectWork(segment, track, event.currentTarget)}
        onContextMenu={event => { event.preventDefault(); onInspectWork(segment, track, event.currentTarget) }} />)}
      {gapVisible ? <span className="recent-focus__work-gap" tabIndex={0} role="img" style={{ left: `${focusTimePosition(gapAt!, window)}%` }} aria-label={`${name}, working history observation gap; working start and end not recorded`} title="Working state observations are incomplete. Start and end are not recorded; this does not prove inactivity.">?</span> : null}
      {liveNow && context ? <button type="button" className={`recent-focus__live${working ? ' is-working' : ''}`} data-run-state="running" data-run-id={context.runId}
        style={{ left: `${position}%` }} aria-label={`Return to ${name}, ${currentFact}, current time ${clock(now)}`}
        title={`${currentFact} · Current time ${dateClock(now)}`} onClick={() => onSelect(context.id)} /> : null}
      {segments.map((item, index) => <button key={`${item.focusedAt}:${index}`} type="button" className={`recent-focus__segment${selected ? ' is-current' : ''}${item.end === undefined ? ' is-open' : ''}`}
        style={{ left: `${item.left}%`, width: item.width === undefined ? undefined : `${item.width}%` }}
        data-focused-at={item.focusedAt} data-known-end={item.end} aria-current={selected ? 'true' : undefined}
        aria-label={`${context ? 'Return to' : 'Inspect focus in'} ${context ? name : item.identity?.name ?? name}, focused at ${dateClock(item.focusedAt)}${item.end === undefined ? ', next focus not recorded' : ''}`}
        title={`${item.identity?.name ?? 'Historical name not recorded'} · ${item.identity?.project?.name ?? 'Project not recorded'} · Focused ${dateClock(item.focusedAt)}${item.end === undefined ? ' · Next focus not recorded' : ''}`}
        onClick={event => context ? onSelect(sessionId) : onInspect(item, event.currentTarget)}><span>{clock(item.focusedAt)}</span></button>)}
      {messageGroups.map(records => {
        const message = records[0]!, multiple = records.length > 1
        const inputs = records.filter(record => record.kind === 'user-message').length, replies = records.filter(record => record.kind === 'assistant-message').length
        const recordKind = inputs && replies ? 'mixed' : message.kind
        const speaker = message.speaker!
        const described = describeMessageSpeaker(speaker)
        const authorLabel = speaker.role === 'agent' ? `${message.kind === 'assistant-message' ? 'Agent reply' : 'Agent input'} · Sender ${speaker.id}` : speaker.role === 'human' ? 'Human message · You' : 'Prompt · Sender not recorded'
        return <button key={message.id} type="button" className={`recent-focus__message${multiple ? ' recent-focus__message--group' : ''}`} data-message-id={message.id} data-message-ids={JSON.stringify(records.map(record => record.id))} data-message-raw-ids={JSON.stringify(records.map(record => record.rawId))} data-record-count={records.length} data-message-raw-id={message.rawId} data-message-source={message.source.kind} data-message-at={message.recordedAt} data-message-author={multiple ? undefined : speaker.role} data-record-kind={recordKind} data-input-message-id={message.input?.id}
          style={{ left: `${focusTimePosition(message.recordedAt!, window)}%` }} aria-label={multiple ? `${records.length} conversation records in ${name} at ${clock(message.recordedAt!)}, including ${inputs} inputs and ${replies} replies. Open recorded messages.` : speaker.role === 'agent' ? `${message.kind === 'assistant-message' ? 'Agent reply' : 'Agent input'} in ${name} at ${clock(message.recordedAt!)}, sender ${speaker.id}` : speaker.role === 'human' ? `Your message in ${name} at ${clock(message.recordedAt!)}` : `Prompt in ${name} at ${clock(message.recordedAt!)}, sender not recorded`}
          title={multiple ? `${records.length} records · ${inputs} inputs · ${replies} replies · ${name} · Record time ${dateClock(message.recordedAt!)} · Click to read each original record` : `${name} · Record time ${dateClock(message.recordedAt!)} · ${authorLabel}\n${message.content.slice(0, 160)}`}
          onMouseEnter={event => { if (!multiple) onPreview(message, event.currentTarget, false) }} onMouseLeave={() => onDismiss(message.id)}
          onFocus={event => { if (!multiple && !(event.relatedTarget instanceof Element && event.relatedTarget.closest('.recent-focus__message-preview'))) onPreview(message, event.currentTarget, false, true) }} onBlur={() => onDismiss(message.id)}
          onClick={event => onPreview(message, event.currentTarget, true, false, multiple ? records : undefined)}>{multiple ? records.length > 99 ? '99+' : records.length : <ConversationSpeakerAvatar speaker={speaker} name={described.name} mote={described.mote} {...(described.providerId ? { providerId: described.providerId } : {})} size={10} />}</button>
      })}
    </div>
  </div>
})

const FocusTimeProject = memo(function FocusTimeProject({ project, registered, currentSessionId, messagesByTrack, messagesByReference, recordedMessageTracks, workByReference, observeWork, observing, window, now, lanesByContext, time, onSelect, onPreview, onDismiss, onInspect, onInspectWork }: {
  project: FocusTimelineProject; registered: boolean; currentSessionId: string | null
  messagesByTrack: ReadonlyMap<string, readonly ConversationRecord[]>; messagesByReference: ReadonlyMap<string, readonly ConversationRecord[]>
  recordedMessageTracks: ReadonlyMap<string, ReadonlyMap<string, string>>
  workByReference: ReadonlyMap<string, FocusWorkFacts>
  observing: boolean
  observeWork(reference: SessionHistoryReference, items: readonly AgentTimelineItem[], identity: AgentFocusHistoryIdentity | undefined): void
  window: FocusTimeWindow; now: number
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
      <span className="recent-focus__gutter">{collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}{registered && project.workspaceId ? <ProjectIcon workspaceId={project.workspaceId} name={project.name} /> : <History size={12} />}<strong>{project.name}</strong><small>{count}</small></span>
      <span className="recent-focus__project-summary" aria-hidden="true" />
    </button>
    <div className="recent-focus__project-tracks" data-collapsed={collapsed} inert={collapsed} aria-hidden={collapsed || undefined}>
      {project.tracks.map(track => <FocusTimeTrack key={track.key} track={track} selected={!!track.current && track.sessionId === currentSessionId} recordedMessageTracks={recordedMessageTracks.get(JSON.stringify([track.current?.hostId ?? track.inputReference?.hostId ?? track.identity?.hostId, track.sessionId]))} retainedWork={workByReference.get(JSON.stringify([track.current?.hostId ?? track.inputReference?.hostId ?? track.identity?.hostId, track.sessionId]))} observeWork={observeWork} observing={observing} nativeMessages={track.current ? messagesByReference.get(JSON.stringify([track.current.hostId, track.sessionId])) : messagesByTrack.get(track.key)} window={window} now={now} lane={track.current ? lanesByContext.get(track.sessionId) : undefined} time={time} onSelect={onSelect} onPreview={onPreview} onDismiss={onDismiss} onInspect={onInspect} onInspectWork={onInspectWork} onPresence={observePresence} />)}
    </div>
  </section>
})

function FocusTimelineLegend({ reading, sources, serviceNotice, latestIncomplete, onRead }: { reading: ReadingWindow; sources: number; serviceNotice: string | null; latestIncomplete: boolean; onRead(anchor: HTMLElement): void }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const readingNext = useRef(false)
  const read = reading.sourceCount
  const incomplete = reading.trimmed || latestIncomplete
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button ref={trigger} data-focus-window-control type="button" className="recent-focus__coverage-button" aria-label="Timeline meaning and coverage" title={serviceNotice ?? (incomplete ? "Some history is outside this bounded window. Current activity is shown independently." : "Working, focused visits, running processes and history coverage")}><CircleHelp size={12} /><span>{serviceNotice ? "Updates paused" : incomplete ? "Partial history" : read ? `${read} read` : "History"}</span></button></Dialog.Trigger>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="dialog-surface recent-focus__legend-dialog" onEscapeKeyDown={event => { event.preventDefault(); setOpen(false) }} onPointerDownCapture={event => event.stopPropagation()} onCloseAutoFocus={event => { if (readingNext.current) { event.preventDefault(); readingNext.current = false } }}>
        <header><Dialog.Title>Timeline meaning and coverage</Dialog.Title><Dialog.Close asChild><button type="button" className="icon-button" aria-label="Close timeline meaning and coverage"><X size={14} /></button></Dialog.Close></header>
        <Dialog.Description>Each mark shows a different fact. Empty space does not prove nothing happened.</Dialog.Description>
        <dl className="recent-focus__legend-definitions">
          <dt><i data-focus-fact="now" />Now</dt><dd>The current moment, not an activity interval.</dd>
          <dt><i data-focus-fact="working" />Working</dt><dd>A confirmed current working state with a known start. Recorded work bands come from accepted state observations. Missing older observations are not reconstructed from messages or focus visits.</dd>
          <dt><i data-focus-fact="focus" />Focused</dt><dd>When a Context received focus. This is not its execution duration.</dd>
          <dt><i data-focus-fact="alive" />Running</dt><dd>A live Run at Now. Being online does not mean it is working.</dd>
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
    </Dialog.Portal>
  </Dialog.Root>
}

function FocusHistoryObservation({ segment, anchor, time, onClose }: { segment: FocusTimeSegment; anchor: HTMLElement; time: FocusTimeFormatters; onClose(): void }) {
  const displayPath = usePathDisplay()
  const identity = segment.identity
  const dateClock = time.detailed
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal container={resolveOverlayContainer()}>
    <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
    <Dialog.Content className="confirmation-dialog dialog-surface recent-focus__observation" onCloseAutoFocus={event => { event.preventDefault(); if (anchor.isConnected && document.activeElement === document.body) anchor.focus() }}>
      <Dialog.Title className="confirmation-dialog__title">{identity?.name ?? segment.sessionId}</Dialog.Title>
      <Dialog.Description className="confirmation-dialog__description">Retained focus observation. Reading it does not restore a Session.</Dialog.Description>
      <dl><dt>Focused</dt><dd>{dateClock(segment.focusedAt)}</dd><dt>Next focus</dt><dd>{segment.end === undefined ? 'Not recorded' : dateClock(segment.end)}</dd>
        <dt>Project</dt><dd>{identity?.project?.name ?? 'Not recorded'}</dd><dt>Branch / Topic</dt><dd>{[identity?.branch, identity?.topicId].filter(Boolean).join(' / ') || 'Not recorded'}</dd>
        <dt>Workspace</dt><dd>{identity?.workspacePath ? displayPath(identity.workspacePath, identity.hostId) : 'Not recorded'}</dd><dt>Session</dt><dd>{segment.sessionId}</dd></dl>
      <p>Focus visits are retained here. Message and execution history coverage may be incomplete.</p>
      <footer><Dialog.Close asChild><button type="button" className="small-button">Close</button></Dialog.Close></footer>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
function FocusWorkingObservation({ segment, track, anchor, time, onClose }: {
  segment: FocusWorkInterval; track: FocusTimelineTrack; anchor: HTMLElement; time: FocusTimeFormatters; onClose(): void
}) {
  const endings = { 'state-change': 'Another semantic state was observed', 'run-ended': 'Run ended or was interrupted', 'observation-gap': 'Observation became unavailable', unknown: 'No subsequent observation recorded', current: 'Still working in the current confirmed Run' }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal container={resolveOverlayContainer()}>
    <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
    <Dialog.Content className="confirmation-dialog dialog-surface recent-focus__observation" onCloseAutoFocus={event => {
      event.preventDefault()
      if (anchor.isConnected && !anchor.closest('[inert]') && document.activeElement === document.body) anchor.focus()
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
  </Dialog.Portal></Dialog.Root>
}

export const RecentFocusTimeline = memo(function RecentFocusTimeline({ entries, currentSessionId, contexts, lanes, hierarchy, onSelect, historyWindowRequest, catalogue: sharedCatalogue }: {
  entries: readonly AgentFocusHistoryEntry[]; currentSessionId: string | null; contexts: readonly FocusContext[]
  lanes?: readonly FocusProjectLane[]; hierarchy?: FocusHierarchyFacts; onSelect(sessionId: string): void
  historyWindowRequest?: { at: number; sequence: number } | undefined
  catalogue?: FocusHistoryCatalogue
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
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden')
  const [readingContextId, setReadingContextId] = useState<string | null>(null)
  const [readerOpen, setReaderOpen] = useState(false)
  const readerOpenRef = useRef(readerOpen); readerOpenRef.current = readerOpen
  const [earlier, setEarlier] = useState(false)
  const [preview, setPreview] = useState<{ message: ConversationRecord | undefined; interactive: boolean; anchor: HTMLElement; records?: readonly ConversationRecord[] | undefined } | null>(null)
  const previewRef = useRef(preview); previewRef.current = preview
  const previewTimers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout>; messageId?: string }>({})
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
      if (timer) clearInterval(timer)
      const visible = document.visibilityState !== 'hidden'; setDocumentVisible(visible)
      if (visible && mode !== 'collapsed') { setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), 30_000) }
    }
    observe(); document.addEventListener('visibilitychange', observe)
    return () => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', observe) }
  }, [mode])
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
      setPreview(current => !interactive && current?.interactive ? current : { message, interactive, anchor: target, records })
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
  const historical = earlier || readonlyReading
  const [latest, setLatest] = useState<LatestInputs>(EMPTY_LATEST_INPUTS)
  // The viewport filters a bounded snapshot; it is not another reading intent.
  const readingScope = JSON.stringify([inputReference?.hostId, inputReference?.agentSessionId, inputControl?.run.runId, historical ? 'snapshot' : 'latest', readonlyReading])
  const nativeWindow = useFocusInputWindow(inputReference, readingScope, mode !== 'collapsed' && documentVisible, historical, preview?.message, readonlyReading, inputTimeline)
  const readSources = useMemo(() => [...nativeWindow.window.partitions.values()].filter(part => part.reference && (part.page || part.timeline || part.work)).map(part => ({
    reference: part.reference!, messages: part.messages, work: part.work, capturedError: part.capturedError
  })), [nativeWindow.window.partitions])
  const readMessagesByReference = useMemo(() => {
    const result = new Map<string, readonly ConversationRecord[]>()
    for (const source of readSources) {
      const key = JSON.stringify([source.reference.hostId, source.reference.agentSessionId])
      if (!source.messages.length) continue
      const ids = new Set<string>()
      result.set(key, [...(result.get(key) ?? []), ...source.messages].filter(item => { if (ids.has(item.id)) return false; ids.add(item.id); return true }))
    }
    return result
  }, [readSources])
  const projected = useMemo(() => inputReference ? historical
    ? readMessagesByReference.get(JSON.stringify([inputReference.hostId, inputReference.agentSessionId])) ?? []
    : inputControl && readingEnabled ? latest.messages : projectConversationRecords({ agentSessionId: inputReference.agentSessionId, executionHostId: inputReference.hostId, timeline: inputTimeline }).filter(record => record.kind !== 'activity') : [], [inputReference?.hostId, inputReference?.agentSessionId, inputControl, readingEnabled, historical, readMessagesByReference, inputTimeline, latest.messages])
  const inputMessages = useMemo(() => projected.filter(item => item.agentSessionId === inputReference?.agentSessionId), [projected, inputReference?.agentSessionId])
  const messagesByReference = useMemo(() => {
    const result = new Map(readMessagesByReference)
    if (inputReference && !historical) result.set(JSON.stringify([inputReference.hostId, inputReference.agentSessionId]), inputMessages.filter(message => message.source.kind === 'native'))
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
    if (!documentVisible) { cancelPreviewIntent(); setPreview(current => current?.interactive ? current : null) }
    if (mode === 'collapsed') { cancelPreviewIntent(); setPreview(null); setObservation(null); setWorkObservation(null); setReaderOpen(false); setReadingContextId(null); setEarlier(false) }
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
    cancelPreviewIntent()
    setReaderOpen(true); setPreview({ message: undefined, interactive: true, anchor: target })
  }
  const inputCoverage = !inputReference ? 'Choose a Context to read its conversation records.' : historical ? nativeWindow.page
    ? `${nativeWindow.page.items.length} native records retained${nativeWindow.rotated ? ' · Some records are outside this bounded reading window' : ''}. ${nativeWindow.page.nextCursor === null ? 'Beginning of this available snapshot reached.' : 'Coverage incomplete. Earlier records can still be read.'}`
    : 'Native history has not been read for this window. Coverage unknown.'
    : latest.windowIncomplete ? 'Some latest conversation records are outside this bounded window. Read earlier records to inspect available history; refresh the source to read latest records.'
      : 'Latest conversation view. Earlier coverage is unknown; read earlier records to inspect the native snapshot.'
  const inputObservationNotice = historical ? null : latest.windowFrozen
    ? 'Automatic updates are paused. The current reading window is kept. Read latest records to open a new window.'
    : latest.observationError ? `Automatic updates unavailable: ${presentError(latest.observationError)} Existing records are kept.` : null
  return <section ref={timelineRef} style={{ height: mode === 'collapsed' ? 28 : height, '--focus-name-width': `${nameWidth}px` } as CSSProperties} className="recent-focus" aria-label="Recent Focus" data-mode={mode} data-ruler-mode={ruler.mode} data-time-zone={time.zone} data-read-source-count={nativeWindow.window.sourceCount} data-native-record-count={nativeWindow.window.nativeCount} data-captured-record-count={nativeWindow.window.capturedCount} data-work-record-count={nativeWindow.window.workCount} data-read-bytes={nativeWindow.window.bytes} data-reading-trimmed={nativeWindow.window.trimmed || undefined} data-window-start={range.start} data-window-end={range.end}>
    <FocusLatestInputs control={inputControl} timeline={inputTimeline} enabled={readingEnabled && !historical} pinned={historical || !preview?.interactive ? undefined : preview.message} onChange={setLatest} />
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
      <span className="recent-focus__title"><History size={12} /><strong>Recent Focus</strong><span className="recent-focus__range" title="Work bands show proven working states; the blue line marks the current moment; hollow dots mark live Runs; thin clips show focus visits. Run start times are unknown. Conversation markers use recorded times from Core. Unknown-time records and incomplete native coverage are available through conversation records. Shows up to 2000 retained focus switches within 512 KiB of serialized UTF-16 history; older observations may be outside retention.">{dateClock(range.start)} — {dateClock(range.end)}</span>{mode !== 'collapsed' ? <span className="recent-focus__legend-key" aria-label="Timeline marks"><span><i data-focus-fact="now" />Now</span><span><i data-focus-fact="working" />Working</span><span title="When you viewed this Context"><i data-focus-fact="focus" />Focused</span><span title="Run is online now; this does not imply working"><i data-focus-fact="alive" />Running</span></span> : null}</span>
      <span className="recent-focus__controls" onPointerDownCapture={event => {
        const control = event.target instanceof Element ? event.target.closest('[data-focus-window-control]') : null
        if (!control) return
        // A viewport action is part of inspecting the same input, not an outside
        // click that dismisses it. Native date/select interaction remains intact.
        event.stopPropagation()
        if (control instanceof HTMLButtonElement) event.preventDefault()
      }}>
        {mode !== 'collapsed' ? <><FocusTimelineLegend reading={nativeWindow.window} sources={inputSources.length} serviceNotice={inputObservationNotice} latestIncomplete={!historical && latest.windowIncomplete} onRead={openInputRecords} /><button data-focus-window-control type="button" className="icon-button" aria-label="Locate current Context track" title="Scroll to the current Context without changing the time window" disabled={!currentSessionId} onClick={locateCurrentTrack}><LocateFixed size={12} /></button><button type="button" className="icon-button" aria-label="View conversation records" aria-expanded={readerOpen} title={`Conversation records${inputSource ? ` · ${inputSource.name}` : ''}, including speech without a recorded time${inputObservationNotice ? ` · ${inputObservationNotice}` : ''}`} onClick={event => openInputRecords(event.currentTarget)}><MessageSquare size={12} /></button><input data-focus-window-control type="datetime-local" className="recent-focus__date" aria-label="Focus history date and time" aria-invalid={dateError !== null} title={`Clock time in ${time.zone}`} value={dateDraft ?? time.dateInput(anchor ?? now)} onChange={event => inspectDate(event.target.value)} />
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
          {projects.map(project => <FocusTimeProject key={project.key} project={project} registered={registeredProjects.has(project.key)} currentSessionId={currentSessionId} messagesByTrack={messagesByTrack} messagesByReference={messagesByReference} recordedMessageTracks={recordedMessageTracks} workByReference={workByReference} observeWork={nativeWindow.observeWork} observing={documentVisible} window={range} now={now} lanesByContext={lanesByContext} time={time} onSelect={onSelect} onPreview={inspectMessage} onDismiss={dismissMessage} onInspect={inspectObservation} onInspectWork={inspectWorkObservation} />)}
        </div>
        <p className="recent-focus__empty">No visible records in this window. Use meaning and coverage to see what has been read.</p>
      </div>
    </div> : null}
    {workObservation ? <FocusWorkingObservation {...workObservation} time={time} onClose={() => setWorkObservation(null)} /> : null}
    {observation ? <FocusHistoryObservation segment={observation.segment} anchor={observation.anchor} time={time} onClose={() => setObservation(null)} /> : null}
    {preview ? <FocusMessagePreview describeSpeaker={describePreviewSpeaker} timeFormatters={time} message={preview.message} recipient={previewContext} recipientName={previewSource?.name} workspaceRoot={previewSource?.workspacePath} sender={sender} lane={senderLane} hierarchy={hierarchy} interactive={preview.interactive} anchor={preview.anchor} onSelect={onSelect} onClose={closePreview} onMouseEnter={cancelPreviewIntent} onMouseLeave={() => { if (preview.message) dismissMessage(preview.message.id) }}
      {...(preview.records ? { reader: {
        selectionOnly: true, messages: preview.records, loading: false,
        coverage: `${preview.records.length} records at ${dateClock(preview.records[0]!.recordedAt!)}. Original source order; select a record to read it.`, error: null,
        onMessage: (message: ConversationRecord) => setPreview(current => current ? { ...current, message } : current)
      } } : readerOpen ? { reader: {
        contexts: inputSources.slice(0, sourceLimit), contextId: inputReference?.agentSessionId ?? null, messages: inputMessages,
        sourceCoverage: catalogue.loading ? 'Discovering retained conversation sources…' : `${Math.min(sourceLimit, inputSources.length)} of ${inputSources.length} sources listed. ${nativeWindow.window.sourceCount} sources read in this window${nativeWindow.window.trimmed ? ' · Older read records or sources were released to keep this window bounded' : ''}. Sources not yet read are not evidence of no records.`,
        sourceError: catalogue.error, onRefreshSources: catalogue.refresh,
        onMoreSources: sourceLimit < inputSources.length ? () => setSourceLimit(value => Math.min(inputSources.length, value + 30)) : undefined,
        loading: historical ? nativeWindow.loading : latest.loading, coverage: inputCoverage,
        serviceNotice: inputObservationNotice, windowFrozen: !historical && latest.windowFrozen,
        error: !inputReference ? null : historical ? [nativeWindow.error, nativeWindow.capturedError].filter(Boolean).join(' ') || null : latest.error ? presentError(latest.error) : null,
        canContinue: !!inputReference && (!historical || nativeWindow.page?.nextCursor !== null),
        onContext: (id: string) => { setReadingContextId(id); setEarlier(false) },
        onMessage: (message: ConversationRecord) => setPreview(current => current ? { ...current, message } : current),
        onContinue: () => { if (!historical) setEarlier(true); else nativeWindow.continueReading() },
        onRefresh: () => { if (historical) nativeWindow.refresh(); else void latest.refresh() }
      } } : {})} /> : null}
  </section>
})
