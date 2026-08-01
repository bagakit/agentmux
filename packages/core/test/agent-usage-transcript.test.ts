import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  extractTurnUsage,
  parseTurnUsage,
  readTurnUsageFromTranscript,
  HOOK_PAYLOAD_USAGE_KEY
} from '../src/agent-usage-transcript.js'
import type { AgentUsageCapability } from '../src/types.js'

const CLAUDE: AgentUsageCapability = { kind: 'native-transcript', transcriptFormat: 'claude-jsonl' }
const CODEX: AgentUsageCapability = { kind: 'native-transcript', transcriptFormat: 'codex-rollout' }

// 真实记录形状——逐字取自本机真跑一个 turn 后 claude / codex 各自 transcript 里的那一行（已核对过
// 与 Provider 自报的用量一致：claude `-p` 的 result.usage、codex 的 last_token_usage）。用真实 schema
// 而不是我们编的形状，才守得住「至少一个 Provider 接通原生 usage 回执且有真实证据（不是 fixture 自证）」。
// 这里把周边噪音记录也一并放进来（attachment / last-prompt / token_count 的 total 干扰项），因为抽取
// 必须在真实 transcript 的杂音里挑对那一条。
const CLAUDE_TRANSCRIPT = [
  JSON.stringify({ type: 'attachment', timestamp: '2026-08-31T02:44:00.000Z' }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-31T02:44:03.000Z',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 53709,
        cache_read_input_tokens: 0,
        output_tokens: 5,
        service_tier: 'standard'
      }
    }
  }),
  JSON.stringify({ type: 'last-prompt' })
].join('\n') + '\n'

const CODEX_ROLLOUT = [
  JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'DONE' } }),
  JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-31T02:00:44.000Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 999999,
          output_tokens: 888888,
          total_tokens: 1888887
        },
        last_token_usage: {
          input_tokens: 61008,
          cached_input_tokens: 58112,
          output_tokens: 3381,
          reasoning_output_tokens: 2650,
          // 故意**不等于** input+output（61008+3381=64389）：codex 自报的 total 会把
          // reasoning_output_tokens 这类不在 input/output 里的量也算进去，所以真实数据里
          // 它本来就可以大于两者之和。这个差额是本 fixture 的判据本体——三数自洽时，
          // 「用它报的 total」与「自己加一遍」给出同一个数字，那条取值就无人守（实测：
          // 把 `total ?? input + output` 改成 `input + output`，23 条全绿）。
          total_tokens: 67039
        }
      }
    }
  })
].join('\n') + '\n'

describe('native usage extraction from provider transcripts', () => {
  it('reads the real claude assistant record usage as this turn tokens', () => {
    const usage = extractTurnUsage(CLAUDE, CLAUDE_TRANSCRIPT, 1234)
    // 分子逐字来自 Provider：input/output 就是 claude 自报的 2 / 5；total 取 in+out（claude 不给单一 total）。
    expect(usage).toEqual({ inputTokens: 2, outputTokens: 5, totalTokens: 7, observedAt: 1234 })
  })

  it('reads codex last_token_usage (this turn) — never the session total', () => {
    const usage = extractTurnUsage(CODEX, CODEX_ROLLOUT, 5678)
    // 必须取 last_token_usage（本 turn 增量），不是 total_token_usage（会话累计）。若抽错字段，
    // 下面这三个数会变成 999999/888888/1888887——断言会红。codex 自报单一 total 就用它报的。
    expect(usage).toEqual({ inputTokens: 61008, outputTokens: 3381, totalTokens: 67039, observedAt: 5678 })
    // 而且 total 必须是**它报的那个**，不是我们自己加的：fixture 里 61008+3381=64389 ≠ 67039，
    // 差额就是 reasoning_output_tokens。这一行把「谁算的」单独钉住——不写它的话，只要哪天有人
    // 把 fixture 改回三数自洽，`total ?? input + output` 换成 `input + output` 又会静默全绿。
    expect(usage?.totalTokens).not.toBe(61008 + 3381)
  })

  it('returns null when the transcript has no usage record yet (no fabricated zero)', () => {
    const noUsage = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'attachment' })
    ].join('\n')
    // 缺席如实是缺席：绝不返回一个 {0,0,0} 冒充"这一 turn 花了 0 个 token"。
    expect(extractTurnUsage(CLAUDE, noUsage, 1)).toBeNull()
    expect(extractTurnUsage(CODEX, noUsage, 1)).toBeNull()
  })

  // `total ?? input + output` 有两条出口，上面那条 codex 用例只走了「它报了」那一侧。
  // 老格式（codex 早期 rollout 不写 total_tokens）走另一侧，而它此前无人守：把整个表达式
  // 换成 `total as number`，23 条全绿（实测）——真实后果是老 rollout 的总量变成 undefined，
  // 一路灌进 POST 负载与用量面板。两条出口各要一条用例，不是一条。
  it('falls back to in+out only when codex reports no single total (legacy rollout)', () => {
    const legacy = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 700, output_tokens: 42 } }
      }
    }) + '\n'
    const usage = extractTurnUsage(CODEX, legacy, 99)
    expect(usage).toEqual({ inputTokens: 700, outputTokens: 42, totalTokens: 742, observedAt: 99 })
    // 这一侧的判据是「有个数」而不只是「等于 742」：删掉 fallback 时得到的是 undefined，
    // 而 undefined 会顺着可选字段一路静默走远，所以先把「在场且有限」单独钉住。
    expect(Number.isFinite(usage?.totalTokens)).toBe(true)
  })

  it('ignores a usage-shaped record missing a core field rather than half-reporting', () => {
    // output_tokens 缺失：这不是一条可信的用量记录，跳过而不是把它当 0。
    const missingOutput = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', usage: { input_tokens: 100 } }
    })
    expect(extractTurnUsage(CLAUDE, missingOutput, 1)).toBeNull()
    // 对称地守另一侧：input_tokens 缺失同样必须跳过——否则删掉抽取里 `input === null ||` 那半个判断也不发红。
    const missingInput = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', usage: { output_tokens: 5 } }
    })
    expect(extractTurnUsage(CLAUDE, missingInput, 1)).toBeNull()
  })

  it('finds the tail usage record even in a large transcript (happy path)', async () => {
    // 大量前置噪音、真值在末尾——证明大文件里也能取到尾部真值。
    const filler = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ type: 'noise', i })
    ).join('\n')
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-usage-'))
    try {
      const path = join(dir, 'transcript.jsonl')
      await writeFile(path, `${filler}\n${CLAUDE_TRANSCRIPT}`)
      const usage = await readTurnUsageFromTranscript(CLAUDE, path, 42)
      expect(usage).toEqual({ inputTokens: 2, outputTokens: 5, totalTokens: 7, observedAt: 42 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores a usage record lying beyond the tail-read byte window (bounded read, not whole-file)', async () => {
    // 真正证明"只读尾部 256KiB、不整文件读"。难点：extractTurnUsage 逆序取离 EOF 最近的一条，且 tailLines
    // 已把行数裁到 64——短行噪音下，字节级尾读是冗余的，靠输出断言证不出来。要证它，唯一的用量记录必须
    // 落在**末尾 64 行以内**（排除行数裁剪的干扰）却又在**256KiB 字节窗口以外**——这只有靠巨行才能同时满足。
    // 有界读会看不见这条越界的老记录 → 返回 null；若实现退化成整文件读，行数裁剪挡不住它 → 会读出 {99,99}，
    // 断言 toBeNull 发红。这条把「计数开销可忽略：不整文件读」钉在可观测行为上。
    const oldUsage = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', usage: { input_tokens: 99, output_tokens: 99 } }
    })
    const pad = 'x'.repeat(40 * 1024)
    // 8 条巨行噪音 ≈ 320KiB，稳超 256KiB 尾读窗口；总行数（9）远小于 64，故行数裁剪不会挡住 oldUsage。
    const hugeNoise = Array.from({ length: 8 }, (_, i) => JSON.stringify({ type: 'noise', i, pad })).join('\n')
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-usage-'))
    try {
      const path = join(dir, 'transcript.jsonl')
      await writeFile(path, `${oldUsage}\n${hugeNoise}\n`)
      const usage = await readTurnUsageFromTranscript(CLAUDE, path, 42)
      expect(usage).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null (never throws) when the transcript file is absent', async () => {
    // usage 是锦上添花：读不到文件不能把整条 hook 回执打死，只能安静缺席。
    const usage = await readTurnUsageFromTranscript(CLAUDE, '/no/such/transcript.jsonl', 1)
    expect(usage).toBeNull()
  })

  it('parseTurnUsage round-trips a serialized usage across the process boundary', () => {
    const usage = { inputTokens: 2, outputTokens: 5, totalTokens: 7, observedAt: 1234 }
    // hook payload 里 usage 是这个键，跨进程后是 unknown——parse 必须把它认回结构化用量。
    const wire = JSON.parse(JSON.stringify({ [HOOK_PAYLOAD_USAGE_KEY]: usage }))
    expect(parseTurnUsage(wire[HOOK_PAYLOAD_USAGE_KEY])).toEqual(usage)
  })

  it('parseTurnUsage rejects a half-filled or non-numeric object', () => {
    expect(parseTurnUsage({ inputTokens: 2, outputTokens: 5 })).toBeNull()
    expect(parseTurnUsage({ inputTokens: 2, outputTokens: 5, totalTokens: 7 })).toBeNull()
    expect(parseTurnUsage({ inputTokens: -1, outputTokens: 5, totalTokens: 7, observedAt: 1 })).toBeNull()
    expect(parseTurnUsage(null)).toBeNull()
    expect(parseTurnUsage('nope')).toBeNull()
  })
})
