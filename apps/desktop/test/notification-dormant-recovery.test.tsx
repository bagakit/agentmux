// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
import type { AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { dormantByRecoveryPolicy } from '../src/renderer/src/lib/continuity-supervision'
import { runEndedByRuntimeRestart } from '../src/renderer/src/lib/session-recovery-banner'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { currentNotificationRows, selectNotificationView, toggleNotificationCenter } from './helpers/notification-center'

/**
 * A startup recovery that Core stopped before its first attempt because the Agent was idle past the
 * automatic window (or for an unknown time) is the recovery policy working as intended. The global
 * notification center does not list that Agent's Session notices; its own work surface keeps them
 * with Resume. Carried input, an unsent message, or any other recovery state is still a problem.
 */
const dom = composerDOM()
type Agent = ReturnType<typeof composerSession>
type Intent = Partial<AgentMuxContinuityOperation> & { supervision?: Partial<NonNullable<AgentMuxContinuityOperation['supervision']>> }

function agent(id: string, intent: Intent = {}, processState: Agent['processState'] = 'interrupted'): Agent {
  const session = composerSession(id)
  const root = { operationId: `${id}-startup`, agentSessionId: session.id, trigger: 'startup', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
    previousRun: session.control.run, admittedAt: 1, observedAt: 2, rechecks: 0, kind: 'pending', reason: 'idle-window-expired',
    evidence: { kind: 'run-ended', state: 'interrupted', observedAt: 1 }, ...intent,
    supervision: { phase: 'paused', activeAttemptOperationId: `${id}-startup`, attemptCount: 0, attemptLimit: 4, observedAt: 2,
      reason: intent.reason ?? 'idle-window-expired', ...intent.supervision } } as AgentMuxContinuityOperation
  return { ...session, label: `Agent ${id}`, processState, status: { state: 'error', source: 'run-process', observedAt: 1 },
    continuity: root, continuityOperations: { [root.operationId]: root } } as Agent
}

beforeEach(() => useAppStore.setState({ loading: false, sessions: [], tabs: {}, notificationEvents: [], noticeReadReceipts: {},
  error: null, lastError: null, errorNoticeContext: null, errorDismissed: false, environmentWarning: undefined,
  runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [], displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {} }))

const listed = async () => {
  await dom.render(<GlobalSystemNotices />)
  await toggleNotificationCenter(dom.container, 'open')
  await selectNotificationView(dom.container, 'current')
  return currentNotificationRows(dom.container).map(row => row.textContent ?? '')
}

it('an Agent left unresumed by the idle policy raises nothing in Current, and keeps its notice on its own surface', async () => {
  const restarted: Agent = { ...agent('runtime-restarted'), interruptionReason: 'daemon_restart' }
  const dormant = [agent('idle-expired'), agent('idle-unknown', { reason: 'idle-unknown' }), agent('exited-idle', {}, 'exited'), restarted]
  useAppStore.setState({ sessions: dormant })
  expect(dormant.map(dormantByRecoveryPolicy)).toEqual([true, true, true, true])
  expect(runEndedByRuntimeRestart(restarted)).toBe(true)
  expect(await listed()).toEqual([])
  // The Agent's own work surface consumes the same Session notices directly: Resume stays reachable there.
  for (const session of dormant) expect(sessionServiceNotices(session).map(item => item.id)).toContain('continuity-supervision')
})

it('carried input, an unsent message, a running Run or another recovery state is still a current problem', async () => {
  const problems = [
    agent('carried-input', { previousInput: { outcome: 'unknown' } } as Intent),
    agent('running', {}, 'running'),
    agent('active-delay', { reason: 'active-delay' }),
    // Only a startup admission is the idle policy at work; another automatic trigger stays a problem.
    agent('progress', { trigger: 'progress' }),
    agent('input-trigger', { trigger: 'input' }),
    agent('attempted', { supervision: { attemptCount: 1 } }),
    agent('observing', { supervision: { phase: 'observing' } })
  ]
  for (const session of problems) expect(dormantByRecoveryPolicy(session), session.id).toBe(false)
  const queued = agent('unsent-message')
  useAppStore.setState({ sessions: [...problems, queued], agentSteerQueues: { [queued.id]: [{ operationId: 'original-unsent', text: 'Original unsent message',
    status: 'queued', runId: queued.control.run.runId, promptCondition: null }] } })
  const rows = await listed()
  for (const session of problems) expect(rows.some(row => row.includes(session.label)), session.id).toBe(true)
  // The dormant Agent's other notices stay quiet; its unsent message is still the person's data.
  expect(rows.filter(row => row.includes(queued.label))).toHaveLength(1)
})
