// @vitest-environment happy-dom
import {act, createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {expect, it, vi} from 'vitest'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore} from '../src/renderer/src/store'
import {createFocusProjectionSelector} from '../src/renderer/src/lib/focus-context'
import {deriveFocusProjectLanes} from '../src/renderer/src/lib/focus-project-lanes'
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({AgentAvatar: () => null}))
vi.mock('../src/renderer/src/components/SessionPane', () => ({SessionPane: () => null}))
import {GlobalFocusSurface} from '../src/renderer/src/components/GlobalFocusSurface'

const now = Date.UTC(2026, 9, 2, 4), day = 24 * 60 * 60 * 1000
it('moves stale lanes behind actionable and recent work without reordering ties or losing selected contexts', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const initial = useAppStore.getState(), config = await api.config.get(), {sessions} = await api.sessions.snapshot(), base = sessions[0]!
  const ids = ['stale', 'unknown', 'recent-a', 'working', 'attention', 'recent-b', 'exact-day']
  const workspaces = ids.map(id => ({id, name: id, hostId: 'local', path: `/recency-${id}`, kind: 'folder' as const}))
  const selected = ids.map((id, index) => {const status = {...base.status, state: id === 'working' ? 'working' as const : id === 'attention' ? 'waiting' as const : 'done' as const, source: 'native-hook' as const, observedAt: now}; return {...base, id, workspacePath: workspaces[index]!.path, hostId: 'local', status, semanticStatus: {...status, stateEnteredAt: id === 'unknown' ? undefined : now - (id === 'stale' ? day + 1 : id === 'exact-day' ? day : 1)}}})
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
  try {
    useAppStore.setState({config: {...config, workspaces}, sessions: selected, timelines: {}, agentNames: {}, tabs: {}, agentFocus: {execution: {sessionId: 'stale', history: []}, pmo: {sessionId: null}}})
    await act(async () => root.render(createElement(GlobalFocusSurface)))
    const order = () => [...element.querySelectorAll<HTMLElement>('.focus-project-lanes__row')].map(row => row.dataset.projectId)
    expect(order()).toEqual(['attention', 'working', 'recent-a', 'recent-b', 'exact-day', 'stale', 'unknown'])
    const stale = element.querySelector('button[data-session-id="stale"]')!
    expect(stale.getAttribute('aria-pressed')).toBe('true')
    await act(async () => useAppStore.setState(state => ({sessions: state.sessions.map(session => ({...session, latestOutputBytes: session.latestOutputBytes + 100, updatedAt: now + day, status: {...session.status, observedAt: now + day}}))})))
    expect(order()).toEqual(['attention', 'working', 'recent-a', 'recent-b', 'exact-day', 'stale', 'unknown'])
    expect(useAppStore.getState().agentFocus.execution.sessionId).toBe('stale')
    await act(async () => useAppStore.setState(state => ({timelines: {...state.timelines, stale: {agentSessionId: 'stale', revision: 1, items: [{id: 'actual-new-prompt', agentSessionId: 'stale', kind: 'user_message', source: 'native-hook', status: 'complete', createdAt: now, updatedAt: now, title: 'user', content: 'Continue the original task'}]}}})))
    expect(order()).toEqual(['attention', 'working', 'stale', 'recent-a', 'recent-b', 'exact-day', 'unknown'])
    expect(element.querySelector('button[data-session-id="stale"]')?.textContent).toContain('Continue the original task')
    expect(useAppStore.getState().sessions.map(session => session.id)).toEqual(ids)
    expect(useAppStore.getState().sessions[0]!.control.run).toBe(base.control.run)
  } finally {await act(async () => root.unmount()); element.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks()}
})

it('uses task events and authoritative state-entry time, excluding heartbeat, lifecycle, process and byte timestamps', async () => {
  const {sessions} = await api.sessions.snapshot(), base = sessions[0]!, old = now - day - 1
  const input = {sessions: [{...base, id: 'old', status: {...base.status, state: 'done' as const, source: 'native-hook' as const, observedAt: now}, semanticStatus: {state: 'done' as const, source: 'native-hook' as const, stateEnteredAt: old, observedAt: now}, updatedAt: now}], timelines: {}, config: null, agentNames: {}}
  const select = createFocusProjectionSelector()
  const selector = (input: Parameters<typeof select>[0]) => select(input).contexts
  const before = selector(input)
  expect(before).toHaveLength(1); expect(before[0]!.lastActivityAt).toBe(old)
  expect(selector({...input, sessions: [{...input.sessions[0]!, updatedAt: now + 1, latestOutputBytes: 999, status: {...input.sessions[0]!.status, observedAt: now + 1}}]})[0]).toBe(before[0])
  expect(selector({...input, sessions: [{...input.sessions[0]!, semanticStatus: {...input.sessions[0]!.semanticStatus, stateEnteredAt: now}}]})[0]!.lastActivityAt).toBe(now)
  const lifecycle = selector({...input, timelines: {old: {agentSessionId: 'old', revision: 1, items: [{id: 'probe', agentSessionId: 'old', kind: 'lifecycle', source: 'native-hook', status: 'complete', createdAt: now, updatedAt: now, title: 'probe'}]}}})
  expect(lifecycle[0]!.lastActivityAt).toBe(old)
  const process = selector({...input, sessions: [{...input.sessions[0]!, semanticStatus: undefined, status: {...input.sessions[0]!.status, source: 'run-process'}}]})
  expect(process[0]!.lastActivityAt).toBeNull()
  const entered = selector({...input, sessions: [{...input.sessions[0]!, semanticStatus: {...input.sessions[0]!.semanticStatus, stateEnteredAt: now}}]})
  expect(entered[0]!.lastActivityAt).toBe(now)
  expect(deriveFocusProjectLanes(before, null, undefined, {}, now)).toHaveLength(1)
})
