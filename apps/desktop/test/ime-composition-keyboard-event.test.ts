// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  isImeCompositionKeyDown,
  isImeOwnedKeyboardEvent,
  resolveImeModifierGesture,
  useImeEnterGestureOwnership
} from '../src/renderer/src/lib/ime-composition-keyboard-event'

/**
 * Lane A：CJK 组字确认用的 Enter 不能触发「回车即提交」的输入框，否则会以半转换的草稿提交。
 *
 * ─── 这一族**不能**用真 DOM 行为测试守到底，必须明说（与 composer-ime.test.ts 同一课）───
 *
 * 真实输入法仍需系统验证；富文本编辑器的 DOM 事件链另由 composer-input-ownership.test.tsx 验证。
 * 于是：
 *   谓词层（part a）—— isImeOwnedKeyboardEvent 是纯函数，直接调用并逐个析取项断言。
 *   手势钩子层（part b）—— useImeEnterGestureOwnership 的返回是一组闭包，其内部状态挂在 useRef 上、
 *      由 useMemo 一次性建好。用 renderToStaticMarkup 挂一个探针组件把返回值**捕获**出来即可反复驱动
 *      （SSR 会跑 useRef/useMemo，返回的闭包在渲染后照旧可用）。requestAnimationFrame node 没有，
 *      按需注入一个可控的假实现，绝不依赖真实定时。
 *   接线层（part c）—— 每个 call site 的 onKeyDown 是内联 JSX 箭头函数或同文件具名函数，既没导出、也无法
 *      在不挂载整棵组件树（store + radix dialog + dnd-kit + canvas）的情况下驱动。所以这里走 TS AST：
 *      遍历 renderer 下每个 .tsx，发现 onKeyDown handler，断言每个都带组字守卫：调谓词、**实参恰好是本
 *      handler 的形参**、且守卫**可达**（它之前不得有无条件退出）。这比 `toContain('isImeCompositionKeyDown')`
 *      强三层，正是 M6（删掉那一行）、「实参传 {} as never」、「首行插早退让整段变 no-op」各自会破坏的东西。
 *
 *      ── 发现的边界（这里只看得见一种「在 Enter 上动作」的写法，别把它读成「所有」）──
 *      发现只认：`x.key === 'Enter'`（AST，非注释/无关字符串）出现在**块体内联箭头** `onKeyDown={(e) => { … }}`，
 *      或指向**同文件可解析的具名函数/箭头声明**的 `onKeyDown={foo}` 里。以下五种写法，一个未守的
 *      commit-on-Enter 输入对发现是**不可见**的（实测复核过）：
 *        (1) `keyCode === 13` —— comparesEnterKey 只认字符串字面量 'Enter'，不认键码。
 *        (2) `['Enter'].includes(x.key)` —— 不是 `=== 'Enter'` 的二元比较，看不见。
 *        (3) 简写体箭头 `onKeyDown={(e) => submit()}`（无 `{}` 块）—— 只认 isBlock(body)，直接跳过。
 *        (4) useCallback 包起来的 handler —— 初始化器是 CallExpression 不是箭头/函数声明，findNamedFunctionBody 认不出。
 *        (5) `onKeyDown={identifier}` 而该名字在本文件解析不到（import 进来 / useCallback 结果 / 拼错）——
 *            过去**静默跳过**；本轮已把它转成一次响亮失败（见下方「无法解析的 onKeyDown={标识符}」断言），
 *            所以 (5) 不再是无声盲点，但 (1)–(4) 仍然开着。
 *      也就是说 part c 是一道**已知有洞**的地板，不是完备普查；它**更不**保证 React 会把 handler 接成 DOM
 *      监听器、Chromium 会按此顺序派发 composition 事件——那要真 DOM。
 */

// ---------------------------------------------------------------------------
// part a：谓词。四个来源各自承重——删掉任意一个析取项，恰好一条 it 变红。
// ---------------------------------------------------------------------------
describe('isImeOwnedKeyboardEvent 读四个来源，每个都单独承重', () => {
  it('M1：合成事件 isComposing===true（其余来源都不满足）', () => {
    // keyCode 未设（≠229），nativeEvent 缺席。只有 isComposing 这一项能让它为真。
    expect(isImeOwnedKeyboardEvent({ isComposing: true })).toBe(true)
  })

  it('M2：合成事件 keyCode===229 兜底（isComposing 非真、nativeEvent 缺席）', () => {
    expect(isImeOwnedKeyboardEvent({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('M3：nativeEvent.isComposing===true（顶层两项都不满足、nativeEvent.keyCode≠229）', () => {
    expect(
      isImeOwnedKeyboardEvent({ isComposing: false, keyCode: 13, nativeEvent: { isComposing: true, keyCode: 13 } })
    ).toBe(true)
  })

  it('M4：nativeEvent.keyCode===229（最易漏的第四项；其余三项都不满足）', () => {
    // 顶层 isComposing 非真、顶层 keyCode≠229、nativeEvent.isComposing 非真。只剩这一项。
    expect(
      isImeOwnedKeyboardEvent({ isComposing: false, keyCode: 13, nativeEvent: { isComposing: false, keyCode: 229 } })
    ).toBe(true)
  })

  it('普通 Enter（无组字标记）不被认作 IME 拥有', () => {
    // 反向锚点：四个来源全不满足时必须为 false，否则某个析取项被改成恒真也不会被上面四条抓到。
    expect(
      isImeOwnedKeyboardEvent({ isComposing: false, keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } })
    ).toBe(false)
    // isImeCompositionKeyDown 是同一判据的薄包装，一并钉住它不是恒真/恒假。
    expect(isImeCompositionKeyDown({ nativeEvent: { isComposing: true } } as never)).toBe(true)
    expect(isImeCompositionKeyDown({ nativeEvent: { isComposing: false, keyCode: 13 } } as never)).toBe(false)
  })
})

// resolveImeModifierGesture 是被复制过来的第四个导出，本轮无 call site（见报告）。这里只钉住它不是
// 恒定返回，以免它被顺手改坏而无人察觉。
describe('resolveImeModifierGesture', () => {
  it('带修饰键的标记事件建立所有权并在无标记的派发键上保留', () => {
    const armed = resolveImeModifierGesture(false, { ctrlKey: true, isComposing: true })
    expect(armed).toEqual({ active: true, carried: false, owned: true })
    const carried = resolveImeModifierGesture(armed.active, { ctrlKey: false, isComposing: false })
    expect(carried).toEqual({ active: false, carried: true, owned: true })
    expect(resolveImeModifierGesture(false, { ctrlKey: true, isComposing: false })).toEqual({
      active: false,
      carried: false,
      owned: false
    })
  })
})

// ---------------------------------------------------------------------------
// part b：两次-keydown carry 手势钩子。
// ---------------------------------------------------------------------------
type CapturedGesture = ReturnType<typeof useImeEnterGestureOwnership>

/** 用 SSR 渲染把钩子返回值捕获出来（useRef/useMemo 会跑，返回的闭包渲染后仍可用）。 */
function captureGestureHook(): CapturedGesture {
  let captured: CapturedGesture | undefined
  function Probe(): null {
    captured = useImeEnterGestureOwnership()
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  if (!captured) throw new Error('钩子未被捕获——SSR 探针写错或钩子改了返回形状')
  return captured
}

function gestureEvent(init: {
  key: string
  keyCode: number
  altKey?: boolean
  ctrlKey?: boolean
  isComposing?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}): { readonly prevented: boolean } & Record<string, unknown> {
  let prevented = false
  return {
    key: init.key,
    keyCode: init.keyCode,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    nativeEvent: { isComposing: init.isComposing ?? false },
    preventDefault: () => {
      prevented = true
    },
    get prevented() {
      return prevented
    }
  }
}

/** 装一个可控的 requestAnimationFrame，返回「跑掉所有排队帧」的手柄；用完必须 restore。 */
function installFakeRaf(): { runFrames: () => void; restore: () => void } {
  const frames: Array<() => void> = []
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number }
  const previous = g.requestAnimationFrame
  g.requestAnimationFrame = (cb: () => void): number => {
    frames.push(cb)
    return frames.length
  }
  return {
    runFrames: () => {
      const pending = frames.splice(0)
      for (const frame of pending) frame()
    },
    restore: () => {
      if (previous === undefined) delete g.requestAnimationFrame
      else g.requestAnimationFrame = previous
    }
  }
}

describe('useImeEnterGestureOwnership', () => {
  it('标记的确认 keydown 武装 carry，紧随的无标记裸 Enter 被吞掉（M5）', () => {
    const gesture = captureGestureHook()
    gesture.setComposing(true)
    // 确认那次 keydown：仍在组字，IME 拥有它。
    expect(gesture.ownsKeyDown(gestureEvent({ key: 'Enter', keyCode: 13, isComposing: true }) as never)).toBe(true)

    gesture.setComposing(false)
    // 随后重新派发的那个无标记裸 Enter 必须被吞掉，否则半转换草稿会被提交。
    const redispatch = gestureEvent({ key: 'Enter', keyCode: 13 })
    expect(gesture.ownsKeyDown(redispatch as never)).toBe(true)
    expect(redispatch.prevented).toBe(true)
  })

  it('带修饰键的 Enter（chord）不被吞掉——那是用户越过 IME 的提交', () => {
    const gesture = captureGestureHook()
    gesture.setComposing(true)
    // 即使按住修饰键，确认那次 keydown 仍归 IME。
    expect(
      gesture.ownsKeyDown(gestureEvent({ key: 'Enter', keyCode: 13, isComposing: true, ctrlKey: true }) as never)
    ).toBe(true)
    gesture.setComposing(false)
    const chord = gestureEvent({ key: 'Enter', keyCode: 13, ctrlKey: true })
    expect(gesture.ownsKeyDown(chord as never)).toBe(false)
    expect(chord.prevented).toBe(false)
  })

  it('Shift+Enter 永不被拥有（组字中与重新派发都不）', () => {
    const gesture = captureGestureHook()
    gesture.setComposing(true)
    const marked = gestureEvent({ key: 'Enter', keyCode: 13, isComposing: true, shiftKey: true })
    expect(gesture.ownsKeyDown(marked as never)).toBe(false)
    gesture.setComposing(false)
    const redispatch = gestureEvent({ key: 'Enter', keyCode: 13, shiftKey: true })
    expect(gesture.ownsKeyDown(redispatch as never)).toBe(false)
    expect(redispatch.prevented).toBe(false)
  })

  it('carry 熬过 keyup、只在下一帧到来前仍有效（M7：同步清会漏掉 macOS 的重新派发）', () => {
    // macOS：keyup 先到、重新派发后到。carry 若在 keyup 上同步过期，重新派发的 Enter 就不再被吞，
    // 半转换草稿被提交。所以：keyup 之后、帧尚未跑之前，重新派发的裸 Enter 仍必须被吞掉。
    const gesture = captureGestureHook()
    gesture.setComposing(true)
    expect(gesture.ownsKeyDown(gestureEvent({ key: 'Enter', keyCode: 13, isComposing: true }) as never)).toBe(true)
    gesture.setComposing(false)

    const raf = installFakeRaf()
    // keyup 先到（macOS 顺序）：只应安排下一帧过期，不应同步清。
    gesture.onKeyUp(gestureEvent({ key: 'Enter', keyCode: 13 }) as never)
    // 帧还没跑——重新派发到达：carry 仍在，必须吞掉它。
    const redispatch = gestureEvent({ key: 'Enter', keyCode: 13 })
    const owned = gesture.ownsKeyDown(redispatch as never)
    raf.restore()

    expect(owned).toBe(true)
    expect(redispatch.prevented).toBe(true)
  })

  it('carry 在下一帧确实过期，此后用户真正的 Enter 能提交（拼音每键 Process/229 的场景）', () => {
    const gesture = captureGestureHook()
    gesture.setComposing(true)
    // 拼音选字：最后一个组字键是个数字，被报成 Process/229，武装了 carry。
    expect(gesture.ownsKeyDown(gestureEvent({ key: 'Process', keyCode: 229, isComposing: true }) as never)).toBe(true)
    gesture.setComposing(false)

    const raf = installFakeRaf()
    gesture.onKeyUp(gestureEvent({ key: '1', keyCode: 49 }) as never)
    raf.runFrames()
    raf.restore()

    // carry 已过期：这是用户随后深思熟虑的 Enter，必须放行。
    const deliberate = gestureEvent({ key: 'Enter', keyCode: 13 })
    expect(gesture.ownsKeyDown(deliberate as never)).toBe(false)
    expect(deliberate.prevented).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// part c：接线层（发现式扫描，取代此前手写的三文件清单）。
//
// 此前这里钉的是一张手写的 CALL_SITES 三文件清单，有三处结构性失明，本轮全部补上：
//   (1) 守卫从不读实参：旧 isCompositionGuard 只认 callee 文本 + 裸 return，于是
//       `isImeCompositionKeyDown({} as never)` / `(event.currentTarget as never)` 每个 call site 照样通过。
//       —— 现在要求实参恰好是**该 handler 自己的第一个形参标识符**（不匹配字面量 'event'：
//          那会把一个合法改名的形参打成假红，见 read-key-and-write-key / 「不认字面量 event」原则）。
//   (2) 在场 ≠ 可达：在守卫**上方**插一句无条件 `return`/`throw`，或 `if (event) return`（其 test 就是那个
//       恒真的事件形参），会让整个 handler 变 no-op，而「守卫在场且在 Enter 之前」仍成立、14/14 全绿。
//       —— 现在拒绝守卫之前任何**无条件退出**本 handler 的语句（guard-must-check-reachability-not-presence）。
//   (3) 手写文件清单 = 枚举而非测量：明天新增第 N 个 commit-on-Enter 输入，这张表根本看不见它。
//       —— 现在**扫描** renderer 下每个 .tsx，发现「在 Enter 上动作」的 onKeyDown（内联块体箭头 **和**
//          同文件可解析的具名函数引用都算），要求每个都带守卫；合法地不需要守卫的，进一张逐条具名带理由的例外表。
//          注意：例外表**不是**靠「逐条具名」获得封闭性的——那句话本文件此前写过，实测是假的。真正挡住
//          「剥掉某个守卫 + 自己往例外表里加一条」的，只有例外表**条数被钉成字面量**那一条断言
//          （EXPECTED_EXCEPTION_COUNT，见该表上方注释里那次实测逃生构造）。
//          且这次「扫描」**不是完备普查**：发现只认块体内联箭头 / 同文件可解析具名函数里的 `x.key === 'Enter'`。
//          `keyCode === 13`、`['Enter'].includes(...)`、简写体箭头、useCallback 包装 —— 这四种写法的未守输入
//          对发现仍不可见（顶部 docstring 逐条列了）。第五种 `onKeyDown={无法解析的标识符}` 曾被静默跳过，
//          本轮已转成响亮失败（见下方对应断言），不再是无声盲点。
//
// 守卫有两种合法形状，两者都要求「实参 = 本 handler 形参」且「可达」：
//   · 独立式：`if (isImeCompositionKeyDown(P)) return`，排在 Enter 分支之前（FileExplorer / QuickSwitcher /
//     ScreenshotEditor）。
//   · 内联式：提交 Enter 的那个 `if` 的条件里含 `!isImeCompositionKeyDown(P)` 合取项（AgentComposer）。
//
// 仍**不**保证 React 会把 handler 接成 DOM 监听器、Chromium 会按此顺序派发 composition 事件——那要真 DOM。
// ---------------------------------------------------------------------------
const RENDERER = resolve(__dirname, '../src/renderer/src')
const GUARD = 'isImeCompositionKeyDown'
// React wrapper and native predicate share one implementation; both must inspect this handler's event.
const GUARDS = new Set([GUARD, 'isImeOwnedKeyboardEvent'])
// 造锚点时要跳过的「噪声 callee」：它们出现在几乎每个 handler 里，不能用来标识 handler。
const CALLEE_NOISE = new Set(['preventDefault', 'stopPropagation', ...GUARDS])

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function walkTsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkTsxFiles(p))
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** 子树里是否出现 `x.key === 'Enter'`（或 `'Enter' === x.key`）——用 AST，避开注释/无关字符串里的 'Enter'。 */
function comparesEnterKey(node: ts.Node): boolean {
  let found = false
  const isEnterLiteral = (n: ts.Node): boolean => ts.isStringLiteral(n) && n.text === 'Enter'
  const walk = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      (isEnterLiteral(n.left) || isEnterLiteral(n.right))
    ) {
      found = true
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return found
}

/** 子树里所有调用的最内层被调标识符名（给 handler 造稳定锚点用）。 */
function collectCallees(node: ts.Node): string[] {
  const out: string[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression
      if (ts.isIdentifier(c)) out.push(c.text)
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return out
}

/** 「若被执行到就必定退出本 handler」——对本仓的直线块足够。 */
function alwaysExits(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true
  if (ts.isBlock(stmt)) return stmt.statements.some(alwaysExits)
  return false
}

/**
 * 守卫之前的这条语句是否**无条件**退出 handler（→ 守卫不可达，整个 handler 变 no-op）。
 * 认两类：直接的 return/throw；以及 test 恰好是那个恒真事件形参（或字面 true）的 `if (…) return`。
 * 合法早退如 `if (a || b) return`（test 是复合表达式、非裸形参）不被误判。
 */
function unconditionalExitBeforeGuard(stmt: ts.Statement, paramName: string): boolean {
  if (alwaysExits(stmt)) return true
  if (ts.isIfStatement(stmt) && !stmt.elseStatement) {
    const test = stmt.expression
    const triviallyTrue =
      (ts.isIdentifier(test) && test.text === paramName) || test.kind === ts.SyntaxKind.TrueKeyword
    if (triviallyTrue && alwaysExits(stmt.thenStatement)) return true
  }
  return false
}

/** call 的被调是否就是裸标识符 GUARD、且唯一实参恰好是 `paramName`（结构判等，不认字面量 'event'）。 */
function callIsGuardOnParam(call: ts.CallExpression, paramName: string): boolean {
  if (!ts.isIdentifier(call.expression) || !GUARDS.has(call.expression.text)) return false
  const args = call.arguments
  const arg = args[0]
  return args.length === 1 && arg !== undefined && ts.isIdentifier(arg) && arg.text === paramName
}

/** 独立式：`if (GUARD(param)) <bare return>`（含单语句块）。 */
function isStandaloneGuard(stmt: ts.Statement, paramName: string): boolean {
  if (!ts.isIfStatement(stmt) || stmt.elseStatement) return false
  if (!ts.isCallExpression(stmt.expression)) return false
  if (!callIsGuardOnParam(stmt.expression, paramName)) return false
  const bareReturn = (s: ts.Statement): boolean => ts.isReturnStatement(s) && s.expression === undefined
  const then = stmt.thenStatement
  if (bareReturn(then)) return true
  if (!ts.isBlock(then) || then.statements.length !== 1) return false
  const only = then.statements[0]
  return only !== undefined && bareReturn(only)
}

/** 内联式：把 `&&` 链摊平，找 `!GUARD(param)` 合取项。 */
function conditionInlinesGuard(expr: ts.Expression, paramName: string): boolean {
  const conjuncts: ts.Expression[] = []
  const flatten = (e: ts.Expression): void => {
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      flatten(e.left)
      flatten(e.right)
    } else {
      conjuncts.push(e)
    }
  }
  flatten(expr)
  return conjuncts.some(
    (c) =>
      ts.isPrefixUnaryExpression(c) &&
      c.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isCallExpression(c.operand) &&
      callIsGuardOnParam(c.operand, paramName)
  )
}

/** 一组语句（某 handler 的体）是否被合法守卫：实参=形参、且守卫可达。 */
function isHandlerGuarded(stmts: ts.Statement[], paramName: string | null): boolean {
  if (paramName === null) return false
  const enterIdx = stmts.findIndex((s) => comparesEnterKey(s))
  if (enterIdx < 0) return false
  // 内联式：提交 Enter 的那条 if，其条件含 !GUARD(param)；守卫位置就是这条语句本身。
  const enterStmt = stmts[enterIdx]
  if (enterStmt && ts.isIfStatement(enterStmt) && conditionInlinesGuard(enterStmt.expression, paramName)) {
    return !stmts.slice(0, enterIdx).some((s) => unconditionalExitBeforeGuard(s, paramName))
  }
  // 独立式：Enter 之前存在一条 `if (GUARD(param)) return`，且它之前没有无条件退出。
  for (let g = 0; g < enterIdx; g++) {
    const candidate = stmts[g]
    if (candidate && isStandaloneGuard(candidate, paramName)) {
      return !stmts.slice(0, g).some((s) => unconditionalExitBeforeGuard(s, paramName))
    }
  }
  return false
}

function bodyStatements(body: ts.Node): ts.Statement[] {
  return ts.isBlock(body) ? [...body.statements] : []
}

function paramNameOf(params: ts.NodeArray<ts.ParameterDeclaration>): string | null {
  const p = params[0]
  return p && ts.isIdentifier(p.name) ? p.name.text : null
}

/** 同文件内解析 `onKeyDown={handleFoo}` 指向的具名函数/箭头声明。 */
function findNamedFunctionBody(
  sf: ts.SourceFile,
  name: string
): { params: ts.NodeArray<ts.ParameterDeclaration>; body: ts.Node } | null {
  let hit: { params: ts.NodeArray<ts.ParameterDeclaration>; body: ts.Node } | null = null
  const walk = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) {
      hit = { params: n.parameters, body: n.body }
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      hit = { params: n.initializer.parameters, body: n.initializer.body }
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
  return hit
}

function enclosingTag(attr: ts.JsxAttribute): string {
  let el: ts.Node | undefined = attr.parent
  while (el && !(ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el))) el = el.parent
  return el ? (el as ts.JsxOpeningElement | ts.JsxSelfClosingElement).tagName.getText() : '?'
}

/** 稳定锚点（绝不用行号）：具名 → `<file>::fn:<名>`；箭头 → `<file>::<标签>:<首个非噪声 callee>`。 */
function anchorFor(file: string, tag: string, fnName: string | null, callees: string[]): string {
  if (fnName) return `${file}::fn:${fnName}`
  const action = callees.find((c) => !CALLEE_NOISE.has(c)) ?? '?'
  return `${file}::${tag}:${action}`
}

type DiscoveredHandler = { file: string; anchor: string; tag: string; guarded: boolean }
/** onKeyDown={标识符}，但那个名字在同文件里解析不到（import 进来 / useCallback 包 / 拼错）。 */
type UnresolvableHandler = { file: string; name: string }
type DiscoveryResult = { handlers: DiscoveredHandler[]; unresolvable: UnresolvableHandler[] }

/** 发现 renderer 下每个「在 Enter 上动作」的 onKeyDown handler（内联箭头 + 具名函数引用）。 */
function discoverCommitOnEnterHandlers(): DiscoveryResult {
  const handlers: DiscoveredHandler[] = []
  const unresolvable: UnresolvableHandler[] = []
  for (const path of walkTsxFiles(RENDERER)) {
    const sf = parse(path)
    const file = path.slice(RENDERER.length + 1)
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText() === 'onKeyDown' &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      ) {
        const init = node.initializer.expression
        let params: ts.NodeArray<ts.ParameterDeclaration> | null = null
        let body: ts.Node | null = null
        let fnName: string | null = null
        if (ts.isArrowFunction(init) && ts.isBlock(init.body)) {
          params = init.parameters
          body = init.body
        } else if (ts.isIdentifier(init)) {
          const named = findNamedFunctionBody(sf, init.text)
          if (named) {
            params = named.params
            body = named.body
            fnName = init.text
          } else {
            // onKeyDown={foo} 但 foo 不是本文件的具名函数/箭头声明 —— 发现对它的体完全失明。
            // 曾经这里静默 continue（一个可能未守的 commit-on-Enter 输入就此逃出扫描面）。现在收集起来，
            // 由下面一条断言**响亮**报出来（GAP 2：把静默跳过转成被抓住的一类）。
            unresolvable.push({ file, name: init.text })
          }
        }
        if (params && body) {
          const stmts = bodyStatements(body)
          if (stmts.some((s) => comparesEnterKey(s))) {
            const paramName = paramNameOf(params)
            const tag = enclosingTag(node)
            handlers.push({
              file,
              anchor: anchorFor(file, tag, fnName, collectCallees(body)),
              tag,
              guarded: isHandlerGuarded(stmts, paramName)
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { handlers, unresolvable }
}

// 例外表：被发现、但**合法地不需要**组字守卫的 commit-on-Enter handler。每条自带理由。
//
// **这张表就是本族守卫的逃生门，所以它自己的大小必须被钉死**（下面 EXPECTED_EXCEPTION_COUNT）。原因是实测出来的：
// 本文件此前在这里写「封闭且逐条具名的集合……新的未守 handler 无法悄悄混进例外」，那句话是**假的**。真正挡住
// 「剥掉某个 handler 的守卫 + 把它的锚点加进本表」这条逃生路的，只有下面两处**硬编码计数地板**
// （必守集 ≥5、已守文件 ≥4）；而地板只在树里没有余量时才开火。实测构造：先加一个**合法带守卫**的新
// commit-on-Enter 输入（已守文件 4→5、必守集 5→6，两个地板同时获得余量），再剥掉 QuickSwitcher 的守卫并把它的
// 锚点写进本表 —— Test Files 1 passed (1)、Tests 23 passed (23)，一个真的未守输入在全绿下发货。
// 也就是说地板买到的是「今天恰好没余量」，不是封闭性，而且它随着代码库长大而**静默失效**。
//
// 因此判据换成：本表的条数被钉成一个字面量。加一条例外必须同时改那个数字 —— 那是个响亮、必然被 review 看见的
// 动作，而不是往数组里悄悄塞一项。配合第三条断言（每条例外恰好命中一个**当前未被守卫**的 handler）与本条，
// 「换掉一条例外」也会红：被换掉的那条锚点不再命中任何未守 handler。
//
// 这个数字该收到多少：本表四条里**两条是永久事实豁免**（FileExplorer 的树导航、WorkspaceWorkbench 的
// requestClose——它是个按 Enter/Space 激活的 span 按钮，不承载文本草稿），**两条是 peer 欠账**
// （TerminalView 的搜索框、WorkspaceWorkbench 的重命名输入）。所以两个 peer 文件落地、补上守卫之后，
// 这个数字应当收到 **2**，不是 0 也不是 1。（69d2ed0 的 message 在这里写了「改到 1」，那是错的：
// 它把 requestClose 也算成了欠账。分类由下面每条的 **kind 字段**声明、并被交叉核对，见该表下方的 kind/tag 断言；
// reason 只是给人看的解释，不再是分类的依据。）
const EXPECTED_EXCEPTION_COUNT = 6
// `kind` 是**机器可判**的分类声明，不从 reason 散文里解析（本仓规则：分类必须是声明字段，绝不 parse 散文）。
//   · 'fact' —— 事实豁免：这个 handler 落在非文本可编辑元素上（按钮 / 树导航），永远不承载 IME 组字确认。
//   · 'debt' —— peer 欠账：它落在 input/textarea 这类文本编辑元素上、在 Enter 上提交草稿，文件落地后欠一个组字守卫。
// 下面一条断言拿**外层元素标签**（scanner 已算出的 enclosingTag）交叉核对 kind：debt 必须坐在文本编辑元素上、
// fact 必须不坐在文本编辑元素上。于是把一条 debt 谎报成 fact（或反向）会当场翻红——散文继续做人类解释，
// kind 才是被守住的那句主张。
const GUARD_EXCEPTIONS: ReadonlyArray<{ anchor: string; kind: 'fact' | 'debt'; reason: string }> = [
  {
    anchor: 'components/FileExplorer.tsx::fn:handleTreeKeyDown',
    kind: 'fact',
    reason:
      '事实豁免：树导航，Enter 打开文件/展开目录；树行不是可编辑文本，永远不承载 IME 组字确认，本就不该带组字守卫。'
  },
  {
    anchor: 'components/TerminalView.tsx::input:searchWith',
    kind: 'debt',
    reason:
      '欠账：TerminalView.tsx 为 peer 未提交改动持有，本轮不得编辑。搜索框在 Enter 上跑搜索，' +
      '该文件一旦落地就欠一个组字守卫——届时把本条删掉并补上守卫。'
  },
  {
    anchor: 'components/WorkspaceWorkbench.tsx::input:commitRename',
    kind: 'debt',
    reason:
      '欠账：WorkspaceWorkbench.tsx 为 peer 未提交改动持有，本轮不得编辑。重命名输入在 Enter 上提交草稿，' +
      '文件落地后欠一个组字守卫——届时把本条删掉并补上守卫。'
  },
  {
    anchor: 'components/WorkspaceWorkbench.tsx::span:requestClose',
    kind: 'fact',
    reason:
      '事实豁免：role=button 的 span 按 Enter/Space 激活以关闭 Tab，不承载文本草稿，' +
      '所以它永远不该带组字守卫——这一条不随 WorkspaceWorkbench.tsx 落地而消失。' +
      '（该文件同时为 peer 持有、本轮只读，但那与本条是不是欠账无关。）'
  },
  {
    anchor: 'components/GlobalBoardSurface.tsx::div:onSelect',
    kind: 'fact',
    reason:
      '事实豁免：Demand 卡片是 role=button 的 div，按 Enter/Space 选中这张卡（onSelect → setSelectedDemand），' +
      '卡片内没有任何 input/textarea/contentEditable，不承载文本草稿。它还先判 ' +
      'event.target !== event.currentTarget 就退出，连子元素冒泡上来的按键都不接。' +
      '与 span:requestClose 同一类——按钮语义的激活键，不是提交草稿。'
  },
  {
    anchor: 'components/WorkspaceBoard.tsx::span:openRow',
    kind: 'fact',
    reason:
      '事实豁免：Board 行首是 role=button 的 span，按 Enter/Space 打开这一行（openRow → 打开 Topic/' +
      'workspace/worktree），行首里只有 strong/small 文本，没有任何可编辑元素，不承载文本草稿。' +
      '与 span:requestClose / div:onSelect 同一类。'
  }
]

// debt 例外必须坐在这些文本编辑元素上、fact 例外必须不坐在上面。standalone/自结束标签的 tagName 都是裸元素名。
const TEXT_EDIT_TAGS = new Set(['input', 'textarea'])

describe('part c：发现式接线层——每个 commit-on-Enter 的 onKeyDown 都带组字守卫（实参=形参、且可达）', () => {
  const { handlers, unresolvable } = discoverCommitOnEnterHandlers()
  const exceptionAnchors = new Set(GUARD_EXCEPTIONS.map((e) => e.anchor))

  it('自检：扫描确实发现了 commit-on-Enter handler（扫描根写错会静默全绿）', () => {
    // 下界取「干净/已提交文件上可证的最少条数」，与 peer 文件是否在途无关：
    // AgentComposer(1) + FileExplorer(内联编辑×2 + handleTreeKeyDown) + QuickSwitcher(1) + ScreenshotEditor(1) = 6。
    expect(
      handlers.length,
      `只发现 ${handlers.length} 个 commit-on-Enter handler——RENDERER 根写错、或 walk/发现逻辑坏了`
    ).toBeGreaterThanOrEqual(6)
  })

  it('每个非例外的 commit-on-Enter handler 都被合法守卫（实参=本 handler 形参、且守卫可达）', () => {
    const required = handlers.filter((h) => !exceptionAnchors.has(h.anchor))
    // 这是一道**地板**，不是封闭性论证：它只保证「例外表没把所有 handler 都吞掉」，一旦树里长出更多已守
    // handler 就获得余量、不再对「多划一条例外」开火。封闭性由「例外表条数被钉死」那条负责（见上）。
    expect(required.length, '必守集为空——例外表把所有 handler 都吞了？').toBeGreaterThanOrEqual(5)
    for (const h of required) {
      expect(
        h.guarded,
        `${h.anchor}: 缺少合法组字守卫。要求 Enter 分支之前有 if(${GUARD}(形参)) return，或该 if 条件内联 ` +
          `!${GUARD}(形参)；且实参必须是本 handler 的第一个形参，守卫之前不得有无条件退出。`
      ).toBe(true)
    }
  })

  it('例外表的条数被钉死：加/换一条例外必须显式改这个数字', () => {
    // 这是本族**唯一**真正封闭的判据（见 GUARD_EXCEPTIONS 上方注释里那次实测逃生）。往表里塞一项就红，
    // 于是「剥掉守卫 + 自己写一条例外」不再能在全绿下发货。数字变大要有一条新的事实豁免理由；变小是好事，
    // 说明某个欠账还上了——改小同样要显式动这一行。
    expect(
      GUARD_EXCEPTIONS.length,
      `例外表条数从 ${EXPECTED_EXCEPTION_COUNT} 变成了 ${GUARD_EXCEPTIONS.length}。` +
        '加例外＝给某个 commit-on-Enter 输入开一道免检门，必须在 review 里被看见：确认它真的不承载 IME ' +
        '组字（或它是 peer 持有的欠账），再把 EXPECTED_EXCEPTION_COUNT 一起改掉。'
    ).toBe(EXPECTED_EXCEPTION_COUNT)
  })

  it('例外表逐条有效：每条例外恰好命中一个被发现的 handler，且当前确未被守卫', () => {
    for (const ex of GUARD_EXCEPTIONS) {
      const matches = handlers.filter((h) => h.anchor === ex.anchor)
      expect(matches.length, `例外锚点已失效/漂移，未命中任何被发现的 handler：${ex.anchor}`).toBe(1)
      const only = matches[0]
      if (!only) throw new Error(`例外锚点未命中：${ex.anchor}`)
      // 例外一旦真被守卫，就该从表里删掉（否则它白占位、削弱封闭性）。
      expect(
        only.guarded,
        `例外 ${ex.anchor} 现在带上了守卫——请把它从 GUARD_EXCEPTIONS 里删除。理由存档：${ex.reason}`
      ).toBe(false)
      expect(ex.reason.length, `例外必须自带理由：${ex.anchor}`).toBeGreaterThan(0)
    }
  })

  it('例外的 kind 与外层元素标签自洽：debt 坐在文本编辑元素上、fact 不坐（分类不从散文解析，由此交叉核对）', () => {
    // GAP 1：此前 reason 上唯一的断言是 length>0，于是把一条 debt 谎报成 fact 能全绿发货。现在 kind 是声明字段，
    // 拿 scanner 已算出的外层元素标签（enclosingTag）当判别器：承载文本草稿的元素才可能欠一个组字守卫。
    // 两个方向各钉一次（本仓有「守卫只守一侧出口」的先例）。
    for (const ex of GUARD_EXCEPTIONS) {
      const only = handlers.find((h) => h.anchor === ex.anchor)
      if (!only) throw new Error(`例外锚点未命中，无法核对 kind：${ex.anchor}`)
      const onTextEdit = TEXT_EDIT_TAGS.has(only.tag)
      if (ex.kind === 'debt') {
        expect(
          onTextEdit,
          `例外 ${ex.anchor} 标了 kind:'debt'（欠一个组字守卫），但它坐在 <${only.tag}> 上、不是 ` +
            `input/textarea 这类文本编辑元素——不承载文本草稿的元素不会欠组字守卫，它应当是 'fact'。`
        ).toBe(true)
      } else {
        expect(
          onTextEdit,
          `例外 ${ex.anchor} 标了 kind:'fact'（永不该带组字守卫），但它坐在 <${only.tag}> 这个文本编辑元素上——` +
            `文本编辑元素在 Enter 上会提交草稿，这条其实是 'debt'（peer 文件落地后欠一个组字守卫）。`
        ).toBe(false)
      }
    }
  })

  it('无法解析的 onKeyDown={标识符} 必须响亮报出（曾经被静默跳过——发现对它的体完全失明）', () => {
    // GAP 2：onKeyDown={foo} 而 foo 不是本文件具名函数/箭头声明（import 进来 / useCallback 包 / 拼错）时，
    // 发现逻辑读不到它的体，无从判断它是不是未守的 commit-on-Enter 输入。旧代码在此静默 continue，
    // 于是这类 handler 整个逃出扫描面。现在把它转成一次**响亮失败**：点名文件 + 标识符，逼下一个作者
    // 要么把它改成可解析的形状，要么显式扩展发现逻辑去解析它——不再是一个无人察觉的盲点。
    expect(
      unresolvable,
      unresolvable.length === 0
        ? ''
        : `发现无法解析的 onKeyDown={标识符}，其 handler 体对扫描不可见：` +
          unresolvable.map((u) => `${u.file}::${u.name}`).join('、') +
          '。请把它改成同文件内可解析的具名函数/箭头声明，或扩展 discoverCommitOnEnterHandlers 去解析这种引用。'
    ).toEqual([])
  })

  it('每个已守文件都真 import 了 SSOT 谓词（守卫不能引用未定义名字）', () => {
    const guardedFiles = [...new Set(handlers.filter((h) => h.guarded).map((h) => h.file))]
    // AgentComposer / FileExplorer / QuickSwitcher / ScreenshotEditor 四个文件承载那 5 个已守 handler。
    expect(guardedFiles.length, '一个已守文件都没有？发现逻辑坏了').toBeGreaterThanOrEqual(4)
    for (const file of guardedFiles) {
      const sourceFile = parse(`${RENDERER}/${file}`)
      const used = collectCallees(sourceFile).filter((name) => GUARDS.has(name))
      expect(used.length, `${file}: no guard calls found`).toBeGreaterThan(0)
      const imported = sourceFile.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
            !statement.moduleSpecifier.text.endsWith('ime-composition-keyboard-event')) return []
        const bindings = statement.importClause?.namedBindings
        return bindings && ts.isNamedImports(bindings)
          ? bindings.elements.filter((item) => !item.propertyName || item.propertyName.text === item.name.text).map((item) => item.name.text) : []
      })
      for (const name of used) expect(imported, `${file}: ${name} must be imported from the SSOT`).toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// part c 自检：把分类器（实参=形参 / 可达性 / 两种形状）钉在合成 TSX 片段上。
//
// 上面那组断言的判据强度全押在 isHandlerGuarded 上——如果它退化成「见到 GUARD 就算守住」，真实源码今天恰好
// 正确，全组照旧会绿（合成 fixture 等于自证的反面：这里我们**要**合成，因为要证的是分类器本身而非某个真 call
// site）。所以拿一批**手写的、已知答案**的 handler 片段喂给同一个 isHandlerGuarded，正负各钉一遍：任何一个
// 判据被改松（不读实参 / 不看可达性 / 少认一种形状 / 把无条件早退当合法早退放行）都会让这里某条翻红。
// ---------------------------------------------------------------------------
/** 解析一个「onKeyDown 箭头」片段，抽出它的语句数组 + 形参名，交给 isHandlerGuarded 判定。 */
function classifySnippet(handlerArrow: string): boolean {
  const src = `const _el = <div onKeyDown=${handlerArrow} />\n`
  const sf = ts.createSourceFile('snippet.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let result: boolean | null = null
  const walk = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText() === 'onKeyDown' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isArrowFunction(node.initializer.expression) &&
      ts.isBlock(node.initializer.expression.body)
    ) {
      const arrow = node.initializer.expression
      result = isHandlerGuarded(bodyStatements(arrow.body), paramNameOf(arrow.parameters))
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  if (result === null) throw new Error('分类器自检片段没解析出 onKeyDown 箭头——片段写坏了')
  return result
}

describe('part c 分类器自检：isHandlerGuarded 的四个判据都非空转', () => {
  it.each([...GUARDS])('%s preserves argument identity and reachability', (guard) => {
    expect(classifySnippet(`{(event) => { if (event.key === 'Enter' && !${guard}(event)) submit() }}`)).toBe(true)
    expect(classifySnippet(`{(event) => { if (event.key === 'Enter' && !${guard}(other)) submit() }}`)).toBe(false)
    expect(classifySnippet(`{(event) => { return; if (event.key === 'Enter' && !${guard}(event)) submit() }}`)).toBe(false)
  })

  it('独立式：if(GUARD(形参)) return 在 Enter 之前 → 守住', () => {
    expect(
      classifySnippet(`{(event) => {
        if (isImeCompositionKeyDown(event)) return
        if (event.key === 'Enter') submit()
      }}`)
    ).toBe(true)
  })

  it('内联式：Enter 条件里含 !GUARD(形参) → 守住', () => {
    expect(
      classifySnippet(`{(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !isImeCompositionKeyDown(event) && ok) submit()
      }}`)
    ).toBe(true)
  })

  it('实参判据：GUARD 的实参不是本 handler 形参（{} as never）→ 不算守住（钉死缺陷#1 独立式）', () => {
    expect(
      classifySnippet(`{(event) => {
        if (isImeCompositionKeyDown({} as never)) return
        if (event.key === 'Enter') submit()
      }}`)
    ).toBe(false)
  })

  it('实参判据（内联式）：!GUARD({} as never) → 不算守住（钉死缺陷#1 内联式）', () => {
    expect(
      classifySnippet(`{(event) => {
        if (event.key === 'Enter' && !isImeCompositionKeyDown({} as never) && ok) submit()
      }}`)
    ).toBe(false)
  })

  it('实参判据认「同名不同参」：GUARD(other) 即便叫得出名字也不算（必须是本 handler 首个形参）', () => {
    expect(
      classifySnippet(`{(event) => {
        if (isImeCompositionKeyDown(other)) return
        if (event.key === 'Enter') submit()
      }}`)
    ).toBe(false)
  })

  it('可达性判据：守卫上方一句无条件 return → 不算守住（钉死缺陷#2）', () => {
    expect(
      classifySnippet(`{(event) => {
        if (event) return
        if (isImeCompositionKeyDown(event)) return
        if (event.key === 'Enter') submit()
      }}`)
    ).toBe(false)
  })

  it('可达性判据不误伤合法早退：if(a || b) return 之后仍可守住（test 是复合表达式，非裸形参）', () => {
    expect(
      classifySnippet(`{(event) => {
        if (event.altKey || event.metaKey) return
        if (isImeCompositionKeyDown(event)) return
        if (event.key === 'Enter') submit()
      }}`)
    ).toBe(true)
  })

  it('缺守卫：只有 Enter 分支、没有任何 GUARD → 不算守住（钉死缺陷#3 那类「整段没守卫」）', () => {
    expect(
      classifySnippet(`{(event) => {
        if (event.key === 'Enter') submit()
      }}`)
    ).toBe(false)
  })
})
