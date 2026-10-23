// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { AgentMuxAgentSession } from '@agentmux/core'
import type { AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
import { createContinuityInputDelivery } from '../../../packages/core/src/agent-session-recovery/input'
import { useAppStore } from '../src/renderer/src/store'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { composerSession, composerConfig } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


it('clears the original pending notice through actual Store Core event consumption', () => {
  const view = composerSession()
  const operation: AgentMuxContinuityOperation = {
    operationId: 'original-continuity', agentSessionId: view.id, trigger: 'startup', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
    previousRun: { runId: 'old-run' }, newRun: view.control.run,
    nativeTarget: { kind: 'provider', providerId: view.providerId, sessionId: 'original-native' },
    admittedAt: _historyFixtureEpoch(0, 0, 1), observedAt: _historyFixtureEpoch(0, 0, 2), rechecks: 0, interruptedWorking: true, kind: 'resumed', reason: 'interrupted-working',
    evidence: { kind: 'run-ended', state: 'interrupted', observedAt: _historyFixtureEpoch(0, 0, 1) }, recoveryInputs: { reminder: 'Retained context.', continuation: 'Continue.' }
  }
  operation.recoveryDelivery = createContinuityInputDelivery(operation, 0)!
  const initial = { ...view, continuity: operation, continuityOperations: { [operation.operationId]: operation } }
  useAppStore.setState({ sessions: [initial], config: composerConfig, loading: false, timelines: {}, tabs: {}, layouts: {},
    agentComposerDrafts: { [view.id]: 'Original unsent draft' } })
  expect(sessionServiceNotices(initial).some(notice => notice.id === 'continuity-input:original-continuity')).toBe(true)
  const accepted = structuredClone(operation), delivery = accepted.recoveryDelivery!
  delivery.phase = 'accepted'
  delivery.receipt = { key: delivery.key, status: 'terminal-confirmed', observedAt: _historyFixtureEpoch(0, 0, 10) }
  for (const part of [delivery.reminder, delivery.continuation]) { part.status = 'accepted'; part.receiptRef = delivery.key }
  const core: AgentMuxAgentSession = { kind: 'agent', agentSessionId: view.id, providerId: view.providerId, executorId: view.executorId,
    hostId: 'local', workspacePath: view.workspacePath, run: view.control.run, retiredRuns: [{ runId: 'old-run' }],
    createdAt: view.createdAt, updatedAt: view.agentSessionUpdatedAt + 1,
    continuity: { ...accepted, operationId: 'new-healthy-observation', kind: 'reattachable' }, continuityOperations: { [operation.operationId]: accepted } }
  // The same public Store action used by the live IPC subscription; no snapshot refresh.
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-session', session: core } })
  const current = useAppStore.getState().sessions[0]!
  expect(current.kind).toBe('agent')
  if (current.kind !== 'agent') throw new Error('Original Agent projection is required')
  expect(current.continuityOperations?.[operation.operationId]?.recoveryDelivery?.phase).toBe('accepted')
  expect(current.continuityOperations?.[operation.operationId]?.recoveryDelivery?.key).toEqual(delivery.key)
  expect(current.continuity?.operationId).toBe('new-healthy-observation')
  expect(sessionServiceNotices(current).some(notice => notice.id === 'continuity-input:original-continuity')).toBe(false)
  expect(useAppStore.getState().agentComposerDrafts[view.id]).toBe('Original unsent draft')
  expect(current.control.run).toEqual(view.control.run)
})
