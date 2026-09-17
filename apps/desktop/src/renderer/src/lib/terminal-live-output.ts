import type { AgentMuxRunAttachment, AgentMuxTerminalResize } from '@agentmux/core'

export type TerminalLiveOutputChunk = {
  dataBytes: Uint8Array
  startByte: number
  endByte: number
}

/** Unknown snapshots retain metadata only; their historical bytes cannot prove geometry. */
export type TerminalLiveSnapshot = {
  type: 'snapshot'
  snapshot: AgentMuxRunAttachment
}

export type TerminalLiveItem = TerminalLiveOutputChunk | AgentMuxTerminalResize | TerminalLiveSnapshot

/** Replace only queued work covered by the new authoritative cut; in-flight work settles first. */
function admitTerminalLiveSnapshot(
  chunks: readonly TerminalLiveItem[],
  snapshot: AgentMuxRunAttachment
): TerminalLiveItem[] {
  const known = snapshot.terminal.type === 'basic-vt'
  const latest = snapshot.run.latestOutputBytes
  // A delayed older snapshot cannot overwrite a newer pending authoritative cut.
  if (known && chunks.some(item => 'snapshot' in item && item.snapshot.terminal.type === 'basic-vt' &&
    item.snapshot.run.latestOutputBytes >= latest && item.snapshot.resizeRevision >= snapshot.resizeRevision)) return [...chunks]
  const retained = chunks.filter(item => {
    if ('snapshot' in item) {
      if (!known) return item.snapshot.terminal.type === 'basic-vt'
      return item.snapshot.run.latestOutputBytes > latest || item.snapshot.resizeRevision > snapshot.resizeRevision
    }
    if (!known) return true
    return 'size' in item ? item.throughByte > latest || item.resizeRevision > snapshot.resizeRevision : item.endByte > latest
  })
  const incoming: TerminalLiveSnapshot = { type: 'snapshot',
    snapshot: known ? snapshot : { ...snapshot, replay: [] } }
  // Known restoration precedes uncovered newer live bytes. Unknown restoration leaves older
  // accepted work in order and advances the authoritative snapshot boundary without claiming historical bytes were parsed.
  return known ? [incoming, ...retained] : [...retained, incoming]
}

/** Keep one visual live-output write bounded while coalescing small RuntimeEvents. */
export const TERMINAL_LIVE_OUTPUT_BATCH_BYTES = 64 * 1024

/**
 * Keep unparsed events bounded at 2 MiB. Overflow drops the oldest queued events, not Runtime
 * history: the drain must recover retained bytes from its last parsed cursor before consuming
 * a discontinuous tail. Only Runtime Gap or failed recovery permits an honest omission notice.
 */
export const TERMINAL_LIVE_OUTPUT_BACKLOG_BYTES = 2 * 1024 * 1024

function chunkBytes(chunk: TerminalLiveItem): number {
  if ('size' in chunk || 'snapshot' in chunk) return 0
  return Math.max(0, chunk.endByte - chunk.startByte)
}

type LiveNode = {
  item: TerminalLiveItem
  bytes: number
  previous: LiveNode | null
  next: LiveNode | null
  afterSnapshot: LiveNode | null
  queued: boolean
}

/** One pending queue. Admission/removal work follows newly added/removed items, not backlog size. */
export class TerminalLiveOutputQueue implements Iterable<TerminalLiveItem> {
  private head: LiveNode | null = null
  private tail: LiveNode | null = null
  private firstOrdinary: LiveNode | null = null
  private lastSnapshot: LiveNode | null = null
  private bytes = 0
  private ordinaryCount = 0
  private count = 0
  private readonly limit: number

  constructor(maxBytes = TERMINAL_LIVE_OUTPUT_BACKLOG_BYTES) {
    this.limit = Math.max(1, Math.floor(maxBytes))
  }

  get length(): number { return this.count }

  *[Symbol.iterator](): Iterator<TerminalLiveItem> {
    for (let node = this.head; node; node = node.next) yield node.item
  }

  private append(item: TerminalLiveItem): LiveNode {
    const node: LiveNode = { item, bytes: chunkBytes(item), previous: this.tail,
      next: null, afterSnapshot: this.lastSnapshot, queued: true }
    if (this.tail) this.tail.next = node
    else this.head = node
    this.tail = node
    this.count += 1
    this.bytes += node.bytes
    if ('snapshot' in item) this.lastSnapshot = node
    else {
      this.ordinaryCount += 1
      this.firstOrdinary ??= node
    }
    return node
  }

  private remove(node: LiveNode): void {
    if (node.previous) node.previous.next = node.next
    else this.head = node.next
    if (node.next) node.next.previous = node.previous
    else this.tail = node.previous
    node.queued = false
    this.count -= 1
    this.bytes -= node.bytes
    if (this.lastSnapshot === node) this.lastSnapshot = null
    if (!('snapshot' in node.item)) {
      this.ordinaryCount -= 1
      if (this.firstOrdinary === node) {
        this.firstOrdinary = node.next
        while (this.firstOrdinary && 'snapshot' in this.firstOrdinary.item) {
          this.firstOrdinary = this.firstOrdinary.next
        }
      }
    }
    node.previous = node.next = null
  }

  private sameSnapshotSegment(left: LiveNode, right: LiveNode): boolean {
    const before = (node: LiveNode) => node.afterSnapshot?.queued ? node.afterSnapshot : null
    return before(left) === before(right)
  }

  /** Keep the newest ordinary item; Runtime replay, not client trimming, owns missing history. */
  admit(item: TerminalLiveItem): number {
    this.append(item)
    let droppedBytes = 0
    let droppedGeometry: LiveNode | null = null
    // Synthetic seeds have their own Runtime bound and are never raw-backlog victims.
    while (this.ordinaryCount > 1 && (this.bytes > this.limit || this.ordinaryCount > 4096)) {
      const dropped = this.firstOrdinary!
      this.remove(dropped)
      droppedBytes += dropped.bytes
      if ('size' in dropped.item) droppedGeometry = dropped
    }
    let first = this.firstOrdinary
    if (droppedGeometry && first && !('size' in first.item) &&
      this.sameSnapshotSegment(droppedGeometry, first) && this.ordinaryCount === 4096) {
      // Reserving the required geometry must not grow the ordinary-item ceiling by one.
      this.remove(first)
      droppedBytes += first.bytes
      first = this.firstOrdinary
    }
    if (droppedGeometry && first && !('size' in first.item) &&
      this.sameSnapshotSegment(droppedGeometry, first)) {
      // Retained raw bytes still require the last geometry from their own snapshot segment.
      const node = droppedGeometry
      node.previous = first.previous
      node.next = first
      node.queued = true
      if (first.previous) first.previous.next = node
      else this.head = node
      first.previous = node
      this.firstOrdinary = node
      this.count += 1
      this.ordinaryCount += 1
    }
    return droppedBytes
  }

  /** Snapshot cuts inspect pending work once; they do not add a second queue owner. */
  admitSnapshot(snapshot: AgentMuxRunAttachment): void {
    const retained = admitTerminalLiveSnapshot([...this], snapshot)
    this.head = this.tail = this.firstOrdinary = this.lastSnapshot = null
    this.bytes = this.ordinaryCount = this.count = 0
    for (const item of retained) this.append(item)
  }

  /** Consume the largest original-byte prefix within the visual batch budget. */
  take(maxBytes = TERMINAL_LIVE_OUTPUT_BATCH_BYTES): {
    batch: TerminalLiveOutputChunk[]; resize?: AgentMuxTerminalResize; snapshot?: TerminalLiveSnapshot
  } {
    const first = this.head
    if (!first) return { batch: [] }
    if ('snapshot' in first.item) { this.remove(first); return { batch: [], snapshot: first.item } }
    if ('size' in first.item) { this.remove(first); return { batch: [], resize: first.item } }
    const limit = Math.max(1, Math.floor(maxBytes))
    const batch: TerminalLiveOutputChunk[] = []
    let bytes = 0
    while (this.head && !('size' in this.head.item) && !('snapshot' in this.head.item)) {
      const node = this.head
      if (batch.length > 0 && bytes + node.bytes > limit) break
      bytes += node.bytes
      batch.push(node.item as TerminalLiveOutputChunk)
      this.remove(node)
    }
    return { batch }
  }
}

/**
 * 这一块里 `afterByte` 之后的那截。
 *
 * Runtime offsets refer to the original bytes. Semantic text can be empty when a chunk ends
 * inside UTF-8, or can include a character begun in the preceding chunk; it cannot recreate
 * this payload. The existing xterm parser owns continuation across raw writes.
 */
function dataAfterByte(chunk: TerminalLiveOutputChunk, afterByte: number): Uint8Array {
  return chunk.dataBytes.subarray(Math.max(0, afterByte - chunk.startByte))
}

/**
 * 把一批已取出的块拼成一次终端写入，并给出写完后的 cursor。
 *
 * 三种重叠关系各有正确处理，缺一个就是一类可见缺陷：
 * - **整块已有**（`endByte <= cursor`）：整块跳过。
 * - **部分已有**（`startByte < cursor < endByte`）：只写 cursor 之后那截，**且不发告示**。
 *   这一支此前不存在，于是落到了「startByte 对不上」的告示分支：终端上凭空多出一条
 *   「earlier bytes are unavailable」——而那些字节其实一个没少——同时 cursor 之前的字节被
 *   **重写一遍**，屏幕上出现一段重复内容。回放交接处必然产生这种块：cursor 先被设成回放的
 *   末字节，随后 attach 前缓冲的 pending 事件才被补送，它们的起点就在那之前。
 * - **真的缺了一段**（`startByte > cursor`）：返回 `gap: true`，再写整块。省略是真的，必须说，
 *   但告示由终端外服务窗承载，不能把诊断文字写进 xterm。
 *
 * 与 CLI 侧的 follow 流同形（core 的 session-output-follow 做的是同样三分），两边不许只有一边对。
 */
export function composeTerminalLiveOutputWrite(
  batch: readonly TerminalLiveOutputChunk[],
  cursor: number
): { dataBytes: Uint8Array; cursor: number; gap: boolean } {
  const parts: Uint8Array[] = []
  let bytes = 0
  let nextCursor = cursor
  let gap = false
  for (const chunk of batch) {
    if (chunk.endByte <= nextCursor) continue
    if (chunk.startByte > nextCursor) gap = true
    const suffix = dataAfterByte(chunk, nextCursor)
    parts.push(suffix)
    bytes += suffix.byteLength
    nextCursor = chunk.endByte
  }
  const dataBytes = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) {
    dataBytes.set(part, offset)
    offset += part.byteLength
  }
  return { dataBytes, cursor: nextCursor, gap }
}

