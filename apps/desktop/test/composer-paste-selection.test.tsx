// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const path = '/Users/test/.agentmux/pasted/shot.png'
function editor(): Editor {
  const element = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')
  expect(element).not.toBeNull()
  expect(element!.editor).toBeDefined()
  return element!.editor
}
async function mount(launcher = false) {
  useAppStore.setState({ agentComposerDrafts: { 'agent-1': 'alpha omega', region: 'alpha omega' } })
  if (launcher) {
    useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) }, activeWorkspaceId: 'workspace' })
    await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
  } else await dom.render(<AgentSessionComposer sessionId="agent-1" />)
}
async function select(from: number, to = from) {
  await act(async () => { editor().commands.setTextSelection({ from, to }) })
}
async function paste(text: string, image = false) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  const file = new File([new Uint8Array([1, 2, 3])], 'paste.png', { type: 'image/png' })
  Object.defineProperty(event, 'clipboardData', { value: {
    items: image ? [{ kind: 'file', type: 'image/png', getAsFile: () => file }] : [],
    getData: () => text
  } })
  await act(async () => { dom.container.querySelector('.tiptap')!.dispatchEvent(event) })
  return event
}

it.each([false, true])('plain text inserts at the caret in Agent/Launcher %s without replacing the draft', async (launcher) => {
  await mount(launcher)
  await select(7)
  const event = await paste('new ')
  expect(event.defaultPrevented).toBe(true)
  expect(dom.draft(launcher ? 'region' : 'agent-1')).toBe('alpha new omega')
  expect(editor().state.selection.from).toBe(11)
  await act(async () => { editor().commands.undo() })
  expect(dom.draft(launcher ? 'region' : 'agent-1')).toBe('alpha omega')
})

it('multiline paste replaces only the real selection and preserves both surrounding edges', async () => {
  await mount()
  await select(3, 9)
  await paste('ONE\nTWO')
  expect(dom.draft()).toBe('alONE\nTWOega')
})

it('an empty clipboard does not delete the selection', async () => {
  await mount()
  await select(3, 9)
  await paste('')
  expect(dom.draft()).toBe('alpha omega')
})

it('a pasted image reference is an inline preview at the selected position', async () => {
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(null)
  await mount()
  await select(7)
  await paste(`@${path} `)
  expect(dom.draft()).toBe(`alpha @${path} omega`)
  expect(dom.container.querySelector('.composer-image')).not.toBeNull()
})

it('async image bytes replace the mapped selection while preserving edits and the newer caret', async () => {
  let saved!: (path: string) => void
  vi.spyOn(api.ui, 'savePastedImage').mockImplementation(() => new Promise((resolve) => { saved = resolve }))
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(null)
  await mount()
  await select(7, 9)
  await paste('', true)
  await vi.waitFor(() => expect(saved).toBeTypeOf('function'))
  await act(async () => {
    editor().commands.insertContentAt(1, 'new ')
    editor().commands.setTextSelection(editor().state.doc.content.size - 1)
    editor().commands.insertContent(' tail')
  })
  await act(async () => saved(path))
  expect(dom.draft()).toBe(`new alpha @${path} ega tail`)
  expect(editor().state.selection.from).toBe(editor().state.doc.content.size - 1)
})

it.each([false, true])('file picker preserves its captured insertion and newer edits in Agent/Launcher %s', async (launcher) => {
  let chosen!: (paths: string[]) => void
  vi.spyOn(api.ui, 'chooseFiles').mockImplementation(() => new Promise((resolve) => { chosen = resolve }))
  await mount(launcher)
  await select(7)
  if (!launcher) await dom.click('.composer-tool--mode')
  await dom.click(launcher ? '[aria-label="Reference files for the Agent"]' : '[aria-label="Reference files for the Agent to read"]')
  await act(async () => { editor().commands.insertContentAt(1, 'new ') })
  await act(async () => chosen(['/repo/a.ts', '/repo/b.ts']))
  expect(dom.draft(launcher ? 'region' : 'agent-1')).toBe('new alpha @a.ts @b.ts omega')
})

it('capture inserts into the selection rather than appending after the whole draft', async () => {
  vi.spyOn(api.ui, 'captureScreenshot').mockResolvedValue(path)
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue(null)
  await mount()
  await select(7, 12)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Capture a screen region"]')
  expect(dom.draft()).toBe(`alpha @${path} `)
})
