import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hookResponseFor, resolveHookProvider, runAgentHookCommand } from '../src/agent-hook-command.js'

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
})
