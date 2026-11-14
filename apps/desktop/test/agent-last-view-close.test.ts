import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  agentSessionsWithoutViewsAfterClosing,
  closingWorkbenchRegion,
  closingWorkbenchTabs,
  planWorkbenchViewClose
} from '../src/renderer/src/lib/workbench-view-close.js'
import { lastViewCloseConfirmation, lastViewCloseCopy } from '../src/renderer/src/lib/last-view-close-confirmation.js'

function agentSession(id: string, processState: SessionSnapshot['processState'] = 'running'): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: _hygiene_fixturePath('repo'),
    label: `Codex ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState,
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `${id}-run` } }
  }
}

function agentSurface(regionId: string, sessionId: string): WorkbenchSurface {
  return { regionId, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId }
}

function browserSurface(
  regionId: string,
  binding: { agent?: { hostId: string; agentSessionId: string } | null; control?: { hostId: string; agentSessionId: string } | null | 'absent' }
): WorkbenchSurface {
  return {
    id: `${regionId}-browser`,
    navigationId: `${regionId}:navigation`,
    regionId,
    kind: 'browser',
    workspaceId: 'workspace',
    browserId: `${regionId}-browser`,
    profileId: null,
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: 'responsive',
    error: null,
    ...(binding.agent === undefined ? {} : { agent: binding.agent }),
    ...(binding.control === undefined
      ? {}
      : { control: {
          owner: 'human', activeOperationId: null, revision: 1, inputIsolation: 'inactive',
          ...(binding.control === 'absent' ? {} : { agent: binding.control })
        } })
  } as WorkbenchSurface
}

function splitTab(id: string, left: WorkbenchSurface, right: WorkbenchSurface): WorkbenchTab {
  return addWorkbenchRegion(createWorkbenchTab(id, left), left.regionId, 'right', right)
}

function singleTab(id: string, surface: WorkbenchSurface): WorkbenchTab {
  return createWorkbenchTab(id, surface)
}

const bound = (agentSessionId: string) => ({ hostId: 'local', agentSessionId })

describe('closing an Agent’s last View, from every entry', () => {
  it('a split Region that is the Agent’s only View asks; the Agent is affected, not the sibling', () => {
    const agent = agentSession('agent-1')
    const tab = splitTab('tab', agentSurface('agent-region', agent.id), agentSurface('other-region', 'agent-2'))
    const affected = agentSessionsWithoutViewsAfterClosing({
      tabs: { tab },
      sessions: [agent, agentSession('agent-2')],
      isClosing: closingWorkbenchRegion('tab', 'agent-region')
    })
    expect(affected.sessions.map((session) => session.id)).toEqual(['agent-1'])
    expect(affected.unconfirmed).toEqual([])
  })

  it('another attached View of the same Agent keeps the split close silent', () => {
    const agent = agentSession('agent-1')
    const tab = splitTab('tab', agentSurface('agent-region', agent.id), agentSurface('file-like', 'agent-2'))
    const elsewhere = singleTab('elsewhere', agentSurface('elsewhere-region', agent.id))
    const affected = agentSessionsWithoutViewsAfterClosing({
      tabs: { tab, elsewhere },
      sessions: [agent, agentSession('agent-2')],
      isClosing: closingWorkbenchRegion('tab', 'agent-region')
    })
    expect(affected.sessions).toEqual([])
  })

  it('a Browser bound to the Agent counts as its other View', () => {
    const agent = agentSession('agent-1')
    const tab = splitTab('tab', agentSurface('agent-region', agent.id), agentSurface('sibling', 'agent-2'))
    const browser = singleTab('browser-tab', browserSurface('browser-region', { control: bound(agent.id) }))
    const affected = agentSessionsWithoutViewsAfterClosing({
      tabs: { tab, 'browser-tab': browser },
      sessions: [agent, agentSession('agent-2')],
      isClosing: closingWorkbenchRegion('tab', 'agent-region')
    })
    expect(affected.sessions).toEqual([])
  })

  it('closing a Browser Region bound to a live Agent with no other View names that Agent', () => {
    const agent = agentSession('agent-1')
    const tab = splitTab('tab', browserSurface('browser-region', { control: bound(agent.id) }), agentSurface('sibling', 'agent-2'))
    const affected = agentSessionsWithoutViewsAfterClosing({
      tabs: { tab },
      sessions: [agent, agentSession('agent-2')],
      isClosing: closingWorkbenchRegion('tab', 'browser-region')
    })
    expect(affected.sessions.map((session) => session.id)).toEqual(['agent-1'])
  })

  it('current control outranks cold metadata; a confirmed null binding names nobody', () => {
    const agent = agentSession('agent-1')
    const released = singleTab('tab', browserSurface('browser-region', { agent: bound(agent.id), control: null }))
    expect(agentSessionsWithoutViewsAfterClosing({
      tabs: { tab: released }, sessions: [agent], isClosing: closingWorkbenchTabs(['tab'])
    })).toEqual({ sessions: [], unconfirmed: [] })
    const cold = singleTab('tab', browserSurface('browser-region', { agent: bound(agent.id) }))
    expect(agentSessionsWithoutViewsAfterClosing({
      tabs: { tab: cold }, sessions: [agent], isClosing: closingWorkbenchTabs(['tab'])
    }).sessions.map((session) => session.id)).toEqual(['agent-1'])
  })

  it('an unknown binding still asks and is unconfirmed, never stopped', () => {
    const agent = agentSession('agent-1')
    const unknownBinding = singleTab('tab', browserSurface('browser-region', { control: 'absent' }))
    const missingSession = singleTab('other', browserSurface('other-region', { control: bound('gone') }))
    const affected = agentSessionsWithoutViewsAfterClosing({
      tabs: { tab: unknownBinding, other: missingSession },
      sessions: [agent],
      isClosing: closingWorkbenchTabs(['tab', 'other'])
    })
    expect(affected.sessions).toEqual([])
    expect(affected.unconfirmed.map((item) => item.agentSessionId)).toEqual([null, 'gone'])
    const confirmation = lastViewCloseConfirmation({
      tabs: { tab: unknownBinding }, sessions: [agent], timelines: {}, agentNames: {},
      isClosing: closingWorkbenchTabs(['tab']), dirtyCount: 0
    })!
    const copy = lastViewCloseCopy(confirmation, 'tab')
    expect(copy.description).toContain('could not be confirmed')
    expect(copy.secondaryLabel).toBeUndefined()
    expect(copy.confirmLabel).toBe('Close')
  })

  it('an exited Run does not ask', () => {
    const agent = agentSession('agent-1', 'exited')
    const tab = splitTab('tab', agentSurface('agent-region', agent.id), agentSurface('sibling', 'agent-2'))
    expect(agentSessionsWithoutViewsAfterClosing({
      tabs: { tab }, sessions: [agent, agentSession('agent-2')],
      isClosing: closingWorkbenchRegion('tab', 'agent-region')
    }).sessions).toEqual([])
  })

  it('Tab close plans the Browser-bound Agent’s stop and holds the Browser Region on that stop', () => {
    const agent = agentSession('agent-1')
    const tab = singleTab('tab', browserSurface('browser-region', { control: bound(agent.id) }))
    const plan = planWorkbenchViewClose({
      tabs: { tab },
      layouts: { workspace: createWorkspaceLayout('pane', ['tab']) },
      sessions: [agent],
      workspaceId: 'workspace',
      tabGroupId: 'pane',
      tabId: 'tab',
      keepAgentSessions: false
    })!
    expect(plan.resources.map((resource) => resource.key)).toEqual(['browser:browser-region-browser', 'session:agent-1'])
    expect(plan.surfaces[0]!.resourceKeys).toEqual(['browser:browser-region-browser', 'session:agent-1'])
    const kept = planWorkbenchViewClose({
      tabs: { tab },
      layouts: { workspace: createWorkspaceLayout('pane', ['tab']) },
      sessions: [agent],
      workspaceId: 'workspace',
      tabGroupId: 'pane',
      tabId: 'tab',
      keepAgentSessions: true
    })!
    expect(kept.resources.map((resource) => resource.key)).toEqual(['browser:browser-region-browser'])
  })

  it('the confirmation names the exact Agents and the dirty-file sentence', () => {
    const agent = agentSession('agent-1')
    const tab = splitTab('tab', agentSurface('agent-region', agent.id), agentSurface('sibling', 'agent-2'))
    const confirmation = lastViewCloseConfirmation({
      tabs: { tab }, sessions: [agent, agentSession('agent-2')], timelines: {}, agentNames: { 'agent-1': 'Reviewer' },
      isClosing: closingWorkbenchRegion('tab', 'agent-region'), dirtyCount: 1
    })!
    const copy = lastViewCloseCopy(confirmation, 'split')
    expect(copy.title).toBe('Stop Agent Session?')
    expect(copy.description).toContain('Reviewer')
    expect(copy.description).toContain('Unsaved or retained editor contents in this split will be discarded.')
    expect(copy).toMatchObject({ confirmLabel: 'Stop & Close', secondaryLabel: 'Keep Session & Close' })
  })
})
