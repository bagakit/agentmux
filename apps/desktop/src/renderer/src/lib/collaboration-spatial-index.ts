export type CollaborationBounds = { x: number; y: number; width: number; height: number }
export const collaborationBoundsOverlap = (a: CollaborationBounds, b: CollaborationBounds) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** Disposable broad phase for original map geometry, shared by routing and camera presentation. */
export class CollaborationBoundsIndex<T extends CollaborationBounds> {
  private cells = new Map<string, T[]>()
  extent: CollaborationBounds | null = null
  constructor(boxes: readonly T[]) { for (const box of boxes) this.add(box) }
  add(box: T) {
    for (const key of this.keys(box)) { const values = this.cells.get(key) ?? []; values.push(box); this.cells.set(key, values) }
    const left = Math.min(this.extent?.x ?? box.x, box.x), top = Math.min(this.extent?.y ?? box.y, box.y)
    const right = Math.max(this.extent ? this.extent.x + this.extent.width : box.x + box.width, box.x + box.width)
    const bottom = Math.max(this.extent ? this.extent.y + this.extent.height : box.y + box.height, box.y + box.height)
    this.extent = { x: left, y: top, width: right - left, height: bottom - top }
  }
  private *keys(box: CollaborationBounds) {
    for (let x = Math.floor(box.x / 512); x <= Math.floor((box.x + box.width) / 512); x++)
      for (let y = Math.floor(box.y / 512); y <= Math.floor((box.y + box.height) / 512); y++) yield `${x},${y}`
  }
  query(box: CollaborationBounds) {
    if (!this.extent) return []
    const x = Math.max(box.x, this.extent.x), y = Math.max(box.y, this.extent.y)
    const clipped = { x, y, width: Math.min(box.x + box.width, this.extent.x + this.extent.width) - x, height: Math.min(box.y + box.height, this.extent.y + this.extent.height) - y }
    if (clipped.width < 0 || clipped.height < 0) return []
    const result = new Set<T>()
    for (const key of this.keys(clipped)) for (const value of this.cells.get(key) ?? []) if (collaborationBoundsOverlap(box, value)) result.add(value)
    return [...result]
  }
}
