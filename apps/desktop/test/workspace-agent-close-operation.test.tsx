// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { sessionStopReceipt } from './helpers/session-stop-receipt'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'
import { useWorkspaceAgentClose } from '../src/renderer/src/components/WorkspaceAgentSelection'

const initial = useAppStore.getState(), one = composerSession('close-one'), two = composerSession('close-two'), three = composerSession('close-three')
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
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [one, two, three], error: null }, true)
  vi.spyOn(api.sessions, 'stop').mockImplementation(async (control, operationId) => control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
  vi.spyOn(api.sessions, 'refresh')
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container); await act(async () => root.render(<Host />))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})

it('each selected Agent closes its confirmation immediately and retains only its own unconfirmed intent for a later explicit selection', async () => {
  stop().mockImplementation(async (control, operationId) => {
    if (control.kind === 'agent' && control.agentSessionId === two.control.agentSessionId && callFor(two).length === 1) throw timeout()
    return control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined
  })
  await act(async () => hook.requestClose([context(one), context(two)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  const [oneId, twoId] = [callFor(one)[0]![1], callFor(two)[0]![1]]
  expect(oneId).not.toBe(twoId)
  expect(hook.results).toEqual(expect.arrayContaining([
    expect.objectContaining({ target: expect.objectContaining({ operationId: oneId }), completed: true }),
    expect.objectContaining({ target: expect.objectContaining({ operationId: twoId }), completed: false })
  ]))
  expect(dialog()).toBeNull()
  const retained = structuredClone(useAppStore.getState().agentOperations)
  await act(async () => useAppStore.setState({ agentOperations: retained }))
  await act(async () => hook.requestClose([context(two)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(callFor(one)).toHaveLength(1)
  expect(callFor(two)[1]).toEqual([two.control, twoId])
  expect(dialog()).toBeNull()
})

it('a slow member does not hold faster results or another selected batch', async () => {
  let release!: () => void
  stop().mockImplementation((control, operationId) => control.kind === 'agent' && control.agentSessionId === one.control.agentSessionId
    ? new Promise(resolve => { release = () => resolve(sessionStopReceipt(control, operationId!)) })
    : Promise.resolve(control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined))
  await act(async () => hook.requestClose([context(one), context(two)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(dialog()).toBeNull()
  expect(hook.results).toEqual([expect.objectContaining({ target: expect.objectContaining({ control: two.control }), completed: true })])
  await act(async () => hook.requestClose([context(three)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(callFor(three)).toHaveLength(1)
  expect(hook.results).toHaveLength(2)
  expect(Object.values(useAppStore.getState().agentOperations)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'stop', control: one.control, phase: 'pending' })
  ]))
  await act(async () => release()); await settle()
  expect(hook.results).toHaveLength(3)
  expect(hook.results.filter(result => result.completed)).toHaveLength(3)
})

it('selecting the same pending member again joins its original operation without a duplicate Stop', async () => {
  let release!: () => void
  stop().mockImplementation((control, operationId) => new Promise(resolve => {
    release = () => resolve(control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
  }))
  await act(async () => hook.requestClose([context(one)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  await act(async () => hook.requestClose([context(one)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(callFor(one)).toHaveLength(1)
  expect(dialog()).toBeNull()
  await act(async () => release()); await settle()
  expect(hook.results).toHaveLength(1)
})

it('a selection whose Run changed locally still sends only its frozen expectedRun to Core', async () => {
  await act(async () => hook.requestClose([context(one)])); await settle()
  await act(async () => useAppStore.setState({ sessions: [{ ...one, control: { ...one.control, run: { runId: 'renderer-new-run' } } }, two] }))
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(stop()).toHaveBeenCalledExactlyOnceWith(one.control, expect.any(String))
})

it('Core stale-Run failure never auto-refreshes or stops a replacement; a later selection confirms a new intent', async () => {
  const current = { ...one, control: { ...one.control, run: { runId: 'current-run' } } }
  stop().mockRejectedValueOnce(Object.assign(new Error('Agent Session changed before its Run was stopped.'), { code: 'STALE_AGENT_SESSION' }))
  await act(async () => hook.requestClose([context(one)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(dialog()).toBeNull()
  expect(api.sessions.refresh).not.toHaveBeenCalled()
  expect(hook.results[0]).toMatchObject({ completed: false, message: expect.stringContaining('原 Run 未停止') })
  expect(stop()).toHaveBeenCalledTimes(1)
  await act(async () => useAppStore.setState({ sessions: [current, two] }))
  await act(async () => hook.requestClose([context(current)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(stop().mock.calls[1]![0]).toEqual(current.control)
  expect(stop().mock.calls[1]![1]).not.toBe(stop().mock.calls[0]![1])
})

it('a void Agent Stop response remains unconfirmed and cannot be recorded as completed', async () => {
  stop().mockResolvedValueOnce(undefined)
  await act(async () => hook.requestClose([context(one)])); await settle()
  await act(async () => button('Close Agents')!.click()); await settle()
  expect(hook.results).toEqual([expect.objectContaining({ completed: false })])
  expect(Object.values(useAppStore.getState().agentOperations)).toEqual([
    expect.objectContaining({ kind: 'stop', control: one.control, phase: 'unconfirmed' })
  ])
})
