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
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { registerNativeDesktopIpc } from '../src/main/native-desktop-ipc'
import { ScreenCapture } from '../src/main/screen-capture'
import { readPastedImage } from '../src/main/pasted-image-read'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
const result = { state: 'captured' as const, screenshot: { format: 'png' as const, data: bytes.toString('base64'), width: 1, height: 1, scale: 2 } }
const dom = composerDOM()
let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'amux-native-draft-'))
  useLauncherState.setState({ sections: { workspace: { agents: 'expanded', terminal: 'hidden', browser: 'hidden', note: 'hidden' } }, drafts: {}, executors: {} })
})
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
function connect(captureScreenshot: ReturnType<typeof vi.fn>) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const native = { captureScreenshot, readClipboardText: vi.fn(), writeClipboardText: vi.fn(), writeClipboardImage: vi.fn() }
  const capture = new ScreenCapture({ home, native: () => native, edit: vi.fn(), reportIssue: vi.fn() })
  registerNativeDesktopIpc({ capture: () => capture.capture(true), native: () => native,
    handle: (channel, handler) => { handlers.set(channel, handler) }, trust: () => {} })
  vi.spyOn(api.ui, 'captureScreenshot').mockImplementation(() => handlers.get('ui:captureScreenshot')!({}))
  vi.spyOn(api.ui, 'readPastedImage').mockImplementation(path => readPastedImage(home, path))
}
async function mount(launcher: boolean) {
  if (launcher) {
    useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
      activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'alpha omega' } })
    await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible />)
  } else {
    useAppStore.setState({ agentComposerDrafts: { 'agent-1': 'alpha omega' } })
    await dom.render(<AgentSessionComposer sessionId="agent-1" />)
    await dom.click('.composer-tool--mode')
  }
  const node = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')
  expect(node).not.toBeNull()
  return { editor: node!.editor, id: launcher ? 'region' : 'agent-1' }
}

it.each([false, true])('native selection flows through the real %s Composer button, mapped draft insertion, preview and Undo', async launcher => {
  let done!: (value: typeof result) => void
  const captureScreenshot = vi.fn(() => new Promise<typeof result>(resolve => { done = resolve }))
  connect(captureScreenshot)
  const { editor, id } = await mount(launcher)
  await act(async () => editor.commands.setTextSelection(7))
  await dom.click('[aria-label="Capture a screen region"]')
  expect(captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'selection', allowEditing: true })
  await act(async () => { editor.commands.insertContentAt(1, 'new '); editor.commands.setTextSelection(editor.state.doc.content.size - 1) })
  let path: string | null = null
  await act(async () => { done(result); path = await vi.mocked(api.ui.captureScreenshot).mock.results[0]!.value })
  await act(async () => { await Promise.all(vi.mocked(api.ui.readPastedImage).mock.results.map(item => item.value)) })
  const draft = dom.draft(id)!
  expect(draft).toContain('new alpha')
  expect(draft).toContain('omega')
  expect(path).not.toBeNull()
  expect(draft).toContain(path)
  expect(await readFile(path!)).toEqual(bytes)
  await vi.waitFor(() => expect(api.ui.readPastedImage).toHaveBeenCalledWith(path))
  expect(await readPastedImage(home, path!)).toEqual({ dataUrl: 'data:image/png;base64,' + bytes.toString('base64') })
  await act(async () => editor.commands.undo())
  expect(dom.draft(id)).toBe('new alpha omega')
  expect(useAppStore.getState().sessions[0]?.control).toEqual(composerSession().control)
  expect(useAppStore.getState().error).toBeNull()
})

it.each([false, true])('a typed native cancel leaves the original %s Composer body and healthy Session unchanged', async launcher => {
  const captureScreenshot = vi.fn(async () => ({ state: 'cancelled' as const }))
  connect(captureScreenshot)
  const { id } = await mount(launcher)
  await dom.click('[aria-label="Capture a screen region"]')
  expect(captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'selection', allowEditing: true })
  expect(dom.draft(id)).toBe('alpha omega')
  expect(useAppStore.getState().error).toBeNull()
})

it('keeps a late native selection out of the same live Launcher editor after its exact execution Workspace changes', async () => {
  let done!: (value: typeof result) => void
  connect(vi.fn(() => new Promise<typeof result>(resolve => { done = resolve })))
  await mount(true)
  const originalEditor = dom.container.querySelector('.tiptap')
  await dom.click('[aria-label="Capture a screen region"]')
  await act(async () => {
    useLauncherState.setState(state => ({ sections: { ...state.sections, other: { agents: 'expanded', terminal: 'hidden', browser: 'hidden', note: 'hidden' } } }))
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [...state.config!.workspaces,
      { ...state.config!.workspaces[0]!, id: 'other', name: 'Other Workspace', path: join(home, 'other-workspace') }] },
      tabs: { ...state.tabs, launcher: { ...state.tabs.launcher!, regions: { ...state.tabs.launcher!.regions,
        region: { ...state.tabs.launcher!.regions.region!, workspaceId: 'other' } } } } }))
  })
  expect(dom.container.querySelector('.tiptap')).toBe(originalEditor)
  await act(async () => { done(result); await vi.mocked(api.ui.captureScreenshot).mock.results[0]!.value })
  expect(dom.draft('region')).toBe('alpha omega')
  expect(useAppStore.getState().error).toBeNull()
})
