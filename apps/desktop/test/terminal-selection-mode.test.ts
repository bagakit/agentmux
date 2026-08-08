import { describe, expect, it } from 'vitest'
import {
  isPlainDragSelectionSuppressed,
  MOUSE_TRACKING_MODES,
  selectionForceGestureHint,
  terminalSelectionSuppressionHint,
  type MouseTrackingMode
} from '../src/renderer/src/lib/terminal-selection-mode.js'
import { terminalOptions, TERMINAL_THEME_CATALOG } from '../src/renderer/src/lib/terminal-theme.js'

/**
 * AgentMux 排第一的用户可见 bug：终端里右键 Copy 变灰、Ctrl+C 不复制、Cmd+C 也不复制，三者同时失效。
 *
 * 根因**不在复制这条路上**（此前几轮真的全绿又全无用，正因为没有一条测试碰过这个失效模式——
 * `grep -rE "areMouseEventsActive|mouseTrackingMode|1000h" test/ src/` 此前一无所获）。真相是 xterm 在
 * PTY 程序开启鼠标上报（DECSET ?1000/?1002/?1003）时**停用自己的选区服务**，平白左拖被让给程序，
 * 于是 `getSelection()` 恒空、`hasSelection` 恒 false，所有以选区为闸的复制路一起落空。机制逐字读的是
 * vendored 的 @xterm/xterm 5.5.0 `lib/xterm.js`：`onProtocolChange` 里 `this._selectionService.disable()`，
 * 而 `disable(){this.clearSelection(),this._enabled=!1}`。
 *
 * 判据是 xterm 的 `areMouseEventsActive === (events !== 0)`。五种模式的 events 位掩码逐字取自源码：
 * NONE=0、X10=1、VT200=19、DRAG=23、ANY=31。所以除 `none` 外的四种模式全都压制选区。
 */

/**
 * 被测的模式集合**从被测模块导出的全集派生**，本文件不留手抄清单。
 *
 * 此前这里是 `const ACTIVE_MODES = ['x10','vt200','drag','any'] as const satisfies …` 加一个
 * `Record<MouseTrackingMode, …>` 完整性自检，注释还写着「完整性靠单文件 tsc 检查兜」——那个检查在
 * 任何门禁里都不存在（`apps/desktop/tsconfig.json` 的 include 只有 `src/**`，vitest 只转译不查类型），
 * 所以那条自检从来没有被任何工具执行过，是死代码；而手抄清单漏一个字面量则完全静默。
 * 现在全集由 `MOUSE_TRACKING_MODES` 提供，它在 `src/` 里由带标注的 `Record` 强制穷举，执行者是
 * `pnpm typecheck`。
 *
 * `none` 也不再是手抄的字面量常量：它由「表里判为不压制的那一侧」筛出来。于是下面「相反答案」那条
 * 判据两侧都随表变化，谁都无法单独漂移。
 */
const NONE_MODES = MOUSE_TRACKING_MODES.filter((mode) => !isPlainDragSelectionSuppressed(mode))
const ACTIVE_MODES = MOUSE_TRACKING_MODES.filter((mode) => isPlainDragSelectionSuppressed(mode))
const NONE_MODE: MouseTrackingMode = 'none'

// 上面两个集合是用**被测函数自己**切出来的，所以它们的大小必须另外钉住，否则实现退化成常量时
// （恒 true / 恒 false）一侧会变成空数组，而「对空数组的每个元素都成立」恒真——那正是判据塌陷的形状。
// 这两条断言不依赖模式的具体拼法，只依赖「xterm 恰好一种模式不上报鼠标」这个来自源码的事实（NONE=0）。
describe('模式全集本身：判据的前提自检', () => {
  it('全集恰好来自类型层，且被分成非空的两侧', () => {
    expect(MOUSE_TRACKING_MODES.length, '模式全集为空——导出取值坏了，下面所有遍历都会恒真').toBeGreaterThan(1)
    expect(NONE_MODES, '不压制的那一侧必须恰好是 none 一种（xterm 里 events=0 只有 NONE）').toEqual([NONE_MODE])
    expect(ACTIVE_MODES.length, '压制的那一侧为空——实现恒 false，下面的遍历会退化成恒真').toBe(
      MOUSE_TRACKING_MODES.length - 1
    )
  })
})

// 平台判定必须**显式传 userAgent**：node 测试环境里 `navigator.userAgent` 读出 'Node.js/24'，既不含
// 'Mac' 也不含 'Windows'，于是不传就恒为非 mac——那样 mac 分支永不可观测（记忆
// property-unobservable-in-default-env）。这两个 UA 各自只含一个平台词，落到 host-platform 的顺序判定上。
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const NON_MAC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

describe('鼠标上报模式是否压制平白拖选（#610 复制三合一失效的根因）', () => {
  it('none 不压制——这是唯一让选区服务保持启用的模式', () => {
    // events=0，areMouseEventsActive 为假，选区照常。这一侧独立断言：把判据取反
    // （`mode === 'none'`）时它立刻红。
    expect(isPlainDragSelectionSuppressed(NONE_MODE)).toBe(false)
  })

  it('四种活跃模式全都压制——逐个质询，不抽样', () => {
    // 逐个断言而非抽一个：X10(1)/VT200(19) 只报点击，DRAG(23)/ANY(31) 连移动也报，四者并不等价，
    // 但对「平白拖能不能选中」今天给同一个答案，因为四者 events 都非零。把判据窄成只认 motion 类
    // （`mode === 'drag' || mode === 'any'`）时，x10 与 vt200 这两条会红——正是本轮要区分的东西。
    for (const mode of ACTIVE_MODES) {
      expect(
        isPlainDragSelectionSuppressed(mode),
        `${mode}: events 非零，xterm 会 disable() 选区服务，平白拖选不中——必须判为压制`
      ).toBe(true)
    }
  })

  it('none 与四种活跃模式给出相反的答案——区分性自证', () => {
    // 把「none 单独一侧、四种活跃在另一侧」这件事直接钉住：若实现退化成常量（恒 true / 恒 false），
    // 这两个集合之一会塌陷，这条红。
    const suppressed = ACTIVE_MODES.map((mode) => isPlainDragSelectionSuppressed(mode))
    expect(suppressed, '四种活跃模式里有的没被判为压制').toEqual([true, true, true, true])
    expect(isPlainDragSelectionSuppressed(NONE_MODE), 'none 被误判为压制').toBe(false)
  })
})

describe('压制时给用户的逃生手势提示', () => {
  it('mac 提示按住 Option（⌥）拖，且不说 Shift', () => {
    // 逃生手势是 xterm 的 shouldForceSelection：mac 上 e.altKey && macOptionClickForcesSelection。
    // 锚点是字面 token 'Option' / '⌥'，不从被测模块派生（记忆 expected-value-must-not-derive-from-target）。
    const hint = selectionForceGestureHint(MAC_UA)
    expect(hint, 'mac 提示里没有 Option').toContain('Option')
    expect(hint, 'mac 提示里没有 ⌥ 符号').toContain('⌥')
    // 反向：mac 不该说 Shift。两条分支若被对调，这条会红。
    expect(hint, 'mac 提示里出现了 Shift——分支被对调了').not.toContain('Shift')
  })

  it('非 mac 提示按住 Shift 拖，且不说 Option', () => {
    const hint = selectionForceGestureHint(NON_MAC_UA)
    expect(hint, '非 mac 提示里没有 Shift').toContain('Shift')
    expect(hint, '非 mac 提示里出现了 Option——分支被对调了').not.toContain('Option')
    expect(hint).not.toContain('⌥')
  })

  it('提示既说清「为什么」也说清「怎么办」', () => {
    // 只说其一都领不出死胡同：要有「程序在用鼠标」这个原因，也要有「拖」这个动作。
    for (const ua of [MAC_UA, NON_MAC_UA]) {
      const hint = selectionForceGestureHint(ua)
      expect(hint.toLowerCase(), '没说清为什么选区关着').toContain('mouse')
      expect(hint.toLowerCase(), '没说清怎么办（拖）').toContain('drag')
    }
  })
})

describe('给 UI 的整合决定：要不要提示 + 提示什么', () => {
  it('none 返回 null——菜单照常，不显示任何提示', () => {
    // 若实现忽略模式、无条件返回提示，这条红（none 也会给出提示）。
    expect(terminalSelectionSuppressionHint(NONE_MODE, MAC_UA)).toBeNull()
    expect(terminalSelectionSuppressionHint(NONE_MODE, NON_MAC_UA)).toBeNull()
  })

  it('活跃模式返回逃生提示，且与平台一致', () => {
    // 逐个活跃模式都要非空（若实现只对某一种模式提示，其余会红）；内容与 selectionForceGestureHint 一致，
    // 于是「压制判定」与「文案」两块拼接正确。平台锚点仍是字面 token。
    for (const mode of ACTIVE_MODES) {
      const macHint = terminalSelectionSuppressionHint(mode, MAC_UA)
      expect(macHint, `${mode}: 压制时没有给出提示`).not.toBeNull()
      expect(macHint).toBe(selectionForceGestureHint(MAC_UA))
      expect(macHint!, `${mode}: mac 提示没说 Option`).toContain('Option')

      const otherHint = terminalSelectionSuppressionHint(mode, NON_MAC_UA)
      expect(otherHint).toBe(selectionForceGestureHint(NON_MAC_UA))
      expect(otherHint!, `${mode}: 非 mac 提示没说 Shift`).toContain('Shift')
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 逃生提示与「让它生效的那条 xterm 配置」的跨文件耦合（本轮补的守卫）。
//
// 症状与背景：选区被鼠标上报关掉时，mac 提示叫用户「按住 ⌥ Option 再拖」。这句话能不能兑现，
// 取决于 xterm 的 `shouldForceSelection`——mac 分支是 `e.altKey && rawOptions.macOptionClickForcesSelection`。
// 也就是说，只有当我们把 `macOptionClickForcesSelection: true` 传给 xterm 时，⌥ 拖才真的建立选区。
//
// 缺口在哪：那句提示活在 `terminal-selection-mode.ts`，那条配置活在 `terminal-theme.ts`，两个文件、
// 一件事，此前只有散文把它们绑在一起。把配置翻成 false（或删掉），mac 提示会照旧教用户按 ⌥ 拖，
// 而那个手势不再生效——全程无报错。反过来配置开着却不给 mac 提示，等于配了个没人发现的逃生阀。
// terminal-theme.test.ts 只断言配置字面上 === true，terminal-selection-mode.test.ts 只断言提示里有
// 'Option'；两个文件各自绿，谁都不会因为「提示宣传的手势和真实生效的配置对不上」而红。
//
// 这一族把两侧接到**同一道**判据上：mac 提示提到 ⌥ Option ⇔ 传给 xterm 的配置确实开着。取值读的是
// `terminalOptions(...)` 真正会交给 xterm 的那个对象（`terminal-theme.ts` 的 SSOT），不是在测试里
// 手抄一份 true——手抄会跟着配置一起漂移、变成恒真（记忆 expected-value-must-not-derive-from-target）。
// ────────────────────────────────────────────────────────────────────────────
describe('mac 逃生手势（⌥ 拖）与 macOptionClickForcesSelection 配置必须同真同假', () => {
  // 读的是 terminalOptions 真正交给 xterm 的那个对象里的取值，而非字面量常量。任取一个目录里的主题
  // 都行——这条配置在 TERMINAL_BASE_OPTIONS 里、与主题无关，下面「跨全部主题一致」那条会把这一点钉死。
  const firstThemeId = TERMINAL_THEME_CATALOG[0]!.id
  const macForceEnabled = terminalOptions(firstThemeId).macOptionClickForcesSelection === true

  it('前提自证：读到了 terminalOptions 里的 macOptionClickForcesSelection，且它是个布尔值', () => {
    // 若取值口坏了（改名、terminalOptions 不再展开 BASE_OPTIONS），这里读到 undefined，下面的
    // 「同真同假」会拿一个恒 false 的左值去比，退化成「提示里不能有 Option」的恒真断言——那正是
    // 判据塌陷的形状。所以先钉住「这个配置确实被 terminalOptions 暴露成布尔」。
    expect(
      typeof terminalOptions(firstThemeId).macOptionClickForcesSelection,
      'terminalOptions 没把 macOptionClickForcesSelection 暴露成布尔——耦合守卫读的是 undefined，会恒真'
    ).toBe('boolean')
  })

  it('mac 提示提到 ⌥ Option，当且仅当那条配置开着', () => {
    // 双向：把 terminal-theme.ts 的配置翻成 false → 左边变 false、右边仍 true（提示照旧说 ⌥）→ 红；
    // 把 terminal-selection-mode.ts 的 mac 文案改成不提 Option/⌥（比如错抄成 Shift）→ 右边变 false、
    // 左边仍 true → 也红。两处任一单独漂移都被这一条抓住。
    const macHint = selectionForceGestureHint(MAC_UA)
    const hintAdvertisesOption = macHint.includes('Option') || macHint.includes('⌥')
    expect(
      hintAdvertisesOption,
      macForceEnabled
        ? 'macOptionClickForcesSelection 开着，但 mac 提示没教用户按 ⌥ Option 拖——逃生阀没人发现'
        : 'mac 提示在教用户按 ⌥ Option 拖，但 macOptionClickForcesSelection 没开——这个手势不生效，提示是假话'
    ).toBe(macForceEnabled)
  })

  it('这条配置与主题无关：每个主题产出的 terminalOptions 都开着它', () => {
    // 配置在 TERMINAL_BASE_OPTIONS 里，被 terminalOptions 无条件展开进每个主题。若哪天有人把它挪进
    // 某个主题的分支、或让某个主题覆盖掉它，mac 的 ⌥ 逃生手势就会「在某些主题下静默失效」——这条
    // 遍历全目录把那种按主题分叉的回归钉住。前提自证：目录非空，否则 for-of 恒真。
    expect(TERMINAL_THEME_CATALOG.length, '主题目录为空——下面的遍历恒真').toBeGreaterThan(0)
    for (const { id } of TERMINAL_THEME_CATALOG) {
      expect(
        terminalOptions(id).macOptionClickForcesSelection,
        `主题 ${id} 的 terminalOptions 没开 macOptionClickForcesSelection——mac ⌥ 逃生手势在这个主题下不生效`
      ).toBe(true)
    }
  })
})
