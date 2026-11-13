// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { sessionStopReceipt } from './helpers/session-stop-receipt'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => <span /> }))
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'

const initial = useAppStore.getState(), target = composerSession('stop-op-target')
const tab = createWorkbenchTab('stop-op-tab', { kind: 'agent', regionId: 'stop-op-region', phase: 'attached', workspaceId: 'workspace', sessionId: target.id })
let root: Root, container: HTMLDivElement
function Scene() {
  const project = useMemo(createFocusProjectionSelector, [])
  const { contexts } = useAppStore(project)
  return <>{contexts.map(context => <FocusContextRow key={context.id} context={context} selected={false} onSelect={() => {}} />)}</>
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (label: string) => document.querySelector<HTMLButtonElement>(`[role="dialog"] [data-confirm-label="${label}"]`)
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const stop = () => vi.mocked(api.sessions.stop)
const sentIds = () => stop().mock.calls.map(call => call[1])
async function open() {
  const origin = container.querySelector<HTMLButtonElement>(`button[data-session-id="${target.id}"]`)!
  await act(async () => { origin.focus(); origin.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 })) })
  await settle()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === 'Stop Agent')!
  await act(async () => item.click()); await settle()
  expect(dialog()?.textContent).toContain('Stop Agent?')
}
const timeout = () => Object.assign(new Error('Closing this session had no response from the Runtime within 60s.'), { code: 'SESSION_STOP_TIMEOUT' })

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [target], agentNames: { [target.id]: 'Stop target' }, timelines: {},
    tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('stop-op-group', [tab.id]) }, activeWorkspaceId: 'workspace', mainSurface: 'agents',
    scratchTopicSnapshots: {}, error: null, agentFocus: { execution: { sessionId: target.id, history: [] }, pmo: { sessionId: null } } }, true)
  vi.spyOn(api.sessions, 'stop').mockImplementation(async (control, operationId) => control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
  vi.spyOn(api.sessions, 'refresh')
  vi.spyOn(api.sessions, 'inspectStop').mockImplementation(async (control) => ({ agentSessionId: control.agentSessionId, expectedRun: control.run, phase: 'stopping', canRetry: true, operationIdMatched: true, failure: { stage: 'runtime-stop', code: 'SESSION_STOP_TIMEOUT', message: 'The original Stop still needs confirmation.', observedAt: Date.now() }, observedAt: Date.now() }))
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container); await act(async () => root.render(<Scene />))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})

const feedbackButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.agent-operation-feedback__actions button')].find(item => item.textContent === label)!
const operation = (operationId: string) => Object.values(useAppStore.getState().agentOperations).find(item => item.operationId === operationId)

it('the confirmation closes immediately and unknown Stop is checked without replay before explicit same-operation continuation', async () => {
  stop().mockRejectedValueOnce(timeout())
  await open()
  await act(async () => button('Stop Agent')!.click()); await settle()
  expect(stop()).toHaveBeenCalledTimes(1)
  const [control, operationId] = stop().mock.calls[0]!
  expect(control).toEqual(target.control)
  expect(operationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
  expect(dialog()).toBeNull()
  expect(container.textContent).toContain('停止未确认')
  expect(operation(operationId!)?.phase).toBe('unconfirmed')
  expect(useAppStore.getState().errorNoticeContext?.summary).toContain(operationId)
  await act(async () => feedbackButton('核对原操作').click()); await settle()
  expect(api.sessions.inspectStop).toHaveBeenCalledExactlyOnceWith(target.control, operationId)
  expect(stop()).toHaveBeenCalledTimes(1)
  await act(async () => feedbackButton('继续同次停止').click()); await settle()
  expect(stop()).toHaveBeenCalledTimes(2)
  expect(stop().mock.calls[1]).toEqual([target.control, operationId])
  expect(dialog()).toBeNull()
})

it('a new explicit Stop request after a confirmed receipt is a new intent', async () => {
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  expect(new Set(sentIds()).size).toBe(2)
})

it('reopening Stop for an unconfirmed Run retains its original durable operation reference', async () => {
  stop().mockRejectedValueOnce(timeout())
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  const retained = structuredClone(useAppStore.getState().agentOperations)
  await act(async () => useAppStore.setState({ agentOperations: retained }))
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  expect(sentIds()[1]).toBe(sentIds()[0])
  expect(dialog()).toBeNull()
})

it('the failed stage and code Core recorded remain in the shared operation details', async () => {
  stop().mockRejectedValueOnce(Object.assign(new Error('Runtime refused the stop frame.'), { code: 'CTXMUX_TIMEOUT', stage: 'runtime-stop' }))
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  expect(dialog()).toBeNull()
  expect(container.textContent).toContain('runtime-stop')
  expect(container.textContent).toContain('CTXMUX_TIMEOUT')
  expect(feedbackButton('核对原操作').disabled).toBe(false)
})

it('a pending Stop leaves the original card readable with 停止中 and does not keep a modal open', async () => {
  let release!: () => void
  stop().mockImplementationOnce((control, operationId) => new Promise(resolve => {
    release = () => resolve(control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
  }))
  await open()
  await act(async () => { button('Stop Agent')!.click() })
  try {
    expect(dialog()).toBeNull()
    expect(container.querySelector('.agent-operation-feedback[data-phase="pending"]')?.textContent).toContain('停止中')
    expect(container.querySelector(`button[data-session-id="${target.id}"]`)).not.toBeNull()
    expect(stop()).toHaveBeenCalledTimes(1)
  } finally { await act(async () => release()); await settle() }
  expect(dialog()).toBeNull()
})

it('a Run changed in the renderer is still sent once with the original frozen expectedRun', async () => {
  await open()
  await act(async () => useAppStore.setState({ sessions: [{ ...target, control: { ...target.control, run: { runId: 'new-run' } } }] }))
  await act(async () => button('Stop Agent')!.click()); await settle()
  expect(stop()).toHaveBeenCalledExactlyOnceWith(target.control, expect.any(String))
})

it('Core stale-Run failure stays on the original operation; stopping a replacement Run needs a new explicit confirmation', async () => {
  const current = { ...target, control: { ...target.control, run: { runId: 'current-run' } } }
  stop().mockRejectedValueOnce(new AgentMuxError('Agent Session changed before its Run was stopped.', 'STALE_AGENT_SESSION'))
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  expect(api.sessions.refresh).not.toHaveBeenCalled()
  expect(dialog()).toBeNull()
  expect(operation(sentIds()[0]!)?.phase).toBe('failed')
  expect(operation(sentIds()[0]!)?.message).toContain('原 Run 未停止')
  expect(stop()).toHaveBeenCalledTimes(1)
  await act(async () => useAppStore.setState({ sessions: [current] }))
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  expect(stop().mock.calls[1]![0]).toEqual(current.control)
  expect(sentIds()[1]).not.toBe(sentIds()[0])
})

it('unmounting the confirmation caller cannot cancel the already submitted original Stop', async () => {
  let release!: () => void
  stop().mockImplementationOnce((control, operationId) => new Promise(resolve => {
    release = () => resolve(control.kind === 'agent' ? sessionStopReceipt(control, operationId!) : undefined)
  }))
  await open(); await act(async () => button('Stop Agent')!.click())
  const operationId = sentIds()[0]!
  await act(async () => root.render(null))
  await act(async () => release()); await settle()
  expect(operation(operationId)?.phase).toBe('succeeded')
  expect(stop()).toHaveBeenCalledTimes(1)
  expect(dialog()).toBeNull()
})
