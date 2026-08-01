import { Bot, ChevronRight, CircleDot, Hammer, Info, ShieldAlert, UserRound } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
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
import { timelineRows } from '../lib/activity-timeline-rows'
import {
  createRulerScale,
  describeReadout,
  describeRulerAxis,
  describeSpan,
  formatClock,
  formatDuration,
  formatOffset,
  rulerBand,
  stepRulerSelection,
  type RulerReadoutText,
  type RulerScale
} from '../lib/activity-ruler'
import { stepTitle } from '../lib/activity-step-summary'
import { showEmptyState, showWorkingIndicator } from '../lib/activity-working-state'
import { speaksAsAgent, speaksAsHuman, type ConversationAxisMark } from '../lib/conversation-axis'
import { isConversationTurn, speakerOf, type ConversationSpeaker } from '../lib/conversation-speaker'
import { conversationQuote } from '../lib/conversation-quote'
import { terminalLinkPreviewAnchor } from '../lib/terminal-link-gesture'
import { AgentMarkdown, type LinkClickModifiers, type OpenWorkspaceFile } from './AgentMarkdown'
import { ConversationAxis, type DescribeSpeaker } from './ConversationAxis'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'

/**
 * 机器上报那一路的图标：按 `kind` 画，而这是对的——`tool_call` 是一把锤子、`permission` 是一枚盾，
 * 回答的是「这是一条什么事件」。**对话回合不走这里**：那一路的形状由身份驱动（见 {@link Turn}），
 * 因为「谁说的」不是一种事件类型。两个寄存器各有各的判据，不是同一个判据的两次调用。
 */
function Glyph({ kind, size = 12 }: { kind: AgentTimelineItem['kind']; size?: number }) {
  if (kind === 'user_message') return <UserRound size={size} />
  if (kind === 'assistant_message') return <Bot size={size} />
  if (kind === 'tool_call') return <Hammer size={size} />
  if (kind === 'permission') return <ShieldAlert size={size} />
  return <CircleDot size={size} />
}

/**
 * A run of consecutive machine-reported steps between two turns the user can read. Collapsing the run
 * is the second level of folding: level one expands one step's payload, level two hides the whole
 * stretch of lifecycle noise that sits between a prompt and its answer.
 */
type Segment =
  | { kind: 'item'; item: AgentTimelineItem }
  | { kind: 'run'; id: string; items: AgentTimelineItem[] }

function segment(items: AgentTimelineItem[]): Segment[] {
  const segments: Segment[] = []
  let run: AgentTimelineItem[] = []
  const flush = (): void => {
    if (run.length === 0) return
    // A single hook step is cheaper to read inline than behind a disclosure.
    if (run.length === 1) segments.push({ kind: 'item', item: run[0]! })
    else segments.push({ kind: 'run', id: `run-${run[0]!.id}`, items: run })
    run = []
  }
  for (const item of items) {
    // A run holds machine reporting only. A human turn already breaks it (source 'user'); the assistant
    // reply is native-hook too, so without the speaker guard segment() would sweep it into a collapsed
    // "N steps" fold and hide the agent's half of the conversation.
    if (item.source === 'native-hook' && !isConversationTurn(item)) run.push(item)
    else {
      flush()
      segments.push({ kind: 'item', item })
    }
  }
  flush()
  return segments
}

/** The client-space rectangle the readout must stay clear of and inside — the whole ruler track. */
function readoutAnchor(
  trackRect: DOMRect,
  feedRect: DOMRect,
  pointerX: number
): { left: number; top: number; placement: 'above' | 'below' } {
  // Reuse the exact anchoring the terminal link preview established: clear a full "cell" (here, half
  // the track height from its centre) plus the gap so the readout never covers the segment it
  // describes, and flip below when there is no room above. Keeping one implementation means the two
  // hovering surfaces can never drift apart on where "not covering the thing" lands.
  return terminalLinkPreviewAnchor({
    pointer: { x: pointerX, y: trackRect.top + trackRect.height / 2 },
    cellHeight: trackRect.height / 2,
    viewport: {
      left: feedRect.left,
      top: feedRect.top,
      right: feedRect.right,
      bottom: feedRect.bottom
    }
  })
}

/**
 * 面板要显示的内容。**一个面板、两种内容源**，不是两个面板。
 *
 * 主刻度悬停给的是「什么时候」（`RulerReadoutText`）；轴上的头像标记给的是「说了什么」（原话）。
 * 两者共用同一个浮层、同一套锚定几何、同一条关闭路径——因为它们回答的是同一个问题的两半，而且
 * 在屏幕上占的是同一个位置：两个各自管自己显隐的浮层会在标记与刻度都被指到时同时浮出来，互相
 * 叠住。用一个可辨别联合类型而不是两个可选字段：「既有时间又有原话」和「两者都没有」都不是合法
 * 状态，让类型直接说出这件事，而不是靠渲染时的 if 去防。
 */
type ReadoutBody =
  | { kind: 'moment'; text: RulerReadoutText }
  | { kind: 'quote'; name: string; quote: string }

type Readout = {
  body: ReadoutBody
  left: number
  top: number
  placement: 'above' | 'below'
}

/**
 * The interactive temporal axis. Ticks sit at their real elapsed fraction (or even ordinal spacing
 * when there is no spread to map). It is one focusable slider: click or keyboard both resolve a
 * position to a real event through the shared {@link RulerScale} and ask the log to scroll there;
 * hover and focus read the same scale for the moment (or ordinal) at a position without ever moving
 * the selection.
 */
/**
 * 导出**只为可判**：`renderToStaticMarkup` 不输出任何 handler，所以「hover 出面板 / Escape 关面板 /
 * 空引文不开面板」这三条接线在标记流上完全不可见。测试把这个组件当函数求值、从 element 树上取到那些
 * handler 并真的调用（先例：`ConversationAxis` 的点击接线就是这么判的）。
 * 生产调用者只有本文件的 {@link ActivityView}。
 */
export function Ruler({
  items,
  scale,
  selectedIndex,
  band,
  onSelect,
  axes
}: {
  items: AgentTimelineItem[]
  scale: RulerScale
  selectedIndex: number | null
  band: ReturnType<typeof rulerBand>
  onSelect: (index: number) => void
  /**
   * 与 track 共用一个坐标盒的那些轴，摆在 track 之上。见 render 里的注释。
   *
   * 是个函数而不是一个现成元素：轴需要接到**这一层**的面板出口上（`Ruler` 才持有面板状态与那个
   * 共享坐标盒），而轴本身需要身份解析（`describe`），那只有 ActivityView 有。于是这一层把出口
   * 递出去，调用方把身份补上——两边各给自己知道的那一半，谁都不必知道对方的。
   */
  axes?: (peek: {
    onPeek: (peek: { rect: DOMRect; mark: ConversationAxisMark; name: string }) => void
    onPeekEnd: () => boolean
  }) => JSX.Element | null
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [readout, setReadout] = useState<Readout | null>(null)
  const axisLabel = describeRulerAxis(scale)
  const span = describeSpan(scale)

  const feedRect = (): DOMRect | null =>
    trackRef.current?.closest('.activity-feed')?.getBoundingClientRect() ?? null

  const showReadout = (index: number, pointerX: number): void => {
    const track = trackRef.current
    const feed = feedRect()
    if (!track || !feed) return
    const trackRect = track.getBoundingClientRect()
    const anchor = readoutAnchor(trackRect, feed, pointerX)
    setReadout({ body: { kind: 'moment', text: describeReadout(scale.readoutOf(index), scale.count) }, ...anchor })
  }

  /**
   * 轴上一枚标记要展示的原话。走的是与 {@link showReadout} 同一个 setter、同一个锚定函数、同一条
   * 关闭路径——面板只有一个，这里只是换了内容源。
   *
   * 锚定用**标记自己的矩形**而不是指针位置：标记是个 24px 的圆形命中区，按指针锚定会让面板随指针
   * 在标记内部漂移；按标记中心锚定，面板与它所描述的那枚头像是固定关系。`cellHeight` 取标记高的
   * 一半（与主刻度取 track 半高同一个算法），于是「让开它所描述的东西」这句话在两处是同一个几何。
   *
   * 没有话的 item 不开面板（`conversationQuote` 返回 null）：一个空面板会让「这条没内容」与「面板
   * 坏了」看起来是同一件事。
   */
  const showQuote = ({
    rect,
    mark,
    name
  }: {
    rect: DOMRect
    mark: ConversationAxisMark
    name: string
  }): void => {
    const feed = feedRect()
    if (!feed) return
    const quote = conversationQuote(mark.item)
    if (quote === null) return
    const anchor = terminalLinkPreviewAnchor({
      pointer: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      cellHeight: rect.height / 2,
      viewport: { left: feed.left, top: feed.top, right: feed.right, bottom: feed.bottom }
    })
    setReadout({ body: { kind: 'quote', name, quote }, ...anchor })
  }

  /**
   * 关面板，并回答「刚才真的关掉了一个开着的面板吗」。
   *
   * 这个返回值只为 Escape 存在：轴不持有面板状态，所以「该不该吃掉那个键」只能由持有状态的这一层
   * 回答。无条件吞掉会让 Escape 在面板关着时也被静默吃掉，而外层可能正等着用它关一个更大的东西
   * （Region、对话框）。
   *
   * 直接读闭包里的 `readout` 就够：Escape 是一次**独立的后续事件**，触发它的那一轮渲染早已带上了
   * 开面板之后的新值。这里曾经另存一份 ref，理由写的是"同一帧内按 Escape 会读到过期值"——那个理由
   * 是错的（同一帧内不存在第二个键盘事件），而它换来的是两份必须同步的状态。删掉了。
   */
  const closeReadout = (): boolean => {
    const wasOpen = readout !== null
    setReadout(null)
    return wasOpen
  }

  const fractionFromClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return (clientX - rect.left) / rect.width
  }

  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const readoutAt = scale.readoutAtFraction(fractionFromClientX(event.clientX))
    if (readoutAt) onSelect(readoutAt.index)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const at = scale.readoutAtFraction(fractionFromClientX(event.clientX))
    if (at) showReadout(at.index, event.clientX)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = stepRulerSelection(selectedIndex, event.key, scale.count)
    if (next === null || next === selectedIndex) {
      // Home/End with an existing selection can equal current; still consume the navigation keys so
      // the surrounding scroll container does not also act on them.
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
      }
      return
    }
    event.preventDefault()
    onSelect(next)
    // Focus keeps the same readout the pointer would show, anchored over the newly selected tick.
    const track = trackRef.current
    if (track) {
      const rect = track.getBoundingClientRect()
      showReadout(next, rect.left + scale.fractionOf(next) * rect.width)
    }
  }

  const handleFocus = (): void => {
    if (selectedIndex === null) return
    const track = trackRef.current
    if (track) {
      const rect = track.getBoundingClientRect()
      showReadout(selectedIndex, rect.left + scale.fractionOf(selectedIndex) * rect.width)
    }
  }

  const selectedText =
    selectedIndex === null ? undefined : describeReadout(scale.readoutOf(selectedIndex), scale.count).summary

  return (
    <div className="activity-ruler">
      {/* 轴与 track 必须在**同一个盒**里，否则两处的 `left: N%` 参照不同的宽度。这一行的其余两件
          （span 读数、info note）与 track 同排且占掉右侧近百像素，所以 track 自己不能当那个共享盒
          ——`__stack` 才是：它是这一行的 flex 子项，内部纵向摆「说话人轴 / 自我 Agent 轴 / track」。
          `axes` 由调用方传入而不是在这里组装，是因为轴需要身份解析（`describeSpeaker`），而 Ruler
          对身份一无所知；它只提供那个共享坐标盒。 */}
      <div className="activity-ruler__stack">
        {axes?.({ onPeek: showQuote, onPeekEnd: closeReadout })}
        <div
          ref={trackRef}
          className="activity-ruler__track"
        data-axis={scale.axis}
        role="slider"
        tabIndex={0}
        aria-label={axisLabel}
        aria-valuemin={1}
        aria-valuemax={scale.count}
        aria-valuenow={(selectedIndex ?? 0) + 1}
        aria-valuetext={selectedText ?? axisLabel}
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        onPointerLeave={closeReadout}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={closeReadout}
      >
        <span className="activity-ruler__rail" />
        {band ? (
          <span
            className="activity-ruler__band"
            data-axis={scale.axis}
            style={{ left: `${band.startFraction * 100}%`, right: `${(1 - band.endFraction) * 100}%` }}
            aria-hidden="true"
          />
        ) : null}
        {items.map((item, index) => (
          <span
            key={item.id}
            className={`activity-ruler__tick activity-ruler__tick--${item.kind}`}
            data-status={item.status}
            data-selected={index === selectedIndex ? '' : undefined}
            style={{ left: `${scale.fractionOf(index) * 100}%` }}
          />
        ))}
        </div>
      </div>
      {/* 用户：「时间只显示分钟太不友好了, 应该显示从什么时间点到什么时间点, 消耗的时分秒」。
          原先这里只有一个 `+184m03s` 式的偏移量——既没有真正的时刻，小时也被压进分钟位。现在三个
          事实一次给全：起、止、耗时。ordinal 轴给 null（那条轴上没有流逝的时间），此时不渲染。 */}
      {span ? (
        <span className="activity-ruler__span" title={`${span.from} → ${span.to} · ${span.elapsed} elapsed`}>
          <span className="activity-ruler__span-range">{span.from}<span className="activity-ruler__span-arrow" aria-hidden="true">→</span>{span.to}</span>
          <span className="activity-ruler__span-elapsed">{span.elapsed}</span>
        </span>
      ) : null}
      <span
        className="activity-ruler__note"
        title="Structured Session activity only · never Terminal output or private chain-of-thought"
      >
        <Info size={12} />
      </span>
      {readout ? (
        <div
          className="activity-ruler__readout"
          data-placement={readout.placement}
          data-body={readout.body.kind}
          role="status"
          style={{ left: readout.left, top: readout.top }}
        >
          {readout.body.kind === 'quote' ? (
            <Fragment>
              <span className="activity-ruler__readout-speaker">{readout.body.name}</span>
              <span className="activity-ruler__readout-quote">{readout.body.quote}</span>
            </Fragment>
          ) : readout.body.text.axis === 'temporal' ? (
            <Fragment>
              <span className="activity-ruler__readout-time">
                {formatClock(readout.body.text.at)}
              </span>
              <span className="activity-ruler__readout-offset">{readout.body.text.offsetText} from start</span>
            </Fragment>
          ) : (
            <span className="activity-ruler__readout-ordinal">
              Event {readout.body.text.ordinal} of {readout.body.text.total}
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}

function Row({
  item,
  origin,
  count,
  showSource
}: {
  item: AgentTimelineItem
  origin: number
  count: number
  showSource: boolean
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
    if (!payload) return null
    const fromTool = item.toolInput ? toolCallToDiff(item.title, item.toolInput) : null
    return fromTool ?? parseUnifiedDiff(payload)
  }, [payload, item.toolInput, item.title])
  // 折叠起来的一行只有裸工具名时，三行 `Bash` 分不出跑的是哪条命令——而不展开就认得出，
  // 正是折叠的前提。带上那个最具识别性的参数。
  const heading = stepTitle(item.title, item.toolName, item.toolInput)

  return (
    <Fragment>
      {expandable ? (
        <button
          type="button"
          className={`log-row log-row--${item.kind}`}
          data-status={item.status}
          data-expandable=""
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="log-row__node"><Glyph kind={item.kind} /></span>
          <span className="log-row__time">{formatOffset(item.createdAt, origin)}</span>
          <span className="log-row__title">
            {heading}
            {count > 1 ? <span className="log-row__count">×{count}</span> : null}
          </span>
          <span className="log-row__meta">
            {item.status === 'streaming' ? <span className="log-row__chip">Streaming</span> : null}
            {item.status === 'failed' ? <span className="log-row__chip log-row__chip--failed">Failed</span> : null}
            <span className="log-row__source" data-persistent={showSource ? '' : undefined}>{item.source}</span>
            <ChevronRight size={12} className="log-row__chevron" data-open={open ? '' : undefined} />
          </span>
        </button>
      ) : (
        <div className={`log-row log-row--${item.kind}`} data-status={item.status}>
          <span className="log-row__node"><Glyph kind={item.kind} /></span>
          <span className="log-row__time">{formatOffset(item.createdAt, origin)}</span>
          <span className="log-row__title">
            {heading}
            {count > 1 ? <span className="log-row__count">×{count}</span> : null}
          </span>
          <span className="log-row__meta">
            {item.status === 'streaming' ? <span className="log-row__chip">Streaming</span> : null}
            {item.status === 'failed' ? <span className="log-row__chip log-row__chip--failed">Failed</span> : null}
            <span className="log-row__source" data-persistent={showSource ? '' : undefined}>{item.source}</span>
          </span>
        </div>
      )}
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

/**
 * A readable conversation turn — the second register threaded on the same spine as the machine Row. It
 * shares the log's 20px node hole-punch so chronology is unbroken, but the substance is the words: the
 * caption is a quiet speaker tag, and the body is the largest, brightest text in the view. Never folded,
 * always on screen. This is the register the machine Row deliberately is not.
 */
function Turn({
  item,
  origin,
  speaker,
  describeSpeaker,
  openWorkspaceFile,
  openHttpLink,
  workspaceRoot
}: {
  item: AgentTimelineItem
  origin: number
  /** 这一轮的说话人。由调用方从唯一判据（`speakerOf`）取得——Turn 只在有说话人时才被渲染。 */
  speaker: ConversationSpeaker
  describeSpeaker?: DescribeSpeaker
  openWorkspaceFile?: OpenWorkspaceFile
  openHttpLink?: (url: string, event: LinkClickModifiers) => void
  workspaceRoot: string
}) {
  // 形状由**身份**驱动，不由 kind。这是本任务的全部：`log-turn--${item.kind}` 会让「谁说的」永远
  // 只有两种可能，A2A 落地后第三个身份无处可去；而 `data-speaker-role` 上挂的是身份判定的结论。
  // role 是**画法**的维度（human 一种画法、agent 一种画法），身份本身是 speaker.id——所以这里没有
  // 把开放集压回二值：多个 Agent 共享 `agent` 这一种画法，各自的头像与名字仍然不同。
  const described = describeSpeaker?.(speaker)
  return (
    <div className="log-turn" data-speaker-role={speaker.role} data-status={item.status}>
      <span className="log-turn__node">
        {/* 头像与两条轴上用的是同一个组件、同一套身份表示——不是「正文一套、轴一套」。缺 describe
            时退回 role 形状（人形/Bot），因为没有名字的头像认不出谁，此时颜色与图标也不再承载身份。 */}
        <ConversationSpeakerAvatar
          speaker={speaker}
          name={described?.name ?? (speaker.role === 'human' ? 'You' : 'Agent')}
          size={20}
          {...(described?.providerId === undefined ? {} : { providerId: described.providerId })}
        />
      </span>
      <div className="log-turn__head">
        {/* 名字是身份的判别器（同 provider 的两个 Agent 共用一枚图标、色相有 52% 概率撞在 20° 内，
            已实测），所以 caption 给的是 describe 出来的名字，不是 role 的字面量。 */}
        <span className="log-turn__who">{described?.name ?? (speaker.role === 'human' ? 'You' : 'Assistant')}</span>
        {item.status === 'streaming' ? <span className="log-row__chip">Streaming</span> : null}
        {item.status === 'failed' ? <span className="log-row__chip log-row__chip--failed">Failed</span> : null}
        {/* 回合上给**时刻**，机器行仍给偏移量。这两路问的不是同一个问题：一条 tool_call 关心的是
            "距开始多久"（它属于某一段执行），而一句话关心的是"什么时候说的"。时刻带 title 里的
            偏移量兜底，两个事实都答得出而只占一列宽。 */}
        <span className="log-turn__time" title={`${formatClock(item.createdAt)} · ${formatOffset(item.createdAt, origin)} from start`}>
          {formatClock(item.createdAt)}
        </span>
      </div>
      {/* Only the TURN register renders markdown. The machine Row (log-row__prose) stays plain text: it
          carries payload, not prose someone reads for meaning. */}
      {item.content ? (
        <AgentMarkdown
          content={item.content}
          className="log-turn__body"
          workspaceRoot={workspaceRoot}
          {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
          {...(openHttpLink ? { openHttpLink } : {})}
        />
      ) : null}
    </div>
  )
}

function Run({ items, origin }: { items: AgentTimelineItem[]; origin: number }) {
  const [open, setOpen] = useState(false)
  const rows = useMemo(() => timelineRows(items), [items])
  const failed = items.some((item) => item.status === 'failed')
  // 折起来的一段机器执行正是最需要"这段花了多久"的地方——它是被藏起来的那部分时间。
  //
  // 起点是第一条的 createdAt（PreToolUse，那一步**开始**），终点必须是最后完成的那个 updatedAt
  // （PostToolUse，那一步**结束**）——不是最后一条的 createdAt。一段执行的末步往往是最贵的那一步
  // （build、跑测试、大文件操作），用"末步开始"当终点会系统性地把它整段跑的时间漏掉：一个藏着五分钟
  // 构建的折叠头会宣称自己只有 1 秒。取 max 而不是末条的 updatedAt，是因为并发的几步完成顺序不必
  // 跟着开始顺序。存储侧保证 updatedAt >= createdAt（session-timeline 建条时就拦），所以差非负。
  //
  // 同一时刻的一段（或只有一条且瞬时完成）跨度为零，此时不渲染那一件，不硬报一个 `0s`——与序数轴
  // 同一条诚实规则。
  const elapsed = Math.max(...items.map((item) => item.updatedAt)) - items[0]!.createdAt

  return (
    <Fragment>
      <button
        type="button"
        className="log-fold"
        data-open={open ? '' : undefined}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="log-fold__node"><ChevronRight size={12} className="log-fold__chevron" /></span>
        <span className="log-row__time">{formatOffset(items[0]!.createdAt, origin)}</span>
        <span className="log-fold__label">
          {items.length} steps
          {elapsed > 0 ? <span className="log-fold__elapsed">{formatDuration(elapsed)}</span> : null}
          {rows.length < items.length ? <span className="log-row__count">{rows.length} unique</span> : null}
          {failed ? <span className="log-row__chip log-row__chip--failed">FAILED</span> : null}
        </span>
      </button>
      {open
        ? rows.map(({ item, count }, index) => (
            <Row key={item.id} item={item} origin={origin} count={count} showSource={index === 0} />
          ))
        : null}
    </Fragment>
  )
}

/** A segment paired with the half-open range of event indices it covers, so a position on the ruler
 *  can find the row that hosts that event and the band can read which events are on screen. */
type PlacedSegment = { entry: Segment; key: string; from: number; to: number }

function placeSegments(segments: Segment[]): PlacedSegment[] {
  const placed: PlacedSegment[] = []
  let index = 0
  for (const entry of segments) {
    const size = entry.kind === 'run' ? entry.items.length : 1
    const key = entry.kind === 'run' ? entry.id : entry.item.id
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

export function ActivityView({
  items,
  capability,
  displayState,
  openWorkspaceFile,
  openHttpLink,
  workspaceRoot = '',
  describeSpeaker
}: {
  items: AgentTimelineItem[]
  capability: 'unavailable' | 'complete-events' | 'streaming'
  /** Session 的显示状态——「这个 turn 在不在工作」的唯一真相，不从时间轴形状反推。 */
  displayState?: AgentDisplayState
  /** Absent means file references in agent prose stay plain text. */
  openWorkspaceFile?: OpenWorkspaceFile
  /** Absent means an http(s) link in agent prose raises no menu. Set by the host that owns the
   *  destination menu and the Region origin (SessionPane), never resolved here. */
  openHttpLink?: (url: string, event: LinkClickModifiers) => void
  workspaceRoot?: string
  /**
   * 把一个说话人身份解析成「叫什么、画哪个 provider 的图标」。由持有 Session 的那一层给出——
   * 本组件不读 Store，所以 `providerId` 与显示名只能从外面进来。缺省时两条对话轴不渲染：轴的
   * 价值在于认出身份，没有名字的头像认不出谁，画出来只是一排装饰。
   */
  describeSpeaker?: DescribeSpeaker
}) {
  const segments = useMemo(() => segment(items), [items])
  const placed = useMemo(() => placeSegments(segments), [segments])
  const origin = items[0]?.createdAt ?? 0
  // The scale is the single source both the ruler and the log read from — width is irrelevant to it
  // because every position is expressed as a 0..1 fraction and rendered as a percentage.
  const scale = useMemo(() => createRulerScale(items.map((item) => item.createdAt), 1), [items])

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [visible, setVisible] = useState<{ from: number; to: number } | null>(null)
  const band = useMemo(() => rulerBand(scale, visible), [scale, visible])

  const logRef = useRef<HTMLDivElement>(null)
  // 跟随状态是一个**值**，判定全在 lib 里；组件只负责把几何量喂进去、把决定执行掉。
  // 这样"什么时候该贴底"能被断言，而不是埋在一个 effect 里——本仓库测试不跑 effect。
  const followRef = useRef(initFollowState())
  const [showJump, setShowJump] = useState(false)

  const feedGeometry = (): ScrollGeometry | null => {
    const el = logRef.current?.closest('.activity-feed')
    if (!(el instanceof HTMLElement)) return null
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  }

  const pinToBottom = (): void => {
    const el = logRef.current?.closest('.activity-feed')
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
    const el = logRef.current?.closest('.activity-feed')
    if (!(el instanceof HTMLElement)) return
    const handle = (): void => {
      const geometry = feedGeometry()
      if (!geometry) return
      followRef.current = onScroll(followRef.current, geometry)
      setShowJump(shouldShowJumpToLatest(followRef.current))
    }
    el.addEventListener('scroll', handle, { passive: true })
    return () => el.removeEventListener('scroll', handle)
  }, [])

  // 新内容到达时贴底。追加与原地变长都算"新内容"——流式回答最常见的形态正是后者（尾项没换，
  // 只是变长了）。只有仍在跟随时才贴，否则会把已经滚上去的读者拽回来。
  useEffect(() => {
    const geometry = feedGeometry()
    if (!geometry) return
    const last = items.at(-1)
    const decision = onContentChange(followRef.current, {
      itemCount: items.length,
      lastItemId: last?.id ?? null,
      lastItemLength: last?.content?.length ?? 0
    }, geometry)
    followRef.current = decision.state
    if (decision.scrollToBottom) pinToBottom()
    setShowJump(shouldShowJumpToLatest(followRef.current))
  }, [items])

  // Segment elements keyed by segment key, so a resolved event index can find its host row and the
  // observer can watch each one.
  const segmentEls = useRef(new Map<string, HTMLElement>())

  const segmentForIndex = (index: number): PlacedSegment | undefined =>
    placed.find((entry) => index >= entry.from && index <= entry.to)

  const selectEvent = (index: number): void => {
    setSelectedIndex(index)
    const host = segmentForIndex(index)
    const el = host ? segmentEls.current.get(host.key) : undefined
    // Reuse the same scroll primitive the rest of the app uses to bring a row into view; there is no
    // second scroll controller for the Activity log.
    el?.scrollIntoView({ block: 'nearest' })
  }

  // The visible-range band is driven by an IntersectionObserver, not by a scroll handler: the browser
  // reports crossings when they happen instead of us recomputing layout on every scroll frame. This is
  // what keeps a reading decoration out of the scroll hot path.
  useEffect(() => {
    const root = logRef.current?.closest('.activity-feed')
    if (!(root instanceof HTMLElement)) return
    const onscreen = new Set<string>()
    const ranges = new Map(placed.map((entry) => [entry.key, { from: entry.from, to: entry.to }]))
    const recompute = (): void => {
      let from = Infinity
      let to = -Infinity
      for (const key of onscreen) {
        const range = ranges.get(key)
        if (!range) continue
        from = Math.min(from, range.from)
        to = Math.max(to, range.to)
      }
      setVisible(to >= from ? { from, to } : null)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.segmentKey
          if (!key) continue
          if (entry.isIntersecting) onscreen.add(key)
          else onscreen.delete(key)
        }
        recompute()
      },
      // The sticky ruler occupies the top of the scroll port; discount it so a row hidden behind the
      // ruler is not counted as visible.
      { root, rootMargin: '-34px 0px 0px 0px', threshold: 0 }
    )
    for (const el of segmentEls.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [placed])

  if (capability === 'unavailable') {
    return (
      <div className="activity-feed">
        <div className="activity-feed__empty">
          This executor does not provide structured activity. Terminal remains available.
        </div>
      </div>
    )
  }
  if (showEmptyState(displayState, items)) {
    return (
      <div className="activity-feed">
        <div className="activity-feed__empty">
          No structured activity yet. Terminal remains available.
        </div>
      </div>
    )
  }
  // 正在想、但首行还没落地：显示"在进行"而不是空状态。一个正在工作的东西显示成空，
  // 比慢更糟——用户会以为自己没发出去，然后再发一遍。
  if (items.length === 0) {
    return (
      <div className="activity-feed">
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
    <div className="activity-feed">
      <Ruler
        items={items}
        scale={scale}
        selectedIndex={selectedIndex}
        band={band}
        onSelect={selectEvent}
        axes={({ onPeek, onPeekEnd }) =>
          describeSpeaker ? (
            // 两条轴在既有 ruler **之上**分轴，而不是替换它：ruler 那三条更强的性质（诚实时间轴、
            // 每行偏移、无跨度时退化为序数）是既有资产。轴与 track 由 `Ruler` 摆进同一个坐标盒，
            // 所以「同一个 fraction 落在同一个像素」这句话在布局上真的成立，而不只是两个都写着
            // 同一个百分比——后者在两个不同宽度的盒里是两个位置。
            //
            // 顺序是「说话人在上、自我 Agent 在下、主刻度在最下」：自上而下正是从"谁在说话"到
            // "这个 Agent 在干什么"到"整条时间轴"的收敛，越往下越细。
            //
            // 面板出口（onPeek/onPeekEnd）由 Ruler 递进来：面板与主刻度的 readout 是同一个浮层，
            // 而它的锚定要用 Ruler 才有的那个共享坐标盒。这一层只补上身份解析。
            <Fragment>
              <ConversationAxis
                items={items}
                belongs={speaksAsHuman}
                label="Speakers"
                size={16}
                describe={describeSpeaker}
                selectedIndex={selectedIndex}
                onSelect={selectEvent}
                onPeek={onPeek}
                onPeekEnd={onPeekEnd}
              />
              <ConversationAxis
                items={items}
                belongs={speaksAsAgent}
                label="This agent"
                size={16}
                describe={describeSpeaker}
                selectedIndex={selectedIndex}
                onSelect={selectEvent}
                onPeek={onPeek}
                onPeekEnd={onPeekEnd}
              />
            </Fragment>
          ) : null
        }
      />
      <div className="activity-log" ref={logRef}>
        {placed.map(({ entry, key, from }) => {
          // 判据只问一次：`speakerOf` 的**结论**既决定走哪个寄存器，又是 Turn 需要的那个身份。
          // 原先这里问 `isConversationTurn`、Turn 里再问一遍 `speakerOf`，两处必须一致却各调一次；
          // 现在结论直接传下去，Turn 拿到的是非空身份，"有说话人"与"是一轮对话"不可能再漂移。
          const speaker = entry.kind === 'run' ? null : speakerOf(entry.item)
          return (
            // One wrapper per segment carries the scroll target, the observer key, and the selection
            // marker, so the three log registers below stay unaware of the ruler wiring.
            <div
              key={key}
              className="activity-log__segment"
              ref={registerSegment(key)}
            >
              {entry.kind === 'run' ? (
                <Run items={entry.items} origin={origin} />
              ) : speaker ? (
                <Turn
                  item={entry.item}
                  origin={origin}
                  speaker={speaker}
                  workspaceRoot={workspaceRoot}
                  {...(describeSpeaker ? { describeSpeaker } : {})}
                  {...(openWorkspaceFile ? { openWorkspaceFile } : {})}
                  {...(openHttpLink ? { openHttpLink } : {})}
                />
              ) : (
                <Row item={entry.item} origin={origin} count={1} showSource />
              )}
            </div>
          )
        })}
      </div>
      {showWorkingIndicator(displayState, items) ? <WorkingIndicator /> : null}
      {showJump ? (
        <button type="button" className="activity-feed__jump" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  )
}
