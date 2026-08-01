import { describe, expect, it } from 'vitest'
import {
  TURN_REOPENING_EVENTS,
  hookEventUpdatesSemanticStatus,
  hookTurnPhaseAfter,
  type HookTurnPhase
} from '../src/hook-turn-phase.js'
import type { AgentHookLifecycleEvent } from '../src/types.js'

// ---------------------------------------------------------------------------
// 判据本身的两条纯函数。接线侧的行为在 hook-after-turn-end.test.ts 里守。
//
// 这里额外守一条**不相交性**，它是接线那边「读与推进的先后不承重」的唯一理由：会推进阶段的事件与会被
// 闸门拦的事件不相交，所以拿推进前还是推进后的值算出同一个答案。这不是可有可无的补充——client.ts 里
// 那两句的顺序被实测证明可以调换而 7 条断言全绿（我为此写过一句声称顺序承重的注释，是错的）。哪天有
// 事件同时进两族，下面那条会先红，而**那时**顺序才开始承重，注释也才该改回去。
// ---------------------------------------------------------------------------

/** 词汇表全集。新增成员时这里会因缺项而暴露——刻意不从类型推导，手写才能被审计。 */
const ALL_LIFECYCLE_EVENTS: readonly AgentHookLifecycleEvent[] = [
  'session-start',
  'user-prompt-submit',
  'permission-request',
  'tool-use-start',
  'tool-use-end',
  'subagent-start',
  'subagent-stop',
  'turn-start',
  'turn-end'
]

describe('hookTurnPhaseAfter', () => {
  it('turn-end 收尾台账，重开事件重新打开它', () => {
    expect(hookTurnPhaseAfter('turn-end')).toBe('turn-ended')
    // 两种重开形状都必须认。少认哪一种，那一族 Provider 的闸门就永久 latch。
    expect(hookTurnPhaseAfter('user-prompt-submit')).toBe('in-turn')
    expect(hookTurnPhaseAfter('turn-start')).toBe('in-turn')
  })

  it('重开清单与实现是同一份真相，且两种形状都在里面', () => {
    // 这条守的是「清单导出了但实现没用它」这种漂移：那时不变量说方言满足要求，闸门其实没开。
    // 判据是逐元素成对，而不是数量——数量对不上才红的话，换掉一个成员仍全绿。
    for (const event of TURN_REOPENING_EVENTS) {
      expect(hookTurnPhaseAfter(event), `${event} 在重开清单里就必须真的重开`).toBe('in-turn')
    }
    // 反向：清单外的事件一个都不许重开，否则清单形同虚设。
    for (const event of ALL_LIFECYCLE_EVENTS) {
      if (TURN_REOPENING_EVENTS.includes(event)) continue
      expect(hookTurnPhaseAfter(event), `${event} 不在清单里就不该重开`).not.toBe('in-turn')
    }
    // 自检：清单必须真的含两种形状，否则上面两个循环都可能在退化的清单上恒真。
    expect([...TURN_REOPENING_EVENTS].sort()).toEqual(['turn-start', 'user-prompt-submit'])
  })

  it('其余事件一概不动阶段——包括认不出 canonical 生命周期的', () => {
    // 让 permission-request / subagent-* / session-start 动阶段，就等于把这条判据变成一张需要逐个
    // Provider 维护的表。逐条钉而不是只钉一两个抽样：抽到的那一对恰好正确是本仓栽过的形状。
    for (const event of ALL_LIFECYCLE_EVENTS) {
      if (event === 'turn-end' || TURN_REOPENING_EVENTS.includes(event)) continue
      expect(hookTurnPhaseAfter(event), `${event} 不该改变阶段`).toBeUndefined()
    }
    expect(hookTurnPhaseAfter(undefined)).toBeUndefined()
  })

  it('session-start 不算重开：它一个 run 只来一次，拿它开闸救不了第二轮', () => {
    // Hermes 的 on_session_start 第一方源码写明只在全新会话建立时触发（"not on continuation"）。
    // 把它算成重开会让「所有方言都满足重开要求」变成好看的假话，而闸门照旧 latch。
    expect(hookTurnPhaseAfter('session-start')).toBeUndefined()
    expect(TURN_REOPENING_EVENTS).not.toContain('session-start')
  })
})

describe('hookEventUpdatesSemanticStatus', () => {
  it('turn 已收尾时，一次工具调用的事前与事后都不许改语义状态', () => {
    expect(hookEventUpdatesSemanticStatus('turn-ended', 'tool-use-start')).toBe(false)
    expect(hookEventUpdatesSemanticStatus('turn-ended', 'tool-use-end')).toBe(false)
  })

  it('turn 已收尾时，两种重开事件都照收——它们开启下一轮', () => {
    // 反向那一侧。若实现宽到「收尾后一律不更新」，上面两条仍绿而用户第二次提问后界面永远显示 done。
    expect(hookEventUpdatesSemanticStatus('turn-ended', 'user-prompt-submit')).toBe(true)
    expect(hookEventUpdatesSemanticStatus('turn-ended', 'turn-start')).toBe(true)
  })

  it('Provider 没有任何重开事件时不抑制——否则抑制从可逆变成永久', () => {
    // 这是整条判据的前提：「收尾之后要再动工必先开新一轮」。一家 Provider 声明不出任何重开事件时前提
    // 不成立，闸门于是永久拒绝——第一次收尾之后整个 run 余下的 working/等你态全被吞掉（Pi 今天正是
    // 这样）。两害相权：宁可漏掉一次「压制迟到残响」，也不能让健康的 Agent 再也点不亮。
    expect(hookEventUpdatesSemanticStatus('turn-ended', 'tool-use-start', false)).toBe(true)
    expect(hookEventUpdatesSemanticStatus('turn-ended', 'tool-use-end', false)).toBe(true)
    // 正向对照：同样的输入，只要这家能重开，就照旧抑制。少了这一条，把实现写成「永远不抑制」也全绿。
    expect(hookEventUpdatesSemanticStatus('turn-ended', 'tool-use-start', true)).toBe(false)
    expect(hookEventUpdatesSemanticStatus('turn-ended', 'tool-use-end', true)).toBe(false)
  })

  it('turn 已收尾时，认不出 canonical 生命周期的事件也照收', () => {
    // 归一化失败绝不该顺带静音一个健康的 Agent：那种事件的语义状态由 Provider 自己的 rules 给出。
    expect(hookEventUpdatesSemanticStatus('turn-ended', undefined)).toBe(true)
  })

  it('阶段缺席或还在 turn 内时，任何事件都照收', () => {
    // 缺席（`undefined`）读作「这个 run 还没见过任何 turn-end」。把缺席当成收尾，每个 Agent 的第一轮
    // 工作都不会被点亮。逐条过全集，两个阶段值各一遍。
    for (const phase of [undefined, 'in-turn'] as const) {
      for (const event of [...ALL_LIFECYCLE_EVENTS, undefined]) {
        expect(
          hookEventUpdatesSemanticStatus(phase, event),
          `phase=${phase} event=${event} 应照收`
        ).toBe(true)
      }
    }
  })

  it('推进阶段的事件与被闸门拦的事件不相交——接线侧顺序不承重的唯一理由', () => {
    // 这条红了，说明有事件既会推进阶段、又会在某个阶段被拦。此时 client.ts 里「先读台账、后推进」
    // 的先后就开始承重（拿推进前还是推进后的值会算出不同答案），那句注释必须改回「顺序承重」并补一条
    // 行为断言。别只让这条变绿了事。
    const advances = ALL_LIFECYCLE_EVENTS.filter((event) => hookTurnPhaseAfter(event) !== undefined)
    const PHASES: readonly (HookTurnPhase | undefined)[] = [undefined, 'in-turn', 'turn-ended']
    const gated = ALL_LIFECYCLE_EVENTS.filter(
      (event) => PHASES.some((phase) => !hookEventUpdatesSemanticStatus(phase, event))
    )

    // 自检：两侧都必须非空，否则「空集不相交」恒真。
    expect(advances.length, '判据失效了：没有任何事件推进阶段').toBeGreaterThan(0)
    expect(gated.length, '判据失效了：没有任何事件会被闸门拦').toBeGreaterThan(0)

    expect(advances.filter((event) => gated.includes(event))).toEqual([])
  })
})
