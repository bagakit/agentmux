import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// agentRosterMenuActions 经 clipboard-copy 引到 api（在 AgentRoster 里），但本 lib 自己不碰 api，
// 直接测纯函数。组件源码扫描不加载运行时，也无需宿主全局。
import { agentRosterMenuActions } from '../src/renderer/src/lib/agent-roster-menu.js'
describe('Roster row shares one stable Agent link', () => {
  it.each(['agent-7', 'agent-9'])('copies %s from the row identity', async sessionId => {
    const write = vi.fn(async (_text: string) => {})
    const actions = agentRosterMenuActions({ sessionId, writeClipboardText: write })
    expect(actions.map(action => ({ key: action.key, label: action.label }))).toEqual([
      { key: 'copy-session', label: 'Copy Agent Link' }
    ])
    await actions[0]!.onSelect()
    expect(write).toHaveBeenCalledExactlyOnceWith(`amux://agent/${sessionId}`)
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
