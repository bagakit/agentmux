import { ChevronRight, FileText, Info, LoaderCircle, Pencil, Search } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
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
import { conversationRulerRecords, conversationRulerWindow, type RulerRecord, type RulerWindow } from '../lib/conversation-ruler'
import { projectAgentActivityHistory } from '@agentmux/core/timeline'
import { ConversationAxis, type DescribeSpeaker } from './ConversationAxis'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationNativeThread } from '@agentmux/client-ui/components/ConversationNativeThread'
import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { SemanticIcon } from './semantic-icons'
import { WorkflowCard } from './workflow/WorkflowCard'
import { WorkflowToolRow } from './workflow/WorkflowToolRow'
import { NativeProcessObservation } from './NativeProcessObservation'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
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
  items: AgentTimelineItem[],
  userMessages?: readonly AgentSessionUserMessage[]
): {
  unifiedItems: ConversationAxisItem[]
  segments: Segment[]
} {
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

function UserMessageReadNotice({ read }: { read: UserMessageReadState | undefined }) {
  if (!read || (!read.loading && !read.error && !read.observationError && !read.windowFrozen && !read.windowIncomplete && !read.hasMore)) return null
  return (
    <div className="activity-feed__read-notice" role="status">
      <span>
        {read.loading ? <><LoaderCircle size={12} className="spin" /> Reading native inputs…</> : read.error
          ? `Native input read failed: ${read.error.message}. Existing messages are kept.`
          : read.windowFrozen ? 'Native source changed. The current reading window is kept. Read latest records to open a new window.'
          : read.observationError ? `Automatic native updates are unavailable: ${read.observationError.message}. The current reading window is kept; Refresh retries the source.`
          : read.windowIncomplete ? 'This window keeps recent conversation and process records. History reads the original sequence.'
          : 'Earlier conversation records are available in History.'}
      </span>
      {read.error ? <button type="button" className="small-button" disabled={read.loading} onClick={read.onRetry}>Retry</button> : null}
      {!read.error && (read.windowFrozen || read.observationError) ? <button type="button" className="small-button" disabled={read.loading} onClick={read.onRetry}>{read.windowFrozen ? 'Read latest records' : 'Refresh'}</button> : null}
      {read.hasMore || read.windowIncomplete ? <button type="button" className="small-button" onClick={(event) => read.onReadEarlier(event.currentTarget)}>Read earlier records</button> : null}
    </div>
  )
}

export function ActivityView({
  sessionId,
  items,
  userMessages,
  nativeHistoryPage,
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
  moteConversation = false
}: {
  sessionId: string
  items: AgentTimelineItem[]
  userMessages?: readonly AgentSessionUserMessage[]
  nativeHistoryPage?: AgentSessionHistoryPage | null
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
}) {
  const { unifiedItems, segments } = useMemo(() => {
    const page = nativeHistoryPage?.agentSessionId === sessionId ? nativeHistoryPage : null
    const nativeIds = new Set(page?.items.filter((item) => item.kind === 'user-message').map((item) => item.id))
    // Only move an input into the source thread when that exact record is present there.
    // A missing page prop cannot erase already observed native input facts.
    const observedMessages = userMessages?.filter((message) => message.source.kind !== 'native' || !page ||
      message.source.providerId !== page.source.providerId || message.source.nativeSessionId !== page.source.nativeSessionId ||
      !nativeIds.has(message.rawId))
    return buildActivityEntries(items, observedMessages)
  }, [items, userMessages, nativeHistoryPage, sessionId])
  const placed = useMemo(() => placeSegments(segments), [segments])
  const origin = useMemo(() => {
    for (const it of unifiedItems) {
      const t = 'createdAt' in it ? it.createdAt : it.recordedAt
      if (t !== undefined) return t
    }
    return 0
  }, [unifiedItems])
  const rulerRecords = useMemo(() => conversationRulerRecords(sessionId, nativeHistoryPage, unifiedItems),
    [sessionId, nativeHistoryPage, unifiedItems])
  const [rulerWindow, setRulerWindow] = useState<RulerWindow>('1h')
  const ruler = useMemo(() => conversationRulerWindow(rulerRecords, rulerWindow), [rulerRecords, rulerWindow])
  const activity = useMemo(() => projectAgentActivityHistory(items), [items])
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const selectedRecord = rulerRecords.find(record => record.id === selectedRecordId)
  const selectedIndex = selectedRecord?.target.kind === 'observed' ? selectedRecord.target.index : null
  const rulerSelectedIndex = ruler.items.findIndex(record => record.id === selectedRecordId)
  const [visible, setVisible] = useState<Set<string>>(new Set())
  const scale = ruler.scale
  const band = useMemo(() => {
    const indices = ruler.items.flatMap((record, index) => visible.has(record.id) ? [index] : [])
    return rulerBand(scale, indices.length ? { from: Math.min(...indices), to: Math.max(...indices) } : null)
  }, [ruler.items, scale, visible])

  const logRef = useRef<HTMLDivElement>(null)
  const [feedEl, setFeedEl] = useState<HTMLDivElement | null>(null)
  const [locatedMessageKey, setLocatedMessageKey] = useState<string | null>(null)
  useEffect(() => {
    if (!locatedMessageKey) return
    const timer = window.setTimeout(() => setLocatedMessageKey(null), 2200)
    return () => window.clearTimeout(timer)
  }, [locatedMessageKey])
  useEffect(() => { setLocatedMessageKey(null) }, [sessionId])
  // 跟随状态是一个**值**，判定全在 lib 里；组件只负责把几何量喂进去、把决定执行掉。
  // 这样"什么时候该贴底"能被断言，而不是埋在一个 effect 里——本仓库测试不跑 effect。
  const followRef = useRef(initFollowState())
  const [showJump, setShowJump] = useState(false)
  const lastSessionIdRef = useRef<string | null>(null)
  const currentSessionId = sessionId

  useEffect(() => {
    if (currentSessionId && lastSessionIdRef.current !== currentSessionId) {
      lastSessionIdRef.current = currentSessionId
      followRef.current = initFollowState()
      setShowJump(false)
      pinToBottom()
    }
  }, [currentSessionId])

  const feedGeometry = (): ScrollGeometry | null => {
    const el = feedEl ?? logRef.current?.closest('.activity-feed')
    if (!(el instanceof HTMLElement)) return null
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  }

  const pinToBottom = (): void => {
    const el = feedEl ?? logRef.current?.closest('.activity-feed')
    if (el instanceof HTMLElement) el.scrollTop = el.scrollHeight
  }

  const jumpToLatest = (): void => {
    pinToBottom()
    const geometry = feedGeometry()
    if (geometry) followRef.current = onScroll(followRef.current, { ...geometry, scrollTop: geometry.scrollHeight })
    followRef.current = { ...followRef.current, following: true }
    setShowJump(shouldShowJumpToLatest(followRef.current))
  }

  // 用户主动往上滚才脱离；内容变长不算——两者都会让"离底部的距离"变大，能区分它们的证据是
  // scrollTop 本身有没有减少。判定在 lib 里，这里只把事件折进去。
  useEffect(() => {
    const el = feedEl ?? logRef.current?.closest('.activity-feed')
    if (!(el instanceof HTMLElement)) return
    const handle = (): void => {
      const geometry = feedGeometry()
      if (!geometry) return
      followRef.current = onScroll(followRef.current, geometry)
      setShowJump(shouldShowJumpToLatest(followRef.current))
    }
    el.addEventListener('scroll', handle, { passive: true })
    return () => el.removeEventListener('scroll', handle)
  }, [feedEl])

  // 新内容到达时贴底。追加与原地变长都算"新内容"——流式回答最常见的形态正是后者（尾项没换，
  // 只是变长了）。只有仍在跟随时才贴，否则会把已经滚上去的读者拽回来。
  useEffect(() => {
    const geometry = feedGeometry()
    if (!geometry) return
    const last = unifiedItems.at(-1)
    const decision = onContentChange(followRef.current, {
      itemCount: unifiedItems.length,
      lastItemId: last?.id ?? null,
      lastItemLength: last?.content?.length ?? 0
    }, geometry)
    followRef.current = decision.state
    if (decision.scrollToBottom) pinToBottom()
    setShowJump(shouldShowJumpToLatest(followRef.current))
  }, [unifiedItems, feedEl])

  useEffect(() => {
    if (!revealRequest || !feedEl) return
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
  }, [revealRequest, feedEl, unifiedItems, nativeHistoryPage])

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
    el?.scrollIntoView({ block: 'nearest' })
  }

  // Register committed shells once. Disclosure registers only added descendants, never a scroll-frame scan.
  useEffect(() => {
    if (!feedEl) return
    const expected = new Map<string, string[]>()
    const segmentsByIndex = new Map<number, string>()
    for (const segment of placed) for (let index = segment.from; index <= segment.to; index++) segmentsByIndex.set(index, segment.key)
    for (const record of rulerRecords) {
      const target = record.target
      const key = target.kind === 'native' ? JSON.stringify([target.source, target.recordId]) : segmentsByIndex.get(target.index)
      if (key) { const ids = expected.get(key) ?? []; ids.push(record.id); expected.set(key, ids) }
    }
    const mapping = new Map<Element, readonly string[]>()
    const onscreen = new Set<Element>()
    const recompute = (): void => setVisible(new Set([...onscreen].flatMap(el => mapping.get(el) ?? [])))
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) entry.isIntersecting ? onscreen.add(entry.target) : onscreen.delete(entry.target)
      recompute()
    }, { root: feedEl, rootMargin: '-64px 0px 0px 0px', threshold: 0 })
    function register(node: HTMLElement): void {
      const id = node.dataset.nativeRecordId ?? node.dataset.nativeStepId
      const source = node.closest<HTMLElement>('[data-native-source]')?.dataset.nativeSource
      const key = id && source ? JSON.stringify([source, id]) : node.dataset.segmentKey
      const records = key ? expected.get(key) : undefined
      if (records && !mapping.has(node)) { mapping.set(node, records); observer.observe(node) }
    }
    const selector = '[data-native-record-id], [data-native-step-id], [data-segment-key]'
    feedEl.querySelectorAll<HTMLElement>(selector).forEach(register)
    const mutations = new MutationObserver(entries => {
      for (const entry of entries) {
        for (const added of entry.addedNodes) if (added instanceof HTMLElement) {
          if (added.matches(selector)) register(added)
          added.querySelectorAll<HTMLElement>(selector).forEach(register)
        }
        for (const removed of entry.removedNodes) if (removed instanceof HTMLElement) {
          const unregister = (node: Element): void => { observer.unobserve(node); mapping.delete(node); onscreen.delete(node) }
          if (removed.matches(selector)) unregister(removed)
          removed.querySelectorAll(selector).forEach(unregister)
        }
      }
      recompute()
    })
    mutations.observe(feedEl, { childList: true, subtree: true })
    return () => { mutations.disconnect(); observer.disconnect() }
  }, [rulerRecords, placed, feedEl])

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
  const hasItems = items.length > 0
  const readNotice = <UserMessageReadNotice read={userMessageRead} />

  if (capability === 'unavailable' && !hasUserMessages && !hasItems && !hasNativeRecords) {
    return (
      <div className="activity-feed" data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}>
        {readNotice}
        {fileReferenceNotice}
        <div className="activity-feed__empty">
          This executor does not provide structured activity. Terminal remains available.
        </div>
      </div>
    )
  }
  if (!hasUserMessages && !hasNativeRecords && showEmptyState(displayState, items)) {
    return (
      <div className="activity-feed" data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}>
        {readNotice}
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
    return (
      <div className="activity-feed" data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}>
        {readNotice}
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

  return (
    <div className="activity-feed" data-mote-conversation={moteConversation ? 'true' : undefined} ref={setFeedEl}>
      {readNotice}
        {fileReferenceNotice}
      {capability === 'unavailable' ? (
        <div className="activity-feed__empty" role="status">
          This executor does not provide structured activity. Terminal remains available.
        </div>
      ) : null}
      {ruler.items.length > 0 ? <Ruler
        items={ruler.items}
        scale={scale}
        selectedIndex={rulerSelectedIndex < 0 ? null : rulerSelectedIndex}
        band={band}
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
      {nativeHistoryPage ? <ConversationNativeThread
        page={nativeHistoryPage}
        renderProcess={(props) => <NativeProcessObservation {...props} />}
        sessionId={sessionId}
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
      {placed.length > 0 ? <div className="activity-feed__observation-source">Submitted messages &amp; Hook observations · Separate recorded source</div> : null}

      <div className="activity-log" ref={logRef}>
        {placed.map(({ entry, key, from }) => {
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
                  messageId={entry.message.id}
                  conversationSessionId={sessionId}
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
                  {...(readPastedImage ? { readPastedImage } : {})}
                  {...(openHttpLink ? { openHttpLink } : {})}
                  {...(onContinue ? { onContinue: () => onContinue(buildContinuationPrompt(unifiedItems, entry.message)) } : {})}
                  {...(onSelectAnnotation ? { onSelectAnnotation } : {})}
                />
              ) : speaker ? (
                <ConversationMessage
                  messageId={entry.item.id}
                  conversationSessionId={sessionId}
                  {...(entry.item.kind === 'user_message' ? { inputSource: { kind: 'captured' as const, submissionId: entry.item.id } } : {})}
                  located={entry.item.kind === 'user_message' && locatedMessageKey === conversationMessageSourceKey(sessionId, { kind: 'captured', submissionId: entry.item.id })}
                  {...(describeSpeaker ? { describeSpeaker } : {})}
                  content={entry.item.content ?? ''}
                  status={entry.item.status}
                  createdAt={entry.item.createdAt}
                  origin={origin}
                  speaker={speaker}
                  workspaceRoot={workspaceRoot}
                  homeDir={homeDir}
                  {...(described ?? {})}
                  {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
                  {...(readPastedImage ? { readPastedImage } : {})}
                  {...(openHttpLink ? { openHttpLink } : {})}
                  {...(onContinue ? { onContinue: () => onContinue(buildContinuationPrompt(unifiedItems, entry.item)) } : {})}
                  {...(onSelectAnnotation ? { onSelectAnnotation } : {})}
                />
              ) : (
                <Row item={entry.item} origin={origin} showSource workspaceRoot={workspaceRoot} />
              )}
            </div>
          )
        })}
      </div>
      {showWorkingIndicator(displayState, items) ? <WorkingIndicator /> : null}
      {showJump ? (
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
