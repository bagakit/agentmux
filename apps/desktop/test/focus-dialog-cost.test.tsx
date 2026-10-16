// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'

// Avatar resource work is outside this dialog owner; card/menu/hooks/Store and
// the actual ConfirmationDialog/Modal/Portal consumer remain mounted.
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => <span /> }))
declare global {
  var __focusDialogCalls: Array<{ open: boolean; title: string; subject?: string }>
  var __focusDialogProbeLoaded: boolean
}
const baseline = useAppStore.getState()
let root: Root | undefined, container: HTMLElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); container = undefined
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  globalThis.__focusDialogCalls = []
})
function Scene() {
  const project = useMemo(createFocusProjectionSelector, []), { contexts } = useAppStore(project)
  return contexts.map(context => <FocusContextRow key={context.id} context={context} selected={false} onSelect={() => {}} />)
}
async function fixture(count: number) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.__focusDialogCalls = []
  expect(globalThis.__focusDialogProbeLoaded, 'Actual ConfirmationDialog probe loaded').toBe(true)
  const sessions = Array.from({ length: count }, (_, index) => composerSession(`dialog-owner-${index}`))
  useAppStore.setState({ ...baseline, config: composerConfig, sessions, tabs: {}, layouts: {}, timelines: {},
    agentNames: Object.fromEntries(sessions.map(session => [session.id, 'Same visible Agent'])), agentComposerDrafts: { original: 'Original unsent draft' }, mainSurface: 'agents' }, true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  await act(async () => root!.render(<Scene />))
  expect(container.querySelectorAll('button[data-session-id]')).toHaveLength(count)
  return sessions
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const confirm = () => document.querySelector<HTMLButtonElement>('[role="dialog"] [data-confirm-label]')!
async function open(sessionId: string, label: string) {
  const card = container!.querySelector<HTMLButtonElement>(`button[data-session-id="${sessionId}"]`)!
  await act(async () => { card.focus(); card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
  await settle()
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)
  expect(action).toBeTruthy(); await act(async () => action!.click()); await settle()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  return card
}

it.each([2, 279])('keeps %i actual idle Focus card consumers at zero dormant dialog entries', async count => {
  await fixture(count)
  expect(globalThis.__focusDialogCalls, 'Dormant Focus dialog entries').toHaveLength(0)
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
})

it('opens only the requested card dialog, preserves exact restart retry and restores focus after cancel/confirmation', async () => {
  const sessions = await fixture(2), target = sessions[1]!, before = useAppStore.getState()
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  const restart = vi.spyOn(api.sessions, 'restart').mockImplementationOnce(async (_control, operationId) => ({
    agentSessionId: target.id, expectedRun: target.control.run, operationId, previousRun: target.control.run,
    phase: 'unconfirmed', canRetry: true, observedAt: _tailFixtureEpoch(0, 0, 1)
  })).mockImplementation(async (_control, operationId) => ({
    agentSessionId: target.id, expectedRun: target.control.run, operationId, previousRun: target.control.run,
    phase: 'restarted', canRetry: false, observedAt: _tailFixtureEpoch(0, 0, 2), newRun: { runId: 'replacement-run' },
    session: { ...target, control: { ...target.control, run: { runId: 'replacement-run' } } }
  }))
  const card = await open(target.id, 'Stop Agent')
  expect(globalThis.__focusDialogCalls.length).toBeGreaterThan(0)
  expect(globalThis.__focusDialogCalls.every(call => call.open && call.title === 'Stop Agent?' && call.subject === 'Same visible Agent')).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click()); await settle()
  expect(document.activeElement).toBe(card); expect(stop).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled()
  globalThis.__focusDialogCalls = []
  await open(target.id, 'Restart Session…')
  expect(globalThis.__focusDialogCalls.every(call => call.open && call.title === 'Restart Session?')).toBe(true)
  await act(async () => confirm().click()); await settle()
  const operationId = restart.mock.calls[0]![1]
  expect(restart).toHaveBeenNthCalledWith(1, target.control, operationId, false)
  expect(confirm().textContent).toBe('Retry original restart')
  await act(async () => confirm().click()); await settle()
  expect(restart).toHaveBeenNthCalledWith(2, target.control, operationId, false)
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(card)
  expect(container!.querySelector(`button[data-session-id="${target.id}"]`)).toBe(card)
  for (const key of ['tabs', 'layouts', 'agentComposerDrafts', 'timelines'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
  expect(useAppStore.getState().sessions[0]).toBe(sessions[0]); expect(stop).not.toHaveBeenCalled()
})
