import { CapturedConversationMessage } from '@agentmux/client-ui/components/CapturedConversationMessage'
import type { ConversationReplySource } from '@agentmux/core/prompt-reaction'
import { ArrowDown, ArrowLeft, ChevronRight, ChevronUp, FileText, Info, Pencil, Search } from 'lucide-react'
import { WorkflowStatusGlyph } from '@agentmux/client-ui/components/WorkflowObservation'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode, type KeyboardEvent, type WheelEvent } from 'react'
import type { AgentDisplayState, AgentSessionHistoryPage, AgentSessionUserMessage } from '@agentmux/core'
import type { AgentTimelineItem } from '../../../shared/contracts'
import {
  initFollowState,
  onContentChange,
  onScroll,
  shouldShowJumpToLatest,
  type ScrollGeometry
} from '../lib/activity-autoscroll'
import {
  MAX_DIFF_LINES,
  parseUnifiedDiff,
  toolCallToDiff,
  type ToolDiff
} from '../lib/activity-diff'
import { createRulerScale, describeReadout, describeRulerAxis, describeSpan, describeActivityRecordTime, rulerBand, stepRulerSelection, type RulerReadoutText, type RulerScale } from '../lib/activity-ruler'
import { formatClock, formatDuration } from '@agentmux/client-ui/conversation-time'
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
import { Ruler } from './ConversationRuler'
export { Ruler } from './ConversationRuler'
import { ConversationRulerControls } from './ConversationRulerControls'
import { RULER_WINDOWS, conversationRulerRecords, conversationRulerWindow, type RulerRecord, type RulerWindow } from '../lib/conversation-ruler'
import { projectAgentActivityHistory } from '@agentmux/core/timeline'
import { ConversationAxis, type DescribeSpeaker } from './ConversationAxis'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationView, type ConversationQuestionReply } from '@agentmux/client-ui/components/ConversationView'
import { renderConversationQuestionNotice } from './ConversationQuestionNotice'
import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { SemanticIcon } from './semantic-icons'
import { WorkflowCard } from './workflow/WorkflowCard'
import { WorkflowToolRow } from './workflow/WorkflowToolRow'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { conversationReadingAnchor, protectsConversationWindow, restoreConversationAnchor, useSessionConversationWindow, type ConversationReading } from '../lib/session-conversation-window'
import type { ConversationRevealRequest } from '../lib/mailbox-message-navigation'

/**
 * 机器上报那一路的图标：按 `kind` 画，而这是对的——`tool_call` 是一把锤子、`permission` 是一枚盾，
 * 回答的是「这是一条什么事件」。**对话回合不走这里**：那一路的形状由身份驱动（见 {@link ConversationMessage}），
 * 因为「谁说的」不是一种事件类型。两个寄存器各有各的判据，不是同一个判据的两次调用。
 */
function Glyph({ kind, toolName, size = 12 }: { kind: AgentTimelineItem['kind']; toolName?: string; size?: number }) {
  if (kind === 'user_message') return <SemanticIcon name="user-message" size={size} />
  if (kind === 'assistant_message') return <SemanticIcon name="assistant-message" size={size} />
  if (kind === 'tool_call') {
    const name = toolName?.toLowerCase()
    if (name === 'bash' || name === 'shell' || name === 'exec_command' || name === 'run_command') return <SemanticIcon name="terminal" size={size} />
    if (name === 'read' || name === 'read_file') return <FileText size={size} />
    if (name === 'edit' || name === 'write' || name === 'write_file' || name === 'apply_patch') return <Pencil size={size} />
    if (name === 'grep' || name === 'glob' || name === 'search') return <Search size={size} />
    return <SemanticIcon name="tool-call" size={size} />
  }
  if (kind === 'permission') return <SemanticIcon name="permission" size={size} />
  return <SemanticIcon name="neutral" size={size} />
}

/**
 * A run of consecutive machine-reported steps between two turns the user can read. Collapsing the run
 * is the second level of folding: level one expands one step's payload, level two hides the whole
 * stretch of lifecycle noise that sits between a prompt and its answer.
 */
type Segment =
  | { kind: 'item'; item: AgentTimelineItem }
  | { kind: 'run'; id: string; items: AgentTimelineItem[] }
  | { kind: 'user-message'; message: AgentSessionUserMessage }

type RawEntry =
  | { type: 'timeline'; item: AgentTimelineItem; time: number }
  | { type: 'user-message'; message: AgentSessionUserMessage; time?: number }

function buildActivityEntries(
  sourceItems: AgentTimelineItem[],
  userMessages?: readonly AgentSessionUserMessage[]
): {
  unifiedItems: ConversationAxisItem[]
  segments: Segment[]
} {
  // Host diagnostics remain queryable in the original timeline, outside conversation content.
  const items = sourceItems.filter(item => !(item.kind === 'system_message' && item.source === 'agentmux' && item.id.startsWith('device-operation:')))
  const segments: Segment[] = []
  let run: AgentTimelineItem[] = []
  const flush = (): void => {
    if (run.length === 0) return
    // A single hook step is cheaper to read inline than behind a disclosure.
    if (run.length === 1) segments.push({ kind: 'item', item: run[0]! })
    else segments.push({ kind: 'run', id: `run-${run[0]!.id}`, items: run })
    run = []
  }

  if (!userMessages || userMessages.length === 0) {
    for (const item of items) {
      if (item.source === 'native-hook' && !isConversationTurn(item)) run.push(item)
      else {
        flush()
        segments.push({ kind: 'item', item })
      }
    }
    flush()
    return { unifiedItems: items, segments }
  }

  // Only exclude captured user messages that are already represented in userMessages.
  // Native rawId collision must NEVER erase an unrelated timeline receipt.
  const capturedSubmissionIds = new Set(
    userMessages
      .filter((m) => m.source.kind === 'captured')
      .map((m) => m.rawId)
  )
  const nonUserItems = items.filter((item) => {
    if (item.kind === 'user_message' || item.source === 'user') {
      return !capturedSubmissionIds.has(item.id)
    }
    return true
  })

  const stream: RawEntry[] = [
    ...nonUserItems.map((item) => ({ type: 'timeline' as const, item, time: item.createdAt })),
    ...userMessages.map((message) => ({
      type: 'user-message' as const,
      message,
      ...(message.recordedAt !== undefined ? { time: message.recordedAt } : {})
    }))
  ]

  stream.sort((a, b) => {
    if (a.time !== undefined && b.time !== undefined) return a.time - b.time
    if (a.time !== undefined) return 1
    if (b.time !== undefined) return -1
    return 0
  })

  const unifiedItems: ConversationAxisItem[] = []

  for (const entry of stream) {
    if (entry.type === 'user-message') {
      flush()
      segments.push({ kind: 'user-message', message: entry.message })
      unifiedItems.push(entry.message)
    } else {
      unifiedItems.push(entry.item)
      if (entry.item.source === 'native-hook' && !isConversationTurn(entry.item)) {
        run.push(entry.item)
      } else {
        flush()
        segments.push({ kind: 'item', item: entry.item })
      }
    }
  }
  flush()
  return { unifiedItems, segments }
}


function Row({
  item,
  origin,
  showSource,
  workspaceRoot
}: {
  item: AgentTimelineItem
  origin: number
  showSource: boolean
  /** 用来把仓内绝对路径缩成相对路径，见 activity-step-summary 的 shortenPath。缺席则原样显示。 */
  workspaceRoot: string
}) {
  const [open, setOpen] = useState(false)
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
        source: item.source,
        persistentSource: showSource
      }} className={`log-row log-row--${item.kind}`} icon={<Glyph kind={item.kind} {...(item.toolName ? { toolName: item.toolName } : {})} />}
        {...(expandable ? { expanded: open, onToggle: () => setOpen((value) => !value) } : {})} />
      {prose ? <p className="log-row__prose">{prose}</p> : null}
      {open && diff ? <DiffBlock diff={diff} /> : null}
      {open && !diff && payload ? <pre className="log-row__payload">{payload}</pre> : null}
      {open && output ? (
        <pre className="log-row__output" data-status={item.status}>{output}</pre>
      ) : null}
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

function Run({ items, origin, workspaceRoot }: { items: AgentTimelineItem[]; origin: number; workspaceRoot: string }) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [presentedIds, setPresentedIds] = useState<Set<string>>(() => new Set())
  const visible = (item: AgentTimelineItem, index: number): boolean =>
    showAll || items.length <= 10 || presentedIds.has(item.id) || index >= items.length - 6 || item.status !== 'complete'
  // Only disclosure intent is retained. Records stay in the original Timeline snapshot.
  // A status change must never remove a row the user has already read or selected.
  useLayoutEffect(() => {
    if (!open || showAll) return
    setPresentedIds((previous) => {
      const next = new Set(previous)
      items.forEach((item, index) => {
        if (items.length <= 10 || index >= items.length - 6 || item.status !== 'complete') next.add(item.id)
      })
      return next.size === previous.size ? previous : next
    })
  }, [items, open, showAll])
  if (items.length === 0) return null
  const counts = items.reduce((result, item) => {
    if (item.status === 'complete' || item.status === 'streaming' || item.status === 'failed') result[item.status]++
    else result.unknown++
    return result
  }, { complete: 0, streaming: 0, failed: 0, unknown: 0 })
  const hiddenCount = items.filter((item, index) => !visible(item, index)).length
  const failed = items.some((item) => item.status === 'failed')
  const streaming = items.some((item) => item.status === 'streaming')
  const complete = items.every((item) => item.status === 'complete')
  // This is the recorded range of these observations, not a Run execution duration.
  const lastRecordedAt = Math.max(...items.map((item) => item.updatedAt))
  const elapsed = lastRecordedAt - items[0]!.createdAt
  const recordedTime = describeActivityRecordTime(items[0]!.createdAt, lastRecordedAt, origin)
  return <WorkflowCard observation={{
    id: `observed-${items[0]!.id}`,
    stepCount: items.length,
    counts,
    ...(failed ? { status: 'failed' as const } : streaming ? { status: 'streaming' as const } : complete ? { status: 'complete' as const } : {}),
    streaming,
    recordedTime,
    ...(elapsed > 0 ? { elapsed: formatDuration(elapsed) } : {})
  }} expanded={open} onExpandedChange={setOpen}>
    {hiddenCount > 0 ? <button type="button" className="wf-observation__more" onClick={() => setShowAll(true)}>
      <ChevronRight size={12} aria-hidden="true" />Show {hiddenCount} more recorded steps
    </button> : null}
    {items.map((item, index) => visible(item, index) ? <Row key={item.id} item={item} origin={origin}
      showSource={index === 0} workspaceRoot={workspaceRoot} /> : null)}
  </WorkflowCard>
}

/** A segment paired with the half-open range of event indices it covers, so a position on the ruler
 *  can find the row that hosts that event and the band can read which events are on screen. */
type PlacedSegment = { entry: Segment; key: string; from: number; to: number }

function placeSegments(segments: Segment[]): PlacedSegment[] {
  const placed: PlacedSegment[] = []
  let index = 0
  for (const entry of segments) {
    const size = entry.kind === 'run' ? entry.items.length : 1
    const key = entry.kind === 'run' ? entry.id : entry.kind === 'user-message' ? entry.message.id : entry.item.id
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
function WorkingIndicator(): JSX.Element {
  return (
    <div className="activity-working" role="status" aria-live="polite">
      <span className="activity-working__dots" aria-hidden="true">
        <i /><i /><i />
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
  if (!read || (!read.error && !read.observationError && !read.windowFrozen && !read.windowIncomplete && !(showEarlier && read.hasMore))) return null
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
  openWorkspaceFile,
  readPastedImage,
  openHttpLink,
  workspaceRoot = '',
  homeDir = '',
  fileReferenceNotice,
  onContinue,
  onSelectAnnotation,
  describeSpeaker,
  moteConversation = false,
  onReplyQuestion,
  renderMessageActions
}: {
  sessionId: string
  executionHostId?: string
  items: AgentTimelineItem[]
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
  /** Absent means file references in agent prose stay plain text. */
  openWorkspaceFile?: OpenWorkspaceFile
  /** Absent means pasted-image references stay plain text (a text link, as before). */
  readPastedImage?: ReadPastedImage
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
  renderMessageActions?: (source: ConversationReplySource) => ReactNode
  onReplyQuestion?: ConversationQuestionReply
}) {
  const logRef = useRef<HTMLDivElement>(null)
  const [feedEl, setFeedEl] = useState<HTMLDivElement | null>(null)
  const anchorRef = useRef<ReturnType<typeof conversationReadingAnchor>>(null)
  const followRef = useRef(initFollowState())
  const [showJump, setShowJump] = useState(false)
  const returnRef = useRef<HTMLButtonElement>(null)
  const edgeRef = useRef({ earlier: false, newer: false, programmaticTop: null as number | null })
  const [rulerWindow, setRulerWindow] = useState<RulerWindow>('24h')
  const readingWindow = useSessionConversationWindow(conversationReading, recentNativePage ?? null, (page, intent, currentOriginal) => {
    const keepAnchor = intent === 'earlier' || intent === 'newer' || (intent !== 'current' && !followRef.current.following)
    if (protectsConversationWindow(feedEl, page, keepAnchor, currentOriginal)) return false
    anchorRef.current = keepAnchor && feedEl ? conversationReadingAnchor(feedEl) : null
    if (intent === 'current') {
      followRef.current = { ...followRef.current, following: true }
      edgeRef.current.earlier = false; edgeRef.current.newer = false
    }
    return true
  }, nativeContextItems, RULER_WINDOWS[rulerWindow])
  const handleReadingKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const interactive = event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="button"], [role="textbox"], [role="combobox"], [role="menu"]')
    if (!event.defaultPrevented && !interactive) {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) requestReadingEdge(-1, event.currentTarget)
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) requestReadingEdge(1, event.currentTarget)
    }
    if (event.key === 'Escape' && !event.defaultPrevented && conversationReading?.opened && conversationReading.onClose) {
      event.stopPropagation(); conversationReading.onClose()
    }
  }
  useEffect(() => {
    edgeRef.current = { earlier: false, newer: false, programmaticTop: null }
  }, [sessionId, conversationReading?.identity, conversationReading?.reference.hostId])
  const nativeHistoryPage = readingWindow.page
  const questionAnswerContext = useMemo(() => recentNativePage
    ? { ...recentNativePage, items: nativeContextItems ?? recentNativePage.items } : null,
    [recentNativePage, nativeContextItems])
  const historyBoundary = readingWindow.historyBoundary
  const boundaryIndex = !historyBoundary || !nativeHistoryPage ? -1 : nativeHistoryPage.items.findIndex(item => item.id === historyBoundary.beforeRecordId)
  const lastEarlierRecord = nativeHistoryPage?.items[boundaryIndex - 1]
  const boundaryTime = lastEarlierRecord?.completedAt ?? lastEarlierRecord?.startedAt
  const items = readingWindow.captured ?? observedItems
  const readingEnabled = conversationReading?.enabled !== false
  useLayoutEffect(() => {
    if (conversationReading?.enabled && feedEl && anchorRef.current) restoreConversationAnchor(feedEl, anchorRef.current)
    else if (conversationReading?.enabled && feedEl && followRef.current.following) feedEl.scrollTop = feedEl.scrollHeight
    if (conversationReading?.enabled && feedEl) edgeRef.current.programmaticTop = feedEl.scrollTop
  }, [nativeHistoryPage, feedEl, conversationReading?.enabled])
  useLayoutEffect(() => {
    if (!conversationReading?.enabled || !(readingWindow.historical || showJump) || !feedEl) return
    const content = feedEl.querySelector('.conversation-native-thread')
    if (!content) return
    let active = true
    const observer = new ResizeObserver(() => {
      if (active && anchorRef.current) { restoreConversationAnchor(feedEl, anchorRef.current); edgeRef.current.programmaticTop = feedEl.scrollTop }
    })
    observer.observe(content)
    return () => { active = false; observer.disconnect() }
  }, [feedEl, conversationReading?.enabled, readingWindow.historical, showJump])
  useEffect(() => {
    if (!conversationReading?.enabled || !conversationReading.opened || !conversationReading.onClose) return
    returnRef.current?.focus({ preventScroll: true })
  }, [conversationReading?.opened, conversationReading?.identity])
  const { unifiedItems, segments } = useMemo(() => {
    const page = nativeHistoryPage?.agentSessionId === sessionId ? nativeHistoryPage : null
    const nativeIds = new Set(page?.items.filter((item) => item.kind === 'user-message').map((item) => item.id))
    // A historical native window contains only its own source records. Recent facts stay
    // in the shared current window; a missing/different source never erases observed input.
    const observedMessages = userMessages?.filter((message) => {
      if (message.source.kind !== 'native' || !page) return true
      const sameSource = message.source.providerId === page.source.providerId && message.source.nativeSessionId === page.source.nativeSessionId
      if (conversationReading?.nativeSourceFacts && !sameSource) return false
      return !sameSource || !readingWindow.historical && !nativeIds.has(message.rawId)
    })
    return buildActivityEntries(items, observedMessages)
  }, [items, userMessages, nativeHistoryPage, sessionId, readingWindow.historical, Boolean(conversationReading?.nativeSourceFacts)])
  const placed = useMemo(() => placeSegments(segments), [segments])
  const nativeSupplement = (entry: Segment): boolean => entry.kind === 'user-message' && entry.message.source.kind === 'native'
  const observations = placed.reduce((summary, { entry }) => {
    if (nativeSupplement(entry)) return summary
    if (entry.kind === 'user-message') {
      summary.count++
      if (entry.message.deliveryStatus === 'failed') summary.failed++
      if (entry.message.deliveryStatus === 'unverified') summary.unconfirmed++
    } else for (const item of entry.kind === 'run' ? entry.items : [entry.item]) {
      summary.count++
      if (item.status === 'failed') summary.failed++
      if (item.kind === 'user_message' && item.status === 'streaming') summary.unconfirmed++
    }
    return summary
  }, { count: 0, failed: 0, unconfirmed: 0 })
  const observationRef = useRef<HTMLDetailsElement>(null)
  const [observationDisclosure, setObservationDisclosure] = useState({ sessionId, open: false })
  const observationOpen = observationDisclosure.sessionId === sessionId && observationDisclosure.open
  const observationVisible = observationOpen && conversationReading?.enabled !== false
  const readObservationImage = useCallback<ReadPastedImage>(path => observationVisible && readPastedImage
    ? readPastedImage(path) : Promise.resolve(null), [observationVisible, readPastedImage])
  const expandObservationFor = (target: Element): void => {
    const disclosure = observationRef.current
    if (!disclosure?.contains(target)) return
    disclosure.open = true
    setObservationDisclosure({ sessionId, open: true })
  }
  const origin = useMemo(() => {
    for (const it of unifiedItems) {
      const t = 'createdAt' in it ? it.createdAt : it.recordedAt
      if (t !== undefined) return t
    }
    return 0
  }, [unifiedItems])
  const rulerRecords = useMemo(() => conversationRulerRecords(sessionId, nativeHistoryPage, unifiedItems),
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

  const feedGeometry = (): ScrollGeometry | null => {
    const el = feedEl ?? logRef.current?.closest('.activity-feed')
    if (!(el instanceof HTMLElement)) return null
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  }

  const pinToBottom = (): void => {
    const el = feedEl ?? logRef.current?.closest('.activity-feed')
    if (el instanceof HTMLElement) { el.scrollTop = el.scrollHeight; edgeRef.current.programmaticTop = el.scrollTop }
  }

  const jumpToLatest = (): void => {
    pinToBottom()
    const geometry = feedGeometry()
    if (geometry) followRef.current = onScroll(followRef.current, { ...geometry, scrollTop: geometry.scrollHeight })
    followRef.current = { ...followRef.current, following: true }
    setShowJump(shouldShowJumpToLatest(followRef.current))
  }

  const handleReadingWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1)
    requestReadingEdge(Math.sign(delta), el, delta)
  }
  const requestReadingEdge = (direction: number, el: HTMLElement, delta = 0): void => {
    // Only this wheel/key input can request a page. Passive scroll, layout and
    // anchor restoration update reading position without producing more reads.
    const edges = edgeRef.current
    const distance = Math.max(80, el.clientHeight * 2)
    const nextTop = Math.max(0, el.scrollTop + delta)
    const earlier = nextTop <= distance
    const newer = el.scrollHeight - el.clientHeight - nextTop <= distance
    if (!earlier) edges.earlier = false
    if (!newer) edges.newer = false
    if (!conversationReading?.enabled || readingWindow.loading && !readingWindow.coverageLoading) return
    if (direction < 0 && earlier && !edges.earlier && readingWindow.hasMore) {
      edges.earlier = true; readingWindow.readEarlier()
    } else if (direction > 0 && newer && !edges.newer && readingWindow.hasNewer) {
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
      const programmatic = edgeRef.current.programmaticTop === geometry.scrollTop
      edgeRef.current.programmaticTop = null
      if (!programmatic && geometry.scrollTop !== followRef.current.lastScrollTop) anchorRef.current = conversationReadingAnchor(el)
      followRef.current = programmatic
        ? { ...followRef.current, lastScrollTop: geometry.scrollTop }
        : onScroll(followRef.current, geometry)
      setShowJump(shouldShowJumpToLatest(followRef.current))
    }
    el.addEventListener('scroll', handle, { passive: true })
    return () => el.removeEventListener('scroll', handle)
  }, [feedEl, readingWindow.historical, readingWindow.loading, readingWindow.hasMore, readingWindow.hasNewer, readingEnabled])

  // 新内容到达时贴底。追加与原地变长都算"新内容"——流式回答最常见的形态正是后者（尾项没换，
  // 只是变长了）。只有仍在跟随时才贴，否则会把已经滚上去的读者拽回来。
  useEffect(() => {
    if (!readingEnabled) return
    const geometry = feedGeometry()
    if (!geometry || readingWindow.historical) return
    const page = nativeHistoryPage?.agentSessionId === sessionId ? nativeHistoryPage : null
    const nativeTail = page?.items.at(-1)
    const observedTail = unifiedItems.at(-1)
    // The native source owns the reading tail. Inspect only its final record, never the whole page.
    const nativeLength = nativeTail?.contentParts.reduce((length, part) => length +
      Object.values(part).reduce<number>((size, value) => size + (typeof value === 'string' ? value.length : 0), 0), 0)
    const decision = onContentChange(followRef.current, {
      itemCount: unifiedItems.length + (page?.items.length ?? 0),
      lastItemId: nativeTail ? JSON.stringify([page!.source.providerId, page!.source.nativeSessionId, nativeTail.id]) : observedTail?.id ?? null,
      lastItemLength: nativeLength ?? observedTail?.content?.length ?? 0
    }, geometry)
    followRef.current = decision.state
    if (decision.scrollToBottom) pinToBottom()
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

  useEffect(() => {
    if (!readingEnabled || !revealRequest || !feedEl) return
    const target = Array.from(feedEl.querySelectorAll<HTMLElement>('.log-turn[data-message-source-key]'))
      .find(node => node.dataset.messageSourceKey === revealRequest.sourceKey)
    if (target && revealRequest.isCurrent()) expandObservationFor(target)
    const frame = requestAnimationFrame(() => {
      if (!revealRequest.isCurrent() || !feedEl.isConnected) { revealRequest.complete(false); return }
      const matches = Array.from(feedEl.querySelectorAll<HTMLElement>('.log-turn[data-message-source-key]'))
        .filter(node => node.dataset.messageSourceKey === revealRequest.sourceKey)
      if (matches.length !== 1) { revealRequest.complete(false); return }
      const node = matches[0]!
      const head = node.querySelector<HTMLElement>('.log-turn__head') ?? node
      followRef.current = { ...followRef.current, following: false }
      // No smooth scrolling or animation, including under reduced-motion preferences.
      head.scrollIntoView({ block: 'center', behavior: 'instant' })
      if (!revealRequest.isCurrent()) { revealRequest.complete(false); return }
      node.focus({ preventScroll: true })
      const r = head.getBoundingClientRect(), viewport = feedEl.getBoundingClientRect()
      const inView = r.width > 0 && r.height > 0 && r.bottom > viewport.top && r.top < viewport.bottom
      if (inView) setLocatedMessageKey(revealRequest.sourceKey)
      revealRequest.complete(inView)
    })
    return () => cancelAnimationFrame(frame)
  }, [revealRequest, feedEl, unifiedItems, nativeHistoryPage, readingEnabled])

  // Segment elements keyed by segment key, so a resolved event index can find its host row and the
  // observer can watch each one.
  const segmentEls = useRef(new Map<string, HTMLElement>())

  const segmentForIndex = (index: number): PlacedSegment | undefined =>
    placed.find((entry) => index >= entry.from && index <= entry.to)

  const selectEvent = (index: number): void => {
    setSelectedRecordId(rulerRecords.find(record => record.target.kind === 'observed' && record.target.index === index)?.id ?? null)
    const host = segmentForIndex(index)
    const el = host ? segmentEls.current.get(host.key) : undefined
    // Reuse the same scroll primitive the rest of the app uses to bring a row into view; there is no
    // second scroll controller for the Activity log.
    if (el) expandObservationFor(el)
    el?.scrollIntoView({ block: 'nearest' })
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
      ruler?.closest<HTMLElement>('.activity-feed-frame')?.style.setProperty('--activity-reading-top', `${height + 8}px`)
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
    const thread = [...(feedEl?.querySelectorAll<HTMLElement>('[data-native-source]') ?? [])]
      .find(node => node.dataset.nativeSource === target.source)
    if (!thread) return
    const group = [...thread.querySelectorAll<HTMLElement>('[data-native-record-ids]')]
      .find(node => (JSON.parse(node.dataset.nativeRecordIds ?? '[]') as string[]).includes(target.recordId))
    const toggle = group?.querySelector<HTMLButtonElement>('.wf-head[aria-expanded="false"]')
    toggle?.click()
    locateRef.current.frame = requestAnimationFrame(() => {
      locateRef.current.frame = null
      if (locateRef.current.source !== page || !thread.isConnected) return
      const node = [...thread.querySelectorAll<HTMLElement>('[data-native-record-id], [data-native-step-id]')]
        .find(node => node.dataset.nativeRecordId === target.recordId || node.dataset.nativeStepId === target.recordId)
      node?.scrollIntoView({ block: 'nearest' })
    })
  }

  const hasUserMessages = Boolean(userMessages && userMessages.length > 0)
  const hasNativeRecords = nativeHistoryPage?.agentSessionId === sessionId && nativeHistoryPage.items.length > 0
  const hasItems = unifiedItems.length > 0
  // Reading navigation belongs to the message flow; the ruler keeps temporal facts only.
  const readingEntry = conversationReading && (readingWindow.hasMore || readingWindow.hasEarlierNavigation || readingWindow.historical ||
    conversationReading.opened || readingWindow.newerOutside || readingWindow.error || readingAction || conversationReading.nativeSourceFacts?.nativeConfirmation) ? (
    <div className="activity-feed__reading" data-conversation-reading={readingWindow.historical ? 'earlier' : 'current'}>
      <div className="activity-feed__reading-entry">
        {readingWindow.hasMore ? (
          <button type="button" className="activity-feed__reading-action" disabled={readingWindow.loading && !readingWindow.coverageLoading || !conversationReading.enabled}
            onClick={readingWindow.readEarlier}><ChevronUp size={12} aria-hidden="true" />Earlier</button>
        ) : null}
        {readingWindow.hasEarlierNavigation || conversationReading.opened || readingWindow.newerOutside || readingWindow.error ? (
          <button type="button" className="activity-feed__reading-action" disabled={!conversationReading.enabled}
            aria-label="Current" title="Return to latest messages" onClick={readingWindow.showCurrent}>
            <ArrowDown size={12} aria-hidden="true" />Current</button>
        ) : null}
        {conversationReading.nativeSourceFacts?.nativeConfirmation ? <>
          <span className="activity-feed__reading-status">{readingWindow.previousSource ? 'Previous native source' : 'Current native source'}</span>
          <button type="button" className="activity-feed__reading-action" disabled={!conversationReading.enabled}
            onClick={readingWindow.showCurrentSource}>Current source</button>
          <button type="button" className="activity-feed__reading-action" disabled={!conversationReading.enabled}
            onClick={readingWindow.showPreviousSource}>Previous source</button>
        </> : null}
        {conversationReading.opened && conversationReading.onClose ? <button ref={returnRef} type="button"
          className="activity-feed__reading-action" aria-label={`Return to ${conversationReading.returnLabel ?? 'Activity'}`}
          onClick={conversationReading.onClose}><ArrowLeft size={12} aria-hidden="true" />Return</button> : null}
        {readingAction}
      </div>
    </div>
  ) : null
  const readNotice = <>
    {readingNotice}
    {readingWindow.capturedError ? <div role="status" className="activity-feed__read-notice">Submitted-message read unavailable: {readingWindow.capturedError}. Existing records are kept.</div> : null}
    {readingWindow.error ? <div role="status" className="activity-feed__read-notice"><span>{readingWindow.error}</span>
      <button type="button" className="small-button" disabled={readingWindow.loading} onClick={readingWindow.retry}>Retry</button></div> : null}
    {!readingWindow.historical ? <UserMessageReadNotice showEarlier={!conversationReading} read={userMessageRead ? { ...userMessageRead,
      onReadEarlier: conversationReading ? readingWindow.readEarlier : userMessageRead.onReadEarlier } : undefined} /> : null}
  </>

  // Loading is a sibling overlay: neither scroll height nor card geometry depends on pending work.
  const renderSurface = (content: JSX.Element): JSX.Element => <div className="activity-feed-frame">
    {content}
    {conversationReading?.enabled !== false && (readingWindow.loading || userMessageRead?.loading) ? <div className="activity-feed__loading-layer">
      <span role="status" aria-live="polite" className="activity-feed__reading-status">
        <WorkflowStatusGlyph status="running" />Reading records…
      </span>
    </div> : null}
  </div>

  if (capability === 'unavailable' && !hasUserMessages && !hasItems && !hasNativeRecords) {
    return renderSurface(
      <div className="activity-feed" data-workbench-reading-scroll onKeyDown={handleReadingKey} data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}
        onWheel={handleReadingWheel}>
        {readNotice}
        {readingEntry}
        {fileReferenceNotice}
        <div className="activity-feed__empty">
          This executor does not provide structured activity. Terminal remains available.
        </div>
      </div>
    )
  }
  if (!hasUserMessages && !hasNativeRecords && showEmptyState(displayState, hasItems ? items : [])) {
    return renderSurface(
      <div className="activity-feed" data-workbench-reading-scroll onKeyDown={handleReadingKey} data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}
        onWheel={handleReadingWheel}>
        {readNotice}
        {readingEntry}
        {fileReferenceNotice}
        {!userMessageRead?.loading && !userMessageRead?.error ? <div className="activity-feed__empty">
          {userMessageRead?.hasMore ? 'No inputs in the recent conversation window.' : 'No structured activity yet. Terminal remains available.'}
        </div> : null}
      </div>
    )
  }
  // 正在想、但首行还没落地：显示"在进行"而不是空状态。一个正在工作的东西显示成空，
  // 比慢更糟——用户会以为自己没发出去，然后再发一遍。
  if (!hasUserMessages && !hasItems && !hasNativeRecords) {
    return renderSurface(
      <div className="activity-feed" data-workbench-reading-scroll onKeyDown={handleReadingKey} data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}
        onWheel={handleReadingWheel}>
        {readNotice}
        {readingEntry}
        {fileReferenceNotice}
        <WorkingIndicator />
      </div>
    )
  }

  const registerSegment = (key: string) => (el: HTMLDivElement | null): void => {
    if (el) {
      el.dataset.segmentKey = key
      segmentEls.current.set(key, el)
    } else {
      segmentEls.current.delete(key)
    }
  }

  const renderPlaced = ({ entry, key }: PlacedSegment): JSX.Element => {
  const readEntryImage = readPastedImage && (nativeSupplement(entry) ? readPastedImage : readObservationImage)
  // Identity is resolved once here; the shared message only renders that verdict.
  const speaker = entry.kind === 'run'
    ? null
    : entry.kind === 'user-message'
      ? speakerOfUserMessage(entry.message)
      : speakerOf(entry.item)
  const described = speaker ? describeSpeaker?.(speaker) : undefined
  return (
    // One wrapper per segment carries the scroll target, the observer key, and the selection
    // marker, so the three log registers below stay unaware of the ruler wiring.
    <div
      key={key}
      className="activity-log__segment"
      ref={registerSegment(key)}
    >
      {entry.kind === 'run' ? (
        <Run items={entry.items} origin={origin} workspaceRoot={workspaceRoot} />
      ) : entry.kind === 'user-message' ? (
        <ConversationMessage
          compact={!nativeSupplement(entry)}
          messageId={entry.message.id}
          conversationSessionId={sessionId}
          {...(executionHostId ? { executionHostId } : {})}
          inputSource={entry.message.source}
          located={locatedMessageKey === conversationMessageSourceKey(sessionId, entry.message.source)}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          content={entry.message.contentParts.length > 0 ? entry.message.contentParts : entry.message.content}
          {...(entry.message.deliveryStatus ? { status: entry.message.deliveryStatus } : {})}
          {...(entry.message.recordedAt === undefined ? {} : { createdAt: entry.message.recordedAt })}
          origin={origin}
          speaker={speaker!}
          name={described?.name ?? (speaker!.role === 'agent' ? (entry.message.author.kind === 'agent' ? entry.message.author.agentSessionId : speaker!.id) : 'Input')}
          workspaceRoot={workspaceRoot}
          homeDir={homeDir}
          {...(described?.providerId ? { providerId: described.providerId } : {})}
          {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
          {...(readEntryImage ? { readPastedImage: readEntryImage } : {})}
          {...(openHttpLink ? { openHttpLink } : {})}
          {...(onContinue ? { onContinue: () => onContinue(buildContinuationPrompt(unifiedItems, entry.message)) } : {})}
          {...(onSelectAnnotation ? { onSelectAnnotation } : {})}
        />
      ) : speaker ? (
        <CapturedConversationMessage
          compact
          item={entry.item}
          {...(renderMessageActions && entry.item.kind === 'assistant_message' && entry.item.agentSessionId === sessionId &&
            !entry.item.authorAgentSessionId && entry.item.source !== 'user' && entry.item.content?.trim() && entry.item.status === 'complete'
            ? { messageActions: renderMessageActions({ kind: 'captured', agentSessionId: sessionId, recordId: entry.item.id }) } : {})}
          conversationSessionId={sessionId}
          {...(executionHostId ? { executionHostId } : {})}
          {...(entry.item.kind === 'user_message' || speaker.role === 'system' || entry.item.sourceDevice || entry.item.sourceChannel ? { inputSource: { kind: 'captured' as const, submissionId: entry.item.id, ...(entry.item.sourceChannel ? { channel: entry.item.sourceChannel } : {}), ...(entry.item.sourceDevice ? { device: entry.item.sourceDevice } : {}) } } : {})}
          located={entry.item.kind === 'user_message' && locatedMessageKey === conversationMessageSourceKey(sessionId, { kind: 'captured', submissionId: entry.item.id })}
          {...(describeSpeaker ? { describeSpeaker } : {})}
          {...(speaker.role === 'system' ? { recordTitle: entry.item.title } : {})}
          origin={origin}
          speaker={speaker}
          workspaceRoot={workspaceRoot}
          homeDir={homeDir}
          {...(described ?? {})}
          {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
          {...(readEntryImage ? { readPastedImage: readEntryImage } : {})}
          {...(openHttpLink ? { openHttpLink } : {})}
          {...(onContinue ? { onContinue: () => onContinue(buildContinuationPrompt(unifiedItems, entry.item)) } : {})}
          {...(onSelectAnnotation ? { onSelectAnnotation } : {})}
        />
      ) : (
        <Row item={entry.item} origin={origin} showSource workspaceRoot={workspaceRoot} />
      )}
    </div>
  )
  }

  return renderSurface(
    <div className="activity-feed" data-workbench-reading-scroll onKeyDown={handleReadingKey} data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}
        onWheel={handleReadingWheel}>
      {readNotice}
      {fileReferenceNotice}
      {capability === 'unavailable' ? (
        <div className="activity-feed__empty" role="status">
          This executor does not provide structured activity. Terminal remains available.
        </div>
      ) : null}
      {ruler.items.length > 0 ? <Ruler visible={readingEnabled}
        items={ruler.items}
        scale={scale}
        selectedIndex={rulerSelectedIndex < 0 ? null : rulerSelectedIndex}
        band={band}
        {...(conversationReading ? { reading: { loading: readingWindow.loading, hasMore: readingWindow.hasMore } } : {})}
        recentFraction={ruler.recentFraction}
        activity={activity.segments}
        controls={close => <ConversationRulerControls window={rulerWindow} onWindow={setRulerWindow}
          untimed={ruler.untimed} onSelect={selectRulerRecord} describe={describeSpeaker ?? (() => ({ name: 'Recorded input' }))}
          onOpen={() => { close() }} />}
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
      /> : null}
      {observations.count > 0 ? <details key={sessionId} ref={observationRef} className="activity-feed__observations"
        open={observationOpen} onToggle={event => {
          if (event.currentTarget === observationRef.current) setObservationDisclosure({ sessionId, open: event.currentTarget.open })
        }}>
        <summary className="activity-feed__observation-source">
          <ChevronRight size={12} aria-hidden="true" />
          <span>投递与运行详情</span>
          <span className="activity-feed__observation-count">· {observations.count} 项</span>
          {observations.failed > 0 ? <span className="activity-feed__observation-issue">{observations.failed} failed records</span> : null}
          {observations.unconfirmed > 0 ? <span className="activity-feed__observation-issue">{observations.unconfirmed} submissions unconfirmed</span> : null}
        </summary>
        <div className="activity-feed__observation-scope">包含发送回执和运行观察，不代表 Agent 已接纳的对话消息</div>
        <div className="activity-log">{placed.filter(({ entry }) => !nativeSupplement(entry)).map(renderPlaced)}</div>
      </details> : null}
      <div className="activity-log" ref={logRef}>{placed.filter(({ entry }) => nativeSupplement(entry)).map(renderPlaced)}</div>
      {readingEntry}
      {nativeHistoryPage ? <ConversationView
        page={nativeHistoryPage}
        questionAnswerContext={questionAnswerContext}
        {...(historyBoundary && boundaryIndex > 0 ? {
          recordBoundary: { ...historyBoundary, content: <div className="activity-feed__history-divider" role="separator">
            以上是历史消息（{boundaryTime === undefined ? '时间未记录' : new Date(boundaryTime).toLocaleString()}）
          </div> }
        } : {})}
        renderQuestionNotice={renderConversationQuestionNotice}
        {...(onReplyQuestion ? { onReplyQuestion } : {})}
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
        {...(openHttpLink ? { openHttpLink } : {})}
        {...(onSelectAnnotation ? { onSelectAnnotation } : {})}
      /> : null}
      {readingWindow.historical || readingWindow.newerOutside ? <div className="activity-feed__read-notice activity-feed__newer-edge" data-conversation-current-entry>
        <span role="status" aria-live="polite">{readingWindow.error ?? (readingWindow.newerOutside ? 'Current records updated or outside this window.' : 'Viewing earlier records.')} {readingWindow.hasNewer ? '较新记录可向下滚动继续读取' : ''}</span>
        {readingWindow.hasNewer ? <button type="button" className="small-button" disabled={readingWindow.loading && !readingWindow.coverageLoading || !conversationReading?.enabled} onClick={readingWindow.readNewer}>Newer</button> : null}
        <button type="button" className="small-button" disabled={!conversationReading?.enabled} onClick={readingWindow.showCurrent}>Show latest messages</button>
      </div> : null}
      {!readingWindow.historical && showWorkingIndicator(displayState, items) ? <WorkingIndicator /> : null}
      {showJump && !readingWindow.historical ? (
        <button
          type="button"
          className="activity-feed__jump"
          data-message-tool-control="jump-to-latest"
          aria-label="Jump to latest message"
          onClick={jumpToLatest}
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  )
}
