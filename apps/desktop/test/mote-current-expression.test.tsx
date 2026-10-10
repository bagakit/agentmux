// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentActivityRemainingMs } from '@agentmux/core/agent-status'
import { MoteIdentityMotion } from '../src/renderer/src/components/MoteIdentityMotion'
import { MoteFace } from '../src/renderer/src/components/MoteFace'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import { useAppStore } from '../src/renderer/src/store'
import { observeAgentSession } from '../src/renderer/src/lib/agent-observation'
import { currentMote } from './fixtures/mote-current-expression'
import * as authority from '../src/renderer/src/lib/mote-expression'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/lib/mote-face-motion', () => ({ observeMoteMotion: () => ({ update() {}, dispose() {} }) }))
const baseline = useAppStore.getState()
let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(_historyFixtureEpoch(0, 2000, 0))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useAppStore.setState(baseline, true); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(id = 'expression-original', visible = true) {
  await act(async () => root.render(<MoteIdentityMotion moteSessionId={id} moteHostId="local" visible={visible}>{expression => <MoteFace face={DEFAULT_MOTE_FACE} expression={expression} />}</MoteIdentityMotion>))
}
const expression = () => host.querySelector<HTMLElement>('[data-mote-expression]')!.dataset.moteExpression
async function set(session = currentMote()) { await act(async () => useAppStore.setState({ sessions: [session] })) }
it('the mounted original identity consumes current idle/unknown/Run and input facts, never retained working', async () => {
  const session = currentMote(); await set(session); await mount()
  const originalFace = host.querySelector('.mote-face')!
  expect(expression()).toBe('thinking')
  await set({ ...session, currentActivity: { ...session.currentActivity!, state: 'idle', nativeTurnId: 'turn-original' } })
  expect(expression()).toBe('idle'); expect(host.querySelector('.mote-face')).toBe(originalFace)
  await set({ ...session, currentActivity: { ...session.currentActivity!, state: 'unknown' } })
  expect(expression()).toBe('unknown')
  await set({ ...session, currentActivity: { ...session.currentActivity!, run: { runId: 'retired-run' } } })
  expect(expression()).toBe('unknown')
  await set({ ...session, processState: 'exited' }); expect(expression()).toBe('stopped')
  await set({ ...session, pendingInteraction: { kind: 'question' } as never }); expect(expression()).toBe('waiting')
  expect(useAppStore.getState().sessions[0]?.control).toEqual(session.control)
  expect(useAppStore.getState().stopSession).toBe(baseline.stopSession)
})
it('an actual current observation survives a retained completion, admits only exact liveTool, and expires without any event', async () => {
  const current = currentMote(), session = { ...current, status: { ...current.status, state: 'done' as const } }
  const remaining = agentActivityRemainingMs(observeAgentSession(session, Date.now()), Date.now())
  expect(remaining).toBeGreaterThan(0)
  await set(session); await mount(); expect(expression()).toBe('thinking')
  const liveTool = { itemId: 'real-tool', hostId: 'local', runId: session.control.run.runId, epoch: session.semanticStatus!.stateEnteredAt!, observedAt: Date.now(), startedAt: Date.now() }
  await act(async () => useAppStore.setState({ timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [], liveTool } } }))
  expect(expression()).toBe('tool')
  await act(async () => useAppStore.setState({ timelines: { [session.id]: { agentSessionId: session.id, revision: 2, items: [], liveTool: { ...liveTool, runId: 'retired-run' } } } }))
  expect(expression()).toBe('thinking')
  const original = useAppStore.getState().sessions[0]
  await act(async () => vi.advanceTimersByTimeAsync(remaining))
  expect(expression()).toBe('unknown')
  expect(useAppStore.getState().sessions[0]).toBe(original)
  expect(host.querySelector('.mote-face')?.getAttribute('data-mote-face-palette')).toBe(DEFAULT_MOTE_FACE.palette)
})
it('new exact evidence replaces the old wake; unrelated Sessions do not rerender this consumer', async () => {
  const original = currentMote(); await set(original); await mount()
  const remaining = agentActivityRemainingMs(observeAgentSession(original, Date.now()), Date.now())
  await act(async () => vi.advanceTimersByTimeAsync(remaining / 2))
  const refreshed = currentMote(); await set(refreshed)
  const projection = vi.spyOn(authority, 'moteExpressionPresentation'); projection.mockClear()
  await act(async () => { for (let index = 0; index < 60; index++) useAppStore.setState({ sessions: [refreshed, { ...original, id: 'unrelated-' + index }] }) })
  expect(projection).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(remaining / 2))
  expect(expression()).toBe('thinking')
  await act(async () => vi.advanceTimersByTimeAsync(remaining / 2))
  expect(expression()).toBe('unknown')
})
it('foreground rechecks elapsed evidence and static identity adds no activity timer or Session subscription', async () => {
  const session = currentMote(); await set(session); await mount()
  let hidden = true; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  const remaining = agentActivityRemainingMs(observeAgentSession(session, Date.now()), Date.now())
  vi.setSystemTime(Date.now() + remaining + 1); hidden = false
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(expression()).toBe('unknown')
  await act(async () => root.render(<MoteIdentityMotion>{value => <MoteFace face={DEFAULT_MOTE_FACE} expression={value} />}</MoteIdentityMotion>))
  expect(expression()).toBe('identity'); expect(vi.getTimerCount()).toBe(0)
  const projection = vi.spyOn(authority, 'moteExpressionPresentation'); projection.mockClear()
  await set({ ...session, id: 'unrelated' }); expect(projection).not.toHaveBeenCalled()
})
