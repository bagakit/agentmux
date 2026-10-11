// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_NOTEBOOK_ID, type Notebook, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme, serializeThemeFile } from '@agentmux/client-ui/theme'
import { ICON_GLYPHS, SEMANTIC_ICON_CATALOG, semanticIconHref } from '@agentmux/client-ui/icons'
import { NotebookHome, NotebookNavigation } from '../src/renderer/src/components/NotebookNavigation'
import { FilePathLabel } from '../src/renderer/src/components/FilePathLabel'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM(), book: Notebook = { notebookId: DEFAULT_NOTEBOOK_ID, name: 'Original notes', createdAt: _historyFixtureEpoch(0, 0, 1) }
const parent: NotebookPage = { noteId: 'original-note', notebookId: book.notebookId, title: 'Original selected note', parentNoteId: null,
  resource: { hostId: 'local', workspaceId: composerConfig.workspaces[0]!.id, workspacePath: composerConfig.workspaces[0]!.path, path: 'original.note.md' }, sources: [], topics: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2) }
const child: NotebookPage = { ...parent, noteId: 'original-child', title: 'Original child note', parentNoteId: parent.noteId,
  resource: { ...parent.resource, path: 'child.note.md' } }
const pages = [parent, child], notePath = 'M3 12L12 3L21 12L12 21Z', filePath = 'M4 4H20V20H4Z'
const open = vi.fn(), createChild = vi.fn(), create = vi.fn(), query = vi.fn(), archive = vi.fn(), select = vi.fn()
let release: () => void
beforeEach(() => { release = mountThemeRuntime(window, { appAppearance: 'light' }); for (const callback of [open, createChild, create, query, archive, select]) callback.mockReset() })
afterEach(() => release())
type Mode = 'sidebar' | 'tree' | 'cards'
async function render(mode: Mode) {
  await dom.render(<><section data-note-entry={mode}>{mode === 'sidebar'
    ? <NotebookNavigation notebooks={[book]} pages={pages} selectedId={book.notebookId} selectedNoteId={parent.noteId} onSelect={select} onOpen={open}
      onCreateChild={createChild} query="" onQuery={query} onCreate={create} pending={false} actions={null} archived={false} onArchivedChange={archive}/>
    : <NotebookHome notebook={book} pages={pages} pending={false} onCreate={create} onOpen={open} query="" view={mode}/>}</section>
    <section data-ordinary-file><FilePathLabel path="source/ordinary.txt"/><FilePathLabel path="source/unknown.unrecognized"/></section></>)
}
const symbol = (role: 'object.note' | 'file.text') => document.getElementById(semanticIconHref(role).slice(1))!
const shapes = (element: Element) => [...element.children].map(shape => [shape.localName, Object.fromEntries([...shape.attributes].map(attribute => [attribute.name, attribute.value]))])
function entries(mode: Mode) {
  const selector = mode === 'sidebar' ? '.survey-notebook-page' : mode === 'tree' ? '.notebook-page-directory > button' : '.recall-note-card'
  const buttons = [...dom.container.querySelectorAll<HTMLButtonElement>(selector)]
  expect(buttons).toHaveLength(2)
  for (const button of buttons) {
    const icon = button.querySelector('svg[data-semantic-icon="object.note"]')
    expect(icon, `${mode} exact Note identity`).not.toBeNull()
    expect(icon!.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('object.note'))
    expect(icon!.getAttribute('width')).toBe(String(mode === 'sidebar' ? 12 : mode === 'tree' ? 17 : 18))
    expect(icon!.getAttribute('height')).toBe(icon!.getAttribute('width'))
    if (mode !== 'sidebar') expect((icon as SVGSVGElement).style.strokeWidth).toBe(mode === 'tree' ? '1.5' : '1.4')
    expect(button.querySelector('[data-icon-animation]')).toBeNull()
  }
  return buttons
}

it.each(['sidebar', 'tree', 'cards'] as const)('real %s Note identities share exact user glyph/paths while preserving original entry nodes, file assets and page actions', async mode => {
  await render(mode)
  const buttons = entries(mode), texts = buttons.map(button => button.textContent), originalFile = shapes(symbol('file.text'))
  expect(SEMANTIC_ICON_CATALOG['file.text'].glyph).toBe('file-text')
  const custom = { ...structuredClone(GRAPHITE_THEME), id: 'custom.original-notes', name: 'Original note identity', icons: {
    'object.note': { kind: 'glyph' as const, glyph: 'book-open' as const }, 'file.text': { kind: 'paths' as const, paths: [{ d: filePath }] }
  } }
  const saved = serializeThemeFile(custom)
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(shapes(symbol('object.note'))).toEqual(ICON_GLYPHS['book-open'])
  expect(symbol('file.text').querySelector('path')?.getAttribute('d')).toBe(filePath)
  expect(entries(mode)).toEqual(buttons)
  const paths = { ...custom, icons: { ...custom.icons, 'object.note': { kind: 'paths' as const, paths: [{ d: notePath }] } } }
  await act(async () => { expect(previewTheme(paths).applied).toBe(true) })
  expect(symbol('object.note').querySelector('path')?.getAttribute('d')).toBe(notePath)
  expect(symbol('file.text').querySelector('path')?.getAttribute('d')).toBe(filePath)
  expect(entries(mode)).toEqual(buttons); expect(buttons.map(button => button.textContent)).toEqual(texts)
  const generic = dom.container.querySelector('[data-ordinary-file]')!
  expect(generic.querySelector('svg[data-semantic-icon="file.text"] use')?.getAttribute('href')).toBe(semanticIconHref('file.text'))
  expect(generic.querySelector('svg[data-semantic-icon="file.generic"]')).not.toBeNull()
  expect(generic.querySelector('[data-semantic-icon="object.note"]')).toBeNull()
  const noteBefore = shapes(symbol('object.note'))
  await act(async () => { expect(previewTheme({ ...paths, icons: { ...paths.icons, 'file.text': { kind: 'glyph' as const, glyph: 'file-text' as const } } }).applied).toBe(true) })
  expect(shapes(symbol('object.note'))).toEqual(noteBefore); expect(shapes(symbol('file.text'))).toEqual(originalFile)
  expect(serializeThemeFile(custom)).toBe(saved)
  await act(async () => buttons[1]!.click()); expect(open).toHaveBeenCalledExactlyOnceWith(child)
  expect(createChild).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled()
  if (mode === 'sidebar') {
    expect(buttons[0]!.getAttribute('aria-current')).toBe('page')
    await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Add subpage to Original child note"]')!.click())
    expect(createChild).toHaveBeenCalledExactlyOnceWith(child)
    expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Collapse Original selected note"]')!.getAttribute('aria-expanded')).toBe('true')
  }
})
