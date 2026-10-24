// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { installScreenshotAttachmentReceiver } from '../src/renderer/src/lib/screenshot-attachment'
import { GlobalScreenshot } from '../src/main/global-screenshot'
import { ScreenCapture } from '../src/main/screen-capture'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { registerNativeDesktopIpc } from '../src/main/native-desktop-ipc'
import { readPastedImage } from '../src/main/pasted-image-read'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
const captured = { state: 'captured' as const, screenshot: { format: 'png' as const, data: bytes.toString('base64'), width: 1, height: 1, scale: 2 } }
const originalDocument = { windowId: 'original-window', documentGeneration: 'original-generation' }
const dom = composerDOM()
let home: string
const externalControls: HTMLElement[] = []
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'amux-shortcut-draft-'))
  useLauncherState.setState({ sections: { workspace: { agents: 'expanded', terminal: 'hidden', browser: 'hidden', note: 'hidden' } }, drafts: {}, executors: {} })
})
afterEach(async () => { for (const control of externalControls.splice(0)) control.remove(); await rm(home, { recursive: true, force: true }) })

let globalCapture: GlobalScreenshot
let focused = true
let disposeReceiver: (() => void) | undefined
function connect(captureScreenshot: ReturnType<typeof vi.fn>) {
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  const handlers = new Map<string, (...args: any[]) => any>()
  const clipboard = vi.fn(async () => {}), reportIssue = vi.fn()
  const native = { captureScreenshot, readClipboardText: vi.fn(), writeClipboardText: vi.fn(), writeClipboardImage: clipboard }
  const capture = new ScreenCapture({ home, native: () => native, edit: vi.fn(), reportIssue })
  registerNativeDesktopIpc({ capture: () => capture.capture(true), native: () => native,
    handle: (channel, handler) => { handlers.set(channel, handler) }, trust: () => {} })
  const saved = vi.spyOn(api.ui, 'captureScreenshot').mockImplementation(() => handlers.get('ui:captureScreenshot')!({}))
  vi.spyOn(api.ui, 'readPastedImage').mockImplementation(path => readPastedImage(home, path))
  const frame = { executeJavaScript: vi.fn(async (code: string) => new Function('window', 'return ' + code)(window)) }
  const nativeWindow = { isDestroyed: () => false, isFocused: () => focused, isMinimized: () => !focused }
  globalCapture = new GlobalScreenshot({ contents: { isDestroyed: () => false, mainFrame: frame } as never,
    focusedWindow: () => focused ? nativeWindow as never : null, windowForDocument: () => nativeWindow as never,
    capture: attach => capture.capture(attach), reportIssue })
  disposeReceiver?.(); disposeReceiver = installScreenshotAttachmentReceiver(window)
  return { saved, clipboard, reportIssue, frame }
}
afterEach(() => { disposeReceiver?.(); disposeReceiver = undefined })

async function renderComposer(launcher: boolean, sessionId = 'agent-1', visible = true, generation = originalDocument.documentGeneration) {
  await dom.render(<WorkbenchDocumentContext.Provider value={{ document, window: { ...originalDocument, documentGeneration: generation } }}>
    {launcher ? <NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={visible} /> : <AgentSessionComposer sessionId={sessionId} visible={visible} />}
  </WorkbenchDocumentContext.Provider>)
  const node = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')
  expect(node).not.toBeNull()
  return node!
}
async function mount(launcher: boolean) {
  if (launcher) useAppStore.setState({
    tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'alpha omega' }
  })
  else useAppStore.setState({ agentComposerDrafts: { 'agent-1': 'alpha omega' } })
  const node = await renderComposer(launcher)
  await act(async () => {
    node.editor.commands.setTextSelection(7)
    node.focus()
    // Dispatch the actual bubbling focus event consumed by the production React wrapper.
    node.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: document.body }))
  })
  return { node, editor: node.editor, id: launcher ? 'region' : 'agent-1' }
}
async function begin() {
  let pending!: Promise<void>
  await act(async () => { pending = globalCapture.run(); void pending.catch(() => {}) })
  return { pending }
}
async function settlePreview() {
  await act(async () => { await Promise.all(vi.mocked(api.ui.readPastedImage).mock.results.map(result => result.value)) })
}

it.each([false, true])('the real %s focused message input pins its bookmark and receives the same clipboard PNG with Undo', async launcher => {
  let finish!: (value: typeof captured) => void
  const native = vi.fn(() => new Promise<typeof captured>(resolve => { finish = resolve }))
  const { clipboard, reportIssue } = connect(native)
  const { editor, id } = await mount(launcher)
  const { pending } = await begin()
  expect(native).toHaveBeenCalledExactlyOnceWith({ mode: 'selection', allowEditing: true })
  await act(async () => { editor.commands.insertContentAt(1, 'new '); editor.commands.setTextSelection(editor.state.doc.content.size - 1) })
  const outside = document.createElement('button'); document.body.append(outside); externalControls.push(outside)
  await act(async () => outside.focus())
  await act(async () => { finish(captured); await pending })
  await settlePreview()
  const draft = dom.draft(id)!, path = draft.match(/@([^ ]+\.png)/)?.[1]
  expect(path).toBeTruthy()
  expect(await readFile(path!)).toEqual(bytes)
  expect(draft).toContain('new alpha')
  expect(draft.indexOf(path!)).toBeLessThan(draft.indexOf('omega'))
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }))
  expect(document.activeElement).toBe(outside)
  expect(reportIssue).not.toHaveBeenCalled()
  await act(async () => editor.commands.undo())
  expect(dom.draft(id)).toBe('new alpha omega')
  expect(useAppStore.getState().sessions[0]?.control).toEqual(composerSession().control)
})

it.each([false, true])('without current input focus the real %s Composer is not an implicit destination', async launcher => {
  const native = vi.fn(async () => captured), { clipboard } = connect(native)
  const { id } = await mount(launcher)
  const outside = document.createElement('button'); document.body.append(outside); externalControls.push(outside)
  await act(async () => outside.focus())
  await act(async () => { await globalCapture.run() })
  expect(clipboard).toHaveBeenCalledOnce()
  expect(dom.draft(id)).toBe('alpha omega')
  await expect(readFile(join(home, '.agentmux', 'pasted'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([false, true])('minimized or external-app focus copies without attaching to the previously focused %s input', async launcher => {
  const native = vi.fn(async () => captured), { clipboard, frame } = connect(native)
  const { id } = await mount(launcher)
  focused = false
  await act(async () => { await globalCapture.run() })
  expect(clipboard).toHaveBeenCalledOnce()
  expect(frame.executeJavaScript).not.toHaveBeenCalled()
  expect(dom.draft(id)).toBe('alpha omega')
})

it.each([false, true])('a cancelled capture makes no attachment or clipboard write in the real %s Composer', async launcher => {
  const native = vi.fn(async () => ({ state: 'cancelled' as const })), { clipboard } = connect(native)
  const { id } = await mount(launcher)
  await act(async () => { await globalCapture.run() })
  expect(dom.draft(id)).toBe('alpha omega')
  expect(clipboard).not.toHaveBeenCalled()
})

it('Survey with no mounted Composer still captures and copies through Main', async () => {
  const native = vi.fn(async () => captured), { clipboard } = connect(native)
  await dom.render(<div>Survey workface</div>)
  await act(async () => { await globalCapture.run() })
  expect(native).toHaveBeenCalledOnce()
  expect(clipboard).toHaveBeenCalledOnce()
})

it('a late screenshot never changes the new input after the original scope is replaced', async () => {
  let finish!: (value: typeof captured) => void
  const native = vi.fn(() => new Promise<typeof captured>(resolve => { finish = resolve })), { clipboard, reportIssue } = connect(native)
  await mount(false)
  const { pending } = await begin()
  useAppStore.setState({ agentComposerDrafts: { 'agent-1': 'alpha omega', 'agent-2': 'New draft' } })
  await renderComposer(false, 'agent-2')
  await act(async () => { finish(captured); await pending })
  expect(clipboard).toHaveBeenCalledOnce()
  expect(dom.draft('agent-2')).toBe('New draft')
  expect(reportIssue).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('saved at') }))
})

it('native unknown preserves the exact failure and clears only this optional attachment without replay', async () => {
  const error = new Error('Original native operation outcome unknown')
  const native = vi.fn(async () => { throw error }), { clipboard } = connect(native)
  const { id } = await mount(false)
  await act(async () => { await expect(globalCapture.run()).rejects.toBe(error) })
  expect(native).toHaveBeenCalledOnce()
  expect(clipboard).not.toHaveBeenCalled()
  expect(dom.draft(id)).toBe('alpha omega')
})

it('same editor in a new document generation never receives the old screenshot', async () => {
  let finish!: (value: typeof captured) => void
  const native = vi.fn(() => new Promise<typeof captured>(resolve => { finish = resolve })), { clipboard, reportIssue } = connect(native)
  const { editor, id } = await mount(false)
  const { pending } = await begin()
  const updated = await renderComposer(false, 'agent-1', true, 'replacement-generation')
  expect(updated.editor).toBe(editor)
  await act(async () => { finish(captured); await pending })
  expect(clipboard).toHaveBeenCalledOnce()
  expect(dom.draft(id)).toBe('alpha omega')
  expect(reportIssue).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('saved at') }))
})

it('the explicit Capture button also preserves its original document generation', async () => {
  let finish!: (value: typeof captured) => void
  const native = vi.fn(() => new Promise<typeof captured>(resolve => { finish = resolve })), { clipboard, saved } = connect(native)
  const { editor, id } = await mount(false)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Capture a screen region"]')
  expect(native).toHaveBeenCalledOnce()
  const updated = await renderComposer(false, 'agent-1', true, 'replacement-generation')
  expect(updated.editor).toBe(editor)
  await act(async () => { finish(captured); await saved.mock.results[0]!.value })
  expect(clipboard).toHaveBeenCalledOnce()
  expect(dom.draft(id)).toBe('alpha omega')
  expect(await readFile((await saved.mock.results[0]!.value)!)).toEqual(bytes)
})
