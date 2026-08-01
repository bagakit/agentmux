import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AgentProviderRegistry,
  defineAgentProvider,
  resolveManagedHookPlan,
  type AgentProvider
} from '../src/agent-provider.js'
import { createCodexProvider } from '../src/providers/index.js'
import { AgentMuxError } from '../src/errors.js'
import { BUILT_IN_AGENT_PROVIDER_IDS } from '../src/types.js'

function resumeContext(provider: AgentProvider) {
  return {
    workspacePath: '/tmp/agentmux-provider-conformance',
    nativeHandle: {
      kind: 'provider' as const,
      providerId: provider.id,
      sessionId: `native-${provider.id}`,
      transcriptPath: `/tmp/agentmux-provider-conformance/${provider.id}.jsonl`
    },
    args: [] as string[],
    env: {}
  }
}

describe('built-in Provider conformance', () => {
  const registry = new AgentProviderRegistry()
  const providers = registry.list()

  it('enumerates a non-empty registry with one module-backed implementation per id', () => {
    expect(providers.length).toBeGreaterThan(0)
    expect(new Set(providers.map((provider) => provider.id)).size).toBe(providers.length)
    for (const provider of providers) {
      expect(provider.catalog.id).toBe(provider.id)
      expect(provider.catalog.label).toBe(provider.label)
      expect(provider.catalog.executable).toBe(provider.executable)
      expect(provider.catalog.readySignal).toEqual({
        kind: 'foreground-process',
        expectedProcess: provider.catalog.expectedProcess
      })
    }
  })

  it('keeps capability declarations consistent with hook strategy and managed installation', () => {
    const endpoint = { url: 'http://127.0.0.1:59999/v1/events', token: 'conformance-token' }
    for (const provider of providers) {
      const { capabilities, hookStrategy } = provider.catalog
      // endpoint 一律给足：需要它的 Provider（写投递代码进文件的那类）才产得出 plan，不需要的
      // 会忽略它。缺席行为由下面单独一条守——两侧都要钉，只钉一侧会让「永远不装」也能过。
      const managedPlan = resolveManagedHookPlan(
        provider.id,
        '/tmp/agentmux-provider-conformance',
        { HERMES_HOME: '/tmp/agentmux-provider-conformance/hermes' },
        endpoint
      )

      // `hookStrategy.kind` is the SINGLE source of "does this provider emit native hooks". It used to
      // be mirrored by a `capabilities.hookEvents` boolean that nothing read (the real consumers —
      // client.ts, doctor.ts, hook-normalizer.ts — all branch on `hookStrategy.kind`), so the boolean
      // was pure drift surface and is gone. This asserts the surviving source stays wired to behavior:
      // a native strategy must produce a managed plan (when explicit-managed) and a `none` strategy must
      // produce no plan and no hook-derived timeline/permission.
      if (hookStrategy.kind === 'none') {
        expect(managedPlan).toBeNull()
        expect(capabilities.timeline).toBe('unavailable')
        expect(capabilities.permission).toBe('none')
      } else if (hookStrategy.installation === 'explicit-managed') {
        expect(managedPlan?.providerId).toBe(provider.id)
        expect(managedPlan?.mutations.length).toBeGreaterThan(0)
      } else {
        expect(managedPlan).toBeNull()
      }
    }
  })

  /**
   * endpoint 缺席时（修复路径没有 Binding）每个 explicit-managed Provider 必须二选一，且必须是**同一个**
   * 选择的两侧都成立：要么照常产出一份不含 endpoint 的 plan（写命令的九家——命令在运行时自己读环境变量），
   * 要么如实弃权返回 null（写投递代码的那类——内联死 token 比不装更坏）。
   *
   * 为什么单独守：上面那条给足 endpoint，所以一个「无论如何都返回 null」的 resolver 会在那里假绿。
   * 这里反过来钉住缺席一侧，两条合起来才说明这个维度被真正实现了，而不是被忽略。
   */
  it('endpoint 缺席时，explicit-managed 的每一家要么照常产出 plan、要么如实弃权', () => {
    for (const provider of providers) {
      const { hookStrategy } = provider.catalog
      if (hookStrategy.kind !== 'native' || hookStrategy.installation !== 'explicit-managed') continue
      const withoutEndpoint = resolveManagedHookPlan(
        provider.id,
        '/tmp/agentmux-provider-conformance',
        { HERMES_HOME: '/tmp/agentmux-provider-conformance/hermes' }
      )
      if (withoutEndpoint === null) continue
      // 产出了就必须是完整可装的——不允许「产出一份空 plan」这种中间态。
      expect(withoutEndpoint.providerId).toBe(provider.id)
      expect(withoutEndpoint.mutations.length).toBeGreaterThan(0)
      // 且绝不能把一个 endpoint 占位符写进内容里：那正是弃权要避免的死 token。
      for (const mutation of withoutEndpoint.mutations) {
        expect(mutation.content).not.toContain('undefined')
      }
    }
  })

  // AgentCapabilities は "each field describes an axis Core actually branches on". Two booleans used to
  // live here — `hookEvents` and `acp` — that nothing read: their real twins are `hookStrategy.kind` and
  // `acpStrategy.kind`, which client.ts/doctor.ts/hook-normalizer.ts branch on. A per-provider boolean
  // that only ever restates another declared field is drift surface: 12 hand-written copies that a new
  // provider can silently get wrong. They are deleted.
  //
  // This guard bites the mutation "re-add a zero-consumer descriptor field": it freezes the capability
  // key-set to a written literal (NOT derived from the object under test — that would drift along with
  // the mutation). Re-introducing `hookEvents`/`acp`, or any other describe-only boolean, adds a key and
  // turns this red, forcing the author to either wire a real consumer or keep it out.
  it('AgentCapabilities exposes exactly the axes with a runtime consumer — no re-added mirror fields', () => {
    // Anchored literal. `terminal` and `replyCorrelation` are intentionally kept even though today only
    // structural consumers touch them; the point of the freeze is that ADDING a key is a deliberate act
    // that updates this line, so a silently re-added `hookEvents`/`acp` mirror cannot slip back in.
    const EXPECTED_CAPABILITY_KEYS = [
      'permission', 'providerResume', 'replyCorrelation', 'terminal', 'timeline', 'usage'
    ]
    for (const provider of providers) {
      // `usage` is optional, so union it in before comparing: a provider that omits it still must not
      // introduce any key outside the frozen set.
      const keys = new Set(Object.keys(provider.catalog.capabilities))
      keys.add('usage')
      expect([...keys].sort()).toEqual(EXPECTED_CAPABILITY_KEYS)
    }
  })

  it('keeps providerResume capability and the actual resume method aligned', () => {
    for (const provider of providers) {
      const { capabilities, resumeStrategy } = provider.catalog
      expect(capabilities.providerResume).toBe(resumeStrategy.kind === 'provider-native')

      if (resumeStrategy.kind === 'none') {
        expect(() => provider.buildResumeLaunch(resumeContext(provider))).toThrow(/does not support provider-native resume/)
      } else {
        const launch = provider.buildResumeLaunch(resumeContext(provider))
        expect(launch.command).toBe(provider.executable)
        expect(launch.args.length).toBeGreaterThan(0)
        expect(launch.env).toEqual({})
      }
    }
  })

  it('projects the same declared capabilities from probing and catalog enumeration', async () => {
    for (const provider of providers) {
      const probed = await provider.probeCapabilities({ async hasExecutable() { return true } })
      expect(probed).toMatchObject({
        providerId: provider.id,
        executable: provider.executable,
        installed: true,
        capabilities: provider.catalog.capabilities
      })
    }
  })
})

// ---------------------------------------------------------------------------
// 内置 Provider 的 id 集合有三个各自独立的真实来源，此前无人守它们不漂移：
//   1. **union** —— `BUILT_IN_AGENT_PROVIDER_IDS`（types.ts），一等 built-in 的类型层清单；
//   2. **模块** —— `src/providers/*.ts` 里真实存在、且真的产出一个 Provider 的工厂文件；
//   3. **注册** —— `BUILT_IN_AGENT_PROVIDERS`（agent-provider.ts）里真正被组装进注册表的 id。
//
// 这三者可以悄悄分家而不发红：union 里加个 id 却忘了写模块、写了模块却忘了加进 composition、
// 或反过来。下面这组守卫把三方物化成集合逐一相等；任一方少一个/多一个都立刻红。
//
// 为什么必须让 union 有运行时投影：`AgentProviderId` 会拓宽成 `string`，纯类型 union 在运行时
// 无迹可寻，从 union 删一家既不编译报错也无从断言。types.ts 已按 RISK_TIERS 的先例把它物化成
// 元组，这里才拿得到那个「值」。
// ---------------------------------------------------------------------------

/** 只认「以 create 开头、Provider 结尾」的具名工厂导出——不硬编码任何文件名或 id 清单。 */
const PROVIDER_FACTORY_RE = /^create[A-Z][A-Za-z0-9]*Provider$/

/**
 * 扫 `src/providers/` 目录，动态载入每个 `.ts` 模块，把「恰好导出一个 Provider 工厂、且该工厂
 * 真的产出一个带 id 的 Provider」的文件收进来，返回 { 文件名 → 产出的 id }。
 *
 * 排除非-provider 文件（shared.ts / index.ts）用的是**结构判据而非硬编码名单**：
 *   - shared.ts 一个 `create*Provider` 都不导出 → 被 count===1 挡掉；
 *   - index.ts 导出 12 个（re-export + composition）→ 同样被 count===1 挡掉。
 * 判据是「这个文件自己定义了唯一一个能产出 Provider 的工厂吗」。下次谁再往目录里丢一个新的
 * 辅助文件（0 个工厂）或又一个 barrel（多个工厂），它都会被同一条结构规则自动排除，而不会像
 * 硬编码 exclude 名单那样在加文件时静默失效——那正是本守卫要避免的失明点。
 */
async function scanProviderModules(): Promise<Map<string, string>> {
  const dirUrl = new URL('../src/providers/', import.meta.url)
  const files = readdirSync(fileURLToPath(dirUrl))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
  const produced = new Map<string, string>()
  for (const file of files) {
    const mod = (await import(new URL(file, dirUrl).href)) as Record<string, unknown>
    const factories = Object.keys(mod).filter(
      (key) => PROVIDER_FACTORY_RE.test(key) && typeof mod[key] === 'function'
    )
    if (factories.length !== 1) continue
    const factory = mod[factories[0] as string] as (define: typeof defineAgentProvider) => AgentProvider
    produced.set(file, factory(defineAgentProvider).id)
  }
  return produced
}

describe('built-in provider id 三方一致性', () => {
  it('扫到的 provider 模块数量合理，绝不空集取胜', async () => {
    // 挡板：如果 scanProviderModules 因为扫描根写错（指向不存在的目录、或过滤条件把所有文件都
    // 排除）而得出空集，下面「集合相等」在两边都空时会假绿。所以先钉住数量下界。
    const modules = await scanProviderModules()
    expect(modules.size).toBeGreaterThanOrEqual(12)
    // union 与注册表也各自非空，同理防止任一来源塌成空集后彼此「相等」。
    expect(BUILT_IN_AGENT_PROVIDER_IDS.length).toBeGreaterThanOrEqual(12)
    expect(new AgentProviderRegistry().list().length).toBeGreaterThanOrEqual(12)
  })

  it('union、providers/ 模块、BUILT_IN_AGENT_PROVIDERS 三方 id 集合逐一相等', async () => {
    // 三个集合都从各自的真实来源现算，没有一处手抄字面清单——手抄的那份会和它要守的东西一起漂。
    const unionIds = [...BUILT_IN_AGENT_PROVIDER_IDS].sort()
    const moduleIds = [...(await scanProviderModules()).values()].sort()
    const registeredIds = new AgentProviderRegistry().list().map((provider) => provider.id).sort()

    // 模块目录里不能有重复 id（两个文件产出同一个 id 也是一种漂移）。
    expect(new Set(moduleIds).size).toBe(moduleIds.length)
    // 三方两两相等 ⇒ 三者互等。任一方多/少一个 id 都会让这两条之一发红。
    expect(moduleIds).toEqual(unionIds)
    expect(registeredIds).toEqual(unionIds)
  })
})

describe('注册表遇到重复 id 时 fail-closed', () => {
  it('重复 id 的 composition 抛 DUPLICATE_PROVIDER——行为测试，不是源码扫描', () => {
    // 真的构造一个含重复 id 的 provider 列表喂给注册表，断言它抛且错误码正确。
    // 这条 fail-closed 路径此前完全没有测试：把 register() 里那次 `has(id)` 检查删掉，
    // 后注册的会静默覆盖前一个（Map.set），这条就变红。
    const codex = createCodexProvider(defineAgentProvider)
    let thrown: unknown
    try {
      new AgentProviderRegistry([codex, codex])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentMuxError)
    expect((thrown as AgentMuxError).code).toBe('DUPLICATE_PROVIDER')
    // 报文里带上冲突的那个 id，排障时认得出是谁。
    expect((thrown as AgentMuxError).message).toContain('codex')
  })

  it('公开的 register() 也守同一条边界，不只是构造函数', () => {
    // 构造函数与 register() 走的是同一个方法，但 register 是公开 API，单独钉一遍它，
    // 免得有人把重复检查挪进构造函数专属分支后这条边界在公开路径上失守。
    const registry = new AgentProviderRegistry()
    expect(() => registry.register(createCodexProvider(defineAgentProvider)))
      .toThrowError(/DUPLICATE_PROVIDER|already registered/)
  })
})
