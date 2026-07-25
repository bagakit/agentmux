import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canStopSessionRun, sessionTabTooltip } from '../src/renderer/src/lib/session-metadata.js'

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
    expect(workspaceWorkbenchSource).toContain('agentmux inspect --tab ${tab.id}')
    expect(workspaceWorkbenchSource).toContain('agentmux send --to-tab ${tab.id} --text "..."')
    expect(workspaceWorkbenchSource).toContain('MESSAGE_TARGET_NOT_UNIQUE')
    expect(workspaceWorkbenchSource).toContain('agentmux list sessions')
    expect(workspaceWorkbenchSource).toContain('agentmux send --to-session <session-id> --text "..."')
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
