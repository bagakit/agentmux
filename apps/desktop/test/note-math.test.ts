// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { fileUploadRevision } from '@agentmux/core/files'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { noteContentExtensions, noteIdentityExtensions } from '@agentmux/client-ui/note/note-content-schema'
import { noteWikiInputExtension } from '@agentmux/client-ui/note/note-wiki-input'
import { indexNoteReferences, prepareNoteWikiLinks, noteSemanticText } from '@agentmux/client-ui/note/note-wikilinks'
import { noteKnowledge, parseNoteFile } from '@agentmux/client-ui/note/note-knowledge'
import { readNoteDocument, serializeNoteDocument, newNoteDocument, type NoteDocument } from '../src/shared/note-document'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileReadOwner } from '@agentmux/host/file-read-owner'

const header = '---\nschema: agentmux.note.md.v1\nnote-id: math-note\n---\n\n'
function read(body: string): NoteDocument {
  const result = readNoteDocument(header + body)
  expect(result.status, result.status === 'invalid' ? result.message : '').toBe('valid')
  if (result.status !== 'valid') throw new Error(result.message)
  return result.note
}
function roundtrip(note: NoteDocument) {
  const raw = serializeNoteDocument(note), result = readNoteDocument(raw)
  expect(result).toMatchObject({ status: 'valid', note })
  if (result.status !== 'valid') throw new Error(result.message)
  expect(serializeNoteDocument(result.note)).toBe(raw)
  return raw
}
const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) { const element = editor.view.dom.parentElement; editor.destroy(); element?.remove() } })
function editor(content: JSONContent = newNoteDocument('', 'input-note', 'original-block').content) {
  const element = document.createElement('div'); document.body.append(element)
  const instance = new Editor({ element, extensions: [...noteContentExtensions(), ...noteIdentityExtensions(), noteWikiInputExtension()], content })
  editors.push(instance); return instance
}
function type(instance: Editor, text: string) {
  for (const char of text) {
    const { view } = instance, { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', handler => handler(view, from, to, char, () => view.state.tr.insertText(char, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to))
  }
}
function nodes(instance: Editor, type: string) { const found: JSONContent[] = []; instance.state.doc.descendants(node => { if (node.type.name === type) found.push(node.toJSON()) }); return found }

it('roundtrips standard inline and multiline block math with stable identities and original expressions', () => {
  const note = read('Before $x^2 + \\alpha$ after ^paragraph\n\n$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n\n^equation\n')
  expect(note.content.content![0]).toMatchObject({ type: 'paragraph', attrs: { blockId: 'paragraph' }, content: [{ type: 'text', text: 'Before ' }, { type: 'noteMathInline', attrs: { latex: 'x^2 + \\alpha' } }, { type: 'text', text: ' after' }] })
  expect(note.content.content![1]).toMatchObject({ type: 'noteMathBlock', attrs: { blockId: 'equation', latex: expect.stringContaining('\\begin{aligned}') } })
  const raw = roundtrip(note)
  expect(raw).toContain('$x^2 + \\alpha$'); expect(raw).toContain('$$\n'); expect(raw).toContain('^equation')
})

it('roundtrips escaped dollars, ordinary currency and code without introducing a formula', () => {
  const note = read('Literal \\$x\\$ plus `$code$` ^literal\n\nUnpaired currency $5 ^currency\n\n```tex\n$$\n\\alpha\n$$\n```\n\n^source\n')
  expect(JSON.stringify(note)).not.toContain('noteMath')
  const raw = roundtrip(note)
  expect(raw).toContain('\\$x\\$')
  expect(raw).toContain('`$code$`')
})

it('preserves math in marked inline content, nested lists and quotes', () => {
  const note = read('> **$\\beta$** ^quoted\n>\n> $$\n> x+y\n> $$\n>\n> ^quote-math\n\n^quote\n\n- <!--amux-item:item-->\n\n  Text $z$ ^item-text\n\n  $$\n  z^2\n  $$\n\n  ^item-math\n')
  roundtrip(note)
  expect(note.content.content![0]!.content![0]!.content![0]).toEqual({ type: 'noteMathInline', attrs: { latex: '\\beta' }, marks: [{ type: 'bold' }] })
  expect(note.content.content![1]!.content![0]!.content![1]).toMatchObject({ type: 'noteMathBlock', attrs: { blockId: 'item-math', latex: 'z^2' } })
})

it('keeps dollar runs inside expressions and chooses nonconflicting standard delimiters', () => {
  const note = read('Formula $$a$b$$ ^inline\n\n$$$\na\n$$\nb\n$$$\n\n^display\n')
  expect(note.content.content![0]!.content![1]).toMatchObject({ type: 'noteMathInline', attrs: { latex: 'a$b' } })
  expect(note.content.content![1]!.attrs!.latex).toBe('a\n$$\nb')
  roundtrip(note)
})

it('saves cleared inline math as a blank inline expression, never as a new block opener', () => {
  const note = newNoteDocument('', 'math-note', 'original-block')
  note.content.content![0]!.content = [{ type: 'noteMathInline', attrs: { latex: '' } }]
  const raw = serializeNoteDocument(note), parsed = readNoteDocument(raw)
  expect(raw).toContain('$ $')
  expect(parsed).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'paragraph', attrs: { blockId: 'original-block' }, content: [{ type: 'noteMathInline', attrs: { latex: ' ' } }] }] } } })
})

it('keeps unsupported math fence metadata in the original source instead of dropping it', () => {
  const raw = header + '$$ metadata\nx\n$$\n'
  expect(readNoteDocument(raw)).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'noteRawBlock', attrs: { source: '$$ metadata\nx\n$$', format: 'markdown' } }] } } })
})

it('indexes mathematical source text but creates no wiki references or binding requests inside formulas', () => {
  const note = read('Before $[[not a page]]$ [[A page]] ^body\n\n$$\n[[not a page either]]\n$$\n\n^math\n')
  const prepared = prepareNoteWikiLinks(note, () => 'only-reference')
  expect(prepared.pending).toHaveLength(1); expect(prepared.pending[0]!.text).toBe('A page')
  const raw = serializeNoteDocument(note), revision = fileUploadRevision(new TextEncoder().encode(raw))
  const knowledge = noteKnowledge([{ location: { workspaceId: 'workspace', path: 'math.note.md' }, document: { path: 'math.note.md', content: raw, revision } }], 'complete')
  expect(knowledge.references).toHaveLength(1)
  expect(knowledge.sources[0]!.blocks.get('math')!.text).toBe('[[not a page either]]')
  expect(knowledge.sources[0]!.blocks.get('body')!.text).toBe('Before [[not a page]] [[A page]]')
  const literalRaw = header + 'Literal \\$[[A real page]]\\$ ^literal\n'
  const literalKnowledge = noteKnowledge([{ location: { workspaceId: 'workspace', path: 'literal.note.md' }, document: { path: 'literal.note.md', content: literalRaw, revision: 'literal-revision' } }])
  expect(literalKnowledge.references).toHaveLength(1)
})

it('converts typed inline math through the installed input rules without changing its original paragraph', () => {
  const instance = editor()
  type(instance, 'Before $x^2$ after')
  expect(nodes(instance, 'noteMathInline')).toEqual([{ type: 'noteMathInline', attrs: { latex: 'x^2' } }])
  expect(instance.state.doc.firstChild!.attrs.blockId).toBe('original-block')
  expect(noteSemanticText(instance.state.doc.firstChild!)).toBe('Before x^2 after')
  const marked = editor(); marked.commands.setBold(); type(marked, '$x$')
  expect(nodes(marked, 'noteMathInline')[0]!.marks).toEqual([{ type: 'bold' }])
})

it('keeps prospective and complete math text out of wiki input while allowing the next real page link', () => {
  const instance = editor()
  type(instance, '$[[Not a page]]')
  expect(nodes(instance, 'noteLink')).toHaveLength(0)
  type(instance, '$ [[A page]]')
  expect(nodes(instance, 'noteMathInline')).toEqual([{ type: 'noteMathInline', attrs: { latex: '[[Not a page]]' } }])
  expect(nodes(instance, 'noteLink')).toHaveLength(1)
  expect(indexNoteReferences(instance.state.doc)).toHaveLength(1)
})

it('turns a complete empty paragraph $$ shortcut into an editable block with the same identity and provenance', () => {
  const note = newNoteDocument('', 'input-note', 'original-block')
  const provenance = { created: { actor: { kind: 'agent', id: 'creator' }, at: 1 }, lastEdited: null }
  note.content.content![0]!.attrs!.provenance = provenance
  const instance = editor(note.content)
  type(instance, '$$ ')
  expect(instance.getJSON().content).toEqual([{ type: 'noteMathBlock', attrs: { blockId: 'original-block', provenance, latex: '' } }])
  expect(instance.commands.undoInputRule()).toBe(true)
  expect(instance.state.doc.firstChild!.type.name).toBe('paragraph')
  expect(instance.state.doc.firstChild!.attrs).toMatchObject({ blockId: 'original-block', provenance })
  expect(instance.state.doc.firstChild!.textContent).toBe('$$ ')
})

it('preserves escaped input, code-mark input, code-block input, trailing content and composition', () => {
  const literal = editor(); type(literal, '\\$x\\$'); expect(nodes(literal, 'noteMathInline')).toHaveLength(0)
  const code = editor(); code.commands.setCode(); type(code, '$x$'); expect(nodes(code, 'noteMathInline')).toHaveLength(0)
  const block = editor(); block.commands.setCodeBlock(); type(block, '$x$'); expect(nodes(block, 'noteMathInline')).toHaveLength(0)
  const trailing = editor(newNoteDocument('after', 'input-note', 'original-block').content); type(trailing, '$$ ')
  expect(trailing.state.doc.firstChild!.type.name).toBe('paragraph'); expect(trailing.state.doc.textContent).toBe('$$ after')
  const composing = editor(); Object.defineProperty(composing.view, 'composing', { configurable: true, get: () => true }); type(composing, '$x$')
  expect(nodes(composing, 'noteMathInline')).toHaveLength(0); expect(composing.state.doc.textContent).toBe('$x$')
})

it('uses the original public file writer/read for formulas, stable blocks and trustworthy attribution', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-math-')))
  const workspace = { id: 'workspace', hostId: 'local', path: root, name: 'Notes', kind: 'folder' as const }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never), metadata = new AgentMuxNotebookStore(join(root, 'catalog.json'))
  const writer = new NoteFileWriter(files, undefined, metadata), path = 'math.note.md'
  const resource = { hostId: 'local', workspaceId: workspace.id, workspacePath: root, zoneId: 'zone', zonePath: root, path }
  const owner = new FileReadOwner({ workspace: () => workspace, catalog: async () => ({ zones: [{ zoneId: 'zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: root }], bindings: [] }) as never, files: { read: writer.read.bind(writer), write: writer.write.bind(writer), listFiles: files.listFiles.bind(files) } })
  const rpc = new AgentMuxRpcService({ coreClients: () => [], files: owner })
  try {
    const note = read('Before $x^2$ ^body\n\n$$\na+b\n$$\n\n^equation\n')
    const created = await writer.write(workspace, { path, content: serializeNoteDocument(note), expectedRevision: null }, { actor: { kind: 'agent', id: 'original-author' } })
    expect(created.status).toBe('written'); if (created.status !== 'written') throw new Error('Create must succeed')
    const before = await writer.read(workspace, path); if (before.status !== 'read') throw new Error('Read must succeed')
    const parsed = parseNoteFile(before.document); if (parsed.status !== 'valid') throw new Error(parsed.message)
    parsed.note.content.content![1]!.attrs!.latex = 'a+b+c'
    const result = await rpc.call('file.write', { zoneId: 'zone', path, expectedResource: resource, expectedRevision: created.revision, content: serializeNoteDocument(parsed.note) }, { principal: { kind: 'user', id: 'formula-editor' } })
    expect(result.result.status).toBe('written')
    const saved = (await rpc.call('file.read', { zoneId: 'zone', path, expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } })).result; if (saved.status !== 'read') throw new Error('Saved formula must read')
    expect(saved.document.noteProvenance!.blocks.body).toEqual(before.document.noteProvenance!.blocks.body)
    expect(saved.document.noteProvenance!.blocks.equation).toMatchObject({ created: before.document.noteProvenance!.blocks.equation!.created, lastEdited: { actor: { kind: 'user', id: 'formula-editor' } } })
    expect(saved.document.content).toContain('a+b+c'); expect(saved.document.content).toContain('^equation')
    expect(readNoteDocument(saved.document.content).status).toBe('valid')
    expect(await rpc.call('file.write', { zoneId: 'zone', path, expectedResource: resource, expectedRevision: created.revision, content: serializeNoteDocument(note) })).toMatchObject({ result: { status: 'conflict' } })
  } finally { await rpc.dispose(); await files.dispose(); await rm(root, { recursive: true, force: true }) }
})
