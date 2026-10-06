import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentRuntimeStatus } from '../../../packages/core/src/client.js'
import type { AgentTimelineSnapshot } from '../../../packages/core/src/types.js'
import { activityCertaintyClient } from '../../../packages/core/test/fixtures/activity-certainty-client.js'
import type { SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { createClientUiRoot } from './helpers/client-ui-render'

// The actual Store/projection/Global/Row/menu remain loaded. Native painting and
// history reading are separate tasks; this family exercises the original lane.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const NOW = _hygiene_fixtureTime(32774400000)
const initial = useAppStore.getState()
const opened: Awaited<ReturnType<typeof activityCertaintyClient>>[] = []
let root: Root, node: HTMLDivElement, base: Extract<SessionSnapshot, { kind: 'agent' }>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const snapshot = await api.sessions.snapshot()
  const found = snapshot.sessions.find(session => session.kind === 'agent')
  expect(found?.kind).toBe('agent'); base = found as typeof base
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); useAppStore.setState(initial, true)
  await Promise.all(opened.splice(0).map(item => item.close())); vi.restoreAllMocks()
})
async function open(id: string, provider: 'codex' | 'grok' | 'traex' = 'codex', workspacePath?: string) {
  const h = await activityCertaintyClient(id, provider, workspacePath ? { workspacePath } : {}); opened.push(h); return h
}
function present(status: AgentMuxAgentRuntimeStatus): Extract<SessionSnapshot, { kind: 'agent' }> {
  const session = status.session
  const { semanticStatus: _previous, ...presentationBase } = base
  return { ...presentationBase, id: session.agentSessionId, providerId: session.providerId, executorId: session.executorId,
    hostId: session.hostId, workspacePath: session.workspacePath, label: `Observed ${session.agentSessionId}`,
    capabilities: status.capabilities, processState: status.run.state, latestOutputBytes: status.run.latestOutputBytes,
    status: session.semanticStatus ?? { state: 'running', source: 'run-process', observedAt: status.run.observedAt },
    ...(session.semanticStatus ? { semanticStatus: session.semanticStatus } : {}),
    control: { kind: 'agent', hostId: session.hostId, agentSessionId: session.agentSessionId, run: session.run } }
}
async function mount(statuses: AgentMuxAgentRuntimeStatus[]) {
  const config = await api.config.get(), path = statuses[0]!.session.workspacePath
  await act(async () => {
    useAppStore.setState({ config: { ...config, workspaces: [{ id: 'certainty-project', name: 'Certainty project', hostId: 'local', path, kind: 'folder' }] },
      sessions: statuses.map(present), timelines: {}, tabs: {}, layouts: {}, scratchTopicSnapshots: {}, providerCatalog: [], agentNames: {},
      mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
    root.render(createElement(GlobalFocusSurface))
  })
}
function row(id: string) {
  const found = node.querySelector<HTMLButtonElement>(`.focus-context[data-session-id="${id}"]`)
  expect(found).not.toBeNull(); return found!
}
function neutral() {
  const found = node.querySelector<HTMLElement>('.focus-context-group[data-bucket="idle"][data-empty]:not([data-empty="true"])')
    ?? [...node.querySelectorAll<HTMLElement>('.focus-context-group[data-bucket="idle"]')].find(group => group.querySelector('.focus-context'))
  expect(found).not.toBeUndefined(); expect(found).not.toBeNull(); return found!
}
it('public bare running explains unconfirmed activity with an exact Unknown count and a usable original Agent entry', async () => {
  const h = await open('bare-ui'), status = await h.client.statusAgent('bare-ui')
  await mount([status])
  expect(status.observation.semantic).toBe('unknown')
  expect(row('bare-ui').dataset.activity).toBe('unknown')
  expect(row('bare-ui').getAttribute('aria-label')).toContain('Activity not confirmed')
  expect(neutral().getAttribute('aria-label')).toBe('Activity unknown')
  expect(node.querySelector('[aria-label="Idle 0 · Activity unknown 1 · Recovery 0"]')).not.toBeNull()
  expect(row('bare-ui').disabled).toBe(false); row('bare-ui').focus(); expect(document.activeElement).toBe(row('bare-ui'))
  expect(useAppStore.getState().sessions[0]!.control.run).toEqual(status.session.run)
})
it('persisted stale working reaches the actual neutral lane without a false Working spinner or completed result', async () => {
  const h = await activityCertaintyClient('stale-ui', 'grok', { semanticStatus: { state: 'working', source: 'native-hook', observedAt: NOW - 25 * 60_000 } })
  opened.push(h)
  const status = await h.client.statusAgent('stale-ui'); await mount([status])
  expect(status.observation.semantic).toBe('unknown'); expect(row('stale-ui').dataset.bucket).toBe('idle')
  expect(row('stale-ui').dataset.activity).toBe('unknown')
  expect(row('stale-ui').getAttribute('aria-label')).toContain('Activity signal expired')
  expect(row('stale-ui').querySelector('.status--working')).toBeNull()
  expect(node.querySelector('[aria-label="Idle 0 · Activity unknown 1 · Recovery 0"]')).not.toBeNull()
  expect((await h.sessions())[0]!.semanticStatus?.state).toBe('working')
})
it('mixed confirmed Idle and unknown share one original group but retain separately readable counts', async () => {
  const bare = await open('unknown-mixed'), done = await open('idle-mixed', 'codex', bare.directory)
  await done.hook('Stop', 'ui-confirmed-done')
  await mount([await bare.client.statusAgent('unknown-mixed'), await done.client.statusAgent('idle-mixed')])
  expect(neutral().getAttribute('aria-label')).toBe('Idle / Unknown')
  expect(neutral().querySelector('header')!.getAttribute('aria-label')).toBe('Idle 1 · Activity unknown 1 · Recovery 0')
  expect(row('unknown-mixed').dataset.activity).toBe('unknown'); expect(row('idle-mixed').dataset.activity).toBe('idle')
  expect(node.querySelectorAll('.focus-context-group')).toHaveLength(5) // four original states and disconnected
})
it('confirmed working remains Working while an observation-unsupported Provider stays distinct and usable', async () => {
  const working = await open('working-ui'), unsupported = await open('unsupported-ui', 'traex', working.directory)
  await working.hook('UserPromptSubmit', 'ui-current-working')
  await mount([await working.client.statusAgent('working-ui'), await unsupported.client.statusAgent('unsupported-ui')])
  expect(row('working-ui').dataset.bucket).toBe('working'); expect(row('working-ui').dataset.activity).toBe('active')
  expect(row('unsupported-ui').dataset.activity).toBe('unsupported')
  expect(row('unsupported-ui').getAttribute('aria-label')).toContain('Activity not reported')
  expect(row('unsupported-ui').disabled).toBe(false)
})
it('same-state accepted fresh confirmation updates the original cached unknown context to Working', async () => {
  const h = await open('fresh-confirmation')
  vi.mocked(Date.now).mockReturnValue(NOW - 25 * 60_000)
  await h.hook('UserPromptSubmit', 'initial-work-observation')
  vi.mocked(Date.now).mockReturnValue(NOW)
  const stale = await h.client.statusAgent('fresh-confirmation'); await mount([stale])
  expect(row('fresh-confirmation').dataset.activity).toBe('unknown')
  const enteredAt = stale.session.semanticStatus!.stateEnteredAt
  await h.hook('UserPromptSubmit', 'accepted-fresh-confirmation')
  const fresh = await h.client.statusAgent('fresh-confirmation')
  expect(fresh.session.semanticStatus!.stateEnteredAt).toBe(enteredAt)
  expect(fresh.session.semanticStatus!.observedAt).toBe(NOW)
  expect(fresh.observation.semantic).toBe('active')
  await act(async () => useAppStore.setState({ sessions: [present(fresh)] }))
  expect(row('fresh-confirmation').dataset.activity).toBe('active')
  expect(row('fresh-confirmation').dataset.bucket).toBe('working')
  expect(useAppStore.getState().sessions[0]!.control.run).toEqual(stale.session.run)
})
it('same active confirmation preserves the existing context reference, while capability replacement changes the meaning', async () => {
  const h = await open('stable-current')
  vi.mocked(Date.now).mockReturnValue(NOW - 1); await h.hook('UserPromptSubmit', 'current-one')
  vi.mocked(Date.now).mockReturnValue(NOW)
  const session = present(await h.client.statusAgent('stable-current'))
  const select = createFocusProjectionSelector(), config = await api.config.get()
  const input = { sessions: [session], timelines: {}, config, agentNames: {}, scratchTopicSnapshots: {} }
  const before = select(input); expect(before.contexts[0]!.activitySemantic).toBe('active')
  await h.hook('UserPromptSubmit', 'current-two')
  const confirmed = present(await h.client.statusAgent('stable-current'))
  expect(confirmed.status.observedAt).not.toBe(session.status.observedAt)
  expect(select({ ...input, sessions: [confirmed] }).contexts[0]).toBe(before.contexts[0])
  // Snapshot capability is an independent authoritative input to this consumer.
  const unsupported = select({ ...input, sessions: [{ ...confirmed,
    capabilities: { ...confirmed.capabilities, timeline: 'unavailable' } }] })
  expect(unsupported.contexts[0]!.activitySemantic).toBe('unsupported')
  expect(unsupported.contexts[0]!.bucket).toBe('idle')
  expect(unsupported.contexts[0]!.stateLabel).toBe('Activity not reported')
})
it('unrelated bytes and another SID status preserve this context and do not reread its Timeline or the public Run', async () => {
  const h = await open('cost-ui'), other = await open('other-ui', 'codex', h.directory)
  const statuses = [await h.client.statusAgent('cost-ui'), await other.client.statusAgent('other-ui')]
  const sessions = statuses.map(present), timelines: Record<string, AgentTimelineSnapshot> = {}
  const reads: Record<string, number> = {}
  for (const session of sessions) timelines[session.id] = new Proxy({ agentSessionId: session.id, revision: 0, items: [] }, {
    get(target, key, receiver) { if (key === 'items') reads[session.id] = (reads[session.id] ?? 0) + 1; return Reflect.get(target, key, receiver) } })
  const select = createFocusProjectionSelector(), config = await api.config.get()
  const input = { sessions, timelines, config, agentNames: {}, scratchTopicSnapshots: {} }
  const before = select(input), retained = before.contexts.find(item => item.id === 'cost-ui')
  for (const id of Object.keys(reads)) delete reads[id]
  for (let i = 0; i < 200; i++) {
    const after = select({ ...input, sessions: sessions.map(session => session.id === 'other-ui'
      ? { ...session, latestOutputBytes: i + 1, status: { ...session.status, observedAt: NOW + i } } : session) })
    expect(after.contexts.find(item => item.id === 'cost-ui')).toBe(retained)
  }
  expect(reads['cost-ui'] ?? 0).toBe(0); expect(h.requests).toEqual([h.run.runId])
})
