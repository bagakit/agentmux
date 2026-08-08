import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TerminalViewportSynchronizer } from '../src/renderer/src/lib/terminal-viewport-sync'
import {
  findCallsToIdentifier,
  findCallsToMember,
  parseTsx,
  assertEarlyExitGuards
} from './helpers/effect-reachability'

// ---------------------------------------------------------------------------
// Guard 2 — 改字号必须真的重排已开着的终端，不只是「调了 setter」。
//
// 一个字号变化的形状很特别：容器 CSS 像素**没变**，但每个格子的像素尺寸变了，于是整块 grid
// （cols/rows）都动了。这正好撞上 `fitAndSynchronize` 的抖动闸——它认为「grid 变了但容器像素
// 没变」是 WebGL/DOM cell-metric 的瞬时抖动，直接 return 不 fit。所以一次**普通的**
// observeViewport() 在字号变化后会被这道闸静默吞掉，PTY 永远收不到新的行列数、TUI 按旧网格串行。
//
// 判据因此是**行为**的：把 synchronizer 放进「上次成功 fit 的像素 == 现在的像素、但 grid 发散」
// 这个精确场景里，
//   · 普通 observeViewport() 一路跑完 → resize **没有**被调用（抖动闸挡住，这是缺陷形状）；
//   · synchronizeCellMetrics() 一路跑完 → resize **被**调用且带新 grid（缺陷被治好）。
// 只断言「setter 被调过」是数不出这个差别的——那正是本仓反复记录的假绿。
// ---------------------------------------------------------------------------

const frameHarness = () => {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  return {
    request(callback: FrameRequestCallback) {
      nextId += 1
      callbacks.set(nextId, callback)
      return nextId
    },
    cancel(frameId: number) {
      callbacks.delete(frameId)
    },
    async runAll() {
      // Drain every queued frame, including ones a frame schedules while running, so the stability
      // loop settles exactly as it does in the browser.
      for (let guard = 0; guard < 64 && callbacks.size > 0; guard += 1) {
        const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined
        if (!entry) break
        callbacks.delete(entry[0])
        entry[1](0)
        await Promise.resolve()
      }
    }
  }
}

/**
 * A synchronizer that has already gone live and settled on a fitted grid at a fixed container size —
 * the exact preconditions the wobble gate reads. `cellPx` is how many CSS px one cell takes on each
 * axis; raising it (a bigger font) shrinks the proposed grid while the container pixels stay put.
 */
async function liveSettledSynchronizer() {
  const frames = frameHarness()
  const viewportPx = { width: 1200, height: 800 }
  let cellPx = { w: 10, h: 20 }
  const gridFor = () => ({
    cols: Math.floor(viewportPx.width / cellPx.w),
    rows: Math.floor(viewportPx.height / cellPx.h)
  })
  let actual = gridFor()
  const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
  const sync = new TerminalViewportSynchronizer({
    proposeGrid: () => gridFor(),
    fit: () => { actual = gridFor() },
    readGrid: () => actual,
    resize,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    measureViewport: () => ({ ...viewportPx })
  })
  await sync.startLiveSynchronization()
  await frames.runAll()
  resize.mockClear()
  return {
    sync,
    resize,
    runAll: frames.runAll,
    // Simulate a font-size change: same container pixels, larger cells ⇒ the grid diverges while
    // measureViewport keeps returning the last-fitted pixels. This is precisely the wobble shape.
    growFont() { cellPx = { w: 12, h: 24 } }
  }
}

describe('terminal font-size live refit reaches the PTY', () => {
  it('自检：字号变化确实制造「grid 发散、容器像素不变」这个抖动闸场景', async () => {
    const harness = await liveSettledSynchronizer()
    harness.growFont()
    // 普通 observe 走完后 resize 一次都没有——证明抖动闸真的把这个形状挡住了。若这条为假，
    // 下面那条「synchronizeCellMetrics 能穿过」就不再证明任何东西（场景本身就不需要穿透）。
    harness.sync.observeViewport()
    await harness.runAll()
    expect(harness.resize).not.toHaveBeenCalled()
  })

  it('synchronizeCellMetrics 穿过抖动闸，把新 grid 送到 PTY', async () => {
    const harness = await liveSettledSynchronizer()
    harness.growFont()
    harness.sync.synchronizeCellMetrics()
    await harness.runAll()
    // 更大的字号 ⇒ 更少的行列。容器 1200×800、cell 12×24 ⇒ 100×33。
    expect(harness.resize).toHaveBeenCalledWith({ cols: 100, rows: 33 })
  })

  it('普通 observeViewport 与 synchronizeCellMetrics 在同一场景下结果相反', async () => {
    // 把两条路并排跑在同一初始状态上：差异只来自 synchronizeCellMetrics 清掉了像素基线。
    const viaObserve = await liveSettledSynchronizer()
    viaObserve.growFont()
    viaObserve.sync.observeViewport()
    await viaObserve.runAll()

    const viaSync = await liveSettledSynchronizer()
    viaSync.growFont()
    viaSync.sync.synchronizeCellMetrics()
    await viaSync.runAll()

    expect(viaObserve.resize).not.toHaveBeenCalled()
    expect(viaSync.resize).toHaveBeenCalledTimes(1)
  })
})

// TerminalView 里那条 effect 无法在本仓跑（没有 DOM 测试环境，renderToStaticMarkup 不跑 effect）。
// 所以「字号 effect 里，refit 那句调用**可达**」用 AST 可达性判据守——文本 toContain 看不见
// 在它之前插一句 `return` 造成的整段 no-op（本仓 renderer-effect-reachability 的同一族判据）。
describe('TerminalView applies the size to an open terminal and refits', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url)),
    'utf8'
  )
  const sourceFile = parseTsx('TerminalView.tsx', source)

  it('字号 effect 调用 synchronizeCellMetrics，且之前只有那两句合法守护', () => {
    const calls = findCallsToMember(sourceFile, 'synchronizeCellMetrics')
    expect(calls, 'synchronizeCellMetrics() 应恰有一处调用').toHaveLength(1)
    // 合法守护恰好两句：跳过挂载首跑（attach 已在构造期用过字号），以及 open terminal 缺席时不做。
    // 任何在这之外**另插**一句早退（把整段 effect 变成 no-op）都会让白名单不匹配而红——这正是
    // 「文本 toContain 看不见早退」的补法。删掉这两句本应在场的守护，同样红。
    assertEarlyExitGuards(
      calls[0]!,
      ['!fontSizeMountedRef.current', '!terminal'],
      'TerminalView font-size effect'
    )
  })

  it('refit 之前先把新字号写到 open terminal 的 options 上', () => {
    // 只 refit 而不改 terminal.options.fontSize，xterm 会按旧字号重新 fit，字号根本不变。
    // 两件事必须都在这条 effect 里：设 options + 触发 refit。
    expect(source).toContain('terminal.options.fontSize = fontSize')
  })

  it('attach effect 不依赖 fontSize（改字号不能重建 xterm、重放 scrollback）', () => {
    // attach effect 的依赖数组钉死为这三项。把 fontSize 加进去会让每次改字号都拆掉 xterm 重放
    // 历史输出——一次严重的体验回归，且静默。依赖数组是承重的，用 AST 读它而不是文本匹配。
    const attachDeps = findCallsToIdentifier(sourceFile, 'useEffect')
      .map((call) => call.arguments[1])
      .filter((arg): arg is NonNullable<typeof arg> => Boolean(arg))
      .map((arg) => arg.getText())
      .filter((text) => text.includes('session.control.run.runId'))
    expect(attachDeps, 'attach effect 依赖数组应能被定位到').toHaveLength(1)
    expect(attachDeps[0]).not.toContain('fontSize')
  })
})
