// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import type { NoteGraphReference } from '@agentmux/core/notebook-observation'
import { noteHistoryRevision } from '@agentmux/core/note-history'
import { NoteSharedDetails } from '../src/renderer/src/components/NoteSharedDetails'
import { noteSharedRelations } from '../src/renderer/src/lib/note-shared-relations'
import { readNoteShareClipboard, stageNoteShare } from '../src/renderer/src/lib/note-share-staging'
import type { NoteFileTarget } from '../src/renderer/src/lib/file-document-consumers'
import type { useNoteCanvasObservation } from '../src/renderer/src/lib/use-note-canvas-observation'
import { newNoteDocument, readNoteDocument, serializeNoteDocument, type NoteInclude } from '../src/shared/note-document'
import { parseNotebookGraphSnapshot, type NotebookGraphSnapshot } from '../src/shared/notebook-observation'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM()
beforeEach(installNoteCanvasGeometry)
afterEach(async () => { await dom.render(null) })
afterAll(() => vi.unstubAllGlobals())
const target = (noteId: string): NoteFileTarget => ({ hostId: 'local', workspaceId: 'notes', workspacePath: fixturePath('shared-details'), path: `${noteId}.note.md`, noteId })
const resource = ({ noteId: _noteId, ...value }: NoteFileTarget) => value
function fixture() {
  const host = target('reader'), shared = target('shared'), moved = target('moved-source'), origin = target('origin'), other = target('other')
  const note = newNoteDocument('Shared original prose', shared.noteId, 'shared-body')
  note.title = 'Shared # original'; note.kind = 'shared-block'
  note.origin = { operationId: 'share-original', sourceNoteId: origin.noteId, sourcePath: origin.path, sourceRevision: noteHistoryRevision('Source baseline'), sourceBlockId: 'extracted-section' }
  const include: NoteInclude = { referenceId: 'reader-first', noteId: shared.noteId, path: shared.path, workspaceId: shared.workspaceId }
  const use = (file: NoteFileTarget, blockId: string, referenceId: string): NoteGraphReference => ({ source: { noteId: file.noteId, blockId }, sourceResource: resource(file), target: { kind: 'page', noteId: shared.noteId }, occurrence: { kind: 'stored', referenceId }, mode: 'embed', resolution: 'resolved' })
  const references = [use(moved, 'extracted-section', 'share-original:source'), use(host, 'first', include.referenceId), use(host, 'second', 'reader-second'), use(other, 'other-use', 'other-reference')]
  const unrelated = [
    { ...use(host, 'link', 'link-only'), mode: 'link' as const },
    { ...use(host, 'reference', 'reference-only'), mode: 'reference' as const, target: { kind: 'block' as const, noteId: shared.noteId, blockId: 'shared-body' } },
    { ...use(host, 'block-embed', 'block-only'), target: { kind: 'block' as const, noteId: shared.noteId, blockId: 'shared-body' } },
    { ...use(host, 'different-shared', 'different-target'), target: { kind: 'page' as const, noteId: 'different-shared' } }
  ]
  const catalog = emptyNotebookState()
  for (const file of [origin, host, other]) catalog.pages[file.noteId] = { noteId: file.noteId, notebookId: Object.keys(catalog.notebooks)[0]!, parentNoteId: null, title: file.noteId, createdAt: 0, updatedAt: 0, sources: [], topics: [], resource: resource(file) }
  const snapshot: NotebookGraphSnapshot = { catalog, graph: { catalogRevision: 0, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'complete', hierarchy: [], duplicateNoteIds: [], references: [...references, ...unrelated], observations: [
    { noteId: origin.noteId, resource: resource(origin), status: 'read', actualNoteId: origin.noteId, revision: 'origin-saved', blockIds: ['container'], blockForwardings: [{ blockId: 'extracted-section', includeBlockId: 'container', noteId: moved.noteId }] },
    { noteId: moved.noteId, resource: resource(moved), status: 'read', actualNoteId: moved.noteId, revision: 'moved-saved', blockIds: ['extracted-section'], kind: 'shared-block', fileIdentity: 'confirmed' },
    { noteId: shared.noteId, resource: resource(shared), status: 'read', actualNoteId: shared.noteId, revision: 'shared-saved', blockIds: ['shared-body'], kind: 'shared-block', fileIdentity: 'confirmed' },
    { noteId: host.noteId, resource: resource(host), status: 'read', actualNoteId: host.noteId, revision: 'reader-saved', blockIds: ['first', 'second', 'link', 'reference', 'block-embed', 'different-shared'] },
    { noteId: other.noteId, resource: resource(other), status: 'read', actualNoteId: other.noteId, revision: 'other-saved', blockIds: ['other-use'] },
    { noteId: 'different-shared', resource: resource(target('different-shared')), status: 'read', actualNoteId: 'different-shared', revision: 'different-saved', blockIds: ['different-body'], kind: 'shared-block', fileIdentity: 'confirmed' }
  ] } }
  parseNotebookGraphSnapshot(snapshot, {})
  const graph: ReturnType<typeof useNoteCanvasObservation> = { snapshot, issue: null, stale: false, busy: false, refresh: vi.fn() }
  const onOpen = vi.fn(async (_target: NoteFileTarget, _blockId?: string, _signal?: AbortSignal) => {})
  return { host, shared, moved, origin, other, note, include, snapshot, graph, onOpen }
}
type Fixture = ReturnType<typeof fixture>
async function mount(f: Fixture, active = true) {
  await dom.render(<section data-workbench-region-id="reader-region"><textarea aria-label="Original draft" defaultValue="Keep this draft" /><NoteSharedDetails note={f.note} target={f.shared} host={f.host} include={f.include} graph={f.graph} active={active} onOpen={f.onOpen} /></section>)
}
const marker = () => dom.container.querySelector<HTMLButtonElement>('.note-shared-block__marker')!
const panel = () => document.querySelector<HTMLDivElement>('.note-shared-details[role="dialog"]')
const action = (label: string) => {
  const found = Array.from(panel()!.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === label)
  if (!found) throw Error(`Missing shared action: ${label}`)
  return found
}
async function open() { await act(async () => marker().click()); await vi.waitFor(() => expect(panel()).not.toBeNull()) }

it('counts direct saved occurrences separately from documents and follows the exact extracted source through forwarding', () => {
  const f = fixture(), result = noteSharedRelations(f.snapshot, f.shared.noteId, f.note.origin, { target: f.host, referenceId: f.include.referenceId })
  expect(result.documents).toBe(3)
  expect(result.uses.map(use => use.reference.occurrence)).toEqual(['share-original:source', 'reader-first', 'reader-second', 'other-reference'].map(referenceId => ({ kind: 'stored', referenceId })))
  expect(result.uses.filter(use => use.current).map(use => use.reference.source)).toEqual([{ noteId: f.host.noteId, blockId: 'first' }])
  expect(result.source).toMatchObject({ source: true, current: false, title: 'moved-source', reference: { source: { noteId: f.moved.noteId, blockId: 'extracted-section' } } })
  expect(f.snapshot.catalog.pages[f.moved.noteId]).toBeUndefined()
})

it('requires the original occurrence and resource and keeps healthy uses when the extraction position is unknown', () => {
  const f = fixture()
  f.snapshot.graph.references[0] = { ...f.snapshot.graph.references[0]!, occurrence: { kind: 'stored', referenceId: 'similar-source' } }
  const current = { target: { ...f.host, path: 'different.note.md' }, referenceId: f.include.referenceId }
  const wrong = noteSharedRelations(f.snapshot, f.shared.noteId, f.note.origin, current)
  expect(wrong.source).toBeUndefined(); expect(wrong.uses.filter(use => use.current)).toEqual([])
  expect(wrong.documents).toBe(3); expect(wrong.uses).toHaveLength(4)
  f.snapshot.graph.references[0] = { ...f.snapshot.graph.references[0]!, occurrence: { kind: 'stored', referenceId: 'share-original:source' } }
  f.snapshot.graph.observations[0] = { noteId: f.origin.noteId, resource: resource(f.origin), status: 'unknown', message: 'Original location unread' }
  f.snapshot.graph.completeness = 'partial'; parseNotebookGraphSnapshot(f.snapshot, {})
  const unknown = noteSharedRelations(f.snapshot, f.shared.noteId, f.note.origin, { target: f.host, referenceId: f.include.referenceId })
  expect(unknown.source).toBeUndefined(); expect(unknown.uses).toHaveLength(4)
})

it('opens exact source and use blocks without a page catalog entry and retains the shared original after origin loss', async () => {
  const f = fixture(); await mount(f); await open()
  expect(panel()!.textContent).toContain('3 documents · 4 uses')
  const source = panel()!.querySelector<HTMLButtonElement>('.note-shared-details__origin button')!
  await act(async () => source.click())
  expect(f.onOpen).toHaveBeenLastCalledWith(f.moved, 'extracted-section', expect.any(AbortSignal)); expect(panel()).toBeNull()
  await open()
  const uses = panel()!.querySelectorAll<HTMLButtonElement>('.note-shared-details__uses button')
  expect(uses).toHaveLength(4); expect(uses[1]!.textContent).toContain('Current position')
  await act(async () => uses[2]!.click())
  expect(f.onOpen).toHaveBeenLastCalledWith(f.host, 'second', expect.any(AbortSignal))
  f.snapshot.graph.observations[0] = { noteId: f.origin.noteId, resource: resource(f.origin), status: 'missing', message: 'Original location removed' }
  f.snapshot.graph.completeness = 'partial'; parseNotebookGraphSnapshot(f.snapshot, {})
  f.graph = { ...f.graph, snapshot: { ...f.snapshot, graph: { ...f.snapshot.graph } } }
  await mount(f); await open()
  expect(panel()!.textContent).toContain('Shared content remains available')
  await act(async () => action('Open shared content').click())
  expect(f.onOpen).toHaveBeenLastCalledWith(f.shared, undefined, expect.any(AbortSignal))
})

it.each(['partial', 'stale', 'unavailable'] as const)('qualifies %s counts and refreshes the same observation', async state => {
  const f = fixture()
  if (state === 'partial') f.snapshot.graph.completeness = 'partial'
  if (state === 'stale') f.graph.stale = true
  if (state === 'unavailable') f.graph = { ...f.graph, snapshot: null, issue: 'Original graph owner unavailable' }
  await mount(f); await open()
  const counts = panel()!.querySelector('.note-shared-details__uses-heading')!
  if (state === 'unavailable') { expect(counts.textContent).toBe('Use locations'); expect(panel()!.textContent).toContain('Original graph owner unavailable') }
  else expect(counts.textContent).toContain(`${state === 'stale' ? 'Last confirmed' : 'At least'} · 3 documents · 4 uses`)
  await act(async () => action('Refresh locations').click())
  expect(f.graph.refresh).toHaveBeenCalledTimes(1)
})

it('preserves editing focus on hover, opens from keyboard focus and returns Escape to the marker without reopening', async () => {
  const f = fixture(); await mount(f)
  const draft = dom.container.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => { draft.focus(); draft.setSelectionRange(2, 6); marker().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  expect(panel()).not.toBeNull()
  expect(document.activeElement).toBe(draft); expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 6])
  await act(async () => marker().dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: draft })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  expect(panel()).toBeNull()
  await act(async () => marker().focus())
  expect(panel()).not.toBeNull(); expect(marker().getAttribute('aria-expanded')).toBe('true')
  await act(async () => panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await vi.waitFor(() => expect(panel()).toBeNull())
  expect(document.activeElement).toBe(marker()); expect(marker().getAttribute('aria-expanded')).toBe('false')
  expect(draft.value).toBe('Keep this draft')
})

it('opens explicitly, dismisses outside and preserves a failed original navigation for retry', async () => {
  const f = fixture(); await mount(f); await open()
  expect(document.activeElement).toBe(panel())
  const draft = dom.container.querySelector<HTMLTextAreaElement>('textarea')!
  // Radix defers registration past opening and checks the complete outside click.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  await act(async () => {
    draft.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    draft.focus(); draft.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' })); draft.click()
  })
  await vi.waitFor(() => expect(panel()).toBeNull()); expect(document.activeElement).toBe(draft)
  await open(); f.onOpen.mockRejectedValueOnce(Error('The original file is unavailable'))
  await act(async () => action('Open shared content').click())
  expect(panel()!.textContent).toContain('The original file is unavailable')
  expect(f.onOpen).toHaveBeenLastCalledWith(f.shared, undefined, expect.any(AbortSignal))
  await act(async () => action('Open shared content').click())
  expect(f.onOpen).toHaveBeenCalledTimes(2); expect(panel()).toBeNull()
})

it('copies a bound whole-file content link and a reusable original include through the real clipboard readers', async () => {
  const f = fixture(); let copied: DataTransfer | undefined
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => {
    copied = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: copied })); return true
  }) })
  await mount(f); await open(); await act(async () => action('Copy content link').click())
  expect(copied).toBeDefined(); expect(panel()!.textContent).toContain('Content link copied')
  const pasted = readNoteDocument(serializeNoteDocument(newNoteDocument('', 'paste-target', 'paste-block')) + copied!.getData('text/plain'))
  expect(pasted.status).toBe('valid'); if (pasted.status !== 'valid') throw Error(pasted.message)
  const links = pasted.note.content.content!.flatMap(node => node.content ?? []).filter(node => node.type === 'noteLink')
  expect(links).toHaveLength(1); expect(links[0]!.attrs).toMatchObject({ target: { noteId: f.shared.noteId }, text: 'Shared # original' })
  expect(links[0]!.attrs!.target.blockId).toBeUndefined()
  const html = document.createElement('div'); html.innerHTML = copied!.getData('text/html')
  expect(JSON.parse(html.querySelector<HTMLElement>('[data-note-link]')!.dataset.noteLink!)).toMatchObject({ target: { noteId: f.shared.noteId } })
  await act(async () => action('Copy shared reference').click())
  const copy = readNoteShareClipboard(new ClipboardEvent('paste', { clipboardData: copied! }), document)
  expect(copy).toMatchObject({ source: f.shared, include: { noteId: f.shared.noteId, path: f.shared.path, workspaceId: f.shared.workspaceId } })
  expect(panel()!.textContent).toContain('Reference copied · paste to share')
  const reuse = stageNoteShare('notes\0destination.note.md', copy!)
  expect(reuse).toMatchObject({ noteId: f.shared.noteId, path: f.shared.path }); expect(reuse.referenceId).not.toBe(f.include.referenceId)
  expect(reuse.forwardedBlockIds).toBeUndefined(); expect(f.onOpen).not.toHaveBeenCalled()
})

it('reports an unconfirmed clipboard result without claiming copy success', async () => {
  const f = fixture(); Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
  await mount(f); await open(); await act(async () => action('Copy content link').click())
  expect(panel()!.textContent).toContain('Copy was not confirmed')
  expect(panel()!.textContent).not.toContain('Content link copied')
})


it('cancels the previous detail navigation and ignores its completion after a later exact use is chosen', async () => {
  const f = fixture(), selected: string[] = [], pending: Array<{ signal?: AbortSignal; resolve(): void }> = []
  f.onOpen.mockImplementation((file, blockId, signal) => new Promise<void>(resolve => {
    pending.push({ signal, resolve() { if (!signal?.aborted) selected.push(`${file.noteId}:${blockId}`); resolve() } })
  }))
  await mount(f); await open()
  const uses = panel()!.querySelectorAll<HTMLButtonElement>('.note-shared-details__uses button')
  await act(async () => uses[1]!.click())
  await act(async () => uses[2]!.click())
  expect(pending).toHaveLength(2); expect(pending[0]!.signal?.aborted).toBe(true); expect(pending[1]!.signal?.aborted).toBe(false)
  await act(async () => pending[0]!.resolve())
  expect(selected).toEqual([]); expect(panel()).not.toBeNull()
  await act(async () => pending[1]!.resolve())
  expect(selected).toEqual(['reader:second']); expect(panel()).toBeNull()
})

it.each(['close', 'inactive', 'unmount', 'identity'] as const)('cancels a pending shared detail navigation on %s without applying its later failure', async reason => {
  const f = fixture(); let signal: AbortSignal | undefined, reject!: (error: Error) => void
  f.onOpen.mockImplementation((_target, _block, value) => new Promise<void>((_resolve, fail) => { signal = value; reject = fail }))
  await mount(f); await open(); await act(async () => action('Open shared content').click())
  expect(signal?.aborted).toBe(false)
  if (reason === 'close') await act(async () => panel()!.querySelector<HTMLButtonElement>('[aria-label="Close shared details"]')!.click())
  else if (reason === 'inactive') await mount(f, false)
  else if (reason === 'unmount') await dom.render(null)
  else { f.shared = { ...f.shared, path: 'moved-shared.note.md' }; await mount(f) }
  expect(signal?.aborted).toBe(true)
  if (reason === 'close') await open()
  await act(async () => reject(Error('Stale original navigation failure')))
  expect(document.body.textContent).not.toContain('Stale original navigation failure')
  if (reason === 'close') expect(panel()).not.toBeNull()
})
