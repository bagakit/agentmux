// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { RuntimeEvent } from '../src/shared/contracts'
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => <div data-original-body="">Old retained body</div> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal="" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-original-composer="" /> }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
const dom = composerDOM(), target = { hostId: 'local', agentSessionId: 'original-session' }
let listeners: Set<(event: RuntimeEvent) => void>
beforeEach(() => {
  listeners = new Set(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue({ sources: [], warnings: [] })
})
it('an exact Core deletion event outranks a stale active Session presentation without removing original Store identity, workface or local inputs', async () => {
  const session = composerSession(target.agentSessionId), tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', sessionId: session.id, workspaceId: 'workspace', regionId: 'original-region' })
  const sessions = [session], tabs = { [tab.id]: tab }, drafts = { 'unbound-original-region': 'Unsent original draft' }, queues = { [session.id]: [{ operationId: 'old-queue', text: 'Unsent original queue', status: 'deferred' as const }] }
  useAppStore.setState({ sessions, tabs, timelines: {}, pendingAgentLaunches: {}, recoveryCandidates: [], agentComposerDrafts: drafts, agentSteerQueues: queues, viewModes: { [session.id]: 'activity' } })
  const reopen = vi.spyOn(api.sessions, 'reopen'), stop = vi.spyOn(api.sessions, 'stop'), snapshot = vi.spyOn(api.sessions, 'snapshot')
  await dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible readOnly linkOrigin={{ workspaceId: 'workspace', tabId: tab.id, regionId: 'original-region', tabGroupId: 'original-group' }} />)
  expect(dom.container.querySelector('[data-original-body]'), 'delete-stale-active-fixture-is-real').not.toBeNull()
  const fact = { type: 'agent-session-record-deleted' as const, agentSessionId: target.agentSessionId, retiredAt: 1,
    recordDeletion: { operationId: 'original-delete', retirementRevision: '1'.repeat(64), deletedAt: 2, phase: 'pending' as const } }
  await act(async () => { for (const listener of listeners) listener({ type: 'core', hostId: 'another-host', event: fact }) })
  expect(dom.container.querySelector('[data-original-body]'), 'delete-foreign-host-fact-does-not-take-away-original-capability').not.toBeNull()
  const pendingAgentLaunches = { [session.id]: { request: { executorId: 'codex', hostId: target.hostId, createOperationId: 'original-create-request' }, events: [], overflowed: false, created: agentCreationFixture(session),
    projectionFailures: [] } }
  useAppStore.setState({ pendingAgentLaunches })
  await act(async () => { for (const listener of listeners) listener({ type: 'core', hostId: target.hostId, event: fact }) })
  expect(dom.container.querySelector('[data-agent-surface-mode="deleted-record"]'), 'delete-exact-terminal-outranks-stale-active-projection').not.toBeNull()
  expect(dom.container.querySelector('[data-original-body]')).toBeNull(); expect(dom.container.querySelector('[data-original-terminal]')).toBeNull(); expect(dom.container.querySelector('[data-original-composer]')).toBeNull()
  expect(useAppStore.getState().pendingAgentLaunches, 'delete-keeps-original-created-operation-reference').toBe(pendingAgentLaunches)
  expect(useAppStore.getState().sessions).toBe(sessions); expect(useAppStore.getState().tabs).toBe(tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); expect(useAppStore.getState().agentSteerQueues).toBe(queues)
  expect(reopen).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
})
