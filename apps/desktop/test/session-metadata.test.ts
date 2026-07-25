import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { canStopSessionRun, sessionTabTooltip } from '../src/renderer/src/lib/session-metadata.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  type AgentWorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    () => { throw new Error('The Workbench store is not used by these pure behavior tests.') },
    { getState: () => ({}) }
  )
}))
vi.mock('../src/renderer/src/components/SessionPane.js', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/NewTabSurface.js', () => ({ NewTabSurface: () => null }))

import {
  copyableAgentSessionIdForTab,
  formatAgentMuxTabHandoff
} from '../src/renderer/src/components/WorkspaceWorkbench.js'

const sessionPaneSource = readFileSync(
  new URL('../src/renderer/src/components/SessionPane.tsx', import.meta.url),
  'utf8'
)
const workspaceWorkbenchSource = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
  'utf8'
)
const workbenchTabMenuSource = readFileSync(
  new URL('../src/renderer/src/components/WorkbenchTabContextMenu.tsx', import.meta.url),
  'utf8'
)

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

describe('single-line session tab projection', () => {
  it('keeps low-frequency session metadata in the tab tooltip', () => {
    const tooltip = sessionTabTooltip({
      label: 'codex · agentmux',
      id: 'd1df756e-18f5-4d3e-b309-0635b8d2999b',
      hostId: 'local',
      createdAt: 0,
      updatedAt: 60_000
    })

    expect(tooltip).toContain('codex · agentmux')
    expect(tooltip).toContain('Session ID: d1df756e-18f5-4d3e-b309-0635b8d2999b')
    expect(tooltip).toContain('Host: local')
    expect(tooltip).toContain('Started:')
    expect(tooltip).toContain('Active:')
  })

  it('keeps Stop Run available until the process has exited', () => {
    expect(canStopSessionRun({ processState: 'running' })).toBe(true)
    expect(canStopSessionRun({ processState: 'interrupted' })).toBe(true)
    expect(canStopSessionRun({ processState: 'exited' })).toBe(false)
  })

  it('keeps SessionPane chrome-free and owns Run actions in the pane tabbar', () => {
    expect(sessionPaneSource).not.toContain('session-info-bar')
    expect(sessionPaneSource).not.toContain('Stop Run')
    expect(workspaceWorkbenchSource).toContain('pane-action pane-action--stop')
    expect(workbenchTabMenuSource).toContain('Copy Session ID')
  })

  it('copies the exact Tab identity and an actionable Agent handoff from every Tab menu', () => {
    expect(workbenchTabMenuSource).toContain('Copy Tab ID')
    expect(workbenchTabMenuSource).toContain('Copy Agent Handoff')
    expect(workspaceWorkbenchSource).toContain('api.ui.writeClipboardText(tab.id)')

    const handoff = formatAgentMuxTabHandoff("tab id$'quoted")
    const quotedTabId = `'tab id$'"'"'quoted'`
    expect(handoff).toContain(`agentmux inspect --tab ${quotedTabId}`)
    expect(handoff).toContain(`agentmux send --to-tab ${quotedTabId} --text "..."`)
    expect(handoff).toContain('MESSAGE_TARGET_NOT_UNIQUE')
    expect(handoff).toContain('choose an agentSessionId from the error candidates')
    expect(handoff).toContain('agentmux send --to-session <agentSessionId> --text "..."')
    expect(handoff).not.toContain('agentmux list sessions')
  })

  it('offers Copy Session ID only for one distinct Agent Session across the Tab', () => {
    const terminalOnly = createWorkbenchTab('terminal-tab', {
      regionId: 'terminal-region',
      kind: 'terminal',
      phase: 'attached',
      workspaceId: 'workspace',
      sessionId: 'terminal-1'
    })
    expect(copyableAgentSessionIdForTab(terminalOnly)).toBeNull()
    expect(copyableAgentSessionIdForTab(tabWithAgentSessions('agent-1', 'agent-1'))).toBe('agent-1')
    expect(copyableAgentSessionIdForTab(tabWithAgentSessions('agent-1', 'agent-2'))).toBeNull()
    expect(workspaceWorkbenchSource).toContain('copyableAgentSessionId ? { onCopySessionId:')
  })

  it('makes stopping the default Agent Tab close action while preserving an explicit background option', () => {
    expect(workspaceWorkbenchSource).toContain("'Stop & Close'")
    expect(workspaceWorkbenchSource).toContain("'Keep Session & Close'")
    expect(workspaceWorkbenchSource).toContain('sessionIdsWithoutViewsAfterClosingTabs')
  })

  it('uses a Terminal icon instead of an Agent status dot for Terminal tabs', () => {
    expect(workspaceWorkbenchSource).toContain(') : <SquareTerminal size={12} />')
    expect(workspaceWorkbenchSource).not.toContain('session ? <StatusDot status={session.status} />')
  })
})
