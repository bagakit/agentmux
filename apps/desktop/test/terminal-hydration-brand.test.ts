import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { allStyles } from './helpers/styles.js'

/**
 * 恢复态用品牌语言，而不是十六处共用的通用转圈。
 *
 * 用户原话："restoring 的动画太简单, 没有品牌感"。占满一整格终端的等待态是产品最显眼的门面，
 * 而它此前用的是 `LoaderCircle className="spin"`——与"Loading branches"完全同款。把最显眼的
 * 位置让给最没有信息的图形，是把工具属性当成了设计粗糙的理由。
 *
 * 设计 SSOT：`docs/design/agentmux-surface-density.md`《动效》。这里守住三件一旦破了就**悄悄**破、
 * 不会有任何行为测试变红的约束：动效是 token 而非手写毫秒、整格覆盖层不退回通用 spin、
 * 静态首帧自己就读得出"正在工作"。
 */

const styles = allStyles()
const terminalView = readFileSync(
  new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
  'utf8'
)

/** 恢复态那一段样式——断言只针对它。切到兄弟态**之前**为止：把兄弟态一起切进来的话，
 *  它那套一模一样的卡片语汇会替恢复态把断言蹭绿（本轮变异测试实测：恢复态改用 surface-2
 *  也照样全绿）。 */
function hydrationRules(): string {
  const start = styles.indexOf('.terminal-hydration {')
  const end = styles.indexOf('.terminal-agent-startup {', start)
  if (start < 0 || end < 0) throw new Error('恢复态样式段找不到了——这个读取器要跟着改')
  return styles.slice(start, end)
}

/** 兄弟态（Agent 启动）那一段，用于证明"绿色是差异化手段"而不是两处都染绿。 */
function siblingRules(): string {
  const start = styles.indexOf('.terminal-agent-startup {')
  const end = styles.indexOf('.terminal-service-window {', start)
  if (start < 0 || end < 0) throw new Error('兄弟启动态样式段找不到了——这个读取器要跟着改')
  return styles.slice(start, end)
}

describe('扫描本身有效', () => {
  it('读到的是真的样式与真的组件，不是空字符串', () => {
    // 扫不到东西的检查会全绿地什么也不说。
    expect(styles.length).toBeGreaterThan(10_000)
    expect(hydrationRules()).toContain('.terminal-hydration__content')
    expect(terminalView).toContain('terminal-hydration')
  })
})

describe('动效是 token，不是各表面手写的毫秒数', () => {
  it('四档节奏与入场曲线都在 :root 有声明', () => {
    for (const token of ['--dur-fast', '--dur-enter', '--dur-breath', '--dur-sweep', '--ease-enter']) {
      expect(styles).toContain(`${token}:`)
    }
  })

  it('每个动效 token 都有 var() 落点——没有落点的 token 比没有更糟', () => {
    // 它会让下一个人以为这里已经有答案了。surface-scale-contract 也守这条，
    // 这里再钉一次是因为动效 token 是本轮新增的一族，最容易只声明不接线。
    for (const token of ['--dur-fast', '--dur-enter', '--dur-breath', '--dur-sweep', '--ease-enter']) {
      expect(`${token} 无人引用`).toBe(
        styles.includes(`var(${token})`) ? `${token} 无人引用` : `${token} 有 var() 落点`
      )
    }
  })

  it('恢复态自己的两条动效走 token，不写死秒数', () => {
    const rules = hydrationRules()
    expect(rules).toContain('var(--dur-sweep)')
    expect(rules).toContain('var(--dur-breath)')
    // 动画简写里不得再出现裸的时长字面量。
    expect(rules).not.toMatch(/animation:[^;]*\b\d+(\.\d+)?m?s\b/)
  })

  it('既有的 cubic-bezier 提为具名后不再散在各表面手写', () => {
    // 三处手写同一串曲线时，调一次传导不到另外两处——那不是复用，是三份巧合。
    expect(styles).toMatch(/--ease-enter:\s*cubic-bezier/)
    // 只数真的声明（`animation:` / `transition:` 里的），不数注释中提到这个词的散文。
    const handwritten = [...styles.matchAll(/(animation|transition)[^;{}]*cubic-bezier/g)]
    expect(handwritten.map((m) => m[0]!.trim())).toEqual([])
  })
})

describe('整格覆盖层用品牌语言', () => {
  it('恢复态不再挂通用 .spin——那是行内尺度，不携带品牌', () => {
    const restoring = terminalView.slice(
      terminalView.indexOf("startupPhase === 'restoring'"),
      terminalView.indexOf("startupPhase === 'starting-agent'")
    )
    expect(restoring.length).toBeGreaterThan(80)
    expect(restoring).not.toContain('className="spin"')
    expect(restoring).not.toContain('LoaderCircle')
  })

  it('行内小 spinner 仍然存在——本轮只改整格覆盖层，不做全站替换', () => {
    // 一个 App 只有一条通用 spinner；十六处行内加载各自长出一个品牌动画等于没有品牌。
    expect(styles).toContain('.spin {')
    expect(terminalView).toContain('LoaderCircle')
  })

  it('绿色是与兄弟态的差异化手段：恢复态用绿，兄弟启动态不用', () => {
    expect(hydrationRules()).toContain('var(--green)')
    const sibling = siblingRules()
    expect(sibling.length).toBeGreaterThan(80)
    expect(sibling).not.toContain('var(--green)')
  })

  it('与兄弟态同族：同一套居中卡片语汇，只在动效与色相上区分', () => {
    const rules = hydrationRules()
    for (const token of ['var(--surface-1)', 'var(--line-soft)', 'var(--radius-sm)', 'var(--elev-1)']) {
      expect(rules).toContain(token)
    }
  })

  it('兄弟启动态也有同等级的卡片质量，但使用蓝紫启动扫描线区分语义', () => {
    const sibling = siblingRules()
    expect(sibling).toContain('.terminal-agent-startup__content::before')
    expect(sibling).toContain('var(--blue)')
    expect(sibling).toContain('var(--purple)')
    expect(sibling).toContain('var(--dur-sweep)')
    expect(sibling).toContain('width: min(420px')
  })
})

describe('动效不得是唯一的信息载体', () => {
  it('prefers-reduced-motion 会冻住 keyframe，所以静态首帧必须自己说得清', () => {
    // base.css 的全局 animation-duration: 0s !important 把任何 keyframe 冻在首帧。
    expect(styles).toMatch(/animation-duration:\s*0s\s*!important/)
    const rules = hydrationRules()
    // 扫描线首帧要在可见位置：有实际宽度、有实色渐变，而不是 0 宽或全透明起步。
    expect(rules).toMatch(/width:\s*\d+%/)
    // 光标首帧不透明——呼吸只降到 50% 的那一帧，不是从 0 起步。
    expect(rules).not.toMatch(/@keyframes terminal-cursor-breath\s*\{\s*from\s*\{\s*opacity:\s*0/)
  })

  it('文案本身就说清了在做什么，不靠动起来才读得懂', () => {
    expect(terminalView).toContain('Restoring terminal…')
    expect(terminalView).toContain('Replaying retained output.')
  })

  it('无障碍不退步：恢复态仍是 role=status 的礼貌播报', () => {
    const restoring = terminalView.slice(
      terminalView.indexOf("startupPhase === 'restoring'"),
      terminalView.indexOf("startupPhase === 'starting-agent'")
    )
    expect(restoring).toContain('role="status"')
    expect(restoring).toContain('aria-live="polite"')
  })
})
