import { describe, expect, it, vi } from 'vitest'

// WorkbenchTabContextMenu 现在经 clipboard-copy 引到 api，api 在模块加载时判断宿主。先立起这个全局，
// 否则下面对组件模块的静态 import 会撞 requireDesktopApi 的 window.agentmux。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { createWorkbenchTabCopyModel } from '../src/renderer/src/components/WorkbenchTabContextMenu.js'
import { createRegionCopyModel } from '../src/renderer/src/components/RegionContextMenu.js'
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

describe('Tab object link and unique Agent identity', () => {
  it('encodes the exact complete work surface as one link', async () => {
    const write = vi.fn(async (_text: string) => {})
    const model = createWorkbenchTabCopyModel({ tabId: '--tab id$quoted', agentSessionId: null, writeClipboardText: write })
    expect(model.tabAddress.label).toBe('Copy Tab Link')
    await model.tabAddress.onSelect()
    expect(write).toHaveBeenCalledExactlyOnceWith('amux://tab/--tab%20id%24quoted')
  })
  it('only exposes Agent identity when the complete Tab has one unique Agent', async () => {
    const same = copyableAgentSessionIdForTab(tabWithAgentSessions('agent-1', 'agent-1'))
    expect(same).toBe('agent-1')
    const write = vi.fn(async (_text: string) => {})
    const model = createWorkbenchTabCopyModel({ tabId: 'tab', agentSessionId: same, writeClipboardText: write })
    expect(model.entries.map(entry => entry.action.label)).toEqual(['Copy Agent Link', 'Copy Tab Link'])
    await model.sessionAddress!.onSelect()
    expect(write).toHaveBeenCalledExactlyOnceWith('amux://agent/agent-1')
    const multiple = copyableAgentSessionIdForTab(tabWithAgentSessions('agent-1', 'agent-2'))
    expect(multiple).toBeNull()
    expect(createWorkbenchTabCopyModel({ tabId: 'tab', agentSessionId: multiple, writeClipboardText: write }).sessionAddress).toBeUndefined()
    const terminal = createWorkbenchTab('terminal', { regionId: 'r', kind: 'terminal', phase: 'attached', workspaceId: 'w', sessionId: 'terminal-1' })
    expect(copyableAgentSessionIdForTab(terminal)).toBeNull()
  })
  it('Tab and Region menus share the same stable Agent link, with independent spatial links', async () => {
    const tabCopy = vi.fn(async (_text: string) => {})
    const regionCopy = vi.fn(async (_text: string) => {})
    const tab = createWorkbenchTabCopyModel({ tabId: 'view:x', agentSessionId: 'agent-7', writeClipboardText: tabCopy })
    const region = createRegionCopyModel({ regionId: 'region:y', agentSessionId: 'agent-7', writeClipboardText: regionCopy })
    await tab.sessionAddress!.onSelect(); await region.sessionAddress!.onSelect()
    expect(tabCopy).toHaveBeenCalledExactlyOnceWith('amux://agent/agent-7')
    expect(regionCopy).toHaveBeenCalledExactlyOnceWith('amux://agent/agent-7')
    await tab.tabAddress.onSelect(); await region.regionAddress.onSelect()
    expect(tabCopy).toHaveBeenLastCalledWith('amux://tab/view%3Ax')
    expect(regionCopy).toHaveBeenLastCalledWith('amux://region/region%3Ay')
  })
})
