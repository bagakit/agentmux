import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { enclosingFunctionBody, isFunctionBoundary, readAndParse } from './helpers/effect-reachability.js'

/**
 * 「复制为什么变灰」这条提示的**取值侧**接线（#638 的根因入口，#782 的缺口）。
 *
 * 分工：`terminal-context-menu-selection-hint.test.ts` 守的是**菜单那一侧**——组件把 `mouseTrackingMode`
 * 喂给 `terminalSelectionSuppressionHint(...)` 并渲染其结果。但那道门对「这个 prop 到底被喂了什么」
 * 完全失明：`TerminalView` 可以一直传 `'none'`，菜单侧 13 条照旧全绿，而用户永远看不到提示。
 * 供给侧此前**零守卫**——那正是 #782 记的洞，也是这个文件存在的全部理由。
 *
 * 为什么是 AST 而不是渲染：desktop 包没有默认 DOM 环境，`renderToStaticMarkup` 既不跑 effect 也不派发
 * pointerdown，所以「右键那一刻真的采样了吗」没法用行为测试守（记忆
 * render-to-static-markup-blind-to-effects）。判据因此落在**取值关系**上，逐条问：
 *
 *   1. 状态本身在场，且 setter 与 JSX 读的是**同一个** useState 声明（避免两个同名概念各活各的）；
 *   2. 采样恰好一处，且它写进去的值就是 `terminalRef.current?.modes.mouseTrackingMode` 这次读取；
 *   3. 采样长在右键手势里（`event.button === 2` 那条分支），不是挂载时算一次；
 *   4. 菜单拿到的就是那个 state，不是字面量。
 *
 * ─── 这道门**不**保证什么 ───
 *
 *   - 它证明不了 `onPointerDown` 真的会被派发、React 真的会重渲染菜单——那要真 DOM 环境，本仓没有。
 *   - 它按词法判「采样在右键分支里」，不推理条件是否等价：把 `event.button === 2` 换成另一条语义相同
 *     的写法会打假红。这是刻意的保守取向（同 effect-reachability 的形状假设）。
 *   - 模式 → 提示文案的映射由 `terminal-selection-mode.test.ts` 逐模式变异钉死，不在这里重测。
 */

const SOURCE_PATH = fileURLToPath(
  new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url)
)
const { sourceFile } = readAndParse(SOURCE_PATH)

/** 文件里所有 `name(...)` 形状的调用（裸标识符被调用，属性访问不算）。 */
function callsTo(name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return calls
}

/**
 * 从 `node` 向上、到最内层函数边界为止，把每一层「把它放进 then 分支」的 `if` 条件收集起来。
 *
 * 用来问「这句调用长在哪条分支下」。落在 else 分支里的不收——那条 `if` 的条件不担保它的极性
 * （与 effect-reachability 的 earlyExitConditionsBefore 同一取向）。
 */
function enclosingThenConditions(node: ts.Node): string[] {
  const conditions: string[] = []
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isFunctionBoundary(current)) break
    if (ts.isIfStatement(current)) {
      const inThen = current.thenStatement.getStart() <= node.getStart() && node.getEnd() <= current.thenStatement.getEnd()
      if (inThen) conditions.push(current.expression.getText(sourceFile).replace(/\s+/gu, ' ').trim())
    }
    current = current.parent
  }
  return conditions
}

/** `const [a, b] = <init>` 里 `init` 的文本；找不到该解构时返回 null。 */
function arrayDestructuringInitializer(names: readonly string[]): string | null {
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      const bound = node.name.elements.map((element) =>
        ts.isBindingElement(element) && ts.isIdentifier(element.name) ? element.name.text : ''
      )
      if (names.every((name, index) => bound[index] === name)) {
        found = node.initializer.getText(sourceFile)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return found
}

/** 名为 `name` 的 `const` 声明的初始化式文本（取最后一个同名声明）；找不到返回 null。 */
function initializerOf(name: string): string | null {
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      found = node.initializer.getText(sourceFile)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return found
}

describe('鼠标上报模式的状态本身', () => {
  it('mouseTrackingMode 与 setMouseTrackingMode 来自同一个 useState，初值是 none', () => {
    // 一对一绑定：把 JSX 读的那个和 handler 写的那个拆成两个各自的 useState，提示就永远显示不出来
    // （写的那个没人读），而单看任何一侧都合法。这条把「它们是同一份状态」钉住。
    const initializer = arrayDestructuringInitializer(['mouseTrackingMode', 'setMouseTrackingMode'])
    expect(
      initializer,
      '找不到 `const [mouseTrackingMode, setMouseTrackingMode] = ...` ——两者不再是同一份状态'
    ).not.toBeNull()
    expect(
      initializer,
      'mouseTrackingMode 不是 useState 的产物——它可能变成了每次渲染现算的值（右键那一刻的模式会丢）'
    ).toMatch(/^useState</u)
    // 初值必须是 'none'：还没右键过就没有可信的模式，不猜。换成某个压制型模式会让提示在冷启动时
    // 无条件出现（说错话）；这是取值判据，不是「有没有传初值」。
    expect(
      initializer,
      "useState 的初值不是 'none'——冷启动时会拿一个没根据的模式去决定要不要提示"
    ).toContain("('none')")
  })
})

describe('采样：右键那一刻，从 xterm 读，恰好一处', () => {
  const setterCalls = callsTo('setMouseTrackingMode')

  it('setMouseTrackingMode 的调用点恰为一处', () => {
    // 在场自证 + 唯一性。0 处 = 采样被删（prop 恒为初值 'none'，提示永久消失，而菜单侧全绿）；
    // 多处 = 有第二个写入点，下面几条抽到的那一个不一定是真正生效的那个
    // （记忆 presence-assertion-blind-when-shape-repeats）。
    expect(
      setterCalls.map((call) => call.getText(sourceFile)),
      'setMouseTrackingMode 的调用点不是恰好一处——采样被删掉或出现了第二个写入点'
    ).toHaveLength(1)
  })

  it('写进去的值就是 terminal.modes.mouseTrackingMode 这次读取', () => {
    // 这是本文件最承重的一条：把实参换成字面量 `'none'`（或任何常量），采样在场、调用点计数不变、
    // 菜单侧 13 条全绿，而提示永远不出现——正是 #782 要抓的那个形状
    // （记忆 optional-prop-only-buys-silence：接线层按 AST 判「值就是那次读取」）。
    expect(setterCalls, '采样调用缺席，这条判据没有对象').toHaveLength(1)
    const argument = setterCalls[0]!.arguments[0]?.getText(sourceFile) ?? ''
    expect(argument, 'setMouseTrackingMode 没有实参').not.toBe('')
    // 实参今天是一个局部名字（先读到 `mode` 再判空），所以顺着它的声明去问取值来源；
    // 直接内联那次读取也接受（下面 toContain 对两种写法同样成立）。
    const source = ts.isIdentifier(setterCalls[0]!.arguments[0]!)
      ? (initializerOf(argument) ?? '')
      : argument
    expect(
      source,
      `采样写入的不是 xterm 的当前模式（实测取值来源：${source || '(读不到)'}）——` +
        '换成常量后菜单侧仍全绿，但提示永远不会出现'
    ).toContain('modes.mouseTrackingMode')
    // 必须读自 xterm 实例本身，不是别处同名字段：钉住 receiver。
    expect(source, '采样读的不是 terminalRef.current 上的模式').toContain('terminalRef.current')
  })

  it('采样长在右键分支里，不是挂载时算一次', () => {
    // 把它搬到 effect / 组件体里，采样会在挂载时发生一次，此后 TUI 再切 DECSET ?1000/?1002/?1003
    // 都不会被看见（xterm 不为模式切换发 React 能订阅的事件）——提示从此说的是开机那一刻的旧话。
    // 判「它在 event.button === 2 这条 then 分支下」。
    expect(setterCalls, '采样调用缺席，这条判据没有对象').toHaveLength(1)
    const conditions = enclosingThenConditions(setterCalls[0]!)
    expect(
      conditions,
      `采样不在 \`event.button === 2\` 分支里（实测所在分支条件：[${conditions.join(' | ')}]）——` +
        '它可能被搬到了挂载期，此后模式切换永远看不见'
    ).toContain('event.button === 2')
    // 前提自证：它确实长在某个函数体内（onPointerDown 那个箭头）。拿不到函数体说明上面那次
    // 向上遍历的边界判断失效了，条件列表可能是从别的作用域凑出来的。
    expect(
      enclosingFunctionBody(setterCalls[0]!),
      '采样调用不在任何函数体内——enclosingThenConditions 的作用域边界不可信'
    ).not.toBeUndefined()
  })

  it('自证：判据认得出「实参被换成字面量」这次变异', () => {
    // 没有这一条，上面那条可能只是恰好在一个它读不懂的形状上返回了空串。用探针走一遍同一条提取路径。
    const probe = ts.createSourceFile(
      'probe.tsx',
      "const mode = 'none'\nsetMouseTrackingMode(mode)",
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX
    )
    let probeInit: string | null = null
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'mode' &&
        node.initializer !== undefined
      ) {
        probeInit = node.initializer.getText(probe)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(probe, visit)
    expect(probeInit, '提取器读不出局部名字的初始化式——上一条的取值判据是恒绿的').toBe("'none'")
    expect(probeInit, '常量初始化式竟然含 modes.mouseTrackingMode——判据分不出真假').not.toContain(
      'modes.mouseTrackingMode'
    )
  })
})

describe('投递：菜单拿到的就是那个 state', () => {
  /** 文件里所有 `<TerminalContextMenu ...>` 开标签（自闭合与成对都认）。 */
  function menuElements(): ts.JsxOpeningLikeElement[] {
    const found: ts.JsxOpeningLikeElement[] = []
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(sourceFile) === 'TerminalContextMenu'
      ) {
        found.push(node)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sourceFile, visit)
    return found
  }

  it('恰好一个 TerminalContextMenu 挂载点', () => {
    // 在场自证：0 个 → 下面那条读的是 undefined 会恒真；多个 → 只钉住其中一个，另一个可以传字面量。
    expect(
      menuElements(),
      'TerminalContextMenu 的挂载点不是恰好一个——下面那条接线断言可能扫错元素或恒真'
    ).toHaveLength(1)
  })

  it('mouseTrackingMode prop 的取值正好是那个 state 变量', () => {
    // 传 `'none'`、传 `undefined`、或干脆不传（prop 曾是可选的），三种写法都让提示永久消失而菜单侧全绿。
    // 判表达式文本的身份，不判「有没有这个属性」——后者对前两种完全失明。
    const element = menuElements()[0]
    expect(element, '菜单挂载点缺席').not.toBeUndefined()
    let expression: string | null = null
    for (const attribute of element!.attributes.properties) {
      if (
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText(sourceFile) === 'mouseTrackingMode' &&
        attribute.initializer !== undefined &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression !== undefined
      ) {
        expression = attribute.initializer.expression.getText(sourceFile)
      }
    }
    expect(
      expression,
      'TerminalContextMenu 没有收到 mouseTrackingMode（属性缺席或不是表达式）——菜单会按 none 处理，提示永不出现'
    ).not.toBeNull()
    expect(
      expression,
      'mouseTrackingMode 传的不是那个 state 变量——采样再对，菜单也看不到'
    ).toBe('mouseTrackingMode')
  })
})
