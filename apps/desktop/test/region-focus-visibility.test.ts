import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

/**
 * 「多个 Region 时，当前聚焦在哪一格」必须看得出来（#339，用户原话：「多个 region, 当前聚焦在哪里,
 * 看不出俩」）。
 *
 * 这条守的不是某一个 CSS 声明长什么样——那是设计的自由。守的是这件事**有没有人在负责**：
 *   1. 组件真的按 `activeRegionId` 分岔，而不是给每一格同一个类名（取值层）
 *   2. 那个类名真的对应到有实际视觉效果的声明，而不是一条空规则（表达层）
 *   3. 焦点与非焦点在**同一个属性**上取不同值，否则"有声明"也可能是两边都一样（差别层）
 *
 * 为什么第 2、3 条要分开：本仓 #111 的先例是「CSS 守卫只查选择器名存在，删掉承重声明体全绿」。
 * 只判 `.workbench-region--active` 这个选择器在不在，把它的 body 清空即可绕过——屏幕上焦点
 * 彻底消失，而守卫沉默。反过来只判「body 非空」也不够：写一条与默认态**取值相同**的声明
 * （比如都是 transparent）同样让焦点不可见。
 *
 * 键盘那一侧已经在场且可达（`lib/workbench-shortcuts.ts:268` 的 `focus-region.{left,right,up,down}`
 * 走 `store.focusRegion`），所以用户能把焦点切到看不见的地方——这正是"看不出来"最难受的现场：
 * 按了键，界面上没有任何东西变。
 */

const WORKBENCH_TSX = new URL(
  '../src/renderer/src/components/WorkspaceWorkbench.tsx',
  import.meta.url
)

/** 注释里描述规则的文字不是规则本身（与 surface-selection-contract 同一条处理）。 */
const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

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

/** 一条规则里声明的属性 → 取值。同一属性重复声明时后者胜（层叠内规则内的顺序）。 */
function declarations(rule: Rule): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of rule.body.split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const property = part.slice(0, at).trim()
    if (!property) continue
    out.set(property, part.slice(at + 1).trim())
  }
  return out
}

/**
 * 某个类名恰好命中的规则们（不含把它当祖先或兄弟的选择器）。
 *
 * 用词法边界收紧：`.workbench-region` 是 `.workbench-region--active` 与
 * `.workbench-region-split` 的前缀，`includes` 会把三者混成一堆，于是"默认态"里混进焦点态的
 * 声明，第 3 条差别断言当场退化成恒真（记忆 counting-a-symbol-misses-other-spellings 的同族：
 * 判据比它要防的拼法更粗）。
 */
function rulesForClass(className: string): Rule[] {
  const exact = new RegExp(`\\.${className}(?![\\w-])`)
  return rules().filter((rule) =>
    rule.selector.split(',').some((part) => exact.test(part.trim()))
  )
}

/**
 * 组件里 `activeRegionId` 参与计算的那个 className 表达式。
 *
 * 按 AST 取而不是 grep：判据要落在「这个三元的两个分支给出**不同**的类名」上。
 * 文本判据看不出 `? 'workbench-region--active' : 'workbench-region--active'`
 * 与 `? '' : ''` 这两种把分岔抹平的写法（前者每格都亮，后者每格都不亮，用户看到的都是
 * "分不出焦点"）。
 */
function activeRegionConditional(): { whenActive: string; whenNot: string } | null {
  const text = readFileSync(WORKBENCH_TSX, 'utf8')
  const source = ts.createSourceFile(
    'WorkspaceWorkbench.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let found: { whenActive: string; whenNot: string } | null = null
  const walk = (node: ts.Node): void => {
    if (
      ts.isConditionalExpression(node) &&
      node.condition.getText(source).includes('activeRegionId')
    ) {
      found = {
        whenActive: node.whenTrue.getText(source),
        whenNot: node.whenFalse.getText(source)
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

describe('Region 焦点必须看得出来（#339）', () => {
  it('自检：能按类名精确取到规则，且不把前缀相同的邻居算进来', () => {
    // 认不出任何规则的读取器会让下面的断言因为"没找到"而全绿。这条同时钉住词法边界：
    // `.workbench-region-split` 与 `.workbench-region--active` 都以 `.workbench-region` 开头，
    // 混进来就会污染"默认态有哪些声明"。
    const exact = /\.workbench-region(?![\w-])/
    const base = rulesForClass('workbench-region')
    expect(base.length, '读不到 .workbench-region 的规则——样式入口或类名变了').toBeGreaterThan(0)
    // 判据落在**命中的那一支**上，不在整条选择器字符串上：`.workbench-region-split,
    // .workbench-region` 是一条合法的逗号组，其中一支正是我们要的；按整条判会把它当违规。
    for (const rule of base) {
      const matched = rule.selector.split(',').map((part) => part.trim()).filter((part) => exact.test(part))
      expect(matched.length, `${rule.selector} 被取进来了却没有任何一支精确命中`).toBeGreaterThan(0)
      for (const part of matched) {
        expect(part, `词法边界失效：${part} 被当成了 .workbench-region 本身`).not.toMatch(
          /\.workbench-region(?:--|-)\w/
        )
      }
    }
    // 反向：焦点态那条确实取得到，且没被上面那组吞掉。
    expect(rulesForClass('workbench-region--active').length).toBeGreaterThan(0)
    // 判据自己认得出该拒的拼法——否则"没找到违规"与"认不出违规"在结果上同形。
    expect(exact.test('.workbench-region--active')).toBe(false)
    expect(exact.test('.workbench-region-split')).toBe(false)
    expect(exact.test('.workbench-region')).toBe(true)
  })

  it('组件按 activeRegionId 分岔，且两个分支给出不同的类名', () => {
    const conditional = activeRegionConditional()
    expect(
      conditional,
      'WorkspaceWorkbench 里没有任何按 activeRegionId 分岔的三元——每一格长得一样，焦点无从表达'
    ).not.toBeNull()
    // 两个分支必须真的不同。写成同一个值（两边都加类、或两边都不加）在类型与文本上都合法，
    // 而屏幕上就是"分不出哪一格是焦点"。
    expect(
      conditional!.whenActive.trim(),
      '按 activeRegionId 分岔的两个分支给出同一个类名，等于没有分岔'
    ).not.toBe(conditional!.whenNot.trim())
    // 焦点那一侧必须真的给出一个类名，不能是空串（空串意味着焦点态没有任何样式挂载点）。
    expect(conditional!.whenActive, '焦点分支没有给出类名').toMatch(/[a-z]/)
  })

  it('焦点类名有承重声明，不是一条空规则', () => {
    const active = rulesForClass('workbench-region--active')
    const properties = new Set(active.flatMap((rule) => [...declarations(rule).keys()]))
    // #111 的先例：只判选择器在不在场，把 body 清空即可让焦点在屏幕上彻底消失而守卫沉默。
    expect(
      [...properties],
      '.workbench-region--active 没有任何声明——焦点态是一条空规则，屏幕上看不出任何差别'
    ).not.toEqual([])
  })

  it('焦点与非焦点在同一个属性上取到不同的值', () => {
    const base = rulesForClass('workbench-region')
    const active = rulesForClass('workbench-region--active')
    const baseDeclarations = new Map<string, string>()
    for (const rule of base) for (const [key, value] of declarations(rule)) baseDeclarations.set(key, value)

    const differing: string[] = []
    for (const rule of active) {
      for (const [property, value] of declarations(rule)) {
        // 默认态没声明这个属性 → 焦点态是在无到有地加东西，那本身就是差别。
        if (!baseDeclarations.has(property)) {
          differing.push(property)
          continue
        }
        if (baseDeclarations.get(property) !== value) differing.push(property)
      }
    }
    // 「有声明」不等于「有差别」：焦点态写一条与默认态逐字相同的声明（本仓默认态就有一条
    // `box-shadow: inset 0 0 0 1px transparent` 占位），编译与上面那条断言都过，而用户
    // 看到的两格一模一样。
    expect(
      differing,
      '焦点态的每一条声明都与默认态取值相同——两格在屏幕上没有任何差别'
    ).not.toEqual([])
  })
})
