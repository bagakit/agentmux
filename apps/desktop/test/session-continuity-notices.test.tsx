// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { AgentMuxContinuityInputDelivery, AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
import { createContinuityInputDelivery } from '../../../packages/core/src/agent-session-recovery/input'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession, composerConfig } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM()
function fixture(phase: AgentMuxContinuityInputDelivery['phase']) {
  const session = composerSession()
  const operation: AgentMuxContinuityOperation = {
    operationId: 'original-recovery', agentSessionId: session.id, trigger: 'startup',
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: { runId: 'previous-run' }, newRun: session.control.run,
    nativeTarget: { kind: 'provider', providerId: session.providerId, sessionId: 'retained-native-identity' },
    admittedAt: _historyFixtureEpoch(0, 0, 1), observedAt: _historyFixtureEpoch(0, 0, 2), rechecks: 0, interruptedWorking: true, kind: 'resumed', reason: 'interrupted-working',
    evidence: { kind: 'run-ended', state: 'interrupted', observedAt: _historyFixtureEpoch(0, 0, 1) },
    recoveryInputs: { reminder: 'Retained recovery context', continuation: 'Continue retained work' }
  }
  operation.recoveryDelivery = createContinuityInputDelivery(operation, 0)!
  operation.recoveryDelivery.phase = phase
  operation.recoveryDelivery.reason = 'original-input-delivery-unconfirmed'
  // A later healthy attachment must not hide this original operation's receipt.
  return { ...session, continuity: { ...operation, operationId: 'new-attachment', kind: 'reattachable' as const, recoveryDelivery: undefined },
    continuityOperations: { [operation.operationId]: operation } }
}

it.each(['waiting', 'dispatching', 'unknown', 'not-applied'] as const)('keeps %s recovery input visible from its original operation', phase => {
  const session = fixture(phase)
  const notice = sessionServiceNotices(session).find(one => one.id === 'continuity-input:original-recovery')!
  expect(notice).toBeDefined()
  expect(notice.notice.notice.mode).toContain('input controls are kept')
  expect(notice.notice.notice.restore).toContain(session.continuityOperations['original-recovery'].recoveryDelivery!.key.submissionId)
  expect(notice.notice.notice.restore).toContain('will not be replayed automatically')
})

it('shows the actual mailbox notice while preserving the original draft and ordinary input', async () => {
  const session = fixture('unknown')
  useAppStore.setState({ sessions: [session], config: composerConfig, loading: false,
    agentComposerDrafts: { [session.id]: 'Keep my draft' }, noticeReadReceipts: {}, tabs: {}, layouts: {} })
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await dom.render(<AgentSessionComposer sessionId={session.id} />)
  const mailbox = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  const { act } = await import('react')
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => mailbox.dispatchEvent(event))
  await dom.click('[role="tab"][id$="-system-tab"]')
  expect(mailbox.textContent).toContain('Recovery input delivery is unconfirmed')
  const row = Array.from(mailbox.querySelectorAll<HTMLButtonElement>('button')).find(one => one.textContent?.includes('Recovery input delivery is unconfirmed'))!
  await act(async () => row.click())
  expect(mailbox.textContent).toContain('original-recovery')
  expect(dom.draft()).toBe('Keep my draft')
  expect(dom.container.querySelector('[contenteditable="true"]')).not.toBeNull()
  expect(useAppStore.getState().sessions[0]?.control).toBe(session.control)
  expect(stop).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('does not disturb accepted, superseded, healthy or another Run with recovery notices', () => {
  for (const phase of ['accepted', 'superseded'] as const) expect(sessionServiceNotices(fixture(phase)).some(one => one.id.startsWith('continuity-input:'))).toBe(false)
  expect(sessionServiceNotices(composerSession()).some(one => one.id.startsWith('continuity-input:'))).toBe(false)
  const old = fixture('unknown')
  old.control = { ...old.control, run: { runId: 'newer-run' } }
  expect(sessionServiceNotices(old).some(one => one.id.startsWith('continuity-input:'))).toBe(false)
})
