import { Info } from 'lucide-react'
import { Fragment, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { AgentActivityHistoryProjection } from '@agentmux/core'
import { describeReadout, describeRulerAxis, describeSpan, rulerBand, stepRulerSelection, type RulerReadoutText, type RulerScale } from '../lib/activity-ruler'
import { formatClock } from '@agentmux/client-ui/conversation-time'
import type { RulerAxisItem, ConversationAxisMark } from '../lib/conversation-axis'
import { conversationRulerDensity, rulerRecordQuote } from '../lib/conversation-ruler'
import { terminalLinkPreviewAnchor } from '../lib/terminal-link-gesture'
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
  axes,
  controls,
  recentFraction = 0,
  activity = []
}: {
  items: readonly RulerAxisItem[]
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
  controls?: (close: () => boolean) => ReactNode
  recentFraction?: number | null
  activity?: AgentActivityHistoryProjection['segments']
  axes?: (peek: {
    width: number
    onPeek: (peek: { rect: DOMRect; mark: ConversationAxisMark; name: string }) => void
    onPeekEnd: () => boolean
  }) => JSX.Element | null
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [readout, setReadout] = useState<Readout | null>(null)
  const [trackWidth, setTrackWidth] = useState(0)
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const measure = (): void => setTrackWidth(track.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(track)
    return () => observer.disconnect()
  }, [])
  const density = useMemo(() => conversationRulerDensity(items, trackWidth), [items, trackWidth])
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
    const quote = rulerRecordQuote(mark.item)
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
      {/* Summary sits above one full-width coordinate box shared by axes and ticks. */}
      <div className="activity-ruler__stack">
        {axes?.({ width: trackWidth, onPeek: showQuote, onPeekEnd: closeReadout })}
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
        {scale.axis === 'temporal' ? <>
          {recentFraction !== null && recentFraction > 0 && recentFraction < 1 ? <span className="conversation-ruler__cutoff" style={{ left: `${recentFraction * 100}%` }} title="Latest recorded hour starts here" /> : null}
          <span className="conversation-ruler__recent" style={{ left: `${Math.max(0, Math.min(1, recentFraction ?? 0)) * 100}%` }} aria-hidden="true" />
          {density.map((bin, index) => bin.count > 0 ? <span key={index} className="conversation-ruler__density"
            data-era={recentFraction === null ? undefined : bin.left < recentFraction ? 'history' : 'recent'}
            style={{ left: `${bin.left * 100}%`, width: `${bin.width * 100}%`, height: `${2 + bin.strength * 5}px` }}
            title={`${bin.count} loaded records · Recorded density, not execution`} /> : null)}
          {activity.map(segment => {
            if (segment.endAt === null || segment.end === 'observation-gap' || segment.end === 'unknown' || segment.startAt > scale.origin + scale.span || segment.endAt < scale.origin) return null
            const left = Math.max(0, (segment.startAt - scale.origin) / scale.span)
            const right = Math.min(1, (segment.endAt - scale.origin) / scale.span)
            return <span key={segment.observationId} className="conversation-ruler__activity" data-state={segment.state}
              style={{ left: `${left * 100}%`, width: `${Math.max(0, right - left) * 100}%` }}
              title={`Recorded ${segment.state}${segment.detail ? ` · ${segment.detail}` : ''}${segment.startKnown ? '' : ' · Start not recorded'}`} />
          })}
        </> : null}
        {band ? (
          <span
            className="activity-ruler__band"
            data-axis={scale.axis}
            style={{ left: `min(${band.startFraction * 100}%, calc(100% - 3px))`, right: `${(1 - band.endFraction) * 100}%` }}
            aria-hidden="true"
          />
        ) : null}
        {items.map((item, index) => {
          const raw = 'kind' in item && item.kind === 'ruler-record' ? item.record : item
          const status = 'status' in raw ? raw.status : 'deliveryStatus' in raw ? raw.deliveryStatus : undefined
          // Density replaces repeated ticks. Keep failure, ordinal and selected records identifiable.
          if (scale.axis === 'temporal' && status !== 'failed' && index !== selectedIndex) return null
          return <span key={item.id} className="activity-ruler__tick" data-status={status}
            data-selected={index === selectedIndex ? '' : undefined} style={{ left: `${scale.fractionOf(index) * 100}%` }} />
        })}
        </div>
      </div>
      <div className="activity-ruler__summary">
        {span ? <span className="activity-ruler__span" title={`${span.from} → ${span.to} · ${span.elapsed} elapsed`}>
          <span className="activity-ruler__span-range"><span>{span.from}</span><span className="activity-ruler__span-arrow" aria-hidden="true">→</span><span>{span.to}</span></span>

        </span> : <span className="activity-ruler__span">Record order</span>}
        <span className="activity-ruler__count">{scale.count} records</span>
      </div>
      {controls?.(closeReadout)}
      <span
        className="activity-ruler__note"
        title="Loaded records only · Blue: recorded working · Dotted: recorded idle · Amber: awaiting input · Unmarked: unknown · Brighter rail: latest recorded hour · Height: record density"
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
