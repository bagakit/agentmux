import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatus, AgentTimelineSnapshot } from '@agentmux/core'
import type { RuntimeEvent, SessionSnapshot } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import { serviceNoticeFingerprint } from '../src/renderer/src/lib/use-service-notices'
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusNavigationPreview } from '../src/renderer/src/components/FocusNavigationPreview'
import { AttentionRequestPanel } from '../src/renderer/src/components/AttentionRequestPanel'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'

const dom = composerDOM()
const NOW = _hygiene_fixtureTime(32774400000)
type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const failure: NonNullable<AgentStatus['failure']> = {
  code: 'AGENT_MODEL_OVERLOADED', message: 'Selected model is at capacity. Please try a different model.',
  nativeCode: 'server_overloaded', httpStatusCode: 503,
  recovery: 'Retry later or select another available model in the original Session.', nativeTurnId: 'failed-turn-1'
}
const completed = (content: string, time: number): AgentTimelineSnapshot => ({ agentSessionId: 'agent-1', revision: time,
  items: [{ id: `response-${time}`, agentSessionId: 'agent-1', kind: 'assistant_message', status: 'complete',
    source: 'native-transcript', title: 'Response', content, createdAt: NOW + time, updatedAt: NOW + time }] })
let agent: Agent, healthy: Agent
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  agent = { ...composerSession(), status: { state: 'done', source: 'native-transcript', observedAt: NOW + 1 } }
  healthy = composerSession('healthy')
  useAppStore.setState({ sessions: [agent, healthy], loading: false, config: composerConfig,
    timelines: { 'agent-1': completed('An older successful answer', 1) }, tabs: {}, layouts: {},
    scratchTopicSnapshots: {}, noticeReadReceipts: {}, agentNames: {}, mainSurface: 'agents',
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
})
function statusEvent(state: 'working' | 'done' | 'error', observedAt: number,
  requestFailure?: NonNullable<AgentStatus['failure']>): RuntimeEvent {
  return { type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: agent.id, state,
    ...(requestFailure ? { detail: `[${requestFailure.code}] ${requestFailure.message}`, failure: requestFailure } : {}),
    evidence: { source: 'native-transcript', observedAt: NOW + observedAt, run: agent.control.run } } }
}
async function publish(event: RuntimeEvent) { await act(async () => useAppStore.getState().applyEvent(event)) }
const current = () => useAppStore.getState().sessions.find((item): item is Agent => item.id === agent.id && item.kind === 'agent')!
const row = () => dom.container.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${agent.id}"]`)!
const mailbox = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const trigger = () => dom.container.querySelector<HTMLButtonElement>('.composer__mailbox')!
async function openNotices() {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => mailbox().dispatchEvent(event))
  await dom.click('[role="tab"][id$="-system-tab"]')
}
async function mount() {
  await dom.render(<><GlobalFocusSurface /><FocusNavigationPreview />
    <AttentionRequestPanel sessionId={agent.id} onClose={() => {}} />
    <AgentSessionComposer sessionId={agent.id} /></>)
}
function kept() {
  expect(current().control).toBe(agent.control)
  expect(useAppStore.getState().sessions.find(item => item.id === healthy.id)).toBe(healthy)
  expect(dom.draft()).toBe('Keep my draft')
  expect(api.sessions.stop).not.toHaveBeenCalled()
}

it('projects a native request failure immediately into Attention, error details and Notices while keeping input', async () => {
  await mount(); expect(row().dataset.bucket).toBe('results')
  await publish(statusEvent('error', 2, failure))
  expect(current().status.failure).toEqual(failure)
  expect(current().status.failure).not.toBe(failure)
  expect(row().dataset.bucket).toBe('attention'); expect(row().disabled).toBe(false)
  expect(row().textContent).toContain(`[${failure.code}] ${failure.message}`)
  expect(row().querySelector('.focus-context__recap')).toBeNull()
  expect(dom.container.querySelector('[data-preview-count="attention"] b')!.textContent).toBe('1')
  expect(dom.container.querySelector('[data-preview-count="results"] b')!.textContent).toBe('0')
  const panel = dom.container.querySelector('.attention-request-panel')!
  expect(panel.textContent).toContain(`[${failure.code}] ${failure.message}`)
  expect(panel.textContent).toContain('Run is still alive')
  expect(panel.textContent).not.toContain('Close failed Session')
  expect(dom.container.querySelector('[contenteditable="true"]')).not.toBeNull()
  expect(trigger().getAttribute('aria-label')).toContain('Notices 1 need attention')
  await openNotices()
  expect(mailbox().textContent).toContain(`Agent request failed · ${failure.code}`)
  const notice = sessionServiceNotices(current())[0]!
  expect(notice.notice.notice).toMatchObject({ mode: expect.stringContaining(failure.message), restore: failure.recovery })
  kept()
})

it('clears the failure on later work and successful completion, restoring the current result without deleting the Session', async () => {
  await publish(statusEvent('error', 2, failure)); await mount()
  expect(row().dataset.bucket).toBe('attention'); expect(sessionServiceNotices(current())).toHaveLength(1)
  await publish(statusEvent('working', 3))
  expect(current().status.failure).toBeUndefined(); expect(sessionServiceNotices(current())).toEqual([])
  expect(row().dataset.bucket).toBe('working')
  await act(async () => useAppStore.setState({ timelines: { 'agent-1': completed('The retry completed successfully', 4) } }))
  await publish(statusEvent('done', 4))
  expect(row().dataset.bucket).toBe('results'); expect(row().textContent).toContain('The retry completed successfully')
  expect(current().status.failure).toBeUndefined(); expect(sessionServiceNotices(current())).toEqual([])
  expect(trigger().getAttribute('aria-label')).toContain('Notices 0 need attention')
  kept()
})

it('retains known failure through unavailable observation and keeps unknown Runs reviewable without a terminal close action', async () => {
  await publish(statusEvent('error', 2, failure)); const failed = current()
  await act(async () => useAppStore.setState({ sessions: [{ ...failed, processState: 'interrupted' }, healthy] }))
  await mount()
  expect(row().dataset.bucket).toBe('attention'); expect(row().disabled).toBe(false)
  expect(dom.container.querySelector('.attention-request-panel')!.textContent).toContain('not confirmed as exited')
  expect(dom.container.querySelector('.attention-request-panel')!.textContent).not.toContain('Close failed Session')
  expect(sessionServiceNotices(current())[0]!.notice).toMatchObject({ kind: 'indeterminate', notice: {
    step: `Agent request failed · ${failure.code}`, mode: expect.stringContaining('availability is unknown'), restore: failure.recovery
  } })
  const retained = { ...current(), semanticStatus: { ...failed.status } }
  await act(async () => useAppStore.setState({ sessions: [retained, healthy] }))
  await publish({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'lost',
    evidence: { source: 'run-process', observedAt: NOW + 3 } } })
  const notices = sessionServiceNotices(current())
  expect(notices.map(item => item.id)).toContain('provider-request')
  expect(notices.find(item => item.id === 'provider-request')!.notice.notice.step).toContain(failure.code)
  expect(dom.container.querySelector('[contenteditable="true"]')).not.toBeNull()
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual([agent.id, healthy.id])
  expect(dom.draft()).toBe('Keep my draft'); expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('uses the native Turn as notice occurrence, keeps metadata refreshes read, and announces the same error in a later Turn', async () => {
  await publish(statusEvent('error', 2, failure)); await mount(); await openNotices()
  expect(trigger().getAttribute('aria-label')).toContain('Notices 0 need attention')
  const first = sessionServiceNotices(current())[0]!
  await publish(statusEvent('error', 3, { ...failure }))
  expect(serviceNoticeFingerprint(sessionServiceNotices(current())[0]!)).toBe(serviceNoticeFingerprint(first))
  expect(trigger().getAttribute('aria-label')).toContain('Notices 0 need attention')
  const close = new Event('toggle'); Object.defineProperty(close, 'newState', { value: 'closed' })
  await act(async () => mailbox().dispatchEvent(close))
  await publish(statusEvent('error', 4, { ...failure, nativeTurnId: 'failed-turn-2' }))
  expect(serviceNoticeFingerprint(sessionServiceNotices(current())[0]!)).not.toBe(serviceNoticeFingerprint(first))
  expect(trigger().getAttribute('aria-label')).toContain('Notices 1 need attention')
  expect(createFocusProjectionSelector()(useAppStore.getState()).contexts.find(item => item.id === agent.id)!.bucket).toBe('attention')
  kept()
})
