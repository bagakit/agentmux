import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hookResponseFor, resolveHookProvider, runAgentHookCommand } from '../src/agent-hook-command.js'
import { BUILT_IN_AGENT_PROVIDERS } from '../src/agent-provider.js'

describe('agent hook command response contract', () => {
  it('gates Antigravity: PreToolUse defers with "ask", Stop clears, other events emit {}', () => {
    // Antigravity reads empty/absent stdout on the PreToolUse gate as a HARD DENY (#2426),
    // so it is the one provider that must receive an explicit decision.
    expect(hookResponseFor('antigravity', 'PreToolUse')).toBe('{"decision":"ask"}\n')
    expect(hookResponseFor('antigravity', 'Stop')).toBe('{"decision":""}\n')
    expect(hookResponseFor('antigravity', 'PreInvocation')).toBe('{}\n')
    expect(hookResponseFor('antigravity', 'PostToolUse')).toBe('{}\n')
  })

  it('never emits an Antigravity decision to a gated observer of another provider', () => {
    // Codex marks the hook run FAILED on {"decision":"ask"} / {"decision":""}; Claude only
    // tolerates it by luck. A passive observer must emit {} for every event on both.
    for (const provider of ['codex', 'claude', 'gemini', 'pi', 'hermes', 'cursor', 'grok', 'traex']) {
      for (const eventName of ['PreToolUse', 'Stop', 'PostToolUse', 'SessionStart', 'UserPromptSubmit']) {
        expect(hookResponseFor(provider, eventName)).toBe('{}\n')
      }
    }
  })

  it('falls back to {} for an unknown provider or a missing event', () => {
    expect(hookResponseFor(null, 'PreToolUse')).toBe('{}\n')
    expect(hookResponseFor('antigravity', null)).toBe('{}\n')
    expect(hookResponseFor(null, null)).toBe('{}\n')
  })

  it('resolves the provider from the baked command var, then the launch env, then the antigravity event', () => {
    expect(resolveHookProvider({ AGENTMUX_HOOK_PROVIDER: 'codex', AGENTMUX_PROVIDER_ID: 'claude' })).toBe('codex')
    expect(resolveHookProvider({ AGENTMUX_PROVIDER_ID: 'claude' })).toBe('claude')
    expect(resolveHookProvider({ AGENTMUX_ANTIGRAVITY_EVENT: 'PreToolUse' })).toBe('antigravity')
    expect(resolveHookProvider({})).toBeNull()
  })
})

// 守 hook 进程那段「在收尾事件上读 transcript 尾部、把本 turn 真实 token 数并进既有 POST」的接线本身。
// 前面的纯函数测试守的是抽取正确，但那段调用点（agent-hook-command.ts 的 runAgentHookCommand）无人覆盖时，
// 把整段摘掉也能全绿——usage 会永远缺席却没有测试发红。这一组就把那段接线端到端钉住：喂 stdin、给真实
// transcript、拦截 POST，断言 body.payload 里 usage 该在时在、不该在时绝不在（验收 1/5/6 落在源头）。
describe('agent hook command usage relay', () => {
  const CLAUDE_TRANSCRIPT =
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', usage: { input_tokens: 2, output_tokens: 5 } }
    }) + '\n'

  let restoreStdin: (() => void) | null = null

  function feedStdin(json: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([Buffer.from(json, 'utf8')]),
      configurable: true
    })
    restoreStdin = () => {
      if (descriptor) Object.defineProperty(process, 'stdin', descriptor)
      else delete (process as unknown as { stdin?: unknown }).stdin
    }
  }

  // 拦下 fetch，把 POST body 解析出来供断言；stdout 也吞掉避免污染测试输出。
  function captureHookPost(): { bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>)
        return { ok: true } as Response
      })
    )
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    return { bodies }
  }

  afterEach(() => {
    restoreStdin?.()
    restoreStdin = null
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('merges the real last-turn usage into the Stop POST for a usage-declaring provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-hookcmd-'))
    try {
      const transcriptPath = join(dir, 'transcript.jsonl')
      await writeFile(transcriptPath, CLAUDE_TRANSCRIPT)
      vi.stubEnv('AGENTMUX_HOOK_URL', 'http://127.0.0.1:65535/hook')
      vi.stubEnv('AGENTMUX_HOOK_TOKEN', 'test-token')
      vi.stubEnv('AGENTMUX_HOOK_EVENT', 'Stop')
      vi.stubEnv('AGENTMUX_USAGE_TRANSCRIPT_FORMAT', 'claude-jsonl')
      const { bodies } = captureHookPost()
      feedStdin(JSON.stringify({ session_id: 'sess-real', transcript_path: transcriptPath }))

      await runAgentHookCommand()

      expect(bodies).toHaveLength(1)
      const payload = bodies[0]!.payload as Record<string, unknown>
      // 这条断言就是 Mutation B（摘掉读 transcript 那段）会发红的地方：usage 必须真的并进了 POST，
      // 且分子逐字来自 transcript（2/5/7），不是任何合成值。
      expect(payload.agentmuxUsage).toMatchObject({ inputTokens: 2, outputTokens: 5, totalTokens: 7 })
      expect(typeof (payload.agentmuxUsage as Record<string, unknown>).observedAt).toBe('number')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('attaches NO usage when the provider did not declare a transcript format (never a fabricated one)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-hookcmd-'))
    try {
      const transcriptPath = join(dir, 'transcript.jsonl')
      await writeFile(transcriptPath, CLAUDE_TRANSCRIPT)
      vi.stubEnv('AGENTMUX_HOOK_URL', 'http://127.0.0.1:65535/hook')
      vi.stubEnv('AGENTMUX_HOOK_TOKEN', 'test-token')
      vi.stubEnv('AGENTMUX_HOOK_EVENT', 'Stop')
      // 关键：不声明 AGENTMUX_USAGE_TRANSCRIPT_FORMAT——这就是未接入 usage 的 7 家的情形。
      vi.stubEnv('AGENTMUX_USAGE_TRANSCRIPT_FORMAT', '')
      const { bodies } = captureHookPost()
      feedStdin(JSON.stringify({ session_id: 'sess-undeclared', transcript_path: transcriptPath }))

      await runAgentHookCommand()

      expect(bodies).toHaveLength(1)
      const payload = bodies[0]!.payload as Record<string, unknown>
      // 即便 transcript 就在那儿且有真实用量，没声明格式的 Provider 也绝不被塞进一个 usage——
      // 缺席在源头就是缺席，UI 那侧才谈得上显示"此 Provider 不报 token 用量"而非 0。
      expect(payload).not.toHaveProperty('agentmuxUsage')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('attaches NO usage when a declared provider closes a turn whose transcript has no usage yet (never a fabricated 0)', async () => {
    // 真值态 2：Provider 声明了 usage、事件是收尾（Stop）、transcript 也在，但里面还没有一条用量记录
    // （turn 刚开始、或 Provider 这一 turn 没写用量）。抽取返回 null，源头就绝不能塞一个 {0,0,0} 冒充
    // "这一 turn 花了 0 个 token"——否则下游 parseTurnUsage 会照收，UI 落成 "0 tok"，awaiting 态被吞掉。
    // 这条断言正是钉住 agent-hook-command.ts 的 `if (usage)` 那一侧：把它改成 `usage ?? {0,0,0}` 就发红。
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-hookcmd-'))
    try {
      const transcriptPath = join(dir, 'transcript.jsonl')
      // 合法 JSONL、能解析，但没有 assistant.usage——真正的"声明了但还没数"。
      await writeFile(transcriptPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
      vi.stubEnv('AGENTMUX_HOOK_URL', 'http://127.0.0.1:65535/hook')
      vi.stubEnv('AGENTMUX_HOOK_TOKEN', 'test-token')
      vi.stubEnv('AGENTMUX_HOOK_EVENT', 'Stop')
      vi.stubEnv('AGENTMUX_USAGE_TRANSCRIPT_FORMAT', 'claude-jsonl')
      const { bodies } = captureHookPost()
      feedStdin(JSON.stringify({ session_id: 'sess-noturn', transcript_path: transcriptPath }))

      await runAgentHookCommand()

      expect(bodies).toHaveLength(1)
      const payload = bodies[0]!.payload as Record<string, unknown>
      expect(payload).not.toHaveProperty('agentmuxUsage')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not read the transcript on a non-finalization event (usage only on turn close)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-hookcmd-'))
    try {
      const transcriptPath = join(dir, 'transcript.jsonl')
      await writeFile(transcriptPath, CLAUDE_TRANSCRIPT)
      vi.stubEnv('AGENTMUX_HOOK_URL', 'http://127.0.0.1:65535/hook')
      vi.stubEnv('AGENTMUX_HOOK_TOKEN', 'test-token')
      vi.stubEnv('AGENTMUX_HOOK_EVENT', 'PostToolUse')
      vi.stubEnv('AGENTMUX_USAGE_TRANSCRIPT_FORMAT', 'claude-jsonl')
      const { bodies } = captureHookPost()
      feedStdin(JSON.stringify({ session_id: 'sess-midturn', transcript_path: transcriptPath }))

      await runAgentHookCommand()

      expect(bodies).toHaveLength(1)
      const payload = bodies[0]!.payload as Record<string, unknown>
      // PostToolUse 不是收尾事件：本 turn 用量还没落定，这里读也读不到终值，所以根本不读、不并入。
      expect(payload).not.toHaveProperty('agentmuxUsage')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * 事件名的三个拼法在这个**子进程**里同权——它与 normalizer 共用 agent-hook-event.ts 那一份键顺序。
   *
   * 为什么必须在这里单独钉：此前这个子进程只认 `hook_event_name` 与 `eventName`，**漏掉
   * `hookEventName`**。于是一个只给 camelCase 的 Provider，其事件名在这里读成 null——`eventName`
   * 为空会让整段 POST 被跳过（见 `if (url && token && eventName)`），状态与用量双双静默丢失，
   * 而 normalizer 侧的测试全绿，因为事件压根没送到 Core。
   */
  it('reads the event name from all three payload spellings, so no spelling silently drops the POST', async () => {
    for (const key of ['hook_event_name', 'hookEventName', 'eventName']) {
      const dir = await mkdtemp(join(tmpdir(), 'agentmux-hookcmd-'))
      try {
        const transcriptPath = join(dir, 'transcript.jsonl')
        await writeFile(transcriptPath, CLAUDE_TRANSCRIPT)
        vi.stubEnv('AGENTMUX_HOOK_URL', 'http://127.0.0.1:65535/hook')
        vi.stubEnv('AGENTMUX_HOOK_TOKEN', 'test-token')
        // 关键：不给旗标、不给环境变量——事件名只能从 stdin 负载的这个拼法读出来。
        vi.stubEnv('AGENTMUX_HOOK_EVENT', '')
        vi.stubEnv('AGENTMUX_USAGE_TRANSCRIPT_FORMAT', 'claude-jsonl')
        const { bodies } = captureHookPost()
        feedStdin(JSON.stringify({ [key]: 'Stop', session_id: 'sess-spelling', transcript_path: transcriptPath }))

        await runAgentHookCommand()

        // POST 真的发出去了（事件名读出来了），且事件名逐字是 Stop。
        expect(bodies, `payload key ${key} must resolve the event name`).toHaveLength(1)
        expect(bodies[0]!.eventName).toBe('Stop')
        // 而且被认成 turn 收尾，所以用量真的抽到了——这一步同时守住派生出来的收尾事件集合。
        const payload = bodies[0]!.payload as Record<string, unknown>
        expect(payload.agentmuxUsage).toMatchObject({ inputTokens: 2, outputTokens: 5, totalTokens: 7 })
      } finally {
        await rm(dir, { recursive: true, force: true })
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
    }
  })

  /**
   * 收尾事件集合是从 canonical 映射表派生的，所以 snake_case 的收尾方言也能抽到用量。
   * 此前硬编码 `['Stop','StopFailure']`：Hermes 的 `on_session_end` 与 Pi 的 `agent_end` 永远读不到。
   */
  it('extracts usage on a snake_case turn-end dialect, not only on PascalCase Stop', async () => {
    for (const eventName of ['on_session_end', 'agent_end']) {
      const dir = await mkdtemp(join(tmpdir(), 'agentmux-hookcmd-'))
      try {
        const transcriptPath = join(dir, 'transcript.jsonl')
        await writeFile(transcriptPath, CLAUDE_TRANSCRIPT)
        vi.stubEnv('AGENTMUX_HOOK_URL', 'http://127.0.0.1:65535/hook')
        vi.stubEnv('AGENTMUX_HOOK_TOKEN', 'test-token')
        vi.stubEnv('AGENTMUX_HOOK_EVENT', eventName)
        vi.stubEnv('AGENTMUX_USAGE_TRANSCRIPT_FORMAT', 'claude-jsonl')
        const { bodies } = captureHookPost()
        feedStdin(JSON.stringify({ session_id: 'sess-snake', transcript_path: transcriptPath }))

        await runAgentHookCommand()

        expect(bodies).toHaveLength(1)
        const payload = bodies[0]!.payload as Record<string, unknown>
        expect(payload.agentmuxUsage, `${eventName} is a turn end and must yield usage`)
          .toMatchObject({ inputTokens: 2, outputTokens: 5, totalTokens: 7 })
      } finally {
        await rm(dir, { recursive: true, force: true })
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
      }
    }
  })

  /**
   * POST 的闸是 `if (url && token && eventName)`——三个合取项。上面所有测试都断言「POST 发出去了」
   * （`bodies).toHaveLength(1)`），也就是全都只质询这道闸的**通过侧**；每个 fixture 三项都是真的，
   * 所以任意删掉一项都不改变它们断言的任何东西（实测：把 `&& eventName` 删掉，21 条全绿）。
   *
   * 拦下侧同样承重——尤其 `eventName` 那一项，实现里 :113-115 的注释把它点名为 P0：一个存在但为空的
   * `AGENTMUX_HOOK_EVENT` 会让事件名变 falsy，于是整段 POST 被跳过、状态与用量双双静默丢失。
   * 下面三条各让一项为假、另两项为真，于是每一项都成为那个现场里唯一还站着的守卫。
   */
  it('三项闸各自都能拦下 POST：缺 url / 缺 token / 事件名读不出来', async () => {
    const cases = [
      {
        name: '缺 url',
        env: { AGENTMUX_HOOK_TOKEN: 'test-token', AGENTMUX_HOOK_EVENT: 'Stop' } as Record<string, string>
      },
      {
        name: '缺 token',
        env: { AGENTMUX_HOOK_URL: 'http://127.0.0.1:65535/hook', AGENTMUX_HOOK_EVENT: 'Stop' }
      },
      {
        // url 与 token 都齐，只有事件名读不出来：旗标没给、环境变量是空串（读作「没设」）、
        // stdin 负载里也没有任何一种事件名拼法。这正是那条 P0 注释描述的现场。
        name: '事件名读不出来',
        env: {
          AGENTMUX_HOOK_URL: 'http://127.0.0.1:65535/hook',
          AGENTMUX_HOOK_TOKEN: 'test-token',
          AGENTMUX_HOOK_EVENT: ''
        }
      }
    ]
    for (const scenario of cases) {
      for (const [key, value] of Object.entries(scenario.env)) vi.stubEnv(key, value)
      const { bodies } = captureHookPost()
      feedStdin(JSON.stringify({ session_id: 'sess-gate' }))

      await runAgentHookCommand()

      expect(bodies, `${scenario.name} 时不该发出任何 POST`).toHaveLength(0)
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })
})

/**
 * 门控决策与 stdin 的顺序。
 *
 * 我们自己的 128KiB 上限（MAX_HOOK_INPUT_BYTES）在 stdin 读循环里 `throw`。决策的 stdout 写出原先排在
 * 读循环**之后**，于是一个超大负载让整个进程带着**空 stdout** 退出——而 Antigravity 把 PreToolUse 上的
 * 空 stdout 读作 HARD DENY（见 hookResponseFor 头部注释）。后果不是「丢一条状态」，而是**我们的体积
 * 上限把一个合法的工具调用变成了策略拒绝**：Agent 被自己的监视器挡住。大文件写、大段粘贴的
 * PreToolUse 负载超 128KiB 是现实场景。
 *
 * 实测（HEAD 上，修复前）：provider=antigravity + PreToolUse + 200KiB stdin，捕获到的 stdout 是 `[]`。
 */
describe('门控决策先于读 stdin', () => {
  let restoreStdin: (() => void) | null = null

  /** 塞一段任意大小的 stdin；返回的函数还原原描述符。 */
  function feedRawStdin(chunk: Buffer): void {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', { value: Readable.from([chunk]), configurable: true })
    restoreStdin = () => {
      if (descriptor) Object.defineProperty(process, 'stdin', descriptor)
      else delete (process as unknown as { stdin?: unknown }).stdin
    }
  }

  function captureStdout(): string[] {
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    return written
  }

  afterEach(() => {
    restoreStdin?.()
    restoreStdin = null
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('超过体积上限的负载仍然把门控决策写了出去——上限不许把合法工具调用变成拒绝', async () => {
    vi.stubEnv('AGENTMUX_HOOK_PROVIDER', 'antigravity')
    // 事件名走 Antigravity 自己的环境变量（等价于 `--event PreToolUse`）：两者都与 stdin 无关，
    // 这正是「决策可以先算出来」的全部依据。
    vi.stubEnv('AGENTMUX_ANTIGRAVITY_EVENT', 'PreToolUse')
    const written = captureStdout()
    feedRawStdin(Buffer.alloc(200 * 1024, 0x41))

    // 体积上限照旧响亮失败——这一条状态事件确实丢了，我们不假装它没丢。
    await expect(runAgentHookCommand()).rejects.toThrow(/exceeds the AgentMux limit/)

    // 但决策必须已经送达。把 stdout 写出移回 stdin 读循环之后（原位置），这里会拿到 []，断言红。
    expect(written, '超大负载下门控决策没写出去——Antigravity 会把空 stdout 读作 HARD DENY')
      .toEqual(['{"decision":"ask"}\n'])
  })

  it('正常大小的负载不受影响：决策仍是那一条，且只写一次', async () => {
    // 反向那一侧。前移若写成「两处都写」，正常路径会出现两条决策——一个门控 CLI 读到两段 JSON。
    vi.stubEnv('AGENTMUX_HOOK_PROVIDER', 'antigravity')
    vi.stubEnv('AGENTMUX_ANTIGRAVITY_EVENT', 'PreToolUse')
    const written = captureStdout()
    feedRawStdin(Buffer.from(JSON.stringify({ session_id: 'sess-small' }), 'utf8'))

    await runAgentHookCommand()

    expect(written).toEqual(['{"decision":"ask"}\n'])
  })

  /**
   * 生产真路：事件名走 `--event` 旗标，而不是环境变量。
   *
   * 上面两条用 `AGENTMUX_ANTIGRAVITY_EVENT` 喂事件名，图的是简便——可**生产里那个变量根本不存在**：
   * `client.ts` 的 agentEnvironment 只注入 url/token/providerId，从不注入任何事件名变量（grep 可证），
   * 而 antigravity 的 managed plan 给每条 hook 命令追加 `--event <名>`（providers/antigravity.ts:34-38）。
   * 于是那两条走的是一条只在测试里点亮的路。
   *
   * 后果实测：把决策的事件源从 `flagEvent ?? envEvent` 收窄成只认 `envEvent`，本文件与
   * provider-event-name-source 那套 **36 条全绿**——而生产里 antigravity 的每一次 PreToolUse 都会拿到
   * `{}`（因为 env 恒空），被读作 HARD DENY。正是本 describe 要消灭的那类灾难，在全绿下复活。
   *
   * 所以这一条**刻意不设**任何事件名环境变量：旗标是这里事件名的唯一来源。
   */
  it('生产真路：事件名只来自 --event 旗标时，门控决策照样送达', async () => {
    vi.stubEnv('AGENTMUX_HOOK_PROVIDER', 'antigravity')
    const originalArgv = process.argv
    process.argv = [originalArgv[0]!, originalArgv[1]!, '--event', 'PreToolUse']
    try {
      const written = captureStdout()
      feedRawStdin(Buffer.from(JSON.stringify({ session_id: 'sess-flag' }), 'utf8'))

      await runAgentHookCommand()

      expect(written, '旗标是生产里事件名的唯一来源——决策丢了就等于每次工具调用都被拒绝')
        .toEqual(['{"decision":"ask"}\n'])
    } finally {
      process.argv = originalArgv
    }
  })

  /**
   * 前移的前提：**决策的两个输入都与 stdin 无关**。provider 恒来自 env，事件名则必须来自 `--event`
   * 旗标或 env，绝不能只在负载里。这条前提此前只写在注释里；写成判据，是因为将来某家 gated Provider
   * 改成 `payload` 取事件名时，前移会静默给出**错的**决策（PreToolUse 的 `ask` 退化成 `{}`），
   * 而上面两条测试用的是 antigravity、照旧全绿。
   *
   * 「谁是 gated」不手抄名字，而是问 `hookResponseFor` 自己：它对哪家返回非 `{}`，那家就是 gated。
   * 这样第二家 gated Provider 一加进来就自动落入判据，不必有人记得回来改这份清单。
   */
  it('每一家门控 Provider 的事件名都不靠 stdin——否则前移会给出错的决策', () => {
    const gated = BUILT_IN_AGENT_PROVIDERS.filter((provider) =>
      provider.hook.rules.some((rule) => rule.events.some((event) => hookResponseFor(provider.id, event) !== '{}\n'))
    )
    // 自检：判据不能落空。真有 0 家门控时，上面那两条行为断言也没有对象，这里要响亮地说出来。
    expect(gated.map((provider) => provider.id), '一家门控 Provider 都没识别出来——判据落空了')
      .not.toHaveLength(0)

    for (const provider of gated) {
      expect(provider.hook.eventNameSource, `${provider.id} 是门控的，必须声明事件名来源`).toBeDefined()
      expect(
        provider.hook.eventNameSource?.kind,
        `${provider.id} 的事件名来自负载，可是门控决策要在读负载之前写出——这两件事不能同时成立`
      ).toBe('flag')
    }
  })
})
