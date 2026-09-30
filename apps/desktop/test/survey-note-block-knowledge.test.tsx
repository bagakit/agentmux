// @vitest-environment happy-dom
import { act, createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTE_SCHEMA, newNoteDocument, readNoteDocument, type NoteDocument } from '../src/shared/note-document'
import type { FileDocument } from '../src/shared/contracts'
import { NoteBlockEditor, type NoteEditorHandle } from '../src/renderer/src/components/NoteBlockEditor'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { noteKnowledge, noteBacklinks, resolveNoteBlock } from '../src/renderer/src/lib/note-knowledge'

const source: NoteDocument = { schema: NOTE_SCHEMA, noteId: 'source-note', content: { type: 'doc', content: [
  { type: 'paragraph', attrs: { blockId: 'source-block' }, content: [{ type: 'text', text: 'Original finding' }] }
] } }
const related: NoteDocument = { schema: NOTE_SCHEMA, noteId: 'related-note', content: { type: 'doc', content: [
  { type: 'blockReference', attrs: { blockId: 'related-block', referenceId: 'reference-one', target: { noteId: source.noteId, blockId: 'source-block' }, mode: 'embed' } }
] } }
const file = (note: NoteDocument, path = `${note.noteId}.note.json`): FileDocument => ({ path, content: JSON.stringify(note), revision: 'original-revision' })
const input = (document: FileDocument, workspaceId = 'original-resource') => ({ location: { workspaceId, path: document.path }, document })
let host: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
async function render(element: React.ReactNode) { await act(async () => root.render(element)) }
function editorAt(index = 0): Editor {
  const editors = host.querySelectorAll<HTMLElement & { editor: Editor }>('.note-block-content')
  expect(editors.length).toBeGreaterThan(index)
  expect(editors[index]!.editor).toBeDefined()
  return editors[index]!.editor
}
async function mount(note = source) {
  const changes = vi.fn(), issue = vi.fn(), open = vi.fn(), save = vi.fn()
  await render(<NoteBlockEditor note={note} knowledge={noteKnowledge([input(file(note))])} onChange={changes} onOpen={open} onSave={save} onIssue={issue} />)
  return { editor: editorAt(), changes, issue, open, save }
}
function semanticIds(editor: Editor) {
  const ids: string[] = []
  editor.state.doc.descendants(node => { if (node.attrs.blockId) ids.push(node.attrs.blockId) })
  return ids
}
async function enter(editor: Editor, pos: number) {
  await act(async () => {
    editor.commands.setTextSelection(pos)
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
  })
}

describe('actual rich Note identity and controlled content', () => {
  it.each([1, 5, 17])('splits with actual Enter at %i, keeps the original ID and restores exact undo/redo identities', async pos => {
    const { editor, changes } = await mount()
    expect(semanticIds(editor)).toEqual(['source-block'])
    expect(changes).not.toHaveBeenCalled()
    await enter(editor, pos)
    const splitIds = semanticIds(editor), split = editor.getJSON()
    expect(splitIds).toHaveLength(2)
    expect(new Set(splitIds).size).toBe(2)
    expect(splitIds).toContain('source-block')
    expect(changes).toHaveBeenCalled()
    expect(readNoteDocument(changes.mock.lastCall![0]).status).toBe('valid')
    await act(async () => { expect(editor.commands.undo()).toBe(true) })
    expect(editor.getJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'source-block' }, content: [{ type: 'text', text: 'Original finding' }] }] })
    await act(async () => { expect(editor.commands.redo()).toBe(true) })
    expect(editor.getJSON()).toEqual(split)
    expect(semanticIds(editor)).toEqual(splitIds)
  })
  it('keeps Shift Enter within the original block and saves only through the supplied owner', async () => {
    const { editor, changes, save } = await mount()
    await act(async () => {
      editor.commands.setTextSelection(5)
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, keyCode: 13, bubbles: true, cancelable: true }))
    })
    expect(semanticIds(editor)).toEqual(['source-block'])
    expect(editor.getJSON().content![0]!.content!.map(node => node.type)).toEqual(['text', 'hardBreak', 'text'])
    expect(readNoteDocument(changes.mock.lastCall![0]).status).toBe('valid')
    await act(async () => editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('uses mature nested list transactions and folds a view without modifying the document or selection', async () => {
    const nested: NoteDocument = { schema: NOTE_SCHEMA, noteId: 'list-note', content: { type: 'doc', content: [{ type: 'bulletList', content: [
      { type: 'listItem', attrs: { blockId: 'first-item' }, content: [{ type: 'paragraph', attrs: { blockId: 'first' }, content: [{ type: 'text', text: 'First' }] }] },
      { type: 'listItem', attrs: { blockId: 'second-item' }, content: [{ type: 'paragraph', attrs: { blockId: 'second' }, content: [{ type: 'text', text: 'Second' }] }] }
    ] }] } }
    const { editor, changes } = await mount(nested)
    await act(async () => {
      editor.commands.setTextSelection(12)
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true }))
    })
    expect(editor.getJSON().content![0]!.content).toHaveLength(1)
    expect(semanticIds(editor).filter(id => ['first-item', 'first', 'second-item', 'second'].includes(id))).toEqual(['first-item', 'first', 'second-item', 'second'])
    const afterIndent = editor.getJSON(), selection = editor.state.selection.toJSON(), writes = changes.mock.calls.length
    const fold = host.querySelector<HTMLButtonElement>('[aria-label="Fold or unfold nested blocks"]')!
    expect(fold.disabled).toBe(false)
    await act(async () => fold.click())
    expect(host.querySelector('.note-block--folded')).not.toBeNull()
    expect(editor.getJSON()).toEqual(afterIndent)
    expect(editor.state.selection.toJSON()).toEqual(selection)
    expect(changes).toHaveBeenCalledTimes(writes)
    await act(async () => editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true, bubbles: true, cancelable: true })))
    expect(editor.getJSON().content![0]!.content).toHaveLength(2)
    expect(semanticIds(editor)).toContain('second-item')
    expect(semanticIds(editor)).toContain('second')
  })
  it('regenerates both occurrence identities in an actual ordinary paste while preserving its exact target', async () => {
    const { editor, changes, issue } = await mount(related)
    const transfer = new DataTransfer()
    transfer.setData('text/html', editor.getHTML())
    transfer.setData('text/plain', 'Original finding')
    await act(async () => {
      editor.commands.setNodeSelection(0)
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    })
    const nodes: Array<Record<string, unknown>> = []
    editor.state.doc.descendants(node => { if (node.type.name === 'blockReference') nodes.push(node.attrs) })
    expect(nodes).toHaveLength(2)
    expect(nodes[0]!.referenceId).toBe('reference-one')
    expect(nodes[1]!.referenceId).not.toBe('reference-one')
    expect(nodes[1]!.blockId).not.toBe('related-block')
    expect(nodes.map(node => node.target)).toEqual([{ noteId: 'source-note', blockId: 'source-block' }, { noteId: 'source-note', blockId: 'source-block' }])
    expect(issue.mock.calls.filter(([value]) => value !== null)).toEqual([])
    expect(readNoteDocument(changes.mock.lastCall![0]).status).toBe('valid')
  })
  it('never mounts an allocator for malformed source, and preserves its raw body', async () => {
    const document = { path: 'bad.note.json', content: JSON.stringify({ schema: NOTE_SCHEMA, noteId: 'bad', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this raw' }] }] } }), revision: 'raw' }
    const change = vi.fn()
    await render(<NoteFileView document={document} knowledge={noteKnowledge([input(document)])} onChange={change} onSave={() => {}} onOpen={() => {}} />)
    expect(host.querySelector('[contenteditable="true"]')).toBeNull()
    expect(host.textContent).toContain('original source is preserved')
    expect(document.content).toContain('Keep this raw')
    expect(change).not.toHaveBeenCalled()
  })
  it('keeps the original Note and rich input alive for an actual pasted reference with an unconfirmed target', async () => {
    const { editor, changes, issue } = await mount(source), original = JSON.stringify(source)
    const transfer = new DataTransfer()
    transfer.setData('text/html', '<div data-note-block-reference="" data-note-target="broken-json" data-note-reference-mode="reference"></div>')
    transfer.setData('text/plain', 'Unconfirmed reference')
    const pasted = act(async () => {
      editor.view.focus(); editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    })
    await expect(pasted).resolves.toBeUndefined()
    expect(host.querySelector('.note-block-content')).not.toBeNull()
    expect(host.textContent).toContain('pasted reference target is unconfirmed')
    expect(changes).not.toHaveBeenCalled(); expect(issue.mock.lastCall![0]).not.toBeNull()
    expect(JSON.stringify(source)).toBe(original)
    await act(async () => editor.commands.undo())
    expect(editor.getJSON()).toEqual(source.content)
    expect(host.textContent).not.toContain('pasted reference target is unconfirmed')
    await act(async () => editor.commands.insertContent('Continuing '))
    expect(readNoteDocument(changes.mock.lastCall![0]).status).toBe('valid')
    expect(editor.state.doc.textContent).toContain('Continuing ')
    expect(issue.mock.lastCall).toEqual([null])
  })
  it('preserves an unsupported mark field in the raw source without mounting a lossy rich editor', async () => {
    const document = { path: 'unknown-mark.note.json', revision: 'original-revision', content: JSON.stringify({ schema: NOTE_SCHEMA, noteId: 'unknown-mark', content: { type: 'doc', content: [
      { type: 'paragraph', attrs: { blockId: 'preserved-block' }, content: [{ type: 'text', text: 'Preserve this source', marks: [{ type: 'bold', extra: 'Keep this field' }] }] }
    ] } }) }
    const changes = vi.fn(), raw = document.content
    await render(<NoteFileView document={document} knowledge={noteKnowledge([input(document)])} onChange={changes} onSave={() => {}} onOpen={() => {}} />)
    expect(host.querySelector('[contenteditable="true"]')).toBeNull()
    expect(host.textContent).toContain('original source is preserved')
    expect(document.content).toBe(raw); expect(changes).not.toHaveBeenCalled()
  })
  it('does no candidate scan for a closed picker and reuses the open picker results across selection changes', async () => {
    const files = Array.from({ length: 20 }, (_, index) => input(file(newNoteDocument(`Finding ${index}`, `note-${index}`, `block-${index}`))))
    const original = noteKnowledge(files)
    expect(original.sources).toHaveLength(20)
    let reads = 0
    const knowledge = { ...original, sources: original.sources.map(source => ({ ...source, get blocks() { reads++; return source.blocks } })) }
    await render(<NoteBlockEditor note={original.sources[0]!.note} knowledge={knowledge} onChange={() => {}} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />)
    expect(host.querySelector('.note-reference-picker')).toBeNull(); expect(host.querySelector('.note-reference')).toBeNull()
    expect(reads).toBe(0)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click())
    expect(host.querySelectorAll('.note-reference-picker__row')).toHaveLength(20); expect(reads).toBe(20)
    await act(async () => editorAt().commands.setTextSelection(4))
    expect(reads).toBe(20)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded="true"]')!.click())
    await act(async () => editorAt().commands.setTextSelection(2))
    expect(reads).toBe(20)
  })
  it('returns a real focused NodeSelection for an atomic reference and the exact text block for a paragraph', async () => {
    const handle = createRef<NoteEditorHandle | null>(), change = vi.fn()
    const note: NoteDocument = { ...related, content: { type: 'doc', content: [...related.content.content!, ...source.content.content!] } }
    await render(<NoteBlockEditor note={note} knowledge={noteKnowledge([input(file(note)), input(file(source))])} onChange={change} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} handleRef={handle} />)
    expect(handle.current).not.toBeNull()
    await act(async () => { expect(handle.current!.focusBlock('related-block')).toBe(true) })
    expect(editorAt().state.selection.toJSON()).toEqual({ type: 'node', anchor: 0 })
    expect(document.activeElement).toBe(editorAt().view.dom)
    await act(async () => { expect(handle.current!.focusBlock('source-block')).toBe(true) })
    expect(editorAt().state.selection.$from.parent.attrs.blockId).toBe('source-block')
    expect(document.activeElement).toBe(editorAt().view.dom)
    expect(change).not.toHaveBeenCalled()
  })
  it('inserts an explicit typed reference through the actual picker without copying the original body', async () => {
    const draft = newNoteDocument('My interpretation', 'draft-note', 'draft-block'), changes = vi.fn()
    const knowledge = noteKnowledge([input(file(source)), input(file(draft))])
    await render(<NoteBlockEditor note={draft} knowledge={knowledge} onChange={changes} onOpen={() => {}} onSave={() => {}} onIssue={() => {}} />)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click())
    const target = host.querySelector<HTMLButtonElement>('[aria-label="Reference original-resource · source-note.note.json · source-block"]')
    expect(target).not.toBeNull()
    await act(async () => target!.click())
    const read = readNoteDocument(changes.mock.lastCall![0])
    expect(read.status).toBe('valid')
    const references: unknown[] = []
    editorAt().state.doc.descendants(node => { if (node.type.name === 'blockReference') references.push(node.attrs.target) })
    expect(references).toEqual([{ noteId: 'source-note', blockId: 'source-block' }])
    expect(editorAt().state.doc.textContent).not.toContain('Original finding')
    expect(source.content.content![0]!.content).toEqual([{ type: 'text', text: 'Original finding' }])
    expect(host.querySelector('.note-reference__excerpt')!.textContent).toBe('Original finding')
  })
})

describe('derived exact references and actual two Note presentation', () => {
  it('shares a canonical document index across displays and re-derives only a changed original document', () => {
    const original = file(source), relatedFile = file(related)
    const first = noteKnowledge([input(original), input(relatedFile)])
    const second = noteKnowledge([input(original), input(relatedFile)])
    expect(first.sources).toHaveLength(2); expect(second.sources).toHaveLength(2)
    expect(second.sources[0]!.blocks).toBe(first.sources[0]!.blocks)
    expect(second.sources[1]!.blocks).toBe(first.sources[1]!.blocks)
    const next = { ...original, content: JSON.stringify(newNoteDocument('Updated finding', 'source-note', 'source-block')), revision: 'next-revision' }
    const third = noteKnowledge([input(next), input(relatedFile)])
    expect(third.sources[0]!.blocks).not.toBe(first.sources[0]!.blocks)
    expect(third.sources[0]!.blocks.get('source-block')!.text).toBe('Updated finding')
    expect(third.sources[1]!.blocks).toBe(first.sources[1]!.blocks)
  })
  it('deduplicates displays, preserves duplicate identities, and distinguishes unknown scope from a missing block', () => {
    const first = file(source), second = file(related)
    const knowledge = noteKnowledge([input(first), input(first), input(second)])
    expect(knowledge.sources.map(source => source.note.noteId)).toEqual(['source-note', 'related-note'])
    const links = noteBacklinks(knowledge, { noteId: 'source-note', blockId: 'source-block' })
    expect(links.map(link => [link.source.note.noteId, link.blockId, link.referenceId, link.mode])).toEqual([['related-note', 'related-block', 'reference-one', 'embed']])
    expect(noteBacklinks(knowledge, { noteId: 'source-note', blockId: 'other-block' })).toEqual([])
    expect(noteBacklinks(knowledge, { noteId: 'other-note', blockId: 'source-block' })).toEqual([])
    expect(resolveNoteBlock(knowledge, { noteId: 'unread', blockId: 'unread' }).status).toBe('unknown')
    expect(resolveNoteBlock(knowledge, { noteId: 'source-note', blockId: 'deleted' }).status).toBe('missing')
    const duplicate = noteKnowledge([input(first), input(file(source, 'copied.note.json'), 'other-resource')])
    expect(duplicate.sources).toHaveLength(2)
    expect(resolveNoteBlock(duplicate, { noteId: 'source-note', blockId: 'source-block' }).status).toBe('ambiguous')
  })
  it('updates an actual read-only embed from the canonical owner and returns its exact resource and block', async () => {
    const open = vi.fn()
    function TwoNotes() {
      const [original, setOriginal] = useState(file(source)), [other, setOther] = useState(file(related))
      const knowledge = noteKnowledge([input(original), input(other, 'foreign-resource')])
      return <><NoteFileView document={original} knowledge={knowledge} onChange={raw => setOriginal({ ...original, content: raw })} onSave={() => {}} onOpen={open} />
        <NoteFileView document={other} knowledge={knowledge} onChange={raw => setOther({ ...other, content: raw })} onSave={() => {}} onOpen={open} /></>
    }
    await render(<TwoNotes />)
    expect(host.querySelector('.note-embedded-content')!.textContent).toContain('Original finding')
    expect(host.querySelector('.note-embedded-content')!.getAttribute('contenteditable')).toBe('false')
    await act(async () => editorAt().commands.insertContentAt(1, 'Edited '))
    expect(host.querySelector('.note-embedded-content')!.textContent).toContain('Edited Original finding')
    const link = host.querySelector<HTMLButtonElement>('.note-reference__source button')!
    await act(async () => link.click())
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.lastCall![0].location).toEqual({ workspaceId: 'original-resource', path: 'source-note.note.json' })
    expect(open.mock.lastCall![1]).toBe('source-block')
    expect(host.textContent).toContain('Partial scope')
  })
  it('renders a retained circular embed as a persistent notice, without transitive backlinks', async () => {
    const circular: NoteDocument = { schema: NOTE_SCHEMA, noteId: 'cycle', content: { type: 'doc', content: [{ type: 'blockReference', attrs: { blockId: 'self', referenceId: 'self-ref', target: { noteId: 'cycle', blockId: 'self' }, mode: 'embed' } }] } }
    const knowledge = noteKnowledge([input(file(circular))])
    await render(<NoteFileView document={file(circular)} knowledge={knowledge} onChange={() => {}} onSave={() => {}} onOpen={() => {}} />)
    expect(host.textContent).toContain('This reference is circular')
    expect(noteBacklinks(knowledge, { noteId: 'cycle', blockId: 'self' }).map(link => link.referenceId)).toEqual(['self-ref'])
    expect(host.querySelectorAll('.note-reference').length).toBe(2)
  })
})
