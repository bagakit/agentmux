// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
let root: Root | undefined
const registry = new FinalizationRegistry<{ collected: boolean }>(state => { state.collected = true })

const stackTraceLimit = Error.stackTraceLimit
// Development React keeps each Fiber's creation stack frames; the shipped production Renderer does not.
beforeEach(() => { Error.stackTraceLimit = 0 })
afterEach(async () => { root?.unmount(); await settle(); document.body.replaceChildren(); Error.stackTraceLimit = stackTraceLimit })

function runningAgent(id: string) {
  const session = composerSession(id)
  const operation = { operationId: `${id}-startup`, agentSessionId: session.id, trigger: 'startup', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
    previousRun: session.control.run, admittedAt: 1, observedAt: 2, rechecks: 0, kind: 'pending', reason: 'active-delay',
    evidence: { kind: 'run-ended', state: 'interrupted', observedAt: 1 },
    supervision: { phase: 'paused', activeAttemptOperationId: `${id}-startup`, attemptCount: 0, attemptLimit: 4, observedAt: 2, reason: 'active-delay' } } as AgentMuxContinuityOperation
  return { ...session, label: `Agent ${id}`, processState: 'running' as const, status: { state: 'error' as const, source: 'run-process' as const, observedAt: 1 },
    continuity: operation, continuityOperations: { [operation.operationId]: operation } }
}

async function released(state: { collected: boolean }) {
  for (let attempt = 0; attempt < 10 && !state.collected; attempt++) { gc(); await settle() }
  return state.collected
}

it('the open notification center keeps its Session notices without retaining the Session array of an older render', async () => {
  const noticed = runningAgent('noticed')
  useAppStore.setState({ config: composerConfig, loading: false, tabs: {}, notificationEvents: [], noticeReadReceipts: {}, error: null,
    runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [], displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {} })
  let first: object | undefined = [noticed, composerSession('unrelated-0')]
  if (process.env.RETENTION_SNAPSHOT) Reflect.set(first, 'retentionMarker', new (class RetentionMarker {})())
  const state = { collected: false }
  registry.register(first, state)
  useAppStore.setState({ sessions: first as never })
  const container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  root.render(<GlobalSystemNotices />)
  await settle()
  const details = container.querySelector<HTMLElement>('.global-system-notices__details')!
  const toggle = new Event('toggle')
  Object.defineProperty(toggle, 'newState', { value: 'open' })
  details.dispatchEvent(toggle)
  await settle()
  container.querySelector<HTMLButtonElement>('[role="tab"][data-section="current"]')!.click()
  await settle()
  expect(container.textContent).toContain('Agent noticed')
  first = undefined
  for (let index = 1; index <= 4; index++) { useAppStore.setState({ sessions: [noticed, composerSession(`unrelated-${index}`)] }); await settle() }
  expect(container.textContent).toContain('Agent noticed')
  const collected = await released(state)
  if (!collected && process.env.RETENTION_SNAPSHOT) (await import('node:v8')).writeHeapSnapshot(process.env.RETENTION_SNAPSHOT)
  expect(collected, 'Long-lived notice closures must not pin an older render scope').toBe(true)
})
