import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

// 守住控件语言里的选中态禁令（docs/design/agentmux-surface-density.md《控件语言》）。
//
// 用户看着 Topic 面板说："现在 topic 左边的窄边表示选中, 太难看了, AI 味道重, 不够现代化.
// 这个项目有没有设计引导, 能不能吧这种样式全 ban 了"。改掉那一行 CSS 只解决当前这一处——
// 下一个人加新列表时还会写出来，因为没有任何东西告诉他不该写。所以这里把它变成一条被测试
// 守住的禁令。
//
// 关键在于**分清两种 inset 竖条**：
//   `inset -1px 0 var(--line-soft)`  Sidebar 与 Tool Dock 的右边界，是容器分隔线，合法；
//   `inset 2px 0 0 var(--green-2)`   贴在行左缘的亮色装饰，是选中态竖条，禁止。
// 一刀切禁掉全部 inset 竖条会误伤前者，只盯 `.workspace-topic-item` 会放过后来的新列表。
// 判据是**这条竖条有没有出现在一个表达选中的选择器上**。

// 注释里描述规则的文字不是规则本身。
const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 什么样的选择器在表达"选中"。
 *
 * 从命名约定推出而非手工枚举清单，这样后加的列表自动被覆盖——一个手工清单只能挡住写它时
 * 已经存在的东西，而这条禁令要挡的恰恰是还没被写出来的那一行。
 */
const SELECTED_STATE =
  /(?:^|[\s>+~])[^\s>+~,]*(?:--(?:active|selected|current)\b|\.(?:active|selected|current)\b|\[aria-(?:selected|current)=)/

type Rule = { selector: string; body: string }

function rules(): Rule[] {
  const out: Rule[] = []
  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, ' ')
    if (selector.startsWith('@')) continue
    out.push({ selector, body: match[2]! })
  }
  return out
}

function selectedStateRules(): Rule[] {
  // 逗号分隔的选择器组里，只要有一支表达选中，整条规则就作用在选中态上。
  return rules().filter((rule) => rule.selector.split(',').some((part) => SELECTED_STATE.test(part)))
}

/** 纯水平偏移、零模糊的 inset 阴影——那就是一条贴边的竖线，不是阴影。 */
const INSET_VERTICAL_BAR = /inset\s+(-?\d+)px\s+0(?:px)?\s+(?:0(?:px)?\s+)?(?![\d.]+px)/g

function verticalBars(rule: Rule): string[] {
  const found: string[] = []
  for (const declaration of rule.body.matchAll(/box-shadow:\s*([^;]+)/g)) {
    for (const bar of declaration[1]!.matchAll(INSET_VERTICAL_BAR)) {
      if (bar[1] === '0') continue
      found.push(declaration[1]!.trim())
    }
  }
  return found
}

/**
 * 同一根竖条的另一种拼法。
 *
 * 上面那条只看 `box-shadow`，于是禁令在散文里说"选中态一律不用左侧竖条"，在测试里只对
 * 用阴影画的竖条生效——`.foo--selected { border-left: 2px solid var(--green) }` 会全绿通过。
 * 两种拼法在屏幕上是同一根线，判据必须同时认得两种写法，否则守的是实现细节而不是那条禁令。
 *
 * 只认**有实际宽度**的左缘边框：`border-left: 0` 与 `border-left-color` 单独出现都不画线。
 * 逻辑属性 `border-inline-start` 一并认，它是同一根线的书写方向无关拼法。
 */
const LEFT_EDGE_BORDER =
  /border-(?:left|inline-start)(?:-width)?:\s*(?!0(?:px)?\s*(?:;|$))([^;]*\b(?:[1-9]\d*(?:\.\d+)?|0?\.\d+)px[^;]*)/g

function leftEdgeBorders(rule: Rule): string[] {
  const found: string[] = []
  for (const declaration of rule.body.matchAll(LEFT_EDGE_BORDER)) {
    found.push(declaration[0]!.trim())
  }
  return found
}

describe('surface selection contract', () => {
  it('finds the selected-state rules by naming convention, not a hand-kept list', () => {
    // 认不出任何选中态的检查会全绿地什么也不说。这个下界同时确认命名约定还在被遵守。
    expect(selectedStateRules().length).toBeGreaterThan(10)
  })

  it('still recognises an inset vertical bar when it sees one', () => {
    // 禁令依赖这个形状判定。若正则认不出竖条，下面那条断言会因为"没找到"而全绿——
    // 容器分隔线（Sidebar、Tool Dock 的右边界）正好是合法的同形状样本，用它证明识别有效。
    const containerEdges = rules().filter(
      (rule) => !SELECTED_STATE.test(rule.selector) && verticalBars(rule).length > 0
    )
    expect(containerEdges.length).toBeGreaterThan(0)
  })

  it('never spells selection as a bar stuck to the left edge', () => {
    // 一条贴边的亮色竖线是"AI 生成的管理后台"最容易辨认的印记：它既不是填充也不是描边，
    // 在密集列表里连成一片噪音。选中由单一几何信号表达——干净的 Surface 填充。
    const offenders = selectedStateRules()
      .flatMap((rule) => verticalBars(rule).map((shadow) => `${rule.selector} { box-shadow: ${shadow} }`))

    expect(offenders).toEqual([])
  })

  it('lets container edges keep their hairline, since they are not selection', () => {
    // 禁令针对的是"用竖条表达选中"，不是"任何 inset 竖条"。Sidebar 与 Tool Dock 的右边界
    // 是容器分隔线——一刀切会误伤它们，而误伤会让下一个人把整条规则关掉。
    const dockEdge = rules().find((rule) => rule.selector === '.surface-tool-dock')
    expect(dockEdge).toBeDefined()
    expect(verticalBars(dockEdge!).length).toBeGreaterThan(0)
  })

  it('still recognises a left-edge border when it sees one', () => {
    // 与 inset 竖条同一条自证：认不出这个形状的话，下面那条禁令会因为"没找到"而全绿。
    // 内容语汇里的引用条（`.md-quote` 等）正是合法的同形状样本，用它们证明识别有效。
    const contentBands = rules().filter(
      (rule) => !SELECTED_STATE.test(rule.selector) && leftEdgeBorders(rule).length > 0
    )
    expect(contentBands.length).toBeGreaterThan(0)
    // 零宽度与只给颜色都不画线，不该被算成竖条——否则下一个人会为了绕开误报去改真样式。
    expect(leftEdgeBorders({ selector: 'x', body: 'border-left: 0;' })).toEqual([])
    expect(leftEdgeBorders({ selector: 'x', body: 'border-left: 0px;' })).toEqual([])
    expect(leftEdgeBorders({ selector: 'x', body: 'border-left-color: var(--green);' })).toEqual([])
    // 而这三种拼法都是同一根线。
    expect(leftEdgeBorders({ selector: 'x', body: 'border-left: 2px solid red;' })).toHaveLength(1)
    expect(leftEdgeBorders({ selector: 'x', body: 'border-inline-start: 2px solid red;' })).toHaveLength(1)
    expect(leftEdgeBorders({ selector: 'x', body: 'border-left-width: 3px;' })).toHaveLength(1)
  })

  it('never spells selection as a left-edge border either', () => {
    // 一根 `border-left` 与一条 inset 阴影在屏幕上是同一根线。禁令管的是那根线，不是画法：
    // 只守住阴影那一种拼法，等于把门开在旁边——而"选中不用竖条"这句话本身没有例外。
    //
    // 内容语汇里的左侧色带（引文、命令输出、被读回的用户发言）不在此列：它们说的是"这一段是
    // 引来的/跑出来的"，不表达选中，选择器也不带选中命名。判据与阴影那条一致——**这根线有没有
    // 出现在一个表达选中的选择器上**。
    const offenders = selectedStateRules()
      .flatMap((rule) => leftEdgeBorders(rule).map((border) => `${rule.selector} { ${border} }`))

    expect(offenders).toEqual([])
  })
})
