import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// agentRosterMenuActions 经 clipboard-copy 引到 api（在 AgentRoster 里），但本 lib 自己不碰 api，
// 直接测纯函数。组件源码扫描不加载运行时，也无需宿主全局。
import { agentRosterMenuActions } from '../src/renderer/src/lib/agent-roster-menu.js'
import {
  formatMessagingAddress,
  formatSessionAddress
} from '../src/renderer/src/lib/agent-address.js'

// Roster 行右键菜单：复用已有的 agent-address 动作源，不重写寻址。守两件事：
//   - 两项恒在场（每行都是一个 Agent），点了真的复制到 agent-address 的 formatter 产物；
//   - AgentRoster 真把这份 actions 画出来了（不是造了不画）——用组件源码里画的是 map、
//     且渲染层不读可选字段来判在场。本仓 renderToStaticMarkup 渲不出 Radix Portal 内容，
//     所以把在场降成数据、在这里跑纯函数，是唯一咬得住「不渲染」「点了不生效」的做法。

describe('Roster 行右键菜单：复用地址动作源', () => {
  it('每行两项：交接（落到 Session 地址）与复制 Session 地址', async () => {
    const copied: string[] = []
    const actions = agentRosterMenuActions({
      sessionId: 'agent-7',
      writeClipboardText: async (text) => {
        copied.push(text)
      }
    })
    expect(actions.map((action) => action.label)).toEqual([
      'Message this Agent',
      'Copy Session Address'
    ])

    for (const action of actions) await action.onSelect()
    // Roster 行没有 View/Region 语境，交接解析成 Session 地址（跨 View 稳定）。
    expect(copied).toEqual([
      formatMessagingAddress({ agentSessionId: 'agent-7' }),
      formatSessionAddress('agent-7')
    ])
    // 交接与复制 Session 在 Roster 这里逐字相同——都是 Session 身份。
    expect(copied[0]).toBe(formatSessionAddress('agent-7'))
  })

  it('每一项点下去复制的是那个 session 的地址，不是把两项接串了', async () => {
    // 派生可能是壳：label 对、onSelect 指向别项。逐项点一遍看落点。
    const write = vi.fn(async (_text: string) => {})
    const actions = agentRosterMenuActions({ sessionId: 'agent-9', writeClipboardText: write })
    const expected = new Map<string, string>([
      ['Message this Agent', formatMessagingAddress({ agentSessionId: 'agent-9' })],
      ['Copy Session Address', formatSessionAddress('agent-9')]
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
})

describe('AgentRoster 真把这份 actions 画出来了', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/AgentRoster.tsx', import.meta.url),
    'utf8'
  )
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('每行外面套了 ContextMenu.Trigger，右键才有菜单', () => {
    expect(withoutComments).toContain('ContextMenu.Trigger')
    expect(withoutComments).toContain('ContextMenu.Content')
  })

  it('菜单项画的是 menuActions.map，不是一串写死的 ContextMenu.Item', () => {
    expect(withoutComments).toContain('menuActions.map(')
  })

  it('actions 由 agentRosterMenuActions 造，复用地址源而非组件里重拼', () => {
    expect(withoutComments).toContain('agentRosterMenuActions(')
    // 组件不自己 import 三级地址 formatter——寻址逻辑留在 lib 里，一个概念一个出口。
    expect(withoutComments).not.toContain('formatSessionAddress')
    expect(withoutComments).not.toContain('formatMessagingAddress')
  })

  it('写剪贴板走共用出口（复制失败必报，不静默）', () => {
    expect(withoutComments).toContain('copyTextToClipboard(')
    // 不许绕过出口直接写剪贴板。
    expect(withoutComments).not.toContain('api.ui.writeClipboardText')
  })
})
