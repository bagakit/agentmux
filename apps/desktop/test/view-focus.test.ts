import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import {
  planControlOpen,
  resolveWorkbenchControlRegion
} from '../src/renderer/src/lib/control.js'
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

  it('resolves Launcher destinations through the open-only unique Region owner', () => {
    const openFile = createWorkbenchTab('open-file', {
      regionId: 'open-file-region',
      kind: 'file',
      workspaceId: 'workspace',
      path: 'README.md'
    })
    const orphanLauncher = createWorkbenchTab('orphan-launcher', {
      regionId: 'launcher-target',
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    const firstLauncher = createWorkbenchTab('first-launcher', {
      regionId: 'duplicate-launcher',
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    const secondLauncher = createWorkbenchTab('second-launcher', {
      regionId: 'duplicate-launcher',
      kind: 'launcher',
      workspaceId: 'workspace'
    })
    const nonLauncher = createWorkbenchTab('non-launcher', {
      regionId: 'non-launcher-region',
      kind: 'file',
      workspaceId: 'workspace',
      path: 'package.json'
    })
    const attempt = (tabs: Record<string, WorkbenchTab>, openTabIds: string[], regionId: string) => (
      planControlOpen({
        sessions: [],
        tabs,
        layouts: { workspace: createWorkspaceLayout('pane', openTabIds) }
      }, { kind: 'launcher', regionId }, undefined, 'new-tab', 'new-region')
    )

    expect(() => attempt({
      [openFile.id]: openFile,
      [orphanLauncher.id]: orphanLauncher
    }, [openFile.id], 'launcher-target')).toThrow(expect.objectContaining({ code: 'REGION_NOT_OPEN' }))
    expect(() => attempt({
      [firstLauncher.id]: firstLauncher,
      [secondLauncher.id]: secondLauncher
    }, [firstLauncher.id, secondLauncher.id], 'duplicate-launcher')).toThrow(expect.objectContaining({
      code: 'AMBIGUOUS_REGION_TARGET'
    }))
    expect(() => attempt({ [nonLauncher.id]: nonLauncher }, [nonLauncher.id], 'non-launcher-region'))
      .toThrow(expect.objectContaining({ code: 'LAUNCHER_REGION_REQUIRED' }))
  })
})
