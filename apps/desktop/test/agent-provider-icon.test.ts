import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core/provider-id'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentProviderIcon, agentProviderLabel } from '../src/renderer/src/components/AgentProviderIcon.js'

describe('AgentProviderIcon', () => {
  it('每个内置 Provider 都画出自己的品牌标记，无一落到 Bot 兜底', () => {
    // 这是"图标映射的守卫"：直接遍历 Core 的运行时 SSOT（BUILT_IN_AGENT_PROVIDER_IDS），
    // 对每个 id 渲染一次并断言它画出了真图形——而不是遍历组件自己导出的某份手抄清单。
    //
    // 为什么遍历 SSOT 而不是本地清单：本文件历史上真出过两次同形状的 bug——组件的图标清单
    // 手抄成 5 个（Core 已有 9 个）、又手抄成 9 个（Core 已有 12 个），多出来的那些 Provider
    // 一条断言都没红。只要"该有图标的清单"来自组件本地，它就能悄悄比 Core 短一截。把遍历源
    // 钉死在 Core 的 id 全集上，这种漂移就无处可藏：Core 每长出一个 Provider，这里立刻多遍历
    // 一次，忘了给它接图标 → 落到 Bot 兜底 → `lucide-bot` 出现 → **当场红**。
    //
    // 怎么验证它真会红（本轮实测）：把 AgentProviderIcon 的 switch 里任意一个 case 删掉（比如
    // 删 `case 'droid'`），那个 id 就落进 `default` 的 `<Bot/>`，markup 里出现 `lucide-bot`，
    // 这条对该 id 独占红：`droid 落到了 Bot 兜底`。恢复后复绿。
    //
    // 注意 desktop 是经 dist 解析 @agentmux/core 的，所以这份 SSOT 是 packages/core/dist 里
    // 那一份——要复现"Core 长大而图标没跟上"得让 dist 的 id 全集变长（新增 Provider 会重建
    // dist），光改 packages/core/src 这个测试看不见。
    expect(BUILT_IN_AGENT_PROVIDER_IDS.length).toBeGreaterThan(0)
    for (const providerId of BUILT_IN_AGENT_PROVIDER_IDS) {
      const markup = renderToStaticMarkup(createElement(AgentProviderIcon, { providerId, size: 16 }))
      expect(markup).toContain(`data-agent-provider="${providerId}"`)
      // 内置 id 必须被认得——label 表里有它。
      expect(markup, `${providerId} 该被认得为内置 Provider`).toContain('data-agent-provider-known="true"')
      // 必须是真图形（内联 svg 或图片资源），不能退化成 Bot 兜底。
      expect(markup, `${providerId} 应画出品牌标记而非兜底图形`).toMatch(/<svg|<img/)
      expect(markup).not.toContain('<text')
      // lucide 的 Bot 兜底带这个类名，出现即说明这个 id 根本没接上自己的标记。
      expect(markup, `${providerId} 落到了 Bot 兜底`).not.toContain('lucide-bot')
      // 内置 Provider 也必须在 label 表里有条目（label 缺失时 agentProviderLabel 原样返回 id，
      // 于是 label 会等于 id——钉住它不等于 id，堵住"忘了给新 Provider 加 label"这条缝）。
      expect(agentProviderLabel(providerId), `${providerId} 缺少 label 条目`).not.toBe(providerId)
    }
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
