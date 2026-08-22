import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar.js'
import { topicAgentPresentation } from '../src/renderer/src/lib/surface-tool-dock.js'
import { allStyleRules } from './helpers/styles.js'

// #473：一个没有 live Session 的协作者（磁盘上的 durable identity）不许被画成「像它在跑」。
// 语义决定取 (b)：identityContent 明说该文件是 durable 短记忆而非 Run-state，所以不删文件、保留协作者，
// 但显示必须把「曾在」与「在跑」分开。此前的缺陷：disconnected 头像没有任何专属规则，与「live 但
// done/exited」的头像逐像素同款——「曾在」和「跑完了还在」被画成同一件事。

describe('#473 关闭的协作者不被画成在跑', () => {
  it('投影层把无 live Session 的协作者报成 disconnected、无 attention', () => {
    const shown = topicAgentPresentation({ sessionId: 's', providerId: 'claude', live: null })
    expect(shown.state).toBe('disconnected')
    expect(shown.attention).toBeNull()
  })

  it('disconnected 头像的 class 与 running 分得开（不带 running 那档的在场标志）', () => {
    const closed = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'a', onOpen: () => {}, providerId: 'claude', state: 'disconnected'
    }))
    const running = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'a', onOpen: () => {}, providerId: 'claude', state: 'running'
    }))
    expect(closed).toContain('status--disconnected')
    expect(running).toContain('status--running')
    // 两者 class 不同 —— 样式表据此给不同的处理。
    expect(closed).not.toContain('status--running')
  })

  it('同一个共享状态点把 disconnected 与 running、done、exited 区分开', () => {
    const styles = allStyleRules()
    const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    expect(rules.length).toBeGreaterThan(0)
    const bodiesFor = (selector: string) => rules.filter(([, selectors]) =>
      selectors!.split(',').some((one) => one.trim() === selector)).map(([, , body]) => body!).join(';')
    const closed = renderToStaticMarkup(createElement(AgentAvatar, {
      label: 'a', providerId: 'claude', state: 'disconnected'
    }))
    expect(closed).toContain('agent-avatar__status status__dot')
    expect(closed).toContain('agent-avatar__contour')
    const baseDot = bodiesFor('.status__dot')
    expect(baseDot).toContain('background: var(--status-ink)')
    const disconnected = bodiesFor('.status--disconnected .status__dot')
    expect(disconnected, '断开态必须走共享空心点').toContain('background: transparent')
    expect(disconnected).toContain('var(--status-ink)')
    expect(bodiesFor('.status--disconnected')).toContain('--status-ink: var(--text-3)')
    expect(bodiesFor('.status--running')).toContain('--status-ink: var(--blue)')
    // done/exited retain the filled base dot; no private avatar rule can turn them into disconnected.
    expect(bodiesFor('.status--done .status__dot')).not.toContain('background: transparent')
    expect(bodiesFor('.status--exited .status__dot')).not.toContain('background: transparent')
    expect(bodiesFor('.agent-avatar__contour')).toContain('filter: none')
    expect(bodiesFor('.agent-avatar__contour')).not.toContain('drop-shadow(')
  })
})
