// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor, JSONContent } from '@tiptap/core'
import { closeHistory } from '../src/shared/note-content-schema'
import { NoteFileContext } from '@agentmux/client-ui/components/NoteFileContext'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NoteSharedFileEditing } from '../src/renderer/src/components/NoteSharedFileEditing'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM(), knowledge = noteKnowledge([])
afterEach(async () => { await dom.render(null); vi.unstubAllGlobals() })
const paragraph = (id: string, text: string): JSONContent => ({ type: 'paragraph', attrs: { blockId: id }, content: [{ type: 'text', text }] })
function list(type: 'taskList' | 'bulletList' | 'orderedList', prefix = ''): JSONContent {
  const item = type === 'taskList' ? 'taskItem' : 'listItem'
  const provenance = { created: { actor: { kind: 'agent', id: 'original-author' }, at: 1 }, lastEdited: null }
  return { type, content: [false, true].map((checked, index) => ({ type: item, attrs: { blockId: prefix + 'item-' + index, provenance, ...(item === 'taskItem' ? { checked } : {}) }, content: [paragraph(prefix + 'text-' + index, index ? 'Second original' : 'First original')] })) }
}
function original(content: JSONContent[], id = 'tools-note') {
  return { ...newNoteDocument('', id, 'empty'), content: { type: 'doc', content } }
}
function snapshot(editor: Editor): JSONContent { return editor.getJSON() }
function button(label: string, index = 0) { return dom.container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)[index]! }
async function selectText(editor: Editor, text: string) {
  let at = -1
  editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === text) at = pos })
  expect(at).toBeGreaterThanOrEqual(0)
  await act(async () => { editor.commands.setTextSelection(at + 1); editor.view.focus() })
}
async function click(label: string, index = 0) {
  expect(button(label, index)).not.toBeNull()
  expect(button(label, index).disabled).toBe(false)
  await act(async () => button(label, index).click())
}
function roundtrip(editor: Editor) {
  const source = serializeNoteDocument(original(snapshot(editor).content!)), parsed = readNoteDocument(source)
  expect(parsed.status).toBe('valid')
  if (parsed.status !== 'valid') throw Error(parsed.message)
  expect(serializeNoteDocument(parsed.note)).toBe(source)
  return source
}
async function setup(content: JSONContent[]) {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const change = vi.fn(), save = vi.fn(), issue = vi.fn()
  await dom.render(<NoteBlockEditor note={original(content)} knowledge={knowledge} onChange={change} onSave={save} onIssue={issue} onOpen={() => {}} />)
  return { editor: (dom.container.querySelector('.note-block-content') as HTMLElement & { editor: Editor }).editor, change, save, issue }
}

it.each(['taskList', 'bulletList', 'orderedList'] as const)('indents and outdents the real %s item with original identities, checked state, undo and explicit save', async type => {
  const { editor, save, change, issue } = await setup([list(type), paragraph('outside', 'Outside prose')])
  await selectText(editor, 'Second original')
  const before = snapshot(editor), second = before.content![0]!.content![1]!
  await click('Indent block')
  const nested = snapshot(editor).content![0]!
  expect(nested.content).toHaveLength(1)
  expect(nested.content![0]!.content![1]).toMatchObject({ type, content: [second] })
  expect(snapshot(editor).content![1]).toEqual(before.content![1])
  const source = roundtrip(editor)
  if (type === 'taskList') expect(source).toContain('- [x]')
  expect(source).toContain('item%2D1'); expect(source).toContain('text%2D1')
  await act(async () => editor.view.dispatch(closeHistory(editor.state.tr)))
  await click('Outdent block')
  expect(snapshot(editor)).toEqual(before)
  await act(async () => editor.commands.undo())
  expect(snapshot(editor).content![0]!.content).toHaveLength(1)
  await act(async () => editor.commands.undo())
  expect(snapshot(editor)).toEqual(before)
  expect(change).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalledWith(expect.any(String))
})

it('uses the nearest ordinary item inside a task instead of choosing its task ancestor', async () => {
  const task = list('taskList')
  const ordinary = list('bulletList', 'nested-')
  ordinary.content![1]!.content![0]!.content![0]!.text = 'Nested ordinary second'
  task.content![0]!.content!.push(ordinary)
  const { editor, save } = await setup([task, paragraph('outside', 'Outside prose')])
  await selectText(editor, 'Nested ordinary second')
  const before = snapshot(editor)
  await click('Indent block')
  expect(snapshot(editor).content![0]!.content).toHaveLength(2)
  const nestedOrdinary = snapshot(editor).content![0]!.content![0]!.content![1]!
  expect(nestedOrdinary.content).toHaveLength(1)
  expect(nestedOrdinary.content![0]!.content![1]!.type).toBe('bulletList')
  await click('Outdent block')
  expect(snapshot(editor)).toEqual(before); expect(save).not.toHaveBeenCalled()
})

it('routes both host toolbar directions to the actual focused shared original and leaves the host draft untouched', async () => {
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const workspace = composerConfig.workspaces[0]!, host = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: 'host.note.md', noteId: 'host-note' }
  const shared = { ...host, path: 'original.note.md', noteId: 'shared-note' }, hostChange = vi.fn(), sharedChange = vi.fn(), save = vi.fn()
  await dom.render(<NoteSharedFileEditing target={host} active hasIncludes={false} occurrence="list-tools-originals" knowledge={knowledge} onOpen={() => {}}>
    <NoteBlockEditor note={original([list('bulletList')], host.noteId)} knowledge={knowledge} onChange={hostChange} onSave={save} onIssue={() => {}} onOpen={() => {}} />
    <NoteFileContext.Provider value={shared}><NoteBlockEditor note={original([list('taskList')], shared.noteId)} knowledge={knowledge} onChange={sharedChange} onSave={save} onIssue={() => {}} onOpen={() => {}} /></NoteFileContext.Provider>
  </NoteSharedFileEditing>)
  const [hostEditor, sharedEditor] = [...dom.container.querySelectorAll<HTMLElement>('.note-block-content')].map(node => (node as HTMLElement & { editor: Editor }).editor)
  await selectText(sharedEditor!, 'Second original')
  const hostBefore = snapshot(hostEditor!), sharedBefore = snapshot(sharedEditor!)
  await click('Indent block')
  expect(snapshot(sharedEditor!).content![0]!.content).toHaveLength(1)
  expect(snapshot(sharedEditor!).content![0]!.content![0]!.content![1]!.content![0]).toEqual(sharedBefore.content![0]!.content![1])
  expect(snapshot(hostEditor!)).toEqual(hostBefore); expect(hostChange).not.toHaveBeenCalled()
  await click('Outdent block')
  expect(snapshot(sharedEditor!)).toEqual(sharedBefore); expect(snapshot(hostEditor!)).toEqual(hostBefore)
  await act(async () => sharedEditor!.commands.undo())
  expect(snapshot(sharedEditor!)).toEqual(sharedBefore)
  expect(sharedChange).toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
})
