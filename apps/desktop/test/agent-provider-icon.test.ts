import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AGENT_PROVIDERS_WITH_BRAND_MARK,
  AGENT_PROVIDERS_WITHOUT_BRAND_MARK,
  AgentProviderIcon,
  agentProviderLabel
} from '../src/renderer/src/components/AgentProviderIcon.js'

describe('AgentProviderIcon', () => {
  it('每个内置 Provider 都恰好落进"有标记"或"没标记"之一', () => {
    // 这条守的是**分区**：覆盖无遗漏（每个内置 id 都被判到）、两族无交集。
    //
    // 它不与下面两条重复：那两条各自只遍历自己那份清单，对"某个 id 两边都不在"都是瞎的。
    // 而"某个 id 两边都不在"正是本文件历史上真出过的那个 bug（9 个内置 Provider 手抄成 5 个）。
    // 所以在派生成立的当下它确实近乎恒真，但它是防"派生被改回手抄"的那道回归闸——留着。
    //
    // 实测纪录（review 复核，纠正此前的一处夸大）：把派生换回手抄清单**但保持完整**（9+3=12），
    // 这条**不红**。所以它捕捉的是"漏了一个 id"，不是"退化了派生"这个动作本身。写变异时别把
    // 两处改动捆在一起，否则分不清是哪条断言在承重。
    //
    // 它独有的触发面另测过：手抄清单停在 9，同时给 Core 的 id 全集加一个新 provider——这条
    // **独占红**（`expected […10] to deeply equal […11]`），其余五条全绿。那正是本文件历史上
    // 真出过的形状：SSOT 长大而手抄的那份不动。注意 desktop 是经 dist 解析 @agentmux/core 的，
    // 所以要复现得改 resolved 的那份 dist，光改 packages/core/src 这个测试看不见（也实测过）。
    const withMark = [...AGENT_PROVIDERS_WITH_BRAND_MARK]
    const withoutMark = [...AGENT_PROVIDERS_WITHOUT_BRAND_MARK]
    expect([...withMark, ...withoutMark].sort()).toEqual([...BUILT_IN_AGENT_PROVIDER_IDS].sort())
    expect(withMark.filter((id) => withoutMark.includes(id))).toEqual([])
    // 手抄的那一侧只有豁免清单，所以直接钉它：每个豁免都得是真的内置 id，且不许重复。
    // （非内置 id 已被 readonly BuiltInAgentProviderId[] 在编译期挡住，这里守的是重复。）
    expect(new Set(withoutMark).size, '豁免清单里有重复').toBe(withoutMark.length)
  })

  it('renders a real offline identity mark for every Agent that claims one', () => {
    // 清单从组件导出，**不**在这里手抄：此前这里硬编码了 5 个 id，而组件当时已有 9 个内置
    // Provider——多出来的 4 个一条断言都没红。所谓"every built-in Agent"曾经只是句话。
    //
    // 不再断言一个手抄的下界（曾是 `>= 9`，即 12-3 算出来的数）：那正是本次要消灭的"手抄数字"
    // 形状，且 Provider 合法减少时它会假红。非空由上面那条分区断言覆盖。
    expect(AGENT_PROVIDERS_WITH_BRAND_MARK.length).toBeGreaterThan(0)
    for (const providerId of AGENT_PROVIDERS_WITH_BRAND_MARK) {
      const markup = renderToStaticMarkup(createElement(AgentProviderIcon, { providerId, size: 16 }))
      expect(markup).toContain(`data-agent-provider="${providerId}"`)
      expect(markup).toContain('data-agent-provider-known="true"')
      // 有品牌标记就必须是真图形（内联 svg 或图片资源），不能退化成 Bot 兜底。
      expect(markup, `${providerId} 应画出品牌标记而非兜底图形`).toMatch(/<svg|<img/)
      expect(markup).not.toContain('<text')
      // lucide 的 Bot 兜底带这个类名，出现即说明这个 id 根本没接上自己的标记。
      expect(markup, `${providerId} 落到了 Bot 兜底`).not.toContain('lucide-bot')
    }
  })

  it('认得名字但没有品牌图形的 Provider：label 认得，标记保持中性', () => {
    // Kimi 是第一个这样的条目：仓库里没有它的图标资源，就不画一个近似的冒充它。
    // 「认得这个 Provider」与「有它的品牌标记」是两件事，这条钉住两者可以分开。
    //
    // 遍历整份豁免清单而不是只看 kimi：这份清单能让上面那条"必须有品牌标记"闭嘴，所以每个进来的
    // id 都要在这里付出代价——必须**真的**落到 Bot 兜底。谁把一个有图标的 id 塞进豁免（比如为了
    // 让别处的断言过），这里立刻红。
    for (const providerId of AGENT_PROVIDERS_WITHOUT_BRAND_MARK) {
      const markup = renderToStaticMarkup(createElement(AgentProviderIcon, { providerId, size: 16 }))
      // "认得"由 known 这个属性直接表达，不用"label 不等于 id"去代理——那个代理对未来某个
      // 品牌名恰好是小写 id 的 Provider（label 就想写成 'xai'）会假红，而那不是缺陷。
      expect(markup, `${providerId} 该被认得——没图形不等于不认得`).toContain('data-agent-provider-known="true"')
      expect(markup).toContain(`data-agent-provider="${providerId}"`)
      expect(markup, `${providerId} 声明没有品牌图形，就必须真的走 Bot 兜底`).toContain('lucide-bot')
    }
    expect(agentProviderLabel('kimi')).toBe('Kimi')
  })

  it('keeps custom Provider identity neutral instead of impersonating a built-in Agent', () => {
    const markup = renderToStaticMarkup(createElement(AgentProviderIcon, {
      providerId: 'private-agent',
      size: 16
    }))

    expect(markup).toContain('data-agent-provider="private-agent"')
    expect(markup).toContain('data-agent-provider-known="false"')
    expect(markup).toContain('<svg')
  })

  it('provider 缺失时仍画出一枚中性标记——不消失、也不冒充某个内置 Agent', () => {
    // `providerId` 是 optional，因为「这个 Session 归哪个 Provider」本身可能不存在（终端 Session
    // 没有 Provider）或查不到（Session 已退场、store 未装载）。缺失这条路以前不是合法输入，于是
    // 三个调用方各自在外面写 `providerId ? <Icon/> : null`（WorkspaceBoard:109、SurfaceToolDock:787、
    // QuickSwitcher:23）——那让标记在缺失时**整枚消失**，留下一个无法解释的空位。
    //
    // 这条钉住缺失有它自己的画法：有 glyph、known 为 false（不冒充内置）、尺寸仍生效。
    const markup = renderToStaticMarkup(createElement(AgentProviderIcon, { size: 16 }))
    expect(markup).toContain('<svg')
    expect(markup).toContain('data-agent-provider-known="false"')
    // 且不许把缺失编码成某个字符串值：`data-agent-provider` 要么缺席，要么不是空串那种假值。
    expect(markup).not.toContain('data-agent-provider=""')
    expect(markup).toContain('width:16px')
  })

  it('uses one shared display label mapping across Agent surfaces', () => {
    expect(['codex', 'claude', 'traex', 'hermes', 'pi'].map(agentProviderLabel)).toEqual([
      'Codex',
      'Claude',
      'TraeX',
      'Hermes',
      'Pi'
    ])
    expect(agentProviderLabel('private-agent')).toBe('private-agent')
    expect(agentProviderLabel('toString')).toBe('toString')
  })
})
