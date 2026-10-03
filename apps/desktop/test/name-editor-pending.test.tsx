// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector, type FocusContext } from '../src/renderer/src/lib/focus-context'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { FocusToolbar } from '../src/renderer/src/components/FocusToolbar'
import { SurveyZoneItem } from '../src/renderer/src/components/SurveyZoneItem'

// Real editors and menus are mounted. Only the external asynchronous name
// owner is deferred; Core persistence and ACK semantics have their own suite.
const baseline = useAppStore.getState()
const tabId = 'pending-name-tab'
let root: Root, container: HTMLDivElement, context: FocusContext
function deferred() {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>(done => { resolve = done })
  return { promise, resolve }
}
const settle = () => act(async () => { await new Promise(done => setTimeout(done, 15)) })
const key = (node: Element, value: string) => act(async () => {
  node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value }))
})
async function value(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const config = await api.config.get(), snapshot = await api.sessions.snapshot()
  const original = snapshot.sessions.find(session => session.kind === 'agent')!
  const workspace = { ...config.workspaces[0]!, path: resolve(config.workspaces[0]!.path), hostId: 'local' }
  const session = { ...original, workspacePath: workspace.path, hostId: 'local' }
  const tab = createWorkbenchTab(tabId, { regionId: 'pending-name-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id }, 'Original Tab')
  useAppStore.setState({ ...baseline, config: { ...config, workspaces: [workspace] }, sessions: [session], timelines: {},
    tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('pending-name-group', [tab.id]) },
    scratchTopicSnapshots: {}, agentNames: { [session.id]: 'Original Agent' }, nameLabels: {} }, true)
  context = createFocusProjectionSelector()(useAppStore.getState()).contexts.find(item => item.id === session.id)!
  expect(context).toBeTruthy()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it.each(['Agent row', 'Focus Tab', 'Survey Zone'] as const)('%s keeps later input and a reopened edit when an earlier name ACK arrives', async kind => {
  const requests = [deferred(), deferred(), deferred()]
  let index = 0
  const rename = vi.fn(() => requests[index++]!.promise)
  useAppStore.setState({ renameAgent: rename, renameTab: rename })
  function SurveyFixture() {
    const [editing, setEditing] = useState(true)
    return <SurveyZoneItem zone={{ zoneId: 'pending-name-zone', workspaceId: context.workspaceId, kind: 'directory', hostId: 'local', directoryPath: context.workspacePath, branch: null }}
      title="Original exploration" glyph={null} selected activity={null} editing={editing} onEdit={setEditing} onRename={rename} onSelect={() => {}} />
  }
  await act(async () => root.render(kind === 'Agent row'
    ? createElement(FocusContextRow, { context, selected: true, onSelect() {} })
    : kind === 'Focus Tab' ? createElement(FocusToolbar, { children: null, selectedId: context.id, selected: context, tab: useAppStore.getState().tabs[tabId]!, onReview() {}, onCloseWorkspace() {} })
    : createElement(SurveyFixture)))
  const selector = kind === 'Agent row' ? '.focus-context__rename' : kind === 'Focus Tab' ? '.focus-toolbar__rename' : '.survey-item-name input'
  const input = () => container.querySelector<HTMLInputElement>(selector)
  async function open() {
    if (kind === 'Survey Zone') {
      await act(async () => container.querySelector<HTMLButtonElement>('.survey-item')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    } else {
      const trigger = container.querySelector<HTMLButtonElement>(kind === 'Agent row' ? 'button.focus-context' : '.focus-toolbar__identity')!
      expect(trigger).toBeTruthy()
      await act(async () => trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 20 })))
      await settle()
      const label = kind === 'Agent row' ? 'Rename Agent' : 'Rename Tab'
      const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === label)
      expect(action, label).toBeTruthy(); await act(async () => action!.click()); await settle()
    }
    expect(input()).toBeTruthy()
  }
  async function submit() {
    if (kind === 'Survey Zone') await act(async () => input()!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    else await key(input()!, 'Enter')
  }
  if (kind !== 'Survey Zone') await open()
  await value(input()!, 'Submitted first'); await submit(); expect(rename).toHaveBeenCalledTimes(1)
  await value(input()!, 'Newer unsaved draft')
  await act(async () => requests[0]!.resolve(true))
  expect(input()?.value, 'a prior successful name ACK must keep later input').toBe('Newer unsaved draft')

  await value(input()!, 'Submitted second'); await submit(); expect(rename).toHaveBeenCalledTimes(2)
  await key(input()!, 'Escape'); expect(input()).toBeNull()
  await open(); await value(input()!, 'Reopened unsaved draft')
  await act(async () => requests[1]!.resolve(true))
  expect(input()?.value, 'a cancelled request must not close the reopened edit').toBe('Reopened unsaved draft')

  await submit(); expect(rename).toHaveBeenCalledTimes(3)
  await act(async () => requests[2]!.resolve(true))
  expect(input(), 'the current successful name request still ends editing').toBeNull()
})
