import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller'
import { projectRuntimeEvent } from '../src/renderer/src/lib/session-state'
import { activityCertaintyClient } from '../../../packages/core/test/fixtures/activity-certainty-client'
import { agentContextForSession, createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { observeAgentSession } from '../src/renderer/src/lib/agent-observation'
import { sessionServiceNotices } from '../src/renderer/src/lib/session-service-notices'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot } from './helpers/client-ui-render'
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const NOW = _tailRefreshFixtureEpoch(1), OLD = NOW - 25 * 60_000
const cleanup: Array<() => Promise<void>> = []
const initial = useAppStore.getState()
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); useAppStore.setState(initial, true); vi.restoreAllMocks() })
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const h = await activityCertaintyClient('reason-main-ui', 'grok', { semanticStatus: { state: 'working', source: 'native-hook', observedAt: OLD } })
  cleanup.push(h.close)
  const kernel = Reflect.get(h.client, 'kernel'); kernel.list = async () => [h.run]
  kernel.identity = () => ({ buildIdentity: 'private', protocolVersion: 1, daemonInstanceId: 'private' })
  const config = await api.config.get()
  const actual: AppConfig = { ...config, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [{ id: 'reason-project', name: 'Activity observations', hostId: 'local', path: h.directory, kind: 'folder' }] }
  const main = new RuntimeController(h.store, async () => h.client)
  main.commit(await main.prepare(actual)); cleanup.push(async () => main.dispose())
  const snapshot = await main.snapshot(actual)
  const session = snapshot.sessions.find(item => item.id === 'reason-main-ui')!
  expect(session?.kind).toBe('agent')
  return { h, config: actual, session: session as Extract<SessionSnapshot, { kind: 'agent' }>, snapshot }
}
it('actual Main snapshot and real Focus card explain expired work while preserving exact navigation and input control', async () => {
  const { h, config, session, snapshot } = await fixture()
  const original = structuredClone(session.control)
  const node = document.createElement('div'); document.body.append(node); const root = createClientUiRoot(node)
  cleanup.push(async () => { await act(async () => root.unmount()); node.remove() })
  await act(async () => {
    useAppStore.setState({ loading: false, config, sessions: snapshot.sessions, timelines: {}, tabs: {}, layouts: {}, agentNames: {}, scratchTopicSnapshots: {},
      providerCatalog: [], mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
    root.render(createElement(GlobalFocusSurface))
  })
  const card = node.querySelector<HTMLButtonElement>('[data-session-id="reason-main-ui"]')!
  expect(card).not.toBeNull(); expect(card.disabled).toBe(false)
  expect(card.dataset.activity).toBe('unknown'); expect(card.querySelector('.status--working')).toBeNull()
  expect(card.getAttribute('aria-label')).toContain('Activity signal expired')
  expect(card.getAttribute('aria-label')).toContain('Last confirmed working')
  expect(card.getAttribute('aria-label')).toContain(new Date(OLD).toLocaleString())
  expect(card.getAttribute('aria-label')).toContain('Prompt readiness ready')
  expect(card.querySelector('.focus-context__detail')?.textContent).toContain('Activity signal expired')
  card.focus(); expect(document.activeElement).toBe(card)
  expect(useAppStore.getState().sessions[0]!.control).toEqual(original)
  expect((await h.client.statusAgent('reason-main-ui')).observation).toEqual(observeAgentSession(session, NOW))
})
it('Renderer display decay keeps the last confirmed working and cache updates another unknown reason', async () => {
  const { h, config, session } = await fixture()
  const event = { type: 'core' as const, hostId: 'local', event: { type: 'agent-session' as const, session: (await h.client.statusAgent('reason-main-ui')).session } }
  const view = { sessions: [session], timelines: {}, pendingAgentLaunches: {}, tabs: {}, layouts: {}, viewModes: {} }
  const projected = projectRuntimeEvent(view, event).state.sessions[0] as typeof session
  const decayed = { ...projected, status: { ...projected.status, state: 'running' as const } }
  expect(observeAgentSession(decayed, NOW)).toMatchObject({ reason: 'activity-stale', lastKnownActivity: { state: 'working', observedAt: OLD } })
  const select = createFocusProjectionSelector()
  const input = { sessions: [decayed], timelines: {}, agentNames: {}, config, scratchTopicSnapshots: {} }
  expect(select(input).contexts[0]!.stateLabel).toBe('Activity signal expired')
  const next = { ...decayed, semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: OLD + 1, idleEvidenceConsumed: true } }
  // Same displayed status and semantic=unknown, but its explanatory native fact changed.
  const context = select({ ...input, sessions: [next] }).contexts[0]!
  expect(context.stateLabel).toBe('Activity not confirmed'); expect(context.detail).toContain('Last confirmed done')
})
it('native-source uncertainty is an independent notice and never overrides fresh work or waiting', async () => {
  const { session } = await fixture()
  for (const state of ['working', 'waiting'] as const) {
    const fact = { state, source: 'native-hook' as const, observedAt: NOW }
    const active = { ...session, status: fact, semanticStatus: fact,
      nativeSourceObservation: { state: 'unknown' as const, run: session.control.run, observedAt: NOW, reason: 'current-main-unconfirmed' } }
    expect(observeAgentSession(active, NOW).semantic).toBe(state === 'working' ? 'active' : 'awaiting-input')
    expect(sessionServiceNotices(active).some(item => item.id === 'activity-observation')).toBe(false)
    expect(sessionServiceNotices(active).some(item => item.id === 'native-source')).toBe(true)
  }
})
it('a disconnected observation describes the last process reading without claiming current input availability', async () => {
  const { session } = await fixture()
  const notices = sessionServiceNotices(session, [], undefined, undefined, undefined, false)
  const activity = notices.find(item => item.id === 'activity-observation')!
  expect(activity.notice.notice?.mode).toContain('Last observed Run running')
  expect(activity.notice.notice?.mode).toContain('Current input availability unconfirmed')
  expect(activity.notice.notice?.mode).not.toContain('Input available')
  const disconnected = { ...session, status: { ...session.status, state: 'disconnected' as const } }
  const implicit = sessionServiceNotices(disconnected).find(item => item.id === 'activity-observation')!
  expect(implicit.notice.notice?.mode).toContain('Current input availability unconfirmed')
  expect(agentContextForSession(disconnected, undefined, undefined, undefined, null).detail).toContain('Current input availability unconfirmed')
})
it('prompt readiness never contradicts a confirmed Native input-lane failure', async () => {
  const { session } = await fixture()
  const blocked = { ...session, nativeService: { revision: 1, owner: { type: 'serving' as const }, output: { type: 'serving' as const },
    input: { phase: { type: 'unavailable' as const, reason: 'write_failed' as const }, unsettledCommands: 0, unsettledRequestBytes: 0,
      writeBlocked: true, completedInputBytes: 0, currentSize: { cols: 80, rows: 24 }, activeConfirmedBytes: 0 }, terminalFault: null } }
  expect(observeAgentSession(blocked, NOW).readiness).toBe('ready')
  const notices = sessionServiceNotices(blocked)
  expect(notices.find(item => item.id === 'native-service')?.notice.notice.mode).toContain('input unavailable')
  expect(notices.find(item => item.id === 'activity-observation')?.notice.notice.mode).toContain('Prompt readiness ready')
  expect(notices.map(item => item.notice.notice.mode).join(' ')).not.toContain('Input available')
})
it('missing current retained evidence does not deny an earlier working observation in the same Session', async () => {
  const { session } = await fixture()
  expect(session.semanticStatus?.state).toBe('working')
  const ended = { ...session, semanticStatus: { state: 'running' as const, source: 'native-transcript' as const, observedAt: NOW },
    status: { state: 'running' as const, source: 'native-transcript' as const, observedAt: NOW } }
  const notices = sessionServiceNotices(ended)
  const explanation = notices.find(item => item.id === 'activity-observation')!.notice.notice.mode
  expect(explanation).toContain('Last confirmed activity unavailable')
  expect(explanation).not.toContain('No confirmed activity observed')
})
it('localized display wording cannot change an activity notice read identity', async () => {
  const { session } = await fixture()
  const first = sessionServiceNotices(session).find(item => item.id === 'activity-observation')!
  vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Different local date wording')
  const next = sessionServiceNotices(session).find(item => item.id === 'activity-observation')!
  expect(next.notice.notice.mode).not.toBe(first.notice.notice.mode)
  expect(next.cause).toBe(first.cause)
  expect(next.occurrence).toBe(first.occurrence)
})
