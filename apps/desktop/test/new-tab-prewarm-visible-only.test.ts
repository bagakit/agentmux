import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * 初始页只有在**可见**时才可以预热终端。
 *
 * `warmTerminal` 是全局单槽（一个 key、一个 session，见 store.ts 的 prewarmTerminal）。泊车的
 * （隐藏的）workspace 槽仍然挂载着；如果它们也预热，每个泊车 workspace 都会 spawn 一个 PTY 并
 * 互相踢掉对方那唯一的槽。所以不变量是：`prewarmTerminal` 的**调用只能在 `visible` 为真时发生**。
 *
 * 承载它的是 NewTabSurface.tsx 的这段 effect：
 *
 *     useEffect(() => {
 *       if (workspace && visible) prewarmTerminal(workspace.id)
 *     }, [prewarmTerminal, visible, workspace?.id])
 *
 * 本仓**没有任何 DOM 测试环境**（无 jsdom / happy-dom，vitest.config 里 `environment:` 零命中），
 * 渲染只有 `renderToStaticMarkup`，它**不跑 useEffect**。所以「组件挂载后 effect 有没有以正确极性
 * 调用 prewarm」这件事没法用行为测试守——只能守形状。
 *
 * 但守形状的旧写法是一条**文本断言**（workspace-workbench-registry.test.ts）：
 *
 *     expect(newTab).toContain('if (workspace && visible) prewarmTerminal(workspace.id)')
 *
 * 它被实测绕过：**保留那行字面量不动**，在它上面加一行 `if (workspace) prewarmTerminal(workspace.id)`
 * （无条件），结果每个泊车 workspace 都会预热，而该文件 6 条全绿、`tsc --noEmit` 也干净。这是本仓
 * 反复记录的同族洞——「数符号名守不住别的拼法」「grep 守卫看不见早退」：字面量在场 ≠ 语义正确。
 *
 * 所以这条守卫的判据改成**数出口 + 判极性**，而且用 AST 而不是文本（先例：
 * terminal-link-provider-coverage.test.ts 用 `ts.createSourceFile` 数 activate 出口个数）：
 *
 *   1. 整个文件里 `prewarmTerminal(` 的**调用点恰好只有一处**。
 *   2. 那一处调用落在一个以 `visible` 为**必要条件**的 `if` 的 then 分支里
 *      （把守护条件按 `&&` 摊平后，其中一个合取项是裸标识符 `visible`）。
 *
 * 为什么这两条能同时抓住两种变异：
 *   - 取反 `!visible`：`!visible` 是 PrefixUnary 不是裸 `visible` 合取项 → 第 2 条红。
 *   - 另加一个无条件调用：调用点变两处 → 第 1 条红。
 * 单独任一条都只抓一种；两条一起才两种都抓。
 *
 * 为什么天然免疫「把代码移进注释」这种恒真陷阱：判据读的是 AST 的**调用节点**，注释掉的代码在
 * 语法树里根本不产生 CallExpression。注释掉那行 → 调用点变 0 处 → 第 1 条红。判据不依赖「文件里
 * 出现过某个字符串」，所以没有可以被注释掉而恒真的东西。
 */

const SOURCE_PATH = new URL(
  '../src/renderer/src/components/NewTabSurface.tsx',
  import.meta.url
).pathname
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('NewTabSurface.tsx', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
}

/**
 * 文件里所有 `prewarmTerminal(...)` 的调用表达式。
 *
 * 只认「标识符 `prewarmTerminal` 直接被调用」这一形状。line 72 的
 * `const prewarmTerminal = useAppStore((state) => state.prewarmTerminal)` 里，`prewarmTerminal`
 * 一处是声明名、一处是属性访问名，都不是「被调用的标识符」，所以不会命中。
 */
function prewarmCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'prewarmTerminal'
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

/** 剥掉外层括号。`(visible)`、`((a && b))` 都还原成里面那个真表达式。 */
function unwrap(expr: ts.Expression): ts.Expression {
  let node = expr
  while (ts.isParenthesizedExpression(node)) node = node.expression
  return node
}

/** 把 `a && b && c` 这样的合取链摊平成 [a, b, c]；非 `&&` 的表达式原样单独返回。 */
function conjuncts(expr: ts.Expression): ts.Expression[] {
  const node = unwrap(expr)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...conjuncts(node.left), ...conjuncts(node.right)]
  }
  return [node]
}

/** 这个表达式是不是恰好是裸标识符 `name`（去括号后）。`!visible`、`visible === true` 都不算。 */
function isBareIdentifier(expr: ts.Expression, name: string): boolean {
  const node = unwrap(expr)
  return ts.isIdentifier(node) && node.text === name
}

/** `node` 是否在 `container` 的子树内（含自身）。依赖 createSourceFile 建了 parent 指针。 */
function isDescendant(node: ts.Node, container: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (current === container) return true
    current = current.parent
  }
  return false
}

/** 函数边界：守护条件必须与调用**在同一个函数体内**，不能借用外层函数里的 `if (visible)`。 */
function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  )
}

/**
 * 这个调用是否被「以 `visible` 为必要条件」的分支守住。
 *
 * 从调用向上找 `if`，直到撞上函数边界（撞上就说明这个调用所在的函数里没有任何守护，返回 false）。
 * 一个 `if` 算数，需要同时满足：
 *   - 调用落在它的 then 分支里，而**不**在 else 分支里（`if (visible) {} else { prewarm() }`
 *     意味着不可见时才跑，极性正好相反）；
 *   - 它的条件按 `&&` 摊平后，含有裸 `visible` 合取项（于是「visible 为真」是这个 `if` 进入的必要条件）。
 * 允许嵌套：只要向上任意一层这样的 `if` 成立即可（`visible` 仍是必要条件）。
 */
function callGuardedByVisible(call: ts.CallExpression): boolean {
  let current: ts.Node | undefined = call.parent
  while (current) {
    if (isFunctionBoundary(current)) return false
    if (ts.isIfStatement(current)) {
      const inElse = current.elseStatement ? isDescendant(call, current.elseStatement) : false
      const inThen = isDescendant(call, current.thenStatement)
      if (inThen && !inElse && conjuncts(current.expression).some((c) => isBareIdentifier(c, 'visible'))) {
        return true
      }
    }
    current = current.parent
  }
  return false
}

describe('创建页只在可见时预热终端（否则每个泊车 workspace 都会抢那唯一的热终端槽）', () => {
  it('整个文件里 prewarmTerminal 的调用点恰好只有一处', () => {
    // 数出口，不数字面量。多一处（无条件预热）或少一处（删空 effect）都在这里红。
    const calls = prewarmCalls(parse(SOURCE))
    expect(calls, `实测调用点：${calls.length} 处，应为 1 处`).toHaveLength(1)
  })

  it('那一处调用以 `visible` 为必要条件（落在 if (… && visible) 的 then 分支里）', () => {
    const [call] = prewarmCalls(parse(SOURCE))
    expect(call, '找不到 prewarmTerminal 调用——上一条会先红').toBeDefined()
    expect(callGuardedByVisible(call!)).toBe(true)
  })

  // ---- 下面是「守卫的守卫」：证明上面两条判据对每种变异各自独立变红，且不是恒真的。 ----
  //
  // 这些自检**不**改真文件读来的 SOURCE，而是变异一段硬编码的干净 fixture。理由：真文件被人
  // 施加变异做验收时（本任务要求逐个施加 M1–M4），若自检也 `SOURCE.replace()`，那个 replace 会
  // 因为「要替换的原串已经不在了」而 no-op，于是自检自己红成一片噪音，盖过「哪条**真判据**红了」
  // 这个才是要看的信号。fixture 与真 effect 同形，所以它照样证明分析器认得每种形状。

  /** 与真 effect 同形的干净样本：单一调用，落在 `workspace && visible` 的 then 分支里。 */
  const CLEAN = [
    'const C = () => {',
    '  useEffect(() => {',
    '    if (workspace && visible) prewarmTerminal(workspace.id)',
    '  }, [prewarmTerminal, visible, workspace?.id])',
    '}'
  ].join('\n')

  it('干净 fixture 上两条判据都成立（否则自检自身恒假）', () => {
    const calls = prewarmCalls(parse(CLEAN))
    expect(calls).toHaveLength(1)
    expect(callGuardedByVisible(calls[0]!)).toBe(true)
  })

  it('自检 M1：把守护改成 !visible，极性判据翻红（计数不变）', () => {
    const mutated = CLEAN.replace('workspace && visible', 'workspace && !visible')
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    const calls = prewarmCalls(parse(mutated))
    // 调用点仍是一处（M1 不加不减），所以计数那条不会红——只有极性那条能认出这次变异。
    expect(calls).toHaveLength(1)
    expect(callGuardedByVisible(calls[0]!)).toBe(false)
  })

  it('自检 M2：在原行上面加一行无条件预热，计数判据翻红', () => {
    const mutated = CLEAN.replace(
      '    if (workspace && visible) prewarmTerminal(workspace.id)',
      '    if (workspace) prewarmTerminal(workspace.id)\n    if (workspace && visible) prewarmTerminal(workspace.id)'
    )
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    // 原字面量原封不动地留着——这正是文本断言绕不过去的地方；AST 数出口能看见两处。
    expect(prewarmCalls(parse(mutated))).toHaveLength(2)
  })

  it('自检 M3：把 effect 体删空，计数判据翻红', () => {
    const mutated = CLEAN.replace('    if (workspace && visible) prewarmTerminal(workspace.id)\n', '')
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    expect(prewarmCalls(parse(mutated))).toHaveLength(0)
  })

  it('自检 M4：把那行代码移进注释，判据不被骗（AST 里注释不产生调用节点）', () => {
    const mutated = CLEAN.replace(
      '    if (workspace && visible) prewarmTerminal(workspace.id)',
      '    // if (workspace && visible) prewarmTerminal(workspace.id)'
    )
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    // 若判据靠「文件里出现过这行字符串」恒真，这里会被骗成绿；靠 AST 则调用点变 0 处。
    expect(prewarmCalls(parse(mutated))).toHaveLength(0)
  })

  it('极性分析器本身可被直接质询：裸 visible 合取项通过，取反/缺席/在 else 里都不通过', () => {
    const guarded = (cond: string): boolean => {
      const src = `const C = () => { useEffect(() => { if (${cond}) prewarmTerminal(x) }, []) }`
      const [call] = prewarmCalls(parse(src))
      return callGuardedByVisible(call!)
    }
    expect(guarded('workspace && visible')).toBe(true)
    expect(guarded('visible && workspace')).toBe(true) // 顺序无关
    expect(guarded('(workspace && visible)')).toBe(true) // 去括号
    expect(guarded('workspace && !visible')).toBe(false) // 取反
    expect(guarded('workspace')).toBe(false) // 根本没有 visible
    expect(guarded('workspace || visible')).toBe(false) // visible 不是必要条件（OR）
    expect(guarded('visible === false')).toBe(false) // 不是裸标识符

    // 调用落在 if(visible) 的 else 分支里：不可见时才跑，极性相反，不算被守住。
    const inElse = 'const C = () => { if (visible) {} else { prewarmTerminal(x) } }'
    const [elseCall] = prewarmCalls(parse(inElse))
    expect(callGuardedByVisible(elseCall!)).toBe(false)

    // 完全没有 if 包裹（无条件调用）：向上撞到函数边界前找不到守护，返回 false。
    const bare = 'const C = () => { useEffect(() => { prewarmTerminal(x) }, []) }'
    const [bareCall] = prewarmCalls(parse(bare))
    expect(callGuardedByVisible(bareCall!)).toBe(false)
  })
})
