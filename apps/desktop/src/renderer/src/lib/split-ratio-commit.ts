/**
 * 「和已落盘的比例差这么点就不算一次改动」的死区。
 *
 * 它同时是两个产品预算的分界，两侧都能被用户碰到，所以不是一个可以随手调的实现细节：
 *
 * - **下界**：小于它的差值被当成噪声丢掉。react-resizable-panels 的 onLayout 会在起拖/收拖、
 *   容器尺寸微变时报出与当前值只差浮点末位的比例；没有死区的话每一次都要落一次盘。
 * - **上界**：大于它的差值必须落盘。用户在一个 1200px 宽的分屏上拖动 12px 就产生 0.01 的变化，
 *   而这是**故意**拖的——把死区调大到 0.05，用户所有小于 5% 的微调都会被静默吞掉：分隔条
 *   松手后弹回原位，且没有任何提示。
 *
 * 注意比较是 `<=`：恰好等于死区的差值算噪声、被丢掉。但**「恰好等于」在今天的取值下根本到不了**，
 * 所以这个 `=` 是个不可观测的选择，不是一条能举例说明的规则。此处此前举的例子（1200px 上拖 6px
 * 「恰好 0.005，落在丢弃那一侧」）把结论说反了：那次拖动经百分比往返得到的是
 * `0.0050000000000000044`，严格大于 0.005，落在**提交**那一侧。
 *
 * 到不了的理由是算术而非运气：`observeLayout` 收的是百分比再 `/100`，两个操作数都是十进制小数，
 * 而 0.005 不是二进制有理数，于是 `|latest - persisted|` 落不到它上面。穷举 200–2400px 面板 ×
 * ±40px 拖动共 88040 对，端点命中 0 次；把界内合法的两个比例任意配对（步长 1e-4，两侧都在
 * [0.15, 0.85] 内）也是 0 次。**但这条不可达性是取值的性质，不是这个类的性质**：换成一个二进制
 * 有理数就立刻可达——`1/128 = 0.0078125` 仍落在下面那两个产品预算之间（0.001 < ε < 0.01，即今天
 * 合法），而它有 13763 组精确命中。所以改这个常量时，`<=` 里的 `=` 可能从死代码变成活规则：
 * 那一刻要先决定「恰好等于算噪声还是算改动」，再改数。测试侧钉住的正是这个前提本身。
 *
 * 导出是为了让测试能声明「我知道今天的取值」，但**判据不许从它派生**：`ε/2` 与 `ε×2` 这样的
 * 派生输入会跟着它一起漂，于是无论取 0.005 还是 0.09 都同样通过（已实测）。测试那边用两个
 * 写死的产品预算把它夹住——那两个字面量是需求，这个常量是实现。
 */
export const SPLIT_RATIO_EPSILON = 0.005

function ratioFromLayout(sizes: number[]): number | null {
  const firstSize = sizes[0]
  if (firstSize === undefined || !Number.isFinite(firstSize)) return null
  return firstSize / 100
}

export class SplitRatioCommitter {
  private dragging = false
  private latestRatio: number

  constructor(
    private persistedRatio: number,
    private readonly commit: (ratio: number) => void
  ) {
    this.latestRatio = persistedRatio
  }

  synchronizePersistedRatio(ratio: number): void {
    this.persistedRatio = ratio
    if (!this.dragging) this.latestRatio = ratio
  }

  observeLayout(sizes: number[]): void {
    const ratio = ratioFromLayout(sizes)
    if (ratio === null) return
    this.latestRatio = ratio
    if (!this.dragging) this.commitLatest()
  }

  setDragging(dragging: boolean): void {
    this.dragging = dragging
    if (!dragging) this.commitLatest()
  }

  private commitLatest(): void {
    if (Math.abs(this.latestRatio - this.persistedRatio) <= SPLIT_RATIO_EPSILON) return
    this.persistedRatio = this.latestRatio
    this.commit(this.latestRatio)
  }
}
