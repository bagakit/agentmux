// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
import { useWorkspaceAgentClose } from '../src/renderer/src/components/WorkspaceAgentSelection'

const initial = useAppStore.getState(), one = composerSession('close-one'), two = composerSession('close-two')
const context = (session: typeof one) => ({ id: session.id, hostId: session.hostId, name: session.id, control: session.control }) as unknown as FocusContext
let root: Root, container: HTMLDivElement, hook: ReturnType<typeof useWorkspaceAgentClose>
function Host() { hook = useWorkspaceAgentClose(); return hook.dialog }
const button = (label: string) => document.querySelector<HTMLButtonElement>(`[role="dialog"] [data-confirm-label="${label}"]`)
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const stop = () => vi.mocked(api.sessions.stop)
const callFor = (session: typeof one) => stop().mock.calls.filter(call => call[0].kind === 'agent' && call[0].agentSessionId === session.control.agentSessionId)
const timeout = () => Object.assign(new Error('No response from the Runtime within 60s.'), { code: 'SESSION_STOP_TIMEOUT' })

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [one, two], error: null }, true)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'refresh')
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container); await act(async () => root.render(<Host />))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})

it('each selected Agent gets one intent; Continue Stop resends only the unconfirmed one with its same id', async () => {
  stop().mockImplementation(async control => { if (control.kind === 'agent' && control.agentSessionId === two.control.agentSessionId && callFor(two).length === 1) throw timeout() ; return undefined })
  await act(async () => hook.requestClose([context(one), context(two)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  const [oneId, twoId] = [callFor(one)[0]![1], callFor(two)[0]![1]]
  expect(oneId).not.toBe(twoId)
  expect(hook.results.map(result => result.completed)).toEqual([true, false])
  expect(dialog()?.textContent).toContain('Stop not confirmed')
  expect(dialog()?.querySelector(`[data-session-stop-operation="${twoId}"]`)?.textContent).toContain(`--operation-id ${twoId}`)
  await act(async () => button('Continue Stop')!.click()); await settle()
  expect(callFor(one)).toHaveLength(1)
  expect(callFor(two)[1]).toEqual([two.control, twoId])
  expect(dialog()).toBeNull()
})

it('a selection whose Run changed in the renderer is still sent: Core’s expectedRun is the only Run check', async () => {
  await act(async () => hook.requestClose([context(one)])); await settle()
  await act(async () => useAppStore.setState({ sessions: [{ ...one, control: { ...one.control, run: { runId: 'renderer-new-run' } } }, two] }))
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(stop()).toHaveBeenCalledExactlyOnceWith(one.control, expect.any(String))
})

it('Core’s STALE_AGENT_SESSION offers a fresh intent for the current Run, never Continue Stop with the old control', async () => {
  const current = { ...one, control: { ...one.control, run: { runId: 'current-run' } } }
  stop().mockRejectedValueOnce(Object.assign(new Error('Agent Session changed before its Run was stopped.'), { code: 'STALE_AGENT_SESSION' }))
  vi.mocked(api.sessions.refresh).mockResolvedValueOnce(current)
  await act(async () => hook.requestClose([context(one)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(dialog()?.textContent).toContain('The Run changed; stop the current Run current-run')
  expect(button('Continue Stop')).toBeNull()
  await act(async () => button('Stop current Runs')!.click()); await settle()
  expect(stop().mock.calls[1]![0]).toEqual(current.control)
  expect(stop().mock.calls[1]![1]).not.toBe(stop().mock.calls[0]![1])
})
