import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SPLIT_RATIO_EPSILON, SplitRatioCommitter } from '../src/renderer/src/lib/split-ratio-commit'
import { LatestTerminalOutputAcknowledger } from '../src/renderer/src/lib/terminal-output-ack'
import { terminalStartupPhase } from '../src/renderer/src/lib/terminal-startup'

describe('Terminal interaction latency owners', () => {
  it('lets the live output drain yield to the renderer between queued chunks', () => {
    const source = readFileSync(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/u, ''))
      .join('\n')
    const outputDrain = source.slice(
      source.indexOf('const drainLiveOutput = async ()'),
      source.indexOf('const disposeEvents = api.sessions.onEvent')
    )
    expect(outputDrain).toContain('takeTerminalLiveOutputBatch(liveOutputQueue)')
    expect(outputDrain).toContain('await yieldTerminalWork()')
  })

  it('coalesces an acknowledgement burst and eventually sends the latest cursor', async () => {
    let releaseFirst = () => {}
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const acknowledge = vi.fn()
      .mockImplementationOnce(async () => await firstPending)
      .mockResolvedValue(undefined)
    const acknowledger = new LatestTerminalOutputAcknowledger(acknowledge)

    acknowledger.queue(10)
    acknowledger.queue(20)
    acknowledger.queue(30)

    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(acknowledge).toHaveBeenLastCalledWith(10)

    releaseFirst()
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2))
    expect(acknowledge).toHaveBeenLastCalledWith(30)

    acknowledger.queue(25)
    await Promise.resolve()
    expect(acknowledge).toHaveBeenCalledTimes(2)
  })

  it('stops draining acknowledgements after its Terminal View is disposed', async () => {
    let releaseFirst = () => {}
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve })
    const acknowledge = vi.fn(async () => await firstPending)
    const acknowledger = new LatestTerminalOutputAcknowledger(acknowledge)

    acknowledger.queue(10)
    acknowledger.queue(20)
    acknowledger.dispose()
    releaseFirst()
    await Promise.resolve()
    await Promise.resolve()

    expect(acknowledge).toHaveBeenCalledTimes(1)
    expect(acknowledge).toHaveBeenCalledWith(10)
  })

  it('commits one final split ratio after a pointer drag', () => {
    const commit = vi.fn()
    const committer = new SplitRatioCommitter(0.5, commit)

    committer.setDragging(true)
    committer.observeLayout([55, 45])
    committer.observeLayout([62, 38])
    committer.observeLayout([70, 30])

    expect(commit).not.toHaveBeenCalled()

    committer.setDragging(false)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(0.7)
  })

  it('immediately commits a non-pointer layout change', () => {
    const commit = vi.fn()
    const committer = new SplitRatioCommitter(0.5, commit)

    committer.observeLayout([60, 40])

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(0.6)
  })

  it('拖动中收到的持久化比例不许覆盖用户正在拖的那个值', () => {
    // 这是 `synchronizePersistedRatio` 里 `!this.dragging` 那道闸唯一的靶子，而它此前无人守：
    // 上面两条从不调这个方法，把闸删成无条件赋值，8 条照旧全绿。
    //
    // 可达性不是假想的：WorkspaceWorkbench 每次渲染分屏节点都调它一次（committer 存在 useRef 里
    // 跨渲染存活），而起拖本身就 setState 触发一次重渲染。于是拖动期间任何一次重渲染都会把
    // **旧的** node.ratio 送进来。删掉闸之后 latestRatio 被改写成旧值，收拖时 commitLatest 的
    // epsilon 比较发现「和已落盘的一样」就整个不提交——用户这次拖动被静默吞掉、分隔条弹回原位。
    const commit = vi.fn()
    const committer = new SplitRatioCommitter(0.5, commit)

    committer.setDragging(true)
    committer.observeLayout([70, 30])
    // 拖动中的一次重渲染：带进来的是尚未更新的落盘值。
    committer.synchronizePersistedRatio(0.5)
    committer.setDragging(false)

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(0.7)
  })

  it('不在拖动时的同步要被认下来：外部改过比例后，空点一下分隔条不许把它弹回旧值', () => {
    // 与上一条成对：那道闸只该**在拖动中**挡住写入。把它改成永远不写 `latestRatio`（即
    // 「修」成一个恒不写的 no-op）时上一条照旧绿——所以必须有第二条钉住「不拖动时要写」。
    //
    // 判据为什么必须是「空点一下」而不是「同步完再拖一次」：`latestRatio` 只被 commitLatest 读，
    // 而 `observeLayout` **无条件**改写它。所以任何在同步之后还夹一次 observeLayout 的路径，
    // 两个世界的 latestRatio 都被覆盖成同一个值，判据当场退化成恒真（实测：那种写法下把闸改成
    // 恒不写，10 条全绿）。唯一读 latestRatio 而中间没有 observeLayout 的路径，就是
    // 在分隔条上按下又松开、一格也没拖动——react-resizable-panels 只发 onDragging(true/false)，
    // 不发 onLayout。
    //
    // 用户能真碰到：先用布局预设（或另一个窗口）把比例改成 0.8，再去分隔条上点一下。
    // 恒不写的话 latestRatio 还停在 0.5，收手时 commitLatest 发现「和 0.8 差得远」就提交 0.5，
    // 把刚才那次外部改动静默撤销。
    const commit = vi.fn()
    const committer = new SplitRatioCommitter(0.5, commit)

    committer.synchronizePersistedRatio(0.8)
    // 同步本身不提交——它描述的是「盘上已经是这样」，不是一次新的用户操作。
    expect(commit).not.toHaveBeenCalled()

    // 空点：按下、松开，一次 onLayout 都没有。
    committer.setDragging(true)
    committer.setDragging(false)

    expect(commit, '空点一下分隔条把外部改动撤销了').not.toHaveBeenCalled()
  })

  /**
   * 死区（`SPLIT_RATIO_EPSILON`）的两侧各是一个产品预算，此前**整个区间都不可观测**：
   * 上面四条守住的最小差值是 0.1（0.5→0.6/0.7/0.8），所以把它从 0.005 改成 0.09——
   * 一个会静默吞掉用户所有小于 9% 拖动的取值——十条照旧全绿（实测存活）。改成 0（把闸整个
   * 拆掉）也一样绿。
   *
   * 判据故意**不从常量派生**。`ε/2` 与 `ε×2` 这种派生输入会跟着常量一起漂：0.005 与 0.09
   * 两个世界都同样通过（已算过）。所以下面两个数是写死的**需求**，夹住的是实现：
   *
   * - `MUST_PERSIST_DELTA = 0.01`：1200px 宽的分屏上拖 12px。这是用户**故意**做的微调，
   *   必须落盘。死区一旦大过它，松手后分隔条弹回原位且没有任何提示。
   * - `MUST_DISCARD_DELTA = 0.001`：1200px 上 1.2px，小于一个 CSS 像素。
   *   react-resizable-panels 在起拖/收拖与容器尺寸微变时报这种量级的差值，不该各写一次盘。
   *
   * 于是常量的合法区间被这两个预算夹住，今天的 0.005 落在中间。区间的两端点自己落在哪一侧由
   * 上面那次百分比往返的浮点误差决定（`0.01` 实测仍合法，因为往返后的差值比它大一点点），所以
   * 自检与两条行为断言必须拿**同一个** `observedDelta` 去比——写死一个端点就会让两者在边界上
   * 判得不一样。这里不声称端点开闭，只声称「两个预算都被满足」。
   */
  describe('死区两侧的产品预算', () => {
    const MUST_PERSIST_DELTA = 0.01
    const MUST_DISCARD_DELTA = 0.001

    /**
     * 生产侧比较的不是我写的 delta，而是它过一趟百分比之后的值：`observeLayout` 收的是
     * `sizes[0]`（百分比），再 `/100` 还原成比例。`(0.5 + 0.001) * 100 / 100 - 0.5` 是
     * 0.0010000000000000009——比 0.001 大。所以自检必须拿**这个**值去比，否则它和下面两条
     * 行为断言会在边界上判得不一样（实测：ε 恰为 0.001 时自检过、行为红）。
     */
    function sizesFor(delta: number): [number, number] {
      return [(0.5 + delta) * 100, (0.5 - delta) * 100]
    }

    function observedDelta(delta: number): number {
      return Math.abs(sizesFor(delta)[0] / 100 - 0.5)
    }

    it('今天的死区取值落在两个预算之间（自检：下面两条不是恒真）', () => {
      // 没有这条的话，一个荒谬的取值（比如 0.5）会让「必须丢掉」那条恒真、
      // 只剩一条断言在守——而那一条单独存在时，`ε = +Infinity` 也能过。
      expect(SPLIT_RATIO_EPSILON, '死区大到会吞掉用户故意做的微调').toBeLessThan(
        observedDelta(MUST_PERSIST_DELTA)
      )
      expect(SPLIT_RATIO_EPSILON, '死区小到连亚像素抖动都要写一次盘').toBeGreaterThanOrEqual(
        observedDelta(MUST_DISCARD_DELTA)
      )
    })

    it('故意拖出来的 1% 必须落盘', () => {
      const commit = vi.fn()
      const committer = new SplitRatioCommitter(0.5, commit)

      committer.observeLayout(sizesFor(MUST_PERSIST_DELTA))

      expect(commit, `差 ${MUST_PERSIST_DELTA} 的拖动被死区吞掉了`).toHaveBeenCalledTimes(1)
      expect(commit).toHaveBeenCalledWith(0.5 + MUST_PERSIST_DELTA)
    })

    it('亚像素级的抖动不许写盘', () => {
      const commit = vi.fn()
      const committer = new SplitRatioCommitter(0.5, commit)

      committer.observeLayout(sizesFor(MUST_DISCARD_DELTA))

      expect(commit, `差 ${MUST_DISCARD_DELTA} 的抖动被当成一次真改动写了盘`).not.toHaveBeenCalled()
    })
  })

  it('keeps a slow Agent visibly starting until the first output arrives', () => {
    const initial = {
      hydrating: true,
      attachFailed: false,
      agent: true,
      running: true,
      hasOutput: false
    }

    expect(terminalStartupPhase(initial)).toBe('restoring')
    expect(terminalStartupPhase({ ...initial, hydrating: false })).toBe('starting-agent')
    expect(terminalStartupPhase({ ...initial, hydrating: false, hasOutput: true })).toBeNull()
  })

  it('does not call a failed, exited, or ordinary Terminal session an Agent startup', () => {
    const waiting = {
      hydrating: false,
      attachFailed: false,
      agent: true,
      running: true,
      hasOutput: false
    }

    expect(terminalStartupPhase({ ...waiting, attachFailed: true })).toBeNull()
    expect(terminalStartupPhase({ ...waiting, running: false })).toBeNull()
    expect(terminalStartupPhase({ ...waiting, agent: false })).toBeNull()
  })

  it('never puts a startup overlay back over the canvas after the reveal deadline', () => {
    expect(terminalStartupPhase({
      hydrating: false,
      attachFailed: false,
      agent: true,
      running: true,
      hasOutput: false,
      revealOverdue: true
    })).toBeNull()
  })
})
