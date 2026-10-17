// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { RegionContextMenu } from '../src/renderer/src/components/RegionContextMenu'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { api } from '../src/renderer/src/lib/api'
import { formatRegionAddress, formatSessionAddress } from '../src/renderer/src/lib/agent-address'
import * as presentation from '../src/renderer/src/lib/session-presentation'
import * as store from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const tabId = 'original-tab', regionId = 'original-region', canonical = 'original-agent'
type Entry = 'region-context' | 'header-context' | 'more'
const entries: Entry[] = ['region-context', 'header-context', 'more']

function originalSession(runId = 'original-run', label = 'Original Agent') {
  return { ...composerSession('original-presentation'), label, hostId: 'remote',
    control: { kind: 'agent' as const, hostId: 'remote', agentSessionId: canonical, run: { runId } } }
}

function scene(entry: Entry, copy: (text: string) => Promise<void>, session = originalSession()) {
  return <RegionContextMenu tabId={tabId} regionId={regionId} agentSessionId={canonical}
    splitMenu={[]} swapMenu={[]} writeClipboardText={copy}>
    {entry === 'region-context' ? <button>Original Region</button> : <section><AgentRegionHeader
      name={session.label} executorLabel="Original executor" sessionId={canonical} sessionKind="agent"
      executionHost={{ id: 'remote', label: 'Original Host', kind: 'unknown', configured: false, cwd: session.workspacePath }}
      regionId={regionId} readOnly={false} onHistory={undefined} nativeSession={session} /></section>}
  </RegionContextMenu>
}

function item(menu: HTMLElement, label: string) {
  const found = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent?.trim() === label)
  expect(found, `original menu item: ${label}`).toBeDefined()
  return found!
}

async function open(entry: Entry) {
  await act(async () => {
    if (entry === 'more') {
      const trigger = dom.container.querySelector<HTMLElement>('.agent-region-header__more')!
      expect(trigger).not.toBeNull()
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    } else {
      const trigger = dom.container.querySelector<HTMLElement>(entry === 'header-context' ? '.agent-region-header' : 'button')!
      expect(trigger).not.toBeNull()
      trigger.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }))
    }
  })
  const selector = entry === 'region-context' ? '.region-context-menu' : `.agent-region-menu[data-menu-entry="${entry === 'more' ? 'more' : 'context'}"]`
  await vi.waitFor(() => expect(document.querySelector(`${selector}[data-state="open"]`)).not.toBeNull())
  return document.querySelector<HTMLElement>(`${selector}[data-state="open"]`)!
}

async function copyMenu(entry: Entry, menu: HTMLElement) {
  if (entry === 'region-context') return menu
  const trigger = item(menu, 'Copy link')
  await act(async () => {
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  await vi.waitFor(() => expect(document.getElementById(trigger.getAttribute('aria-controls')!)).not.toBeNull())
  return document.getElementById(trigger.getAttribute('aria-controls')!)!
}

function executionReader() {
  // Core spatial execution is the controlled boundary; selectors, index, Store and menus are real.
  return vi.spyOn(store, 'agentRegionExecution').mockReturnValue({ hostId: 'remote', cwd: originalSession().workspacePath })
}

it.each([1, 32, 100])('does no target derivation for %i closed menus on unrelated publications', async count => {
  const sessions = Array.from({ length: count }, (_,index) => composerSession(`closed-agent-${index}`))
  const execution = executionReader(), index = vi.spyOn(presentation, 'agentSessionPresentationIndex')
  store.useAppStore.setState({ sessions })
  await dom.render(<>{sessions.map(session => <RegionContextMenu key={session.id} tabId={tabId}
    regionId={`region-${session.id}`} agentSessionId={session.id} splitMenu={[]} swapMenu={[]} writeClipboardText={async () => {}}>
    <button>{session.id}</button></RegionContextMenu>)}</>)
  expect(dom.container.querySelectorAll('button')).toHaveLength(count)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  execution.mockClear(); index.mockClear()
  for (let i = 0; i < 20; i++) await act(async () => store.useAppStore.setState(state => ({
    agentComposerDrafts: { ...state.agentComposerDrafts, unrelated: `Unrelated draft ${i}` }
  })))
  expect(execution.mock.calls.length, 'closed menu execution work').toBe(0)
  expect(index.mock.calls.length, 'closed menu Session index work').toBe(0)
  expect(dom.container.querySelectorAll('button')).toHaveLength(count)
})

it.each(entries.flatMap(entry => (['Copy Region Link', 'Copy Agent Link'] as const).map(label => ({ entry, label }))))('copies $label from current exact facts via $entry', async ({ entry, label }) => {
  const execution = executionReader(), copy = vi.fn(async (_text: string) => {})
  const foreign = composerSession(canonical), current = originalSession('latest-run', 'Current Agent')
  store.useAppStore.setState({ sessions: [foreign] })
  await dom.render(scene(entry, copy))
  await act(async () => store.useAppStore.setState({ sessions: [foreign, current] }))
  await dom.render(scene(entry, copy, current))
  if (entry !== 'region-context') expect(dom.container.querySelector('.agent-region-header__name')?.textContent).toBe(current.label)
  const menu = await open(entry)
  expect(execution).toHaveBeenCalledWith({ tabId, regionId, agentSessionId: canonical })
  const copies = await copyMenu(entry, menu)
  await act(async () => item(copies, label).click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(label === 'Copy Region Link' ? formatRegionAddress(regionId) : formatSessionAddress(canonical))
  await vi.waitFor(() => expect(document.querySelector('[role="menu"][data-state="open"]')).toBeNull())
})

it.each(entries)('uses current exact Host/Run while %s is open and retains its dialog operation after closing', async entry => {
  const execution = executionReader(), index = vi.spyOn(presentation, 'agentSessionPresentationIndex')
  const original = originalSession(), closedUpdate = originalSession('closed-update-run'), current = originalSession('open-update-run', 'Current original Agent')
  const foreign = composerSession(canonical), copy = vi.fn(async (_text: string) => {})
  const restartAction = store.useAppStore.getState().restartSession
  const restart = vi.spyOn(api.sessions, 'restart').mockImplementation(async (control, operationId) => ({
    agentSessionId: canonical, expectedRun: control.run, previousRun: control.run, operationId,
    phase: 'unconfirmed', canRetry: false, observedAt: 1
  }))
  store.useAppStore.setState({ sessions: [foreign, original], agentComposerDrafts: { [canonical]: 'Keep original draft' } })
  await dom.render(scene(entry, copy))
  await act(async () => store.useAppStore.setState({ sessions: [foreign, closedUpdate] }))
  const menu = await open(entry)
  await act(async () => store.useAppStore.setState({ sessions: [foreign, current] }))
  await act(async () => item(menu, 'Restart Session…').click())
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(current.label)
  await vi.waitFor(() => expect(document.querySelector('[role="menu"][data-state="open"]')).toBeNull())
  execution.mockClear(); index.mockClear()
  await act(async () => store.useAppStore.setState(state => ({ agentNames: { ...state.agentNames, unrelated: 'Other Agent' } })))
  expect(execution.mock.calls.length, 'closed menu stays idle while the independent dialog is open').toBe(0)
  expect(index).not.toHaveBeenCalled()
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [data-confirm-label]')!.click())
  await vi.waitFor(() => expect(restart).toHaveBeenCalledExactlyOnceWith(current.control, expect.any(String), false))
  const operationId = restart.mock.calls[0]![1]
  await act(async () => store.useAppStore.setState({ sessions: [foreign, originalSession('later-run')] }))
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [data-confirm-label]')!.click())
  await vi.waitFor(() => expect(restart).toHaveBeenNthCalledWith(2, current.control, operationId, true))
  expect(store.useAppStore.getState().restartSession).toBe(restartAction)
  expect(store.useAppStore.getState().agentComposerDrafts[canonical]).toBe('Keep original draft')
  expect(store.useAppStore.getState().sessions[0]).toBe(foreign)
  expect(copy).not.toHaveBeenCalled()
})

it.each(['missing-execution', 'foreign-only', 'ambiguous'] as const)('preserves original %s target uncertainty in an open menu', async condition => {
  const execution = executionReader(), original = originalSession()
  if (condition === 'missing-execution') execution.mockReturnValue(null)
  const sessions = condition === 'foreign-only' ? [composerSession(canonical)] : condition === 'ambiguous'
    ? [original, { ...original, id: 'second-presentation' }] : [original]
  const restart = vi.spyOn(api.sessions, 'restart').mockRejectedValue(new Error('Unexpected restart'))
  const reportError = vi.spyOn(store.useAppStore.getState(), 'reportError')
  store.useAppStore.setState({ sessions })
  await dom.render(scene('region-context', async () => {}))
  const menu = await open('region-context')
  expect([...menu.querySelectorAll('[role="menuitem"]')].some(element => element.textContent === 'Copy Agent Link')).toBe(false)
  await act(async () => item(menu, 'Restart Session…').click())
  expect(reportError).toHaveBeenCalled()
  expect(store.useAppStore.getState().error).toContain('original Agent Run is not confirmed')
  expect(restart).not.toHaveBeenCalled()
  expect(store.useAppStore.getState().sessions).toBe(sessions)
})
