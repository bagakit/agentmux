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
    for (const provider of providers) {
      const { capabilities, hookStrategy } = provider.catalog
      const managedPlan = resolveManagedHookPlan(
        provider.id,
        '/tmp/agentmux-provider-conformance',
        { HERMES_HOME: '/tmp/agentmux-provider-conformance/hermes' }
      )

      expect(capabilities.hookEvents).toBe(hookStrategy.kind === 'native')
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
