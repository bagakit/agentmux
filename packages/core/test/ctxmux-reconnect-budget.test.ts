import { describe, expect, it } from 'vitest'
import {
  RECONNECT_FLAP_BUDGET,
  RECONNECT_PROBATION_MS,
  judgeReconnectFlap,
  shouldClearFlapLedger
} from '../src/ctxmux-reconnect-budget.js'

// 这一层守的是「跨成功幸存」的界：半死 daemon 每轮都连上，于是单轮那道界每次都被重置，用户看到
// 无穷次「失联→重连中→恢复→失联」。把 give-up 分支删掉、或把预算改成 Infinity，本文件必须变红。
describe('judgeReconnectFlap', () => {
  it('把预算钉成写死的字面量（与派生断言并存）', () => {
    // 下面的机制断言全用 import 的常量当期望值，会跟着常量一起漂：把 3 改成 0（一次抖动就放弃、
    // 正常的网络切换都活不过）或 9999（等于没有界）都不会让它们红。这条钉住产品取值本身。
    expect(RECONNECT_FLAP_BUDGET).toBe(3)
    // 缓刑期同理。下界是一整轮内层重连的最坏墙钟：31.5s 退避 + 5s daemon ready + 10s 握手 ≈ 46.5s，
    // 取 90s 留一倍余量，且必须 > control-host 的 60s 长请求上限。改成 1_000 会让「一次慢但成功的
    // 重连」被误判成缓刑期满、预算永远清零，这道界重新变成死代码。
    expect(RECONNECT_PROBATION_MS).toBe(90_000)
    // 缓刑期必须严格大于内层那一轮的最坏墙钟，否则清账判据会吃掉本模块要挡的那一族。
    expect(RECONNECT_PROBATION_MS).toBeGreaterThan(31_500 + 5_000 + 10_000)
    // 与 control-host 的长控制请求上限对账：缓刑不得在一个仍在途的长请求中途就宣布「稳了」。
    expect(RECONNECT_PROBATION_MS).toBeGreaterThan(60_000)
  })

  it('预算内的每一次抖动都重连，并把记账后的次数交回调用方', () => {
    // 逐次走完预算，期望值全为字面量：判决与计数两样都钉住。把 `ledger.flapCount + 1` 改成
    // `ledger.flapCount`（不记账）会让账永不增长、界永不触发，这里的 flapCount 断言先红。
    expect(judgeReconnectFlap({ flapCount: 0 })).toEqual({ kind: 'reconnect', flapCount: 1 })
    expect(judgeReconnectFlap({ flapCount: 1 })).toEqual({ kind: 'reconnect', flapCount: 2 })
    expect(judgeReconnectFlap({ flapCount: 2 })).toEqual({ kind: 'reconnect', flapCount: 3 })
  })

  it('账面已达预算时放弃，且绝不再排重连', () => {
    // 边界极性：账面 == 预算 的那一次必须 give-up。把 `>=` 写成 `>` 会多放一次抖动过去——
    // 这条断言正是那个差一变异的落点。
    expect(judgeReconnectFlap({ flapCount: RECONNECT_FLAP_BUDGET })).toEqual({
      kind: 'give-up',
      flapCount: RECONNECT_FLAP_BUDGET + 1
    })
    expect(judgeReconnectFlap({ flapCount: RECONNECT_FLAP_BUDGET + 5 })).toEqual({
      kind: 'give-up',
      flapCount: RECONNECT_FLAP_BUDGET + 6
    })
  })

  it('恰好在第 RECONNECT_BUDGET+1 次抖动上翻面——界只有这一处', () => {
    // 端到端把整条序列走一遍，断言「前 N 次全 reconnect、之后全 give-up」，且翻面点唯一。
    // 这条能咬住任何把界搬到别处或搬没了的改动（例如让 judge 恒返 reconnect）。
    const verdicts = Array.from({ length: RECONNECT_FLAP_BUDGET + 3 }, (_, prior) =>
      judgeReconnectFlap({ flapCount: prior }).kind)
    expect(verdicts).toEqual(['reconnect', 'reconnect', 'reconnect', 'give-up', 'give-up', 'give-up'])
    // 翻面**恰好一次**：一条 kind 序列若来回跳，说明判据不是单调的。
    const flips = verdicts.filter((kind, index) => index > 0 && kind !== verdicts[index - 1])
    expect(flips).toHaveLength(1)
  })
})

describe('shouldClearFlapLedger', () => {
  it('连续健康满缓刑期才清账，差一毫秒都不清', () => {
    // 边界两侧各钉一条：`>=` 改成 `>` 让恰好期满的那一刻清不掉账，第一条红；改成 `<` 或去掉
    // 比较让它恒真，第二条红。
    expect(shouldClearFlapLedger(1_000, 1_000 + RECONNECT_PROBATION_MS)).toBe(true)
    expect(shouldClearFlapLedger(1_000, 1_000 + RECONNECT_PROBATION_MS - 1)).toBe(false)
  })

  it('刚刚 restored 绝不清账——否则这道界是死代码', () => {
    // 这是本模块最容易写错的一条：抖动那一刻恰好就是 restored 的那一刻，拿 restored 清账等于
    // 永远清得掉，跨成功的账永远攒不起来。清账的判据必须是「连续健康了一段时间」。
    expect(shouldClearFlapLedger(5_000, 5_000)).toBe(false)
    expect(shouldClearFlapLedger(5_000, 5_100)).toBe(false)
  })

  it('时钟向前跳（合盖唤醒）走的是恢复满额那一侧，不是阻断那一侧', () => {
    // 合盖两小时再开：now - healthySince 变巨大 → 清账 → 抖动预算恢复满额，醒来后第一次掉线
    // 拿到完整的重连机会。若把判据建成「首次失联至今超过 X 就 unrecoverable」，同一个时钟跳变
    // 会让用户开盖第一眼就看到「彻底连不上」，而它一次都还没重试过。这条钉住方向。
    const twoHours = 2 * 60 * 60 * 1_000
    expect(shouldClearFlapLedger(1_000, 1_000 + twoHours)).toBe(true)
  })
})
