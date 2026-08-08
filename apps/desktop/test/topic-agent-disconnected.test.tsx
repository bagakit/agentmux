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

  it('样式表给 disconnected 头像一条专属规则，把它与 done/exited 那种「跑完了还在」区分开', () => {
    const styles = allStyleRules()
    // 取每条 .agent-avatar.status--<state> 规则体，比较 disconnected 与 done/exited 的视觉处理。
    const ruleFor = (state: string): string => {
      for (const [, selector, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (selector!.split(',').some((one) => one.trim() === `.agent-avatar.status--${state}`)) return body!
      }
      return ''
    }
    const disconnected = ruleFor('disconnected')
    // disconnected 必须有专属规则（缺陷正是它此前没有）。
    expect(disconnected, 'disconnected 头像没有专属规则，与 done/exited 逐像素同款').not.toBe('')
    // 它必须画出一个可见的「不在场」记号（描边），且仍读 --status-ink，不自己挑色。
    expect(disconnected).toMatch(/outline:[^;]*var\(--status-ink\)/)
    // done / exited 刻意没有这条专属规则（它们「在场但结束」，走基础的灰度收敛），
    // 所以 disconnected 与它们分得开正是靠这条独有规则。
    expect(ruleFor('done'), 'done 现在有了专属头像规则——与 disconnected 的区分被抹掉了').toBe('')
    expect(ruleFor('exited'), 'exited 现在有了专属头像规则——与 disconnected 的区分被抹掉了').toBe('')
    // 而它与 running 那档也要分得开：running 是实线描边（在场且活跃），disconnected 是虚线（占位）。
    const running = ruleFor('running')
    expect(running).toContain('outline')
    expect(disconnected).toContain('dashed')
    expect(running).not.toContain('dashed')
  })
})
