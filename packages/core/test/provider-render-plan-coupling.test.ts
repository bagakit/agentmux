import { describe, expect, it } from 'vitest'
import {
  AgentProviderRegistry,
  defineAgentProvider,
  type AgentProviderDefinition
} from '../src/agent-provider.js'
import { catalog } from '../src/providers/shared.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentPromptInputPlan, AgentTerminalPromptRenderMatcher } from '../src/types.js'

// ---------------------------------------------------------------------------
// 「render-then-submit 两阶段计划 ⟺ terminalPromptRender 匹配器」的定义期耦合守卫（Lane 3 / 静默半成功）。
//
// 由来：提交一条 prompt 依赖同一条通路的两半，却分居 `AgentProviderDefinition` 的两个可选字段：
//   - `terminalPromptRender`：渲染匹配器，readiness 纪元靠它 arm（client.ts 握手期 / native-stop 期两条
//     arm 路径都 gate 在它上，`AgentPromptSubmissionCoordinator.observeReadiness` 自己第一行也是
//     `if (!matcher) return`）；
//   - `planPromptInput` 产出的 `render-then-submit` 计划：两阶段提交（payload → 渲染验证 → submit）在
//     `submitInputPlan` 里消费 readiness 纪元。
// 谁也不强制对方在场。声明了两阶段计划却漏了匹配器：readiness 永不 arm，发往这个 Provider 的**每条**
// prompt 都在 `claimPromptReadiness` 被 `AGENT_PROMPT_NOT_READY`（reason=epoch-missing）拒掉——没有编译错、
// 没有红测试，一个新接的 Provider「装上了但一条 prompt 都发不出去」，只在**用户**发第一条 prompt 时现形。
// 反向（有匹配器、单阶段计划）：readiness 被 arm 却永不消费，屏幕证据观察白做。
//
// `provider-render-conformance.test.ts` 早已守了「匹配器 ⟹ render-then-submit」一侧（它对 codex 断言并对
// 所有声明了匹配器的 Provider 断言 plan.kind）。**反向那侧此前无人守**——那正是本 lane 的静默杀手：一个只
// 声明了两阶段计划的新 Provider 通不过任何现有断言。本文件补上定义期的**双向**不变式，并证明它有牙。
//
// 判据形态：不做源码文本扫描（`readFileSync + toContain` 家族对早退/改拼法失明，本仓反复踩）。而是走
// **真调用路径**——`defineAgentProvider` 是每个 Provider 的唯一构造入口，让它对违约定义**当场抛**，于是
// 违约在「新接一个 Provider」这个动作发生的瞬间就炸，不必等到运行时。
//
// 本守卫看不见什么（务必申报）：
//   1. 定义期只探两个代表性 prompt（单行 / 多行）判 `planPromptInput` 产哪一种计划。一个「按 prompt
//      内容切换计划种类」的 Provider 本就不被这套 readiness 机制支持（readiness 在不知道 prompt 内容时
//      就已 arm），故假定计划种类对一个 Provider 稳定。这条假定与 conformance 测试探计划种类的做法一致。
//   2. 它证明「两者同在或同缺」，不证明匹配器的字节真能在该 Provider 的 PTY 里定位到 composer——那是
//      `provider-render-conformance.test.ts` 用录制字节负责的（且它今天只对 codex 有真录制）。
// ---------------------------------------------------------------------------

const VALID_MATCHER: AgentTerminalPromptRenderMatcher = {
  frameStart: '[?2026h',
  activeComposer: '›',
  frameEnd: '[?2026l'
}

/** 一份最小但合法的 Provider 定义，套用一层覆盖来构造四种「匹配器在场 × 计划种类」组合。 */
function defineWith(overrides: {
  id: string
  matcher?: AgentTerminalPromptRenderMatcher
  plan?: (prompt: string) => AgentPromptInputPlan
}): AgentProviderDefinition {
  return {
    catalog: catalog({
      id: overrides.id,
      label: `Probe ${overrides.id}`,
      executable: overrides.id,
      expectedProcess: overrides.id,
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'none' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'unavailable', permission: 'none',
        providerResume: false, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: { rules: [] },
    ...(overrides.matcher ? { terminalPromptRender: overrides.matcher } : {}),
    ...(overrides.plan ? { planPromptInput: overrides.plan } : {})
  }
}

const renderThenSubmit = (prompt: string): AgentPromptInputPlan => ({
  kind: 'render-then-submit',
  payload: prompt,
  renderedText: prompt,
  submit: '\r'
})

const singlePhase = (prompt: string): AgentPromptInputPlan => ({ kind: 'single-phase', data: `${prompt}\r` })

function couplingErrorFrom(build: () => unknown): AgentMuxError {
  let thrown: unknown
  try {
    build()
  } catch (error) {
    thrown = error
  }
  expect(thrown, '违约定义没有抛——定义期耦合守卫恒真').toBeInstanceOf(AgentMuxError)
  return thrown as AgentMuxError
}

describe('render-then-submit 计划与 terminalPromptRender 匹配器的定义期耦合', () => {
  it('声明了两阶段计划却漏掉匹配器：defineAgentProvider 当场抛（本 lane 的静默杀手）', () => {
    // 这一支就是「一条 prompt 都发不出去」的 Provider。此前它通不过任何断言却也不炸；现在它在构造期炸。
    const error = couplingErrorFrom(() =>
      defineAgentProvider(defineWith({ id: 'plan-without-matcher', plan: renderThenSubmit }))
    )
    expect(error.code).toBe('INVALID_AGENT_PROVIDER')
    // detail 里如实带上两半各自的在场事实，排障时一眼看出是哪半缺席（不含用户内容）。
    expect(error.detail).toContain('hasRenderMatcher=false')
    expect(error.detail).toContain('rendersTwoPhase=true')
  })

  it('声明了匹配器却用单阶段计划：同样当场抛（readiness 被 arm 却永不消费）', () => {
    const error = couplingErrorFrom(() =>
      defineAgentProvider(defineWith({ id: 'matcher-without-plan', matcher: VALID_MATCHER }))
    )
    expect(error.code).toBe('INVALID_AGENT_PROVIDER')
    expect(error.detail).toContain('hasRenderMatcher=true')
    expect(error.detail).toContain('rendersTwoPhase=false')
  })

  it('两者同缺（默认单阶段）：合法，不抛', () => {
    // 绝大多数 Provider 是这一支——没有匹配器、planPromptInput 缺省成 single-phase。
    expect(() => defineAgentProvider(defineWith({ id: 'neither' }))).not.toThrow()
  })

  it('两者同在：合法，不抛（codex 那一支的形状）', () => {
    expect(() =>
      defineAgentProvider(defineWith({ id: 'both', matcher: VALID_MATCHER, plan: renderThenSubmit }))
    ).not.toThrow()
  })

  it('自检：多行 prompt 也在探测里——单探一个单行 prompt 会漏掉只在多行分叉里违约的计划', () => {
    // 一个「单行时 single-phase、多行时 render-then-submit」的计划：没有匹配器时，它在多行探针上违约。
    // 若守卫只探单行 prompt，这一支会假绿。这里证明守卫确实两个探针都判。
    const branchingPlan = (prompt: string): AgentPromptInputPlan =>
      prompt.includes('\n') ? renderThenSubmit(prompt) : singlePhase(prompt)
    const error = couplingErrorFrom(() =>
      defineAgentProvider(defineWith({ id: 'branching-no-matcher', plan: branchingPlan }))
    )
    expect(error.code).toBe('INVALID_AGENT_PROVIDER')
    expect(error.detail).toContain('rendersTwoPhase=true')
  })

  it('前提自检：这套 defineWith 造出的合法定义确实能构造出可用 Provider（否则四条判据都在坏 fixture 上）', () => {
    // 若 defineWith 本身产出的都是无法构造的定义，上面「不抛」的两条会假绿（因为它们只断言「没抛耦合错」，
    // 一个别的原因抛的错会被 couplingErrorFrom 之外的路径吞掉）。这里正面证明合法定义真能产出 Provider。
    const provider = defineAgentProvider(defineWith({ id: 'sanity', matcher: VALID_MATCHER, plan: renderThenSubmit }))
    expect(provider.id).toBe('sanity')
    expect(provider.terminalPromptRender).toEqual(VALID_MATCHER)
    expect(provider.planPromptInput('x').kind).toBe('render-then-submit')
  })

  it('行为锚点：每个真实内置 Provider 都满足这条不变式（注册表构造成功即证明）', () => {
    // BUILT_IN_AGENT_PROVIDERS 在 agent-provider.ts 模块加载时就 defineAgentProvider 过一遍；这里再显式
    // 构造一次注册表，等于把「所有内置 Provider 都通过了这条定义期不变式」钉成一条会红的断言。
    const registry = new AgentProviderRegistry()
    const providers = registry.list()
    expect(providers.length).toBeGreaterThanOrEqual(12)
    for (const provider of providers) {
      const rendersTwoPhase = provider.planPromptInput('probe').kind === 'render-then-submit'
      // 逐个复核：匹配器在场 ⟺ 计划是两阶段。这是定义期守卫的运行时投影，双向都钉。
      expect(Boolean(provider.terminalPromptRender)).toBe(rendersTwoPhase)
    }
    // 前提自检：至少有一个 Provider 走两阶段分支（否则「⟺」这条对全体恒为 false===false 而不测左侧在场）。
    expect(providers.some((provider) => provider.terminalPromptRender)).toBe(true)
  })
})
