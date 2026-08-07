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
 * 注意比较是 `<=`：恰好等于死区的差值算噪声、被丢掉。所以上面举的例子都取严格大于它的量，
 * 别拿 6px（恰好 0.005）当「必须落盘」的例子——那个量今天正好落在丢弃那一侧。
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
