// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'

vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => <span /> }))
declare global {
  var __focusMenuPortalCalls: unknown[]
  var __focusMenuPortalProbeLoaded: boolean
}
const baseline = useAppStore.getState()
let root: Root | undefined, container: HTMLElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
  root = undefined; container?.remove(); container = undefined
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  globalThis.__focusMenuPortalCalls = []
})
function Scene({ active = true }: { active?: boolean }) {
  const project = useMemo(createFocusProjectionSelector, []), { contexts } = useAppStore(project)
  return <WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}>{contexts.map(context => <FocusContextRow key={context.id} context={context} selected={false} onSelect={() => {}} />)}<input aria-label="Later input" /></WorkbenchPresentationContext.Provider>
}
async function fixture(count: number) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); globalThis.__focusMenuPortalCalls = []
  expect(globalThis.__focusMenuPortalProbeLoaded, 'Actual DocumentOverlayPortal probe loaded').toBe(true)
  const sessions = Array.from({ length: count }, (_, index) => composerSession(`menu-owner-${index}`))
  useAppStore.setState({ ...baseline, config: composerConfig, sessions, tabs: {}, layouts: {}, timelines: {}, mainSurface: 'agents',
    agentNames: Object.fromEntries(sessions.map(session => [session.id, 'Same visible Agent'])), agentComposerDrafts: { original: 'Original unsent draft' } }, true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  await act(async () => root!.render(<Scene />))
  expect(container.querySelectorAll('button[data-session-id]')).toHaveLength(count)
  return sessions
}
const portalCalls = () => globalThis.__focusMenuPortalCalls.filter(component => component === ContextMenu.Portal)
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
async function open(card: HTMLElement, method: 'mouse' | 'keyboard') {
  await act(async () => {
    card.focus()
    card.dispatchEvent(method === 'mouse' ? new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40 })
      : new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))
  })
  await settle()
  const menu = document.querySelector<HTMLElement>('.focus-context-menu')!
  expect(menu).not.toBeNull(); expect(menu.dataset.agentSessionId).toBe(card.dataset.sessionId)
  expect(portalCalls().length).toBeGreaterThan(0)
  return menu
}

it.each([2, 279])('keeps %i closed real Focus menus at zero Portal owner entries', async count => {
  await fixture(count)
  expect(portalCalls(), 'Closed Focus menu Portal entries').toHaveLength(0)
})

it.each(['mouse', 'keyboard'] as const)('preserves %s menu Escape, rename cancellation and later input focus', async method => {
  const sessions = await fixture(2), target = sessions[1]!, before = useAppStore.getState()
  const stop = vi.spyOn(api.sessions, 'stop'), restart = vi.spyOn(api.sessions, 'restart')
  const card = container!.querySelector<HTMLButtonElement>(`button[data-session-id="${target.id}"]`)!
  const menu = await open(card, method)
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
  expect(document.querySelector('.focus-context-menu')).toBeNull(); expect(document.activeElement).toBe(card)
  const rename = [...(await open(card, method)).querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Rename Agent')!
  await act(async () => rename.click()); await settle()
  const input = container!.querySelector<HTMLInputElement>('.focus-context__rename')!
  expect(input).not.toBeNull(); expect(document.activeElement).toBe(input)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await settle()
  const restored = container!.querySelector<HTMLButtonElement>(`button[data-session-id="${target.id}"]`)!
  expect(document.activeElement).toBe(restored); expect(useAppStore.getState().agentNames).toBe(before.agentNames)
  await open(restored, method)
  const later = container!.querySelector<HTMLInputElement>('[aria-label="Later input"]')!
  await act(async () => later.focus()); await settle()
  expect(document.querySelector('.focus-context-menu')).toBeNull(); expect(document.activeElement).toBe(later)
  expect(stop).not.toHaveBeenCalled(); expect(restart).not.toHaveBeenCalled()
  for (const key of ['sessions', 'tabs', 'layouts', 'agentComposerDrafts', 'timelines'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})

it('uses current inactive presentation on close even though the Portal no longer renders Content', async () => {
  const sessions = await fixture(2), target = sessions[1]!
  const card = container!.querySelector<HTMLButtonElement>(`button[data-session-id="${target.id}"]`)!
  await open(card, 'keyboard')
  const focus = vi.spyOn(card, 'focus')
  // A hidden/deactivated workface can lose focus to its document body. The old
  // active=true Content callback must not restore that now-inactive card.
  vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body)
  await act(async () => root!.render(<Scene active={false} />)); await settle()
  expect(document.querySelector('.focus-context-menu')).toBeNull()
  expect(focus, 'Inactive menu close does not restore the original card').not.toHaveBeenCalled()
})
