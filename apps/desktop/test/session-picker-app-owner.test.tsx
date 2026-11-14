// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createWorkspaceLayout } from '@agentmux/layout'
import { parseAgentMuxControlRequest } from '@agentmux/core'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { installNativePopover } from './fixtures/mote-workface'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// App, QuickSwitcher, Store and public presentation run; unused PTY paint does not.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => <textarea aria-label="Retained workface draft" defaultValue="Keep my original input" /> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { App } from '../src/renderer/src/App'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'
import * as windows from '../src/renderer/src/lib/workbench-windows'
import { readDesktopOverlays } from '../src/renderer/src/lib/desktop-presentation'

const dom = composerDOM(), initial = useAppStore.getState()
let restorePopover: () => void
beforeEach(() => {
  localStorage.clear()
  restorePopover = installNativePopover()
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 500))
  const first = createWorkbenchTab('first', { regionId: 'first-region', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: 'original' })
  const second = createWorkbenchTab('second', { regionId: 'second-region', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: 'original' })
  useAppStore.setState({ ...initial, loading: false, initialize: async () => () => {}, config: composerConfig,
    sessions: [composerSession('original')], tabs: { first, second }, layouts: { workspace: createWorkspaceLayout('group', ['first', 'second']) },
    activeWorkspaceId: 'workspace', mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
    agentComposerDrafts: { original: 'Original unsent draft' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
})
afterEach(() => restorePopover())
async function key(target: EventTarget, value: string, metaKey = false) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, code: value === 'p' ? 'KeyP' : value, metaKey, bubbles: true, cancelable: true })))
}
const query = () => document.querySelector<HTMLInputElement>('.quick-switch [role="combobox"]')!
async function inspect() {
  const result = await useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: crypto.randomUUID(), operation: 'inspect.client' }))
  if (result.operation !== 'inspect.client') throw Error('Expected original client observation')
  return result
}

it('actual App reports the visible location request through public inspection and its shortcut closes only that request', async () => {
  await dom.render(<App />)
  const before = useAppStore.getState()
  await act(async () => expect(useAppStore.getState().selectSession('original')).toBe(false))
  expect(query()).not.toBeNull()
  expect(readDesktopOverlays()).toMatchObject({ quickSwitcher: true })
  const read = await inspect()
  expect(read.observation.desktop.overlays.quickSwitcher).toBe(true)
  expect(read.observation.desktop.presentation).toMatchObject({ state: 'covered', blockers: ['quick-switcher'] })
  expect(useAppStore.getState().selectMainRegion({ displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'second', regionId: 'second-region' })).toBe(false)
  await key(query(), 'p', true)
  expect(useAppStore.getState().sessionLocationRequest).toBeNull()
  expect(document.querySelector('.quick-switch')).toBeNull()
  expect(readDesktopOverlays().quickSwitcher).toBe(false)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

async function childShortcut() {
  const child = document.implementation.createHTMLDocument('Original child')
  const input = child.createElement('textarea'); child.body.append(input); input.focus()
  const scope = { windowId: 'original-child', documentGeneration: 'original-generation' }
  const unregister = registerWorkbenchDocument(child, scope)
  const unregisterMain = registerWorkbenchDocument(document, { windowId: 'original-main', documentGeneration: 'main-generation' })
  let confirm!: (value: boolean) => void
  const focus = vi.spyOn(windows, 'focusWorkbenchWindow').mockResolvedValue(true).mockResolvedValueOnce(true)
    .mockImplementationOnce(() => new Promise(resolve => { confirm = resolve }))
  const sourceFocus = vi.spyOn(input, 'focus')
  await key(input, 'p', true)
  expect(query()).not.toBeNull()
  await key(query(), 'Escape')
  await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(2))
  sourceFocus.mockClear()
  return { input, child, scope, sourceFocus, confirm: (value: boolean) => confirm(value), dispose: () => { unregister(); unregisterMain() } }
}

it.each(['unchanged', 'new-location', 'later-input', 'new-document', 'new-window'] as const)('a delayed cross-document cancel receipt respects %s work', async change => {
  await dom.render(<App />)
  const original = await childShortcut()
  let unregisterNew: (() => void) | undefined
  try {
    if (change === 'new-location') await act(async () => expect(useAppStore.getState().selectSession('original')).toBe(false))
    if (change === 'later-input') await act(async () => document.body.dispatchEvent(new Event('beforeinput', { bubbles: true })))
    if (change === 'new-window') unregisterNew = registerWorkbenchDocument(original.child, { ...original.scope, windowId: 'new-window' })
    if (change === 'new-document') unregisterNew = registerWorkbenchDocument(original.child, { ...original.scope, documentGeneration: 'new-generation' })
    await act(async () => original.confirm(true))
    expect(original.sourceFocus).toHaveBeenCalledTimes(change === 'unchanged' ? 1 : 0)
    if (change === 'new-location') expect(document.activeElement).toBe(query())
    expect(useAppStore.getState().agentComposerDrafts.original).toBe('Original unsent draft')
  } finally { unregisterNew?.(); original.dispose() }
})

it.each(['main', 'source', 'later-input'] as const)('a delayed cross-document open receipt cannot override %s replacement', async change => {
  await dom.render(<App />)
  const child = document.implementation.createHTMLDocument('Original shortcut source')
  const input = child.createElement('textarea'); input.value = 'Keep original source input'; child.body.append(input); input.focus()
  const unregisterMain = registerWorkbenchDocument(document, { windowId: 'original-main', documentGeneration: 'main-generation' })
  const unregisterSource = registerWorkbenchDocument(child, { windowId: 'original-source', documentGeneration: 'source-generation' })
  let unregisterNew: (() => void) | undefined
  let confirm!: (value: boolean) => void
  vi.spyOn(windows, 'focusWorkbenchWindow').mockImplementation(() => new Promise(resolve => { confirm = resolve }))
  try {
    await key(input, 'p', true)
    expect(query()).toBeNull()
    if (change === 'main') unregisterNew = registerWorkbenchDocument(document, { windowId: 'original-main', documentGeneration: 'new-main-generation' })
    if (change === 'source') unregisterNew = registerWorkbenchDocument(child, { windowId: 'new-source-window', documentGeneration: 'source-generation' })
    if (change === 'later-input') await act(async () => input.dispatchEvent(new Event('beforeinput', { bubbles: true })))
    await act(async () => confirm(true))
    expect(query()).toBeNull()
    expect(readDesktopOverlays().quickSwitcher).toBe(false)
    expect(input.value).toBe('Keep original source input')
  } finally { unregisterNew?.(); unregisterSource(); unregisterMain() }
})
