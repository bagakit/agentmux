// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { fileUploadRevision, type FileImportParams } from '@agentmux/core/files'
import { NoteFileContext, resolveNoteSourceResource } from '@agentmux/client-ui/components/NoteFileContext'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NoteImageResource } from '../src/renderer/src/components/NoteImageResource'
import { openDesktopNoteLink } from '../src/renderer/src/lib/note-file-link'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const originalWorker = globalThis.Worker, originalObserver = globalThis.IntersectionObserver
const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: 'notes/source.note.md' }
afterEach(async () => { await dom.render(null); vi.stubGlobal('Worker', originalWorker); vi.stubGlobal('IntersectionObserver', originalObserver) })
const activeEditor = () => (dom.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
async function setup() {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const save = vi.fn(), change = vi.fn()
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: workspace.path, path: params.path }, result: { status: 'deleted' } }))
  vi.spyOn(api.files, 'readPreview').mockResolvedValue({ status: 'deleted', message: 'Preview fixture retains source' })
  await dom.render(<NoteFileContext.Provider value={resource}><NoteBlockEditor note={newNoteDocument('Original', 'attachment-note', 'body')} knowledge={noteKnowledge([])} onChange={change} onSave={save} onIssue={() => {}} onOpen={() => {}} /></NoteFileContext.Provider>)
  return { editor: activeEditor(), save, change }
}
async function selectFiles(files: File[]) {
  const input = dom.container.querySelector<HTMLInputElement>('input[type="file"]')!
  expect(input).not.toBeNull()
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}
function source(editor: Editor) { return serializeNoteDocument({ ...newNoteDocument('', 'attachment-note'), content: editor.getJSON() }) }
function written(params: FileImportParams) { return { operationId: params.operationId, resource: params.expectedResource, result: { status: 'written' as const, revision: params.revision, byteLength: params.byteLength } } }

it('real file chooser imports through Files, maps concurrent typing, and inserts relative image and attachment drafts without saving', async () => {
  const { editor, save } = await setup()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const imports = vi.spyOn(api.files, 'importPublic').mockImplementation(async params => { await gate; return written(params) })
  await act(async () => editor.commands.setTextSelection(5))
  await selectFiles([new File([new Uint8Array([0, 1, 2])], 'original picture.png', { type: 'image/png' }), new File(['original attachment'], 'report.txt')])
  await vi.waitFor(() => expect(imports).toHaveBeenCalledTimes(1))
  await act(async () => editor.view.dispatch(editor.state.tr.insertText('New ', 1)))
  await act(async () => { release(); await gate })
  await vi.waitFor(() => expect(imports).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(editor.getJSON().content![0]!.content!.some(node => node.type === 'image')).toBe(true))
  const first = imports.mock.calls[0]![0]
  expect(first.expectedRevision).toBeNull(); expect(first.expectedResource).toMatchObject({ ...resource, path: expect.stringMatching(/^notes\/attachment-.*-original picture\.png$/) })
  expect(first.revision).toBe(fileUploadRevision(Uint8Array.from([0, 1, 2])))
  const serialized = source(editor)
  expect(serialized).toContain('New Orig'); expect(serialized).toContain('![original picture.png](./attachment-'); expect(serialized).toContain('[report.txt](./attachment-')
  expect(serialized).not.toMatch(/data:|blob:/); expect(save).not.toHaveBeenCalled()
  await act(async () => editor.commands.undo()); expect(source(editor)).not.toContain('[report.txt]'); expect(save).not.toHaveBeenCalled()
})
it('unknown import leaves the draft editable and retains the original operation without another write', async () => {
  const { editor, save } = await setup(), before = editor.getJSON()
  const imports = vi.spyOn(api.files, 'importPublic').mockImplementation(async params => ({ operationId: params.operationId, resource: params.expectedResource, result: { status: 'unknown', code: 'RECEIPT_MISSING', message: 'Original publication receipt unavailable' } }))
  await selectFiles([new File(['original'], 'report.txt')])
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original publication receipt unavailable'))
  expect(dom.container.textContent).toContain(imports.mock.calls[0]![0].operationId)
  expect(editor.getJSON()).toEqual(before); expect(imports).toHaveBeenCalledTimes(1); expect(editor.isEditable).toBe(true); expect(save).not.toHaveBeenCalled()
})
it('clipboard shares the same importer and a second selection is reported while the first is pending', async () => {
  const { editor } = await setup()
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const imports = vi.spyOn(api.files, 'importPublic').mockImplementation(async params => { await gate; return written(params) })
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files: [new File(['first'], 'first.txt')], getData: () => '', types: ['Files'] } })
  await act(async () => editor.view.dom.dispatchEvent(event))
  await vi.waitFor(() => expect(imports).toHaveBeenCalledTimes(1)); expect(event.defaultPrevented).toBe(true)
  await selectFiles([new File(['second'], 'second.txt')]); expect(dom.container.textContent).toContain('An attachment import is still running')
  await act(async () => { release(); await gate }); await vi.waitFor(() => expect(source(editor)).toContain('[first.txt]'))
  expect(imports).toHaveBeenCalledTimes(1); expect(source(editor)).not.toContain('[second.txt]')
})
it('a Workspace remapping while import is pending cannot insert or silently rebind a confirmed resource', async () => {
  const { editor } = await setup(), before = editor.getJSON()
  let resolve!: (value: any) => void
  const imports = vi.spyOn(api.files, 'importPublic').mockImplementation(() => new Promise(done => { resolve = done }))
  await selectFiles([new File(['original'], 'original.txt')]); await vi.waitFor(() => expect(imports).toHaveBeenCalledTimes(1))
  await act(async () => { useAppStore.setState({ config: { ...composerConfig, workspaces: [{ ...workspace, hostId: 'other' }] } }); useAppStore.setState({ config: composerConfig }); resolve(written(imports.mock.calls[0]![0])) })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('No reference was inserted'))
  expect(editor.getJSON()).toEqual(before); expect(imports).toHaveBeenCalledTimes(1)
})
it('relative images retain their original source resource and a foreign observed body never inherits the display Host', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  const preview = vi.spyOn(api.files, 'readPreview').mockResolvedValue({ status: 'unavailable', code: 'REMOTE_WORKSPACE_PREVIEW_UNAVAILABLE', message: 'Original remote preview unavailable' })
  await dom.render(<NoteImageResource resource={resource} src="./assets/picture.png" alt="Original picture" title="Kept title" />)
  await vi.waitFor(() => expect(preview).toHaveBeenCalledWith(workspace.id, 'notes/assets/picture.png', { expectedResource: resource }))
  expect(dom.container.textContent).toContain('Original remote preview unavailable')
  await dom.render(<NoteImageResource resource={{ ...resource, hostId: 'foreign' }} src="./assets/picture.png" alt="Original picture" />)
  expect(dom.container.textContent).toContain('Original file resource unavailable'); expect(preview).toHaveBeenCalledTimes(1)
  expect(resolveNoteSourceResource(resource, { workspaceId: 'foreign-workspace', path: 'source.note.md' })).toBeNull()
  expect(resolveNoteSourceResource(resource, { workspaceId: workspace.id, path: 'nested/source.note.md' })).toEqual({ ...resource, path: 'nested/source.note.md' })
})
it('attachment opening resolves the authored directory and refuses a changed original Host', async () => {
  const open = vi.spyOn(useAppStore.getState(), 'openFile').mockResolvedValue(true)
  expect(await openDesktopNoteLink(resource, './attachment%20one.pdf')).toBe(true)
  expect(open).toHaveBeenCalledWith('notes/attachment one.pdf', undefined, undefined, resource.workspaceId)
  await expect(openDesktopNoteLink({ ...resource, hostId: 'another' }, './attachment%20one.pdf')).rejects.toThrow('Workspace changed')
  await expect(openDesktopNoteLink(resource, '../../outside.pdf')).rejects.toThrow('cannot be resolved')
  expect(open).toHaveBeenCalledTimes(1)
})
