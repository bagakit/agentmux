import { describe, expect, it, vi } from 'vitest'
import { TerminalViewportSynchronizer } from '../src/renderer/src/lib/terminal-viewport-sync'

/**
 * 「按错的宽度排好的 replay 要补一次重绘」这条机制，判据锚点错过两次，所以这个文件专钉锚点，
 * 不重测 `terminal-viewport-sync.test.ts` 已经守着的其余行为。
 *
 * 错法一（b5209aa 发货的形状，审计实测）：锚在「第一次 live fit 这一次挪了 grid 吗」。
 * 而非 live 的 fit 也会挪 grid——`fitAndSynchronize` 里的 `fit()` 不看 `this.live`，只有
 * `requestResize` 被挡。于是调用方排在 attach 之前的那一帧，完全可以在 replay 字节写进解析器
 * **之后**、第一次 live fit **之前**把 grid 挪到终值；此后两端相等，判据答否，那一屏 80 列
 * 排好的 alt screen 永久留在屏上。
 *
 * 错法二（我修第一版时的形状，被本文件第三条用例当场打红）：锚在「synchronizer 建好之后挪过吗」。
 * xterm 一律以 80×24 构造、第一次 fit 必然挪，所以这个问法在每一格上恒真——等于无条件重绘，
 * 不再是判据，每个全新终端都白搭一对 resize。
 *
 * 现在锚在 `markReplayLanded()` 记下的那一刻，上面两条路径就都判对了。前两条用例只差
 * 「重放在 pre-fit 之前还是之后」，那一对就是判据的分界。
 *
 * 这个文件另开一份而不是加进 terminal-viewport-sync.test.ts：那个文件是多个并发方向的共享锚点。
 */

function frameHarness() {
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
    runNext() {
      const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined
      if (!entry) return false
      callbacks.delete(entry[0])
      entry[1](0)
      return true
    }
  }
}

/**
 * 一个跟着 fit 走的假 xterm：`fit()` 把 actual 挪到 proposed，`readGrid()` 报 actual。
 * 与被测对象的关系就是真 xterm 与 FitAddon 的关系，没有别的耦合。
 */
function terminalHarness(initial: { cols: number; rows: number }) {
  const frames = frameHarness()
  let proposed = { ...initial }
  let actual = { ...initial }
  const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
  const sync = new TerminalViewportSynchronizer({
    proposeGrid: () => proposed,
    fit: () => {
      actual = { ...proposed }
    },
    readGrid: () => actual,
    resize,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    // 像素跟着列/行走，好让抖动闸只在"像素真没变"时才介入（这里从不触发）。
    measureViewport: () => ({ width: proposed.cols * 10, height: proposed.rows * 20 })
  })
  return {
    sync,
    frames,
    resize,
    setProposed(next: { cols: number; rows: number }) {
      proposed = { ...next }
    },
    grid: () => actual
  }
}

/**
 * 数「补重绘」发生了几次。
 *
 * 判据取 `requestContentRedraw` 自己的签名：它先送**恰好差一格**的临时尺寸（rows-1，行不够时
 * cols-1），紧接着送回终值。所以只认「前一次是终值差一格、后一次是终值」这种相邻对。
 *
 * 别用宽一点的「前一次不是终值、后一次是终值」——那样连"第一次抵达终值"都算成一次重绘：起活后
 * 又改一次尺寸时，`132x45 → 100x30` 这对会被误判，于是"只重绘一次"那条用例会对着正确的实现打红。
 *
 * 代价是本文件的尺寸必须彼此差一格以上（现在最近的一对是 100x30 与 132x45），否则一次普通的
 * 单格 resize 会与重绘同形。这个前提由下面的断言各自钉住的终值保证。
 */
function redrawRoundTrips(
  resize: ReturnType<typeof vi.fn>,
  settled: { cols: number; rows: number }
): number {
  const calls = resize.mock.calls.map(([size]) => `${size.cols}x${size.rows}`)
  const settledKey = `${settled.cols}x${settled.rows}`
  const oneCellOff = new Set([
    `${settled.cols}x${settled.rows - 1}`,
    `${settled.cols - 1}x${settled.rows}`
  ])
  let trips = 0
  for (let index = 0; index + 1 < calls.length; index += 1) {
    if (oneCellOff.has(calls[index]) && calls[index + 1] === settledKey) trips += 1
  }
  return trips
}

describe('replay 之后的重排补救：判据锚在「重放那一刻的 grid」', () => {
  it('非 live 的 fit 排在重放之后时，起活仍要补一次重绘', async () => {
    // 事故路径：调用方在 attach 之前排了一帧（TerminalView 的 onRender / 首次 observeViewport
    // 都会），而它跑在 replay 字节之后。此时 grid 已被挪到终值。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    // 重放发生在 80 列上——xterm 就是以 80×24 构造的。
    harness.sync.markReplayLanded()

    harness.setProposed({ cols: 132, rows: 45 })
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    // 非 live 的 fit 挪了 grid，但一个字节也没送到 PTY。
    expect(harness.grid()).toEqual({ cols: 132, rows: 45 })
    expect(harness.resize).not.toHaveBeenCalled()

    await harness.sync.startLiveSynchronization()

    // 此刻「这一次 fit 挪没挪」答否（两端都是 132×45），但重放那一屏是按 80 列排的。
    expect(
      redrawRoundTrips(harness.resize, { cols: 132, rows: 45 }),
      '非 live 的 fit 抢先挪了 grid，起活时就不补重绘了——按 80 列排好的 replay 会留在屏上。' +
        '判据要锚在重放那一刻的 grid，不是「第一次 live fit 这一次挪没挪」。'
    ).toBe(1)
    // 重绘收在终值上：几何的所有者仍是稳定尺寸那一方。
    expect(harness.resize.mock.calls.at(-1)?.[0]).toEqual({ cols: 132, rows: 45 })
  })

  it('非 live 的 fit 排在重放之前时不重绘：那一屏本来就是按对的宽度排的', async () => {
    // 与上一条同样有 pre-fit，只有「重放在 fit 之前还是之后」不同——这一对就是判据的分界。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    harness.setProposed({ cols: 132, rows: 45 })
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    expect(harness.grid()).toEqual({ cols: 132, rows: 45 })

    // 重放此时才落地，已经是按 132 列排的。
    harness.sync.markReplayLanded()

    await harness.sync.startLiveSynchronization()

    expect(
      redrawRoundTrips(harness.resize, { cols: 132, rows: 45 }),
      '重放已经按终值宽度排好，重绘只是白花一次 PTY 往返与一次可见闪动。'
    ).toBe(0)
    // 不重绘不等于不同步：几何照样要送到 PTY。
    expect(harness.resize).toHaveBeenCalledWith({ cols: 132, rows: 45 })
  })

  it('没有重放过的全新终端不重绘：没有排错的那一屏', async () => {
    // 全新起的终端第一次 fit 同样从 80×24 挪到真尺寸，但它没有重放，屏上没有需要救的内容。
    // 「建好之后挪过吗」那种问法在这里恒真，会给每一格新终端都白搭一对 resize。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    harness.setProposed({ cols: 120, rows: 40 })
    await harness.sync.startLiveSynchronization()
    expect(harness.frames.runNext()).toBe(true)
    await vi.waitFor(() => expect(harness.resize).toHaveBeenCalledWith({ cols: 120, rows: 40 }))

    expect(
      redrawRoundTrips(harness.resize, { cols: 120, rows: 40 }),
      '没重放过就没有按错宽度排的那一屏；这里重绘是纯粹的多余闪动。'
    ).toBe(0)
  })

  it('只重绘一次：起活后继续挪 grid 不再触发补救', async () => {
    // 补救是一次性的。起活之后的 resize 都是真尺寸变化，会自己发 SIGWINCH，TUI 有重画的理由。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    harness.sync.markReplayLanded()
    harness.setProposed({ cols: 132, rows: 45 })
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    await harness.sync.startLiveSynchronization()
    // 先确认这一格真的走过一次补救，否则下面的 0 是空的。
    expect(redrawRoundTrips(harness.resize, { cols: 132, rows: 45 })).toBe(1)
    const afterStart = harness.resize.mock.calls.length

    harness.setProposed({ cols: 100, rows: 30 })
    harness.sync.observeViewport()
    // 起活的 finally 已经排了一帧，所以这次 observeViewport 是空操作（frameId 非空即返回），
    // 而那一帧记下的上一个提案是 132×45。稳定闸要两帧提案一致才肯 fit，于是这里必须跑两帧。
    // 别把第二帧省掉：只跑一帧时 resize 一次都不发，会读成「起活后不再同步」的反向结论。
    expect(harness.frames.runNext()).toBe(true)
    expect(harness.resize.mock.calls.length, '第一帧只是记下新提案，稳定闸还没放行').toBe(afterStart)
    expect(harness.frames.runNext()).toBe(true)
    await vi.waitFor(() => expect(harness.resize.mock.calls.length).toBeGreaterThan(afterStart))

    expect(
      redrawRoundTrips(harness.resize, { cols: 100, rows: 30 }),
      '起活之后的每次 resize 都是真尺寸变化，会自己发出 SIGWINCH；再补重绘就是多余的闪动。'
    ).toBe(0)
  })

  it('markReplayLanded 只认第一次：实时输出不是"重放的那一屏"', async () => {
    // 幂等性有承重意义：若后续调用能覆盖锚点，一次实时输出就会把锚点刷成当前 grid，
    // 判据当场退化成恒等，补救永久关闭。
    const harness = terminalHarness({ cols: 80, rows: 24 })

    harness.sync.markReplayLanded()
    harness.setProposed({ cols: 132, rows: 45 })
    harness.sync.observeViewport()
    expect(harness.frames.runNext()).toBe(true)
    // 第二次调用发生在 grid 已经挪走之后——若它生效，锚点会变成 132×45，判据即失效。
    harness.sync.markReplayLanded()

    await harness.sync.startLiveSynchronization()

    expect(
      redrawRoundTrips(harness.resize, { cols: 132, rows: 45 }),
      'markReplayLanded 不幂等的话，任何一次后续调用都会把锚点刷成当前 grid，补救永久失效。'
    ).toBe(1)
  })
})
