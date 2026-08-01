import { describe, expect, it } from 'vitest'
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
  type RulerReadout
} from '../src/renderer/src/lib/activity-ruler.js'

describe('activity ruler mapping', () => {
  it('places events at their real elapsed fraction on a temporal axis', () => {
    // 1000, 3000, 5000 → the middle event sits exactly halfway along a 200px track.
    const scale = createRulerScale([1_000, 3_000, 5_000], 200)
    expect(scale.axis).toBe('temporal')
    expect(scale.fractionOf(0)).toBe(0)
    expect(scale.fractionOf(1)).toBeCloseTo(0.5, 10)
    expect(scale.fractionOf(2)).toBe(1)
    expect(scale.positionOf(1)).toBeCloseTo(100, 10)
  })

  it('round-trips position → data → position onto the same pixel', () => {
    // Uneven gaps so a bug that mixed ordinal and temporal math would land on a different pixel.
    const scale = createRulerScale([0, 250, 1_000, 4_000], 400)
    for (let i = 0; i < scale.count; i += 1) {
      const pixel = scale.positionOf(i)
      const readout = scale.readoutAt(pixel)
      expect(readout).not.toBeNull()
      // The position we came from maps back to the same event, and thus the same pixel.
      expect(readout!.index).toBe(i)
      expect(scale.positionOf(readout!.index)).toBeCloseTo(pixel, 6)
    }
  })

  it('snaps a click between two events to the nearer real event, never an interpolated instant', () => {
    const scale = createRulerScale([0, 100, 900, 1_000], 100)
    // Fractions: 0, .1, .9, 1. A point at .12 is closest to event 1 (.10), not event 2 (.90).
    const near = scale.readoutAtFraction(0.12)
    expect(near!.index).toBe(1)
    // Exactly between event 1 (.10) and event 2 (.90) is .50; both are .40 away → deterministic lower.
    const midpoint = scale.readoutAtFraction(0.5)
    expect(midpoint!.index).toBe(1)
    // A temporal readout reports a real recorded moment — the event's own timestamp, not a blend.
    expect(near).toMatchObject<Partial<RulerReadout>>({ axis: 'temporal' })
    if (near!.axis === 'temporal') expect(near!.at).toBe(100)
  })

  it('collapses to an ordinal axis with NO moment when every event shares one instant', () => {
    const scale = createRulerScale([7, 7, 7], 300)
    expect(scale.axis).toBe('ordinal')
    // Ordinal spacing is even, so the ticks do not stack on the left edge.
    expect(scale.fractionOf(0)).toBe(0)
    expect(scale.fractionOf(1)).toBeCloseTo(0.5, 10)
    expect(scale.fractionOf(2)).toBe(1)

    const readout = scale.readoutAtFraction(0.5)
    expect(readout!.axis).toBe('ordinal')
    // The honesty contract, enforced by the type: an ordinal readout has no `at` to render a time
    // from. Reading it off the object proves no moment leaked in under a zero-span axis.
    expect((readout as { at?: number }).at).toBeUndefined()
  })

  it('describes a zero-span readout as an ordinal only — no clock time, no offset', () => {
    const scale = createRulerScale([7, 7, 7], 300)
    const text = describeReadout(scale.readoutOf(1), scale.count)
    expect(text.axis).toBe('ordinal')
    expect(text.summary).toBe('Event 2 of 3')
    // If a moment or offset ever appeared here it would be fabricated precision.
    expect((text as { at?: number }).at).toBeUndefined()
    expect((text as { offsetText?: string }).offsetText).toBeUndefined()
  })

  it('describes a spanning readout with both a moment and a labelled offset from start', () => {
    const scale = createRulerScale([1_000, 3_500], 200)
    const text = describeReadout(scale.readoutOf(1), scale.count)
    expect(text.axis).toBe('temporal')
    if (text.axis === 'temporal') {
      expect(text.at).toBe(3_500) // the event's absolute recorded moment
      expect(text.offsetMs).toBe(2_500) // relative to the first event (the origin)
      expect(text.offsetText).toBe('+2.5s') // the offset register says it is relative to start
      expect(text.summary).toContain('from start')
    }
  })

  it('does not throw on empty, single-event, or zero-width inputs', () => {
    const empty = createRulerScale([], 100)
    expect(empty.count).toBe(0)
    expect(empty.readoutAt(50)).toBeNull()
    expect(empty.readoutAtFraction(0.5)).toBeNull()
    expect(() => empty.positionOf(0)).not.toThrow()

    const single = createRulerScale([42], 100)
    expect(single.axis).toBe('ordinal') // one event has no spread
    expect(single.fractionOf(0)).toBe(0)
    expect(single.readoutAtFraction(0.9)!.index).toBe(0)

    const zeroWidth = createRulerScale([0, 1_000, 2_000], 0)
    expect(zeroWidth.positionOf(2)).toBe(0) // nothing divides by width
    expect(() => zeroWidth.readoutAt(0)).not.toThrow()
    expect(zeroWidth.readoutAt(0)!.index).toBe(0)
  })

  it('clamps out-of-range indices and non-finite inputs instead of throwing', () => {
    const scale = createRulerScale([0, 1_000], 100)
    expect(scale.fractionOf(-5)).toBe(0)
    expect(scale.fractionOf(99)).toBe(1)
    expect(scale.readoutAtFraction(Number.NaN)!.index).toBe(0)
    expect(scale.readoutAtFraction(5)!.index).toBe(1) // past the end clamps to last
  })

  describe('keyboard selection', () => {
    it('enters on the first event going forward and the last going backward', () => {
      expect(stepRulerSelection(null, 'ArrowRight', 4)).toBe(0)
      expect(stepRulerSelection(null, 'Home', 4)).toBe(0)
      expect(stepRulerSelection(null, 'ArrowLeft', 4)).toBe(3)
      expect(stepRulerSelection(null, 'End', 4)).toBe(3)
    })

    it('steps by one and clamps at the ends', () => {
      expect(stepRulerSelection(1, 'ArrowRight', 4)).toBe(2)
      expect(stepRulerSelection(1, 'ArrowLeft', 4)).toBe(0)
      expect(stepRulerSelection(0, 'ArrowLeft', 4)).toBe(0) // no wrap past the start
      expect(stepRulerSelection(3, 'ArrowRight', 4)).toBe(3) // no wrap past the end
      expect(stepRulerSelection(2, 'Home', 4)).toBe(0)
      expect(stepRulerSelection(2, 'End', 4)).toBe(3)
    })

    it('ignores unrelated keys and refuses to select when there are no events', () => {
      expect(stepRulerSelection(2, 'a', 4)).toBe(2)
      expect(stepRulerSelection(null, 'ArrowRight', 0)).toBeNull()
    })
  })

  describe('visible range band', () => {
    it('derives the band edges from the first and last visible events', () => {
      const scale = createRulerScale([0, 1_000, 2_000, 3_000, 4_000], 100)
      const band = rulerBand(scale, { from: 1, to: 3 })
      expect(band).not.toBeNull()
      expect(band!.startOrdinal).toBe(2)
      expect(band!.endOrdinal).toBe(4)
      expect(band!.startFraction).toBeCloseTo(0.25, 10)
      expect(band!.endFraction).toBeCloseTo(0.75, 10)
    })

    it('shows no band when everything is visible — no full-width fake frame', () => {
      const scale = createRulerScale([0, 1_000, 2_000, 3_000], 100)
      expect(rulerBand(scale, { from: 0, to: 3 })).toBeNull()
    })

    it('shows no band when nothing is visible or the log is too short to have a range', () => {
      const scale = createRulerScale([0, 1_000, 2_000], 100)
      expect(rulerBand(scale, null)).toBeNull()
      const lone = createRulerScale([0], 100)
      expect(rulerBand(lone, { from: 0, to: 0 })).toBeNull()
    })

    it('stays meaningful on an ordinal axis — it frames which events, not a time span', () => {
      const scale = createRulerScale([5, 5, 5, 5], 100)
      const band = rulerBand(scale, { from: 1, to: 2 })
      expect(band).not.toBeNull()
      expect(band!.startOrdinal).toBe(2)
      expect(band!.endOrdinal).toBe(3)
      // Ordinal fractions are evenly spaced, so the band still lands on real tick positions.
      expect(band!.startFraction).toBeCloseTo(1 / 3, 10)
      expect(band!.endFraction).toBeCloseTo(2 / 3, 10)
    })
  })

  it('formats offsets in ms, seconds, and minutes with a leading sign', () => {
    expect(formatOffset(400, 0)).toBe('+400ms')
    expect(formatOffset(2_500, 0)).toBe('+2.5s')
    expect(formatOffset(125_000, 0)).toBe('+2m05s')
    expect(formatOffset(0, 5_000)).toBe('+0ms') // never negative
  })

  /**
   * 用户：「时间只显示分钟太不友好了, 应该显示从什么时间点到什么时间点, 消耗的时分秒」。
   *
   * 这一组守的是那句话的三个部分：耗时要有小时位、时刻要读得出、以及两个时刻加一段耗时一次给全。
   */
  describe('时分秒读数', () => {
    it('跑过一小时就报小时位，不再把三小时说成 184 分钟', () => {
      // 这正是用户报的那个缺陷的形状：一次跑了 3 小时 4 分 3 秒。封顶在分钟的实现给出 `184m03s`，
      // 读者得自己去除以 60。断言同时正向要小时、反向拒绝那个分钟数——只写正向的话，一个
      // 「小时位与分钟位都报」的错实现（`3h184m03s`）也能过。
      const threeHours = 3 * 3_600_000 + 4 * 60_000 + 3_000
      expect(formatDuration(threeHours)).toBe('3h04m03s')
      expect(formatDuration(threeHours)).not.toContain('184')
      // 偏移量走的是同一个函数，所以时间沟里的读数也拿到小时位——那才是这条修复真正落地的地方。
      expect(formatOffset(threeHours, 0)).toBe('+3h04m03s')
    })

    it('每一档的边界各在该跳的地方跳，低位补零', () => {
      expect(formatDuration(0)).toBe('0ms')
      expect(formatDuration(999)).toBe('999ms')
      expect(formatDuration(1_000)).toBe('1.0s')
      expect(formatDuration(59_900)).toBe('59.9s')
      // 60 秒整不再是 `60.0s`：进位到分钟档。
      expect(formatDuration(60_000)).toBe('1m00s')
      expect(formatDuration(3_599_000)).toBe('59m59s')
      // 而分钟不封顶在 59：满一小时进位，且此时分钟与秒都补零（等宽下不跳位）。
      expect(formatDuration(3_600_000)).toBe('1h00m00s')
      // 负数与非整数不产生 `-0m00s` / `4.7m` 这类读数。
      expect(formatDuration(-5_000)).toBe('0ms')
      expect(formatDuration(1_500.9)).toBe('1.5s')
    })

    it('时刻是固定宽度的 24 小时读数，不随 locale 变宽', () => {
      // 用本地时间构造，于是断言与跑测试的时区无关——两侧都在同一个时区里说话。
      const morning = new Date(2026, 0, 2, 9, 3, 7).getTime()
      expect(formatClock(morning)).toBe('09:03:07')
      const afternoon = new Date(2026, 0, 2, 14, 3, 7).getTime()
      expect(formatClock(afternoon)).toBe('14:03:07')
      // 这两条是"必须能在等宽的时间沟里列对齐"的判据：同一个宽度、没有 AM/PM 尾巴。
      // `toLocaleTimeString` 会给出 `9:03:07 AM`（宽度随小时变、还多一截），两条都会红。
      expect(formatClock(morning)).toHaveLength(formatClock(afternoon).length)
      expect(formatClock(morning)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    })

    it('一段时间跨度一次给出起、止、耗时；序数轴上不给', () => {
      const origin = new Date(2026, 0, 2, 14, 0, 0).getTime()
      const scale = createRulerScale([origin, origin + 60_000, origin + 3 * 3_600_000], 200)
      const span = describeSpan(scale)
      expect(span).not.toBeNull()
      expect(span!.from).toBe('14:00:00')
      // 止是**最后一个事件**的时刻，不是起点也不是中间那个：origin + 3h。
      expect(span!.to).toBe('17:00:00')
      expect(span!.elapsed).toBe('3h00m00s')

      // 零跨度的轴上间距表达的是顺序而不是流逝的时间，硬报一个 `0s` 耗时就是把 ruler 特意做成
      // 类型上不可表达的那种不诚实又请了回来。
      const flat = createRulerScale([origin, origin, origin], 200)
      expect(flat.axis).toBe('ordinal')
      expect(describeSpan(flat)).toBeNull()
    })

    it('读屏用户拿到的也是时分秒，且那串数字没被啃掉一位', () => {
      // 可访问名走 formatDuration 而不是 `formatOffset(...).slice(1)`：后者是"格式化成 `+3h00m00s`
      // 再把加号切掉"，一旦前缀变了就会啃掉一位数字。断言里既要有小时位，也要拒绝残留的正号。
      const origin = new Date(2026, 0, 2, 14, 0, 0).getTime()
      const scale = createRulerScale([origin, origin + 3 * 3_600_000], 200)
      expect(describeRulerAxis(scale)).toBe('Activity timeline, 2 events over 3h00m00s')
      const flat = createRulerScale([origin, origin], 200)
      expect(describeRulerAxis(flat)).toBe('Activity timeline, 2 events in order')
    })
  })
})
