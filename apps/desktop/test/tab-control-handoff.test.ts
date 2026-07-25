import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchTabCopyModel } from '../src/renderer/src/components/WorkbenchTabContextMenu.js'
import {
  copyableAgentSessionIdForTab,
  formatAgentMuxTabHandoff
} from '../src/renderer/src/lib/tab-control-handoff.js'
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

describe('Tab Control handoff', () => {
  it('round-trips leading dashes and shell metacharacters through flag-value commands', () => {
    const handoff = formatAgentMuxTabHandoff("--tab id$'quoted")
    const quotedTabId = `'--tab id$'"'"'quoted'`
    expect(handoff).toContain(`agentmux inspect --tab=${quotedTabId}`)
    expect(handoff).toContain(`agentmux send --to-tab=${quotedTabId} --text "..."`)
    expect(handoff).toContain('MESSAGE_TARGET_NOT_UNIQUE')
    expect(handoff).toContain('choose an agentSessionId from the error candidates')
    expect(handoff).toContain('agentmux send --to-session <agentSessionId> --text "..."')
    expect(handoff).not.toContain('agentmux list sessions')
  })

  it('executes the menu copy model with raw Tab identity and the formatted handoff', async () => {
    const tabId = "--tab id$'quoted"
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const copyModel = createWorkbenchTabCopyModel({
      tabId,
      agentSessionId: null,
      writeClipboardText
    })

    expect(copyModel.tabId.label).toBe('Copy Tab ID')
    expect(copyModel.agentHandoff.label).toBe('Copy Agent Handoff')
    expect(copyModel.sessionId).toBeUndefined()
    await copyModel.tabId.onSelect()
    await copyModel.agentHandoff.onSelect()
    expect(writeClipboardText).toHaveBeenNthCalledWith(1, tabId)
    expect(writeClipboardText).toHaveBeenNthCalledWith(2, formatAgentMuxTabHandoff(tabId))
  })

  it('exposes Copy Session ID only for one distinct Agent Session in the whole Tab', async () => {
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
    const singleSessionModel = createWorkbenchTabCopyModel({
      tabId: 'tab',
      agentSessionId: singleSessionId,
      writeClipboardText
    })
    expect(singleSessionModel.sessionId?.label).toBe('Copy Session ID')
    await singleSessionModel.sessionId?.onSelect()
    expect(writeClipboardText).toHaveBeenCalledWith('agent-1')

    const multipleSessionId = copyableAgentSessionIdForTab(tabWithAgentSessions('agent-1', 'agent-2'))
    expect(multipleSessionId).toBeNull()
    expect(createWorkbenchTabCopyModel({
      tabId: 'tab',
      agentSessionId: multipleSessionId,
      writeClipboardText
    }).sessionId).toBeUndefined()
  })
})
