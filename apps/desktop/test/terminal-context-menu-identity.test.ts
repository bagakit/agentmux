import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { terminalIdentityMenuActions } from '../src/renderer/src/lib/terminal-identity-menu.js'
describe('terminal identity menu shares its own Agent', () => {
  it('offers one semantic Agent link', async () => {
    const write = vi.fn(async (_text: string) => {})
    const actions = terminalIdentityMenuActions({ sessionId: 'agent-terminal-1', sessionKind: 'agent', writeClipboardText: write })
    expect(actions.map(action => action.label)).toEqual(['Copy Agent Link'])
    await actions[0]!.onSelect()
    expect(write).toHaveBeenCalledExactlyOnceWith('amux://agent/agent-terminal-1')
  })
  it('plain terminal has no Agent identity action', () => {
    expect(terminalIdentityMenuActions({ sessionId: 'terminal', sessionKind: 'terminal', writeClipboardText: vi.fn() })).toEqual([])
  })
  it('encodes the exact Session without guessing the focused neighbor', async () => {
    const write = vi.fn(async (_text: string) => {})
    const actions = terminalIdentityMenuActions({ sessionId: 'agent with /?#', sessionKind: 'agent', writeClipboardText: write })
    expect(actions).toHaveLength(1)
    await actions[0]!.onSelect()
    expect(write).toHaveBeenCalledExactlyOnceWith('amux://agent/agent%20with%20%2F%3F%23')
  })
})

describe('TerminalContextMenu / TerminalView 真把这份 actions 接上了', () => {
  /**
   * 源码扫描守的是"接线在场"，而这一族有一个已知的白绿形态：**indexOf 锚点取空了**。
   * `s.slice(s.indexOf(anchor), …)` 里锚点一旦不存在，indexOf 返回 -1，slice 切出空串（或整段），
   * 之后每条 not.toContain 恒真。所以每个锚点都先断言它真的在场（记忆 indexof-anchor-gone）。
   */
  function sourceOf(relative: string): string {
    const raw = readFileSync(new URL(relative, import.meta.url), 'utf8')
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  }

  const menu = sourceOf('../src/renderer/src/components/TerminalContextMenu.tsx')
  const view = sourceOf('../src/renderer/src/components/TerminalView.tsx')

  it('菜单画的是 identityActions.map，不是一串写死的 ContextMenu.Item', () => {
    expect(menu).toContain('identityActions.map(')
    // 组件不自己 import 地址 formatter——寻址留在 lib 里，一个概念一个出口。
    expect(menu).not.toContain('formatSessionAddress')
    expect(menu).not.toContain('formatMessagingAddress')
  })

  it('身份簇与复制文本那一簇之间隔着分隔线（回答的不是同一个问题）', () => {
    const anchor = 'identityActions.length > 0'
    const start = menu.indexOf(anchor)
    // 锚点在场自证：不判这一句，下面 slice 出空串时断言会恒真。
    expect(start, '条件渲染的锚点没了——这条断言会变成恒真').toBeGreaterThan(-1)
    const block = menu.slice(start, start + 600)
    expect(block, '切出来的不是那一段').toContain('identityActions.map(')
    // 分隔线在这个条件块**里面**：非 Agent 时连分隔线一起不挂，否则一条线下面空无一物。
    expect(block).toContain('ContextMenu.Separator')
  })

  it('TerminalView 传的是这一格自己的 session 身份，不是 store 里的活跃会话', () => {
    const anchor = 'terminalIdentityMenuActions({'
    const start = view.indexOf(anchor)
    expect(start, '接线的锚点没了').toBeGreaterThan(-1)
    const block = view.slice(start, start + 500)
    expect(block).toContain('sessionId: session.id')
    expect(block).toContain('sessionKind: session.kind')
    // 不许从 store 取活跃会话：用户右键的那一格往往恰恰不是聚焦的那一格。
    expect(block).not.toContain('activeSession')
    expect(block).not.toContain('sharingMetadata')
  })

  it('写剪贴板走共用出口，不绕过它直接碰 IPC', () => {
    const anchor = 'terminalIdentityMenuActions({'
    const start = view.indexOf(anchor)
    expect(start).toBeGreaterThan(-1)
    const block = view.slice(start, start + 500)
    expect(block).toContain('copyTextToClipboard(')
    // 全 renderer 唯一那个写剪贴板的出口是 clipboard-copy.ts；这里不许自己写。
    expect(block).not.toContain('api.ui.writeClipboardText')
    expect(menu).not.toContain('api.ui.writeClipboardText')
    expect(menu).not.toContain('navigator.clipboard')
  })

  it('identityActions 是必填 prop——删掉那行 JSX 属性必须编译不过', () => {
    // 可选属性买到的只是关掉 tsc：`x?:` 会让 `x={undefined && f()}` 合法，整节静默消失
    // （记忆 optional-prop-only-buys-silence）。类型层的必填由 tsc 守，这里守类型声明本身没被改回可选。
    expect(menu).toContain('identityActions: TerminalIdentityMenuAction[]')
    expect(menu).not.toContain('identityActions?:')
  })
})
