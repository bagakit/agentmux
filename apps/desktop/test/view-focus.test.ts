import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { resolveWorkbenchControlRegion } from '../src/renderer/src/lib/control.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'

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
        providerId: 'codex',
        executorId: 'codex',
        capabilities: {
          terminal: true, hookEvents: true, timeline: 'streaming', permission: 'observe',
          providerResume: true, acp: false, replyCorrelation: 'none'
        },
        control: {
          kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `${id}-run` }
        }
      }
    : {
        ...base,
        kind,
        providerId: null,
        control: {
          kind: 'terminal', hostId: 'local', runId: `${id}-run`, run: { runId: `${id}-run` }
        }
      }
}

function tab(id: string, kind: 'agent' | 'terminal', sessionId: string): WorkbenchTab {
  return createWorkbenchTab(id, {
    regionId: initialWorkbenchRegionId(id),
    kind,
    phase: 'attached',
    workspaceId: 'workspace',
    sessionId
  })
}

describe('Desktop Control Region resolver', () => {
  it('resolves an already-open Terminal Region or uniquely open Agent Region', () => {
    const sessions = [session('semantic-1', 'agent'), session('terminal-1', 'terminal')]
    const tabs = {
      'agent-left': tab('agent-left', 'agent', 'semantic-1'),
      'terminal-left': tab('terminal-left', 'terminal', 'terminal-1')
    }
    const layouts = {
      workspace: createWorkspaceLayout('pane', ['agent-left', 'terminal-left'])
    }
    expect(resolveWorkbenchControlRegion({ sessions, tabs, layouts }, {
      kind: 'region', regionId: initialWorkbenchRegionId('terminal-left')
    })).toEqual({
      tabId: 'terminal-left',
      regionId: initialWorkbenchRegionId('terminal-left'),
      kind: 'terminal',
      runId: 'terminal-1-run',
      workspaceId: 'workspace',
    })
    expect(resolveWorkbenchControlRegion({ sessions, tabs, layouts }, { kind: 'self' }, {
      agentSessionId: 'semantic-1'
    })).toEqual({
      tabId: 'agent-left',
      regionId: initialWorkbenchRegionId('agent-left'),
      kind: 'agent',
      agentSessionId: 'semantic-1',
      providerId: 'codex',
      executorId: 'codex',
      workspaceId: 'workspace',
    })
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
    expect(() => resolveWorkbenchControlRegion({ sessions, tabs, layouts }, { kind: 'self' }, {
      agentSessionId: 'semantic-1'
    })).toThrow('multiple Regions')
    expect(() => resolveWorkbenchControlRegion({ sessions, tabs, layouts }, {
      kind: 'region', regionId: initialWorkbenchRegionId('stale')
    })).toThrow('stable Control projection')
    expect(() => resolveWorkbenchControlRegion({ sessions, tabs, layouts }, {
      kind: 'region', regionId: 'closed'
    })).toThrow('not currently open')
    expect({ sessions, tabs, layouts }).toEqual(before)
  })
})
