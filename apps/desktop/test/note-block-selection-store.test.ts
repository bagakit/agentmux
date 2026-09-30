import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig } from '../src/shared/contracts'
import { newNoteDocument } from '../src/shared/note-document'
import { noteBlockSelectionKey, type NoteBlockPresentation } from '../src/renderer/src/lib/note-block-selection'
import { workbenchHomePresentationReferences } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { restorePersistedUiState, useAppStore } from '../src/renderer/src/store'
const initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [{ id: 'resource', name: 'Resource', hostId: 'local', path: '/resource', kind: 'folder' }, { id: 'display', name: 'Display', hostId: 'local', path: '/display', kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
function seed() {
  const tab = createWorkbenchTab('shared-note', { kind: 'file', regionId: 'same-region', workspaceId: 'resource', path: 'a.note.json' })
  const first = createWorkspaceLayout('first', [tab.id])
  const display = { ...first, root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .5, first: first.root, second: { type: 'leaf' as const, groupId: 'second' } }, groups: [...first.groups, { ...first.groups[0]!, id: 'second' }] }
  const note = newNoteDocument('first', 'original-note', 'first-block')
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'second' }] })
  useAppStore.setState({ config, tabs: { [tab.id]: tab }, layouts: { resource: first, display }, noteBlockSelections: {}, documents: { [documentKey('resource', 'a.note.json')]: { path: 'a.note.json', content: JSON.stringify(note), revision: 'original' } } })
  return tab
}
afterEach(() => useAppStore.setState(initial, true))
describe('original Note presentation selection owner', () => {
  it('keeps the same Note/Region selection independent at two exact display Groups, without writing content', () => {
    const tab = seed(), before = useAppStore.getState()
    const a: NoteBlockPresentation = { tabHostId: 'workbench:shared-note', reference: { displayWorkspaceId: 'display', groupId: 'first', tabId: tab.id, regionId: 'same-region' } }
    const b: NoteBlockPresentation = { ...a, reference: { ...a.reference, groupId: 'second' } }
    expect(noteBlockSelectionKey(a)).not.toBe(noteBlockSelectionKey(b))
    before.setNoteBlockSelection(a, { noteId: 'original-note', blockId: 'first-block' })
    before.setNoteBlockSelection(b, { noteId: 'original-note', blockId: 'second-block' })
    expect(useAppStore.getState().noteBlockSelections).toEqual({ [noteBlockSelectionKey(a)]: { noteId: 'original-note', blockId: 'first-block' }, [noteBlockSelectionKey(b)]: { noteId: 'original-note', blockId: 'second-block' } })
    expect(useAppStore.persist.getOptions().partialize?.(useAppStore.getState()).noteBlockSelections).toEqual(useAppStore.getState().noteBlockSelections)
    expect(useAppStore.getState().documents).toBe(before.documents); expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().layouts).toBe(before.layouts)
    const changed = vi.fn(), unsubscribe = useAppStore.subscribe(changed)
    before.setNoteBlockSelection(b, { noteId: 'original-note', blockId: 'second-block' })
    expect(changed).not.toHaveBeenCalled(); unsubscribe()
  })
  it('does not call an owner-map winner the home of a Tab in two original Groups', () => {
    const tab = seed(), state = useAppStore.getState()
    expect(state.layouts.display!.groups.map(group => group.tabOrder)).toEqual([[tab.id], [tab.id]])
    const references = workbenchHomePresentationReferences(state.layouts.display, 'display', state.tabs)
    expect(references.size).toBe(1); expect(references.get(tab.id)).toBeNull()
    const unique = workbenchHomePresentationReferences(state.layouts.resource, 'resource', state.tabs)
    expect(unique.get(tab.id)).toEqual({ displayWorkspaceId: 'resource', groupId: 'first', tabId: tab.id, regionId: 'same-region' })
  })
  it('retains an exact unknown block through the original UI restore, without replacing it with first', () => {
    const presentation: NoteBlockPresentation = { tabHostId: 'survey-slot', reference: { displayWorkspaceId: 'display', groupId: 'second', tabId: 'still-restoring', regionId: 'still-restoring-region' } }
    const key = noteBlockSelectionKey(presentation), selections = { [key]: { noteId: 'unconfirmed-note', blockId: 'unconfirmed-nonfirst-block' } }
    const restored = restorePersistedUiState(config, { workbenchSpaceSelection: null, noteBlockSelections: selections })
    expect(restored.noteBlockSelections).toEqual(selections)
  })
  it('does not save an unconfirmed occurrence or invent a Note identity from an arbitrary target', () => {
    const tab = seed(), before = useAppStore.getState()
    const presentation: NoteBlockPresentation = { tabHostId: 'survey-slot', reference: { displayWorkspaceId: 'display', groupId: 'missing', tabId: tab.id, regionId: 'same-region' } }
    before.setNoteBlockSelection(presentation, { noteId: 'original-note', blockId: 'second-block' })
    before.setNoteBlockSelection({ ...presentation, reference: { ...presentation.reference, groupId: 'second' } }, { noteId: 'wrong-note', blockId: 'second-block' })
    expect(useAppStore.getState().noteBlockSelections).toEqual({}); expect(useAppStore.getState().documents).toBe(before.documents)
  })
})
