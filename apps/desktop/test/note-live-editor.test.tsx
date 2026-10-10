import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Editor as TiptapEditor, type Editor } from '@tiptap/core'
import { NoteBlockEditor, noteEditorExtensions } from '../src/renderer/src/components/NoteBlockEditor'
import { newNoteDocument, readNoteDocument, serializeNoteDocument, type NoteDocument } from '../src/shared/note-document'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'
import { api } from '../src/renderer/src/lib/api'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { NoteSnapshotSync } from '@agentmux/client-ui/note/note-snapshot-sync'

vi.mock('../src/renderer/src/components/ReadonlyDiffEditor', () => ({ ReadonlyDiffEditor: ({ original, modified }: { original: string; modified: string }) => <div data-testid="readonly-draft-diff"><pre>{original}</pre><pre>{modified}</pre></div> }))

let host: HTMLDivElement, root: Root
const knowledge = noteKnowledge([])
const paragraph = (text: string, blockId: string) => ({ type: 'paragraph', attrs: { blockId }, content: [{ type: 'text', text }] })
function note(...content: any[]): NoteDocument { return { ...newNoteDocument('', 'live-note', 'unused'), content: { type: 'doc', content } } }
const changed = vi.fn(), issue = vi.fn(), composition = vi.fn()
function View({ value, change = changed, composing = composition }: { value: NoteDocument; change?: (raw: string) => void; composing?: (active: boolean) => void }) {
  return <NoteBlockEditor note={value} knowledge={knowledge} onChange={change} onIssue={issue} onOpen={() => {}} onSave={() => {}} onCompositionChange={composing} />
}
async function render(value: NoteDocument, change = changed, composing = composition) { await act(async () => root.render(<View value={value} change={change} composing={composing} />)) }
function editor(): Editor { return host.querySelector<HTMLElement & { editor: Editor }>('.note-block-content')!.editor }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  useNotebookLibrary.setState({ state: null, issue: null })
  vi.spyOn(api.notebooks, 'resolve').mockImplementation(() => new Promise(() => {}))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  changed.mockClear(); issue.mockClear(); composition.mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

it('keeps the mounted editor, caret and local undo when remote edits arrive on both sides', async () => {
  await render(note(paragraph('left', 'a'), paragraph('human', 'b'), paragraph('right', 'c')))
  const original = editor()
  await act(async () => { original.view.focus(); original.commands.setTextSelection(12); original.commands.insertContent(' local') })
  const calls = changed.mock.calls.length, caret = original.state.selection.from
  await render(note(paragraph('remote left', 'a'), paragraph('human local', 'b'), paragraph('remote right', 'c')))
  expect(editor()).toBe(original)
  expect(original.state.selection.from).toBe(caret + 7)
  expect(changed).toHaveBeenCalledTimes(calls)
  expect(issue.mock.calls.filter(([message]) => message)).toEqual([])
  await act(async () => original.commands.undo())
  expect(original.getText()).toBe('remote left\n\nhuman\n\nremote right')
  await act(async () => original.commands.redo())
  expect(original.getText()).toBe('remote left\n\nhuman local\n\nremote right')
})

it('publishes final Chinese composition before releasing the pending remote owner and never replaces an active IME DOM', async () => {
  const order: string[] = [], originalNote = note(paragraph('start ', 'a'))
  let last: NoteDocument = originalNote
  const change = vi.fn((raw: string, _before?: string) => { order.push('change'); const read = readNoteDocument(raw); if (read.status === 'valid') last = read.note })
  const composing = vi.fn((active: boolean) => order.push(active ? 'start' : 'end'))
  await render(originalNote, change, composing)
  const original = editor(), dom = original.view.dom
  await act(async () => {
    original.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    original.view.dispatch(original.state.tr.insertText('知识', 7))
  })
  expect(original.view.composing).toBe(true)
  await render(note(paragraph('remote start ', 'a')), change, composing)
  expect(editor()).toBe(original); expect(original.view.dom).toBe(dom)
  expect(original.getText()).toBe('start 知识')
  expect(change).not.toHaveBeenCalled()
  await act(async () => original.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '知识' })))
  await vi.waitFor(() => expect(order).toEqual(['start', 'change', 'end']))
  expect(issue.mock.calls.filter(([message]) => message)).toEqual([])
  expect(last.content.content![0]!.content).toEqual([{ type: 'text', text: 'start 知识' }])
  const beforeComposition = readNoteDocument(change.mock.calls[0]![1]!)
  expect(beforeComposition.status).toBe('valid')
  if (beforeComposition.status === 'valid') expect(beforeComposition.note.content.content![0]!.content).toEqual([{ type: 'text', text: 'start ' }])
  // The original owner recomputes the confirmed merged target after receiving the local draft.
  await render(note(paragraph('remote start 知识', 'a')), change, composing)
  expect(original.getText()).toBe('remote start 知识')
  expect(original.view.dom).toBe(dom)
})

it('clears an unmounted composition signal without publishing intermediate input', async () => {
  await render(note(paragraph('human', 'a')))
  await act(async () => {
    editor().view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    editor().view.dispatch(editor().state.tr.insertText('未完成', 1))
  })
  await act(async () => root.render(null))
  expect(composition.mock.calls).toEqual([[true], [false]])
  expect(changed).not.toHaveBeenCalled()
})

it('refuses a late worker response after newer human input, then maps only the newly confirmed target', async () => {
  const requests: { worker: NoteSnapshotTestWorker; request: any }[] = []
  class HeldWorker extends NoteSnapshotTestWorker {
    override postMessage(request: any) { requests.push({ worker: this, request }) }
  }
  vi.stubGlobal('Worker', HeldWorker)
  await render(note(paragraph('human', 'a')))
  const original = editor()
  await render(note(paragraph('remote human', 'a')))
  expect(requests).toHaveLength(1)
  await act(async () => original.commands.insertContentAt(6, ' local'))
  const before = original.getJSON()
  expect(readNoteDocument(changed.mock.calls.at(-1)![1]).status).toBe('valid')
  const editorBefore = readNoteDocument(changed.mock.calls.at(-1)![1])
  if (editorBefore.status === 'valid') expect(editorBefore.note.content.content![0]!.content![0]!.text).toBe('human')
  await act(async () => original.commands.insertContentAt(12, ' more'))
  const nextBefore = readNoteDocument(changed.mock.calls.at(-1)![1])
  if (nextBefore.status === 'valid') expect(nextBefore.note.content.content![0]!.content![0]!.text).toBe('human local')
  // Even a worker host that delivers a result after termination cannot overwrite the newer draft.
  const { computeNoteSnapshot } = await import('@agentmux/client-ui/note/note-snapshot.worker')
  await act(async () => requests[0]!.worker.onmessage?.({ data: computeNoteSnapshot(requests[0]!.request) } as MessageEvent))
  expect(original.getJSON()).not.toEqual(before)
  expect(original.getText()).toBe('human local more')
  await render(note(paragraph('remote human local more', 'a')))
  expect(requests).toHaveLength(2)
  await act(async () => requests[1]!.worker.onmessage?.({ data: computeNoteSnapshot(requests[1]!.request) } as MessageEvent))
  expect(original.getText()).toBe('remote human local more')
  expect(issue.mock.calls.filter(([message]) => message)).toEqual([])
})

it('keeps input and exposes worker failure or invalid steps while retaining a target that can be retried', async () => {
  const released = vi.fn()
  class FailedWorker extends NoteSnapshotTestWorker {
    override terminate() { released(); super.terminate() }
    override postMessage() { queueMicrotask(() => this.onerror?.({ message: 'worker unavailable' } as ErrorEvent)) }
  }
  await render(note(paragraph('human', 'a')))
  const original = editor()
  vi.stubGlobal('Worker', FailedWorker)
  const target = note(paragraph('remote human', 'a'))
  await render(target)
  expect(original.getText()).toBe('human')
  expect(issue).toHaveBeenLastCalledWith(expect.stringContaining('worker unavailable'))
  expect(released).toHaveBeenCalledTimes(1)
  class InvalidWorker extends NoteSnapshotTestWorker {
    override postMessage(request: any) { queueMicrotask(() => this.onmessage?.({ data: { generation: request.generation, status: 'ready', steps: [] } } as MessageEvent)) }
  }
  vi.stubGlobal('Worker', InvalidWorker)
  await render(structuredClone(target))
  expect(original.getText()).toBe('human')
  expect(issue).toHaveBeenLastCalledWith(expect.stringContaining('mapped document differs'))
  vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry incoming update')!.click())
  expect(original.getText()).toBe('remote human')
  expect(editor()).toBe(original)
  expect(issue).toHaveBeenLastCalledWith(null)
})

it('keeps selection inside an editable wiki through remote marks, emoji and nested block changes', async () => {
  const { noteInlineLinkContent } = await import('@agentmux/client-ui/note/note-wikilinks')
  const wiki = noteInlineLinkContent({ referenceId: 'link', text: 'Target', target: { noteId: 'target' } })
  const initial = note({ ...paragraph('', 'p'), content: [{ type: 'text', text: 'before ' }, wiki, { type: 'text', text: ' after' }] })
  await render(initial)
  const original = editor()
  await act(async () => { original.view.focus(); original.commands.setTextSelection(14) })
  const target = note({ ...paragraph('', 'p'), content: [{ type: 'text', text: '🧠 before ', marks: [{ type: 'bold' }] }, wiki, { type: 'text', text: ' after remote' }] }, { type: 'bulletList', content: [{ type: 'listItem', attrs: { blockId: 'item' }, content: [paragraph('new item', 'nested')] }] })
  await render(target)
  expect(editor()).toBe(original)
  expect(original.state.selection.$from.parent.type.name).toBe('noteLink')
  expect(original.state.selection.from).toBe(17)
  expect(original.state.doc.firstChild!.firstChild!.marks[0]!.type.name).toBe('bold')
  expect(changed).not.toHaveBeenCalled()
})

it('reconnects a StrictMode view and continues mapping updates through the hook-owned Editor', async () => {
  const value = note(paragraph('human', 'a'))
  await act(async () => root.render(<StrictMode><View value={value} /></StrictMode>))
  const original = editor()
  await act(async () => { original.commands.insertContentAt(6, ' local') })
  await act(async () => root.render(<StrictMode><View value={note(paragraph('remote human local', 'a'))} /></StrictMode>))
  expect(editor()).toBe(original)
  expect(original.getText()).toBe('remote human local')
  await act(async () => original.commands.undo())
  expect(original.getText()).toBe('remote human')
  expect(issue.mock.calls.filter(([message]) => message)).toEqual([])
})

it('retains the latest target while a PM view is temporarily unmounted and resumes on that same Editor', async () => {
  const element = document.createElement('div'); host.append(element)
  const original = new TiptapEditor({ element, extensions: noteEditorExtensions(), content: note(paragraph('human', 'a')).content })
  const sync = new NoteSnapshotSync(original, () => false, issue)
  try {
    original.commands.insertContentAt(6, ' local')
    original.unmount()
    expect(original.isDestroyed).toBe(true)
    sync.update(note(paragraph('remote human local', 'a')).content)
    await act(async () => original.mount(element))
    expect(original.getText()).toBe('remote human local')
    original.commands.undo()
    expect(original.getText()).toBe('remote human')
    expect(issue.mock.calls.filter(([message]) => message)).toEqual([])
  } finally { sync.destroy(); original.destroy(); element.remove() }
})

it('can reconnect an effect holding a fully destroyed old Editor without reading its nulled schema', async () => {
  await render(note(paragraph('human', 'a')))
  const original = editor()
  await act(async () => original.destroy())
  expect(original.schema).toBeNull()
  let sync: NoteSnapshotSync | undefined
  expect(() => { sync = new NoteSnapshotSync(original, () => false, issue); sync.update(note(paragraph('remote', 'a')).content) }).not.toThrow()
  sync!.destroy()
  expect(issue.mock.calls.filter(([message]) => message)).toEqual([])
})

it('keeps both actual drafts for a moved block and compares or explicitly keeps the displayed draft without replacing its Editor or undo', async () => {
  const retained = vi.fn(), kept = vi.fn()
  const view = (value: NoteDocument) => <NoteBlockEditor note={value} knowledge={knowledge} onChange={changed} onIssue={issue} onOpen={() => {}} onSave={() => {}} onSnapshotIssue={retained} onKeepDisplayedDraft={kept} />
  await act(async () => root.render(view(note(paragraph('human', 'a'), paragraph('keep', 'b')))))
  const original = editor()
  await act(async () => { original.commands.setTextSelection(6); original.commands.insertContent('++') })
  const caret = original.state.selection.from
  const incoming = note(paragraph('keep', 'b'), paragraph('human++', 'a'))
  await act(async () => root.render(view(incoming)))
  expect(retained).toHaveBeenCalledTimes(1)
  const [displayedRaw, incomingRaw, reason] = retained.mock.calls[0]!
  expect(reason).toContain('moved')
  expect(readNoteDocument(displayedRaw).status).toBe('valid')
  expect(readNoteDocument(incomingRaw).status).toBe('valid')
  expect(original.getText()).toBe('human++\n\nkeep')
  expect(original.state.selection.from).toBe(caret)
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry incoming update')!.click())
  expect(retained).toHaveBeenCalledTimes(2)
  expect(host.querySelector('[aria-label="Incoming update recovery"]')?.textContent).toContain('Keep editing displayed draft')
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Compare incoming update')!.click())
  expect(host.querySelector('[data-testid="readonly-draft-diff"]')).not.toBeNull()
  expect(editor()).toBe(original)
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Keep editing displayed draft')!.click())
  expect(kept).toHaveBeenLastCalledWith(displayedRaw, incomingRaw)
  const chosen = readNoteDocument(kept.mock.calls[0]![0])
  if (chosen.status !== 'valid') throw new Error('chosen draft invalid')
  await act(async () => root.render(view(chosen.note)))
  expect(editor()).toBe(original)
  expect(host.querySelector('[aria-label="Incoming update recovery"]')).toBeNull()
  await act(async () => original.commands.undo())
  expect(original.getText()).toBe('human\n\nkeep')
  await act(async () => original.commands.redo())
  expect(original.getText()).toBe('human++\n\nkeep')
})

it('forwards the exact current Markdown source through NoteFileView rather than pretending its canonical whitespace is the original file', async () => {
  const retained = vi.fn(), kept = vi.fn()
  const view = (content: string) => <NoteFileView document={{ path: 'original.note.md', content, revision: 'observed-revision' }} knowledge={knowledge} onChange={changed} onSave={() => {}} onOpen={() => {}} onSnapshotIssue={retained} onKeepDisplayedDraft={kept} />
  await act(async () => root.render(view(serializeNoteDocument(note(paragraph('human', 'a'), paragraph('keep', 'b'))))))
  const original = editor()
  await act(async () => original.commands.insertContentAt(6, '++'))
  const incoming = serializeNoteDocument(note(paragraph('keep', 'b'), paragraph('human++', 'a'))).replaceAll('\n', '\r\n')
  await act(async () => root.render(view(incoming)))
  expect(retained).toHaveBeenCalledTimes(1)
  expect(retained.mock.calls[0]![1]).toBe(incoming)
  expect(retained.mock.calls[0]![0]).toContain('human++')
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Keep editing displayed draft')!.click())
  expect(kept).toHaveBeenCalledWith(retained.mock.calls[0]![0], incoming)
  expect(editor()).toBe(original)
})
