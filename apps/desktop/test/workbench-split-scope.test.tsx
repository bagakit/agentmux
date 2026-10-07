// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import { createWorkspaceLayout, type SplitDirection } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
// Native coverage keeps the actual xterm/Run. Here only resource rendering is isolated;
// both original Workbench split consumers and the installed panel library stay mounted.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <textarea aria-label="Original terminal input" defaultValue="Retained draft" /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <textarea aria-label="Original composer" /> }))
vi.mock('../src/renderer/src/components/EditorPane', () => ({ EditorPane: () => <div>Original editor</div> }))
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const initial = useAppStore.getState()
const workspaceId = 'scope-workspace', tabId = 'scope-tab', otherTabId = 'scope-other-tab'
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.hasAttribute('data-resize-handle')) {
      const group = this.closest('[data-panel-group]')!
      const first = [...group.children].find(element => element.hasAttribute('data-panel')) as HTMLElement
      const ratio = Number(first.style.flexGrow) / 100
      return group.getAttribute('data-panel-group-direction') === 'horizontal'
        ? new DOMRect(ratio * 1000, 0, 1, 600) : new DOMRect(0, ratio * 600, 1000, 1)
    }
    return new DOMRect(0, 0, 1000, 600)
  })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => { pointer(document.body, 'pointerup', 0, 0, 0); root.unmount() })
  host.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function pointer(target: Element, type: string, x: number, y: number, buttons: number) {
  target.dispatchEvent(new PointerEvent(type, { isPrimary: true, clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true }))
}
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
function originalRatio(consumer: 'region' | 'group', direction: SplitDirection, ratio: number) {
  useAppStore.setState(state => consumer === 'region' ? { tabs: { ...state.tabs,
    [tabId]: { ...state.tabs[tabId]!, layout: { ...state.tabs[tabId]!.layout,
      root: { ...state.tabs[tabId]!.layout.root, direction, ratio } } } } }
    : { layouts: { ...state.layouts, [workspaceId]: { ...state.layouts[workspaceId]!,
      root: { ...state.layouts[workspaceId]!.root, direction, ratio } } } })
}

it.each(['region', 'group'] as const)('keeps the original %s consumer safe across direction and accepted ratio changes during dragging', async consumer => {
  const sessions = (await api.sessions.snapshot()).sessions.filter(session => session.kind === 'agent').slice(0, 2)
  expect(sessions).toHaveLength(2)
  const originalConfig = await api.config.get(), changed = vi.fn()
  const config = { ...originalConfig, workspaces: [{ id: workspaceId, name: 'Original split scope', hostId: originalConfig.hosts[0]!.id, path: fixturePath('scope-workspace'), kind: 'folder' as const }] }
  let tab = createWorkbenchTab(tabId, { kind: 'agent', phase: 'attached', regionId: 'scope-region', workspaceId, sessionId: sessions[0]!.id })
  const other = createWorkbenchTab(otherTabId, { kind: 'agent', phase: 'attached', regionId: 'scope-other-region', workspaceId, sessionId: sessions[1]!.id })
  if (consumer === 'region') tab = addWorkbenchRegion(tab, 'scope-region', 'right', other.regions['scope-other-region']!)
  const layout = createWorkspaceLayout('scope-group', [tabId])
  if (consumer === 'group') {
    layout.groups.push(createWorkspaceLayout('scope-other-group', [otherTabId]).groups[0]!)
    layout.root = { type: 'split', direction: 'horizontal', ratio: 0.65,
      first: { type: 'leaf', groupId: 'scope-group' }, second: { type: 'leaf', groupId: 'scope-other-group' } }
  }
  useAppStore.setState({ ...initial, config, sessions, localHome: fixturePath('scope-home'), activeWorkspaceId: workspaceId,
    tabs: consumer === 'region' ? { [tabId]: tab } : { [tabId]: tab, [otherTabId]: other }, layouts: { [workspaceId]: layout },
    viewModes: Object.fromEntries(sessions.map(session => [session.id, 'terminal'])),
    updateRegionSplitRatio: (workspace, target, path, ratio) => changed(workspace, target, path, ratio),
    updateSplitRatio: (workspace, path, ratio) => changed(workspace, path, ratio)
  }, true)
  originalRatio(consumer, 'horizontal', 0.65)
  await act(async () => root.render(<WorkspaceWorkbench workspaceId={workspaceId} />)); await settle()
  const selector = consumer === 'region' ? '.workbench-region-resize-handle' : '.pane-resize-handle'
  const group = host.querySelector(selector)!.parentElement!
  const editor = host.querySelector<HTMLTextAreaElement>('[aria-label="Original terminal input"]')!
  editor.focus(); editor.setSelectionRange(2, 7)
  const originalEditor = editor, originalPanels = [...group.children].filter(element => element.hasAttribute('data-panel'))

  for (const [direction, accepted, released] of [['vertical', 0.65, 0.7], ['horizontal', 0.58, 0.61]] as const) {
    await act(async () => originalRatio(consumer, 'horizontal', 0.65)); await settle(); changed.mockClear()
    let handle = host.querySelector(selector)!, bounds = handle.getBoundingClientRect()
    await act(async () => pointer(handle, 'pointerdown', bounds.x + bounds.width / 2, 150, 1))
    await act(async () => pointer(document.body, 'pointermove', 500, 150, 1))
    expect(Number(originalPanels[0]!.getAttribute('data-panel-size'))).toBeCloseTo(50)
    expect(changed).not.toHaveBeenCalled()
    await act(async () => originalRatio(consumer, direction, accepted)); await settle()
    expect(host.querySelector(selector)!.parentElement).toBe(group)
    expect([...group.children].filter(element => element.hasAttribute('data-panel'))).toEqual(originalPanels)
    expect(host.querySelector('[aria-label="Original terminal input"]')).toBe(originalEditor)
    expect(document.activeElement).toBe(editor)
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 7])
    expect(Number(originalPanels[0]!.getAttribute('data-panel-size'))).toBeCloseTo(accepted * 100)
    await act(async () => {
      pointer(document.body, 'pointermove', 450, 190, 1)
      pointer(document.body, 'pointerup', 450, 190, 0)
    })
    expect(changed).not.toHaveBeenCalled()
    handle = host.querySelector(selector)!; bounds = handle.getBoundingClientRect()
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
    const endX = x + (direction === 'horizontal' ? 30 : 0), endY = y + (direction === 'vertical' ? 30 : 0)
    await act(async () => pointer(handle, 'pointerdown', x, y, 1))
    await act(async () => pointer(document.body, 'pointermove', endX, endY, 1))
    await act(async () => pointer(document.body, 'pointerup', endX, endY, 0))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0]!.at(-1)).toBeCloseTo(released)
    expect(changed.mock.calls[0]!.slice(0, -1)).toEqual(consumer === 'region' ? [workspaceId, tabId, ''] : [workspaceId, ''])
  }
})
