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
export function admitTerminalLiveSnapshot(
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

/**
 * 收下一块新产出，并把未消费的积压压回上限之内。
 *
 * 丢弃只从队头发生，所以留下的那截**始终内部连续**：于是无论这一次丢了多少块、连着丢了多少次，
 * drain 那边看到的都只是「队头这块的 startByte 对不上 cursor」这**一处**不连续，也就只发一条省略
 * 告示。这条性质是「恰好一条告示」的来源，不是巧合——测试里钉着它。
 *
 * cursor 的推进不在这里做：drain 逐块把 `nextCursor` 推到 `output.endByte`，所以被丢掉的那段字节
 * 必须先通过 Runtime retained replay 回补，不能把客户端裁剪当成 Runtime 淘汰。
 */
export function admitTerminalLiveOutput<T extends TerminalLiveItem>(
  chunks: readonly T[],
  incoming: T,
  maxBytes = TERMINAL_LIVE_OUTPUT_BACKLOG_BYTES
): { queue: T[]; droppedBytes: number } {
  const limit = Math.max(1, Math.floor(maxBytes))
  const queue = [...chunks]
  queue.push(incoming)
  let bytes = queue.reduce((total, chunk) => total + chunkBytes(chunk), 0)
  let droppedBytes = 0
  let ordinaryCount = queue.filter(item => !('snapshot' in item)).length
  let droppedGeometry: { item: T; afterSnapshot: T | undefined } | undefined
  // Synthetic seeds have their own Runtime bound. Raw backlog trimming cannot discard a seed.
  while (ordinaryCount > 1 && (bytes > limit || ordinaryCount > 4096)) {
    const index = queue.findIndex(item => !('snapshot' in item))
    const afterSnapshot = queue.slice(0, index).filter(item => 'snapshot' in item).at(-1)
    const dropped = queue.splice(index, 1)[0]!
    ordinaryCount -= 1
    if ('size' in dropped) droppedGeometry = { item: dropped, afterSnapshot }
    const size = chunkBytes(dropped)
    bytes -= size
    droppedBytes += size
  }
  const first = queue.findIndex(item => !('snapshot' in item))
  if (droppedGeometry && first >= 0 && !('size' in queue[first]!) &&
    queue.slice(0, first).filter(item => 'snapshot' in item).at(-1) === droppedGeometry.afterSnapshot) {
    queue.splice(first, 0, droppedGeometry.item)
  }
  return { queue, droppedBytes }
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

/** Takes the largest ordered prefix that fits the visual batch budget. */
export function takeTerminalLiveOutputBatch<T extends TerminalLiveItem>(
  chunks: readonly T[],
  maxBytes = TERMINAL_LIVE_OUTPUT_BATCH_BYTES
): { batch: TerminalLiveOutputChunk[]; rest: T[]; resize?: AgentMuxTerminalResize; snapshot?: TerminalLiveSnapshot } {
  if (chunks.length === 0) return { batch: [], rest: [] }
  const first = chunks[0]!
  if ('snapshot' in first) return { batch: [], rest: chunks.slice(1), snapshot: first }
  if ('size' in first) return { batch: [], rest: chunks.slice(1), resize: first }
  const limit = Math.max(1, Math.floor(maxBytes))
  let bytes = 0
  let count = 0
  while (count < chunks.length) {
    const chunk = chunks[count]
    if (!chunk || 'size' in chunk || 'snapshot' in chunk) break
    const size = chunkBytes(chunk)
    if (count > 0 && bytes + size > limit) break
    bytes += size
    count += 1
  }
  return {
    batch: chunks.slice(0, count) as TerminalLiveOutputChunk[],
    rest: chunks.slice(count)
  }
}
