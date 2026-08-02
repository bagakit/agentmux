import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  earlyExitsBefore,
  findCallsToIdentifier,
  isDescendant,
  isFunctionBoundary,
  parseTsx,
  readAndParse
} from './helpers/effect-reachability.js'

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
 * 所以这条守卫的判据由三块组成：
 *
 *   1. 整个文件里 `prewarmTerminal(` 的**调用点恰好只有一处**。
 *   2. 那一处调用落在一个以 `visible` 为**必要条件**的 `if` 的 then 分支里
 *      （把守护条件按 `&&` 摊平后，其中一个合取项是裸标识符 `visible`）。
 *   3. 那一处调用**可达**：它之前、同一条 effect 体内没有任何提前离开的出口。
 *
 * 第 1、3 两块（找调用、数出口、可达性）现在共用 test/helpers/effect-reachability.ts —— 那份判据在本仓
 * 多处 effect 上重复出现，抽成一处避免每个守卫各写一份、各漏一角。本文件只在其上再叠加**本 effect 专属**
 * 的第 2 块：`visible` 极性。
 *
 * 为什么这三块合起来能抓住每种变异：
 *   - 取反 `!visible`：`!visible` 是 PrefixUnary 不是裸 `visible` 合取项 → 第 2 条红。
 *   - 另加一个无条件调用：调用点变两处 → 第 1 条红。
 *   - 在 effect 第一行插 `if (launcherId) return`（launcherId 恒非空 → 无条件早退）：调用点仍一处、
 *     仍在 `visible` 分支里，前两条完全失明 → 只有第 3 条（可达性）红。
 * 单独任一条都只抓一种；三条一起才都抓得住。
 *
 * 为什么天然免疫「把代码移进注释」这种恒真陷阱：判据读的是 AST 的**调用节点**，注释掉的代码在
 * 语法树里根本不产生 CallExpression。注释掉那行 → 调用点变 0 处 → 第 1 条红。判据不依赖「文件里
 * 出现过某个字符串」，所以没有可以被注释掉而恒真的东西。
 */

const SOURCE_PATH = new URL(
  '../src/renderer/src/components/NewTabSurface.tsx',
  import.meta.url
).pathname

function prewarmCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  return findCallsToIdentifier(sourceFile, 'prewarmTerminal')
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
  const parse = (source: string): ts.SourceFile => parseTsx('NewTabSurface.tsx', source)

  it('整个文件里 prewarmTerminal 的调用点恰好只有一处', () => {
    // 数出口，不数字面量。多一处（无条件预热）或少一处（删空 effect）都在这里红。
    const { sourceFile } = readAndParse(SOURCE_PATH)
    const calls = prewarmCalls(sourceFile)
    expect(calls, `实测调用点：${calls.length} 处，应为 1 处`).toHaveLength(1)
  })

  it('那一处调用以 `visible` 为必要条件（落在 if (… && visible) 的 then 分支里）', () => {
    const { sourceFile } = readAndParse(SOURCE_PATH)
    const [call] = prewarmCalls(sourceFile)
    expect(call, '找不到 prewarmTerminal 调用——上一条会先红').toBeDefined()
    expect(callGuardedByVisible(call!)).toBe(true)
  })

  it('那一处调用之前，effect 体里没有任何提前离开的出口（否则整条 effect 是 no-op）', () => {
    const { sourceFile } = readAndParse(SOURCE_PATH)
    const [call] = prewarmCalls(sourceFile)
    expect(call, '找不到 prewarmTerminal 调用——第一条会先红').toBeDefined()
    const exits = earlyExitsBefore(call!).map((node) => node.getText().trim())
    expect(exits, `调用之前有提前离开的出口：${exits.join(' / ')}`).toEqual([])
  })

  // ---- 下面是「守卫的守卫」：证明上面判据对每种变异各自独立变红，且不是恒真的。 ----
  //
  // 这些自检**不**改真文件读来的源码，而是变异一段硬编码的干净 fixture。理由：真文件被人
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

  it('干净 fixture 上判据都成立（否则自检自身恒假）', () => {
    const calls = prewarmCalls(parse(CLEAN))
    expect(calls).toHaveLength(1)
    expect(callGuardedByVisible(calls[0]!)).toBe(true)
    expect(earlyExitsBefore(calls[0]!)).toEqual([])
  })

  it('自检 M5：在 effect 第一行插一句无条件早退，可达性判据翻红（另两条纹丝不动）', () => {
    // 这就是那个实测出来的洞的精确形状。用 `if (launcherId) return` 而不是裸 `return`：
    // launcherId 恒是非空串（warmLauncherId 返回 `group:…` 或 `region:…`），所以语义上等价于
    // 无条件早退，但**保留了 workspace 的收窄**——裸 return 会让 workspace.id 报 TS18048，
    // 于是给人一种「tsc 会拦住这种事」的错觉。真实的坏形状不报错。
    const mutated = CLEAN.replace(
      '    if (workspace && visible) prewarmTerminal(workspace.id)',
      '    if (launcherId) return\n    if (workspace && visible) prewarmTerminal(workspace.id)'
    )
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    const calls = prewarmCalls(parse(mutated))
    // 前提自检：另两条判据对这次变异**完全失明**——这正是为什么需要第三条。
    expect(calls).toHaveLength(1)
    expect(callGuardedByVisible(calls[0]!)).toBe(true)
    // 只有可达性那条认得出来。
    expect(earlyExitsBefore(calls[0]!)).toHaveLength(1)
  })

  it('自检 M6：throw 也算出口（把早退写成抛异常同样让预热不发生）', () => {
    const mutated = CLEAN.replace(
      '    if (workspace && visible) prewarmTerminal(workspace.id)',
      '    if (launcherId) throw new Error("nope")\n    if (workspace && visible) prewarmTerminal(workspace.id)'
    )
    expect(mutated).not.toBe(CLEAN)
    expect(earlyExitsBefore(prewarmCalls(parse(mutated))[0]!)).toHaveLength(1)
  })

  it('可达性分析器本身可被直接质询：调用之后的 return 与嵌套函数里的 return 都不算', () => {
    const exitsBefore = (body: string): number => {
      const src = `const C = () => { useEffect(() => {\n${body}\n}, []) }`
      const [call] = prewarmCalls(parse(src))
      return earlyExitsBefore(call!).length
    }
    // cleanup 那个 `return () => …` 排在调用**之后**，不是这次调用的出口——否则每个带 cleanup 的
    // effect 都会被误判，这条判据就得靠例外清单活着。
    expect(exitsBefore('  prewarmTerminal(x)\n  return () => stop()')).toBe(0)
    // 嵌套回调里的 return 属于那个回调，不影响外层能不能走到调用。
    expect(exitsBefore('  const f = () => { return 1 }\n  prewarmTerminal(x)')).toBe(0)
    // 真正的早退：调用之前、同一个 effect 体内。
    expect(exitsBefore('  if (a) return\n  prewarmTerminal(x)')).toBe(1)
    expect(exitsBefore('  return\n  prewarmTerminal(x)')).toBe(1)
    expect(exitsBefore('  if (a) throw new Error("x")\n  prewarmTerminal(x)')).toBe(1)
    // 两个出口都数出来，报错信息里能看到全部（而不是只报第一个让人以为只有一处）。
    expect(exitsBefore('  if (a) return\n  if (b) return\n  prewarmTerminal(x)')).toBe(2)
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
