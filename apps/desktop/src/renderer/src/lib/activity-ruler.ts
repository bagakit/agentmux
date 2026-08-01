/**
 * The one place pixel positions on the Activity ruler and positions on the timeline are converted,
 * in both directions. Click, the visible-range band, and the hover/focus readout all read from a
 * single {@link RulerScale} so they can never disagree on where an event sits — three independent
 * formulas would drift apart at the boundaries.
 *
 * The honesty contract is enforced in the *type*, not by discipline: when the events carry no time
 * spread (all at one instant, or a lone event), a readout is an `ordinal` variant with no `at`
 * field. There is nothing for a caller to render a moment from, so no path can claim a precision the
 * data does not hold. See {@link RulerReadout}.
 */

export type RulerAxis = 'temporal' | 'ordinal'

/**
 * Where a position on the ruler resolves to — always a real event, never an interpolated instant.
 *
 * - `temporal`: the events span real elapsed time, so the readout carries the snapped event's actual
 *   moment (`at`) and its offset from the first event.
 * - `ordinal`: the events carry no spread, so the readout is only "the Nth event". It has no `at`:
 *   the type itself makes a fabricated moment unrepresentable.
 */
export type RulerReadout =
  | { axis: 'temporal'; index: number; at: number; offsetMs: number }
  | { axis: 'ordinal'; index: number }

export type RulerScale = {
  axis: RulerAxis
  /** Number of events on the axis. */
  count: number
  /** Track width in pixels this scale was built for (0 when unknown or degenerate). */
  width: number
  /** Timestamp of the first event, the origin all offsets are measured from. */
  origin: number
  /** Elapsed time between first and last event; 0 collapses the axis to ordinal. */
  span: number
  /** Fraction 0..1 of event `index` along the track — width-independent, drives CSS `left`. */
  fractionOf(index: number): number
  /** Pixel position of event `index` along the track (fraction × width). */
  positionOf(index: number): number
  /** The readout for a known event index (used by hover-on-a-tick and keyboard focus). */
  readoutOf(index: number): RulerReadout
  /** Nearest real event to a 0..1 fraction. null only when there are no events. */
  readoutAtFraction(fraction: number): RulerReadout | null
  /** Nearest real event to a pixel position on the track. null only when there are no events. */
  readoutAt(pixel: number): RulerReadout | null
}

export type RulerReadoutText =
  | { axis: 'ordinal'; ordinal: number; total: number; summary: string }
  | {
      axis: 'temporal'
      ordinal: number
      total: number
      at: number
      offsetMs: number
      /** The offset rendered as a signed, human duration ("+2.3s"). */
      offsetText: string
      summary: string
    }

/** A stretch of the ruler the log is currently showing, in fractions and in event ordinals. */
export type RulerBand = {
  startFraction: number
  endFraction: number
  startOrdinal: number
  endOrdinal: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0
  const i = Math.round(index)
  return clamp(Number.isFinite(i) ? i : 0, 0, count - 1)
}

/**
 * Offset from the first event. Tabular numerals keep the gutter from shifting as it ticks.
 *
 * 整个读数都交给 {@link formatDuration}——一个符号加一段时长，没有第二套分档。原先这里自己重写了
 * 毫秒档与秒档（只有分钟以上才转交），那两行与 formatDuration 完全同义，于是「一个格式化器」这条
 * 只在文档里成立：把 formatDuration 的分档修好之后，时间沟里仍旧印着 `+60.0s`。同一条规则住在两处
 * 就一定会走岔，这一次走岔的是最显眼的那一处——机器行每一行都在读它。
 */
export function formatOffset(createdAt: number, origin: number): string {
  return `+${formatDuration(Math.max(0, createdAt - origin))}`
}

/**
 * 一段时长，按时分秒读出来。
 *
 * 用户：「时间只显示分钟太不友好了, 应该显示从什么时间点到什么时间点, 消耗的时分秒」。这条是那个
 * 「消耗的时分秒」——原先的实现在分钟处封顶，一次跑了三小时的 Session 会显示成 `184m03s`，读者
 * 得自己去除以 60。小时位不是可选的修饰：Agent 跑一下午是这个产品的常态。
 *
 * 只在**非零的最高位**起显示单位，低位补零：`3h04m03s` / `4m03s` / `3.2s` / `840ms`。补零是为了
 * 等宽下不跳位（gutter 里每行都在同一列），而省掉高位的零是为了短跑不必读 `0h00m03s`。
 *
 * 分档必须按**将要显示的那个值**来判，不是按另一个精度的同一时长。秒档显示到 0.1s，所以先把时长
 * 归到十分之一秒，再用这个粒度决定进不进分钟档：否则 `59_950ms` 会以整数秒 59 留在秒档，却被
 * 四舍五入印成 `60.0s`——一个这套记法里不存在的读数。
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms))
  if (total < 1_000) return `${total}ms`
  const tenths = Math.round(total / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`
  const seconds = Math.round(total / 1_000)
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const rest = seconds % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) return `${hours}h${pad(minutes)}m${pad(rest)}s`
  return `${minutes}m${pad(rest)}s`
}

/**
 * 一个时刻的挂钟读数，`HH:MM:SS`，本地时区。
 *
 * 用户要的「从什么时间点到什么时间点」需要真正的时刻，而偏移量答不了这个问题——`+4m03s` 说不出
 * 那是下午两点还是凌晨三点。
 *
 * 固定 24 小时补零而不走 `toLocaleTimeString`：这个读数落在等宽的时间沟里，一列上下必须对齐，而
 * locale 格式的宽度会变（`2:03:07 PM` 比 `14:03:07` 长且长度随小时变化）。日志读数取可预测的
 * 对齐，这也是各类日志查看器的通行做法。
 */
export function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 整段活动的时间跨度：起、止、以及耗时。
 *
 * 这是用户那句话的完整答案，三个事实一次给全。ordinal 轴（所有事件同一时刻，或只有一条）**不给
 * 跨度**：那条轴上的间距表达的是顺序而不是流逝的时间，硬报一个 `0s` 耗时就是把 ruler 特意做成
 * 类型上不可表达的那种不诚实又请了回来。
 */
export function describeSpan(scale: RulerScale): { from: string; to: string; elapsed: string } | null {
  if (scale.axis === 'ordinal') return null
  return {
    from: formatClock(scale.origin),
    to: formatClock(scale.origin + scale.span),
    elapsed: formatDuration(scale.span)
  }
}

/**
 * Build the bidirectional scale from the event timestamps and the ruler's pixel width.
 *
 * A zero (or negative) spread between first and last event — every event at one instant, or a single
 * event, or none — collapses the axis to `ordinal`: positions are spaced by order, and readouts drop
 * the moment. A width of 0 (unmeasured track) is tolerated everywhere; nothing divides by it.
 */
export function createRulerScale(timestamps: readonly number[], width: number): RulerScale {
  const count = timestamps.length
  const origin = count > 0 ? timestamps[0]! : 0
  const last = count > 0 ? timestamps[count - 1]! : 0
  const span = Math.max(0, last - origin)
  const axis: RulerAxis = span > 0 ? 'temporal' : 'ordinal'
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 0

  const fractionOf = (index: number): number => {
    if (count <= 1) return 0
    const i = clampIndex(index, count)
    if (axis === 'temporal') return (timestamps[i]! - origin) / span
    return i / (count - 1)
  }

  const positionOf = (index: number): number => fractionOf(index) * safeWidth

  const readoutOf = (index: number): RulerReadout => {
    const i = clampIndex(index, count)
    if (axis === 'temporal') {
      return { axis: 'temporal', index: i, at: timestamps[i]!, offsetMs: timestamps[i]! - origin }
    }
    return { axis: 'ordinal', index: i }
  }

  const readoutAtFraction = (fraction: number): RulerReadout | null => {
    if (count === 0) return null
    const target = clamp(Number.isFinite(fraction) ? fraction : 0, 0, 1)
    // Snap to the nearest real event. A click between two events resolves to one of them — never to
    // an interpolated instant that no event occupies. A tie keeps the lower index, deterministically.
    let best = 0
    let bestDistance = Infinity
    for (let i = 0; i < count; i += 1) {
      const distance = Math.abs(fractionOf(i) - target)
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    return readoutOf(best)
  }

  const readoutAt = (pixel: number): RulerReadout | null =>
    readoutAtFraction(safeWidth > 0 ? pixel / safeWidth : 0)

  return {
    axis,
    count,
    width: safeWidth,
    origin,
    span,
    fractionOf,
    positionOf,
    readoutOf,
    readoutAtFraction,
    readoutAt
  }
}

/**
 * Turn a readout into the text the ruler shows on hover and keyboard focus.
 *
 * On a temporal axis it carries both registers, each labelled by the caller: the snapped event's
 * absolute moment (`at`, formatted by the view as a clock time) and its offset from the run's start
 * (`offsetText`, already signed). On an ordinal axis it is only "Event N of T" — no moment, no
 * offset, nothing a reader could mistake for a time the data never had.
 */
export function describeReadout(readout: RulerReadout, total: number): RulerReadoutText {
  const ordinal = readout.index + 1
  if (readout.axis === 'ordinal') {
    return { axis: 'ordinal', ordinal, total, summary: `Event ${ordinal} of ${total}` }
  }
  const origin = readout.at - readout.offsetMs
  const offsetText = formatOffset(readout.at, origin)
  return {
    axis: 'temporal',
    ordinal,
    total,
    at: readout.at,
    offsetMs: readout.offsetMs,
    offsetText,
    summary: `Event ${ordinal} of ${total} · ${offsetText} from start`
  }
}

/**
 * Move the keyboard selection along the axis. Arrow/Home/End step by event, clamped to the ends.
 * Entering the axis with nothing selected lands on the first event (forward keys / Home) or the last
 * (backward keys / End), so the first keypress always selects rather than silently doing nothing.
 */
export function stepRulerSelection(
  current: number | null,
  key: string,
  total: number
): number | null {
  if (total <= 0) return null
  const last = total - 1
  if (current === null) {
    switch (key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'Home':
        return 0
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'End':
        return last
      default:
        return null
    }
  }
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return clamp(current - 1, 0, last)
    case 'ArrowRight':
    case 'ArrowDown':
      return clamp(current + 1, 0, last)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return current
  }
}

/**
 * The accessible name for the ruler slider. It states the axis honestly: a temporal axis names the
 * elapsed span, an ordinal axis says the spacing is order only — never implying a duration the data
 * does not carry.
 */
export function describeRulerAxis(scale: RulerScale): string {
  const events = `${scale.count} event${scale.count === 1 ? '' : 's'}`
  if (scale.axis === 'temporal') {
    // 走 formatDuration 而不是 `formatOffset(...).slice(1)`：后者是"格式化成 `+4m03s` 再把加号切
    // 掉"，一旦偏移量的前缀变了（比如某天带上符号位）这里就会啃掉一位数字。要的本来就是一段时长，
    // 直接问那个函数。读屏用户同样拿到时分秒——小时位在这里也不是可选的。
    return `Activity timeline, ${events} over ${formatDuration(scale.span)}`
  }
  return `Activity timeline, ${events} in order`
}

/**
 * The band to draw for the events currently visible in the log, or null when there is nothing
 * honest to draw:
 * - fewer than two events — there is no range to frame;
 * - nothing visible — an empty band would be a lie about what is on screen;
 * - everything visible (the log is shorter than a screen) — a full-width band reads as "all of it is
 *   here" and adds nothing, so it is deliberately suppressed rather than drawn edge to edge.
 *
 * The band's edges sit on the first and last visible *events* (via the shared scale), so it lines up
 * with the ticks instead of estimating a viewport fraction.
 */
export function rulerBand(
  scale: RulerScale,
  visible: { from: number; to: number } | null
): RulerBand | null {
  const total = scale.count
  if (total <= 1 || !visible) return null
  if (!Number.isFinite(visible.from) || !Number.isFinite(visible.to)) return null
  const from = clampIndex(Math.min(visible.from, visible.to), total)
  const to = clampIndex(Math.max(visible.from, visible.to), total)
  if (from <= 0 && to >= total - 1) return null
  return {
    startFraction: scale.fractionOf(from),
    endFraction: scale.fractionOf(to),
    startOrdinal: from + 1,
    endOrdinal: to + 1
  }
}
