const SPLIT_RATIO_EPSILON = 0.005

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
