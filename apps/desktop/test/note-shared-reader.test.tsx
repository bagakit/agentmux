// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Root } from 'react-dom/client'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { newNoteDocument, serializeNoteDocument, type NoteDocument } from '@agentmux/client-ui/note/note-document'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { ExecutionHost } from '@agentmux/core'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { NotebookObservationOwner } from '@agentmux/host/notebook-observation-owner'
import { parseNotebookGraphSnapshot } from '../src/shared/notebook-observation'
import { createClientUiRoot } from './helpers/client-ui-render'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'

let container: HTMLDivElement, root: Root
const directories: string[] = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  installNoteCanvasGeometry(); container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function originals(child = false, mode: 'reference' | 'embed' = 'embed') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-shared-reader-'))); directories.push(directory)
  const workspace = { id: 'notes', name: 'Notes', hostId: 'local', kind: 'folder' as const, path: directory }
  const files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost)), store = new AgentMuxNotebookStore(join(directory, 'catalog.json'))
  const owner = new NotebookObservationOwner({ workspace: () => workspace, files }), writer = new NoteFileWriter(files, { state: () => store.read(), owner }, store)
  await mkdir(join(directory, '.blocks'))
  const shared: NoteDocument = { ...newNoteDocument('Shared whole-file evidence.', 'shared', 'inner', 'Shared original'), kind: 'shared-block' }
  const source: NoteDocument = { schema: 'agentmux.note.v1', noteId: 'source', title: 'Source', content: { type: 'doc', content: [{ type: 'noteInclude', attrs: { blockId: 'old-address', referenceId: 'shared-use', noteId: 'shared', path: '.blocks/old.note.md' } }] } }
  const reading: NoteDocument = { schema: 'agentmux.note.v1', noteId: 'reading', title: 'Reader', content: { type: 'doc', content: [{ type: 'blockReference', attrs: { blockId: 'old-reference', referenceId: 'old-use', mode, target: { noteId: 'source', blockId: 'old-address' } } }] } }
  if (child) {
    source.content.content![0]!.attrs!.forwardedBlockIds = ['inner']
    reading.content.content![0]!.attrs!.target = { noteId: 'source', blockId: 'inner' }
  }
  for (const [path, note] of [['reading.note.md', reading], ['source.note.md', source], ['.blocks/moved.note.md', shared]] as const) {
    expect(await writer.write(workspace, { path, expectedRevision: null, content: serializeNoteDocument(note) })).toMatchObject({ status: 'written' })
    if (note !== shared) {
      const state = await store.read()
      await store.apply({ expectedRevision: state.revision, operationId: 'register-' + note.noteId, change: { kind: 'register', noteId: note.noteId, title: note.title!, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path } } }, { kind: 'user', id: 'test' })
    }
  }
  const body = await files.read(workspace, '.blocks/moved.note.md')
  if (body.status !== 'read') throw Error('Shared original file was not saved')
  // The file entity survives normal, unanchored internal Markdown changes.
  expect(await files.write(workspace, { path: '.blocks/moved.note.md', expectedRevision: body.document.revision, content: body.document.content + '\nA new unanchored ordinary paragraph.\n' })).toMatchObject({ status: 'written' })
  const state = await store.read(), graph = await owner.graph(state, { noteId: 'reading' })
  const snapshot = parseNotebookGraphSnapshot({ catalog: state, graph }, { noteId: 'reading' })
  const documents = []
  for (const path of ['source.note.md', '.blocks/moved.note.md']) {
    const value = await files.read(workspace, path)
    if (value.status !== 'read') throw Error('Original source unreadable')
    documents.push({ location: { workspaceId: 'notes', path }, document: value.document })
  }
  const read = await files.read(workspace, 'reading.note.md')
  if (read.status !== 'read') throw Error('Reader source unreadable')
  return { graph, snapshot, documents, read: read.document }
}

it.each(['reference', 'embed'] as const)('renders an old block reference through a source include into the complete shared original in %s mode even when note-scoped graph edges are filtered', async mode => {
  const f = await originals(false, mode), kind = mode === 'embed' ? 'Embedded block' : 'Block reference'
  expect(f.graph.completeness).toBe('partial')
  expect(f.graph.references).toHaveLength(1)
  expect(f.graph.references[0]!.target).toEqual({ kind: 'block', noteId: 'source', blockId: 'old-address' })
  expect(f.graph.observations.find(item => item.noteId === 'shared')).toMatchObject({ kind: 'shared-block', fileIdentity: 'confirmed' })
  await act(async () => root.render(<NoteReader workspaceId="notes" {...f.read} documents={f.documents} graph={f.graph} blockIds={['old-reference']} clipBlocks={false} />))
  await vi.waitFor(() => expect(container.querySelector('[data-shared-note-id="shared"]')?.textContent).toContain('Shared whole-file evidence.'))
  expect(container.textContent).toContain('A new unanchored ordinary paragraph.')
  expect(container.querySelector('[data-block-id="old-address"]')).not.toBeNull()
  expect(container.querySelector('[data-shared-note-id="shared"]')!.getAttribute('contenteditable')).toBe('false')
  const shared = container.querySelector('[data-shared-note-id="shared"]')!, source = shared.querySelector<HTMLDetailsElement>(':scope > .note-reader-source')!
  expect(shared.querySelector(':scope > strong')).toBeNull()
  expect(source.open).toBe(false); expect(source.querySelector('summary')!.textContent).toBe('')
  expect(source.querySelector('summary')!.getAttribute('aria-label')).toBe('Shared content source')
  await act(async () => source.querySelector('summary')!.click())
  expect(source.open).toBe(true); expect(source.textContent).toContain('Shared original'); expect(source.textContent).toContain('.blocks/moved.note.md')
  const reference = container.querySelector('[data-block-id="old-reference"]')!
  expect(reference.querySelector(':scope > strong')).toBeNull()
  const origin = reference.querySelector<HTMLDetailsElement>(':scope > .note-reader-source')!
  expect(origin.querySelector('summary')!.getAttribute('aria-label')).toBe(`${kind} source`)
  await act(async () => origin.querySelector('summary')!.click())
  expect(origin.open).toBe(true); expect(origin.textContent).toContain(kind); expect(origin.textContent).toContain('source / old-address')
})

it('retains a visible original-file read action when shared identity is unknown instead of displaying loaded bytes as a confirmed include', async () => {
  const f = await originals(), graph = structuredClone(f.graph), readInclude = vi.fn()
  graph.observations.find(item => item.noteId === 'shared')!.fileIdentity = 'unknown'
  await act(async () => root.render(<NoteReader workspaceId="notes" {...f.read} documents={f.documents} graph={graph} readInclude={readInclude} />))
  await vi.waitFor(() => expect(container.textContent).toContain('共享原文尚未确认'))
  expect(container.textContent).not.toContain('Shared whole-file evidence.')
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === '读取共享原文')!
  expect(button).toBeDefined(); await act(async () => button.click())
  expect(readInclude).toHaveBeenCalledWith({ noteId: 'shared', path: '.blocks/old.note.md' })
})

it('renders an old child reference from the actual shared original rather than a nonexistent host child', async () => {
  const f = await originals(true)
  expect(f.graph.references[0]).toMatchObject({ target: { kind: 'block', noteId: 'source', blockId: 'inner' }, resolution: 'resolved' })
  expect(f.graph.observations.find(item => item.noteId === 'source')).toMatchObject({ blockIds: ['old-address'], blockForwardings: [{ blockId: 'inner', includeBlockId: 'old-address', noteId: 'shared' }] })
  await act(async () => root.render(<NoteReader workspaceId="notes" {...f.read} documents={f.documents} graph={f.graph} blockIds={['old-reference']} clipBlocks={false} />))
  await vi.waitFor(() => expect(container.textContent).toContain('Shared whole-file evidence.'))
  expect(container.querySelector('[data-block-id="inner"]')).not.toBeNull()
  expect(container.textContent).not.toContain('原始块尚未读取')
})

it('names a compact shared original through its icon and preserves its exact open target', async () => {
  const f = await originals(), onOpenLink = vi.fn()
  await act(async () => root.render(<NoteReader workspaceId="notes" {...f.read} documents={f.documents} graph={f.graph} compactIncludes onOpenLink={onOpenLink} />))
  await vi.waitFor(() => expect(container.querySelector('.note-include-link')).not.toBeNull())
  const include = container.querySelector('.note-include-link')!, icon = include.querySelector('svg')!
  expect(icon.getAttribute('aria-label')).toBe('Shared content');expect(icon.getAttribute('aria-hidden')).toBe('false');expect(icon.getAttribute('role')).toBe('img')
  expect(include.textContent).toBe('Shared original')
  await act(async () => include.querySelector('button')!.click())
  expect(onOpenLink).toHaveBeenCalledExactlyOnceWith({ text: 'Shared original', target: { noteId: 'shared' } })
})
