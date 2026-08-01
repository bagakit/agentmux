import { Readable } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry, resolveManagedHookPlan } from '../src/agent-provider.js'
import { runAgentHookCommand } from '../src/agent-hook-command.js'
import { HOOK_EVENT_NAME_PAYLOAD_KEYS } from '../src/agent-hook-event.js'

/**
 * 审计发现 D 的守卫：**一家 Provider 既不带 `--event`、也不注入 env、其负载又不带事件名键** 这个组合
 * 必须响亮失败，而不是让整条 POST 被 `agent-hook-command.ts` 的 `if (url && token && eventName)` 静默
 * 跳过（Agent「装上了但永远不动」，且所有测试照旧全绿——copilot 正是这么漏的）。
 *
 * 这里守两条**互相独立**的面（本仓「两个拼法面」教训：配置侧 ≠ 投递侧，各自绿仍可能装了不认/认了没装）：
 *
 *   1. **声明面（静态）**：每个由 AgentMux 亲手写配置的原生 Provider（`explicit-managed`）都必须声明
 *      `eventNameSource`，且这份声明与它的**安装计划**一致——声明 `flag` 就必须每条 hook 命令都真的带
 *      `--event <eventName>`；声明 `payload` 的键必须是三拼法之一。漏声明、或声明与配置不符，都红。
 *      判据落在「安装计划里命令的实际形状」，不是「源码里出现过 --event 这个字符串」。
 *
 *   2. **投递面（行为，端到端）**：把每个 Provider 在生产里真会收到的信封喂进 `runAgentHookCommand`
 *      子进程——`flag` provider 走 argv 的 `--event`（生产真路）、`payload` provider 把事件名放进它声明
 *      的那个负载键、且**不给** flag/env——断言 POST 真的发出去了。这条钉住「声明的那条通路（旗标 /
 *      负载）在子进程里真的是活的」：把子进程读负载事件名那行改成 null，7 个 payload provider 立刻全红；
 *      copilot 那种「三条来源全落空」的形状则由下面的反证用例直接钉住「静默丢 POST」。它不看源码文本，
 *      只看「POST 到底发没发」。
 *
 * **两族投递面，别只模一族。** 上面两条描述的是**命令面**：Provider 装的是一条命令，`agent-hook-command`
 * 那个子进程从 argv 或负载里解析事件名。还有**代码面**：pi 与 opencode 装的是一份 AgentMux 生成的 JS
 * （`extensions/agentmux.js` / `plugin/agentmux.js`），代码跑在 Provider 自己的进程里**自己直接 POST**，
 * 子进程整个不在链路上。对它们，`commandsFromPlan` 连 JSON.parse 都过不去（实测抛 SyntaxError），把信封
 * 喂给 `runAgentHookCommand` 也只是在测一条它们不走的路。所以代码面有自己的判据：断言生成的源码里**每个**
 * 注册的事件回调都把事件名送进 POST 体，且那批事件名来自 `rules` 而不是硬编码。
 *
 * 两族必须**并集等于 explicit-managed 全集、交集为空**——否则新接一家既不进命令面也不进代码面时，
 * 它会从两边的 `it.each` 里同时消失、一条断言都不红（本仓「守卫按出口数不按条件数」那族假绿）。
 */

const registry = new AgentProviderRegistry()

const HOOK_URL = 'http://127.0.0.1:65535/hook'
const HOOK_TOKEN = 'test-token'

/**
 * 一份生成代码的入口形状。**先判形状、再驱动**，两步分开是刻意的：
 * 「认不出入口」必须由调用方断言成失败，而不是由驱动器内部抛（内部抛那行在两家都能认出的今天是
 * 死代码——实测把它换成 `return {}` 无一条转红，等于没人守）。
 */
function generatedCodeEntry(module: GeneratedModule): 'pi-extension' | 'opencode-plugin' | 'unknown' {
  if (typeof module.default === 'function') return 'pi-extension'
  if (typeof module.server === 'function') return 'opencode-plugin'
  return 'unknown'
}

type GeneratedModule = {
  default?: (host: { on: (event: string, handler: Handler) => void }) => unknown
  server?: () => Promise<{ event: (arg: { event: { type: string; properties?: unknown } }) => unknown }>
}

/** 把一份生成代码当模块加载。data: URI 而非落盘，省掉清理与模块缓存。 */
async function loadGeneratedModule(source: string): Promise<GeneratedModule> {
  return (await import(
    `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
  )) as GeneratedModule
}

/**
 * 真的执行一份生成的 hook 代码，逐个触发它注册的事件，收回「事件名 → POST body 里的 eventName」。
 *
 * 两种入口形状都驱动：
 *   - pi：`export default function (pi)`，用 `pi.on(event, handler)` 注册；
 *   - opencode：`export async function server()`，返回 `{ event: async ({event}) => ... }` 单一入口。
 *
 * fetch 用局部 stub、用完还原，不碰全局，避免与本文件另一组的 `vi.stubGlobal` 互相干扰。
 */
async function drivePostsFromGeneratedCode(
  module: GeneratedModule,
  declared: readonly string[]
): Promise<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  const fakeFetch = async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return { ok: true } as Response
  }

  const originalFetch = globalThis.fetch
  const originalEnv = { url: process.env.AGENTMUX_HOOK_URL, token: process.env.AGENTMUX_HOOK_TOKEN }
  globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch
  // pi 的扩展在运行时现读环境变量（token 不落盘），所以这里必须给上，否则它的 post() 直接 return。
  process.env.AGENTMUX_HOOK_URL = HOOK_URL
  process.env.AGENTMUX_HOOK_TOKEN = HOOK_TOKEN
  try {
    const posted: Record<string, unknown> = {}
    const collect = (): void => {
      for (const body of bodies.splice(0)) {
        const name = body.eventName
        // 事件名缺席时**不要**跳过：记成 'undefined' 这个键，让逐事件断言把它报出来。
        posted[typeof name === 'string' ? name : String(name)] = name
      }
    }

    if (typeof module.default === 'function') {
      const handlers = new Map<string, Handler>()
      module.default({ on: (event, handler) => handlers.set(event, handler) })
      for (const event of declared) {
        const handler = handlers.get(event)
        // 注册缺失是被守的缺陷之一：不抛，留空让断言报「少了哪个事件」。
        if (!handler) continue
        await handler(syntheticEvent(event), syntheticContext())
        collect()
      }
      return posted
    }

    const hooks = await module.server!()
    for (const event of declared) {
      await hooks.event({ event: { type: event, properties: {} } })
      collect()
    }
    return posted
  } finally {
    globalThis.fetch = originalFetch
    process.env.AGENTMUX_HOOK_URL = originalEnv.url
    process.env.AGENTMUX_HOOK_TOKEN = originalEnv.token
  }
}

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown

/** 一个足够宽的事件对象：生成代码会读 toolName/input 之类的字段，缺了不该让驱动本身炸。 */
function syntheticEvent(type: string): Record<string, unknown> {
  return { type, prompt: 'p', toolName: 'bash', input: {}, args: {}, properties: {} }
}

/** pi 的 handler 第二个参数是 ctx，扩展从它取 session 字段。给一个不含 transcript 的最小实现。 */
function syntheticContext(): Record<string, unknown> {
  return { sessionId: 'sess-1', session: { id: 'sess-1' } }
}

/** 从一份安装计划里，抽出每条 hook 命令字符串（跨各 Provider 的不同文件结构）。 */
function commandsFromPlan(content: string): string[] {
  const parsed = JSON.parse(content) as unknown
  const commands: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'command' && typeof value === 'string') commands.push(value)
        else walk(value)
      }
    }
  }
  walk(parsed)
  return commands
}

describe('每个 explicit-managed 原生 Provider 都声明了事件名来源，且声明与安装计划一致', () => {
  const managed = registry.list().filter(
    (provider) =>
      provider.catalog.hookStrategy.kind === 'native' &&
      provider.catalog.hookStrategy.installation === 'explicit-managed'
  )
  /** 命令面：装的是一条命令，事件名由 `agent-hook-command` 子进程从 argv 或负载里解析。 */
  const commandFamily = managed.filter((provider) => provider.hook.eventNameSource?.kind !== 'generated-code')
  /** 代码面：装的是 AgentMux 生成的 JS，代码自己 POST，子进程不在链路上。 */
  const codeFamily = managed.filter((provider) => provider.hook.eventNameSource?.kind === 'generated-code')

  it('挡板：确实枚举到了一批 explicit-managed Provider（绝不空集取胜）', () => {
    // 若过滤条件写错导致空集，下面的 it.each 一个都不跑、整组静默通过。先钉住数量下界。
    expect(managed.length).toBeGreaterThanOrEqual(8)
  })

  it('两族分完刚好是全集，且没有 Provider 同时进两族', () => {
    // 少了这一条，新接一家 Provider 若两族的判据都不适用（比如换了第三种投递形状），它会从两边的
    // it.each 里**同时消失**——一条断言都不红，正是本仓「守卫按出口数不按条件数」那族假绿。
    const ids = (list: typeof managed) => list.map((provider) => provider.id).sort()
    expect([...ids(commandFamily), ...ids(codeFamily)].sort(), '两族并集必须等于 explicit-managed 全集')
      .toEqual(ids(managed))
    expect(
      ids(commandFamily).filter((id) => ids(codeFamily).includes(id)),
      '两族必须互斥：同一个 Provider 不能既走子进程解析又走生成代码直送'
    ).toEqual([])
    // 两族都必须非空，否则「分流」退化成一族，另一族的判据成了永不执行的死代码。
    expect(commandFamily.length, '命令面不该为空').toBeGreaterThan(0)
    expect(codeFamily.length, '代码面不该为空（pi/opencode 在这一族）').toBeGreaterThan(0)
  })

  it.each(commandFamily.map((provider) => [provider.id, provider] as const))(
    '%s 的 eventNameSource 有声明且与安装计划相符',
    (providerId, provider) => {
      const source = provider.hook.eventNameSource
      // 缺声明就是本 task 要挡的漏配：AgentMux 亲手写它的配置，却没人保证子进程解析得出事件名。
      expect(source, `${providerId} 是 explicit-managed，必须声明 eventNameSource`).toBeDefined()

      const plan = resolveManagedHookPlan(providerId, '/repo/app', { HERMES_HOME: '/tmp/hermes' })
      expect(plan, `${providerId} 应有安装计划`).not.toBeNull()
      const commands = plan!.mutations.flatMap((mutation) => commandsFromPlan(mutation.content))
      expect(commands.length, `${providerId} 的安装计划里应有 hook 命令`).toBeGreaterThan(0)

      if (source!.kind === 'flag') {
        // 声明 flag ⇒ 每条命令都必须真的带 `--event <非空>`。少一条都意味着那个事件到子进程解析不出
        // 事件名、整条 POST 被丢——把某条命令的 `--event x` 删掉，这条就红。
        for (const command of commands) {
          expect(command, `${providerId} 声明 flag，命令必须带 --event：${command}`)
            .toMatch(/--event\s+\S+/)
        }
      } else if (source!.kind === 'payload') {
        // 声明 payload ⇒ 键必须是三拼法之一（子进程只认这三个）。写一个子进程不认的键，这条红。
        expect(
          HOOK_EVENT_NAME_PAYLOAD_KEYS as readonly string[],
          `${providerId} 的 payloadKey 必须是子进程认得的三拼法之一`
        ).toContain(source!.payloadKey)
      } else {
        // 上面的分流保证 generated-code 不会落到这里；真落到了说明分流写坏了。
        expect.unreachable(`${providerId} 是 generated-code，不该出现在命令面`)
      }
    }
  )

  it.each(codeFamily.map((provider) => [provider.id, provider] as const))(
    '%s 装的生成代码里，每个声明的事件都真的带着事件名 POST',
    async (providerId, provider) => {
      // 代码面的判据不能是「源码里出现过 eventName 这个词」——那种文本断言对「回调注册了但没接上
      // post」完全失明（本仓「grep 守卫看不见早退」）。这里**真的执行**生成的代码：把它当模块加载、
      // stub 掉 fetch、逐个触发它注册的事件，再断言每个事件都发出了一条 body.eventName 等于该事件名
      // 的 POST。
      //
      // 于是这条会在下列每一种真实缺陷上红（没有一种是文本看得见的）：
      //   - 某个回调忘了调 post ⇒ 那个事件没有 POST；
      //   - post 的 body 漏了 eventName ⇒ 值是 undefined；
      //   - 注册 A 却上报 B ⇒ 值对不上；
      //   - rules 声明了某事件而生成代码根本没注册它 ⇒ 那个事件收不到 POST。
      const declared = [...new Set(provider.hook.rules.flatMap((rule) => rule.events))].sort()
      expect(declared.length, `${providerId} 应至少声明一个事件`).toBeGreaterThan(0)

      const plan = resolveManagedHookPlan(
        providerId,
        '/repo/app',
        { AGENTMUX_HOOK_URL: HOOK_URL, AGENTMUX_HOOK_TOKEN: HOOK_TOKEN },
        { url: HOOK_URL, token: HOOK_TOKEN }
      )
      expect(plan, `${providerId} 应有安装计划`).not.toBeNull()
      expect(plan!.mutations.length, `${providerId} 只写它自己那一份代码文件`).toBe(1)

      const module = await loadGeneratedModule(plan!.mutations[0]!.content)
      // 入口形状由**调用方**断言，不由驱动器内部抛：驱动器里那种 throw 在两家都认得出的今天是死代码，
      // 换成静默 `return {}` 一条都不红（实测）。摆到这里它就是一条会红的活断言——改坏 pi 的
      // `export default` 或 opencode 的 `export function server`，这条立刻指名道姓。
      expect(
        generatedCodeEntry(module),
        `${providerId} 的生成代码必须有可驱动的入口（pi 走 default 导出、opencode 走 server 导出）`
      ).not.toBe('unknown')

      const posted = await drivePostsFromGeneratedCode(module, declared)

      expect(
        Object.keys(posted).sort(),
        `${providerId}: rules 声明的事件必须逐个都触发带事件名的 POST——少了的那些在生成代码里没接上`
      ).toEqual(declared)
      for (const event of declared) {
        expect(posted[event], `${providerId} 的 ${event} 上报的事件名必须是它自己`).toBe(event)
      }
    }
  )

  /**
   * 每家上游**实际**发的那个拼法，锚成字面量。
   *
   * 为什么这条不能省：子进程对三拼法同权兜底，所以把某家的 payloadKey 换成另一个合法拼法，运行时照旧
   * 能跑、投递面照旧全绿（实测：hermes 从 hook_event_name 改成 eventName，20 条无一转红）。也就是说这个
   * 声明可以填成**错的知识**而无人察觉——而它的用途恰恰只是记录我们对上游行为的经验事实，供上游改拼法
   * 时有人知道该去核哪一条。一个没有消费者的纯描述字段，等于那条轴上的谎言免检。
   *
   * 期望值必须独立于被测对象：投递面是把事件名放进 `source.payloadKey` 再断言 POST 发出，期望值由被测
   * 声明自己算出，所以它跟着变异一起漂、恒真。故这里锚成字面量；每一项的来源标注在对应 provider 文件头。
   */
  const OBSERVED_PAYLOAD_KEY: Readonly<Record<string, string>> = {
    claude: 'hook_event_name',
    codex: 'hook_event_name',
    droid: 'hook_event_name',
    gemini: 'hook_event_name',
    hermes: 'hook_event_name',
    // grok 只有投递侧是 camelCase；配置侧是 PascalCase，两个拼法面刻意分开，见 grok.ts。
    grok: 'hookEventName'
  }

  it('payload 来源的声明与上游实际发的拼法逐家对上', () => {
    const payloadProviders = managed.filter((provider) => provider.hook.eventNameSource?.kind === 'payload')
    // 表与被守集合必须同集：新增一家 payload provider 却忘了记它实际的拼法，这条红；表里留着已删的
    // provider 也红。少了这一侧，下面的循环会静默跳过没记录的那家。
    expect(
      payloadProviders.map((provider) => provider.id).sort(),
      'OBSERVED_PAYLOAD_KEY 必须与被守的 explicit-managed payload Provider 同集'
    ).toEqual(Object.keys(OBSERVED_PAYLOAD_KEY).sort())
    for (const provider of payloadProviders) {
      const source = provider.hook.eventNameSource!
      expect(
        source.kind === 'payload' ? source.payloadKey : null,
        `${provider.id} 声明的 payloadKey 必须是上游实际发的那一个（子进程三拼法同权，填错了没有任何运行时症状）`
      ).toBe(OBSERVED_PAYLOAD_KEY[provider.id])
    }
  })

  /**
   * unmanaged 的原生 Provider 也可以声明 eventNameSource，但本文件每一条判据都只枚举
   * explicit-managed——AgentMux 不写它们的配置，没有安装计划可比对，也没有「我们亲手配错了」这个失败
   * 模式。于是那些声明**免检**：kimi 现在就有一条 payload/hook_event_name，谁把它改成别的拼法都不会红。
   *
   * 这条守卫不去假装能验它（拿什么验？我们不产出它的配置），而是把这个边界本身钉住：让「哪些 Provider
   * 的声明有人守、哪些没有」成为一个显式、会红的事实，而不是读者要自己从过滤条件里推出来的沉默前提。
   * 若日后 kimi 转成 explicit-managed，它就会落进上面的同集检查里、逼人补上实测拼法——那正是我们想要的
   * 提醒时刻。
   */
  it('unmanaged Provider 的事件名声明免检，这个边界是显式的', () => {
    const unmanagedWithDeclaration = registry.list()
      .filter((provider) => {
        // 一次判完，别拆成链式 filter：`.filter()` 不给下一个回调做类型收窄，分开写 `installation`
        // 就落在 `{kind:'none'}` 变体上而 tsc 报错（vitest 只转译不查类型，那个错不会让测试变红）。
        const strategy = provider.catalog.hookStrategy
        return strategy.kind === 'native' &&
          strategy.installation !== 'explicit-managed' &&
          Boolean(provider.hook?.eventNameSource)
      })
      .map((provider) => provider.id)
      .sort()
    expect(
      unmanagedWithDeclaration,
      '有 unmanaged Provider 声明了事件名来源却无人守：要么让它进 explicit-managed 从而被上面两面检查，要么把这份清单更新以承认它免检'
    ).toEqual(['kimi'])
  })
})

describe('投递面端到端：按每个 Provider 声明的来源喂信封，POST 必须真的发出', () => {
  let restoreStdin: (() => void) | null = null
  let restoreArgv: (() => void) | null = null

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

  // flag provider 的生产投递路径是 argv 的 `--event`（不是 env）；这里就走那条真路，由子进程的
  // parseEventFromArgv 解析，比塞 env 更贴近实际。
  function feedArgv(eventName: string): void {
    const original = process.argv
    process.argv = [original[0]!, original[1]!, '--event', eventName]
    restoreArgv = () => {
      process.argv = original
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

  afterEach(() => {
    restoreStdin?.()
    restoreStdin = null
    restoreArgv?.()
    restoreArgv = null
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  // 只驱动**命令面**：代码面的 Provider 自己 POST，`runAgentHookCommand` 整个不在它们的链路上，
  // 把信封喂给子进程只是在测一条它们不走的路。它们的投递面由上面那条「真的执行生成代码」负责。
  const subprocessDelivered = registry.list().filter(
    (provider) =>
      provider.catalog.hookStrategy.kind === 'native' &&
      provider.catalog.hookStrategy.installation === 'explicit-managed' &&
      provider.hook.eventNameSource?.kind !== 'generated-code'
  )

  it('挡板：确实枚举到了一批走子进程的 Provider（绝不空集取胜）', () => {
    expect(subprocessDelivered.length).toBeGreaterThanOrEqual(8)
  })

  it.each(subprocessDelivered.map((provider) => [provider.id, provider] as const))(
    '%s：按声明的来源送事件名，子进程解析得出并发 POST',
    async (providerId, provider) => {
      const source = provider.hook.eventNameSource!
      // 用这个 Provider 真会发的一个事件名——从它的 rules 里取第一个，绝不硬编码。
      const eventName = provider.hook.rules[0]?.events[0]
      expect(eventName, `${providerId} 应至少有一条 rule 事件`).toBeTruthy()

      const dir = await mkdtemp(join(tmpdir(), 'agentmux-evtsrc-'))
      try {
        vi.stubEnv('AGENTMUX_HOOK_URL', 'http://127.0.0.1:65535/hook')
        vi.stubEnv('AGENTMUX_HOOK_TOKEN', 'test-token')
        // 关键：默认不给旗标、不给 env。flag provider 才走 argv 的 `--event`（生产真路）；payload
        // provider 一律走负载，两条来源必须分开，任一条都不能借另一条的东风。
        vi.stubEnv('AGENTMUX_HOOK_EVENT', '')
        vi.stubEnv('AGENTMUX_USAGE_TRANSCRIPT_FORMAT', '')

        let payload: Record<string, unknown> = { session_id: 'sess-1' }
        if (source.kind === 'flag') {
          feedArgv(eventName!)
        } else if (source.kind === 'payload') {
          // payload provider：事件名只从负载来（不给 flag/env）。放进它声明的那个键，断言子进程确实能
          // 从**负载**这条通路解析出事件名并发 POST。这条会在「子进程整个不读负载事件名」这类回归上红
          // （实测：把 resolveHookEventName 那行改成 null，7 个 payload provider 全红），从而钉住
          // 「声明 payload 的 Provider，其负载通路真的是活的」。
          // 刻意不拿它去证「拼法必须逐字对上」——子进程三拼法同权，写哪个都能解析，那不是运行时缺陷；
          // 「payloadKey 必须是三拼法之一」由上面的静态面负责，避免用被测对象自己算出的期望值假绿。
          payload = { ...payload, [source.payloadKey]: eventName }
        } else {
          // 上面的过滤保证 generated-code 不进这一组；真进来了说明过滤写坏了，别静默按 payload 处理。
          expect.unreachable(`${providerId} 是 generated-code，不该走子进程投递面`)
        }

        const { bodies } = captureHookPost()
        feedStdin(JSON.stringify(payload))

        await runAgentHookCommand()

        expect(bodies, `${providerId} 的事件必须真的 POST 出去，而不是被静默跳过`).toHaveLength(1)
        expect(bodies[0]!.eventName).toBe(eventName)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it('反证：三条来源全落空（无 flag/env、负载不带任何事件名键）时 POST 被丢——正是 copilot 的原缺陷形状', async () => {
    // 这条钉住「静默丢 POST」这个具体失败，防止有人把上面的断言弱化成「只要没抛异常就算过」。
    // 它是 copilot 修复前的确切运行时链路：url+token 都在，只有 eventName 解析不出。
    vi.stubEnv('AGENTMUX_HOOK_URL', 'http://127.0.0.1:65535/hook')
    vi.stubEnv('AGENTMUX_HOOK_TOKEN', 'test-token')
    vi.stubEnv('AGENTMUX_HOOK_EVENT', '')
    vi.stubEnv('AGENTMUX_USAGE_TRANSCRIPT_FORMAT', '')
    const { bodies } = captureHookPost()
    // Copilot 的真实负载形状：camelCase 键，没有 hook_event_name/hookEventName/eventName 里的任何一个。
    feedStdin(JSON.stringify({ toolName: 'bash', toolArgs: { command: 'ls' }, sessionId: 's-1' }))

    await runAgentHookCommand()

    expect(bodies, '事件名解析不出时，当前实现就是静默跳过整条 POST——这正是本 task 要让 Provider 侧不再触发的缺陷').toHaveLength(0)
  })
})
