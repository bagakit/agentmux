import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { useAppStore } from '../src/renderer/src/store.js'
import {
  createWorkbenchTab,
  type AgentWorkbenchSurface
} from '../src/renderer/src/lib/workbench-tabs.js'

/**
 * 显示名的 Store 侧接线：`renameAgent` / `renameTab` 两个独立、各自持久化的字段，且改名不动寻址。
 *
 * 纯函数（display-name / workbench-tabs）证明了求值逻辑；这里证明"能力真的接到了产品上"——动作存在、
 * 改的是对的 slice、清除交还默认、且经 partialize 落进持久化。让 partialize 漏掉某个名字 slice，或
 * 让 renameTab 顺手改了 id，都会在这里变红。
 */

const initialState = useAppStore.getState()
afterEach(() => useAppStore.setState(initialState, true))

function agentSurface(regionId: string, sessionId: string): AgentWorkbenchSurface {
  return { regionId, kind: 'agent', phase: 'attached', workspaceId: 'workspace-1', sessionId }
}

describe('renameAgent：Agent 名是独立、可清除、会持久化的字段', () => {
  it('写入按 session id 存的手改名', () => {
    useAppStore.getState().renameAgent('agent-1', '我的调查员')
    expect(useAppStore.getState().agentNames['agent-1']).toBe('我的调查员')
  })

  it('传空清除该名，交还派生链（不留空串）', () => {
    useAppStore.getState().renameAgent('agent-1', '临时')
    useAppStore.getState().renameAgent('agent-1', '   ')
    expect('agent-1' in useAppStore.getState().agentNames).toBe(false)
  })

  it('改 Agent 名不触及 Tab 名，反之亦然——两个字段互不串味', () => {
    const tab = createWorkbenchTab('tab-1', agentSurface('region-0', 'agent-1'))
    useAppStore.setState({ tabs: { 'tab-1': tab } })
    useAppStore.getState().renameAgent('agent-1', 'Agent 名')
    useAppStore.getState().renameTab('tab-1', 'Tab 名')
    expect(useAppStore.getState().agentNames['agent-1']).toBe('Agent 名')
    expect(useAppStore.getState().tabs['tab-1']!.name).toBe('Tab 名')
  })
})

describe('renameTab：改名只写 name 字段，三级地址不变', () => {
  it('写入手改名，且 id / titleRegionId / region key 原样不变', () => {
    const tab = createWorkbenchTab('tab-1', agentSurface('region-0', 'agent-1'))
    useAppStore.setState({ tabs: { 'tab-1': tab } })
    useAppStore.getState().renameTab('tab-1', '登录专项')
    const renamed = useAppStore.getState().tabs['tab-1']!
    expect(renamed.name).toBe('登录专项')
    expect(renamed.id).toBe('tab-1')
    expect(renamed.titleRegionId).toBe(tab.titleRegionId)
    expect(Object.keys(renamed.regions)).toEqual(Object.keys(tab.regions))
    expect(renamed.regions[tab.titleRegionId]).toEqual(tab.regions[tab.titleRegionId])
  })

  it('传空清除手改名，回到默认策略', () => {
    const tab = { ...createWorkbenchTab('tab-1', agentSurface('region-0', 'agent-1')), name: '旧名' }
    useAppStore.setState({ tabs: { 'tab-1': tab } })
    useAppStore.getState().renameTab('tab-1', '')
    expect(useAppStore.getState().tabs['tab-1']!.name).toBeUndefined()
  })

  it('对不存在的 tab 是无操作，不新建条目', () => {
    useAppStore.getState().renameTab('missing', '名')
    expect('missing' in useAppStore.getState().tabs).toBe(false)
  })
})

describe('持久化：两个名字都写进 partialize，重开还在', () => {
  it('agentNames 与 Tab.name 都被 partialize 捕获', () => {
    const tab = { ...createWorkbenchTab('tab-1', agentSurface('region-0', 'agent-1')), name: 'Tab 名' }
    useAppStore.setState({ tabs: { 'tab-1': tab } })
    useAppStore.getState().renameAgent('agent-1', 'Agent 名')

    const partialize = useAppStore.persist.getOptions().partialize
    expect(partialize).toBeTypeOf('function')
    const persisted = partialize!(useAppStore.getState()) as {
      agentNames: Record<string, string>
      restoredWorkbench: { tabs: Record<string, { name?: string }> }
    }
    // Agent 名单独一档持久化。
    expect(persisted.agentNames['agent-1']).toBe('Agent 名')
    // Tab 名随 WorkbenchTab 一起进 restoredWorkbench——它是 Tab 的字段，与 Tab 同生命周期。
    expect(persisted.restoredWorkbench.tabs['tab-1']!.name).toBe('Tab 名')
  })
})
