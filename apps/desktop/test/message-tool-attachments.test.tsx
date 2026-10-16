// @vitest-environment happy-dom
import { fixturePath as _tailFixturePath } from "../../../test/fixture-values.mjs"
import { act, createRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { expandSemanticReferences } from '@agentmux/client-ui/composer-semantic-reference'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { ComposerFeedback, useComposerFeedback } from '../src/renderer/src/components/ComposerFeedback'
import { useComposerAttachments } from '../src/renderer/src/lib/use-composer-attachments'
import { useComposerInputHistory } from '../src/renderer/src/lib/use-composer-input-history'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const bridge = vi.hoisted(() => ({ api: null as import('../src/shared/contracts').AgentMuxPreloadApi | null,
  filePath: vi.fn(), invoke: vi.fn(async () => undefined) }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: import('../src/shared/contracts').AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 }, webUtils: { getPathForFile: bridge.filePath } }))
import '../src/preload/index'
const dom = composerDOM()
const rootPath = composerConfig.workspaces[0]!.path
const imagePath = _tailFixturePath("original/.agentmux/pasted/drop.png")
const element = () => dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!
const editor = () => element().editor
const text = (id = 'agent-1') => expandSemanticReferences(dom.draft(id) ?? '')
const file = (name: string, type = '') => new File([new Uint8Array([1, 2, 3])], name, { type })
function transfer(files: File[] = [], plain = '') {
  return { files, types: files.length ? ['Files'] : ['text/plain'], getData: (kind: string) => kind === 'text/plain' ? plain : '', items: [] }
}
async function drop(files: File[], position = 7, plain = '', target: Element = element()) {
  vi.spyOn(editor().view, 'posAtCoords').mockReturnValue({ pos: position, inside: 0 })
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 30, clientY: 20 })
  Object.defineProperty(event, 'dataTransfer', { value: transfer(files, plain) })
  await act(async () => target.dispatchEvent(event))
  await act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve() })
  return event
}
async function mount(launcher = false) {
  useAppStore.setState({ agentComposerDrafts: { 'agent-1': 'alpha omega', region: 'alpha omega' } })
  if (launcher) {
    useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) }, activeWorkspaceId: 'workspace',
      prewarmTerminal: vi.fn(async () => {}), detectExecutors: vi.fn(async () => {}) })
    await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" />)
  } else await dom.render(<AgentSessionComposer sessionId="agent-1" />)
}
beforeEach(() => {
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(null)
  vi.spyOn(api.ui, 'savePastedImage').mockResolvedValue(imagePath)
  vi.spyOn(api.ui, 'pathForFile').mockImplementation(value => `${rootPath}/${value.name}`)
})

it('the real history hook isolates fill from preceding and following typing Undo', async () => {
  const insertion = createRef<ComposerInsertionHandle>()
  let history!: ReturnType<typeof useComposerInputHistory>
  function Surface() {
    const value = useAppStore(state => state.agentComposerDrafts['agent-1'] ?? '')
    history = useComposerInputHistory({ sessionId: 'agent-1', control: undefined, visible: true, readOnly: false, insertion })
    return <AgentComposer insertionRef={insertion} value={value} onChange={next => useAppStore.getState().setAgentComposerDraft('agent-1', next)} disabled={false} placeholder="Message" />
  }
  await dom.render(<Surface />)
  await act(async () => { element().focus(); editor().commands.insertContent(' TYPED') })
  const original = dom.draft()
  await act(async () => history.fillText('HISTORY'))
  await act(async () => { editor().commands.insertContent(' AFTER') })
  await act(async () => { expect(editor().commands.undo()).toBe(true) })
  expect(dom.draft()).toBe(original + ' HISTORY')
  await act(async () => { expect(editor().commands.undo()).toBe(true) })
  expect(dom.draft()).toBe(original)
  await act(async () => { expect(editor().commands.redo()).toBe(true) })
  expect(dom.draft()).toBe(original + ' HISTORY')
})

it.each([false, true])('actual Session/Launcher %s drops files, directories and an image at the drop point without sending', async launcher => {
  const send = vi.spyOn(api.sessions, 'submitPrompt'), launch = vi.spyOn(api.sessions, 'launchAgent')
  await mount(launcher)
  await act(async () => editor().commands.setTextSelection(1))
  expect((await drop([file('one.txt'), file('directory'), file('photo.png', 'image/png')])).defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(text(launcher ? 'region' : 'agent-1')).toContain(imagePath))
  expect(text(launcher ? 'region' : 'agent-1').replace(/ +/g, ' ')).toBe(`alpha @one.txt @directory @${imagePath} omega`)
  expect(dom.container.querySelectorAll('.composer-file')).toHaveLength(2)
  expect(dom.container.querySelector('.composer-image')).not.toBeNull()
  expect(api.ui.pathForFile).toHaveBeenCalledTimes(2)
  expect(api.ui.savePastedImage).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
  await act(async () => { expect(editor().commands.undo()).toBe(true) })
  expect(text(launcher ? 'region' : 'agent-1')).toBe('alpha omega')
})

it('an async drop maps through edits and does not replace the newer selection or focus', async () => {
  let saved!: (path: string) => void
  vi.mocked(api.ui.savePastedImage).mockReturnValue(new Promise(resolve => { saved = resolve }))
  await mount()
  await drop([file('photo.png', 'image/png')])
  const outside = document.createElement('input'); document.body.append(outside)
  try {
    await act(async () => { editor().commands.insertContentAt(1, 'NEW '); editor().commands.setTextSelection(1); outside.focus() })
    await act(async () => saved(imagePath))
    await vi.waitFor(() => expect(text()).toContain(imagePath))
    expect(text()).toBe(`NEW alpha @${imagePath} omega`)
    expect(editor().state.selection.from).toBe(1)
    expect(document.activeElement).toBe(outside)
  } finally { outside.remove() }
})

it.each([false, true])('a late drop never edits a different Session/Launcher %s target', async launcher => {
  let saved!: (path: string) => void
  vi.mocked(api.ui.savePastedImage).mockReturnValue(new Promise(resolve => { saved = resolve }))
  await mount(launcher)
  await drop([file('photo.png', 'image/png')])
  if (launcher) {
    await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace => ({ ...workspace, path: workspace.path + '/changed' })) } })))
  } else {
    await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, composerSession('agent-2')], agentComposerDrafts: { ...state.agentComposerDrafts, 'agent-2': 'other draft' } })))
    await dom.render(<AgentSessionComposer sessionId="agent-2" />)
  }
  await act(async () => saved(imagePath))
  expect(text(launcher ? 'region' : 'agent-2')).toBe(launcher ? 'alpha omega' : 'other draft')
  expect(text()).toBe('alpha omega')
})

it('readonly file drops do not call host IO or change the draft', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" readOnly />)
  await drop([file('photo.png', 'image/png')], 2)
  expect(dom.draft()).toBe('Keep my draft')
  expect(api.ui.pathForFile).not.toHaveBeenCalled(); expect(api.ui.savePastedImage).not.toHaveBeenCalled()
})

it('partial success retains valid resources and reports failed originals without a duplicate-batch Retry', async () => {
  const insertion = createRef<ComposerInsertionHandle>()
  function Surface({ hostId = 'local' }: { hostId?: string }) {
    const [value, setValue] = useState('alpha omega'), feedback = useComposerFeedback(hostId)
    const attachments = useComposerAttachments({ scope: hostId, hostId, workspacePath: rootPath, disabled: false, insertion, feedback })
    return <AgentComposer value={value} onChange={setValue} disabled={false} placeholder="Message" insertionRef={insertion}
      onDropFiles={attachments.dropFiles} feedback={<ComposerFeedback failure={feedback.failure} onDismiss={feedback.dismiss} />} />
  }
  vi.mocked(api.ui.pathForFile).mockImplementation(value => value.name === 'missing.txt' ? '' : `${rootPath}/${value.name}`)
  await dom.render(<Surface />)
  await drop([file('one.txt'), file('missing.txt'), file('photo.png', 'image/png')])
  await vi.waitFor(() => expect(dom.container.textContent).toContain('missing.txt'))
  expect(editor().getText()).toContain('one.txt'); expect(editor().getText()).toContain(imagePath)
  expect(dom.container.textContent).toContain('original local file path is unavailable')
  expect([...dom.container.querySelectorAll('.message-delivery-failure button')].some(button => /retry|重试/i.test(button.textContent || button.getAttribute('aria-label') || ''))).toBe(false)
  await dom.render(<Surface hostId="remote" />)
  const before = editor().getText()
  vi.mocked(api.ui.pathForFile).mockClear(); vi.mocked(api.ui.savePastedImage).mockClear()
  await drop([file('remote.txt'), file('photo.png', 'image/png')])
  expect(editor().getText()).toBe(before)
  expect(dom.container.textContent).toContain('not been transferred to the selected machine')
  expect(api.ui.pathForFile).not.toHaveBeenCalled(); expect(api.ui.savePastedImage).not.toHaveBeenCalled()
})

it.each(['plain text', 'https://example.invalid/a'])('native text and link drops preserve the original editor route: %s', async plain => {
  await mount()
  await drop([], 7, plain)
  expect(text()).toBe(`alpha ${plain}omega`)
  expect(api.ui.pathForFile).not.toHaveBeenCalled()
})

it('an internal text move uses ProseMirror once and never becomes an attachment', async () => {
  await mount()
  await act(async () => { editor().commands.setTextSelection({ from: 1, to: 6 }) })
  editor().view.dragging = { slice: editor().state.selection.content(), move: true }
  await drop([], 12, 'alpha')
  expect(text()).toBe(' omegaalpha')
  expect(api.ui.pathForFile).not.toHaveBeenCalled(); expect(api.ui.savePastedImage).not.toHaveBeenCalled()
})

it.each([false, true])('cancelled file and screenshot actions keep the Session/Launcher %s draft', async launcher => {
  vi.spyOn(api.ui, 'chooseFiles').mockResolvedValue(null)
  vi.spyOn(api.ui, 'captureScreenshot').mockResolvedValue(null)
  await mount(launcher)
  if (!launcher) await dom.click('.composer-tool--mode')
  await dom.click(launcher ? '[aria-label="Reference files for the Agent"]' : '[aria-label="Reference files for the Agent to read"]')
  await dom.click('[aria-label="Capture a screen region"]')
  expect(text(launcher ? 'region' : 'agent-1')).toBe('alpha omega')
  expect(api.ui.chooseFiles).toHaveBeenCalledOnce(); expect(api.ui.captureScreenshot).toHaveBeenCalledOnce()
})

it('preload resolves the original File with webUtils without serializing it through IPC', () => {
  const original = file('original.txt'), pathless = file('browser.txt')
  bridge.filePath.mockImplementation(value => value === original ? rootPath + '/original.txt' : '')
  const before = bridge.invoke.mock.calls.length
  expect(bridge.api!.ui.pathForFile(original)).toBe(rootPath + '/original.txt')
  expect(bridge.api!.ui.pathForFile(pathless)).toBe('')
  expect(bridge.filePath.mock.calls).toEqual([[original], [pathless]])
  expect(bridge.invoke.mock.calls).toHaveLength(before)
})

it('file drag feedback clears on leaving and cancellation leaves the draft unchanged', async () => {
  await mount()
  const over = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(over, 'dataTransfer', { value: transfer([file('one.txt')]) })
  await act(async () => element().dispatchEvent(over))
  expect(element().dataset.fileDropTarget).toBe('true')
  expect(over.defaultPrevented).toBe(true)
  await act(async () => element().dispatchEvent(new Event('dragleave', { bubbles: true })))
  expect(element().dataset.fileDropTarget).toBeUndefined()
  expect(text()).toBe('alpha omega')
  expect(api.ui.pathForFile).not.toHaveBeenCalled(); expect(api.ui.savePastedImage).not.toHaveBeenCalled()
})

it('composition keeps its draft and rejects only the current attachment without doing host IO', async () => {
  const insertion = createRef<ComposerInsertionHandle>()
  function Surface() {
    const [value, setValue] = useState('alpha omega'), feedback = useComposerFeedback('ime')
    const attachments = useComposerAttachments({ scope: 'ime', hostId: 'local', workspacePath: rootPath, disabled: false, insertion, feedback })
    return <AgentComposer value={value} onChange={setValue} disabled={false} placeholder="Message" insertionRef={insertion}
      onDropFiles={attachments.dropFiles} feedback={<ComposerFeedback failure={feedback.failure} onDismiss={feedback.dismiss} />} />
  }
  await dom.render(<Surface />)
  // ProseMirror owns this authoritative composition flag.
  const inputState = (editor().view as unknown as { input: { composing: boolean } }).input
  inputState.composing = true
  try {
    await drop([file('photo.png', 'image/png')])
    expect(editor().getText()).toBe('alpha omega')
    expect(dom.container.textContent).toContain('not accepting this attachment')
    expect(api.ui.savePastedImage).not.toHaveBeenCalled()
  } finally { inputState.composing = false }
})

it('same-Session attachment target A to B to A rejects the old A completion', async () => {
  let saved!: (path: string) => void
  vi.mocked(api.ui.savePastedImage).mockReturnValue(new Promise(resolve => { saved = resolve }))
  await mount()
  await drop([file('photo.png', 'image/png')])
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, workspacePath: rootPath + '/other' })) })))
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, workspacePath: rootPath })) })))
  await act(async () => saved(imagePath))
  expect(text()).toBe('alpha omega')
})

it('dropping over an existing file chip still reaches the same editor attachment route', async () => {
  await mount()
  await drop([file('one.txt')])
  const chip = dom.container.querySelector('.composer-file__name')!
  expect(chip).not.toBeNull()
  await drop([file('two.txt')], 7, '', chip)
  expect(text()).toContain('@one.txt')
  expect(text()).toContain('@two.txt')
  expect(dom.container.querySelectorAll('.composer-file')).toHaveLength(2)
})
