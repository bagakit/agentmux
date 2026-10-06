const { fixtureEpoch: _newTailFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
const recallCss = readFileSync('apps/desktop/src/renderer/src/styles/recall.css', 'utf8')
const canvasCss = readFileSync('apps/desktop/src/renderer/src/styles/note-canvas.css', 'utf8')
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import { api } from '../src/renderer/src/lib/api'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NotebookHome } from '../src/renderer/src/components/NotebookNavigation'
import { useAppStore } from '../src/renderer/src/store'
import type { Notebook, NotebookPage } from '@agentmux/core/notebook-catalog'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const title = '一个需要保留全部文字的超长笔记标题'.repeat(12)
const hostname = Array.from({ length: 4 }, () => 'a'.repeat(60)).join('.') + '.test'
const book: Notebook = { notebookId: 'long-title-book', name: 'Long findings', createdAt: 1 }
const pages: NotebookPage[] = Array.from({ length: 4 }, (_, i) => ({ noteId: `note-${i}`, notebookId: book.notebookId, parentNoteId: null, title: i ? `Original note ${i}` : title, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1), resource: { workspaceId: 'original', hostId: 'local', workspacePath: _hygiene_fixturePath("original"), path: `${i}.note.md` }, sources: [{ sourceId: `source-${i}`, url: `https://${hostname}/finding`, title: null, recordedAt: _newTailFixtureEpoch(0, 0, 1) }], topics: [] }))
let host: HTMLDivElement, root: Root, style: HTMLStyleElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); style = document.createElement('style'); style.textContent = recallCss; document.head.append(style); useAppStore.setState({ documents: {}, config: null, noteCanvasLayouts: {}, noteCanvasSaveIssues: {} }); installNoteCanvasGeometry(); const catalog = emptyNotebookState(); catalog.pages = Object.fromEntries(pages.map(page => [page.noteId, page])); vi.spyOn(api.notebooks, 'graph').mockResolvedValue({ catalog, graph: { catalogRevision: 0, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'unknown', observations: pages.map(page => ({ noteId: page.noteId, resource: page.resource, status: 'unknown', message: 'Original not yet read' })), duplicateNoteIds: [], references: [], hierarchy: [] } }); vi.spyOn(api.notebooks, 'onChange').mockImplementation(() => () => {}) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); style.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('bounds real Notebook long-title cards and Graph nodes while keeping original full labels and opening the same page', async () => {
  const open = vi.fn()
  async function render(view: 'cards' | 'graph') { await act(async () => root.render(<NotebookHome notebook={book} pages={pages} query="" pending={false} onCreate={() => {}} onOpen={open} view={view} />)) }
  await render('cards')
  const card = host.querySelector<HTMLButtonElement>('.recall-note-card')!
  expect(card.title).toBe(`${title}\n${hostname}`)
  // happy-dom omits vendor properties; actual Chromium screenshots validate wrapping.
  expect(recallCss.match(/\.recall-note-card strong \{([^}]+)\}/)?.[1]).toContain('-webkit-line-clamp: 3')
  expect(getComputedStyle(card.querySelector('span')!).overflowWrap).toBe('anywhere')
  expect(recallCss.match(/\.recall-note-card span \{([^}]+)\}/)?.[1]).toContain('-webkit-line-clamp: 2')
  await act(async () => card.click()); expect(open).toHaveBeenLastCalledWith(pages[0])
  await render('graph')
  await vi.waitFor(() => expect(host.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(4))
  const nodes = [...host.querySelectorAll<HTMLButtonElement>('.note-canvas-title[data-note-id]')]
  expect(nodes[0]!.title).toBe(title)
  expect(nodes[0]!.textContent).toBe(title)
  expect(canvasCss).toContain('overflow-wrap: anywhere')
  expect(host.querySelector('[aria-label="Full note: ' + title + '"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Collapse relationships: ' + title + '"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Fit visible notes"]')).not.toBeNull()
  await act(async () => nodes[0]!.click()); expect(open).toHaveBeenLastCalledWith(pages[0])
})
