import type { TerminalGridSize } from './terminal-viewport-sync'

export type TerminalLiveOutputChunk = {
  data: string
  startByte: number
  endByte: number
}

export type TerminalLiveItem = TerminalLiveOutputChunk | { size: TerminalGridSize }

/** Keep one visual live-output write bounded while coalescing small RuntimeEvents. */
export const TERMINAL_LIVE_OUTPUT_BATCH_BYTES = 64 * 1024

/**
 * 未消费的 live 输出总量上限。超出的部分从**队头**丢弃。
 *
 * 为什么可以丢：scrollback 只有 5000 行，flood 期间积压的那几十上百 MB 一旦 parse 完立刻被挤出
 * 缓冲——为马上就要滚没的行做无用功，代价却是 renderer 堆随「已产出 − 已 parse」近似线性上涨
 * （agent `cat` 一个 50MB 文件是几十 MB 尖峰，`yes` 跑几秒能到数百 MB，够 GC 抖动乃至 OOM）。
 *
 * 为什么丢队头而不是丢队尾：队尾是**最新**的字节，也是用户正在看的那一屏；丢掉它等于让终端停在
 * 过去。丢队头则只损失中间一段，而那段的省略由 drain 里既有的「序列不连续」告示如实说出来。
 *
 * 上限取 2MiB：约等于 5000 行 × 80 列的几倍，足够覆盖一屏之外的正常回看，又远低于会让堆抖动的量级。
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
 * 会随着它后面那块一起被跨过去。生产者永远不会因为我们丢了字节而卡住。
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
 * 序列不连续时写进终端的告示。
 *
 * 是常量而不是就地字面量：判据（「什么时候该说」）与措辞必须同住，否则测试要手抄一份，
 * 而手抄的那份改了不会红。
 */
export const TERMINAL_LIVE_OUTPUT_GAP_NOTICE =
  '\r\n\u001b[33m[Output sequence gap; earlier bytes are unavailable]\u001b[0m\r\n'

// 一个模块级的编解码器对：无状态（不用 stream 模式），所以共用是安全的，也避免了「同一份字节
// 在两个各自新建的 decoder 之间往返」那类隐患。
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * 这一块里 `afterByte` 之后的那截。
 *
 * 按**字节**切而不是按字符切：startByte/endByte 是 UTF-8 字节偏移，用 `String.prototype.slice`
 * 会在任何非 ASCII 输出上错位（一个 CJK 字符 3 字节、emoji 4 字节）。
 */
function dataAfterByte(chunk: TerminalLiveOutputChunk, afterByte: number): string {
  if (afterByte <= chunk.startByte) return chunk.data
  return utf8Decoder.decode(utf8Encoder.encode(chunk.data).subarray(afterByte - chunk.startByte))
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
 * - **真的缺了一段**（`startByte > cursor`）：发告示，再写整块。省略是真的，必须说。
 *
 * 与 CLI 侧的 follow 流同形（core 的 session-output-follow 做的是同样三分），两边不许只有一边对。
 */
export function composeTerminalLiveOutputWrite(
  batch: readonly TerminalLiveOutputChunk[],
  cursor: number
): { data: string; cursor: number } {
  const parts: string[] = []
  let nextCursor = cursor
  for (const chunk of batch) {
    if (chunk.endByte <= nextCursor) continue
    if (chunk.startByte > nextCursor) parts.push(TERMINAL_LIVE_OUTPUT_GAP_NOTICE)
    parts.push(dataAfterByte(chunk, nextCursor))
    nextCursor = chunk.endByte
  }
  return { data: parts.join(''), cursor: nextCursor }
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
