import { describe, expect, it, vi } from 'vitest'

// WorkbenchTabContextMenu 现在经 clipboard-copy 引到 api，api 在模块加载时判断宿主。先立起这个全局，
// 否则下面对组件模块的静态 import 会撞 requireDesktopApi 的 window.agentmux。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { createWorkbenchTabCopyModel } from '../src/renderer/src/components/WorkbenchTabContextMenu.js'
import { createRegionCopyModel } from '../src/renderer/src/components/RegionContextMenu.js'
import {
  formatMessagingAddress,
  formatSessionAddress,
  formatViewAddress
} from '../src/renderer/src/lib/agent-address.js'
import { copyableAgentSessionIdForTab } from '../src/renderer/src/lib/tab-control-handoff.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  type AgentWorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'

function agentSurface(regionId: string, sessionId: string): AgentWorkbenchSurface {
  return {
    regionId,
    kind: 'agent',
    phase: 'attached',
    workspaceId: 'workspace',
    sessionId
  }
}

function tabWithAgentSessions(...sessionIds: string[]): WorkbenchTab {
  let tab = createWorkbenchTab('tab', agentSurface('region-0', sessionIds[0]!))
  sessionIds.slice(1).forEach((sessionId, index) => {
    const regionId = `region-${index + 1}`
    tab = addWorkbenchRegion(tab, tab.layout.activeRegionId, 'right', agentSurface(regionId, sessionId))
  })
  return tab
}

describe('Tab 地址：哪张完整工作面', () => {
  it('把带前导横线与 shell 元字符的 id 转义到可直接执行', () => {
    const address = formatViewAddress("--tab id$'quoted")
    const quoted = `'--tab id$'"'"'quoted'`
    expect(address).toContain(`agentmux inspect --tab=${quoted}`)
    expect(address).toContain(`agentmux send --to-tab=${quoted} --text "..."`)
  })

  it('复制出的是地址而非裸 id，且经唯一 formatter', async () => {
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const model = createWorkbenchTabCopyModel({
      tabId: 'tab',
      agentSessionId: null,
      writeClipboardText
    })
    expect(model.viewAddress.label).toBe('Copy View Address')
    await model.viewAddress.onSelect()
    const copied = writeClipboardText.mock.calls[0]![0]
    expect(copied).toBe(formatViewAddress('tab'))
    // 裸 id 不构成寻址方式：地址必须自带可执行命令。
    expect(copied).not.toBe('tab')
    expect(copied).toContain('agentmux send --to-tab=')
  })

  // 唯一性判定本身没变：整张 View 承载多个不同 Agent 时，没有无歧义的 Session 地址可给，
  // 此时该去那一格上右键取 Region 地址。
  it('只有整张 View 恰好一个 Agent 时才给 Session 地址', async () => {
    const terminalOnly = createWorkbenchTab('terminal-tab', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: 'terminal-1'
    })
    expect(copyableAgentSessionIdForTab(terminalOnly)).toBeNull()

    const singleSessionId = copyableAgentSessionIdForTab(tabWithAgentSessions('agent-1', 'agent-1'))
    expect(singleSessionId).toBe('agent-1')
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const singleModel = createWorkbenchTabCopyModel({
      tabId: 'tab',
      agentSessionId: singleSessionId,
      writeClipboardText
    })
    expect(singleModel.sessionAddress?.label).toBe('Copy Session Address')
    await singleModel.sessionAddress?.onSelect()
    expect(writeClipboardText).toHaveBeenCalledWith(formatSessionAddress('agent-1'))

    const multiple = copyableAgentSessionIdForTab(tabWithAgentSessions('agent-1', 'agent-2'))
    expect(multiple).toBeNull()
    expect(createWorkbenchTabCopyModel({
      tabId: 'tab',
      agentSessionId: multiple,
      writeClipboardText
    }).sessionAddress).toBeUndefined()
  })
})

// Tab 菜单与 Region 菜单是同一份真相的两个入口，不是两套格式。裸 id 不构成寻址方式：
// 接收方拿到 `session:abc` 无从知道该配哪个 flag，而那正是这次复制本该省掉的一步。
describe('Tab 菜单与 Region 菜单同源', () => {
  it('同一个 Session 从两处复制出的地址逐字相同', async () => {
    const fromTab = vi.fn(async (_text: string) => {})
    const tabModel = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: 'agent-7',
      writeClipboardText: fromTab
    })
    await tabModel.sessionAddress?.onSelect()

    const fromRegion = vi.fn(async (_text: string) => {})
    const regionModel = createRegionCopyModel({
      regionId: 'region:y',
      agentSessionId: 'agent-7',
      writeClipboardText: fromRegion
    })
    await regionModel.sessionAddress?.onSelect()

    expect(fromTab.mock.calls[0]![0]).toBe(fromRegion.mock.calls[0]![0])
    expect(fromTab.mock.calls[0]![0]).toBe(formatSessionAddress('agent-7'))
  })

  it('View 地址如实声明前提，并在多 Agent 时指向 Region 而非让接收方消歧', async () => {
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: null,
      writeClipboardText
    })
    await model.viewAddress.onSelect()
    const copied = writeClipboardText.mock.calls[0]![0]

    expect(copied).toBe(formatViewAddress('view:x'))
    expect(copied.toLowerCase()).toContain('exactly one')
    expect(copied).toMatch(/Region/u)
    // 旧 handoff 把消歧甩给接收方，新地址不这么干。
    expect(copied).not.toContain('MESSAGE_TARGET_NOT_UNIQUE')
  })

  it('同一个 Session 从两处交接出去，Tab 侧给 Session、Region 侧给那一格', async () => {
    // 两处共用同一个交接出口，但解析结果**有意不同**：Region 菜单知道用户点的是哪一格，
    // 那个信息接收方没有，所以在源头就该消歧；Tab 菜单没有这个信息，于是落到跨 View
    // 稳定的 Session。把 Region 侧也退化成 Session，等于把已知的东西丢掉。
    const fromTab = vi.fn(async (_text: string) => {})
    const tabModel = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: 'agent-7',
      writeClipboardText: fromTab
    })
    expect(tabModel.handoff?.label).toBe('Message this Agent')
    await tabModel.handoff?.onSelect()
    expect(fromTab).toHaveBeenCalledWith(formatMessagingAddress({ agentSessionId: 'agent-7' }))
    expect(fromTab.mock.calls[0]![0]).toBe(formatSessionAddress('agent-7'))

    const fromRegion = vi.fn(async (_text: string) => {})
    await createRegionCopyModel({
      regionId: 'region:y',
      agentSessionId: 'agent-7',
      writeClipboardText: fromRegion
    }).handoff?.onSelect()
    expect(fromRegion.mock.calls[0]![0]).toContain("--to-region='region:y'")
    expect(fromRegion.mock.calls[0]![0]).not.toBe(fromTab.mock.calls[0]![0])
  })

  it('没有可交接的 Agent 时交接入口缺席，不画禁用的假按钮', () => {
    // 多 Agent 的 View 同样没有唯一目标——此时该去那一格上右键，而不是给一个点了会错的入口。
    for (const agentSessionId of [null, copyableAgentSessionIdForTab(tabWithAgentSessions('agent-1', 'agent-2'))]) {
      expect(createWorkbenchTabCopyModel({
        tabId: 'view:x',
        agentSessionId,
        writeClipboardText: vi.fn(async () => {})
      }).handoff).toBeUndefined()
    }
  })

  it('不再产出裸 id——那不是寻址方式', () => {
    const model = createWorkbenchTabCopyModel({
      tabId: 'view:x',
      agentSessionId: 'agent-7',
      writeClipboardText: vi.fn(async () => {})
    })
    expect('tabId' in model).toBe(false)
    expect('sessionId' in model).toBe(false)
    expect('agentHandoff' in model).toBe(false)
  })
})
