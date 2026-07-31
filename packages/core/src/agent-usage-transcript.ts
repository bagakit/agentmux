import type { AgentTurnUsage, AgentUsageCapability } from './types.js'
import { open } from 'node:fs/promises'

/**
 * 从 Provider 自己拥有格式的 transcript 里，抽出**最近一个 turn** 的真实 token 用量。
 *
 * 为什么这份知识关在这里、且只被 hook 命令进程调用：Provider 的 transcript schema 是 Provider 的私产，
 * 哪天 codex 改了 rollout 格式、claude 改了 message 记录形状，坏的应该是这一个纯函数，而不是 Core 的会话
 * 语义。所以 Core 永远见不到文件——它只见到已经抽好的 {@link AgentTurnUsage}。这也是「usage 随既有事件流
 * 到达」的落点：hook 进程本就在收尾事件上运行、stdin 已带 `transcript_path`，它顺手读一次尾部即可，零新增
 * 轮询、零新增通道。
 *
 * 两种 transcript 都是 JSONL（一行一条 JSON），用量记录都在末尾附近，所以只解析**最后若干行**就够，
 * 不整文件读。取数一律「最后一条带用量的记录」——那就是本 turn 收敛后的累计值。
 */

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

/**
 * claude transcript（`~/.claude/projects/<slug>/<session>.jsonl`）：`type:"assistant"` 记录带
 * `message.usage`，字段为 `input_tokens` / `output_tokens`（+ cache 明细）。真实实测形状：
 * `{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, ...}`。
 * total 口径取 input+output——claude 不在 usage 里给单一 total 字段，这里就用它报的两个数相加，不掺
 * cache（cache 是 input 的构成，重复计入会虚高）。
 */
function extractClaudeUsage(tail: readonly string[], observedAt: number): AgentTurnUsage | null {
  for (const line of tail) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const message = (record as { message?: unknown }).message
    if (typeof message !== 'object' || message === null) continue
    const usage = (message as { usage?: unknown }).usage
    if (typeof usage !== 'object' || usage === null) continue
    const input = finiteNonNegative((usage as Record<string, unknown>).input_tokens)
    const output = finiteNonNegative((usage as Record<string, unknown>).output_tokens)
    // 两个核心字段都在才算一条可信记录；缺一个就说明这不是我们要的用量记录，继续往前找。
    if (input === null || output === null) continue
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      observedAt
    }
  }
  return null
}

/**
 * codex rollout（`~/.codex/sessions/.../rollout-*.jsonl`）：`type:"event_msg"` 且
 * `payload.type:"token_count"` 的记录带 `payload.info.last_token_usage`（本 turn 增量）与
 * `total_token_usage`（会话累计）。取 `last_token_usage`——它才是"这一 turn 花了多少"，与 claude 的
 * per-turn 口径对齐。字段：`{input_tokens, output_tokens, total_tokens, ...}`，codex 自带 `total_tokens`
 * 就用它报的，不自行相加。
 */
function extractCodexUsage(tail: readonly string[], observedAt: number): AgentTurnUsage | null {
  for (const line of tail) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const payload = (record as { payload?: unknown }).payload
    if (typeof payload !== 'object' || payload === null) continue
    if ((payload as { type?: unknown }).type !== 'token_count') continue
    const info = (payload as { info?: unknown }).info
    if (typeof info !== 'object' || info === null) continue
    const last = (info as { last_token_usage?: unknown }).last_token_usage
    if (typeof last !== 'object' || last === null) continue
    const input = finiteNonNegative((last as Record<string, unknown>).input_tokens)
    const output = finiteNonNegative((last as Record<string, unknown>).output_tokens)
    const total = finiteNonNegative((last as Record<string, unknown>).total_tokens)
    if (input === null || output === null) continue
    return {
      inputTokens: input,
      outputTokens: output,
      // codex 报了单一 total 就用它；没报（老格式）时退回 in+out，绝不为凑字段编数。
      totalTokens: total ?? input + output,
      observedAt
    }
  }
  return null
}

/**
 * 按 Provider 声明的 transcript 格式，从整段 transcript 文本里抽出最近一 turn 的真实用量。
 *
 * 抽不到（文件为空、格式不符、末尾还没有用量记录）就返回 `null`——缺席如实上报，绝不合成一个 0。
 * 传入的是**已读好的文本**而非路径：读文件的 IO 留给调用方（hook 命令进程），本函数保持纯粹、可直接
 * 用真实 transcript 片段做行为测试。
 */
export function extractTurnUsage(
  capability: AgentUsageCapability,
  transcriptContent: string,
  observedAt: number
): AgentTurnUsage | null {
  const tail = tailLines(transcriptContent)
  switch (capability.transcriptFormat) {
    case 'claude-jsonl':
      return extractClaudeUsage(tail, observedAt)
    case 'codex-rollout':
      return extractCodexUsage(tail, observedAt)
  }
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
  return { inputTokens, outputTokens, totalTokens, observedAt }
}

/** 只读 transcript 尾部这么多字节。用量记录贴着 turn 末尾，读整份 transcript（可达数十 MB）纯属浪费，
 *  也会把「开销可忽略」这条验收拖垮。256 KiB 足够覆盖末尾几十条 JSONL 记录。 */
const TAIL_READ_BYTES = 256 * 1024

/**
 * 读 transcript **尾部**并抽出最近一 turn 的用量——hook 命令进程在收尾事件上调用的那一步。
 *
 * 只 `read` 文件末尾 {@link TAIL_READ_BYTES} 字节（seek 到 `size - TAIL_READ_BYTES`），不 `readFile` 整份：
 * 这是「计数开销可忽略」的关键，一次 turn 收尾只多一次有界的尾部读。任何 IO 失败（文件不存在、无权限、
 * 竞态截断）一律吞成 `null`——usage 是锦上添花，绝不能因为它读失败就把整条 hook 回执打死。
 */
export async function readTurnUsageFromTranscript(
  capability: AgentUsageCapability,
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
      return extractTurnUsage(capability, buffer.toString('utf8', 0, bytesRead), observedAt)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}
