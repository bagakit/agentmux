import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import { reduceDetachedAgentLaunch, type SessionProjectionState } from '../src/renderer/src/lib/session-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { AgentLaunchResult, SessionSnapshot } from '../src/shared/contracts'
import { agentCreationFixture } from './helpers/agent-creation-fixture'

it.each([false, true])('a healthy receipt with missing display keeps its real Session, Run and pending correlation (different Session: %s)', different => {
  const requested = 'requested', actual = different ? 'actual-other' : requested
  const tab = createWorkbenchTab('local-display', { kind: 'agent', phase: 'launching', workspaceId: 'remote-workspace', regionId: 'pending-region', sessionId: requested })
  const state: SessionProjectionState = { tabs: { [tab.id]: tab }, layouts: {}, sessions: [], timelines: {}, viewModes: {},
    pendingAgentLaunches: { [requested]: { request: { executorId: 'remote', hostId: 'remote', workspacePath: _hygiene_fixturePath("remote/repo"), prompt: 'once' }, events: [], overflowed: false } } }
  const session = { id: actual, kind: 'agent', providerId: 'claude', executorId: 'remote', hostId: 'remote', workspacePath: _hygiene_fixturePath("remote/repo"), label: 'Remote',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'agent', hostId: 'remote', agentSessionId: actual, run: { runId: 'real-remote-run' } }
  } satisfies Extract<SessionSnapshot, { kind: 'agent' }>
  const result: AgentLaunchResult = { created: { ...agentCreationFixture(session), creation: { createOperationId: 'original-operation', initialPrompt: 'unconfirmed' } },
    session, projectionFailures: [{ step: 'timeline', message: 'Observer disappeared' }] }
  const reduced = reduceDetachedAgentLaunch(state, result)
  expect(reduced.state.sessions).toEqual([session])
  expect(reduced.state.tabs).toBe(state.tabs)
  expect(reduced.state.tabs[tab.id]!.regions['pending-region']).toMatchObject({ phase: 'launching', sessionId: requested, workspaceId: 'remote-workspace' })
  expect(reduced.state.pendingAgentLaunches[actual]).toMatchObject({ created: { agentSessionId: actual, run: { runId: 'real-remote-run' }, creation: { createOperationId: 'original-operation' } },
    projectionFailures: [{ step: 'timeline', message: 'Observer disappeared' }] })
  expect(reduced.state.pendingAgentLaunches[requested]!.request?.prompt).toBe('once')
  expect(reduced.timelineGapSessionId).toBe(actual)
})
