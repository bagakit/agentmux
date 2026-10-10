// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { emptyNotebookState, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { useNoteFileName, useNoteSourceTitle } from '../src/renderer/src/lib/note-source-name'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { useAppStore } from '../src/renderer/src/store'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { newNoteDocument, serializeNoteDocument, type NoteDocument } from '../src/shared/note-document'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM(), path = 'original.note.md', workspace = composerConfig.workspaces[0]!
const key = documentKey(workspace.id, path)
function Names({ note, sourcePath = path }: { note: NoteDocument; sourcePath?: string }) {
  const sourceTitle = useNoteSourceTitle(), fileTitle = useNoteFileName(workspace.id, path)
  return <><output aria-label="Source display title">{sourceTitle({ note, location: { workspaceId: workspace.id, path: sourcePath } }) ?? 'Unknown'}</output>
    <output aria-label="File display title">{fileTitle ?? 'Unknown'}</output></>
}
function catalog(title: string, sourcePath = path) {
  const state = emptyNotebookState()
  state.pages.original = { noteId: 'original', title, notebookId: 'quick-notes', parentNoteId: null,
    resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: sourcePath },
    workface: { workspaceId: workspace.id, zoneId: 'original-zone' }, sources: [], topics: [], createdAt: _historyFixtureEpoch(0, 0, 0), updatedAt: _historyFixtureEpoch(0, 0, 0) } satisfies NotebookPage
  return state
}
beforeEach(() => {
  useNotebookLibrary.setState({ state: null, issue: null })
  useAppStore.setState({ documents: {}, dirtyDocuments: {} })
  vi.spyOn(api.files, 'read').mockRejectedValue(new Error('Display names must reuse the already parsed source'))
  vi.spyOn(api.notebooks, 'read').mockRejectedValue(new Error('Display names must not discover a catalog'))
})

it('uses the current self-contained file title without a catalog and keeps it ahead of an older projection', async () => {
  const note = newNoteDocument('Original text', 'original', 'block', 'Current file title C')
  useAppStore.setState({ documents: { [key]: { path, content: serializeNoteDocument(note), revision: 'original-revision' } } })
  await dom.render(<Names note={note} />)
  const titles = () => [...dom.container.querySelectorAll('output')].map(node => node.textContent)
  expect(titles()).toEqual(['Current file title C', 'Current file title C'])
  await act(async () => useNotebookLibrary.setState({ state: catalog('Older directory title B') }))
  expect(titles()).toEqual(['Current file title C', 'Current file title C'])
  const dirty = { ...note, title: 'Draft title D' }
  await act(async () => useAppStore.setState({ documents: { [key]: { path, content: serializeNoteDocument(dirty), revision: 'original-revision' } }, dirtyDocuments: { [key]: true } }))
  await dom.render(<Names note={dirty} />)
  expect(titles()).toEqual(['Draft title D', 'Draft title D'])
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.notebooks.read).not.toHaveBeenCalled()
})

it('only falls back to a catalog title for the exact original Note resource when its file has no title', async () => {
  const note = newNoteDocument('Original text', 'original', 'block')
  useAppStore.setState({ documents: { [key]: { path, content: serializeNoteDocument(note), revision: 'original-revision' } } })
  useNotebookLibrary.setState({ state: catalog('Another resource title', 'another.note.md') })
  await dom.render(<Names note={note} />)
  expect([...dom.container.querySelectorAll('output')].map(node => node.textContent)).toEqual(['Unknown', 'Unknown'])
  await act(async () => useNotebookLibrary.setState({ state: catalog('Known original title') }))
  expect([...dom.container.querySelectorAll('output')].map(node => node.textContent)).toEqual(['Known original title', 'Known original title'])
  await dom.render(<Names note={note} sourcePath="another.note.md" />)
  expect([...dom.container.querySelectorAll('output')].map(node => node.textContent)).toEqual(['Unknown', 'Known original title'])
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.notebooks.read).not.toHaveBeenCalled()
})
