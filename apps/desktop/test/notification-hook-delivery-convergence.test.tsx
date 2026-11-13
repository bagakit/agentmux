// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it } from 'vitest'
import type { RuntimeEvent } from '../src/shared/contracts'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { notificationTrigger, toggleNotificationCenter, toggleNotificationDetails, selectNotificationView, notificationEventRows, currentNotificationRows } from './helpers/notification-center'

/**
 * One Run's Native Hook delivery losses are one current problem. Core holds them as one
 * hookDeliveryObservation per Run on its Hook binding; the Renderer shows it as the per-Session
 * 'hook-delivery' current notice. N failing receipts are not N Activity records, a read notice
 * stays read while the same loss continues, and only escalation to an unknown result re-raises it.
 */
const dom = composerDOM()
const sessions = [composerSession('hook-converge')]
beforeEach(() => useAppStore.setState({ loading: false, sessions, tabs: {}, notificationEvents: [], noticeReadReceipts: {},
  error: null, lastError: null, errorNoticeContext: null, errorDismissed: false, environmentWarning: undefined,
  runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [], displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {} }))

type Loss = { since: number; accepted: false | 'unknown'; code: string; reason?: string } | null
function projection(loss: Loss, updatedAt: number): RuntimeEvent {
  const session = sessions[0]!
  return { type: 'core', hostId: 'local', event: { type: 'agent-session', session: {
    kind: 'agent', agentSessionId: session.id, providerId: session.providerId, executorId: session.executorId,
    hostId: session.hostId, workspacePath: session.workspacePath, run: { ...session.control.run }, retiredRuns: [],
    createdAt: 1, updatedAt, semanticStatus: { state: 'working', source: 'native-hook', observedAt: updatedAt },
    ...(loss ? { hookDeliveryObservation: { run: { ...session.control.run }, ...loss } } : {})
  } } }
}
const deliveryRows = () => currentNotificationRows(dom.container).filter(row => row.textContent?.includes('Native Hook observations'))
const apply = async (event: RuntimeEvent) => { await act(async () => { useAppStore.getState().applyEvent(event) }) }

it.each([1, 20])('%i lost Hook observations of one Run show one current notice and no Activity record', async count => {
  await dom.render(<GlobalSystemNotices />)
  // Core republishes only when the fact changes; repeated identical projections must still converge.
  for (let index = 0; index < count; index++) await apply(projection({ since: 10, accepted: 'unknown', code: 'HOOK_DELIVERY_TIMEOUT' }, 10 + index))
  expect(useAppStore.getState().notificationEvents).toEqual([])
  await toggleNotificationCenter(dom.container, 'open')
  await selectNotificationView(dom.container, 'current')
  expect(deliveryRows(), 'exactly one current Hook delivery problem for this Run').toHaveLength(1)
  await toggleNotificationDetails(deliveryRows()[0]!)
  expect(deliveryRows()[0]!.textContent).toContain('Losing these observations does not stop the Agent, its terminal or input.')
  expect(deliveryRows()[0]!.textContent).toContain('Whether AgentMux recorded a recent Hook observation is unconfirmed')
  expect(deliveryRows()[0]!.textContent).toContain('This clears when the next Hook observation from this Run is delivered.')
  await selectNotificationView(dom.container, 'history')
  expect(notificationEventRows(dom.container)).toHaveLength(0)
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('0 recent events')
})

it('a read loss stays read while it continues, re-raises once on escalation, and clears on delivery', async () => {
  await dom.render(<GlobalSystemNotices />)
  await apply(projection({ since: 10, accepted: false, code: 'HOOK_DELIVERY_BACKPRESSURE' }, 10))
  await toggleNotificationCenter(dom.container, 'open')
  await selectNotificationView(dom.container, 'current')
  const unread = () => deliveryRows().map(row => row.dataset.unread)
  expect(unread()).toEqual(['true'])
  // Reading the details is how a person acknowledges it.
  await toggleNotificationDetails(deliveryRows()[0]!)
  expect(deliveryRows()[0]!.textContent).toContain('Recent Hook observations were refused before AgentMux processed them')
  expect(unread()).toEqual(['false'])
  // A later projection of the same loss (another field changed) is not a new problem.
  await apply(projection({ since: 10, accepted: false, code: 'HOOK_DELIVERY_BACKPRESSURE' }, 11))
  expect(unread()).toEqual(['false'])
  await apply(projection({ since: 10, accepted: 'unknown', code: 'HOOK_DELIVERY_TIMEOUT' }, 12))
  expect(unread(), 'escalation to an unknown result is a new cause').toEqual(['true'])
  await apply(projection(null, 13))
  expect(deliveryRows(), 'a delivered observation clears the problem').toHaveLength(0)
  // A loss after recovery is a new occurrence, even with the same cause as the read one.
  await apply(projection({ since: 20, accepted: false, code: 'HOOK_DELIVERY_BACKPRESSURE' }, 14))
  expect(unread()).toEqual(['true'])
  expect(useAppStore.getState().notificationEvents).toEqual([])
})

it('a new loss episode is unread even when its recovery was never rendered', async () => {
  await dom.render(<GlobalSystemNotices />)
  await apply(projection({ since: 10, accepted: false, code: 'HOOK_DELIVERY_BACKPRESSURE' }, 10))
  await toggleNotificationCenter(dom.container, 'open')
  await selectNotificationView(dom.container, 'current')
  await toggleNotificationDetails(deliveryRows()[0]!)
  expect(deliveryRows().map(row => row.dataset.unread)).toEqual(['false'])
  // Recovery and the next loss land in one batch: the cleared projection is never rendered.
  await act(async () => {
    useAppStore.getState().applyEvent(projection(null, 11))
    useAppStore.getState().applyEvent(projection({ since: 30, accepted: false, code: 'HOOK_DELIVERY_BACKPRESSURE' }, 12))
  })
  expect(deliveryRows().map(row => row.dataset.unread), 'its first time names a new episode').toEqual(['true'])
})

it('a loss of another Run is not shown on the current Run', async () => {
  await dom.render(<GlobalSystemNotices />)
  const session = sessions[0]!, event = projection({ since: 10, accepted: 'unknown', code: 'HOOK_DELIVERY_TIMEOUT' }, 10)
  if (event.type !== 'core' || event.event.type !== 'agent-session') throw new Error('fixture shape')
  event.event.session.hookDeliveryObservation!.run = { runId: `${session.control.run.runId}-old` }
  await apply(event)
  await toggleNotificationCenter(dom.container, 'open')
  await selectNotificationView(dom.container, 'current')
  expect(deliveryRows()).toHaveLength(0)
})

it('Core\'s own republish shape (unchanged Session time) still sets, escalates and clears the notice', async () => {
  await dom.render(<GlobalSystemNotices />)
  await apply(projection({ since: 10, accepted: false, code: 'HOOK_DELIVERY_BACKPRESSURE' }, 5))
  await toggleNotificationCenter(dom.container, 'open')
  await selectNotificationView(dom.container, 'current')
  expect(deliveryRows().map(row => row.dataset.unread)).toEqual(['true'])
  await toggleNotificationDetails(deliveryRows()[0]!)
  expect(deliveryRows().map(row => row.dataset.unread)).toEqual(['false'])
  await apply(projection({ since: 10, accepted: 'unknown', code: 'HOOK_DELIVERY_TIMEOUT' }, 5))
  expect(deliveryRows().map(row => row.dataset.unread)).toEqual(['true'])
  await apply(projection(null, 5))
  expect(deliveryRows()).toHaveLength(0)
})

it('the notice states only what the delivery owner knows, and names a safe field rejection when there is one', async () => {
  const session = sessions[0]!
  useAppStore.setState({ sessions: [{ ...session, processState: 'interrupted' } as typeof session] })
  await dom.render(<GlobalSystemNotices />)
  await apply(projection({ since: 10, accepted: 'unknown', code: 'INVALID_AGENT_SESSION_STORE',
    reason: 'hookReceipt.toolInvocation.toolInput is invalid.' }, 10))
  await toggleNotificationCenter(dom.container, 'open')
  await selectNotificationView(dom.container, 'current')
  await toggleNotificationDetails(deliveryRows()[0]!)
  // Never claims the Agent is usable: the Run state and input keep their own owners.
  expect(deliveryRows()[0]!.textContent).not.toContain('remain usable')
  expect(deliveryRows()[0]!.textContent).toContain('Losing these observations does not stop the Agent, its terminal or input.')
  expect(deliveryRows()[0]!.textContent).toContain('Rejected: hookReceipt.toolInvocation.toolInput is invalid.')
})
