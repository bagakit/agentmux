import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { terminalIdentityMenuActions } from '../src/renderer/src/lib/terminal-identity-menu.js'
import {
  formatMessagingAddress,
  formatSessionAddress
} from '../src/renderer/src/lib/agent-address.js'

// ---------------------------------------------------------------------------
// 终端画布右键也要能寻址这个 Agent。
//
// 用户原话：「现在右键 TUI 上，实际也没有办法复制出某个 agent 自己的身份，这样就不方便和他通信」。
// Region / Tab / Roster 三处右键早就有这两项，全部走 agent-address 那个唯一出口——缺的只是终端画布
// 这一个入口：用户正跟这个 Agent 对话、光标就在它的 TUI 里，却得离开画布去别处找它的身份。
//
// 所以这一族守的不是"寻址对不对"（那由 agent-address.test.ts 守），而是三件接线事实：
//   1. 文本逐字来自那个唯一出口，终端侧没有第二份拼接；
//   2. 非 Agent 的那一格是**缺席**而不是灰掉——终端没有 Agent 身份，画个 disabled 项是承诺一件
//      不存在的事；
//   3. 组件真把这份 actions 画出来了，且身份取的是这一格自己的 session。
//
// 期望值一律由 agent-address 的 formatter 算出而**不是**手抄一段字符串字面量：手抄的那天 formatter
// 改了格式，这里仍然绿，而那正是"两份拼接会各自演进"要防的东西。
// ---------------------------------------------------------------------------

describe('终端右键的身份动作：复用同一个地址出口', () => {
  it('Agent 那一格给两项：发消息（落到 Session 地址）与复制 Session 地址', async () => {
    const copied: string[] = []
    const actions = terminalIdentityMenuActions({
      sessionId: 'agent-terminal-1',
      sessionKind: 'agent',
      writeClipboardText: async (text) => {
        copied.push(text)
      }
    })
    // 钉死整个数组而不是写 every/some：空集合上 every→true、some→false 会白绿
    // （记忆 vacuous-predicate-on-empty-collection）。
    expect(actions.map((action) => action.label)).toEqual([
      'Message this Agent',
      'Copy Session Address'
    ])

    for (const action of actions) await action.onSelect()
    // 终端画布没有 Region 语境（它只知道自己那一格的 session），所以寻址解析成 Session 地址——
    // 与 Tab 菜单、Roster 同一条规则。
    expect(copied).toEqual([
      formatMessagingAddress({ agentSessionId: 'agent-terminal-1' }),
      formatSessionAddress('agent-terminal-1')
    ])
  })

  it('终端 Session：两项一个都不在场——是缺席，不是灰掉', () => {
    // 终端没有 Agent 身份可寻址。给它画一个 disabled 的「给这个 Agent 发消息」，用户会去想
    // "为什么这个是灰的、怎么点亮它"，而答案是"这里根本没有 Agent"。
    //
    // 这一条与上一条必须**成对**存在：只断言 agent 世界在场，会放过「两个世界都在场」这个缺陷
    // （记忆 banned-word-guard-misses-the-mirror 同一族——只守一个方向，翻面即存活）。
    const actions = terminalIdentityMenuActions({
      sessionId: 'plain-terminal',
      sessionKind: 'terminal',
      writeClipboardText: async () => {
        throw new Error('terminal session must not reach the clipboard')
      }
    })
    expect(actions).toEqual([])
  })

  it('每一项点下去复制的是自己那一项的文本，不是把两项接串了', async () => {
    const write = vi.fn(async (_text: string) => {})
    const actions = terminalIdentityMenuActions({
      sessionId: 'agent-terminal-2',
      sessionKind: 'agent',
      writeClipboardText: write
    })
    const expected = new Map<string, string>([
      ['Message this Agent', formatMessagingAddress({ agentSessionId: 'agent-terminal-2' })],
      ['Copy Session Address', formatSessionAddress('agent-terminal-2')]
    ])
    let clicked = 0
    for (const action of actions) {
      write.mockClear()
      await action.onSelect()
      expect(write, `${action.label} 点下去落点不对`).toHaveBeenCalledWith(expected.get(action.label))
      clicked += 1
    }
    // 空清单的 for 永远绿——自证扫到了东西。
    expect(clicked).toBe(expected.size)
  })

  it('复制出的文本与 Roster / Tab 那三处逐字一致（同一份真相的四个入口）', async () => {
    // 这一条是"不许在终端侧另拼一份"的正面兑现：把 agent-address 里的 flag 改掉，这里必须红。
    const copied: string[] = []
    const actions = terminalIdentityMenuActions({
      sessionId: "agent with 'quotes'",
      sessionKind: 'agent',
      writeClipboardText: async (text) => {
        copied.push(text)
      }
    })
    for (const action of actions) await action.onSelect()
    // 带引号的 id 选得故意：shell 转义也必须来自那个出口，不是终端侧自己转一遍。
    expect(copied[1]).toBe(formatSessionAddress("agent with 'quotes'"))
    expect(copied[1]).toContain('agentmux send')
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
    expect(block).not.toContain('useAppStore')
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
