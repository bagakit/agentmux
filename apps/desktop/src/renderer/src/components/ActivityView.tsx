import { ConversationSourceLabels } from '@agentmux/client-ui/components/ConversationSourceLabels'
import type { ConversationSources } from '@agentmux/client-ui/conversation-sources'
import { conversationItemRef } from '@agentmux/core/conversation'
import { ConversationCoverage } from '@agentmux/client-ui/components/ConversationCoverage'
import { canReplaceCapturedWindow } from '@agentmux/client-ui/captured-conversation-page'
import { type AgentConversationRecord, type ConversationItemRef } from '@agentmux/core/conversation'
import { projectConversationWindow, type ConversationRecord } from '@agentmux/client-ui/conversation-records'
import { consumeProgrammaticReadingScroll, markProgrammaticReadingScroll } from '@agentmux/client-ui/reading-scroll'
import { CapturedConversationMessage, type SubmissionDisclosure } from '@agentmux/client-ui/components/CapturedConversationMessage'
import { ConversationToolPayload } from '@agentmux/client-ui/components/ConversationToolPayload'
import { ReadingFind } from '@agentmux/client-ui/components/ReadingFind'
import { useConversationTraceDisclosure } from '@agentmux/client-ui/conversation-trace-disclosure'
import type { ConversationReplySource } from '@agentmux/core/prompt-reaction'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode, type ComponentProps, type KeyboardEvent, type WheelEvent } from 'react'
import type { AgentDisplayState, AgentSessionHistoryPage, AgentSessionUserMessage, AgentTimelineSnapshot } from '@agentmux/core'
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
import {
  MAX_DIFF_LINES,
  parseUnifiedDiff,
  toolCallToDiff,
  type ToolDiff
} from '../lib/activity-diff'
import { createRulerScale, describeReadout, describeRulerAxis, describeSpan, describeActivityRecordTime, rulerBand, stepRulerSelection, type RulerReadoutText, type RulerScale } from '../lib/activity-ruler'
import { formatClock } from '@agentmux/client-ui/conversation-time'
import { stepTitle } from '@agentmux/client-ui/activity-step-summary'
import { showEmptyState, showWorkingIndicator } from '../lib/activity-working-state'
import { speaksAsAgent, type ConversationAxisItem, type ConversationAxisMark } from '../lib/conversation-axis'
import { buildContinuationPrompt } from '../lib/session-continuation'
import { isConversationTurn, speakerOf } from '../lib/conversation-speaker'
import { speakerOfUserMessage } from '@agentmux/client-ui/conversation-speaker'
import { conversationQuote } from '../lib/conversation-quote'
import { terminalLinkPreviewAnchor } from '../lib/terminal-link-gesture'
import { type LinkClickModifiers, type OpenWorkspaceFile } from '@agentmux/client-ui/components/AgentMarkdown'
import type { ReadPastedImage } from '@agentmux/client-ui/components/ConversationImage'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { ConversationReadFailure, type ConversationReadIssue } from './ConversationReadFailure'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { useWorkbenchDocumentVisibility } from '../lib/workbench-window-registry'
import { Ruler } from './ConversationRuler'
export { Ruler } from './ConversationRuler'
import { ConversationRulerControls } from './ConversationRulerControls'
import { RULER_WINDOWS, conversationRulerRecords, conversationRulerWindow, type RulerRecord, type RulerWindow } from '../lib/conversation-ruler'
import { projectAgentActivityHistory } from '@agentmux/core/timeline'
import { ConversationAxis, type DescribeSpeaker } from './ConversationAxis'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import type { ConversationProcessProps } from '@agentmux/client-ui/components/ConversationRecordSequence'
import { renderConversationQuestionNotice } from './ConversationQuestionNotice'
import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { SemanticIcon } from './semantic-icons'
import { RecordedToolRow as WorkflowToolRow } from '@agentmux/client-ui/components/WorkflowObservation'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { conversationReadingAnchor, protectsConversationWindow, restoreConversationAnchor, useSessionConversationWindow, type ConversationReading } from '../lib/session-conversation-window'
import type { ConversationRevealRequest, RevealConversationItem } from '../lib/mailbox-message-navigation'
import { registerConversationConsumer, conversationFrameObservation, conversationRenderedObservation, conversationInspectionError } from '../lib/conversation-consumer-observation'
import { workbenchDocumentIdentity } from '../lib/workbench-window-registry'
import type { ConversationConsumerQuery } from '@agentmux/core/control'
import type { ConversationConsumerSample } from '../../../shared/conversation-consumer-observation'

const ThemeFileTextIcon = semanticIconComponent('file.text')
const ThemeActionEditIcon = semanticIconComponent('action.edit')
const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeNavigationUpIcon = semanticIconComponent('navigation.up')
const ThemeActionCurrentIcon = semanticIconComponent('action.current')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeLayoutCollapseAllIcon = semanticIconComponent('layout.collapse-all')


/**
 * 机器上报那一路的图标：按 `kind` 画，而这是对的——`tool_call` 是一把锤子、`permission` 是一枚盾，
 * 回答的是「这是一条什么事件」。**对话回合不走这里**：那一路的形状由身份驱动（见 {@link ConversationMessage}），
 * 因为「谁说的」不是一种事件类型。两个寄存器各有各的判据，不是同一个判据的两次调用。
 */
function Glyph({ kind, toolName, size = 12 }: { kind: AgentTimelineItem['kind']; toolName?: string; size?: number }) {
  if (kind === 'user_message') return <SemanticIcon name="conversation.user-message" size={size} />
  if (kind === 'assistant_message') return <SemanticIcon name="conversation.assistant-message" size={size} />
  if (kind === 'tool_call') {
    const name = toolName?.toLowerCase()
    if (name === 'bash' || name === 'shell' || name === 'exec_command' || name === 'run_command') return <SemanticIcon name="object.terminal" size={size} />
    if (name === 'read' || name === 'read_file') return <ThemeFileTextIcon size={size} />
    if (name === 'edit' || name === 'write' || name === 'write_file' || name === 'apply_patch') return <ThemeActionEditIcon size={size} />
    if (name === 'grep' || name === 'glob' || name === 'search') return <ThemeActionSearchIcon size={size} />
    return <SemanticIcon name="conversation.tool-call" size={size} />
  }
  if (kind === 'permission') return <SemanticIcon name="status.permission" size={size} />
  return <SemanticIcon name="status.neutral" size={size} />
}

/**
 * A run of consecutive machine-reported steps between two turns the user can read. Collapsing the run
 * is the second level of folding: level one expands one step's payload, level two hides the whole
 * stretch of lifecycle noise that sits between a prompt and its answer.
 */
type Segment = (
  | { kind: 'item'; item: AgentTimelineItem; record?: ConversationRecord }
  | { kind: 'user-message'; message: AgentSessionUserMessage }) & { beforeRecordId?: string }

/** Positions only adapt the already ordered Core events to retained source renderers. */
function buildActivityEntries(projection: ReturnType<typeof projectConversationWindow> | null) {
  const records = projection?.records ?? [], segments: Segment[] = [], unifiedItems: ConversationAxisItem[] = []
  let beforeRecordId: string | undefined
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!
    if (record.original.kind === 'native') { beforeRecordId = record.rawId; continue }
    const item = record.original.item
    unifiedItems.push(item); segments.push({ kind: 'item', item, record, ...(beforeRecordId === undefined ? {} : { beforeRecordId }) })
  }
  segments.reverse(); unifiedItems.reverse()
  return { records, originalRecords: projection?.originalRecords ?? [], coverage: projection?.timeline.coverage ?? [], unifiedItems, segments }
}

function Row({
  item,
  sources,
  origin,
  showSource,
  workspaceRoot,
  expanded,
  onExpandedChange
}: {
  item: AgentTimelineItem
  sources?: ConversationSources | undefined
  origin: number
  showSource: boolean
  /** 用来把仓内绝对路径缩成相对路径，见 activity-step-summary 的 shortenPath。缺席则原样显示。 */
  workspaceRoot: string
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [localOpen, setOpen] = useState(false)
  const open = expanded ?? localOpen
  const sourceIdentity = useMemo(() => ({}), [item])
  const payloadIdentity = useMemo(() => ({}), [sourceIdentity, item.toolInput, item.content])
  const outputIdentity = useMemo(() => ({}), [sourceIdentity, item.toolOutput])
  // What the agent said is the content of the trace; what a tool was invoked with is its payload.
  // Prose stays on the page, machine arguments fold away — that is the noise the run view is hiding.
  const prose = item.kind === 'tool_call' ? undefined : item.content
  const payload = item.toolInput ?? (item.kind === 'tool_call' ? item.content : undefined)
  // 结果和入参一样值得展开——而且比入参更值得：一步跑失败了，用户第一件想看的是它说了什么。
  // 只有入参能展开的话，失败行点开只有参数，等于把唯一有用的信息挡在外面。
  const output = item.toolOutput
  const expandable = Boolean(payload) || Boolean(output)
  // 一次编辑的实质是"哪几行没了、哪几行来了"，而不是一段转义 JSON——把 old/new 摊成加删行，
  // 用户就不必在脑子里反转义再做行对比。算不出 diff 时（工具不是编辑类、JSON 坏了）如实退回
  // 原始 payload，不猜、不半渲染。
  const diff = useMemo(() => {
    if (!open || !payload) return null
    const fromTool = item.toolInput ? toolCallToDiff(item.title, item.toolInput) : null
    return fromTool ?? parseUnifiedDiff(payload)
  }, [open, payload, item.toolInput, item.title])
  // 折叠起来的一行只有裸工具名时，三行 `Bash` 分不出跑的是哪条命令——而不展开就认得出，
  // 正是折叠的前提。带上那个最具识别性的参数。
  const heading = stepTitle(item.title, item.toolName, item.toolInput, workspaceRoot)
  const recordedTime = describeActivityRecordTime(item.createdAt, item.createdAt, origin)

  return (
    <Fragment>
      <WorkflowToolRow observation={{
        id: item.id,
        title: heading,
        status: item.status,
        recordedTime,
        source: sources ? <ConversationSourceLabels sources={sources.fields[item.toolInput !== undefined ? 'toolInput' : 'content'] ?? sources.main} /> : item.source,
        persistentSource: showSource
      }} className={`log-row log-row--${item.kind}`} icon={<Glyph kind={item.kind} {...(item.toolName ? { toolName: item.toolName } : {})} />}
        {...(expandable ? { expanded: open, onToggle: () => { setOpen(!open); onExpandedChange?.(!open) } } : {})} />
      {prose ? <p className="log-row__prose">{prose}</p> : null}
      {open ? <div className="wf-native-process__body">
        {diff ? <DiffBlock diff={diff} /> : null}
        {payload ? diff ? <details><summary>Original tool input</summary><div className="conversation-tool-trace__payload">
          <ConversationSourceLabels sources={sources?.fields[item.toolInput !== undefined ? 'toolInput' : 'content']} /><ConversationToolPayload text={payload} identity={payloadIdentity} sourceIdentity={sourceIdentity} copyLabel="Copy tool input" />
        </div></details> : <div className="conversation-tool-trace__payload">
          <ConversationSourceLabels sources={sources?.fields[item.toolInput !== undefined ? 'toolInput' : 'content']} /><ConversationToolPayload text={payload} identity={payloadIdentity} sourceIdentity={sourceIdentity} copyLabel="Copy tool input" />
        </div> : null}
        {output ? <div className="conversation-tool-trace__payload" data-status={item.status}>
          <ConversationSourceLabels sources={sources?.fields.toolOutput} /><ConversationToolPayload text={output} identity={outputIdentity} sourceIdentity={sourceIdentity} copyLabel="Copy tool output" />
        </div> : null}
      </div> : null}
    </Fragment>
  )
}

/**
 * 一次编辑摊成加删行。
 *
 * 颜色不是唯一的载体：每行前面留一个 `+`/`-`/空槽，色觉差异或高对比模式下仍读得出增删。
 * 长 diff 由 lib 截断并给出 `truncated`，这里如实说明被截了——静默截断会让用户以为自己看到了全部。
 */
export function DiffBlock({ diff }: { diff: ToolDiff }): JSX.Element {
  return (
    <div className="log-diff">
      {diff.filePath ? <div className="log-diff__path">{diff.filePath}</div> : null}
      <pre className="log-diff__body">
        {diff.lines.map((line, index) => (
          <span key={index} className={`log-diff__line log-diff__line--${line.kind}`}>
            <span className="log-diff__marker" aria-hidden="true">
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
            </span>
            {line.text}
          </span>
        ))}
      </pre>
      {diff.truncated ? (
        <div className="log-diff__truncated">Diff truncated at {MAX_DIFF_LINES} lines.</div>
      ) : null}
    </div>
  )
}

/** A segment paired with the half-open range of event indices it covers, so a position on the ruler
 *  can find the row that hosts that event and the band can read which events are on screen. */
type PlacedSegment = { entry: Segment; key: string; from: number; to: number }

function placeSegments(segments: Segment[]): PlacedSegment[] {
  const placed: PlacedSegment[] = []
  let index = 0
  for (const entry of segments) {
    const size = 1
    const identity = entry.kind === 'user-message' ? entry.message.id : entry.item.id
    const key = JSON.stringify([entry.kind, identity])
    placed.push({ entry, key, from: index, to: index + size - 1 })
    index += size
  }
  return placed
}

type SegmentLayout = { key: string; kind: Segment['kind']; id: string; ids: string[]; beforeRecordId?: string }
function segmentLayout({ entry, key }: PlacedSegment): SegmentLayout {
  return { key, kind: entry.kind,
    id: entry.kind === 'item' ? entry.item.id : entry.message.id,
    ids: [entry.kind === 'item' ? entry.item.id : entry.message.id],
    ...(entry.beforeRecordId === undefined ? {} : { beforeRecordId: entry.beforeRecordId }) }
}
/** Reuse committed grouping/placement choices, resolving bodies from current source records. */
function retainSegmentLayout(layout: readonly SegmentLayout[], current: readonly Segment[]): Segment[] {
  const timeline = new Map(current.flatMap(entry => entry.kind === 'item' ? [[entry.item.id, entry] as const] : []))
  const messages = new Map(current.flatMap(entry => entry.kind === 'user-message' ? [[entry.message.id, entry.message] as const] : []))
  return layout.flatMap((entry): Segment[] => {
    const position = entry.beforeRecordId === undefined ? {} : { beforeRecordId: entry.beforeRecordId }
    if (entry.kind === 'item') { const item = timeline.get(entry.id); return item ? [{ ...item, ...position }] : [] }
    const message = messages.get(entry.id)
    return message ? [{ kind: 'user-message', message, ...position }] : []
  })
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

type UserMessageReadState = {
  loading: boolean
  error: Error | null
  observationError?: Error | null
  windowFrozen?: boolean
  windowIncomplete?: boolean
  hasMore: boolean
  onRetry: () => void
  onReadEarlier: (trigger: HTMLButtonElement) => void
}

function UserMessageReadNotice({ read, showEarlier = true }: { read: UserMessageReadState | undefined; showEarlier?: boolean }) {
  if (!read) return null
  const needsService = Boolean(read.error || read.observationError || read.windowFrozen)
  if (!needsService && (!showEarlier || !read.windowIncomplete && !read.hasMore)) return null
  return (
    <div className="activity-feed__read-notice" role="status">
      <span>
        {read.error
          ? `Native input read failed: ${read.error.message}. Existing messages are kept.`
          : read.windowFrozen ? 'Native source changed. The current reading window is kept. Read latest records to open a new window.'
          : read.observationError ? `Automatic native updates are unavailable: ${read.observationError.message}. The current reading window is kept; Refresh retries the source.`
          : read.windowIncomplete ? 'This window keeps recent conversation and process records. Read earlier to browse the original sequence.'
          : 'Earlier conversation records are available.'}
      </span>
      {read.error ? <button type="button" className="small-button" disabled={read.loading} onClick={read.onRetry}>Retry</button> : null}
      {!read.error && (read.windowFrozen || read.observationError) ? <button type="button" className="small-button" disabled={read.loading} onClick={read.onRetry}>{read.windowFrozen ? 'Read latest records' : 'Refresh'}</button> : null}
      {showEarlier && (read.hasMore || read.windowIncomplete) ? <button type="button" className="small-button" onClick={(event) => read.onReadEarlier(event.currentTarget)}>Read earlier records</button> : null}
    </div>
  )
}

export function ActivityView({
  sessionId,
  executionHostId,
  items: observedItems,
  timelineSnapshot,
  userMessages,
  nativeHistoryPage: recentNativePage,
  nativeContextItems,
  conversationReading,
  readingNotice,
  readingAction,
  userMessageRead,
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
  describeSpeaker,
  moteConversation = false,
  questionReplyRoute, questionReplyTarget, questionReplyContext, questionDraftNotice, onOpenQuestionTerminal, questionReplyState, questionReplyDraft, onQuestionDraftChange, onQuestionReply,
  renderMessageActions, renderRecordActions, renderReadingTools
}: {
  sessionId: string
  executionHostId?: string
  items: AgentTimelineItem[]
  timelineSnapshot?: AgentTimelineSnapshot
  userMessages?: readonly AgentSessionUserMessage[]
  nativeHistoryPage?: AgentSessionHistoryPage | null
  nativeContextItems?: AgentSessionHistoryPage['items']
  conversationReading?: ConversationReading
  readingNotice?: ReactNode
  readingAction?: ReactNode
  userMessageRead?: UserMessageReadState
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
   * 把一个说话人身份解析成「叫什么、画哪个 provider 的图标」。由持有 Session 的那一层给出——
   * 本组件不读 Store，所以 `providerId` 与显示名只能从外面进来。缺省时两条对话轴不渲染：轴的
   * 价值在于认出身份，没有名字的头像认不出谁，画出来只是一排装饰。
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
  const anchorRef = useRef<ReturnType<typeof conversationReadingAnchor>>(null)
  const followRef = useRef(initFollowState())
  const [showJump, setShowJump] = useState(false)
  // Position is presentation only; a layout move must not grant follow/read intent.
  const [atLoadedTail, setAtLoadedTail] = useState(true)
  const returnRef = useRef<HTMLButtonElement>(null)
  const earlierRef = useRef<HTMLDivElement>(null)
  const nativeTailRef = useRef<HTMLDivElement>(null)
  const readingTailRef = useRef<HTMLDivElement>(null)
  const readingSpaceRef = useRef<HTMLDivElement>(null)
  const earlierSpaceAllowed = useRef(false)
  const earlierCommitPending = useRef(false)
  const physicalScrollRef = useRef<ScrollGeometry | null>(null)
  const edgeRef = useRef({ earlier: false, newer: false })
  const [rulerWindow, setRulerWindow] = useState<RulerWindow>('24h')
  const readingWindow = useSessionConversationWindow(conversationReading, (page, intent, currentOriginal, projection) => {
    if (intent === 'earlier' || intent === 'newer') followRef.current = { ...followRef.current, following: false }
    const keepAnchor = intent === 'earlier' || intent === 'newer' || (intent !== 'current' && !followRef.current.following)
    if (protectsConversationWindow(feedEl, page, keepAnchor, currentOriginal, projection, userMessages)) return false
    anchorRef.current = keepAnchor && feedEl ? captureReadingAnchor(feedEl) : null
    if (intent === 'earlier') earlierCommitPending.current = true
    if (!keepAnchor) clearEarlierSpace()
    if (intent === 'current') {
      followRef.current = { ...followRef.current, following: true }
      edgeRef.current.earlier = false; edgeRef.current.newer = false
    }
    return true
  }, RULER_WINDOWS[rulerWindow], (snapshot, displayed) => {
    if (!feedEl) return true
    if (!canReplaceCapturedWindow(feedEl, snapshot, !followRef.current.following, displayed)) return false
    anchorRef.current = captureReadingAnchor(feedEl)
    return true
  })
  function readEarlierRecords(): void {
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
    edgeRef.current = { earlier: false, newer: false }
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
  useEffect(() => {
    edgeRef.current.earlier = false; edgeRef.current.newer = false
  }, [nativeHistoryPage?.nextCursor, readingWindow.error])
  const questionAnswerContext = useMemo(() => recentNativePage
    ? { ...recentNativePage, items: nativeContextItems ?? recentNativePage.items } : null,
    [recentNativePage, nativeContextItems])
  const historyBoundary = readingWindow.historyBoundary
  const boundaryIndex = !historyBoundary || !nativeHistoryPage ? -1 : nativeHistoryPage.items.findIndex(item => item.id === historyBoundary.beforeRecordId)
  const lastEarlierRecord = nativeHistoryPage?.items[boundaryIndex - 1]
  const boundaryTime = lastEarlierRecord?.completedAt ?? lastEarlierRecord?.startedAt
  const items = readingWindow.captured ?? []
  const readingEnabled = conversationReading?.enabled !== false
  const documentVisible = useWorkbenchDocumentVisibility(useWorkbenchDocument())
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
  useLayoutEffect(() => {
    if (!readingEnabled || !feedEl) return
    const content = logRef.current
    if (!content) return
    let active = true
    const observer = new ResizeObserver(() => {
      if (!active) return
      if (conversationReading?.enabled && (readingWindow.historical || !followRef.current.following) && anchorRef.current) {
        restoreReadingPosition(feedEl, anchorRef.current); markProgrammaticReadingScroll(feedEl)
      }
      syncTailPosition()
    })
    observer.observe(content)
    observer.observe(feedEl)
    return () => { active = false; observer.disconnect() }
  }, [feedEl, conversationReading?.enabled, readingWindow.historical, readingEnabled])
  useEffect(() => {
    if (!conversationReading?.enabled || !conversationReading.opened || !conversationReading.onClose) return
    returnRef.current?.focus({ preventScroll: true })
  }, [conversationReading?.opened, conversationReading?.identity])
  const { records: conversationRecords, originalRecords: originalConversationRecords, coverage: conversationCoverage, unifiedItems, segments } = useMemo(
    () => buildActivityEntries(readingWindow.projection), [readingWindow.projection])

  const proposedSegments = useMemo(() => placeSegments(segments), [segments])
  const proposedLayout = proposedSegments.map(segmentLayout)
  const layoutSource = JSON.stringify([sessionId, nativeHistoryPage?.source])
  const committedLayout = useRef<{ source: string; entries: SegmentLayout[] }>({ source: layoutSource, entries: [] })
  const segmentEls = useRef(new Map<string, HTMLElement>())
  const [, selectionChanged] = useState(0)
  const selection = feedEl?.ownerDocument.defaultView?.getSelection()
  const incomingLayout = new Map(proposedLayout.map(entry => [entry.key, entry]))
  const holdCapturedLayout = committedLayout.current.source === layoutSource && Boolean(selection && !selection.isCollapsed && selection.rangeCount && committedLayout.current.entries.some(entry => {
    if (JSON.stringify(entry) === JSON.stringify(incomingLayout.get(entry.key))) return false
    const node = segmentEls.current.get(entry.key)
    if (!node) return false
    try { return selection.getRangeAt(0).intersectsNode(node) } catch { return true }
  }))
  const placed = holdCapturedLayout ? placeSegments(retainSegmentLayout(committedLayout.current.entries, segments)) : proposedSegments
  useLayoutEffect(() => { committedLayout.current = { source: layoutSource, entries: placed.map(segmentLayout) } })
  useEffect(() => {
    if (!holdCapturedLayout || !feedEl) return
    const update = () => selectionChanged(value => value + 1)
    feedEl.ownerDocument.addEventListener('selectionchange', update)
    return () => feedEl.ownerDocument.removeEventListener('selectionchange', update)
  }, [holdCapturedLayout, feedEl])
  function captureReadingAnchor(viewport: HTMLElement, target?: EventTarget | null): ReturnType<typeof conversationReadingAnchor> {
    const selection = viewport.ownerDocument.defaultView?.getSelection()
    const node = target instanceof Node ? target : selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0).startContainer : null
    const element = node instanceof Element ? node : node?.parentElement
    const segment = element?.closest<HTMLElement>('[data-segment-key]')
    if (segment && viewport.contains(segment)) return { kind: 'segment', id: segment.dataset.segmentKey!, offset: segment.getBoundingClientRect().top - viewport.getBoundingClientRect().top }
    return conversationReadingAnchor(viewport)
  }
  const readEntryImage = useCallback<ReadPastedImage>(path => readingEnabled && readPastedImage
    ? readPastedImage(path) : Promise.resolve(null), [readingEnabled, readPastedImage])
  const origin = useMemo(() => {
    for (const it of unifiedItems) {
      const t = 'createdAt' in it ? it.createdAt : it.recordedAt
      if (t !== undefined) return t
    }
    return 0
  }, [unifiedItems])
  const rulerRecords = useMemo(() => conversationRulerRecords(sessionId, nativeHistoryPage, unifiedItems, conversationRecords),
    [sessionId, nativeHistoryPage, unifiedItems])
  const [visible, setVisible] = useState<Set<string>>(new Set())
  const ruler = useMemo(() => conversationRulerWindow(rulerRecords, rulerWindow, visible), [rulerRecords, rulerWindow, visible])
  const activity = useMemo(() => projectAgentActivityHistory(items), [items])
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const selectedRecord = rulerRecords.find(record => record.id === selectedRecordId)
  const selectedIndex = selectedRecord?.target.kind === 'observed' ? selectedRecord.target.index : null
  const rulerSelectedIndex = ruler.items.findIndex(record => record.id === selectedRecordId)
  const scale = ruler.scale
  const band = useMemo(() => {
    const indices = ruler.items.flatMap((record, index) => visible.has(record.id) ? [index] : [])
    return rulerBand(scale, indices.length ? { from: Math.min(...indices), to: Math.max(...indices) } : null)
  }, [ruler.items, scale, visible])

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
    anchorRef.current = null
    pinToBottom()
    const geometry = feedGeometry()
    if (geometry) followRef.current = onScroll(followRef.current, geometry)
    followRef.current = { ...followRef.current, following: true }
    syncTailPosition()
    setShowJump(shouldShowJumpToLatest(followRef.current))
  }

  const returnToLatest = (): void => {
    if (readingWindow.historical || readingWindow.newerOutside || readingWindow.held) {
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
      const nativeAnchor = conversationReadingAnchor(el, undefined, true)
      // Captured content has its own readable tail. Hand paging back only when
      // the original sequence is actually visible in this viewport.
      if (!nativeAnchor) return
      anchorRef.current = nativeAnchor
    }
    if (readingWindow.loading && !readingWindow.coverageLoading) return
    const edges = edgeRef.current
    const distance = Math.max(80, el.clientHeight * 2)
    const nextTop = Math.max(0, el.scrollTop + delta)
    const boundary = earlierRef.current
    const boundaryTop = boundary ? el.scrollTop + boundary.getBoundingClientRect().bottom - el.getBoundingClientRect().top : 0
    const earlier = nextTop <= boundaryTop + distance
    const tailTop = (nativeReadingTail(el) ?? el.scrollHeight) - el.scrollTop
    const newer = tailTop >= 0 && (nativeReadingTail(el) ?? el.scrollHeight) - el.clientHeight - nextTop <= distance
    if (!earlier) edges.earlier = false
    if (!newer) edges.newer = false
    if (direction < 0 && earlier && !edges.earlier && (readingWindow.hasMore || readingWindow.capturedHasMore)) {
      edges.earlier = true; readEarlierRecords()
    } else if (direction > 0 && newer && anchorRef.current?.kind !== 'segment' && !edges.newer && readingWindow.hasNewer) {
      edges.newer = true; readingWindow.readNewer()
    }
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
    syncTailPosition()
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
    document.addEventListener('selectionchange', attempt)
    return () => document.removeEventListener('selectionchange', attempt)
  }, [conversationReading?.enabled, readingWindow.newerOutside, readingWindow.historical,
    readingWindow.loading, readingWindow.error, recentNativePage, showJump, feedEl])

  // This same exact rendered-record owner also serves closed Sessions with no Run.
  function locateLoadedRecord(sourceKey: string, isCurrent: () => boolean): boolean {
    if (!readingEnabled || !feedEl?.isConnected || !isCurrent()) return false
    const matches = Array.from(feedEl.querySelectorAll<HTMLElement>('.log-turn[data-message-source-key], .conversation-reply-observation[data-message-source-key], .conversation-original-record[data-message-source-key], [data-conversation-process-source-key]'))
      .filter(node => node.dataset.messageSourceKey === sourceKey && (node.matches('.conversation-reply-observation') || !node.closest('.conversation-reply-observation')))
    const owners = matches.filter(node => !matches.some(parent => parent !== node && parent.contains(node)))
    if (owners.length !== 1) return false
    const node = owners[0]!, head = node.matches('.conversation-reply-observation')
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
    if (!readingEnabled || !revealRequest || !feedEl) return
    setLocatedMessageKey(revealRequest.sourceKey)
    const frame = requestAnimationFrame(() => {
      if (!revealRequest.isCurrent() || !feedEl.isConnected) { revealRequest.complete(false); return }
      revealRequest.complete(locateLoadedRecord(revealRequest.sourceKey, revealRequest.isCurrent))
    })
    return () => cancelAnimationFrame(frame)
  }, [revealRequest, feedEl, unifiedItems, nativeHistoryPage, readingEnabled])

  // Segment elements keyed by segment key, so a resolved event index can find its host row and the
  // observer can watch each one.

  const segmentForIndex = (index: number): PlacedSegment | undefined =>
    placed.find((entry) => index >= entry.from && index <= entry.to)

  const selectEvent = (index: number): void => {
    setSelectedRecordId(rulerRecords.find(record => record.target.kind === 'observed' && record.target.index === index)?.id ?? null)
    const host = segmentForIndex(index)
    const el = host ? segmentEls.current.get(host.key) : undefined
    // Reuse the same scroll primitive the rest of the app uses to bring a row into view; there is no
    // second scroll controller for the Activity log.
    el?.scrollIntoView({ block: 'nearest' })
    if (feedEl) {
      anchorRef.current = captureReadingAnchor(feedEl, el)
      markProgrammaticReadingScroll(feedEl, 'navigation')
    }
  }

  // Retain confirmed DOM visibility through observation handoff, never message bodies.
  const visibleShells = useRef<{ feed: HTMLDivElement; sessionId: string; shells: Set<Element> } | null>(null)
  // Register committed shells once. Disclosure registers only added descendants, never a scroll-frame scan.
  useEffect(() => {
    if (!readingEnabled || !feedEl) return
    const expected = new Map<string, string[]>()
    const segmentsByIndex = new Map<number, string>()
    for (const segment of placed) for (let index = segment.from; index <= segment.to; index++) segmentsByIndex.set(index, segment.key)
    for (const record of rulerRecords) {
      const target = record.target
      const key = target.kind === 'native' ? JSON.stringify([target.source, target.recordId]) : segmentsByIndex.get(target.index)
      if (key) { const ids = expected.get(key) ?? []; ids.push(record.id); expected.set(key, ids) }
    }
    const mapping = new Map<Element, readonly string[]>()
    const previous = visibleShells.current
    const onscreen = previous?.feed === feedEl && previous.sessionId === sessionId ? previous.shells : new Set<Element>()
    visibleShells.current = { feed: feedEl, sessionId, shells: onscreen }
    let active = true
    const recompute = (): void => {
      if (!active) return
      const next = new Set([...onscreen].flatMap(el => mapping.get(el) ?? []))
      setVisible(current => current.size === next.size && [...current].every(id => next.has(id)) ? current : next)
    }
    const ruler = feedEl.querySelector<HTMLElement>('.activity-ruler')
    let headerHeight = -1
    let observer: IntersectionObserver
    function observeViewport(): void {
      if (!active) return
      const height = Math.ceil(ruler?.getBoundingClientRect().height ?? 0)
      if (height === headerHeight) return
      headerHeight = height
      observer?.disconnect()
      const current = new IntersectionObserver(entries => {
        if (!active || observer !== current) return
        for (const entry of entries) entry.isIntersecting ? onscreen.add(entry.target) : onscreen.delete(entry.target)
        recompute()
      }, { root: feedEl, rootMargin: `-${height}px 0px 0px 0px`, threshold: 0 })
      observer = current
      for (const node of mapping.keys()) observer.observe(node)
    }
    observeViewport()
    const resize = new ResizeObserver(observeViewport)
    if (ruler) resize.observe(ruler)
    function unregister(node: Element): void {
      observer.unobserve(node)
      mapping.delete(node)
      onscreen.delete(node)
    }
    function register(node: HTMLElement): void {
      const id = node.dataset.nativeRecordId ?? node.dataset.nativeStepId
      const source = node.closest<HTMLElement>('[data-native-source]')?.dataset.nativeSource
      const key = id && source ? JSON.stringify([source, id]) : node.dataset.segmentKey
      // Only a folded header represents the group's records. Expanded steps keep their own visibility.
      const group = node.matches('.wf-head[aria-expanded="false"]') ? node.closest<HTMLElement>('[data-native-record-ids]') : null
      const records = group && source
        ? (JSON.parse(group.dataset.nativeRecordIds ?? '[]') as string[]).flatMap(recordId => expected.get(JSON.stringify([source, recordId])) ?? [])
        : key ? expected.get(key) : undefined
      if (!records?.length) { unregister(node); return }
      mapping.set(node, records)
      observer.observe(node)
    }
    const selector = '[data-native-record-id], [data-native-step-id], [data-segment-key], [data-native-record-ids] .wf-head'
    feedEl.querySelectorAll<HTMLElement>(selector).forEach(register)
    for (const node of onscreen) if (!mapping.has(node) || !node.isConnected) onscreen.delete(node)
    recompute()
    const mutations = new MutationObserver(entries => {
      if (!active) return
      for (const entry of entries) {
        if (entry.type === 'attributes' && entry.target instanceof HTMLElement && entry.target.matches('[data-native-record-ids] .wf-head')) register(entry.target)
        for (const added of entry.addedNodes) if (added instanceof HTMLElement) {
          if (added.matches(selector)) register(added)
          added.querySelectorAll<HTMLElement>(selector).forEach(register)
        }
        for (const removed of entry.removedNodes) if (removed instanceof HTMLElement) {
          if (removed.matches(selector)) unregister(removed)
          removed.querySelectorAll(selector).forEach(unregister)
        }
      }
      recompute()
    })
    mutations.observe(feedEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
    return () => { active = false; mutations.disconnect(); resize.disconnect(); observer.disconnect() }
  }, [rulerRecords, placed, feedEl, sessionId, readingEnabled])

  const locateRef = useRef<{ frame: number | null; source: AgentSessionHistoryPage | null | undefined }>({ frame: null, source: nativeHistoryPage })
  locateRef.current.source = nativeHistoryPage
  useEffect(() => () => { if (locateRef.current.frame !== null) cancelAnimationFrame(locateRef.current.frame) }, [sessionId])
  function selectRulerRecord(record: RulerRecord): void {
    if (locateRef.current.frame !== null) cancelAnimationFrame(locateRef.current.frame)
    setSelectedRecordId(record.id)
    if (record.target.kind === 'observed') { selectEvent(record.target.index); return }
    const target = record.target
    const page = nativeHistoryPage
    const thread = feedEl?.querySelector<HTMLElement>('.conversation-native-thread')
    if (!thread) return
    const group = [...thread.querySelectorAll<HTMLElement>('[data-native-record-ids]')]
      .find(node => node.closest<HTMLElement>('[data-native-source]')?.dataset.nativeSource === target.source && (JSON.parse(node.dataset.nativeRecordIds ?? '[]') as string[]).includes(target.recordId))
    const toggle = group?.querySelector<HTMLButtonElement>('.wf-head[aria-expanded="false"]')
    toggle?.click()
    locateRef.current.frame = requestAnimationFrame(() => {
      locateRef.current.frame = null
      if (locateRef.current.source !== page || !thread.isConnected) return
      const node = [...thread.querySelectorAll<HTMLElement>('[data-native-record-id], [data-native-step-id]')]
        .find(node => node.closest<HTMLElement>('[data-native-source]')?.dataset.nativeSource === target.source && (node.dataset.nativeRecordId === target.recordId || node.dataset.nativeStepId === target.recordId))
      node?.scrollIntoView({ block: 'nearest' })
      const viewport = thread.closest<HTMLElement>('.activity-feed')
      if (viewport) {
        anchorRef.current = captureReadingAnchor(viewport, node)
        markProgrammaticReadingScroll(viewport, 'navigation')
      }
    })
  }

  const hasUserMessages = Boolean(userMessages && userMessages.length > 0)
  const hasNativeRecords = nativeHistoryPage?.agentSessionId === sessionId && nativeHistoryPage.items.length > 0
  const hasItems = unifiedItems.length > 0
  const readPending = readingEnabled && Boolean(readingWindow.loading || userMessageRead?.loading)
  const earlierReadPending = readingWindow.loadingEarlier || readingWindow.coverageLoading
  const hasReadContent = hasUserMessages || hasNativeRecords || hasItems || ruler.items.length > 0
  const readingIssues: ConversationReadIssue[] = []
  if (readingWindow.error || !hasReadContent && readingWindow.automaticReadError) readingIssues.push({
    id: 'conversation-records', label: 'Conversation records',
    reasons: [readingWindow.error ?? readingWindow.automaticReadError!.message], loading: readingWindow.loading,
    retryLabel: readingWindow.retryLabel === 'Retry' ? 'Retry conversation records' : readingWindow.retryLabel, retry: readingWindow.retry
  })
  if (!readingWindow.historical && userMessageRead) {
    const reasons = [userMessageRead.error ? `Native input read failed: ${userMessageRead.error.message}` : null,
      userMessageRead.observationError ? `Automatic native updates are unavailable: ${userMessageRead.observationError.message}` : null,
      userMessageRead.windowFrozen ? 'Native source changed. The current reading window is kept. Read latest records to open a new window.' : null]
      .filter((reason): reason is string => reason !== null)
    if (reasons.length) readingIssues.push({ id: 'native-input-records', label: 'Native input records', reasons,
      loading: userMessageRead.loading, retryLabel: userMessageRead.windowFrozen ? 'Read latest records' : 'Retry native input records', retry: userMessageRead.onRetry })
  }
  const emptyReadFailed = Boolean(readingWindow.error || readingWindow.automaticReadError || !readingWindow.historical && userMessageRead?.error)
  const readingServiceScope = JSON.stringify(['conversation-reading', executionHostId, sessionId, conversationReading?.identity])
  const fullReadFailure = Boolean(conversationReading && !hasReadContent && readingIssues.length)
  const emptyReadStatus = fullReadFailure ? <ConversationReadFailure scope={readingServiceScope} issues={readingIssues}
    full visible={readingEnabled} /> : !hasReadContent && !earlierReadPending && (readPending || emptyReadFailed) ? (
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
          <button type="button" className="activity-feed__reading-action" disabled={readingWindow.loading && !readingWindow.coverageLoading || readingWindow.capturedLoading || !conversationReading.enabled}
            title={readingWindow.automaticReadError ? undefined : 'Read earlier conversation and process records in the original sequence'}
            data-read-error={readingWindow.automaticReadError ? 'true' : undefined}
            aria-busy={earlierReadPending || readingWindow.capturedLoading || undefined}
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
          title="Read the adjacent newer page" onClick={readingWindow.readNewer}>Newer</button> : null}
        {conversationReading.nativeSourceFacts?.nativeConfirmation ? <>
          <span className="activity-feed__reading-status">{readingWindow.previousSource ? 'Previous native source' : 'Current native source'}</span>
          <button type="button" className="activity-feed__reading-action" disabled={!conversationReading.enabled}
            onClick={readingWindow.showCurrentSource}>Current source</button>
          <button type="button" className="activity-feed__reading-action" disabled={!conversationReading.enabled}
            onClick={readingWindow.showPreviousSource}>Previous source</button>
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
    {!conversationReading && !readingWindow.historical ? <UserMessageReadNotice read={userMessageRead} /> : null}
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
  const needsReturnToLatest = showJump && (!atLoadedTail || readingWindow.currentOutside) || readingWindow.historical
  const latestControl = needsReturnToLatest || readingWindow.held ? (
    <div className="activity-feed__latest-layer" data-conversation-current-entry>
      {readingWindow.held ? <span className="activity-feed__latest-held" role="status">保留阅读位置</span> : null}
      {needsReturnToLatest ? <button type="button" className="activity-feed__jump" data-message-tool-control="jump-to-latest"
        aria-label="滚动到最新" disabled={!readingEnabled}
        title={readingWindow.held ? '原阅读位置和选区已保留，取消选择或移开当前阅读位置后可滚动到最新' : '滚动到最新'}
        onMouseDown={event => event.preventDefault()} onClick={returnToLatest}>
        <ThemeActionCurrentIcon size={12} aria-hidden="true" />滚动到最新
      </button> : null}
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
    label="loaded conversation" bodySelector=".log-turn__body, .log-row__prose, .log-row__payload, .log-row__output, .log-diff__body" scrollSelector=".activity-feed"
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
        {!emptyReadStatus && !readPending && !readingWindow.error && !userMessageRead?.error ? <div className="activity-feed__empty">
          {userMessageRead?.hasMore ? 'No inputs in the recent conversation window.' : 'No structured activity yet. Terminal remains available.'}
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
  const speaker = entry.kind === 'user-message'
      ? speakerOfUserMessage(entry.message)
      : entry.record?.speaker ?? speakerOf(entry.item)
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
      {entry.kind === 'user-message' ? (
        <ConversationMessage
          messageId={entry.message.id}
          conversationSessionId={sessionId}
          {...(executionHostId ? { executionHostId } : {})}
          {...(executionHostId ? { itemRef: { hostId: executionHostId, agentSessionId: entry.message.agentSessionId,
            source: entry.message.source.kind === 'native' ? entry.message.source : { kind: 'captured' as const, recordId: entry.message.source.submissionId }
          } } : {})}
          messageActions={executionHostId ? renderRecordActions?.({ hostId: executionHostId, agentSessionId: entry.message.agentSessionId,
            source: entry.message.source.kind === 'native' ? entry.message.source : { kind: 'captured', recordId: entry.message.source.submissionId } }, readingEnabled) : undefined}
          inputSource={entry.message.source}
          publicContent={entry.message.publicContent}
          located={locatedMessageKey === conversationMessageSourceKey(sessionId, entry.message.source)}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          content={entry.message.contentParts.length > 0 ? entry.message.contentParts : entry.message.content}
          {...(entry.message.source.kind === 'native' ? {
            nativeResourceRecord: { source: { providerId: entry.message.source.providerId, nativeSessionId: entry.message.source.nativeSessionId },
              recordId: entry.message.source.recordId, ...(entry.message.turnId === undefined ? {} : { turnId: entry.message.turnId }) },
            ...(readHistoryResource ? { readHistoryResource } : {})
          } : {})}
          {...(entry.message.questionAnswers ? { questionAnswers: entry.message.questionAnswers } : {})}
          {...(entry.message.questionDiagnostic ? { questionDiagnostic: entry.message.questionDiagnostic } : {})}
          {...(entry.message.deliveryStatus ? { status: entry.message.deliveryStatus } : {})}
          {...(entry.message.recordedAt === undefined ? {} : { createdAt: entry.message.recordedAt })}
          origin={origin}
          speaker={speaker!}
          name={described?.name ?? (speaker!.role === 'agent' ? (entry.message.author.kind === 'agent' ? entry.message.author.agentSessionId : speaker!.id) : 'Input')}
          workspaceRoot={workspaceRoot}
          homeDir={homeDir}
          {...(described?.providerId ? { providerId: described.providerId } : {})}
          {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
          {...(readPastedImage ? { readPastedImage: readEntryImage } : {})}
          {...(openHttpLink ? { openHttpLink } : {})}
          {...(onContinue ? { onContinue: () => onContinue(buildContinuationPrompt([entry.message], entry.message)) } : {})}
          {...(onSelectAnnotation ? { onSelectAnnotation } : {})}
        />
      ) : entry.record?.role !== 'process' && entry.record?.role !== 'interaction' && speaker ? (
        <CapturedConversationMessage
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
        <Row sources={entry.record?.sources} item={entry.item} origin={origin} showSource workspaceRoot={workspaceRoot}
          {...(disclosure ? { ...(disclosure.steps.has(entry.item.id) ? { expanded: disclosure.steps.get(entry.item.id)! } : {}), onExpandedChange: expanded => disclosure.onStepExpandedChange(entry.item.id, expanded) } : {})} />
      )}
    </div>
  )
  }

  return renderSurface(findTrigger => (
    <div className="activity-feed" data-workbench-reading-scroll onKeyDown={handleReadingKey} data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}
        onWheel={handleReadingWheel}>
      {readNotice}
      {!nativeHistoryPage && userMessages?.some(message => message.source.kind === 'native') ? <p className="activity-feed__read-notice" role="status">Original input records remain readable. Their complete native page and cross-source order are not loaded.</p> : null}
      {fileReferenceNotice}
      {capability === 'unavailable' ? (
        <div className="activity-feed__empty" role="status">
          This executor does not provide structured activity. Terminal remains available.
        </div>
      ) : null}
      {renderReadingHeader(<>{collapseTraces}{findTrigger}{renderReadingTools?.(readingEnabled, revealLoadedRecord)}</>, ruler.items.length > 0 ? <Ruler visible={readingEnabled}
        items={ruler.items}
        scale={scale}
        selectedIndex={rulerSelectedIndex < 0 ? null : rulerSelectedIndex}
        band={band}
        {...(conversationReading ? { reading: { hasMore: readingWindow.hasMore } } : {})}
        pending={readPending && !earlierReadPending}
        recentFraction={ruler.recentFraction}
        activity={activity.segments}
        controls={close => <><ConversationRulerControls window={rulerWindow} onWindow={setRulerWindow}
          untimed={ruler.untimed} onSelect={selectRulerRecord} describe={describeSpeaker ?? (() => ({ name: 'Recorded input' }))}
          onOpen={() => { close() }} />{collapseTraces}{findTrigger}{renderReadingTools?.(readingEnabled, revealLoadedRecord)}</>}
        onSelect={index => selectRulerRecord(ruler.items[index]!)}
        axes={({ width, onPeek, onPeekEnd }) =>
          describeSpeaker ? (
            <ConversationAxis items={ruler.items} belongs={() => true} width={width}
              label="Participants" size={16} describe={describeSpeaker}
              conversationSessionId={sessionId} recentFraction={ruler.recentFraction}
              selectedIndex={rulerSelectedIndex < 0 ? null : rulerSelectedIndex}
              onSelect={index => selectRulerRecord(ruler.items[index]!)} onPeek={onPeek} onPeekEnd={onPeekEnd} />
          ) : null
        }
      /> : undefined)}
      {holdCapturedLayout ? <p className="conversation-metrics__notice" role="status">保留选区，取消选择后更新消息顺序。</p> : null}
      <div ref={logRef}>
      <ConversationView
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
        insertions={[{ key: 'native-reading-tail', role: 'anchor', content: <div ref={nativeTailRef} data-conversation-native-tail aria-hidden="true" /> }]}
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
      {!nativeHistoryPage ? placed.filter(segment => segment.entry.kind === 'user-message').map(segment => renderPlaced(segment)) : null}
      </div>
      <div ref={readingTailRef} data-conversation-reading-tail aria-hidden="true" />
      {!readingWindow.historical && showWorkingIndicator(displayState, items) ? <WorkingIndicator active={activitySemantic === 'active'} /> : null}
      <div ref={readingSpaceRef} data-conversation-reading-space aria-hidden="true" />
    </div>
  ))
}
