// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
 * desktop 包没有 DOM/IME 测试环境：无 jsdom / happy-dom / @testing-library / renderHook。
 * 于是：
 *   谓词层（part a）—— isImeOwnedKeyboardEvent 是纯函数，直接调用并逐个析取项断言。
 *   手势钩子层（part b）—— useImeEnterGestureOwnership 的返回是一组闭包，其内部状态挂在 useRef 上、
 *      由 useMemo 一次性建好。用 renderToStaticMarkup 挂一个探针组件把返回值**捕获**出来即可反复驱动
 *      （SSR 会跑 useRef/useMemo，返回的闭包在渲染后照旧可用）。requestAnimationFrame node 没有，
 *      按需注入一个可控的假实现，绝不依赖真实定时。
 *   接线层（part c）—— 四个 call site 的 onKeyDown 是内联 JSX 箭头函数，既没导出、也无法在不挂载整棵
 *      组件树（store + radix dialog + dnd-kit + canvas）的情况下驱动。所以这里走 TS AST：断言每个
 *      «带 Enter 分支的 onKeyDown» 里，组字守卫（isImeCompositionKeyDown → 裸 return）真的在场、且排在
 *      Enter 分支**之前**。这比 `toContain('isImeCompositionKeyDown')` 强：它校验的是形状（调谓词 + 裸
 *      return）与位置（在 Enter 之前），正是 M6（删掉那一行）会破坏的东西。它**不**保证 React 会把
 *      handler 接成 DOM 监听器、Chromium 会按这个顺序派发 composition 事件——那要真 DOM。
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
// part c：接线层。四个 call site 的 onKeyDown 是内联箭头，无法在不挂载整棵组件树的情况下驱动，
// 故走 AST：每个带 Enter 分支的 onKeyDown 里，组字守卫必须在场且排在 Enter 分支之前（M6 删掉它即红）。
// ---------------------------------------------------------------------------
const RENDERER = resolve(__dirname, '../src/renderer/src')
const CALL_SITES: ReadonlyArray<{ file: string; guardedEnterHandlers: number }> = [
  { file: 'components/FileExplorer.tsx', guardedEnterHandlers: 2 },
  { file: 'components/QuickSwitcher.tsx', guardedEnterHandlers: 1 },
  { file: 'components/browser-screenshot/ScreenshotEditor.tsx', guardedEnterHandlers: 1 }
]

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

/** 该文件里所有 onKeyDown={(...) => { ... }} 的箭头函数块体（语句数组）。 */
function onKeyDownHandlers(path: string): ts.Statement[][] {
  const handlers: ts.Statement[][] = []
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
      handlers.push([...node.initializer.expression.body.statements])
    }
    ts.forEachChild(node, walk)
  }
  walk(parse(path))
  return handlers
}

/** 语句是否为「if (isImeCompositionKeyDown(...)) return」——调谓词 + 裸 return（含单语句块）。 */
function isCompositionGuard(stmt: ts.Statement): boolean {
  if (!ts.isIfStatement(stmt)) return false
  if (!ts.isCallExpression(stmt.expression)) return false
  if (stmt.expression.expression.getText() !== 'isImeCompositionKeyDown') return false
  const then = stmt.thenStatement
  const isBareReturn = (s: ts.Statement): boolean => ts.isReturnStatement(s) && s.expression === undefined
  if (isBareReturn(then)) return true
  return ts.isBlock(then) && then.statements.length === 1 && isBareReturn(then.statements[0])
}

function mentionsEnter(stmt: ts.Statement): boolean {
  return /===\s*'Enter'/u.test(stmt.getText())
}

describe('四个 commit-on-Enter call site 的组字守卫在场且先于 Enter 分支', () => {
  for (const site of CALL_SITES) {
    it(`${site.file}：每个带 Enter 分支的 onKeyDown 都先判组字守卫`, () => {
      const path = `${RENDERER}/${site.file}`
      // import 必须在场，否则守卫引用的是未定义名字（tsc 在 test 环境看不到组件源码，这里自己钉）。
      expect(readFileSync(path, 'utf8')).toMatch(
        /import \{ isImeCompositionKeyDown \} from ['"].*ime-composition-keyboard-event['"]/u
      )
      const enterHandlers = onKeyDownHandlers(path).filter((stmts) => stmts.some(mentionsEnter))
      // 自检：提取器真的找到了预期数量的「带 Enter 的 onKeyDown」，否则「一个都没扫到」会静默通过。
      expect(
        enterHandlers.length,
        `期望 ${site.guardedEnterHandlers} 个带 Enter 分支的 onKeyDown，实得 ${enterHandlers.length}——` +
          '提取器写错、或某个 call site 被删/改形'
      ).toBe(site.guardedEnterHandlers)
      for (const stmts of enterHandlers) {
        const guardIndex = stmts.findIndex(isCompositionGuard)
        const enterIndex = stmts.findIndex(mentionsEnter)
        expect(guardIndex, `组字守卫缺席（M6 删掉了它？）：${stmts.map((s) => s.getText()).join(' ')}`).toBeGreaterThanOrEqual(0)
        expect(guardIndex, '组字守卫排在 Enter 分支之后：确认 Enter 会先触发提交').toBeLessThan(enterIndex)
      }
    })
  }
})
