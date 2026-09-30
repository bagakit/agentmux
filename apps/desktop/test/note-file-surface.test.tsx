// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, type WorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <textarea aria-label="Original file source" value={value} readOnly /> }))
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion, documentKey, fileTabId, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { NOTE_SCHEMA, readNoteDocument, newNoteDocument } from '../src/shared/note-document'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import * as noteKnowledgeModule from '../src/renderer/src/lib/note-knowledge'
import * as noteDocumentModule from '../src/shared/note-document'
import * as noteDirectoryModule from '../src/renderer/src/lib/note-directory-sources'
import { noteBlockSelectionKey } from '../src/renderer/src/lib/note-block-selection'
const dom = composerDOM(), birth = directoryIdentity('local', '/repo'), zoneId = homeZoneId(birth)
const original = { ...createWorkbenchTab('mixed-original', { kind: 'launcher', workspaceId: 'workspace', regionId: 'mixed-launcher' }), space: { spaceId: birth, zoneId } }
const sourceRegion: FileWorkbenchSurface = { kind: 'file', regionId: 'mixed-file', workspaceId: 'workspace', path: 'source.note.json' }
const mixed = addWorkbenchRegion(original, 'mixed-launcher', 'right', sourceRegion)
const referring: FileWorkbenchSurface = { kind: 'file', regionId: 'referring-file', workspaceId: 'workspace', path: 'referring.note.json' }
const referringTab = { ...createWorkbenchTab('referring-tab', referring), space: { spaceId: birth, zoneId } }
const source = newNoteDocument('Original finding', 'source-note', 'source-block')
const reference = { schema: NOTE_SCHEMA, noteId: 'referring-note', content: { type: 'doc', content: [{ type: 'blockReference', attrs: { blockId: 'referring-block', referenceId: 'referring-reference', target: { noteId: 'source-note', blockId: 'source-block' }, mode: 'reference' } }] } }
const sourceKey = documentKey('workspace', sourceRegion.path), referenceKey = documentKey('workspace', referring.path)
beforeEach(() => {
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: 'workspace', mainSurface: 'survey', sessions: [composerSession()], tabs: { [mixed.id]: mixed, [referringTab.id]: referringTab },
    layouts: { workspace: createWorkspaceLayout('original-group', [mixed.id, referringTab.id]) },
    documents: { [sourceKey]: { path: sourceRegion.path, content: JSON.stringify(source), revision: 'source-revision' }, [referenceKey]: { path: referring.path, content: JSON.stringify(reference), revision: 'referring-revision' } },
    dirtyDocuments: {}, savingDocuments: {}, documentIssues: {}, documentGenerations: {}, documentObservationGenerations: {}, documentRevealTargets: {}, noteBlockSelections: {}, noteDirectorySources: {}, workspaceFileRevisions: {}, spaceZoneBindings: {}, scratchTopicSnapshots: {}, spatialRequests: {},
    surveyZoneSelection: { zoneId, selection: [{ displayWorkspaceId: 'workspace', groupId: 'original-group', tabId: referringTab.id, regionId: referring.regionId }], active: { displayWorkspaceId: 'workspace', groupId: 'original-group', tabId: referringTab.id, regionId: referring.regionId } },
    regionCaretFocus: null, retainedSpatialFocus: null, error: null, lastError: null, lastActiveFileByWorkspace: {} })
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'read').mockRejectedValue(new Error('These canonical documents are already read'))
  vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'saved-revision' })
  vi.spyOn(api.files, 'readDirectory').mockRejectedValue(new Error('Render must not discover directories'))
})
function display(surface = sourceRegion, tabId = mixed.id) {
  return { tabHostId: 'survey-note-test', reference: { displayWorkspaceId: 'workspace', groupId: 'original-group', tabId, regionId: surface.regionId } }
}
async function mount(surface = sourceRegion, tabId = mixed.id, confirmed = true) {
  const state = useAppStore.getState(), projection = { entity: { kind: 'zone' as const, zoneId }, presentationId: 'survey-workbench', displayWorkspaceId: 'workspace',
    catalog: spatialCatalog(state, []), selection: state.surveyZoneSelection!.selection, onSelect: () => {} }
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, survey: true, projection, ...(confirmed ? display(surface, tabId) : {}) }}>
    <FileSurfaceView tabId={tabId} surface={surface} />
  </WorkbenchPresentationContext.Provider>)
  await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 0)) })
  await vi.waitFor(async () => { await act(async () => { await vi.dynamicImportSettled() }); expect(dom.container.querySelector('.note-block-content')).not.toBeNull() })
}
function editor(): Editor {
  const node = dom.container.querySelector<HTMLElement & { editor: Editor }>('.note-block-content')
  expect(node).not.toBeNull(); return node!.editor
}
function twoPositions(): WorkspaceLayout {
  return { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', groupId: 'original-group' }, second: { type: 'leaf', groupId: 'second-group' } },
    groups: [...createWorkspaceLayout('original-group', [mixed.id, referringTab.id]).groups, ...createWorkspaceLayout('second-group', [mixed.id]).groups], activeGroupId: 'original-group' }
}
async function click(label: string) {
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)
  expect(button, dom.container.textContent ?? '').toBeDefined(); await act(async () => button!.click())
}
it('connects the real FileSurfaceView to canonical update/save and the original Source toggle', async () => {
  await mount(); expect(dom.container.querySelector('textarea')).toBeNull()
  await act(async () => editor().commands.insertContentAt(1, 'Edited '))
  const state = useAppStore.getState(), raw = state.documents[sourceKey]!.content
  expect(state.dirtyDocuments[sourceKey]).toBe(true)
  const read = readNoteDocument(raw); expect(read.status).toBe('valid')
  if (read.status === 'valid') { expect(read.note.noteId).toBe('source-note'); expect(read.note.content.content![0]!.attrs!.blockId).toBe('source-block') }
  await click('Source'); expect(dom.container.querySelector('textarea')!.value).toBe(raw)
  await click('Preview'); expect(editor().state.doc.textContent).toBe('Edited Original finding')
  await click('Save'); expect(api.files.write).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.files.write).mock.lastCall).toEqual(['workspace', { path: sourceRegion.path, content: raw, expectedRevision: 'source-revision' }])
  expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(false)
})
it('uses the original conflict actions and preserves the rich draft rather than saving on a conflicting shortcut', async () => {
  await mount(); await act(async () => editor().commands.insertContentAt(1, 'Unsaved '))
  const raw = useAppStore.getState().documents[sourceKey]!.content
  await act(async () => useAppStore.setState({ documentIssues: { [sourceKey]: { kind: 'changed', observed: { path: sourceRegion.path, content: JSON.stringify(source), revision: 'external' } } } }))
  expect(dom.container.textContent).toContain('Your draft is preserved')
  expect([...dom.container.querySelectorAll('button')].map(button => button.textContent?.trim())).toContain('Overwrite')
  await act(async () => editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })))
  expect(api.files.write).not.toHaveBeenCalled(); expect(useAppStore.getState().documents[sourceKey]!.content).toBe(raw)
})
it('returns to an existing mixed Tab second File Region without creating a canonical replacement or changing Space focus', async () => {
  await mount(referring, referringTab.id)
  const before = useAppStore.getState(), tabs = before.tabs, layout = before.layouts.workspace!, active = layout.groups[0]!.activeTabId, region = mixed.layout.activeRegionId
  const link = dom.container.querySelector<HTMLButtonElement>('.note-reference__source button')
  expect(link).not.toBeNull(); await act(async () => link!.click())
  expect(dom.container.querySelector('.note-surface > .note-knowledge-notice'), dom.container.textContent ?? '').toBeNull()
  const after = useAppStore.getState()
  expect(Object.keys(after.tabs)).toEqual(Object.keys(tabs))
  expect(after.tabs[fileTabId('workspace', sourceRegion.path)]).toBeUndefined()
  expect(after.tabs[mixed.id]).toBe(mixed)
  expect(after.tabs[mixed.id]!.layout.activeRegionId).toBe(region)
  expect(after.layouts.workspace!.groups[0]!.activeTabId).toBe(active)
  expect(after.mainSurface).toBe('survey')
  expect(after.surveyZoneSelection?.active).toEqual({ displayWorkspaceId: 'workspace', groupId: 'original-group', tabId: mixed.id, regionId: sourceRegion.regionId })
  expect(after.documentRevealTargets[sourceKey]?.noteBlock).toEqual({ noteId: 'source-note', blockId: 'source-block' })
  expect(api.files.read).not.toHaveBeenCalled()
})
it('does not discover on render or rebuild the rich editor for unrelated Session status', async () => {
  const documents = useAppStore.getState().documents, entries = Object.entries
  let scans = 0
  vi.spyOn(Object, 'entries').mockImplementation(value => { if (value === documents) scans++; return entries(value) })
  const index = vi.spyOn(noteKnowledgeModule, 'noteKnowledge'), parse = vi.spyOn(noteDocumentModule, 'readNoteDocument')
  await mount(); const originalEditor = editor(), doc = originalEditor.state.doc, selection = originalEditor.state.selection.toJSON()
  expect(scans).toBeGreaterThan(0); expect(index).toHaveBeenCalled(); expect(parse).toHaveBeenCalled()
  const before = { scans, indexed: index.mock.calls.length, parsed: parse.mock.calls.length }
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession('unrelated'), latestOutputBytes: 512, status: { state: 'running', source: 'run-process', observedAt: 2 } }] }))
  expect({ scans, indexed: index.mock.calls.length, parsed: parse.mock.calls.length }).toEqual(before)
  expect(editor()).toBe(originalEditor); expect(editor().state.doc).toBe(doc); expect(editor().state.selection.toJSON()).toEqual(selection)
  expect(api.files.readDirectory).not.toHaveBeenCalled(); expect(api.files.read).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Partial scope')
})
it('does not rederive this directory for another project revision or an unrelated file issue', async () => {
  vi.mocked(api.files.readDirectory).mockResolvedValue([{ name: sourceRegion.path, path: sourceRegion.path, isDirectory: false, isSymlink: false }, { name: referring.path, path: referring.path, isDirectory: false, isSymlink: false }])
  const facts = vi.spyOn(noteDirectoryModule, 'noteDirectorySourceFacts')
  await mount(); await click('Refresh directory'); expect(facts).toHaveBeenCalled()
  const before = facts.mock.calls.length
  await act(async () => useAppStore.setState({ workspaceFileRevisions: { 'other-project': 10 }, documentIssues: { [documentKey('other-project', 'ordinary.txt')]: { kind: 'read-error', code: 'EIO', message: 'Unrelated error' } } }))
  expect(facts).toHaveBeenCalledTimes(before)
})
it('reads a valid reference-only Note without inserting content, assigning new IDs, or making it dirty', async () => {
  const before = useAppStore.getState().documents[referenceKey]!, generation = useAppStore.getState().documentGenerations[referenceKey]
  await mount(referring, referringTab.id)
  expect(editor().getJSON()).toEqual(reference.content)
  expect(useAppStore.getState().documents[referenceKey]).toBe(before)
  expect(useAppStore.getState().dirtyDocuments[referenceKey]).toBeUndefined()
  expect(useAppStore.getState().documentGenerations[referenceKey]).toBe(generation)
  expect(api.files.write).not.toHaveBeenCalled()
})
it('returns to a different original Zone in Survey with its precise Region and preserves the Space layout', async () => {
  const targetZone = 'other-original-zone', targetTab = { ...mixed, space: { spaceId: birth, zoneId: targetZone } }
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [mixed.id]: targetTab } }))
  await mount(referring, referringTab.id)
  const before = useAppStore.getState(), tabs = before.tabs, layouts = before.layouts
  const link = dom.container.querySelector<HTMLButtonElement>('.note-reference__source button')
  expect(link).not.toBeNull(); await act(async () => link!.click())
  const after = useAppStore.getState()
  expect(after.mainSurface).toBe('survey'); expect(after.activeWorkspaceId).toBe('workspace')
  expect(after.surveyZoneSelection?.zoneId).toBe(targetZone)
  expect(after.surveyZoneSelection?.active).toEqual({ displayWorkspaceId: 'workspace', groupId: 'original-group', tabId: mixed.id, regionId: sourceRegion.regionId })
  expect(after.tabs).toBe(tabs); expect(after.layouts).toBe(layouts)
  expect(after.documentRevealTargets[sourceKey]?.noteBlock).toEqual({ noteId: 'source-note', blockId: 'source-block' })
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})
it('explicitly chooses among multiple original positions instead of silently taking the first Group', async () => {
  useAppStore.setState({ layouts: { workspace: twoPositions() } })
  await mount(referring, referringTab.id)
  const before = useAppStore.getState(), selection = before.surveyZoneSelection, tabs = before.tabs, layouts = before.layouts
  const link = dom.container.querySelector<HTMLButtonElement>('.note-reference__source button')
  expect(link).not.toBeNull(); await act(async () => link!.click())
  const choices = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-source-choices button')]
  expect(choices).toHaveLength(2)
  expect(useAppStore.getState().surveyZoneSelection).toBe(selection)
  expect(useAppStore.getState().documentRevealTargets[sourceKey]).toBeUndefined()
  const second = choices.find(choice => choice.getAttribute('aria-label')?.includes('second-group'))
  expect(second).toBeDefined(); await act(async () => second!.click())
  expect(useAppStore.getState().surveyZoneSelection?.active).toEqual({ displayWorkspaceId: 'workspace', groupId: 'second-group', tabId: mixed.id, regionId: sourceRegion.regionId })
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().layouts).toBe(layouts)
  expect(dom.container.querySelector('.note-source-choices')).toBeNull()
})
it('keeps the exact target when a block disappears while its original position chooser is open', async () => {
  useAppStore.setState({ layouts: { workspace: twoPositions() } }); await mount(referring, referringTab.id)
  const link = dom.container.querySelector<HTMLButtonElement>('.note-reference__source button')
  expect(link).not.toBeNull(); await act(async () => link!.click())
  await act(async () => useAppStore.getState().updateDocument(mixed.id, JSON.stringify(newNoteDocument('Replacement block', 'source-note', 'replacement-block')), sourceRegion.regionId))
  const selection = useAppStore.getState().surveyZoneSelection, tabs = useAppStore.getState().tabs
  const choices = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-source-choices button')]
  expect(choices).toHaveLength(2); await act(async () => choices[1]!.click())
  expect(dom.container.querySelector('.note-surface > .note-knowledge-notice')?.textContent).toContain('no longer confirmed')
  expect(useAppStore.getState().surveyZoneSelection).toBe(selection); expect(useAppStore.getState().tabs).toBe(tabs)
  expect(useAppStore.getState().documentRevealTargets[sourceKey]).toBeUndefined()
  expect(readNoteDocument(useAppStore.getState().documents[referenceKey]!.content)).toEqual({ status: 'valid', note: reference })
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})
it('checks its real directory only on explicit refresh and leaves closed Note sources unread without adding Tabs', async () => {
  vi.mocked(api.files.readDirectory).mockResolvedValue([
    { name: sourceRegion.path, path: sourceRegion.path, isDirectory: false, isSymlink: false },
    { name: referring.path, path: referring.path, isDirectory: false, isSymlink: false },
    { name: 'closed-source.note.json', path: 'closed-source.note.json', isDirectory: false, isSymlink: false }
  ])
  await mount(); expect(api.files.readDirectory).not.toHaveBeenCalled()
  const before = useAppStore.getState(), tabs = before.tabs, layouts = before.layouts, document = before.documents[sourceKey]
  await click('Refresh directory')
  expect(api.files.readDirectory).toHaveBeenCalledExactlyOnceWith('workspace', '')
  expect(dom.container.querySelector('.note-directory-sources')?.textContent).toContain('2 confirmed in this directory · partial')
  expect(dom.container.querySelector('.note-directory-sources')?.textContent).toContain('Not yet readclosed-source.note.json')
  expect(dom.container.querySelector('.note-backlinks')?.textContent).toContain('Partial scope')
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().layouts).toBe(layouts)
  expect(useAppStore.getState().documents[sourceKey]).toBe(document)
  expect(useAppStore.getState().documents[documentKey('workspace', 'closed-source.note.json')]).toBeUndefined()
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})
it('retains a directory failure beside the original dirty Note without retrying, clearing it, or claiming complete knowledge', async () => {
  await mount(); await act(async () => editor().commands.insertContentAt(1, 'My draft '))
  const document = useAppStore.getState().documents[sourceKey]!, selection = useAppStore.getState().surveyZoneSelection
  await click('Refresh directory')
  expect(dom.container.querySelector('.note-directory-sources')?.textContent).toContain('Directory unconfirmed')
  expect(dom.container.querySelector('.note-surface > [role="status"]')?.textContent).toContain('Render must not discover directories')
  expect(useAppStore.getState().documents[sourceKey]).toBe(document); expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(true)
  expect(useAppStore.getState().surveyZoneSelection).toBe(selection)
  expect(api.files.readDirectory).toHaveBeenCalledTimes(1); expect(api.files.write).not.toHaveBeenCalled()
})
it('persists an actual newly split block after the original canonical update without resetting the typing caret', async () => {
  await mount()
  await act(async () => { editor().view.focus(); editor().commands.setTextSelection(editor().state.doc.content.size - 1) })
  await act(async () => editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  await act(async () => editor().commands.insertContent('Second finding'))
  const state = useAppStore.getState(), read = readNoteDocument(state.documents[sourceKey]!.content)
  expect(read.status).toBe('valid')
  if (read.status !== 'valid') throw new Error(read.message)
  expect(read.note.content.content).toHaveLength(2)
  const second = read.note.content.content![1]!, secondId = second.attrs!.blockId
  expect(secondId).not.toBe('source-block'); expect(second.content).toEqual([{ type: 'text', text: 'Second finding' }])
  expect(state.noteBlockSelections[noteBlockSelectionKey(display())]).toEqual({ noteId: 'source-note', blockId: secondId })
  expect(editor().state.selection.$from.parent.attrs.blockId).toBe(secondId)
  expect(editor().state.selection.$from.parentOffset).toBe('Second finding'.length)
  expect(state.dirtyDocuments[sourceKey]).toBe(true); expect(api.files.write).not.toHaveBeenCalled()
})
it('restores a nonfirst semantic block without taking DOM focus or changing the original draft', async () => {
  const note = { ...source, content: { type: 'doc', content: [...source.content.content!, { type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'Unsaved second finding' }] }] } }
  const target = { noteId: source.noteId, blockId: 'second-block' }, key = noteBlockSelectionKey(display())
  useAppStore.setState(state => ({ documents: { ...state.documents, [sourceKey]: { ...state.documents[sourceKey]!, content: JSON.stringify(note) } }, dirtyDocuments: { [sourceKey]: true }, noteBlockSelections: { [key]: target } }))
  const originalDocument = useAppStore.getState().documents[sourceKey], otherInput = document.createElement('input')
  document.body.append(otherInput); otherInput.focus()
  await mount()
  expect(editor().state.selection.$from.parent.attrs.blockId).toBe('second-block')
  expect(document.activeElement).toBe(otherInput)
  expect(useAppStore.getState().noteBlockSelections[key]).toBe(target)
  expect(useAppStore.getState().documents[sourceKey]).toBe(originalDocument)
  expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(true); expect(api.files.write).not.toHaveBeenCalled()
  otherInput.remove()
})
it('preserves an unknown restored block beside editing and never replaces it with the first block', async () => {
  const key = noteBlockSelectionKey(display()), target = { noteId: source.noteId, blockId: 'unconfirmed-block' }
  useAppStore.setState({ noteBlockSelections: { [key]: target } })
  await mount()
  expect(dom.container.textContent).toContain('saved block selection is not confirmed')
  expect(useAppStore.getState().noteBlockSelections[key]).toBe(target)
  expect(editor().view.hasFocus()).toBe(false)
  await act(async () => { editor().view.focus(); editor().commands.setTextSelection(2) })
  expect(useAppStore.getState().noteBlockSelections[key]).toEqual({ noteId: source.noteId, blockId: 'source-block' })
  expect(dom.container.textContent).not.toContain('saved block selection is not confirmed')
})
it('restores an atomic reference as a real NodeSelection without taking DOM focus or changing its canonical Note', async () => {
  const target = { noteId: reference.noteId, blockId: 'referring-block' }, key = noteBlockSelectionKey(display(referring, referringTab.id))
  useAppStore.setState({ noteBlockSelections: { [key]: target } })
  const originalDocument = useAppStore.getState().documents[referenceKey], otherInput = document.createElement('input')
  document.body.append(otherInput); otherInput.focus()
  await mount(referring, referringTab.id)
  expect(editor().state.selection.toJSON()).toEqual({ type: 'node', anchor: 0 })
  expect(document.activeElement).toBe(otherInput)
  expect(useAppStore.getState().documents[referenceKey]).toBe(originalDocument)
  expect(useAppStore.getState().noteBlockSelections[key]).toBe(target)
  expect(useAppStore.getState().dirtyDocuments[referenceKey]).toBeUndefined(); expect(api.files.write).not.toHaveBeenCalled()
  otherInput.remove()
})
it('continues editing with a persistent selection-recovery notice when the exact display is unconfirmed', async () => {
  await mount(sourceRegion, mixed.id, false)
  expect(dom.container.textContent).toContain('Block selection recovery is unconfirmed')
  await act(async () => { editor().view.focus(); editor().commands.insertContentAt(1, 'Preserved ') })
  expect(useAppStore.getState().dirtyDocuments[sourceKey]).toBe(true)
  expect(useAppStore.getState().noteBlockSelections).toEqual({})
  expect(dom.container.textContent).toContain('Block selection recovery is unconfirmed')
})
it('honors a current explicit Region caret request while retaining an unknown saved block and its notice', async () => {
  const key = noteBlockSelectionKey(display()), target = { noteId: source.noteId, blockId: 'unconfirmed-block' }
  const originalBounds = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('note-block-content') ? new DOMRect(0, 0, 400, 300) : originalBounds.call(this)
  })
  useAppStore.setState({ noteBlockSelections: { [key]: target }, regionCaretFocus: { regionId: sourceRegion.regionId, nonce: 99 } })
  const originalDocument = useAppStore.getState().documents[sourceKey]
  await mount()
  expect(document.activeElement).toBe(editor().view.dom)
  expect(useAppStore.getState().regionCaretFocus).toBeNull()
  expect(useAppStore.getState().noteBlockSelections[key]).toBe(target)
  expect(dom.container.textContent).toContain('saved block selection is not confirmed')
  expect(useAppStore.getState().documents[sourceKey]).toBe(originalDocument)
  expect(api.files.write).not.toHaveBeenCalled()
})
it('opens an explicitly chosen unread directory source through the original File owner in the current Zone', async () => {
  const path = 'closed-source.note.json', note = newNoteDocument('Previously unread source', 'closed-note', 'closed-block')
  vi.mocked(api.files.readDirectory).mockResolvedValue([{ name: sourceRegion.path, path: sourceRegion.path, isDirectory: false, isSymlink: false }, { name: path, path, isDirectory: false, isSymlink: false }])
  vi.mocked(api.files.read).mockResolvedValue({ status: 'read', document: { path, content: JSON.stringify(note), revision: 'closed-revision' } })
  await mount(); await click('Refresh directory')
  expect(api.files.read).not.toHaveBeenCalled(); expect(useAppStore.getState().tabs[fileTabId('workspace', path)]).toBeUndefined()
  const open = dom.container.querySelector<HTMLButtonElement>(`button[aria-label="Open Note source workspace · ${path}"]`)
  expect(open).not.toBeNull(); await act(async () => open!.click())
  expect(api.files.read).toHaveBeenCalledExactlyOnceWith('workspace', path)
  expect(useAppStore.getState().tabs[fileTabId('workspace', path)]?.space).toEqual(mixed.space)
  expect(useAppStore.getState().documents[documentKey('workspace', path)]?.content).toBe(JSON.stringify(note))
  expect(useAppStore.getState().mainSurface).toBe('survey')
  expect(api.files.write).not.toHaveBeenCalled()
})
