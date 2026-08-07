import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

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
