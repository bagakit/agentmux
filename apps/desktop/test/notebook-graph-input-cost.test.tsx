import { fixtureEpoch as _tailRefreshFixtureEpoch, fixturePath as _tailRefreshFixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { emptyNotebookState, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { NotebookHome } from '../src/renderer/src/components/NotebookNavigation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), notebook = { notebookId: 'original-book', name: 'Original notebook', createdAt: _tailRefreshFixtureEpoch(0, 0, 1) }
const pages: NotebookPage[] = [{ noteId: 'original', notebookId: notebook.notebookId, parentNoteId: null, title: 'Original page', resource: { hostId: 'local', workspaceId: 'notes', workspacePath: _tailRefreshFixturePath("notes"), path: 'original.note.md' }, sources: [], topics: [], createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1) }]
async function render(active: boolean) { await dom.render(<div hidden={!active}><NotebookHome notebook={notebook} pages={pages} pending={false} onCreate={() => {}} onOpen={() => {}} query="" onQuery={() => {}} view="graph" active={active} /></div>) }
beforeEach(() => {
  installNoteCanvasGeometry()
  const catalog = emptyNotebookState(); catalog.pages.original = pages[0]!
  vi.spyOn(api.notebooks, 'graph').mockResolvedValue({ catalog, graph: { catalogRevision: 0, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'complete', hierarchy: [], references: [], duplicateNoteIds: [], observations: [{ noteId: 'original', resource: pages[0]!.resource, status: 'read', actualNoteId: 'original', revision: 'saved', blockIds: ['block'] }] } })
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(() => () => {})
  vi.spyOn(api.notebooks, 'content')
  useAppStore.setState({ noteCanvasLayouts: {}, noteCanvasSaveIssues: {} })
})
it('keeps the real canvas DOM and performs no graph or body IO for unrelated Sessions, ordinary files or Note drafts', async () => {
  await render(true)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-title')).not.toBeNull())
  const canvas = dom.container.querySelector('.react-flow'), input = dom.container.querySelector('input'), home = dom.container.querySelector('.survey-notebook-home')
  await act(async () => useAppStore.setState({ sessions: [...useAppStore.getState().sessions], documents: { ordinary: { path: 'ordinary.txt', content: 'Unrelated file update', revision: 'new' }, 'notes\0original.note.md': { path: 'original.note.md', content: 'Unsaved draft preserved', revision: 'draft' } }, dirtyDocuments: { 'notes\0original.note.md': true } }))
  await render(true)
  expect(dom.container.querySelector('.react-flow')).toBe(canvas); expect(dom.container.querySelector('input')).toBe(input); expect(dom.container.querySelector('.survey-notebook-home')).toBe(home)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1); expect(api.notebooks.content).not.toHaveBeenCalled()
  await dom.click('[aria-label="Refresh saved graph"]'); expect(api.notebooks.graph).toHaveBeenCalledTimes(2)
})
it('does no hidden observation and does not rescan an already observed graph on reactivation', async () => {
  await render(false); expect(api.notebooks.graph).not.toHaveBeenCalled()
  await render(true); await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-title')).not.toBeNull())
  await render(false); await render(true)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1); expect(api.notebooks.content).not.toHaveBeenCalled()
})
