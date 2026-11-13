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
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'refresh')
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container); await act(async () => root.render(<Scene />))
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})

it('one Stop intent sends one operation id and Continue Stop resends exactly that id and Run', async () => {
  stop().mockRejectedValueOnce(timeout())
  await open()
  await act(async () => button('Stop Agent')!.click()); await settle()
  expect(stop()).toHaveBeenCalledTimes(1)
  const [control, operationId] = stop().mock.calls[0]!
  expect(control).toEqual(target.control)
  expect(operationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
  // The failure shows the operation so inspect reads the same Stop.
  expect(dialog()?.textContent).toContain('Stop not confirmed')
  expect(dialog()?.querySelector(`[data-session-stop-operation="${operationId}"]`)?.textContent)
    .toContain(`amux agent stop inspect --session ${target.control.agentSessionId} --run ${target.control.run.runId} --operation-id ${operationId}`)
  expect(useAppStore.getState().errorNoticeContext?.summary).toContain(operationId)
  await act(async () => button('Continue Stop')!.click()); await settle()
  expect(stop()).toHaveBeenCalledTimes(2)
  expect(stop().mock.calls[1]).toEqual([target.control, operationId])
  // Success closes quietly.
  expect(dialog()).toBeNull()
})

it('a new Stop request after success is a new intent with a new id', async () => {
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  expect(new Set(sentIds()).size).toBe(2)
})

it('reopening Stop for a Run whose Stop is unconfirmed continues that same operation', async () => {
  stop().mockRejectedValueOnce(timeout())
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] .confirmation-dialog__cancel')!.click()); await settle()
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  expect(sentIds()[1]).toBe(sentIds()[0])
})

it('the failed stage Core recorded is shown with the one action that works', async () => {
  stop().mockRejectedValueOnce(Object.assign(new Error('Runtime refused the stop frame.'), { code: 'CTXMUX_TIMEOUT', stage: 'runtime-stop' }))
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  expect(dialog()?.textContent).toContain('Failed stage: runtime-stop (CTXMUX_TIMEOUT)')
  expect(button('Continue Stop')?.disabled).toBe(false)
})

it('shows elapsed time while the Stop is in flight', async () => {
  let release!: () => void
  stop().mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(undefined) }))
  await open()
  await act(async () => button('Stop Agent')!.click())
  expect(dialog()?.querySelector('[data-session-stop-elapsed]')?.textContent).toBe('Stopping · 0s')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1_100)) })
  expect(dialog()?.querySelector('[data-session-stop-elapsed]')?.textContent).toBe('Stopping · 1s')
  await act(async () => release()); await settle()
  expect(dialog()).toBeNull()
})

it('a Run changed in the renderer is still sent once: Core’s expectedRun is the only Run check', async () => {
  await open()
  await act(async () => useAppStore.setState({ sessions: [{ ...target, control: { ...target.control, run: { runId: 'new-run' } } }] }))
  await act(async () => button('Stop Agent')!.click()); await settle()
  expect(stop()).toHaveBeenCalledExactlyOnceWith(target.control, expect.any(String))
})

it('Core’s STALE_AGENT_SESSION re-reads the Session and offers a fresh intent for the current Run; it never loops Continue Stop', async () => {
  const current = { ...target, control: { ...target.control, run: { runId: 'current-run' } } }
  stop().mockRejectedValueOnce(new AgentMuxError('Agent Session changed before its Run was stopped.', 'STALE_AGENT_SESSION'))
  vi.mocked(api.sessions.refresh).mockResolvedValueOnce(current)
  await open(); await act(async () => button('Stop Agent')!.click()); await settle()
  expect(api.sessions.refresh).toHaveBeenCalledExactlyOnceWith(target.control)
  expect(dialog()?.textContent).toContain('The Run changed; stop the current Run')
  expect(button('Continue Stop')).toBeNull()
  await act(async () => button('Stop current Run')!.click()); await settle()
  expect(stop().mock.calls[1]![0]).toEqual(current.control)
  expect(stop().mock.calls[1]![1]).not.toBe(sentIds()[0])
  expect(dialog()).toBeNull()
})
