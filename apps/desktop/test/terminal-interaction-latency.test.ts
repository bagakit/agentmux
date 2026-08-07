import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { SPLIT_RATIO_EPSILON, SplitRatioCommitter } from '../src/renderer/src/lib/split-ratio-commit'
import { MIN_SPLIT_RATIO } from '../src/renderer/src/lib/split-tree'
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
   * 死区比较有两个操作数，而此前只有一个被守住。
   *
   * `latestRatio` 那一侧的来源 `observeLayout` 一直挡着非有限值（`ratioFromLayout` 返回 null 就丢弃
   * 整次上报）。基准 `persistedRatio` 那一侧从**构造参数**与 `synchronizePersistedRatio` 两个入口
   * 裸着进来，谁也没夹过——而 split-ratio-commit.ts 的 docblock 与 split-tree.ts 里 `clampSplitRatio`
   * 的注释都亲口把构造参数点成这条不变量的「最薄一处」。3e6d3cc 的审计把它记成缺口（#595）。
   * （那两处现在都已改口说这一处被补上了；此处引的是**改口前**的说法，也是这一族用例的由来。
   * 锚点写函数名不写行号：那两个文件都是并发热点，行号在别人提交的那一刻就漂，见 #600。）
   *
   * 坏基准的危害不是「判错方向」而是**死区整个失效**：`Math.abs(x - NaN) <= ε` 恒假，于是
   *   1. 每一次亚像素抖动都被当成一次真改动落盘；
   *   2. 在分隔条上空点一下（只有 onDragging、没有 onLayout）时提交出去的就是 `NaN` 本身——
   *      `JSON.stringify(NaN)` 是 `null`，正是 #552 那条坏值沿写入路径传播的老路。
   *
   * 可达性：region 那条渲染路径把 `node.ratio` 裸着交给这两个入口（tab-group 那条先过一次
   * `clampSplitRatio`），所以今天两条路径靠的不是同一层保护。
   *
   * 下面七条按「哪个入口 × 坏成什么样」分开写。六个单点变异（每次只改一处）的击杀集**两两不同**，
   * 用例按标题引用而不按序号——序号会被后来插进来的用例悄悄改写（本条自己就踩过：#601 往中间插了
   * 两条，把原来的「第 5 条」变成了第 7 条）：
   *
   * | 变异（各只改一处） | 击杀的用例 |
   * |---|---|
   * | 构造参数不夹（`= persistedRatio`） | NaN×亚像素、NaN×空点、越界只判有限、上界（构造参数） |
   * | 构造参数只判有限（`isFinite ? x : 0.5`） | 越界只判有限、上界（构造参数） |
   * | 构造参数只夹下界（`isFinite ? max(0.15, x) : 0.5`） | **只有**上界（构造参数） |
   * | 同步入口不夹（`= ratio`） | 同步 NaN、上界（同步入口） |
   * | 同步入口只夹下界（同上形状） | **只有**上界（同步入口） |
   * | 同步入口两个赋值分岔（`latestRatio = ratio`） | 同步 NaN、同步越界留界外 |
   *
   * 所以每个变异都有专属的红，而四条用例各自是某个变异的唯一击杀者——它们钉的正是「为什么是
   * clampSplitRatio 而不是 Number.isFinite」「为什么下界夹了上界也得夹」和「为什么两个赋值必须读
   * 同一个值」。分开写而不合成一条：合成的话先抛的那个 expect 会把后面变成死代码，于是只杀后半的
   * 变异会被读成「已守住」（本仓 two-throws-in-one-it-mask-each-other）。
   */
  describe('死区的基准操作数也要在入口归一化（#595）', () => {
    it('构造参数是 NaN 时，亚像素抖动仍必须被死区丢掉', () => {
      const commit = vi.fn()
      const committer = new SplitRatioCommitter(Number.NaN, commit)

      // 与「亚像素级的抖动不许写盘」同一个量级的上报：0.5 → 0.5001。
      committer.observeLayout([50.01, 49.99])

      expect(
        commit,
        '基准是 NaN 让死区恒假：每一次亚像素抖动都变成一次落盘'
      ).not.toHaveBeenCalled()
    })

    it('构造参数是 NaN 时，空点一下分隔条不许把 NaN 提交出去', () => {
      // 与上一条是**同一个**变异的两种症状，但用户看到的是两件事：那条是多余的写盘，
      // 这条是一个坏值进了 store（落盘后成 `null`）。所以各占一个 it。
      const commit = vi.fn()
      const committer = new SplitRatioCommitter(Number.NaN, commit)

      committer.setDragging(true)
      committer.setDragging(false)

      expect(commit, 'NaN 被当成一次真改动提交进 store').not.toHaveBeenCalled()
    })

    it('同步进来的 NaN 同样要在入口归一化，而不是只夹构造参数', () => {
      // 第二个入口。只修构造参数的话这条红：`synchronizePersistedRatio` 每次渲染都被调一次
      // （committer 存在 useRef 里跨渲染存活），所以一个坏的 node.ratio 照旧能把基准毒掉。
      const commit = vi.fn()
      const committer = new SplitRatioCommitter(0.5, commit)

      committer.synchronizePersistedRatio(Number.NaN)
      committer.setDragging(true)
      committer.setDragging(false)

      expect(commit, '同步入口没夹，基准照旧能被毒成 NaN').not.toHaveBeenCalled()
    })

    it('越界的基准要夹回屏上真画得出的那个值，只判有限还不够', () => {
      // 这一条钉的是「为什么是 clampSplitRatio 而不是 Number.isFinite」。基准要回答的是
      // 「相对**用户眼前看到的**位置，他改了吗」，而渲染层的 `<Panel minSize>` 保证屏上那个值一定
      // 在界内：盘上存着 0.05 时屏上画的是 MIN_SPLIT_RATIO。用户一下都没碰，所以不该有任何写入。
      //
      // 只判有限的话：基准停在 0.05，而 onLayout 报的是屏上的 0.15，差 0.1 远大于死区 ⇒ 挂载即写
      // 一次盘。那次写入的值恰好是对的，所以症状不是坏数据而是**用户没做的操作被记成一次改动**。
      const commit = vi.fn()
      const committer = new SplitRatioCommitter(0.05, commit)

      // 渲染层照 minSize 画出来的布局，用户没碰分隔条。
      committer.observeLayout([MIN_SPLIT_RATIO * 100, (1 - MIN_SPLIT_RATIO) * 100])

      expect(
        commit,
        '越界基准只判有限不夹回界内：用户一下没碰，挂载就写了一次盘'
      ).not.toHaveBeenCalled()
    })

    it('上界那一侧同样要夹回屏上画得出的值（构造参数）', () => {
      // 上面四条只喂过 0.05（下界外）与 NaN，于是**归一化的上半边整个不可观测**：把两个入口的
      // `clampSplitRatio(x)` 换成 `Number.isFinite(x) ? Math.max(MIN_SPLIT_RATIO, x) : 0.5`
      // ——留住 NaN 兜底与下界、只丢掉上界——这一族 23 条照旧全绿（实测存活，#601）。
      //
      // 症状与下界那条同形但方向相反：盘上存着 0.98 时 `<Panel minSize>` 让屏上画的是 0.85，
      // 用户一下都没碰，挂载即写一次盘。
      //
      // 上界写成 `1 - MIN_SPLIT_RATIO` 而不是字面量 0.85：那是 clampSplitRatio 自己的定义式，
      // 而这条用例的被测对象是「委托方有没有走它」，不是「它的上界取值对不对」——后者由
      // split-tree-substrate.test.ts 用写死的历史字面量单独钉。
      const commit = vi.fn()
      const committer = new SplitRatioCommitter(0.98, commit)

      committer.observeLayout([(1 - MIN_SPLIT_RATIO) * 100, MIN_SPLIT_RATIO * 100])

      expect(
        commit,
        '越界基准只夹下界不夹上界：用户一下没碰，挂载就写了一次盘'
      ).not.toHaveBeenCalled()
    })

    it('上界那一侧同样要夹回屏上画得出的值（同步入口）', () => {
      // 第二个入口。与上一条分开写而不合成：只修构造参数的变异要能被单独一条红指认出来，
      // 合成的话先抛的 expect 会把后半变成死代码（本仓 two-throws-in-one-it-mask-each-other）。
      const commit = vi.fn()
      const committer = new SplitRatioCommitter(0.5, commit)

      committer.synchronizePersistedRatio(0.98)
      committer.observeLayout([(1 - MIN_SPLIT_RATIO) * 100, MIN_SPLIT_RATIO * 100])

      expect(
        commit,
        '同步入口的上界没夹：用户一下没碰，一次重渲染就写了一次盘'
      ).not.toHaveBeenCalled()
    })

    it('同步的越界值不许只更新基准而把 latestRatio 留在界外', () => {
      // 「两个赋值分岔」那个变异的靶子：`synchronizePersistedRatio` 里两个赋值必须**用同一个夹过的
      // 值**。写成 `this.persistedRatio = clampSplitRatio(ratio)` 配 `this.latestRatio = ratio` 时
      // 两侧分岔，空点一下就把界外的 0.05 提交进 store——比「同步进来的 NaN」那条更坏，因为这次落盘
      // 的值本身是非法的（不是多写一次，而是写了个越界值）。
      const commit = vi.fn()
      const committer = new SplitRatioCommitter(0.5, commit)

      committer.synchronizePersistedRatio(0.05)
      committer.setDragging(true)
      committer.setDragging(false)

      expect(commit, '两个赋值读了不同的值，界外比例被提交进 store').not.toHaveBeenCalled()
    })
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
   * 上面那次百分比往返的浮点误差决定，所以自检与两条行为断言必须拿**同一个** `observedDelta` 去比——
   * 写死一个端点就会让两者在边界上判得不一样。
   *
   * 两条自检的开闭**不是承重的**，别照着以前那句话读：`toBeLessThan` 严格、
   * `toBeGreaterThanOrEqual` 含端点，两个方向各翻一次实测都是 18 条全绿（0.005 严格落在两个
   * `observedDelta` 之间，端点从不被触及）。真正无人守的是生产侧 `<=` 里的那个 `=`——而它今天
   * **不可能**被行为钉住：见下面「端点不可达」那一条，那才是这个缺口的正确处置。
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

    /**
     * 生产侧的比较是 `<=`，可那个 `=` 今天**没有任何输入能碰到**，所以它既不能被行为断言钉住，
     * 也不该被当成「已经守好的规则」。这一条不去假装钉住它，而是钉住它不可达的那个**前提**——
     * 一旦前提破了，`=` 就从死代码变成活规则，那一刻必须有人先决定「恰好等于算噪声还是算改动」。
     *
     * 为什么到不了：两个操作数都是十进制小数（`observeLayout` 收百分比再 `/100`），而 0.005 不是
     * 二进制有理数，`|latest - persisted|` 落不到它上面。这**不是运气而是取值的性质**，但也**只是
     * 取值的性质**：换成二进制有理数立刻可达，而这样的取值就在今天的合法区间里——
     * `1/128 = 0.0078125` 满足上面两个产品预算（0.001 < ε < 0.01），却有上万组精确命中。
     *
     * 所以判据是双向的：今天这个取值必须一次都碰不到端点（否则 `=` 已经在偷偷生效而无人裁决），
     * 而那个反例必须真能碰到（否则这条断言只是在陈述「找不到」，对任何取值都恒真——
     * 本仓 property-unobservable-in-default-env 记的就是这种自证）。
     */
    describe('端点不可达：`<=` 里的 `=` 今天是死规则，这条钉住它为什么死', () => {
      /** 界内合法比例的枚举步长。1e-4 比渲染层能产生的任何比例都细。 */
      const RATIO_STEP = 1 / 10_000

      /** 把两个界内合法比例任意配对，数出 `|a - b|` 精确等于 candidate 的组数。 */
      function exactEndpointHits(candidate: number): number {
        let hits = 0
        for (let step = MIN_SPLIT_RATIO / RATIO_STEP; step <= (1 - MIN_SPLIT_RATIO) / RATIO_STEP; step += 1) {
          const persisted = step * RATIO_STEP
          for (const latest of [persisted + candidate, persisted - candidate]) {
            if (latest < MIN_SPLIT_RATIO || latest > 1 - MIN_SPLIT_RATIO) continue
            if (Math.abs(latest - persisted) === candidate) hits += 1
          }
        }
        return hits
      }

      it('今天的取值一次都碰不到端点，所以 `=` 不可能被行为观测', () => {
        expect(
          exactEndpointHits(SPLIT_RATIO_EPSILON),
          '端点可达了：`<=` 里的 `=` 不再是死代码，' +
            '得先决定「差值恰好等于死区」算噪声还是算一次改动，再改这个常量'
        ).toBe(0)
      })

      it('自检：换成落在同一个预算区间里的二进制有理数就立刻可达（上面那个 0 不是恒真）', () => {
        // 1/128 同时满足 MUST_DISCARD_DELTA < ε < MUST_PERSIST_DELTA，所以它是一个**合法**取值，
        // 不是一个荒谬的反例——正因如此，上面那条 0 才是一句有内容的话。
        const DYADIC_IN_BUDGET = 1 / 128
        expect(DYADIC_IN_BUDGET).toBeGreaterThan(observedDelta(MUST_DISCARD_DELTA))
        expect(DYADIC_IN_BUDGET).toBeLessThan(observedDelta(MUST_PERSIST_DELTA))
        expect(
          exactEndpointHits(DYADIC_IN_BUDGET),
          '连二进制有理数都碰不到端点 ⇒ 这个枚举根本到不了任何端点，上面那条 0 是自证'
        ).toBeGreaterThan(0)
      })
    })

    /**
     * 上面三条把常量的**取值**夹住了，但没有任何一条问「`commitLatest` 到底读的是不是那个导出常量」。
     * 这个缺口是实测的（3e6d3cc 审计，八个变异逐个跑）：
     *
     * - body 里把 `SPLIT_RATIO_EPSILON` 换成字面量 `0.005` → 13 条全绿；
     * - 换成合法带内的 `0.008` → 13 条全绿；
     * - **导出常量改成 `0.008`、body 内联 `0.005`** → 13 条全绿。
     *
     * 第三种是真危害：那个 docblock 亲口说这个导出值是「两侧都能被用户碰到」的产品预算分界，而它可以
     * 静默退化成一份不管事的文档——自检读常量、行为读 body，两个世界从此各说各话。反过来，任何**害到
     * 用户**的取值（比如 body 内联 0.09）仍被上面的行为断言挡住。所以行为侧守的是「取值别害人」，
     * 这一条守的是「取值只有一处」。
     *
     * 判据写成**只许这一种形状**，不是「禁止字面量在场」：禁止清单必漏（本仓 forbidden-list-guard-always-leaks
     * 记了整整一族——换个拼法就绕过）。这里要求那次比较的右操作数**解析到**那个 `export const`，
     * 于是任何别的写法（字面量、局部副本、另一个常量）都落在允许形状之外。
     *
     * 「解析到」不是「叫这个名字」——这条区别是实测出来的（94f851f 审计 H1）。此前这里只比 AST 标识符的
     * `.text`，于是在方法体首行插一句 `const SPLIT_RATIO_EPSILON = DECOY_EPSILON`（DECOY 在模块作用域
     * 取 0.008）就同时骗过两条断言：右操作数的文本还是那个名字，而字面量藏在方法体外——16 条全绿，
     * 门限却真的漂成了 0.008。这正是这道守卫自己点名要挡的「局部副本」。所以现在用 TS 的 type checker
     * 把那个标识符解析回它的声明，再要求那份声明是**模块作用域的、带 export 的**那一个：名字可以重复，
     * 声明位置不会。用 `createProgram` 而不是 `createSourceFile`（多 30ms，换来作用域规则由编译器实现，
     * 本仓 lexical-boundaries-need-a-real-lexer 记的就是自己猜作用域这一族盲点）。
     *
     * 走 TS parser 而不是正则：字面量与注释都会骗文本匹配（本仓 lexical-boundaries-need-a-real-lexer /
     * equivalence-cannot-catch-a-fresh-copy）。上面那段 docblock 里就正当地写着 `0.005`、`0.008`
     * 这些数字——一个 `toContain` 形状的守卫会对它自己的解释文字发假红。
     *
     * 前两条断言是在场自检：找不到方法体、或方法体里没有那次比较时必须红。否则「方法被改名/被
     * 删掉」会让后面的判据静默变成对空集求值（本仓 name-existence-check-is-blind-to-rule-bodies）。
     */
    describe('死区取值只有一处：commitLatest 必须读那个导出常量', () => {
      const SOURCE = fileURLToPath(
        new URL('../src/renderer/src/lib/split-ratio-commit.ts', import.meta.url)
      )

      /**
       * 带 type checker 的单文件程序。`noLib`/`noResolve` 是刻意的：这道守卫只问「这个标识符解析到
       * 本文件的哪份声明」，不需要 lib 与 import 图，省掉它们让每次建程序只花 ~30ms。
       */
      function programForSource(): { program: ts.Program; source: ts.SourceFile } {
        const program = ts.createProgram([SOURCE], { noResolve: true, noLib: true })
        const source = program.getSourceFile(SOURCE)
        expect(source, `type checker 拿不到 ${SOURCE}`).toBeDefined()
        return { program, source: source! }
      }

      /** `commitLatest` 的方法体。取不到就是在场自检失败，不是「没有违规」。 */
      function commitLatestBody(source: ts.SourceFile): ts.Block {
        const found: ts.Block[] = []
        const visit = (node: ts.Node): void => {
          if (
            ts.isMethodDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === 'commitLatest' &&
            node.body
          ) {
            found.push(node.body)
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
        expect(found, 'split-ratio-commit.ts 里找不到唯一的 commitLatest 方法体').toHaveLength(1)
        return found[0]!
      }

      /** 方法体里所有二元比较。死区那次比较就在其中。 */
      function comparisons(body: ts.Block): ts.BinaryExpression[] {
        const out: ts.BinaryExpression[] = []
        const visit = (node: ts.Node): void => {
          if (ts.isBinaryExpression(node)) {
            const kind = node.operatorToken.kind
            if (
              kind === ts.SyntaxKind.LessThanEqualsToken ||
              kind === ts.SyntaxKind.LessThanToken ||
              kind === ts.SyntaxKind.GreaterThanEqualsToken ||
              kind === ts.SyntaxKind.GreaterThanToken
            ) {
              out.push(node)
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(body)
        return out
      }

      it('自检：方法体里确有一次大小比较（否则下面两条对空集求值）', () => {
        const { source } = programForSource()
        expect(
          comparisons(commitLatestBody(source)),
          'commitLatest 里一次大小比较都没有——下面的判据会静默变成恒真'
        ).toHaveLength(1)
      })

      it('那次比较的门限解析到那个 export const，不只是叫这个名字', () => {
        const { program, source } = programForSource()
        const checker = program.getTypeChecker()
        const [comparison] = comparisons(commitLatestBody(source))
        const right = comparison!.right

        // 先要求它是个标识符：字面量、成员表达式、函数调用都在允许形状之外。
        expect(
          ts.isIdentifier(right) ? 'identifier' : `<${ts.SyntaxKind[right.kind]}>`,
          '死区门限不是一个标识符——字面量与算式都能与导出值漂移'
        ).toBe('identifier')

        // 再把它解析回声明。同名的局部副本在这一步现形：它的声明不在模块作用域、也没有 export。
        const declarations = checker.getSymbolAtLocation(right)?.declarations ?? []
        expect(declarations, '这个标识符解析不到任何声明——守卫看不见它读的是什么').toHaveLength(1)
        const declaration = declarations[0]!
        const statement = declaration.parent?.parent
        expect(
          {
            name: ts.isIdentifier(right) ? right.text : '<not-an-identifier>',
            moduleScope: statement?.parent === source,
            exported: !!(
              ts.isVariableDeclaration(declaration) &&
              statement &&
              ts.canHaveModifiers(statement) &&
              ts
                .getModifiers(statement)
                ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
            )
          },
          '死区门限没有解析到那个模块级 export const：' +
            '一份同名的局部副本能骗过「名字对不对」这种判据（94f851f 审计 H1 实测 16 条全绿），' +
            '而它与导出值可以自由漂移'
        ).toEqual({ name: 'SPLIT_RATIO_EPSILON', moduleScope: true, exported: true })
      })

      it('方法体里不出现任何数字字面量：常量之外没有第二个取值来源', () => {
        const { source } = programForSource()
        const body = commitLatestBody(source)
        const literals: string[] = []
        const visit = (node: ts.Node): void => {
          if (ts.isNumericLiteral(node)) literals.push(node.text)
          ts.forEachChild(node, visit)
        }
        visit(body)
        expect(literals, 'commitLatest 里出现了数字字面量——它就是那个会与导出常量漂移的第二份取值').toEqual([])
      })
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
