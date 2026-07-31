import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AgentProviderIcon,
  agentProviderLabel
} from '../src/renderer/src/components/AgentProviderIcon.js'

describe('AgentProviderIcon', () => {
  it('renders a real offline identity mark for every built-in Agent', () => {
    for (const [providerId, element] of [
      ['codex', 'svg'],
      ['claude', 'svg'],
      ['traex', 'img'],
      ['hermes', 'img'],
      ['pi', 'svg']
    ] as const) {
      const markup = renderToStaticMarkup(createElement(AgentProviderIcon, { providerId, size: 16 }))
      expect(markup).toContain(`data-agent-provider="${providerId}"`)
      expect(markup).toContain('data-agent-provider-known="true"')
      expect(markup).toContain(`<${element}`)
      expect(markup).not.toContain('<text')
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
