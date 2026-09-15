import type { TerminalGridSize } from './terminal-viewport-sync'

export type TerminalLiveOutputChunk = {
  dataBytes: Uint8Array
  startByte: number
  endByte: number
}

export type TerminalLiveItem = TerminalLiveOutputChunk | { size: TerminalGridSize }

/** Keep one visual live-output write bounded while coalescing small RuntimeEvents. */
export const TERMINAL_LIVE_OUTPUT_BATCH_BYTES = 64 * 1024

/**
 * Keep unparsed events bounded at 2 MiB. Overflow drops the oldest queued events, not Runtime
 * history: the drain must recover retained bytes from its last parsed cursor before consuming
 * a discontinuous tail. Only Runtime Gap or failed recovery permits an honest omission notice.
 */
export const TERMINAL_LIVE_OUTPUT_BACKLOG_BYTES = 2 * 1024 * 1024

function chunkBytes(chunk: TerminalLiveItem): number {
  if ('size' in chunk) return 0
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
  // Consecutive geometry observations have no bytes between them; only the last can affect parsing.
  if ('size' in incoming && queue.length && 'size' in queue[queue.length - 1]!) queue.pop()
  queue.push(incoming)
  let bytes = queue.reduce((total, chunk) => total + chunkBytes(chunk), 0)
  let droppedBytes = 0
  let droppedGeometry: T | undefined
  // 至少留一块：把队列清空会把刚收到的最新字节也丢掉，那等于这一刻的终端什么都不显示。
  while (queue.length > 1 && (bytes > limit || queue.length > 4096)) {
    const dropped = queue.shift()
    if (!dropped) break
    if ('size' in dropped) droppedGeometry = dropped
    const size = chunkBytes(dropped)
    bytes -= size
    droppedBytes += size
  }
  // Retained bytes must still parse under the last geometry preceding their prefix.
  if (droppedGeometry && !('size' in queue[0]!)) queue.unshift(droppedGeometry)
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
): { batch: TerminalLiveOutputChunk[]; rest: T[]; size?: TerminalGridSize } {
  if (chunks.length === 0) return { batch: [], rest: [] }
  const first = chunks[0]!
  if ('size' in first) return { batch: [], rest: chunks.slice(1), size: first.size }
  const limit = Math.max(1, Math.floor(maxBytes))
  let bytes = 0
  let count = 0
  while (count < chunks.length) {
    const chunk = chunks[count]
    if (!chunk || 'size' in chunk) break
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
