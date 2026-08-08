import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

/**
 * 终端右键菜单要能**自己解释**为什么 Copy 变灰（#610）。
 *
 * 背景：TUI 开启鼠标上报后 xterm 停用选区服务，平白拖选不中，`hasSelection` 恒 false，于是 Copy 项被
 * `disabled={!hasSelection}` 变灰——而用户面前没有任何解释，同时 TerminalView 里 copySelection() 那条
 * 记忆选区兜底也因为这道 disabled 闸而没人够得着。本轮让菜单接收压制状态并把逃生提示渲染出来。
 *
 * 为什么用 AST 而不是渲染：菜单内容在 Radix 的 Portal 里，`renderToStaticMarkup` 既不跑 effect 也不展开
 * Portal（本仓 terminal-menu-chords.test.ts 已确立这条纪律）。所以接线层按 TypeScript AST 判**取值关系**：
 *   - 组件把 `mouseTrackingMode` prop 喂给 `terminalSelectionSuppressionHint(...)`；
 *   - 提示那一行渲染的正是这次调用的结果绑定。
 * 每条都带在场自证，避免遍历坏掉时静默恒真（记忆 false-green-gate-patterns）。
 *
 * 这一族**不**验「文案对不对、哪个平台说哪句」——那是 terminal-selection-mode.test.ts 的行为判据。
 * 这里只钉「组件真的把根因入口接到了那个纯模块、并渲染其结果」。
 */

const COMPONENT = fileURLToPath(
  new URL('../src/renderer/src/components/TerminalContextMenu.tsx', import.meta.url)
)
const source = readFileSync(COMPONENT, 'utf8')
const file = ts.createSourceFile(COMPONENT, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

/** 找到形如 `const <name> = <call>(...)` 的变量声明，返回其 initializer 文本；找不到为 null。 */
function callBoundTo(name: string): string | null {
  let bound: string | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      bound = node.initializer.getText(file)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return bound
}

describe('菜单把复制失效的根因接到纯模块', () => {
  it('selectionHint 绑定来自 terminalSelectionSuppressionHint(...)，且入参是 mouseTrackingMode', () => {
    // 钉住取值来源本身：把它换成手写 `const selectionHint = null` 或读别的东西，这条红
    // （记忆 optional-prop-only-buys-silence：接线层按 AST 判「值就是那次调用」）。
    const bound = callBoundTo('selectionHint')
    expect(bound, '组件里没有名为 selectionHint 的绑定——提示能力的入口不在了').not.toBeNull()
    expect(
      bound,
      'selectionHint 不是 terminalSelectionSuppressionHint(...) 的返回值'
    ).toMatch(/^terminalSelectionSuppressionHint\(/u)
    // 喂进去的必须是那个根因入口 prop：换成写死的 'none' 会让提示永不出现（能力静默消失）。
    expect(
      bound,
      'terminalSelectionSuppressionHint 收到的不是 mouseTrackingMode——根因入口没接上'
    ).toContain('mouseTrackingMode')
  })

  it('那个纯模块确实是从 terminal-selection-mode 导入的，不是同名本地函数', () => {
    // 上一条只认「调用了一个叫这个名字的东西」。这一条钉住它的来源模块，堵住「组件里另写一个同名
    // 恒返回 null 的函数」这条绕法（记忆 guard-criterion-must-be-import-relation）。
    let imported = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.includes('terminal-selection-mode') &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const element of node.importClause.namedBindings.elements) {
          if (element.name.text === 'terminalSelectionSuppressionHint') imported = true
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    expect(imported, 'terminalSelectionSuppressionHint 不是从 terminal-selection-mode 导入的').toBe(true)
  })

  it('存在一个 ContextMenu.Label，其唯一子表达式就是 selectionHint', () => {
    // 判「派生值真的被渲染出去」，而不是算了却没显示。逐元素定位到那个 Label，读它的唯一子表达式。
    // 只 grep `'selectionHint'` 在场会被注释/属性绕过，也看不出它有没有被渲染，所以走 AST。
    let labelChild: string | null | undefined
    let labelCount = 0
    const soleChildExpression = (element: ts.JsxElement): string | null => {
      const children = element.children.filter(
        (child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces)
      )
      const only = children.length === 1 ? children[0] : undefined
      return only !== undefined && ts.isJsxExpression(only) && only.expression !== undefined
        ? only.expression.getText(file)
        : null
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(file) === 'ContextMenu.Label'
      ) {
        labelCount += 1
        labelChild = soleChildExpression(node)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    // 在场自证：恰好一个 Label。0 个→提示没被渲染（下面断言会对 undefined 误判）；多个→形状变了，
    // 「抽到的那一个」可能不是读 selectionHint 的那个（记忆 presence-assertion-blind-when-shape-repeats）。
    expect(labelCount, '菜单里的 ContextMenu.Label 不是恰好一个——提示渲染点的形状变了').toBe(1)
    expect(
      labelChild,
      'ContextMenu.Label 渲染的不是 selectionHint——派生值算了却没显示给用户'
    ).toBe('selectionHint')
  })

  it('提示行由 selectionHint 条件挂载——null 时不渲染空壳', () => {
    // 渲染点被包在 `selectionHint ? (...) : null` 里：未压制（null）时整行不挂，不会盖一个空 Label。
    // 判 JSX 里存在一个三元，其条件是 selectionHint、whenFalse 是 null，且 whenTrue 分支里出现 Label。
    let guarded = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isConditionalExpression(node) &&
        node.condition.getText(file) === 'selectionHint' &&
        node.whenFalse.kind === ts.SyntaxKind.NullKeyword &&
        node.whenTrue.getText(file).includes('ContextMenu.Label')
      ) {
        guarded = true
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    expect(
      guarded,
      '提示不是由 `selectionHint ? <Label/> : null` 守着——要么无条件挂空壳，要么根本没渲染'
    ).toBe(true)
  })
})

describe('导入的判定函数没有被同名局部声明影子掉', () => {
  it('组件体内没有任何本地声明重用那批受保护的导入名', () => {
    // 这一条堵的是**名字解析**层的绕法，上面两条都堵不住它：审计 agent 实测插入
    //   const terminalSelectionSuppressionHint = (_mode: MouseTrackingMode): string | null => null
    // 于是 import 声明照旧在场（第二条绿）、调用点文本照旧是那个名字（第一条绿），但真正被调用的是这个
    // 恒返回 null 的局部函数——提示永久消失而 13 条全绿。判 import 关系换不来名字解析（记忆
    // guard-criterion-must-be-import-relation 的下一层；#596 是本族第一次：同名局部影子绕过 #594）。
    //
    // 判据：**任何**在组件函数体内引入该名字的声明都算影子，不枚举「箭头函数/function/解构」等具体拼法
    // ——按「这个名字有没有被本地重新绑定」判，而不是按它长什么样判。
    const PROTECTED = ['terminalSelectionSuppressionHint', 'terminalMenuChords', 'isMacPlatform']
    // 在场自证：受保护清单必须真的都是本文件的导入名，否则这条判据在扫一批不存在的名字（恒绿）。
    const importedNames = new Set<string>()
    const collectImports = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined) {
        const bindings = node.importClause.namedBindings
        if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) importedNames.add(element.name.text)
        }
      }
      ts.forEachChild(node, collectImports)
    }
    ts.forEachChild(file, collectImports)
    for (const name of PROTECTED) {
      expect(
        importedNames.has(name),
        `受保护清单里的 ${name} 不是本文件的导入名——这条判据在扫不存在的名字，会恒绿`
      ).toBe(true)
    }

    // 收集组件函数体内引入的**所有**本地名字：变量声明（含解构展开）、函数声明、参数。
    let component: ts.FunctionDeclaration | undefined
    const findComponent = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'TerminalContextMenu') {
        component = node
      }
      ts.forEachChild(node, findComponent)
    }
    ts.forEachChild(file, findComponent)
    expect(component, '找不到 TerminalContextMenu 函数声明——判据的扫描对象缺席').not.toBeUndefined()

    const locals: string[] = []
    const collectBoundNames = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) {
        locals.push(name.text)
        return
      }
      // 解构/数组模式：逐元素下钻，`const { terminalSelectionSuppressionHint } = x` 也算影子。
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) collectBoundNames(element.name)
      }
    }
    const collectLocals = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) collectBoundNames(node.name)
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) locals.push(node.name.text)
      if (ts.isParameter(node)) collectBoundNames(node.name)
      ts.forEachChild(node, collectLocals)
    }
    ts.forEachChild(component!, collectLocals)

    const shadowed = PROTECTED.filter((name) => locals.includes(name))
    expect(
      shadowed,
      `这些导入名被组件体内的本地声明影子掉了：${shadowed.join(', ')}——调用点解析到的不是导入的那个实现，` +
        '能力会静默消失而其余判据全绿'
    ).toEqual([])
  })
})

describe('mouseTrackingMode 作为 prop 接在组件签名上', () => {
  it('组件参数里声明了 mouseTrackingMode', () => {
    // 前提自证：根因入口 prop 必须真的在参数解构里，否则上面「入参是 mouseTrackingMode」那条读的是
    // 一个不存在的名字（会作为自由变量报 TS 错，但 vitest 只转译不查类型，故在这里显式钉一次）。
    let hasParam = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'TerminalContextMenu' &&
        node.parameters.length > 0
      ) {
        const first = node.parameters[0]!
        if (ts.isObjectBindingPattern(first.name)) {
          for (const element of first.name.elements) {
            if (ts.isIdentifier(element.name) && element.name.text === 'mouseTrackingMode') {
              hasParam = true
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    expect(hasParam, 'TerminalContextMenu 的参数里没有 mouseTrackingMode——根因入口 prop 缺席').toBe(true)
  })
})

describe('提示的样式落在共享 CSS 规则里，且那条规则真的带着承重声明', () => {
  // 为什么这一族必须存在：`.tab-context-menu__hint` 的**选择器在场**已经被 rendered-class-has-rule
  // 那道全局门守着，但那道门只收集选择器名（`definedClasses()` 走 `matchAll(/\.(-?[A-Za-z_][\w-]*)/g)`
  // 扫整张表），所以一条**空规则体**照样满足它——实测把这条规则清成 `.tab-context-menu__hint {}` 后
  // 那道门 10 条全绿（同一形状的事故：那道门自己的注释就记着「一条规则的理由注释满足了在场正则」）。
  // 声明体这一层只能在这里守。
  //
  // 判据落在**声明体**上，不落在「文件里出现过这个属性名」上：整条规则整条相等地取出来，再逐属性问
  // 取值。选择器必须整条相等——子串命中会被兄弟规则（例如某个 `.x .tab-context-menu__hint`）替被删的
  // 规则作保（这条坑在 surface-tool-dock.test.ts 的 ruleBody 注释里已记过一次）。
  const HINT = '.tab-context-menu__hint'

  /** 一条规则的声明体（注释已剥除）；选择器整条相等才算命中，不在场时空串。 */
  function ruleBody(selector: string): string {
    for (const [, selectors, body] of allStyleRules().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (selectors!.split(',').some((one) => one.trim() === selector)) return body!
    }
    return ''
  }

  /** 规则里某个属性的取值；不在场时空串。 */
  function declaration(selector: string, property: string): string {
    return ruleBody(selector).match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim() ?? ''
  }

  it('组件不自带内联样式——取值只能来自这条共享规则', () => {
    // 此前这些取值是 7 条 `style={{...}}` 内联声明（当时不允许改 .css）。内联回来就意味着同一份取值
    // 有了第二个来源，改主题/改档位时两处必漂移，且下面几条断言会在全绿下变成守着一份没人用的规则。
    let inlineStyled = 0
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        if (node.tagName.getText(file) === 'ContextMenu.Label') {
          for (const attribute of node.attributes.properties) {
            if (ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'style') inlineStyled += 1
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    expect(inlineStyled, '提示的 ContextMenu.Label 又带上了 style={{...}}——取值出现第二个来源').toBe(0)
  })

  it('提示挂的 className 正是那条规则的选择器', () => {
    // 接线层：规则再对，className 写错（或被删）也一样看不到。判 Label 的 className 字面量。
    let className: string | null = null
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(file) === 'ContextMenu.Label') {
        for (const attribute of node.attributes.properties) {
          if (
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(file) === 'className' &&
            attribute.initializer !== undefined &&
            ts.isStringLiteral(attribute.initializer)
          ) {
            className = attribute.initializer.text
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    expect(className, `提示的 className 不是 ${HINT.slice(1)}——它挂不到那条规则上`).toBe(HINT.slice(1))
  })

  it('规则体带着四条承重声明：字号、颜色、行距、内边距', () => {
    // 在场自证：先要求规则体非空，否则下面每条 `declaration(...)` 都在读空串，四条断言会一起变成
    // 「空 !== 期望」——那当然会红，但红的理由会指向属性而不是「整条规则没了」，诊断被带偏。
    expect(
      ruleBody(HINT).trim(),
      `${HINT} 的规则体是空的——提示会以菜单项的字号/颜色显示，与可点项无从区分`
    ).not.toBe('')
    // 逐条问取值，而不是问「属性名出现过吗」：把 `--fs-micro` 改成 `--fs-body`、把 `--text-3` 改成
    // `--text`，提示就与 `.tab-context-menu__item` 逐像素同形——那正是这条规则存在的理由。
    expect(declaration(HINT, 'font-size'), '提示字号不是 --fs-micro——与菜单项同号就分不出说明与可点项').toBe('var(--fs-micro)')
    expect(declaration(HINT, 'color'), '提示颜色不是 --text-3——说明文字不该与可点项同亮').toBe('var(--text-3)')
    // 整句提示会换到两行，行距必须显式给：菜单项那条给的是 18px 定高，落到多行提示上会撑得很散。
    expect(declaration(HINT, 'line-height'), '提示没有自己的 line-height——多行时行距会沿用菜单项的定高').not.toBe('')
    // 与菜单项左右对齐（同为 --sp-4），否则提示会与它解释的那一项错开。
    expect(declaration(HINT, 'padding'), '提示的横向内边距要与菜单项对齐（--sp-4）').toContain('var(--sp-4)')
  })

  it('规则给了换行宽度上限，且它比菜单最小宽度大', () => {
    // max-width 是「提示可以换行、菜单不会被一句长提示撑爆」这件事的唯一承重项。取值必须比容器的
    // min-width 大，否则上限反而成了收窄，菜单宽度会由提示决定。
    const hintMax = Number(declaration(HINT, 'max-width').replace('px', ''))
    const menuMin = Number(declaration('.tab-context-menu', 'min-width').replace('px', ''))
    expect(Number.isFinite(hintMax), `${HINT} 没有 max-width——一句长提示会把菜单横向撑开`).toBe(true)
    // 前提自证：容器那条 min-width 必须读得到，否则这条比较在拿 NaN 作参照（恒红或恒绿都有可能）。
    expect(Number.isFinite(menuMin), '读不到 .tab-context-menu 的 min-width——这条比较没有参照').toBe(true)
    expect(hintMax, '提示的 max-width 不大于菜单 min-width——上限成了收窄').toBeGreaterThan(menuMin)
  })

  it('刻意不写的两条声明，其前提仍然成立', () => {
    // `display` 与 `white-space` 都被**刻意省掉**：Radix 的 Label 渲染成 div（默认 block），而这一块里
    // 唯一那条 `white-space: nowrap` 落在 `.tab-context-menu__item > span:nth-child(2)`，不是提示的祖先。
    // 省掉是对的（记忆 surviving-mutation-may-be-dead-condition：改不了结果的声明该删，不该让守卫替
    // 死代码作保），但「前提成立」这件事会过期——某天给 `.tab-context-menu` 加一条 `white-space: nowrap`
    // 或 `display: flex`，提示就会静默变成单行/被当成 flex 子项，而上面四条断言全绿（记忆
    // expired-reason-for-not-mapping：刻意不做的理由要做成可检的入参）。所以在这里钉住那个前提本身。
    expect(
      declaration('.tab-context-menu', 'white-space'),
      '容器加了 white-space——提示不再默认换行，规则里要显式写回 white-space: normal'
    ).toBe('')
    expect(
      declaration('.tab-context-menu', 'display'),
      '容器改成了 flex/grid——提示会被当成弹性子项，规则里要显式写回 display: block'
    ).toBe('')
    // 反向自证：这条判据靠「读得到就非空」区分，所以拿一个**确实在场**的属性验一次读取器还活着，
    // 否则 declaration() 坏掉时（比如正则失配）上面两条会一起恒绿。
    expect(
      declaration('.tab-context-menu', 'min-width'),
      'declaration() 连容器确实在场的 min-width 都读不到——上面两条 toBe("") 是恒绿的'
    ).not.toBe('')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 右键 Copy 项自己的接线（本轮补的守卫）。
//
// 上面几族守的是「为什么变灰」那句提示。但**变灰这件事本身**——Copy 项 `disabled={!hasSelection}`、
// 以及点下去 `onSelect={onCopy}`——此前没有任何测试守。用户报的第一个症状恰恰是「右键 Copy 是灰的」
// 和「点了没反应」，也就是这两处接线。它们全在 Radix 的 Portal 里，`renderToStaticMarkup` 既不展开
// Portal 也不派发点击，所以和提示那几族同理，只能按 TypeScript AST 判取值关系：
//   - 有选区才可点：`disabled` 的表达式必须正好是 `!hasSelection`。写成 `disabled={false}`（恒可点，
//     但 xterm 停选区时点了复制空区间）或 `disabled={hasSelection}`（极性反了，有选区时反而变灰）都要红。
//   - 点了真的复制：`onSelect` 必须正好是 `onCopy`。接错成 onPaste/onClear，或干脆没接，右键复制静默失效。
// 每条都带在场自证：先定位到那个 Copy 项本身（靠它的子节点 `<span>Copy</span>` 认，不靠位置），
// 找不到就红，免得断言在一个不存在的元素上恒真（记忆 false-green-gate-patterns / presence-assertion-blind）。
// ────────────────────────────────────────────────────────────────────────────
describe('右键 Copy 项：有选区才可点、点了才复制', () => {
  /** JSX 属性 name 上挂的表达式文本；没有该属性或它不是表达式容器时返回 null。 */
  function attrExpression(element: ts.JsxOpeningElement, attrName: string): string | null {
    for (const attribute of element.attributes.properties) {
      if (
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText(file) === attrName &&
        attribute.initializer !== undefined &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression !== undefined
      ) {
        return attribute.initializer.expression.getText(file)
      }
    }
    return null
  }

  /**
   * 找到那个 Copy 菜单项：一个 `ContextMenu.Item`，其子节点里有 `<span>Copy</span>`。
   * 用内容认而不用「第几个 Item」认——加一项、换顺序都不该让这条判据扫错元素
   * （记忆 presence-assertion-blind-when-shape-repeats）。返回其 openingElement；找不到为 null。
   */
  function findCopyItem(): ts.JsxOpeningElement | null {
    let found: ts.JsxOpeningElement | null = null
    const spansCopy = (element: ts.JsxElement): boolean =>
      element.children.some(
        (child) =>
          ts.isJsxElement(child) &&
          child.openingElement.tagName.getText(file) === 'span' &&
          child.children.some((grand) => ts.isJsxText(grand) && grand.getText(file).trim() === 'Copy')
      )
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(file) === 'ContextMenu.Item' &&
        spansCopy(node)
      ) {
        found = node.openingElement
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    return found
  }

  it('存在一个内容为 Copy 的 ContextMenu.Item——判据的扫描对象在场', () => {
    // 在场自证：Copy 项若被改名/拆走，下面两条读的就是 null，会退化成恒真。先把「它在」钉住。
    expect(
      findCopyItem(),
      '找不到内容为 Copy 的 ContextMenu.Item——右键复制入口没了，下面两条接线断言会恒真'
    ).not.toBeNull()
  })

  it('Copy 项的 disabled 正好是 !hasSelection——有选区才可点，且极性没反', () => {
    // 把 disabled 换成 `false`（恒可点：xterm 停选区时点复制空区间）或 `hasSelection`（极性反：有选区
    // 反而变灰），这条都红。判的是表达式文本，不是「有没有 disabled 属性」——后者对极性反完全失明。
    const copyItem = findCopyItem()
    expect(copyItem, 'Copy 项缺席').not.toBeNull()
    expect(
      attrExpression(copyItem!, 'disabled'),
      'Copy 项的 disabled 不是 !hasSelection——要么恒可点（点了复制空区间），要么极性反了（有选区反而变灰）'
    ).toBe('!hasSelection')
  })

  it('Copy 项的 onSelect 正好是 onCopy——点了真的走复制', () => {
    // 接错成 onPaste/onClear，或没接 onSelect，右键复制会静默失效或做成别的事。判 handler 的身份。
    const copyItem = findCopyItem()
    expect(copyItem, 'Copy 项缺席').not.toBeNull()
    expect(
      attrExpression(copyItem!, 'onSelect'),
      'Copy 项的 onSelect 不是 onCopy——右键点 Copy 不会复制（接错了 handler 或没接）'
    ).toBe('onCopy')
  })

  it('自证：onCopy 与 hasSelection 都是组件签名里的 prop，不是自由变量', () => {
    // 上面两条钉的是字面文本 'onCopy' / '!hasSelection'。若这两个名字根本不是组件的入参（改了 prop 名
    // 却忘了改这里），断言会守着一对过时的名字而组件照常工作——这条把「它们确实是当前 prop」钉住。
    const params = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === 'TerminalContextMenu' &&
        node.parameters.length > 0 &&
        ts.isObjectBindingPattern(node.parameters[0]!.name)
      ) {
        for (const element of node.parameters[0]!.name.elements) {
          if (ts.isIdentifier(element.name)) params.add(element.name.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
    expect(params.has('onCopy'), 'onCopy 不是 TerminalContextMenu 的 prop——上一条在守一个过时的名字').toBe(true)
    expect(
      params.has('hasSelection'),
      'hasSelection 不是 TerminalContextMenu 的 prop——disabled 断言在守一个过时的名字'
    ).toBe(true)
  })
})
