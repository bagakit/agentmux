import type { AgentTurnUsage } from './types.js'
import { open } from 'node:fs/promises'

/** Generic bounded transcript reading and measurement DTO validation. Native schemas belong to Providers. */
export type AgentUsageTranscriptDecoder = (record: unknown, observedAt: number) => AgentTurnUsage | null

/** 只回扫这么多行。用量记录紧贴 turn 末尾，几十行足够跨过收尾时追加的 last-prompt/atis-latch 等噪音。 */
const MAX_TAIL_LINES = 64

/**
 * 把 transcript 全文按行切出**末尾 {@link MAX_TAIL_LINES} 行**，逆序返回（最新在前）。
 *
 * 逆序是因为取数要的是"最后一条带用量的记录"，逆序后第一个命中的即答案，不必先全解析再挑末尾。
 */
function tailLines(content: string): string[] {
  const lines = content.split('\n')
  const tail: string[] = []
  for (let i = lines.length - 1; i >= 0 && tail.length < MAX_TAIL_LINES; i -= 1) {
    const line = lines[i]?.trim()
    if (line) tail.push(line)
  }
  return tail
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Decode only a bounded tail; unknown or malformed rows never become synthetic zero usage. */
export function extractTurnUsage(
  decode: AgentUsageTranscriptDecoder,
  transcriptContent: string,
  observedAt: number
): AgentTurnUsage | null {
  for (const line of tailLines(transcriptContent)) {
    let record: unknown
    try { record = JSON.parse(line) } catch { continue }
    const usage = decode(record, observedAt)
    if (usage) return usage
  }
  return null
}

/** hook 命令进程把抽好的 usage 并进 payload 时用的键——命名带 agentmux 前缀，明示它是 AgentMux 合成的，
 *  绝不与任何 Provider 自己的 payload 字段撞名。 */
export const HOOK_PAYLOAD_USAGE_KEY = 'agentmuxUsage'

/**
 * 把 payload 里 {@link HOOK_PAYLOAD_USAGE_KEY} 那条**已序列化**的 usage 校验回一个 {@link AgentTurnUsage}。
 *
 * 它跨了进程边界（hook 命令进程 → hook server → normalizer），所以到达时是 `unknown`：任一字段缺失或不是
 * 有限非负数就返回 `null`，让缺席保持缺席，绝不放行一个半残的对象冒充真实用量。
 */
function nativeContext(capacity: unknown, used: unknown): Pick<AgentTurnUsage, 'context'> {
  const capacityTokens = finiteNonNegative(capacity)
  const usedTokens = finiteNonNegative(used)
  return capacityTokens !== null && capacityTokens > 0 && usedTokens !== null
    ? { context: { capacityTokens, usedTokens } } : {}
}

/** Optional accounting is independent: a malformed total must not discard a valid response/context. */
export function parseCumulativeUsage(value: unknown): NonNullable<AgentTurnUsage['cumulative']> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const { inputTokens, outputTokens, totalTokens } = source
  if (source.scope !== 'native-session' || ![inputTokens, outputTokens, totalTokens].every(
    count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) return null
  return { scope: 'native-session', inputTokens: inputTokens as number, outputTokens: outputTokens as number, totalTokens: totalTokens as number }
}

export function parseTurnUsage(value: unknown): AgentTurnUsage | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const inputTokens = finiteNonNegative(record.inputTokens)
  const outputTokens = finiteNonNegative(record.outputTokens)
  const totalTokens = finiteNonNegative(record.totalTokens)
  const observedAt = finiteNonNegative(record.observedAt)
  if (inputTokens === null || outputTokens === null || totalTokens === null || observedAt === null) {
    return null
  }
  const context = record.context as Record<string, unknown> | undefined
  const cumulative = parseCumulativeUsage(record.cumulative)
  return { inputTokens, outputTokens, totalTokens, observedAt,
    ...(record.scope === 'response' ? { scope: 'response' as const } : {}),
    ...(cumulative ? { cumulative } : {}),
    ...(context && typeof context === 'object' ? nativeContext(context.capacityTokens, context.usedTokens) : {}) }
}

/** 只读 transcript 尾部这么多字节。用量记录贴着 turn 末尾，读整份 transcript（可达数十 MB）纯属浪费，
 *  也会把「开销可忽略」这条验收拖垮。256 KiB 足够覆盖末尾几十条 JSONL 记录。 */
const TAIL_READ_BYTES = 256 * 1024

/**
 * 读 transcript **尾部**并抽出最近一次响应的用量——hook 命令进程在收尾事件上调用的那一步。
 *
 * 只 `read` 文件末尾 {@link TAIL_READ_BYTES} 字节（seek 到 `size - TAIL_READ_BYTES`），不 `readFile` 整份：
 * 这是「计数开销可忽略」的关键，一次 turn 收尾只多一次有界的尾部读。任何 IO 失败（文件不存在、无权限、
 * 竞态截断）一律吞成 `null`——usage 是锦上添花，绝不能因为它读失败就把整条 hook 回执打死。
 */
export async function readTurnUsageFromTranscript(
  decode: AgentUsageTranscriptDecoder,
  transcriptPath: string,
  observedAt: number
): Promise<AgentTurnUsage | null> {
  try {
    const handle = await open(transcriptPath, 'r')
    try {
      const { size } = await handle.stat()
      const start = size > TAIL_READ_BYTES ? size - TAIL_READ_BYTES : 0
      const length = size - start
      if (length <= 0) return null
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      return extractTurnUsage(decode, buffer.toString('utf8', 0, bytesRead), observedAt)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}
