import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { runAgentHookCommand } from '../src/agent-hook-command.js'
import type { AgentExecutorId, AgentProviderId } from '../src/types.js'

// ---------------------------------------------------------------------------
// usage 这条链上最细的那一根线：**Core 从 catalog 读出 transcript 格式并注入 hook 进程环境**
// （`client.ts` 的 `agentEnvironment` → `AGENTMUX_USAGE_TRANSCRIPT_FORMAT`）。
//
// 断掉它，整条链静默失效：hook 进程的 `resolveUsageCapability` 恒返回 null，于是连一次尾部读都不做，
// 收尾事件永远不带用量，会话里 `turnUsage` 永远缺席，名册上 claude/codex 全变成「还没有一 turn」。
// 而实测（把注入那行改成 `false && usage ? ... : {}`）：**usage 三个测试文件 27 条全绿**——
// 因为 hook 命令测试全部自己 `vi.stubEnv` 那个变量，从没有人证明 Core 真的会注入它。
// 判定与抽取各有人守、接线无人守，是本仓反复出现的同一形状（见 #100 名册那次）。
//
// 所以这一组的纪律是：**中间不留手抄字面量**。测试不自己 stub 那个变量，而是把 `agentEnvironment`
// 真正产出的整份环境喂给 `runAgentHookCommand`。Core 注入什么，hook 进程就读到什么；键名改了、值错了、
// 整段没了，这里都对不上。声明侧（catalog）与消费侧（hook 子进程）由此被绑成一件事。
// ---------------------------------------------------------------------------

/** claude transcript 的真实记录形状（`message.usage` 带 snake_case 字段）。 */
const CLAUDE_TRANSCRIPT =
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', usage: { input_tokens: 2, output_tokens: 5 } }
  }) + '\n'

/** codex rollout 的真实记录形状（`event_msg` + `payload.type:'token_count'` + `last_token_usage`）。 */
const CODEX_ROLLOUT =
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 999999, output_tokens: 888888, total_tokens: 1888887 },
        last_token_usage: { input_tokens: 61008, output_tokens: 3381, total_tokens: 64389 }
      }
    }
  }) + '\n'

type ClientInternals = {
  agentEnvironment(
    environment: Readonly<Record<string, string>>,
    agentSessionId: string,
    providerId: AgentProviderId,
    executorId: AgentExecutorId,
    binding: { bindingId: string; endpoint: { url: string; port: number; token: string } },
    lifecycleOperationId: string,
    capability: string
  ): Record<string, string>
}

/**
 * 让 Client 为某个 Provider 组装一次真实的 Agent 启动环境。
 *
 * 走的是生产那一个方法，不重述它的内容——注入什么由 catalog 与 `agentEnvironment` 说了算。
 */
function spawnEnvironmentFor(client: AgentMuxClient, providerId: AgentProviderId): Record<string, string> {
  return (client as unknown as ClientInternals).agentEnvironment(
    {},
    `sess-${providerId}`,
    providerId,
    providerId as unknown as AgentExecutorId,
    {
      bindingId: `binding-${providerId}`,
      // hook 进程的 POST 目标也来自这份环境——它同样是被注入的，不是测试硬塞的。
      endpoint: { url: 'http://127.0.0.1:65535/hook', port: 65535, token: `token-${providerId}` }
    },
    `op-${providerId}`,
    `capability-${providerId}`
  )
}

describe('catalog → hook 环境的 usage 格式注入', () => {
  const registry = new AgentProviderRegistry()

  async function withClient<T>(run: (client: AgentMuxClient) => Promise<T> | T): Promise<T> {
    const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
    try {
      return await run(client)
    } finally {
      await client.dispose()
    }
  }

  it('声明了 usage 的 Provider 各自拿到自己那份格式，未声明的一个变量都不带', async () => {
    await withClient((client) => {
      // 期望值不手抄：逐个 Provider 拿 catalog 里的声明去比对被注入的环境。
      const declaring = registry.list().filter((provider) => provider.catalog.capabilities.usage)
      // 空集取胜的挡板：至少得有 Provider 声明了 usage，否则下面这个循环一条都不跑。
      expect(declaring.length).toBeGreaterThan(0)
      for (const provider of declaring) {
        const env = spawnEnvironmentFor(client, provider.id)
        expect(
          env.AGENTMUX_USAGE_TRANSCRIPT_FORMAT,
          `${provider.id} 声明了 usage，环境里必须带它自己的格式`
        ).toBe(provider.catalog.capabilities.usage!.transcriptFormat)
      }

      const silent = registry.list().filter((provider) => !provider.catalog.capabilities.usage)
      expect(silent.length).toBeGreaterThan(0)
      for (const provider of silent) {
        const env = spawnEnvironmentFor(client, provider.id)
        // 未声明就**整个键缺席**，不是空串——hook 进程因此对它们连一次尾部读都不做。
        expect(
          Object.prototype.hasOwnProperty.call(env, 'AGENTMUX_USAGE_TRANSCRIPT_FORMAT'),
          `${provider.id} 未声明 usage，环境里绝不该出现这个变量`
        ).toBe(false)
      }
    })
  })

  it('注入的每个格式值都是 hook 进程认得的那两种之一（值域两侧同源）', async () => {
    // 注入侧写出一个 hook 进程不认识的值，等于静默失效：`resolveUsageCapability` 只放行这两个字面量。
    await withClient((client) => {
      for (const provider of registry.list()) {
        const format = spawnEnvironmentFor(client, provider.id).AGENTMUX_USAGE_TRANSCRIPT_FORMAT
        if (format === undefined) continue
        expect(['claude-jsonl', 'codex-rollout'], `${provider.id} 注入了 hook 进程不认识的格式`)
          .toContain(format)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// 端到端那一半：hook 子进程跑在 Core 真正交给它的那份环境里。
// 这里**不 stub `AGENTMUX_USAGE_TRANSCRIPT_FORMAT`**——它只可能来自上面那次注入。
// ---------------------------------------------------------------------------

describe('hook 子进程跑在 Core 注入的环境里，用量才真的到得了 POST', () => {
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

  /**
   * 把 Core 为某个 Provider 组装的环境**整份**装进 process.env，然后跑 hook 子进程。
   *
   * 整份装是关键：不挑键，于是「Core 换了键名」「Core 不再注入」都会让 hook 进程读不到，而不是被
   * 测试自己 stub 的那份值悄悄补上。事件名只从 stdin 负载给（三个环境来源先清空），因为收尾事件的
   * 判定与用量抽取要一起被这条路径覆盖。
   */
  async function runHookInInjectedEnvironment(
    providerId: AgentProviderId,
    transcriptContent: string
  ): Promise<Record<string, unknown>> {
    const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-usage-env-'))
    try {
      const env = spawnEnvironmentFor(client, providerId)
      // 事件名只许从 stdin 来：三个环境来源一律清空，免得外部 env 顶掉负载里的拼法。
      for (const key of ['AGENTMUX_HOOK_EVENT', 'HOOK_EVENT_NAME', 'AGENTMUX_ANTIGRAVITY_EVENT']) {
        vi.stubEnv(key, '')
      }
      // 先把格式变量清空，再整份铺上 Core 注入的环境：Core 不注入时它就保持空，等于「没声明」。
      // 若这里改成直接 stub 一个格式值，这条测试就退化成又一次自证。
      vi.stubEnv('AGENTMUX_USAGE_TRANSCRIPT_FORMAT', '')
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)

      const transcriptPath = join(dir, 'transcript.jsonl')
      await writeFile(transcriptPath, transcriptContent)
      const { bodies } = captureHookPost()
      feedStdin(JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess', transcript_path: transcriptPath }))

      await runAgentHookCommand()

      // POST 真发出去了才谈得上里面有没有用量——URL 与 token 也来自那份注入的环境。
      expect(bodies).toHaveLength(1)
      return bodies[0]!.payload as Record<string, unknown>
    } finally {
      await rm(dir, { recursive: true, force: true })
      await client.dispose()
    }
  }

  afterEach(() => {
    restoreStdin?.()
    restoreStdin = null
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('claude：Core 注入的格式让子进程真的抽出那一 turn 的用量', async () => {
    const payload = await runHookInInjectedEnvironment('claude', CLAUDE_TRANSCRIPT)
    // 分子逐字来自 transcript（2/5/7）。注入断了 → 子进程不读 transcript → 这里没有 agentmuxUsage。
    expect(payload.agentmuxUsage).toMatchObject({ inputTokens: 2, outputTokens: 5, totalTokens: 7 })
  })

  it('codex：注入的是 codex 自己的格式，抽到的是 last_token_usage 而非会话累计', async () => {
    const payload = await runHookInInjectedEnvironment('codex', CODEX_ROLLOUT)
    // 若注入给所有 Provider 一个常量 'claude-jsonl'，claude 解析器在 rollout 里找不到 message.usage，
    // 这条就红。会话累计（999999/888888）出现也红——那是抽错字段。
    expect(payload.agentmuxUsage).toMatchObject({
      inputTokens: 61008,
      outputTokens: 3381,
      totalTokens: 64389
    })
  })

  it('未声明 usage 的 Provider：transcript 就在眼前也一个字都不抽', async () => {
    // 同一份有真实用量的 transcript，换成一个没声明 usage 的 Provider——环境里没有格式变量，
    // 子进程连读都不读。这守的是「未接入的 Provider 不因此留下 0 或误导性数字」那一侧的源头。
    const registry = new AgentProviderRegistry()
    const silent = registry.list().find((provider) => !provider.catalog.capabilities.usage)
    expect(silent, '必须存在一个未声明 usage 的 Provider 才谈得上守这一侧').toBeDefined()
    const payload = await runHookInInjectedEnvironment(silent!.id, CLAUDE_TRANSCRIPT)
    expect(payload).not.toHaveProperty('agentmuxUsage')
  })

  it('格式真的路由了解析器：claude 的环境配 codex 的 transcript 抽不出东西', async () => {
    // 两个格式若被折成同一个解析器（或注入了错的那个），上面两条各自仍可能绿——它们各自的 transcript
    // 恰好配对。这条把配对拆开：claude 解析器在 codex rollout 里找不到 message.usage，必须是缺席。
    const payload = await runHookInInjectedEnvironment('claude', CODEX_ROLLOUT)
    expect(payload).not.toHaveProperty('agentmuxUsage')
  })
})
