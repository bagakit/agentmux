// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { NoteFileContext } from '@agentmux/client-ui/components/NoteFileContext'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NoteSharedFileEditing } from '../src/renderer/src/components/NoteSharedFileEditing'
import { api } from '../src/renderer/src/lib/api'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const host = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: 'host/reading.note.md', noteId: 'host-note' }
const original = { ...host, path: 'shared/original.note.md', noteId: 'shared-note' }
afterEach(async () => { await dom.render(null); vi.unstubAllGlobals() })

it('the outer toolbar imports into the focused original editor resource and follows its pending operation', async () => {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: workspace.path, path: params.path }, result: { status: 'deleted' } }))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const imports = vi.spyOn(api.files, 'importPublic').mockImplementation(async params => { await gate; return { operationId: params.operationId, resource: params.expectedResource, result: { status: 'written', revision: params.revision, byteLength: params.byteLength } } })
  const save = vi.fn(), hostChange = vi.fn(), sharedChange = vi.fn(), knowledge = noteKnowledge([])
  // The original SharedScope owns focus for both real editors. Each editor still
  // has its own original file resource, as when the second body is an inclusion.
  await dom.render(<NoteSharedFileEditing target={host} active hasIncludes={false} occurrence="review-originals" knowledge={knowledge} onOpen={() => {}}>
    <NoteBlockEditor note={newNoteDocument('Host draft', host.noteId, 'host-body')} knowledge={knowledge} onChange={hostChange} onSave={save} onIssue={() => {}} onOpen={() => {}} />
    <NoteFileContext.Provider value={original}><NoteBlockEditor note={newNoteDocument('Original shared draft', original.noteId, 'shared-body')} knowledge={knowledge} onChange={sharedChange} onSave={save} onIssue={() => {}} onOpen={() => {}} /></NoteFileContext.Provider>
  </NoteSharedFileEditing>)
  const editors = [...dom.container.querySelectorAll<HTMLElement>('.note-block-content')].map(node => (node as HTMLElement & { editor: Editor }).editor)
  const outer = editors[0]!, shared = editors[1]!, before = outer.getJSON(), sharedBefore = shared.getJSON()
  await act(async () => { shared.commands.setTextSelection(1); shared.view.focus() })
  const firstMenu = dom.container.querySelector<HTMLSelectElement>('[aria-label="Insert Note content"]')!
  const picker = dom.container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['shared attachment'], 'report.txt')] })
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  await vi.waitFor(() => expect(imports).toHaveBeenCalledTimes(1))
  expect(imports.mock.calls[0]![0].expectedResource).toMatchObject({ hostId: original.hostId, workspaceId: original.workspaceId, workspacePath: original.workspacePath, path: expect.stringMatching(/^shared\/attachment-.*-report\.txt$/) })
  await vi.waitFor(() => expect(firstMenu.querySelector<HTMLOptionElement>('option[value="file"]')!.disabled).toBe(true))
  await act(async () => { shared.view.dispatch(shared.state.tr.insertText('Concurrent ', 1)); release(); await gate })
  await vi.waitFor(() => expect(shared.getJSON().content![0]!.content!.some(node => node.marks?.some(mark => mark.type === 'link'))).toBe(true))
  expect(outer.getJSON()).toEqual(before); expect(hostChange).not.toHaveBeenCalled()
  expect(shared.getText()).toContain('Concurrent report.txtOriginal shared draft')
  expect(shared.getJSON().content![0]!.attrs).toEqual(sharedBefore.content![0]!.attrs)
  expect(sharedChange).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(firstMenu.querySelector<HTMLOptionElement>('option[value="file"]')!.disabled).toBe(false))
  await act(async () => shared.commands.undo())
  expect(outer.getJSON()).toEqual(before); expect(save).not.toHaveBeenCalled()
})
