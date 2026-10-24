import { CapturedProcessRecord } from '@agentmux/client-ui/components/CapturedProcessRecord'
import { conversationItemRef, conversationRecordId } from '@agentmux/core/conversation'
import { ConversationCoverage } from '@agentmux/client-ui/components/ConversationCoverage'
import type { ConversationPresentationController } from '@agentmux/client-ui/use-conversation-record-layout'
import { type AgentConversationRecord, type ConversationItemRef } from '@agentmux/core/conversation'
import { projectConversationWindow, type ConversationRecord } from '@agentmux/client-ui/conversation-records'
import { consumeProgrammaticReadingScroll, markProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'
import { CapturedConversationMessage, type SubmissionDisclosure } from '@agentmux/client-ui/components/CapturedConversationMessage'
import { ReadingFind } from '@agentmux/client-ui/components/ReadingFind'
import { useConversationTraceDisclosure } from '@agentmux/client-ui/conversation-trace-disclosure'
import type { ConversationReplySource } from '@agentmux/core/prompt-reaction'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode, type ComponentProps, type KeyboardEvent, type WheelEvent } from 'react'
import type { AgentDisplayState, AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentObservation } from '@agentmux/core/agent-status'
import type { AgentTimelineItem } from '../../../shared/contracts'
import {
  initFollowState,
  FOLLOW_THRESHOLD_PX,
  onContentChange,
  onScroll,
  shouldShowJumpToLatest,
  isNearBottom,
  type ScrollGeometry
} from '../lib/activity-autoscroll'
import { createRulerScale, describeReadout, describeRulerAxis, describeSpan, describeActivityRecordTime, rulerBand, stepRulerSelection, type RulerReadoutText, type RulerScale } from '../lib/activity-ruler'
import { formatClock } from '@agentmux/client-ui/conversation-time'
import { showEmptyState, showWorkingIndicator } from '../lib/activity-working-state'
import { speaksAsAgent, type ConversationAxisItem, type ConversationAxisMark } from '../lib/conversation-axis'
import { buildContinuationPrompt } from '../lib/session-continuation'
import { isConversationTurn, speakerOf } from '../lib/conversation-speaker'
import { conversationQuote } from '../lib/conversation-quote'
import { terminalLinkPreviewAnchor } from '../lib/terminal-link-gesture'
import { type LinkClickModifiers, type OpenWorkspaceFile } from '@agentmux/client-ui/components/AgentMarkdown'
import type { ReadPastedImage } from '@agentmux/client-ui/components/ConversationImage'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { ConversationReadFailure, type ConversationReadIssue } from './ConversationReadFailure'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { useWorkbenchDocumentVisibility } from '../lib/workbench-window-registry'
import { ConversationReadingRuler, type ConversationVisibleShells } from './ConversationReadingRuler'
export { Ruler } from './ConversationRuler'
import { RULER_WINDOWS, conversationRulerRecords, type RulerRecord, type RulerWindow } from '../lib/conversation-ruler'
import { projectAgentActivityHistory } from '@agentmux/core/timeline'
import type { DescribeSpeaker } from './ConversationAxis'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import type { ConversationProcessMember, ConversationProcessProps } from '@agentmux/client-ui/components/ConversationRecordSequence'
import { renderConversationQuestionNotice } from './ConversationQuestionNotice'
import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { SemanticIcon } from './semantic-icons'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { conversationReadingAnchor, restoreConversationAnchor, useSessionConversationWindow, type ConversationReading } from '../lib/session-conversation-window'
import type { ConversationRevealRequest, RevealConversationItem } from '../lib/mailbox-message-navigation'
import { registerConversationConsumer, conversationFrameObservation, conversationRenderedObservation, conversationInspectionError } from '../lib/conversation-consumer-observation'
import { conversationDiagnosticFrame } from '@agentmux/client-ui/conversation-reading-diagnostics'
import { workbenchDocumentIdentity } from '../lib/workbench-window-registry'
import { useConversationReadAhead } from '../lib/use-conversation-read-ahead'
import type { ConversationConsumerQuery } from '@agentmux/core/control'
import type { ConversationConsumerSample } from '../../../shared/conversation-consumer-observation'
import { channelProfileKey, useChannelActorProfiles } from '../lib/use-channel-actor-profiles'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'

const ThemeNavigationUpIcon = semanticIconComponent('navigation.up')
const ThemeActionCurrentIcon = semanticIconComponent('action.current')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeLayoutCollapseAllIcon = semanticIconComponent('layout.collapse-all')


/**
 * A run of consecutive machine-reported steps between two turns the user can read. Collapsing the run
 * is the second level of folding: level one expands one step's payload, level two hides the whole
 * stretch of lifecycle noise that sits between a prompt and its answer.
 */
type Segment = { kind: 'item'; item: AgentTimelineItem; record: ConversationRecord }

/** Source payloads for the existing leaf renderer and ruler; sequence order stays canonical. */
function buildActivityEntries(projection: ReturnType<typeof projectConversationWindow> | null) {
  const records = projection?.records ?? []
  const nativeTail = records.reduce((last, record, index) => record.original.kind === 'native' ? index : last, -1)
  const afterNativeTail = nativeTail < 0 ? undefined : records[nativeTail + 1]
  const segments: Segment[] = records.flatMap(record => record.original.kind === 'captured'
    ? [{ kind: 'item' as const, item: record.original.item, record }] : [])
  return { records, nativeTailBeforeRecordId: afterNativeTail?.presentationKey ?? afterNativeTail?.id, originalRecords: projection?.originalRecords ?? [], coverage: projection?.timeline.coverage ?? [],
    unifiedItems: segments.map(entry => entry.item), segments }
}

/** A segment paired with the half-open range of event indices it covers, so a position on the ruler
 *  can find the row that hosts that event and the band can read which events are on screen. */
type PlacedSegment = { entry: Segment; key: string; from: number; to: number }

function placeSegments(segments: Segment[]): PlacedSegment[] {
  const placed: PlacedSegment[] = []
  let index = 0
  for (const entry of segments) {
    const size = 1
    const identity = entry.item.id
    const key = JSON.stringify([entry.kind, identity])
    placed.push({ entry, key, from: index, to: index + size - 1 })
    index += size
  }
  return placed
}



/**
 * 「在进行」。
 *
 * 用 aria-live 而不是纯视觉动画：读屏用户同样需要知道 Agent 已经在做事了，否则那一段静默对他们
 * 而言与"没发出去"无法区分。`polite` 是因为这不是需要打断当前朗读的紧急事件。
 */
function WorkingIndicator({ active }: { active: boolean }): JSX.Element {
  return (
    <div className="activity-working" role="status" aria-live="polite">
      <span className="activity-working__dots" aria-hidden="true">
        <SemanticIcon name="status.working" animation={active ? 'work' : 'none'} size={12} />
      </span>
      Working…
    </div>
  )
}

export function ActivityView({
  sessionId,
  executionHostId,
  nativeHistoryPage: recentNativePage,
  nativeContextItems,
  conversationReading,
  readingNotice,
  readingAction,
  revealRequest,
  capability,
  displayState,
  activitySemantic,
  openWorkspaceFile,
  readPastedImage,
  readHistoryResource,
  openHttpLink,
  workspaceRoot = '',
  homeDir = '',
  fileReferenceNotice,
  onContinue,
  onSelectAnnotation,
  describeSpeaker: describeBaseSpeaker,
  moteConversation = false,
  questionReplyRoute, questionReplyTarget, questionReplyContext, questionDraftNotice, onOpenQuestionTerminal, questionReplyState, questionReplyDraft, onQuestionDraftChange, onQuestionReply,
  renderMessageActions, renderRecordActions, renderReadingTools
}: {
  sessionId: string
  executionHostId?: string
  nativeHistoryPage?: AgentSessionHistoryPage | null
  nativeContextItems?: AgentSessionHistoryPage['items']
  conversationReading?: ConversationReading
  readingNotice?: ReactNode
  readingAction?: ReactNode
  revealRequest?: ConversationRevealRequest | null
  capability: 'unavailable' | 'complete-events' | 'streaming'
  /** Session 的显示状态——「这个 turn 在不在工作」的唯一真相，不从时间轴形状反推。 */
  displayState?: AgentDisplayState
  /** Original current observation only qualifies decorative motion; retained display state stays intact. */
  activitySemantic?: AgentObservation['semantic']
  /** Absent means file references in agent prose stay plain text. */
  openWorkspaceFile?: OpenWorkspaceFile
  /** Absent means pasted-image references stay plain text (a text link, as before). */
  readPastedImage?: ReadPastedImage
  readHistoryResource?: ComponentProps<typeof ConversationView>['readHistoryResource']
  /** Absent means an http(s) link in agent prose raises no menu. Set by the host that owns the
   *  destination menu and the Region origin (SessionPane), never resolved here. */
  openHttpLink?: (url: string, event: LinkClickModifiers) => void
  workspaceRoot?: string
  homeDir?: string
  fileReferenceNotice?: ReactNode
  onContinue?: (prompt: string) => void
  onSelectAnnotation?: (selection: ConversationAnnotationSelection) => void
  /**
   * Session owner supplies Agent and Mote presentation. Channel metadata follows
   * this accepted reading window; without represented external actors the default stays unchanged.
   */
  describeSpeaker?: DescribeSpeaker
  moteConversation?: boolean
  renderRecordActions?: (reference: ConversationItemRef, active: boolean, routeHostId?: string) => ReactNode
  renderReadingTools?: (active: boolean, revealLoaded: RevealConversationItem) => ReactNode
  renderMessageActions?: (source: ConversationReplySource) => ReactNode
  questionReplyRoute?: ComponentProps<typeof ConversationView>['questionReplyRoute']
  questionReplyTarget?: ComponentProps<typeof ConversationView>['questionReplyTarget']
  questionDraftNotice?: string | undefined
  questionReplyContext?: string
  onOpenQuestionTerminal?: () => void
  questionReplyDraft?: ComponentProps<typeof ConversationView>['questionReplyDraft']
  onQuestionDraftChange?: ComponentProps<typeof ConversationView>['onQuestionDraftChange']
  onQuestionReply?: ComponentProps<typeof ConversationView>['onQuestionReply']
  questionReplyState?: ComponentProps<typeof ConversationView>['questionReplyState']
}) {
  const logRef = useRef<HTMLDivElement>(null)
  const [feedEl, setFeedEl] = useState<HTMLDivElement | null>(null)
  const visibleShells = useRef<ConversationVisibleShells | null>(null)
  const anchorRef = useRef<ReturnType<typeof conversationReadingAnchor>>(null)
  const followRef = useRef(initFollowState())
  const [showJump, setShowJump] = useState(false)
  // Position is presentation only; a layout move must not grant follow/read intent.
  const [atLoadedTail, setAtLoadedTail] = useState(true)
  const revealReadGeneration = useRef<number | null>(null)
  const returnRef = useRef<HTMLButtonElement>(null)
  const earlierRef = useRef<HTMLDivElement>(null)
  const nativeTailRef = useRef<HTMLDivElement>(null)
  const readingTailRef = useRef<HTMLDivElement>(null)
  const readingSpaceRef = useRef<HTMLDivElement>(null)
  const earlierSpaceAllowed = useRef(false)
  const earlierCommitPending = useRef(false)
  const physicalScrollRef = useRef<ScrollGeometry | null>(null)
  const [rulerWindow, setRulerWindow] = useState<RulerWindow>('24h')
  const presentation = useRef<ConversationPresentationController | null>(null)
  const readingWindow = useSessionConversationWindow(conversationReading, (frame, intent, beforeRecordId) => {
    if (intent === 'earlier' || intent === 'newer' || intent === 'record') followRef.current = { ...followRef.current, following: false }
    const keepAnchor = intent !== 'record' && (intent === 'earlier' || intent === 'newer' || (intent !== 'current' && !followRef.current.following))
    if (presentation.current?.canPresent(frame, { ...(beforeRecordId ? { beforeRecordId } : {}), preserveAnchor: keepAnchor }) === false) return false
    anchorRef.current = keepAnchor && feedEl ? captureReadingAnchor(feedEl) : null
    if (intent === 'earlier') earlierCommitPending.current = true
    if (!keepAnchor) clearEarlierSpace()
    if (intent === 'current') {
      followRef.current = { ...followRef.current, following: true }
    }
    return true
  }, RULER_WINDOWS[rulerWindow])
  function readEarlierRecords(): void {
    readAhead.cancel()
    followRef.current = { ...followRef.current, following: false }
    if (feedEl) anchorRef.current = captureReadingAnchor(feedEl)
    readingWindow.readEarlier()
  }
  const handleReadingKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const interactive = event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="button"], [role="textbox"], [role="combobox"], [role="menu"]')
    if (!event.defaultPrevented && !interactive) {
      if (event.target !== event.currentTarget) anchorRef.current = captureReadingAnchor(event.currentTarget, event.target)
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) requestReadingEdge(-1, event.currentTarget)
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) requestReadingEdge(1, event.currentTarget)
    }
    if (event.key === 'Escape' && !event.defaultPrevented && conversationReading?.opened && conversationReading.onClose) {
      event.stopPropagation(); conversationReading.onClose()
    }
  }
  useLayoutEffect(() => {
    physicalScrollRef.current = null
    clearEarlierSpace()
  }, [sessionId, conversationReading?.identity, conversationReading?.reference.hostId])
  const nativeHistoryPage = readingWindow.page
  const traceDisclosure = useConversationTraceDisclosure(JSON.stringify([executionHostId, sessionId, conversationReading?.identity,
    nativeHistoryPage?.source.providerId, nativeHistoryPage?.source.nativeSessionId]))
  const traceAnchorPending = useRef(false)
  useLayoutEffect(() => {
    if (!traceAnchorPending.current || !feedEl) return
    traceAnchorPending.current = false
    if (anchorRef.current) restoreReadingPosition(feedEl, anchorRef.current)
    markProgrammaticReadingScroll(feedEl)
    syncTailPosition()
  }, [traceDisclosure.expandedTraces, feedEl])
  const questionAnswerContext = useMemo(() => recentNativePage
    ? { ...recentNativePage, items: nativeContextItems ?? recentNativePage.items } : null,
    [recentNativePage, nativeContextItems])
  const historyBoundary = readingWindow.historyBoundary
  const boundaryIndex = !historyBoundary || !nativeHistoryPage ? -1 : nativeHistoryPage.items.findIndex(item => item.id === historyBoundary.beforeRecordId)
  const lastEarlierRecord = nativeHistoryPage?.items[boundaryIndex - 1]
  const boundaryTime = lastEarlierRecord?.completedAt ?? lastEarlierRecord?.startedAt
  const items = readingWindow.captured ?? []
  const readingEnabled = conversationReading?.enabled !== false
  const consumerDocument = useWorkbenchDocument()
  const documentVisible = useWorkbenchDocumentVisibility(consumerDocument)
  const readAhead = useConversationReadAhead({
    identity: JSON.stringify([sessionId, conversationReading?.identity, conversationReading?.reference.hostId, nativeHistoryPage?.source]),
    active: conversationReading?.enabled === true && documentVisible && conversationReading.consumer?.visible !== false && conversationReading.consumer?.activityShown !== false,
    stopped: Boolean(readingWindow.held || readingWindow.error || readingWindow.automaticReadError || readingWindow.previousSource),
    loading: readingWindow.loading,
    frame: readingWindow.snapshot,
    nearEdge: direction => Boolean(feedEl && readingEdgeIsNear(direction, feedEl)),
    read: direction => {
      if (feedEl) anchorRef.current = captureReadingAnchor(feedEl)
      followRef.current = { ...followRef.current, following: false }
      if (direction === 'earlier') return readingWindow.prepareEarlier()
      if (!readingWindow.hasNewer) return false
      readingWindow.readNewer()
      return true
    }
  })
  useLayoutEffect(() => {
    const frame = readingWindow.snapshot
    if (!frame || !feedEl?.isConnected) return
    const location = workbenchDocumentIdentity(feedEl.ownerDocument), context = conversationReading?.consumer
    readingWindow.noteDiagnostic({ phase: 'dom-committed', ...conversationDiagnosticFrame(frame),
      ...(location ? { document: location } : {}), ...(context?.regionId ? { regionId: context.regionId } : {}),
      ...(context?.presentationId ? { presentationId: context.presentationId } : {}) })
  }, [readingWindow.snapshot, readingWindow.noteDiagnostic, feedEl, consumerDocument, conversationReading?.consumer?.regionId, conversationReading?.consumer?.presentationId])
  useLayoutEffect(() => {
    if (!conversationReading || conversationReading.enabled) return
    // The layout boundary observes hiding before the reader's passive cleanup.
    readingWindow.noteDiagnostic({ phase: 'consumer-hidden', reason: 'hidden' })
  }, [conversationReading?.enabled, conversationReading?.consumer?.visible, conversationReading?.identity,
    conversationReading?.reference.hostId, conversationReading?.reference.agentSessionId, documentVisible, readingWindow.noteDiagnostic])
  useEffect(() => {
    if (!conversationReading?.enabled) return
    const visible = documentVisible && conversationReading.consumer?.visible !== false
    // Reader setup runs first in the passive phase, even when its first source
    // read never settles. Both initial gates must be recorded without a frame.
    readingWindow.noteDiagnostic({ phase: visible ? 'consumer-visible' : 'consumer-hidden', ...(visible ? {} : { reason: 'hidden' }) })
  }, [conversationReading?.enabled, conversationReading?.consumer?.visible, conversationReading?.identity,
    conversationReading?.reference.hostId, conversationReading?.reference.agentSessionId, documentVisible, readingWindow.noteDiagnostic])
  const consumerId = useId()
  const inspectConsumer = useRef<((query: ConversationConsumerQuery) => ConversationConsumerSample | null) | null>(null)
  useLayoutEffect(() => {
    inspectConsumer.current = query => {
      const reading = conversationReading
      if (!reading || query.hostId !== reading.reference.hostId || query.agentSessionId !== reading.reference.agentSessionId) return null
      const value = readingWindow.inspect(), context = reading.consumer
      const rect = feedEl?.getBoundingClientRect(), runId = context?.runId ?? null
      return { consumerId, reference: { hostId: reading.reference.hostId, agentSessionId: reading.reference.agentSessionId }, runId,
        matchesExpectedRun: query.expectedRunId === undefined || runId === null ? null : query.expectedRunId === runId,
        readingIdentity: reading.identity,
        location: { regionId: context?.regionId ?? null, presentationId: context?.presentationId ?? null,
          document: feedEl ? workbenchDocumentIdentity(feedEl.ownerDocument) : null },
        gates: { enabled: reading.enabled, visible: context?.visible ?? null, parked: context?.parked ?? null,
          activityShown: context?.activityShown ?? null, viewMode: context?.viewMode ?? null },
        viewport: { connected: Boolean(feedEl?.isConnected), hidden: Boolean(feedEl?.closest('[hidden], [inert]')),
          width: Math.max(0, rect?.width ?? 0), height: Math.max(0, rect?.height ?? 0) },
        loading: value.loading, held: value.held, historical: value.historical, newerAvailable: value.newerAvailable,
        dirty: value.dirty, inFlight: value.inFlight, watch: value.watch,
        error: conversationInspectionError(value.error), sourceError: conversationInspectionError(value.sourceError),
        observationError: conversationInspectionError(value.observationError),
        accepted: conversationFrameObservation(value.snapshot, query.records), pending: conversationFrameObservation(value.pending, query.records),
        rendered: conversationRenderedObservation(feedEl, sessionId, query.records, value.snapshot?.sourceHostId) }
    }
  })
  useLayoutEffect(() => {
    if (!conversationReading) return
    return registerConversationConsumer(consumerId, query => inspectConsumer.current?.(query) ?? null)
  }, [consumerId, Boolean(conversationReading)])
  useLayoutEffect(() => {
    if (earlierCommitPending.current) {
      earlierCommitPending.current = false
      earlierSpaceAllowed.current = true
    }
    if (conversationReading?.enabled && feedEl && anchorRef.current) restoreReadingPosition(feedEl, anchorRef.current)
    else if (conversationReading?.enabled && feedEl && followRef.current.following) pinToBottom()
    if (conversationReading?.enabled && feedEl) markProgrammaticReadingScroll(feedEl)
  }, [nativeHistoryPage, items, feedEl, conversationReading?.enabled])
  useLayoutEffect(() => {
    // Error and transient newer notices can move a retained body before a page commits.
    if (conversationReading?.enabled && feedEl && anchorRef.current) {
      restoreReadingPosition(feedEl, anchorRef.current)
      markProgrammaticReadingScroll(feedEl)
    }
  }, [readingWindow.error, readingWindow.newerOutside, feedEl, conversationReading?.enabled])
  useEffect(() => {
    if (!conversationReading?.enabled || !conversationReading.opened || !conversationReading.onClose) return
    returnRef.current?.focus({ preventScroll: true })
  }, [conversationReading?.opened, conversationReading?.identity])
  const { records: conversationRecords, originalRecords: originalConversationRecords, coverage: conversationCoverage, nativeTailBeforeRecordId, unifiedItems, segments } = useMemo(
    () => buildActivityEntries(readingWindow.projection), [readingWindow.projection])
  const channelAuthors = useMemo(() => [...conversationRecords, ...originalConversationRecords].flatMap(record =>
    record.author?.kind === 'external' ? [record.author] : []), [conversationRecords, originalConversationRecords])
  const channelOwner = useMemo(() => {
    const snapshot = readingWindow.snapshot
    return snapshot && [...conversationRecords, ...originalConversationRecords].every(record => record.author?.kind !== 'external' ||
      record.executionHostId === snapshot.hostId && record.sourceHostId === snapshot.sourceHostId) ? snapshot : undefined
  }, [readingWindow.snapshot, conversationRecords, originalConversationRecords])
  const channelProfiles = useChannelActorProfiles(channelAuthors, channelOwner, readingEnabled && documentVisible &&
    conversationReading?.consumer?.visible !== false && conversationReading?.consumer?.activityShown !== false)
  const describeSpeaker = useMemo(() => {
    if (!channelAuthors.length) return describeBaseSpeaker
    const external = createSpeakerResolver({ lookupExternal: author => channelProfiles.get(channelProfileKey(author)) })
    return ((speaker, size) => speaker.role === 'external' ? external(speaker) :
      describeBaseSpeaker?.(speaker, size) ?? external(speaker)) satisfies DescribeSpeaker
  }, [describeBaseSpeaker, channelProfiles, channelAuthors.length])

  const placed = useMemo(() => placeSegments(segments), [segments])
  const segmentEls = useRef(new Map<string, HTMLElement>())
  function captureReadingAnchor(viewport: HTMLElement, target?: EventTarget | null): ReturnType<typeof conversationReadingAnchor> {
    const selection = viewport.ownerDocument.defaultView?.getSelection()
    const node = target instanceof Node ? target : selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0).startContainer : null
    const element = node instanceof Element ? node : node?.parentElement
    const segment = element?.closest<HTMLElement>('[data-segment-key]')
    if (segment && viewport.contains(segment)) return { kind: 'segment', id: segment.dataset.segmentKey!, offset: segment.getBoundingClientRect().top - viewport.getBoundingClientRect().top }
    const observed = visibleShells.current
    return conversationReadingAnchor(viewport, undefined, false, observed?.feed === viewport && observed.sessionId === sessionId ? observed.shells : undefined)
  }
  const readEntryImage = useCallback<ReadPastedImage>(path => readingEnabled && readPastedImage
    ? readPastedImage(path) : Promise.resolve(null), [readingEnabled, readPastedImage])
  const origin = useMemo(() => {
    for (const it of unifiedItems) {
      const t = it.createdAt
      if (t !== undefined) return t
    }
    return 0
  }, [unifiedItems])
  const rulerRecords = useMemo(() => conversationRulerRecords(sessionId, nativeHistoryPage, unifiedItems, conversationRecords),
    [sessionId, nativeHistoryPage, unifiedItems])
  const activity = useMemo(() => projectAgentActivityHistory(items), [items])
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const selectedRecord = rulerRecords.find(record => record.id === selectedRecordId)
  const selectedIndex = selectedRecord?.target.kind === 'observed' ? selectedRecord.target.index : null


  const [locatedMessageKey, setLocatedMessageKey] = useState<string | null>(null)
  useEffect(() => {
    if (!locatedMessageKey) return
    const timer = window.setTimeout(() => setLocatedMessageKey(null), 2200)
    return () => window.clearTimeout(timer)
  }, [locatedMessageKey])
  useEffect(() => { setLocatedMessageKey(null) }, [sessionId])
  // 跟随状态是一个**值**，判定全在 lib 里；组件只负责把几何量喂进去、把决定执行掉。
  // 这样"什么时候该贴底"能被断言，而不是埋在一个 effect 里——本仓库测试不跑 effect。
  const lastSessionIdRef = useRef<string | null>(null)
  const currentSessionId = sessionId

  useEffect(() => {
    if (!readingEnabled) return
    if (currentSessionId && lastSessionIdRef.current !== currentSessionId) {
      lastSessionIdRef.current = currentSessionId
      followRef.current = initFollowState()
      setShowJump(false)
      pinToBottom()
    }
  }, [currentSessionId, readingEnabled])

  const nativeReadingTail = (el: HTMLElement): number | null => {
    const tail = nativeTailRef.current
    return tail && nativeHistoryPage?.agentSessionId === sessionId && nativeHistoryPage.items.length
      ? el.scrollTop + tail.getBoundingClientRect().top - el.getBoundingClientRect().top
      : null
  }
  // Displayed content and native pagination have different ends. A captured reply is readable
  // content too; opening machine details must not change which native cursor owns paging.
  const readingHeight = (el: HTMLElement): number => Math.max(el.clientHeight, readingTailRef.current
    ? el.scrollTop + readingTailRef.current.getBoundingClientRect().top - el.getBoundingClientRect().top
    : el.scrollHeight)
  const feedGeometry = (): ScrollGeometry | null => {
    const el = feedEl ?? logRef.current?.closest('.activity-feed')
    if (!(el instanceof HTMLElement)) return null
    return { scrollTop: el.scrollTop, scrollHeight: readingHeight(el), clientHeight: el.clientHeight }
  }
  function syncTailPosition(): void {
    const geometry = feedGeometry()
    if (geometry) setAtLoadedTail(isNearBottom(geometry))
  }
  function syncTailAfterLayout(cause?: 'resize'): void {
    const resized = cause === 'resize' ? feedEl : null
    const physicalTail = resized && isNearBottom({ scrollTop: resized.scrollTop, scrollHeight: resized.scrollHeight, clientHeight: resized.clientHeight })
    if (followRef.current.following || atLoadedTail || physicalTail) syncTailPosition()
  }

  function clearEarlierSpace(): void {
    earlierSpaceAllowed.current = false
    earlierCommitPending.current = false
    if (readingSpaceRef.current) readingSpaceRef.current.style.height = ''
  }
  function restoreReadingPosition(viewport: HTMLElement, anchor: NonNullable<typeof anchorRef.current>): void {
    restoreConversationAnchor(viewport, anchor, earlierSpaceAllowed.current ? readingSpaceRef.current : null)
  }

  const pinToBottom = (): void => {
    clearEarlierSpace()
    const el = feedEl ?? logRef.current?.closest('.activity-feed')
    if (el instanceof HTMLElement) { el.scrollTop = Math.max(0, readingHeight(el) - el.clientHeight); markProgrammaticReadingScroll(el) }
  }

  const jumpToLatest = (): void => {
    readAhead.cancel()
    anchorRef.current = null
    pinToBottom()
    const geometry = feedGeometry()
    if (geometry) followRef.current = onScroll(followRef.current, geometry)
    followRef.current = { ...followRef.current, following: true }
    syncTailPosition()
    setShowJump(shouldShowJumpToLatest(followRef.current))
  }

  const returnToLatest = (): void => {
    readAhead.cancel()
    if (readingWindow.historical || readingWindow.newerOutside || readingWindow.held || readingWindow.error) {
      readingWindow.showCurrent()
    } else jumpToLatest()
  }

  const handleReadingWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    anchorRef.current = captureReadingAnchor(el, event.target)
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1)
    requestReadingEdge(Math.sign(delta), el, delta)
  }
  const requestReadingEdge = (direction: number, el: HTMLElement, delta = 0): void => {
    if (!conversationReading?.enabled) return
    if (direction < 0 && anchorRef.current?.kind === 'segment') {
      const observed = visibleShells.current
      const nativeAnchor = conversationReadingAnchor(el, undefined, true, observed?.feed === el && observed.sessionId === sessionId ? observed.shells : undefined)
      // Captured content has its own readable tail. Hand paging back only when
      // the original sequence is actually visible in this viewport.
      if (!nativeAnchor) { readAhead.cancel(); return }
      anchorRef.current = nativeAnchor
    }
    if (!direction) return
    const edge = direction < 0 ? 'earlier' : 'newer'
    if (!readingEdgeIsNear(edge, el, delta) || edge === 'newer' && anchorRef.current?.kind === 'segment') {
      readAhead.cancel(); return
    }
    readAhead.request(edge)
  }
  function readingEdgeIsNear(direction: 'earlier' | 'newer', el: HTMLElement, delta = 0): boolean {
    const distance = Math.max(80, el.clientHeight * 2)
    const nextTop = Math.max(0, el.scrollTop + delta)
    const boundary = earlierRef.current
    const boundaryTop = boundary ? el.scrollTop + boundary.getBoundingClientRect().bottom - el.getBoundingClientRect().top : 0
    if (direction === 'earlier') return nextTop <= boundaryTop + distance
    const tail = nativeReadingTail(el) ?? el.scrollHeight
    return tail - el.scrollTop >= 0 && tail - el.clientHeight - nextTop <= distance
  }

  // 用户主动往上滚才脱离；内容变长不算——两者都会让"离底部的距离"变大，能区分它们的证据是
  // scrollTop 本身有没有减少。判定在 lib 里，这里只把事件折进去。
  useEffect(() => {
    if (!readingEnabled) return
    const el = feedEl ?? logRef.current?.closest('.activity-feed')
    if (!(el instanceof HTMLElement)) return
    const handle = (): void => {
      const geometry = feedGeometry()
      if (!geometry) return
      const programmatic = consumeProgrammaticReadingScroll(el)
      const direction = Math.sign(geometry.scrollTop - followRef.current.lastScrollTop)
      const physical = { ...geometry, scrollHeight: el.scrollHeight }
      const previous = physicalScrollRef.current
      physicalScrollRef.current = physical
      // A browser clamps the existing position when the viewport or content extent shrinks.
      // That completed layout move cannot borrow a direction for another page request.
      const layoutClamp = previous && (previous.clientHeight !== physical.clientHeight || previous.scrollHeight !== physical.scrollHeight)
        && physical.scrollTop < previous.scrollTop
        && Math.abs(physical.scrollTop - Math.min(previous.scrollTop, Math.max(0, physical.scrollHeight - physical.clientHeight))) <= 1
      if (programmatic !== 'restore' && geometry.scrollTop !== followRef.current.lastScrollTop) anchorRef.current = captureReadingAnchor(el)
      followRef.current = programmatic === 'restore'
        ? { ...followRef.current, lastScrollTop: geometry.scrollTop }
        : onScroll(followRef.current, geometry)
      if (geometry.scrollTop > Math.max(0, geometry.scrollHeight - geometry.clientHeight) + FOLLOW_THRESHOLD_PX)
        followRef.current = { ...followRef.current, following: false }
      if (followRef.current.following && earlierSpaceAllowed.current) {
        clearEarlierSpace()
        followRef.current = { ...followRef.current, lastScrollTop: el.scrollTop }
        markProgrammaticReadingScroll(el)
      }
      syncTailPosition()
      setShowJump(shouldShowJumpToLatest(followRef.current))
      if (!programmatic && !layoutClamp && direction) requestReadingEdge(direction, el)
    }
    el.addEventListener('scroll', handle, { passive: true })
    return () => el.removeEventListener('scroll', handle)
  }, [feedEl, readingWindow.historical, readingWindow.loading, readingWindow.hasMore, readingWindow.hasNewer, readingWindow.error, readingWindow.coverageLoading, conversationReading?.enabled, readingEnabled])

  // 新内容到达时贴底。追加与原地变长都算"新内容"——流式回答最常见的形态正是后者（尾项没换，
  // 只是变长了）。只有仍在跟随时才贴，否则会把已经滚上去的读者拽回来。
  useEffect(() => {
    if (!readingEnabled || readingWindow.historical) return
    const page = nativeHistoryPage?.agentSessionId === sessionId ? nativeHistoryPage : null
    const nativeTail = page?.items.at(-1)
    const observedTail = unifiedItems.at(-1)
    // Each independent source keeps its own tail. Both can change in place while displayed;
    // this signature is display change detection, never an association or adoption claim.
    const nativeLength = nativeTail?.contentParts.reduce((length, part) => length +
      Object.values(part).reduce<number>((size, value) => size + (typeof value === 'string' ? value.length : 0), 0), 0) ?? 0
    const decision = onContentChange(followRef.current, {
      itemCount: unifiedItems.length + (page?.items.length ?? 0),
      lastItemId: JSON.stringify([nativeTail ? [page!.source.providerId, page!.source.nativeSessionId, nativeTail.id] : null, observedTail?.id ?? null]),
      lastItemLength: nativeLength + (observedTail?.content?.length ?? 0)
    })
    followRef.current = decision.state
    if (decision.scrollToBottom) pinToBottom()
    syncTailAfterLayout()
    setShowJump(shouldShowJumpToLatest(followRef.current))
  }, [unifiedItems, nativeHistoryPage, sessionId, feedEl, readingWindow.historical, readingEnabled])

  // Current readers should not repeatedly click Current after the shared source
  // advances beyond this local window. Historical reading and selection own their position.
  useEffect(() => {
    if (!conversationReading?.enabled || !readingWindow.newerOutside || readingWindow.historical
      || readingWindow.loading || !followRef.current.following || !feedEl) return
    const document = feedEl.ownerDocument
    const attempt = (): void => {
      if (!followRef.current.following || !conversationReading.enabled) return
      const selection = document.defaultView?.getSelection()
      if (selection && !selection.isCollapsed && selection.rangeCount) {
        try { if (selection.getRangeAt(0).intersectsNode(feedEl)) return }
        catch { return }
      }
      readingWindow.showLatestAutomatically()
    }
    attempt()
  }, [conversationReading?.enabled, readingWindow.newerOutside, readingWindow.historical,
    readingWindow.loading, readingWindow.error, recentNativePage, showJump, feedEl])

  // This same exact rendered-record owner also serves closed Sessions with no Run.
  function locateLoadedRecord(sourceKey: string, isCurrent: () => boolean): boolean {
    if (!readingEnabled || !feedEl?.isConnected || !isCurrent()) return false
    const matches = Array.from(feedEl.querySelectorAll<HTMLElement>('.log-turn[data-message-source-key], .conversation-a2a-notice[data-message-source-key], .conversation-reply-observation[data-message-source-key], .conversation-original-record[data-message-source-key], [data-conversation-process-source-key]'))
      .filter(node => node.dataset.messageSourceKey === sourceKey && (node.matches('.conversation-reply-observation') || !node.closest('.conversation-reply-observation')))
    const owners = matches.filter(node => !matches.some(parent => parent !== node && parent.contains(node)))
    if (owners.length !== 1) return false
    const node = owners[0]!
    if (node.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    const head = node.matches('.conversation-reply-observation')
      ? node.querySelector<HTMLElement>('[data-observation-step-id]') ?? node
      : node.querySelector<HTMLElement>('.log-turn__head, .wf-tool-row') ?? node
    followRef.current = { ...followRef.current, following: false }
    head.scrollIntoView({ block: 'center', behavior: 'instant' })
    anchorRef.current = captureReadingAnchor(feedEl, node)
    markProgrammaticReadingScroll(feedEl, 'navigation')
    if (!isCurrent()) return false
    node.focus({ preventScroll: true })
    const r = head.getBoundingClientRect(), viewport = feedEl.getBoundingClientRect()
    const inView = r.width > 0 && r.height > 0 && r.bottom > viewport.top && r.top < viewport.bottom
    if (inView) setLocatedMessageKey(sourceKey)
    return inView
  }
  const revealLoadedRecord: RevealConversationItem = async (reference, routeHostId = executionHostId) => {
    if (routeHostId !== executionHostId || reference.agentSessionId !== sessionId) return { kind: 'unavailable', message: 'This point belongs to another original conversation. Its reference is kept.' }
    const sourceKey = conversationMessageSourceKey(reference.agentSessionId, reference.source)
    if (!originalConversationRecords.some(record => record.sourceHostId === reference.hostId && conversationMessageSourceKey(record.agentSessionId, record.source) === sourceKey)) return { kind: 'unavailable', message: 'The original source Host is unconfirmed or does not match this record. Its reference and content are kept.' }
    if (sourceKey) { setLocatedMessageKey(sourceKey); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) }
    return sourceKey && locateLoadedRecord(sourceKey, () => readingEnabled)
      ? { kind: 'located' } : { kind: 'unavailable', message: 'The exact original record is not in this loaded reading window. The point is kept; read earlier records or reconnect its original source, then try again.' }
  }

  useEffect(() => {
    if (!revealRequest) { revealReadGeneration.current = null; return }
    if (!readingEnabled || !feedEl) return
    if (!revealRequest.isCurrent()) { revealRequest.complete(false); return }
    const reading = readingWindow.inspect()
    if (conversationReading && (reading.loading || reading.inFlight || reading.watch.binding || reading.held || !reading.snapshot && !reading.error)) return
    const target = revealRequest.record, source = target.source
    const sourceChanged = ['AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'native-source-changed'].includes(
      (reading.error as (Error & { code?: string }) | null)?.code ?? '')
    if (source.kind === 'native' && (sourceChanged || nativeHistoryPage &&
      (nativeHistoryPage.source.providerId !== source.providerId || nativeHistoryPage.source.nativeSessionId !== source.nativeSessionId))) {
      revealRequest.complete(false, '原生来源已变化，当前阅读窗口保留；请刷新来源后再定位。'); return
    }
    const snapshot = reading.snapshot
    const present = originalConversationRecords.some(record => record.sourceHostId === target.hostId &&
      (!revealRequest.inputId || record.input?.id === revealRequest.inputId) &&
      conversationMessageSourceKey(record.agentSessionId, record.source) === revealRequest.sourceKey)
    const targetCoverage = snapshot?.coverage.filter(coverage => coverage.source.kind === source.kind &&
      (source.kind === 'captured' || coverage.source.kind === 'native' &&
        coverage.source.providerId === source.providerId && coverage.source.nativeSessionId === source.nativeSessionId)) ?? []
    // Another source's service failure cannot take away an accepted healthy target.
    // An actual read failure, unknown coverage or changed target still refuses this request.
    const acceptedTargetAvailable = (current: typeof reading) => current.snapshot === snapshot &&
      current.error === current.sourceError && current.errorOperation === null && present &&
      snapshot !== null && snapshot.hostId === executionHostId && snapshot.agentSessionId === target.agentSessionId && snapshot.sourceHostId === target.hostId &&
      targetCoverage.length === 1 && targetCoverage[0]!.current === 'complete-through-cut'
    if (reading.error && !acceptedTargetAvailable(reading)) { revealRequest.complete(false, `读取对话失败：${reading.error.message}`); return }
    if (!snapshot || snapshot.hostId !== executionHostId || snapshot.agentSessionId !== target.agentSessionId ||
      snapshot.sourceHostId !== target.hostId) {
      revealRequest.complete(false, '记录关系未确认，无法定位。'); return
    }
    const id = conversationRecordId(target)
    const loaded = originalConversationRecords.some(record => record.records?.some(original => original.id === id))
    if (conversationReading && revealReadGeneration.current !== revealRequest.generation && !loaded) {
      revealReadGeneration.current = revealRequest.generation
      readAhead.cancel()
      void readingWindow.selectRecord(target, { signal: revealRequest.signal })
      return
    }
    if (!present) { revealRequest.complete(false, '当前有界对话窗口中没有这条记录，无法确认位置。'); return }
    if (conversationReading?.consumer?.activityShown === false) {
      if (!revealRequest.present()) revealRequest.complete(false)
      return
    }
    setLocatedMessageKey(revealRequest.sourceKey)
    const frame = requestAnimationFrame(() => {
      if (!revealRequest.isCurrent() || !feedEl.isConnected) { revealRequest.complete(false); return }
      const current = readingWindow.inspect()
      if (conversationReading && (current.loading || current.inFlight || current.watch.binding || current.held)) return
      if (current.snapshot !== snapshot) return
      if (current.error && !acceptedTargetAvailable(current)) { revealRequest.complete(false, `读取对话失败：${current.error.message}`); return }
      const located = locateLoadedRecord(revealRequest.sourceKey, revealRequest.isCurrent)
      revealRequest.complete(located, located ? undefined : current.error ? `读取对话失败：${current.error.message}` : undefined)
    })
    return () => cancelAnimationFrame(frame)
  }, [revealRequest, feedEl, originalConversationRecords, nativeHistoryPage, readingEnabled, executionHostId,
    Boolean(conversationReading), conversationReading?.consumer?.activityShown,
    readingWindow.snapshot, readingWindow.loading, readingWindow.held, readingWindow.error])

  // Segment elements keyed by segment key, so a resolved event index can find its host row and the
  // observer can watch each one.

  const segmentForIndex = (index: number): PlacedSegment | undefined =>
    placed.find((entry) => index >= entry.from && index <= entry.to)

  const selectEvent = (index: number): void => {
    const record = rulerRecords.find(record => record.target.kind === 'observed' && record.target.index === index)
    if (record) selectRulerRecord(record)
  }



  const locateRef = useRef<{ frame: number | null; source: readonly ConversationRecord[]; enabled: boolean }>({ frame: null, source: conversationRecords, enabled: readingEnabled })
  locateRef.current.source = conversationRecords
  locateRef.current.enabled = readingEnabled
  useEffect(() => () => { if (locateRef.current.frame !== null) cancelAnimationFrame(locateRef.current.frame) }, [sessionId])
  function selectRulerRecord(record: RulerRecord): void {
    if (locateRef.current.frame !== null) cancelAnimationFrame(locateRef.current.frame)
    const accepted = conversationRecords.find(member => member.id === record.id)
    if (!accepted || !readingEnabled || !feedEl) return
    setSelectedRecordId(record.id)
    const target = record.target
    const source = conversationRecords
    const thread = feedEl.querySelector<HTMLElement>('.conversation-native-thread')
    if (!thread) return
    const current = () => locateRef.current.source === source && locateRef.current.enabled && thread.isConnected
    const group = [...thread.querySelectorAll<HTMLElement>('[data-conversation-process-members]')]
      .find(node => (JSON.parse(node.dataset.conversationProcessMembers ?? '[]') as ConversationProcessMember[]).some(member => member.id === record.id))
    const toggle = group?.querySelector<HTMLButtonElement>('.wf-head[aria-expanded="false"]')
    toggle?.click()
    const sourceKey = conversationMessageSourceKey(accepted.agentSessionId, accepted.source)
    if (sourceKey) setLocatedMessageKey(sourceKey)
    const findNode = (): HTMLElement | undefined => {
      if (target.kind === 'observed') {
        const host = segmentForIndex(target.index)
        return host ? segmentEls.current.get(host.key) : undefined
      }
      return [...thread.querySelectorAll<HTMLElement>('[data-native-record-id], [data-native-step-id]')]
        .find(node => node.closest<HTMLElement>('[data-native-source]')?.dataset.nativeSource === target.source && (node.dataset.nativeRecordId === target.recordId || node.dataset.nativeStepId === target.recordId))
    }
    locateRef.current.frame = requestAnimationFrame(() => {
      locateRef.current.frame = null
      if (!current()) return
      findNode()?.querySelector<HTMLButtonElement>('.wf-tool-row[aria-expanded="false"]')?.click()
      locateRef.current.frame = requestAnimationFrame(() => {
        locateRef.current.frame = null
        if (!current()) return
        const node = findNode()
        if (!node) return
        followRef.current = { ...followRef.current, following: false }
        node.scrollIntoView({ block: 'nearest' })
        anchorRef.current = captureReadingAnchor(feedEl, node)
        markProgrammaticReadingScroll(feedEl, 'navigation')
      })
    })
  }

  const hasUserMessages = Boolean(readingWindow.projection?.inputs.length)
  const hasNativeRecords = nativeHistoryPage?.agentSessionId === sessionId && nativeHistoryPage.items.length > 0
  const hasItems = unifiedItems.length > 0
  const readPending = readingEnabled && readingWindow.loading
  const hasAcceptedFrame = Boolean(conversationReading && readingWindow.snapshot)
  const initialReadPending = readPending && !hasAcceptedFrame
  const earlierReadPending = readingWindow.loadingEarlier || readingWindow.coverageLoading
  const hasReadContent = hasUserMessages || hasNativeRecords || hasItems || rulerRecords.length > 0
  const readingIssues: ConversationReadIssue[] = []
  if (readingWindow.error || !hasReadContent && readingWindow.automaticReadError) readingIssues.push({
    id: 'conversation-records', label: 'Conversation records',
    reasons: [readingWindow.error ?? readingWindow.automaticReadError!.message], loading: readingWindow.loading,
    retryLabel: readingWindow.retryLabel === 'Retry' ? 'Retry conversation records' : readingWindow.retryLabel, retry: readingWindow.retry
  })
  const emptyReadFailed = Boolean(readingWindow.error || readingWindow.automaticReadError)
  const readingServiceScope = JSON.stringify(['conversation-reading', executionHostId, sessionId, conversationReading?.identity])
  const fullReadFailure = Boolean(conversationReading && !hasReadContent && readingIssues.length)
  const emptyReadStatus = fullReadFailure ? <ConversationReadFailure scope={readingServiceScope} issues={readingIssues}
    full visible={readingEnabled} /> : !hasReadContent && !earlierReadPending && (initialReadPending || emptyReadFailed) ? (
    <FullPageLoadingSurface className="activity-feed__empty-reading" scope="region"
      phase={emptyReadFailed ? 'failed' : 'loading'} eyebrow="Conversation reading"
      title={emptyReadFailed ? 'Reading interrupted' : 'Reading conversation…'} detail="">
      {!emptyReadFailed ? <div className="full-page-loading__light activity-feed__reading-light" aria-hidden="true"
        style={{ animationPlayState: documentVisible ? undefined : 'paused' }} /> : null}
      <div className="activity-feed__reading-caption">
        <strong>{emptyReadFailed ? 'Reading interrupted' : 'Reading conversation…'}</strong>
        {emptyReadFailed ? <span>Retry the source above to continue reading.</span> : null}
      </div>
    </FullPageLoadingSurface>
  ) : null
  // Reading navigation belongs to the message flow; the ruler keeps temporal facts only.
  const readingEntry = conversationReading && (readingWindow.hasMore || readingWindow.capturedHasMore || readingWindow.automaticReadError || readingWindow.hasNewer ||
    conversationReading.opened && conversationReading.onClose || readingAction || conversationReading.nativeSourceFacts?.nativeConfirmation) ? (
    <div ref={earlierRef} className="activity-feed__reading" data-conversation-reading={readingWindow.historical ? 'earlier' : 'current'}>
      <div className="activity-feed__reading-entry">
        {readingWindow.hasMore || readingWindow.capturedHasMore || readingWindow.automaticReadError ? (
          <button type="button" className="activity-feed__reading-action" disabled={readingWindow.loading && !readingWindow.coverageLoading || !conversationReading.enabled}
            title={readingWindow.automaticReadError ? undefined : 'Read earlier conversation and process records in the original sequence'}
            data-read-error={readingWindow.automaticReadError ? 'true' : undefined}
            aria-busy={earlierReadPending || undefined}
            onClick={readingWindow.automaticReadError ? readingWindow.retry : readEarlierRecords}>
            {earlierReadPending ? <SemanticIcon name="status.loading" animation="spin" size={12} /> : <ThemeNavigationUpIcon size={12} aria-hidden="true" />}
            {readingWindow.automaticReadError ? <span className="activity-feed__reading-failure" role="status" aria-live="polite">
              <span>{earlierReadPending ? 'Loading earlier…' : 'Retry loading earlier'}</span>
              <span>{readingWindow.automaticReadError.message || 'The original read failed.'}</span>
            </span> : <span {...(earlierReadPending ? { role: 'status', 'aria-live': 'polite' as const } : {})}>{earlierReadPending ? 'Loading earlier…' : 'Earlier'}</span>}
          </button>
        ) : null}
        {readingWindow.hasNewer ? <button type="button" className="activity-feed__reading-action"
          disabled={readingWindow.loading && !readingWindow.coverageLoading || !conversationReading.enabled}
          title="Read the adjacent newer page" onClick={() => { readAhead.cancel(); readingWindow.readNewer() }}>Newer</button> : null}
        {conversationReading.nativeSourceFacts?.nativeConfirmation ? <>
          <span className="activity-feed__reading-status">{readingWindow.previousSource ? 'Previous native source' : 'Current native source'}</span>
          <button type="button" className="activity-feed__reading-action" disabled={!conversationReading.enabled}
            onClick={() => { readAhead.cancel(); readingWindow.showCurrentSource() }}>Current source</button>
          <button type="button" className="activity-feed__reading-action" disabled={!conversationReading.enabled}
            onClick={() => { readAhead.cancel(); readingWindow.showPreviousSource() }}>Previous source</button>
        </> : null}
        {conversationReading.opened && conversationReading.onClose ? <button ref={returnRef} type="button"
          className="activity-feed__reading-action" aria-label={`Return to ${conversationReading.returnLabel ?? 'Activity'}`}
          onClick={conversationReading.onClose}><ThemeNavigationBackIcon size={12} aria-hidden="true" />Return</button> : null}
        {readingAction}
      </div>
    </div>
  ) : null
  const readNotice = <>
    {readingNotice}
    {conversationReading ? !fullReadFailure && readingIssues.length > 0 ? <ConversationReadFailure
      scope={readingServiceScope} issues={readingIssues} visible={readingEnabled} /> : null : readingWindow.error ? <div role="status" className="activity-feed__read-notice"><span>{readingWindow.error}</span>
      <button type="button" className="small-button" disabled={readingWindow.loading} onClick={readingWindow.retry}>{readingWindow.retryLabel}</button></div> : null}
  </>
  const collapseTraces = nativeHistoryPage?.items.some(item => item.contentParts.some(part =>
    part.kind === 'reasoning' || part.kind === 'tool-call' || part.kind === 'tool-result')) ? <button type="button"
    className="conversation-process-collapse" aria-label="收起已展开的过程详情"
    title={traceDisclosure.expandedTraces.size ? '收起本页已展开的工具与思考详情；保留答案和过程摘要' : '本页没有已展开的工具或思考详情'}
    disabled={!readingEnabled} aria-disabled={traceDisclosure.expandedTraces.size === 0}
    onMouseDown={event => event.preventDefault()} onClick={event => {
      if (traceDisclosure.expandedTraces.size === 0) return
      followRef.current = { ...followRef.current, following: false }
      if (feedEl) {
        anchorRef.current = captureReadingAnchor(feedEl)
        const focused = feedEl.ownerDocument.activeElement
        const payload = focused instanceof Element ? focused.closest('.conversation-tool-trace__payload, .log-turn__trace-payload') : null
        if (payload && feedEl.querySelector('.conversation-native-thread')?.contains(payload)) event.currentTarget.focus({ preventScroll: true })
      }
      traceAnchorPending.current = true
      setShowJump(true)
      traceDisclosure.collapse()
    }}><ThemeLayoutCollapseAllIcon size={13} aria-hidden="true" /></button> : null

  // A recent source update can lead the committed window for one render. It is
  // independent of the reader's position and must not flash a scroll affordance.
  const needsReturnToLatest = showJump && (!atLoadedTail || readingWindow.currentOutside) || readingWindow.historical || readingWindow.held || Boolean(readingWindow.error)
  const currentActionLabel = readingWindow.error ? '读取当前记录' : '滚动到最新'
  const latestControl = needsReturnToLatest ? (
    <div className="activity-feed__latest-layer" data-conversation-current-entry>

      <button type="button" className="activity-feed__jump" data-message-tool-control="jump-to-latest"
        aria-label={currentActionLabel} disabled={!readingEnabled}
        title={readingWindow.held ? '原阅读位置和选区已保留，取消选择或移开当前阅读位置后可滚动到最新' : currentActionLabel}
        onMouseDown={event => event.preventDefault()} onClick={returnToLatest}>
        <ThemeActionCurrentIcon size={12} aria-hidden="true" />{currentActionLabel}
      </button>
    </div>
  ) : null

  const renderReadingHeader = (tools: ReactNode, rulerContent?: ReactNode): JSX.Element => (
    <div key="reading-header" className="activity-feed__reading-header" data-has-ruler={rulerContent ? 'true' : undefined}>
      {rulerContent ?? emptyReadStatus}
      {readingEntry}
      {!rulerContent ? <div className="reading-find__floating-trigger">{tools}</div> : null}
    </div>
  )

  const renderSurface = (content: (findTrigger: ReactNode) => JSX.Element): JSX.Element => {
    return <ReadingFind className="activity-feed-frame"
    active={readingEnabled} source={JSON.stringify([executionHostId, sessionId, conversationReading?.identity])}
    label="loaded conversation" bodySelector=".log-turn__body, .log-row__prose, .conversation-tool-trace__payload, .wf-native-process__body, .log-diff__body" scrollSelector=".activity-feed"
    onOpen={() => {
      followRef.current = { ...followRef.current, following: false }
      if (feedEl) anchorRef.current = captureReadingAnchor(feedEl)
    }}>
    {findTrigger => <>{content(findTrigger)}{latestControl}</>}
  </ReadingFind>
  }

  if (capability === 'unavailable' && !hasUserMessages && !hasItems && !hasNativeRecords) {
    return renderSurface(findTrigger => (
      <div className="activity-feed" data-workbench-reading-scroll onKeyDown={handleReadingKey} data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}
        onWheel={handleReadingWheel}>
        {readNotice}
        <ConversationCoverage coverage={conversationCoverage} onLocate={revealLoadedRecord} />
        {fileReferenceNotice}
        {renderReadingHeader(findTrigger)}
        {!emptyReadStatus ? <div className="activity-feed__empty">
          This executor does not provide structured activity. Terminal remains available.
        </div> : null}
      </div>
    ))
  }
  if (!hasUserMessages && !hasNativeRecords && showEmptyState(displayState, hasItems ? items : [])) {
    return renderSurface(findTrigger => (
      <div className="activity-feed" data-workbench-reading-scroll onKeyDown={handleReadingKey} data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}
        onWheel={handleReadingWheel}>
        {readNotice}
        <ConversationCoverage coverage={conversationCoverage} onLocate={revealLoadedRecord} />
        {fileReferenceNotice}
        {renderReadingHeader(findTrigger)}
        {!emptyReadStatus && (!readPending || hasAcceptedFrame) && !readingWindow.error ? <div className="activity-feed__empty">
          No structured activity yet. Terminal remains available.
        </div> : null}
      </div>
    ))
  }
  // 正在想、但首行还没落地：显示"在进行"而不是空状态。一个正在工作的东西显示成空，
  // 比慢更糟——用户会以为自己没发出去，然后再发一遍。
  if (!hasUserMessages && !hasItems && !hasNativeRecords) {
    return renderSurface(findTrigger => (
      <div className="activity-feed" data-workbench-reading-scroll onKeyDown={handleReadingKey} data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}
        onWheel={handleReadingWheel}>
        {readNotice}
        <ConversationCoverage coverage={conversationCoverage} onLocate={revealLoadedRecord} />
        {fileReferenceNotice}
        {renderReadingHeader(findTrigger)}
        {!emptyReadStatus ? <WorkingIndicator active={activitySemantic === 'active'} /> : null}
      </div>
    ))
  }

  const placedByRecord = new Map(placed.flatMap(segment => segment.entry.kind === 'item' && segment.entry.record ? [[segment.entry.record.id, segment] as const] : []))
  const registerSegment = (key: string) => (el: HTMLDivElement | null): void => {
    if (el) {
      el.dataset.segmentKey = key
      segmentEls.current.set(key, el)
    } else {
      segmentEls.current.delete(key)
    }
  }

  const renderPlaced = ({ entry, key }: PlacedSegment, disclosure?: ConversationProcessProps['disclosure'], submissionDisclosure?: SubmissionDisclosure): JSX.Element => {
  // Identity is resolved once here; the shared message only renders that verdict.
  const speaker = entry.record.speaker ?? speakerOf(entry.item)
  const described = speaker ? describeSpeaker?.(speaker) : undefined
  return (
    // One wrapper per segment carries the scroll target, the observer key, and the selection
    // marker, so the three log registers below stay unaware of the ruler wiring.
    <div
      key={key}
      className="activity-log__segment"
      {...(entry.kind === 'item' && entry.record?.role === 'process' ? { 'data-conversation-process-source-key': conversationMessageSourceKey(sessionId, entry.record.source), 'data-message-source-key': conversationMessageSourceKey(sessionId, entry.record.source) } : {})}
      ref={registerSegment(key)}
    >
      {entry.record?.role !== 'process' && entry.record?.role !== 'interaction' && speaker ? (
        <CapturedConversationMessage
          active={readingEnabled}
          item={entry.item}
          {...(submissionDisclosure ? { submissionDisclosure } : {})}
          {...(entry.record ? { record: entry.record } : {})}
          {...(entry.record?.role === 'observation' ? { replyObservation: { compact: true } } : {})}
          messageActions={<>{entry.record && conversationItemRef(entry.record) && renderRecordActions?.(conversationItemRef(entry.record)!, readingEnabled, executionHostId)}{entry.item.kind === 'assistant_message' && entry.item.agentSessionId === sessionId &&
            !entry.item.authorAgentSessionId && entry.item.authorHuman !== true && entry.item.authorExternal === undefined && entry.item.source !== 'user'
            ? renderMessageActions?.({ kind: 'captured', agentSessionId: sessionId, recordId: entry.item.id }) : null}</>}
          conversationSessionId={sessionId}
          {...(executionHostId ? { executionHostId } : {})}
          {...(entry.item.kind === 'user_message' ? { publicContent: entry.item.publicContent ?? 'unknown' } : {})}
          {...(entry.item.kind === 'user_message' || speaker.role === 'system' || entry.item.sourceDevice || entry.item.sourceChannel ? { inputSource: { kind: 'captured' as const, submissionId: entry.item.id, ...(entry.item.sourceChannel ? { channel: entry.item.sourceChannel } : {}), ...(entry.item.sourceDevice ? { device: entry.item.sourceDevice } : {}) } } : {})}
          located={locatedMessageKey === conversationMessageSourceKey(sessionId, { kind: 'captured', recordId: entry.item.id })}
          locatedSourceKey={locatedMessageKey}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          {...(speaker.role === 'system' ? { recordTitle: entry.item.title } : {})}
          origin={origin}
          speaker={speaker}
          workspaceRoot={workspaceRoot}
          homeDir={homeDir}
          {...(described ?? {})}
          {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
          {...(readPastedImage ? { readPastedImage: readEntryImage } : {})}
          {...(openHttpLink ? { openHttpLink } : {})}
          {...(onContinue ? { onContinue: () => onContinue(buildContinuationPrompt(unifiedItems, entry.item)) } : {})}
          {...(onSelectAnnotation ? { onSelectAnnotation } : {})}
        />
      ) : (
        <CapturedProcessRecord record={entry.record} origin={origin} workspaceRoot={workspaceRoot}
          located={locatedMessageKey === conversationMessageSourceKey(sessionId, entry.record.source)}
          {...(disclosure ? { disclosure } : {})} />
      )}
    </div>
  )
  }

  return renderSurface(findTrigger => (
    <div className="activity-feed" data-workbench-reading-scroll onKeyDown={handleReadingKey} data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}
        onWheel={handleReadingWheel}>
      {readNotice}
      {fileReferenceNotice}
      {capability === 'unavailable' ? (
        <div className="activity-feed__empty" role="status">
          This executor does not provide structured activity. Terminal remains available.
        </div>
      ) : null}
      {renderReadingHeader(<>{collapseTraces}{findTrigger}{renderReadingTools?.(readingEnabled, revealLoadedRecord)}</>, rulerRecords.length > 0 ? <ConversationReadingRuler
        feedEl={feedEl} sessionId={sessionId} readingEnabled={readingEnabled} rulerRecords={rulerRecords} placed={placed}
        visibleShells={visibleShells} rulerWindow={rulerWindow} onWindow={setRulerWindow} selectedRecordId={selectedRecordId}
        selectRulerRecord={selectRulerRecord} hasMore={conversationReading ? readingWindow.hasMore : undefined}
        pending={readPending && !earlierReadPending} activity={activity.segments} describeSpeaker={describeSpeaker}
        tools={<>{collapseTraces}{findTrigger}{renderReadingTools?.(readingEnabled, revealLoadedRecord)}</>} /> : undefined)}
      <div ref={logRef}>
      <ConversationView
        readingGeometry={{ viewport: () => feedEl, content: () => logRef.current,
          following: () => !readingWindow.historical && followRef.current.following, pinToBottom,
          captureAnchor: () => { if (feedEl) anchorRef.current = captureReadingAnchor(feedEl) },
          restoreAnchor: () => { if (feedEl && anchorRef.current) { restoreReadingPosition(feedEl, anchorRef.current); markProgrammaticReadingScroll(feedEl) } },
          onLayout: syncTailAfterLayout }}
        presentation={{ controller: presentation, pending: readingWindow.held, onRelease: readingWindow.showLatestAutomatically,
          watchSelection: readingWindow.newerOutside && !readingWindow.historical && followRef.current.following,
          intent: readingWindow.presentationIntent }}
        page={nativeHistoryPage}
        readActivity={readingWindow.readActivity}
        expandSubmissions={Boolean(readingWindow.error || readingWindow.automaticReadError)}
        records={conversationRecords}
        originalRecords={originalConversationRecords}
        coverage={conversationCoverage}
        onLocateRecord={revealLoadedRecord}
        renderCapturedRecord={(record, disclosure, submissionDisclosure) => {
          const segment = placedByRecord.get(record.id) ?? (record.original.kind === 'captured' ? { entry: { kind: 'item' as const, item: record.original.item, record }, key: JSON.stringify(['item', record.rawId]), from: 0, to: 0 } : undefined)
          return segment ? renderPlaced(segment, disclosure, submissionDisclosure) : null
        }}
        insertions={[{ key: 'native-reading-tail', role: 'anchor', ...(nativeTailBeforeRecordId ? { beforeRecordId: nativeTailBeforeRecordId } : {}), content: <div ref={nativeTailRef} data-conversation-native-tail aria-hidden="true" /> }]}
        traceDisclosure={traceDisclosure}
        questionAnswerContext={questionAnswerContext}
        {...(historyBoundary && boundaryIndex > 0 ? {
          recordBoundary: { ...historyBoundary, content: <div className="activity-feed__history-divider" role="separator">
            以上是历史消息（{boundaryTime === undefined ? '时间未记录' : new Date(boundaryTime).toLocaleString()}）
          </div> }
        } : {})}
        renderQuestionNotice={renderConversationQuestionNotice}
        {...(questionDraftNotice ? { questionDraftNotice } : {})}
        {...(questionReplyRoute ? { questionReplyRoute } : {})}
        {...(questionReplyTarget ? { questionReplyTarget } : {})}
        {...(questionReplyContext ? { questionReplyContext } : {})}
        {...(onOpenQuestionTerminal ? { onOpenQuestionTerminal } : {})}
        {...(questionReplyState ? { questionReplyState } : {})}
        {...(questionReplyDraft ? { questionReplyDraft } : {})}
        {...(onQuestionReply ? { onQuestionReply } : {})}
        {...(onQuestionDraftChange ? { onQuestionDraftChange } : {})}
        active={readingEnabled}
        {...(renderRecordActions ? { renderRecordActions } : {})}
        {...(renderMessageActions ? { renderMessageActions } : {})}
        renderProcess={(props) => <NativeProcessObservation {...props} compact={true} />}
        sessionId={sessionId}
        {...(executionHostId ? { executionHostId } : {})}
        locatedMessageKey={locatedMessageKey}
        {...(onContinue ? { onContinue } : {})}
        workspaceRoot={workspaceRoot}
        homeDir={homeDir}
        {...(describeSpeaker ? { describeSpeaker } : {})}
        {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
        {...(readPastedImage ? { readPastedImage } : {})}
        {...(readHistoryResource ? { readHistoryResource } : {})}
        {...(openHttpLink ? { openHttpLink } : {})}
        {...(onSelectAnnotation ? { onSelectAnnotation } : {})}
      />
      </div>
      <div ref={readingTailRef} data-conversation-reading-tail aria-hidden="true" />
      {!readingWindow.historical && showWorkingIndicator(displayState, items) ? <WorkingIndicator active={activitySemantic === 'active'} /> : null}
      <div ref={readingSpaceRef} data-conversation-reading-space aria-hidden="true" />
    </div>
  ))
}
