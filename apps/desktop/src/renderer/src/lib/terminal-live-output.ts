export type TerminalLiveOutputChunk = {
  data: string
  startByte: number
  endByte: number
}

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

function chunkBytes(chunk: TerminalLiveOutputChunk): number {
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
export function admitTerminalLiveOutput(
  chunks: readonly TerminalLiveOutputChunk[],
  incoming: TerminalLiveOutputChunk,
  maxBytes = TERMINAL_LIVE_OUTPUT_BACKLOG_BYTES
): { queue: TerminalLiveOutputChunk[]; droppedBytes: number } {
  const limit = Math.max(1, Math.floor(maxBytes))
  const queue = [...chunks, incoming]
  let bytes = queue.reduce((total, chunk) => total + chunkBytes(chunk), 0)
  let droppedBytes = 0
  // 至少留一块：把队列清空会把刚收到的最新字节也丢掉，那等于这一刻的终端什么都不显示。
  while (queue.length > 1 && bytes > limit) {
    const dropped = queue.shift()
    if (!dropped) break
    const size = chunkBytes(dropped)
    bytes -= size
    droppedBytes += size
  }
  return { queue, droppedBytes }
}

/** Takes the largest ordered prefix that fits the visual batch budget. */
export function takeTerminalLiveOutputBatch(
  chunks: readonly TerminalLiveOutputChunk[],
  maxBytes = TERMINAL_LIVE_OUTPUT_BATCH_BYTES
): { batch: TerminalLiveOutputChunk[]; rest: TerminalLiveOutputChunk[] } {
  if (chunks.length === 0) return { batch: [], rest: [] }
  const limit = Math.max(1, Math.floor(maxBytes))
  let bytes = 0
  let count = 0
  while (count < chunks.length) {
    const chunk = chunks[count]
    if (!chunk) break
    const size = chunkBytes(chunk)
    if (count > 0 && bytes + size > limit) break
    bytes += size
    count += 1
  }
  return {
    batch: chunks.slice(0, count),
    rest: chunks.slice(count)
  }
}
