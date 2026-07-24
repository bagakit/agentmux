import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { resolveWorkbenchViewFocus } from '../src/renderer/src/lib/view-focus.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

function session(id: string, kind: 'agent' | 'terminal'): SessionSnapshot {
  const base = {
    id,
    hostId: 'local',
    workspacePath: '/repo',
    label: id,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running' as const,
    status: { state: 'running' as const, source: 'run-process' as const, observedAt: 1 },
    latestOutputBytes: 0
  }
  return kind === 'agent'
    ? {
        ...base,
        kind,
        agentId: 'codex',
        control: {
          kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `${id}-run` }
        }
      }
    : {
        ...base,
        kind,
        agentId: null,
        control: {
          kind: 'terminal', hostId: 'local', runId: `${id}-run`, run: { runId: `${id}-run` }
        }
      }
}

function tab(id: string, kind: 'agent' | 'terminal', sessionId: string): WorkbenchTab {
  return { id, kind, phase: 'attached', workspaceId: 'workspace', sessionId }
}

describe('Desktop typed View focus', () => {
  it('focuses an already-open Raw Terminal View or uniquely open Agent View', () => {
    const sessions = [session('semantic-1', 'agent'), session('terminal-1', 'terminal')]
    const tabs = {
      'agent-left': tab('agent-left', 'agent', 'semantic-1'),
      'terminal-left': tab('terminal-left', 'terminal', 'terminal-1')
    }
    const layouts = {
      workspace: createWorkspaceLayout('pane', ['agent-left', 'terminal-left'])
    }
    expect(resolveWorkbenchViewFocus({
      sessions, tabs, layouts, target: { kind: 'terminal-view', viewId: 'terminal-left' }
    })).toEqual({ viewId: 'terminal-left', kind: 'terminal', workspaceId: 'workspace', paneId: 'pane' })
    expect(resolveWorkbenchViewFocus({
      sessions, tabs, layouts, target: { kind: 'agent-session', agentSessionId: 'semantic-1' }
    })).toEqual({ viewId: 'agent-left', kind: 'agent', workspaceId: 'workspace', paneId: 'pane' })
  })

  it('rejects closed, stale, and ambiguous targets without opening anything', () => {
    const sessions = [session('semantic-1', 'agent')]
    const tabs = {
      'agent-left': tab('agent-left', 'agent', 'semantic-1'),
      'agent-right': tab('agent-right', 'agent', 'semantic-1'),
      stale: tab('stale', 'terminal', 'missing-terminal')
    }
    const layouts = {
      workspace: createWorkspaceLayout('pane', ['agent-left', 'agent-right', 'stale'])
    }
    const before = structuredClone({ sessions, tabs, layouts })
    expect(() => resolveWorkbenchViewFocus({
      sessions, tabs, layouts, target: { kind: 'agent-session', agentSessionId: 'semantic-1' }
    })).toThrow('ambiguous')
    expect(() => resolveWorkbenchViewFocus({
      sessions, tabs, layouts, target: { kind: 'terminal-view', viewId: 'stale' }
    })).toThrow('not currently open')
    expect(() => resolveWorkbenchViewFocus({
      sessions, tabs, layouts, target: { kind: 'terminal-view', viewId: 'closed' }
    })).toThrow('not currently open')
    expect({ sessions, tabs, layouts }).toEqual(before)
  })
})
