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
import { runScreenshotShortcut } from '../src/renderer/src/lib/screenshot-shortcut-target'
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

function connect(captureScreenshot: ReturnType<typeof vi.fn>, focusState: 'confirmed' | 'unknown' = 'confirmed') {
  const handlers = new Map<string, (...args: any[]) => any>()
  registerNativeDesktopIpc({ home, native: () => ({ captureScreenshot, readClipboardText: vi.fn(), writeClipboardText: vi.fn(), writeClipboardImage: vi.fn() }),
    handle: (channel, handler) => { handlers.set(channel, handler) }, trust: () => {} })
  const saved = vi.spyOn(api.ui, 'captureScreenshot').mockImplementation(() => handlers.get('ui:captureScreenshot')!({}))
  vi.spyOn(api.ui, 'readPastedImage').mockImplementation(path => readPastedImage(home, path))
  const focus = vi.spyOn(api.ui.workbenchWindows, 'call').mockImplementation(async (method, params) => ({
    windows: [], recordedOperation: { ...params, method, state: focusState, message: focusState === 'unknown' ? 'Original focus unconfirmed' : null }
  }) as never)
  return { saved, focus }
}

async function renderComposer(launcher: boolean, sessionId = 'agent-1', visible = true) {
  await dom.render(<WorkbenchDocumentContext.Provider value={{ document, window: originalDocument }}>
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
  await act(async () => { pending = runScreenshotShortcut(); void pending.catch(() => {}) })
  return { pending }
}
async function settlePreview() {
  await act(async () => { await Promise.all(vi.mocked(api.ui.readPastedImage).mock.results.map(result => result.value)) })
}

it.each([false, true])('the real %s Composer focus claims the shortcut, saves original PNG, maps its bookmark and preserves Undo', async launcher => {
  let finish!: (value: typeof captured) => void
  const native = vi.fn(() => new Promise<typeof captured>(resolve => { finish = resolve }))
  const { saved, focus } = connect(native)
  const { node, editor, id } = await mount(launcher)
  const { pending } = await begin()
  expect(native).toHaveBeenCalledExactlyOnceWith({ mode: 'selection' })
  expect(focus).not.toHaveBeenCalled()
  await act(async () => { editor.commands.insertContentAt(1, 'new '); editor.commands.setTextSelection(editor.state.doc.content.size - 1) })
  const external = document.createElement('button'); external.textContent = 'Private external focus fixture'
  externalControls.push(external); document.body.append(external)
  await act(async () => external.focus())
  expect(document.activeElement).toBe(external)
  await act(async () => { finish(captured); await expect(pending).resolves.toBeUndefined() })
  await settlePreview()
  const path = await saved.mock.results[0]!.value
  expect(path).toBeTruthy()
  expect(await readFile(path!)).toEqual(bytes)
  const draft = dom.draft(id)!
  expect(draft).toContain('new alpha')
  expect(draft).toContain(path)
  expect(draft.indexOf(path!)).toBeLessThan(draft.indexOf('omega'))
  expect(focus).toHaveBeenCalledExactlyOnceWith('app.window.focus', expect.objectContaining(originalDocument))
  expect(document.activeElement).toBe(node)
  await act(async () => editor.commands.undo())
  expect(dom.draft(id)).toBe('new alpha omega')
  expect(useAppStore.getState().sessions[0]?.control).toEqual(composerSession().control)
  expect(useAppStore.getState().error).toBeNull()
})

it.each([false, true])('a cancelled native selection does not focus Desktop or change the original %s draft', async launcher => {
  const native = vi.fn(async () => ({ state: 'cancelled' as const }))
  const { focus } = connect(native)
  const { id } = await mount(launcher)
  await act(async () => { await runScreenshotShortcut() })
  expect(native).toHaveBeenCalledExactlyOnceWith({ mode: 'selection' })
  expect(dom.draft(id)).toBe('alpha omega')
  expect(focus).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions[0]?.control).toEqual(composerSession().control)
})

it('explicit focus in a remote Composer supersedes the earlier eligible local draft without capturing or inserting there', async () => {
  const native = vi.fn(async () => ({ state: 'cancelled' as const }))
  const { saved, focus } = connect(native)
  const remote = { ...composerSession('remote-draft'), hostId: 'remote',
    control: { ...composerSession('remote-draft').control, hostId: 'remote' } }
  useAppStore.setState({ sessions: [composerSession(), remote],
    agentComposerDrafts: { 'agent-1': 'Local original draft', 'remote-draft': 'Remote original draft' } })
  await dom.render(<WorkbenchDocumentContext.Provider value={{ document, window: originalDocument }}>
    <section data-draft="local"><AgentSessionComposer sessionId="agent-1" visible /></section>
    <section data-draft="remote"><AgentSessionComposer sessionId="remote-draft" visible /></section>
  </WorkbenchDocumentContext.Provider>)
  const localNode = dom.container.querySelector<HTMLElement>('[data-draft="local"] .tiptap')!
  const remoteNode = dom.container.querySelector<HTMLElement>('[data-draft="remote"] .tiptap')!
  expect(localNode).toBeTruthy(); expect(remoteNode).toBeTruthy()
  await act(async () => {
    localNode.focus()
    localNode.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: document.body }))
    // Establish that A was an actual usable target before the later B focus.
    await runScreenshotShortcut()
  })
  expect(native).toHaveBeenCalledExactlyOnceWith({ mode: 'selection' })
  native.mockClear(); saved.mockClear()
  await act(async () => {
    remoteNode.focus()
    remoteNode.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: localNode }))
  })
  expect(document.activeElement).toBe(remoteNode)
  await act(async () => { await expect(runScreenshotShortcut()).rejects.toThrow(/Message Tool|draft|Composer/i) })
  expect(native).not.toHaveBeenCalled()
  expect(saved).not.toHaveBeenCalled()
  expect(focus).not.toHaveBeenCalled()
  expect(dom.draft('agent-1')).toBe('Local original draft')
  expect(dom.draft('remote-draft')).toBe('Remote original draft')
  expect(useAppStore.getState().sessions.map(session => session.control)).toEqual([composerSession().control, remote.control])
})

it('a late selection cannot attach or focus after the Launcher execution scope changes', async () => {
  let finish!: (value: typeof captured) => void
  const { saved, focus } = connect(vi.fn(() => new Promise<typeof captured>(resolve => { finish = resolve })))
  const { node } = await mount(true)
  const { pending } = await begin()
  await act(async () => {
    useLauncherState.setState(state => ({ sections: { ...state.sections, other: { agents: 'expanded', terminal: 'hidden', browser: 'hidden', note: 'hidden' } } }))
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
      { ...state.config!.workspaces[0]!, id: 'other', name: 'Other Workspace', path: join(home, 'other-workspace') }] },
      tabs: { ...state.tabs, launcher: { ...state.tabs.launcher!, regions: { ...state.tabs.launcher!.regions,
        region: { ...state.tabs.launcher!.regions.region!, workspaceId: 'other' } } } } }))
  })
  expect(dom.container.querySelector('.tiptap')).toBe(node)
  let outcome: unknown
  await act(async () => { finish(captured); try { await pending } catch (error) { outcome = error } })
  const path = await saved.mock.results[0]!.value
  expect(await readFile(path!)).toEqual(bytes)
  expect(dom.draft('region')).toBe('alpha omega')
  expect(focus).not.toHaveBeenCalled()
  expect(outcome).toBeInstanceOf(Error)
  expect(String(outcome)).toContain(path!)
})

it('a late selection cannot attach to a replacement Session editor or steal its focus', async () => {
  let finish!: (value: typeof captured) => void
  const { saved, focus } = connect(vi.fn(() => new Promise<typeof captured>(resolve => { finish = resolve })))
  const { node } = await mount(false)
  const { pending } = await begin()
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, composerSession('agent-2')],
    agentComposerDrafts: { ...state.agentComposerDrafts, 'agent-2': 'Second original draft' } })))
  const replacement = await renderComposer(false, 'agent-2')
  expect(replacement).not.toBe(node)
  let outcome: unknown
  await act(async () => { finish(captured); try { await pending } catch (error) { outcome = error } })
  const path = await saved.mock.results[0]!.value
  expect(await readFile(path!)).toEqual(bytes)
  expect(dom.draft('agent-1')).toBe('alpha omega')
  expect(dom.draft('agent-2')).toBe('Second original draft')
  expect(focus).not.toHaveBeenCalled()
  expect(outcome).toBeInstanceOf(Error)
  expect(String(outcome)).toContain(path!)
})

it('a now-hidden original draft keeps its attachment but never claims a return to the later workface', async () => {
  let finish!: (value: typeof captured) => void
  const { saved, focus } = connect(vi.fn(() => new Promise<typeof captured>(resolve => { finish = resolve })))
  const { node, id } = await mount(false)
  const { pending } = await begin()
  const hidden = await renderComposer(false, 'agent-1', false)
  expect(hidden).toBe(node)
  let outcome: unknown
  await act(async () => { finish(captured); try { await pending } catch (error) { outcome = error } })
  await settlePreview()
  const path = await saved.mock.results[0]!.value
  expect(await readFile(path!)).toEqual(bytes)
  expect(dom.draft(id)).toContain(path!)
  expect(focus).not.toHaveBeenCalled()
  expect(outcome).toBeInstanceOf(Error)
  expect(String(outcome)).toContain(path!)
  expect(String(outcome)).toMatch(/return|workface|visible|surface/i)
})

it('a failed native capture preserves the original draft and does not perform a focus action or retry', async () => {
  const native = vi.fn(async () => ({ state: 'failed' as const, error: { code: 'permission_denied', message: 'Original permission refused' } }))
  const { focus } = connect(native)
  const { id } = await mount(false)
  await act(async () => { await expect(runScreenshotShortcut()).rejects.toThrow('Original permission refused') })
  expect(dom.draft(id)).toBe('alpha omega')
  expect(native).toHaveBeenCalledOnce()
  expect(focus).not.toHaveBeenCalled()
})

it('an unconfirmed exact document focus does not claim that the saved attachment returned to the draft', async () => {
  const native = vi.fn(async () => captured)
  const { saved, focus } = connect(native, 'unknown')
  const { id } = await mount(false)
  let outcome: unknown
  await act(async () => { try { await runScreenshotShortcut() } catch (error) { outcome = error } })
  await settlePreview()
  const path = await saved.mock.results[0]!.value
  expect(dom.draft(id)).toContain(path!)
  expect(focus).toHaveBeenCalledExactlyOnceWith('app.window.focus', expect.objectContaining(originalDocument))
  expect(outcome).toBeInstanceOf(Error)
  expect(String(outcome)).toMatch(/focus|return|window/i)
  expect(native).toHaveBeenCalledOnce()
})
