import { describe, expect, it, vi } from 'vitest'
import {
  RECONNECT_MAX_ATTEMPTS,
  nextReconnectStep,
  runBoundedReconnect
} from '../src/ctxmux-reconnect.js'

// 「界」是本层唯一要被守卫咬住的判据：把重连改成无限重试必须让这里变红。因此断言直接钉在
// 尝试次数上限、以及「一直失败最终 give-up / exhausted」这条端到端行为上。
describe('nextReconnectStep', () => {
  it('pins the attempt ceiling to a written literal, independent of the constant it exports', () => {
    // 机制断言全用 import 的 RECONNECT_MAX_ATTEMPTS 当期望值——常量与断言会跟着一起漂：把 6 悄悄改成
    // 1（几乎不重连）或 100（几乎打爆 daemon）都不会让那些断言红。这条把上限钉死成写死的字面量，
    // 与派生断言并存：一条守机制（有界/差一/无限→红），一条守「6 这个具体产品数值」本身。
    expect(RECONNECT_MAX_ATTEMPTS).toBe(6)
  })

  it('gives up exactly at the attempt ceiling and never schedules a retry past it', () => {
    // 到达上限即 give-up，绝不再排 retry——这就是「界」。把 >= 改成永不成立就会在这里失败。
    expect(nextReconnectStep(RECONNECT_MAX_ATTEMPTS)).toEqual({
      kind: 'give-up',
      attempts: RECONNECT_MAX_ATTEMPTS
    })
    expect(nextReconnectStep(RECONNECT_MAX_ATTEMPTS + 5)).toEqual({
      kind: 'give-up',
      attempts: RECONNECT_MAX_ATTEMPTS + 5
    })
  })

  it('schedules a retry for every attempt strictly below the ceiling', () => {
    for (let prior = 0; prior < RECONNECT_MAX_ATTEMPTS; prior += 1) {
      const step = nextReconnectStep(prior)
      expect(step.kind).toBe('retry')
      if (step.kind === 'retry') expect(step.attempt).toBe(prior)
    }
  })

  it('backs off monotonically', () => {
    const delays: number[] = []
    for (let prior = 0; prior < RECONNECT_MAX_ATTEMPTS; prior += 1) {
      const step = nextReconnectStep(prior)
      if (step.kind === 'retry') delays.push(step.delayMs)
    }
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]!).toBeGreaterThanOrEqual(delays[index - 1]!)
    }
  })

  /**
   * 整条退避梯与整窗时长，两个都写死成字面量。
   *
   * 这条替掉的是一条**恒真**断言。原先这里写「封顶：最大不超过 30s」，而实现里确实有个
   * `Math.min(BASE * 2^n, 30_000)`——但 6 次上限让能排出来的最大一档只有 `500 * 2^5 = 16000`，
   * `min` 永远挑不中封顶那侧。于是把封顶改成任何 ≥16s 的值、甚至把整个 `Math.min` 删掉，10 条全绿
   * （两个方向都实测过）。那不是「有条件没人守」，是「这个条件不可能改变结果」——处置是删掉代码，
   * 不是给它补一条测试。封顶因此已从实现里移除。
   *
   * 剩下要守的是这个策略的**产品取值**本身：每一档等多久、以及「连不上多久才放弃」这个总时长。
   * 期望值全写死字面量，绝不从被测模块算出来——用 `RECONNECT_BASE_DELAY_MS * 2 ** n` 当期望值的话，
   * 把基数从 500 悄悄改成 5（几乎不退避、狂敲 daemon）或 50000（等半分钟才第一次重连）都不会红。
   *
   * 31.5s 这个总窗是 #159 那侧设计的参照物：跨成功幸存的累计时限必须显著大于它，否则一次正常的
   * 单轮重连就会被误判成「反复抖动、该放弃了」。谁改动这里的任何一个数，都要回头看那个时限。
   */
  it('钉住退避梯与整窗时长这两个产品取值（期望值全为字面量）', () => {
    const delays: number[] = []
    for (let prior = 0; prior < RECONNECT_MAX_ATTEMPTS; prior += 1) {
      const step = nextReconnectStep(prior)
      if (step.kind === 'retry') delays.push(step.delayMs)
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000])
    // 整个重连窗口的总时长：6 档相加。半死 daemon 的累计时限设计要以它为参照。
    expect(delays.reduce((sum, value) => sum + value, 0)).toBe(31_500)
  })
})

describe('runBoundedReconnect', () => {
  it('returns exhausted after exactly RECONNECT_MAX_ATTEMPTS failed attempts — never unbounded', async () => {
    const attempt = vi.fn(async () => { throw new Error('still down') })
    const sleep = vi.fn(async () => {})
    const result = await runBoundedReconnect({ attempt, sleep })
    expect(result).toEqual({ kind: 'exhausted', attempts: RECONNECT_MAX_ATTEMPTS })
    // 这条是「无限重试 → 红」的具体化：若 give-up 分支被删或改成永远 retry，attempt 会被调用远超上限、
    // 循环不终止，本测试要么次数断言红、要么整体超时红。
    expect(attempt).toHaveBeenCalledTimes(RECONNECT_MAX_ATTEMPTS)
  })

  it('returns reconnected the moment an attempt succeeds and stops trying', async () => {
    let calls = 0
    const attempt = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error('still down')
    })
    const sleep = vi.fn(async () => {})
    const result = await runBoundedReconnect({ attempt, sleep })
    expect(result).toEqual({ kind: 'reconnected', attempts: 3 })
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('waits before each attempt using the injected sleep', async () => {
    const attempt = vi.fn(async () => {})
    const sleep = vi.fn(async () => {})
    await runBoundedReconnect({ attempt, sleep })
    // 首次尝试前也等一拍（退避从第 0 次算起）；本函数绝不碰真定时器，等待完全由注入方决定。
    expect(sleep).toHaveBeenCalledTimes(1)
  })
})
