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
    // 这条守的是**分区**，不是两份清单各自的长度：有标记的那份现在从 Core 的全集派生（减去豁免），
    // 于是新增一家 Provider 时它默认落进"应当有标记"、下一条断言会因为没画图形而红。
    //
    // 单独钉住分区，是因为豁免清单是个消音器——往里加一个 id 就能让"必须画出品牌标记"对它闭嘴。
    // 覆盖必须无遗漏（每个内置 id 都被判到），两族必须无交集（一个 id 不能同时既有又没有）。
    const withMark = [...AGENT_PROVIDERS_WITH_BRAND_MARK]
    const withoutMark = [...AGENT_PROVIDERS_WITHOUT_BRAND_MARK]
    expect([...withMark, ...withoutMark].sort()).toEqual([...BUILT_IN_AGENT_PROVIDER_IDS].sort())
    expect(withMark.filter((id) => withoutMark.includes(id))).toEqual([])
    // 豁免是少数派。若有一天多数 Provider 都没有图形，那说明这套资源该重做，而不是继续加豁免。
    expect(withoutMark.length).toBeLessThan(withMark.length)
  })

  it('renders a real offline identity mark for every Agent that claims one', () => {
    // 清单从组件导出，**不**在这里手抄：此前这里硬编码了 5 个 id，而组件当时已有 9 个内置
    // Provider——多出来的 4 个一条断言都没红。所谓"every built-in Agent"曾经只是句话。
    expect(AGENT_PROVIDERS_WITH_BRAND_MARK.length).toBeGreaterThanOrEqual(9)
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
      expect(agentProviderLabel(providerId), `${providerId} 该有 label——没图形不等于不认得`).not.toBe(providerId)
      expect(markup).toContain(`data-agent-provider="${providerId}"`)
      expect(markup).toContain('data-agent-provider-known="true"')
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
