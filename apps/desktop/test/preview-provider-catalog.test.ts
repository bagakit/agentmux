import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { BUILT_IN_AGENT_PROVIDERS } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api.js'

// 守的缺陷：`api.ts` 的两处 web-preview mock（`config.executors` 与 `providers.list`）此前手抄了一份
// Provider 子集（5 家 / 2 家），内置增到 12 家后静默漂走——grok/gemini/cursor/kimi/droid/copilot 在
// `pnpm dev` 的浏览器预览里根本不出现。修复是让两处 mock 从 `BUILT_IN_AGENT_PROVIDER_IDS` 派生。
//
// 期望值取自**另一处** SSOT——注册表 `BUILT_IN_AGENT_PROVIDERS`（在 providers/index.ts 里独立组合），
// 绝不取 mock 派生所依据的 `BUILT_IN_AGENT_PROVIDER_IDS`：拿后者当期望会和被测对象一起漂，从 id 清单里
// 摘掉一家时两侧同步缩小、测试假绿（实测这是 tautology 陷阱）。注册表是「到底有几家内置 Provider」的
// 权威事实，与 id 清单同步与否正是这道门要暴露的。范式照搬 config-store.test.ts:394（每个内置都要有默认
// Executor），不另起一种风格。
describe('web-preview provider mocks derive from the built-in SSOT', () => {
  const builtInIds = new Set(BUILT_IN_AGENT_PROVIDERS.map((provider) => provider.id))

  // 挡板：若注册表被读成空集，下面的 missing 过滤器一个都不跑，整组会静默通过。先钉数量下界，
  // 让「SSOT 意外为空」这种失明变成响亮的红。12 是当前内置家数；新增只会让它更大，不会打红这条。
  it('sees a non-empty built-in provider set', () => {
    expect(builtInIds.size).toBeGreaterThanOrEqual(12)
  })

  it('config.executors covers every built-in Provider and invents none', async () => {
    const config = await api.config.get()
    const coveredProviderIds = new Set(
      Object.values(config.executors).map((executor) => executor.providerId)
    )
    // 覆盖：每个内置 id 都必须有一条 preview Executor 指向它。从内置集合摘掉一家会让这里变红。
    const missing = [...builtInIds].filter((id) => !coveredProviderIds.has(id))
    expect(missing).toEqual([])
    // 反向：preview 里绝不出现注册表不认识的 providerId。往 mock 里塞一个不存在的 id 会让这里变红。
    const unknown = [...coveredProviderIds].filter((id) => !builtInIds.has(id))
    expect(unknown).toEqual([])
  })

  it('providers.list covers every built-in Provider and invents none', async () => {
    const catalog = await api.providers.list()
    const catalogIds = new Set(catalog.map((entry) => entry.id))
    const missing = [...builtInIds].filter((id) => !catalogIds.has(id))
    expect(missing).toEqual([])
    const unknown = [...catalogIds].filter((id) => !builtInIds.has(id))
    expect(unknown).toEqual([])
  })

  // 守的缺陷：`api.ts` 的 preview mock 用一份手抄的 capabilities 字面量喂给每个 provider，它当时还带着
  // core 类型早已删掉的 `hookEvents` / `acp` 两个零消费者字段。preview 据 capabilities 决定隐藏 timeline、
  // 禁用 resume，手抄一份等于让浏览器预览按一份可能与 core 契约不符的能力表渲染。修复是把 mock 标注成
  // `AgentCatalogEntry['capabilities']`，让 tsc 挡住任何越出 core 契约的键。
  //
  // 这条冻结 preview catalog 每个 entry 的**能力键集**到一份写死的字面量（不是从被测对象派生——那会跟着
  // 变异一起漂）。它咬这个变异：往 mock 里塞回 `hookEvents`/`acp`，或任何别的「只描述、无运行期消费者」
  // 的镜像字段——键集多一个 → 红，逼作者要么给它接一个真消费者、要么别加。`usage` 是可选字段，先并进来
  // 再比，省得「声明了 usage 的 mock」与「没声明的」被这条门判成不一致。
  //
  // 注意这条只守「没有发散的镜像字段」，不守「preview 的能力取值等于真 catalog 的逐 provider 取值」——后者
  // 今天不成立（preview 给所有 provider 同一份扁平 mock，而真 codex/claude 是 permission:'respond' 且带
  // usage），要修得先有一份 node-free 的 per-provider capabilities SSOT 供 12 家 provider 与 preview 共用，
  // 那是另一件工作，单独记 task，不在这条门的验收面内。
  it('preview capabilities expose exactly the core-contract keys — no re-added mirror field', async () => {
    const catalog = await api.providers.list()
    // 挡板：preview catalog 读成空则下面循环一条不跑、整条静默通过。先钉数量下界让「意外为空」响亮变红。
    expect(catalog.length).toBeGreaterThanOrEqual(12)
    // 写死的锚点。与 core `AgentCapabilities` 的键一致（usage 可选，见下）；ADD 一个键是要动这一行的
    // 蓄意行为，故偷偷加回的 `hookEvents`/`acp` 镜像无处藏身。
    const EXPECTED_CAPABILITY_KEYS = [
      'permission', 'providerResume', 'replyCorrelation', 'terminal', 'timeline', 'usage'
    ]
    for (const entry of catalog) {
      const keys = new Set(Object.keys(entry.capabilities))
      keys.add('usage')
      expect([...keys].sort()).toEqual(EXPECTED_CAPABILITY_KEYS)
    }
  })

  // 守的缺陷：preview 的 launchOptions 曾用 `id === 'codex' ? … : id === 'claude' ? … : []` 回答，
  // 注释还声称「那两个是唯一 node-free 导出的声明」并把缺失说成诚实的隐藏。事实是 8 个
  // `*_LAUNCH_OPTIONS` 全在同一个 node-free 模块里（agent-launch-option.ts，只 import ./errors.js 与
  // ./types.js），于是另外 6 家的启动选项控件——含 grok 的 posture 选择器——在 `pnpm dev` 的浏览器预览里
  // 静默消失，而 Provider 侧一切正常，两边各自全绿。修复是让 preview 从同一模块的反查表
  // `LAUNCH_OPTIONS_BY_PROVIDER_ID` 取值。
  //
  // 期望值取自**真注册表** `BUILT_IN_AGENT_PROVIDERS`——core 自己用 describeLaunchOptions 组装 catalog 的
  // 那处（agent-provider.ts:156）——绝不取 preview 所依据的那张映射：拿映射当期望会和被测对象一起漂。
  // core 侧另有一条按 id 逐家比对映射与 catalog（agent-provider.test.ts）；这一条守的是 preview 有没有
  // 真的接上去，两条各守一段，缺哪一段都能让某家 Provider 的控件无声消失。
  it('providers.list carries each built-in Provider its real launch options', async () => {
    const catalog = await api.providers.list()
    const previewOptions = new Map(catalog.map((entry) => [entry.id, entry.launchOptions]))
    // 挡板：注册表里必须真有声明启动选项的 Provider，否则下面循环只跑「都为空」的一侧，整条静默通过。
    const declaring = BUILT_IN_AGENT_PROVIDERS.filter((provider) => provider.catalog.launchOptions.length > 0)
    expect(declaring.length).toBeGreaterThanOrEqual(8)
    for (const provider of BUILT_IN_AGENT_PROVIDERS) {
      // 逐家整份比对（不是数个数）：取值错、少一个选项、少一个 choice 都会红。
      expect(previewOptions.get(provider.id), `preview has no entry for ${provider.id}`).toBeDefined()
      expect(previewOptions.get(provider.id), `${provider.id} launch options diverge from the real catalog`)
        .toEqual(provider.catalog.launchOptions)
    }
  })
})
