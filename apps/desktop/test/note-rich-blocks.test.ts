// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { noteContentExtensions, noteContentSchema, noteIdentityExtensions } from '@agentmux/client-ui/note/note-content-schema'
import { indexNoteReferences, prepareNoteWikiLinks, noteSemanticText } from '@agentmux/client-ui/note/note-wikilinks'
import { noteKnowledge, projectNoteBlocks } from '@agentmux/client-ui/note/note-knowledge'
import { deriveNoteCorpus } from '@agentmux/client-ui/note/note-corpus'
import { readNoteDocument, serializeNoteDocument, type NoteDocument } from '../src/shared/note-document'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileReadOwner } from '@agentmux/host/file-read-owner'

const header = '---\nschema: agentmux.note.md.v1\nnote-id: rich-note\n---\n\n'
function read(body: string): NoteDocument {
  const parsed = readNoteDocument(header + body)
  expect(parsed.status, parsed.status === 'invalid' ? parsed.message : '').toBe('valid')
  if (parsed.status !== 'valid') throw new Error(parsed.message)
  return parsed.note
}
const normalized = (note: NoteDocument) => noteContentSchema.nodeFromJSON(note.content).toJSON()
function roundtrip(note: NoteDocument) {
  const raw = serializeNoteDocument(note), result = readNoteDocument(raw)
  expect(result.status, result.status === 'invalid' ? result.message : raw).toBe('valid')
  if (result.status !== 'valid') throw new Error(result.message)
  expect(normalized(result.note)).toEqual(normalized(note))
  expect(serializeNoteDocument(result.note)).toBe(raw)
  return raw
}
const json = (instance: Editor): JSONContent => instance.getJSON()
const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) { const element = editor.view.dom.parentElement; editor.destroy(); element?.remove() } })
function editor(note: NoteDocument) {
  const element = document.createElement('div'); document.body.append(element)
  const instance = new Editor({ element, extensions: [...noteContentExtensions(), ...noteIdentityExtensions()], content: note.content })
  editors.push(instance); return instance
}
function position(instance: Editor, blockId: string) {
  let pos = -1
  instance.state.doc.descendants((node, at) => { if (node.attrs.blockId === blockId) pos = at + 1 })
  expect(pos).toBeGreaterThan(-1); return pos
}
const tableSource = '| **Left** ^headA | Right ^headB |\n| :--- | ---: |\n| a\\|b ^cellA | $x^2$ ^cellB |\n\n^table\n'

it('preserves mixed inline images, link marks, alt/title and original paragraph anchors', () => {
  const note = read('Before ![a \\[literal\\]](assets/image.png "original title") after [![icon](assets/icon.svg)](https://example.test) ^body\n')
  expect(note.content.content![0]!.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', attrs: { src: 'assets/image.png', alt: 'a [literal]', title: 'original title' } })]))
  const raw = roundtrip(note)
  expect(raw).toContain('assets/image.png'); expect(raw).toContain('original title'); expect(raw).toContain('^body')
})

it('preserves aligned table cells, rich content, literal pipes, empty cells and every anchor', () => {
  const note = read(tableSource + '\n| Empty ^empty | Image ^imageHead |\n| --- | --- |\n| ^blank | ![chart](assets/a.png) ^imageCell |\n\n^tableTwo\n')
  const raw = roundtrip(note)
  expect(raw).toContain('a\\|b'); expect(raw).toContain('$x^2$')
  expect(raw).toContain('^blank'); expect(raw).toContain('^tableTwo')
  expect(raw).not.toContain('amux-cell')
  expect(note.content.content![0]!.content![1]!.content![1]!.attrs).toEqual({ align: 'right' })
  expect(note.content.content![0]!.content!.flatMap(row => row.content!.map(cell => cell.content![0]!.attrs!.blockId))).toEqual(['headA', 'headB', 'cellA', 'cellB'])
})

it('preserves task checked state, nested content and mixed ordered item identities', () => {
  const note = read('3. [x] <!--amux-item:done-->\n\n   Done ^doneBody\n\n4. <!--amux-item:plain-->\n\n   Ordinary ^plainBody\n\n5. [ ] <!--amux-item:pending-->\n\n   Pending ^pendingBody\n\n   - [x] <!--amux-item:nested-->\n\n     Nested ^nestedBody\n')
  expect(note.content.content![0]).toMatchObject({ type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'taskItem', attrs: { checked: true, blockId: 'done' } }, { type: 'listItem' }, { type: 'taskItem', attrs: { checked: false } }] })
  const raw = roundtrip(note)
  expect(raw).toContain('3. [x]'); expect(raw).toContain('amux-item:nested')
})

it('toggles an actual task checkbox transaction and undo without changing paragraph identity', () => {
  const note = read('- [ ] <!--amux-item:task-->\n\n  Original ^body\n'), instance = editor(note)
  const checkbox = instance.view.dom.querySelector('input[type=checkbox]') as HTMLInputElement
  expect(checkbox).not.toBeNull()
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  expect(json(instance).content![0]!.content![0]!.attrs).toMatchObject({ checked: true, blockId: 'task' })
  expect(json(instance).content![0]!.content![0]!.content![0]!.attrs!.blockId).toBe('body')
  expect(roundtrip({ ...note, content: json(instance) })).toContain('- [x]')
  expect(instance.commands.undo()).toBe(true)
  expect(json(instance).content![0]!.content![0]!.attrs!.checked).toBe(false)
})

it('serializes newly inserted empty tables and task lists before the original writer allocates identities', () => {
  const note = read('Original ^body\n'), instance = editor(note)
  instance.commands.setTextSelection(1)
  expect(instance.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })).toBe(true)
  roundtrip({ ...note, content: json(instance) })
  expect(instance.commands.undo()).toBe(true)
  expect(instance.commands.toggleTaskList()).toBe(true)
  roundtrip({ ...note, content: json(instance) })
  const empty = editor(read('<!--amux-empty:empty-->\n'))
  expect(empty.commands.toggleTaskList()).toBe(true)
  expect(roundtrip({ ...note, content: json(empty) })).toContain('- [ ]')
})

it('keeps read-only task checkboxes immutable', () => {
  const instance = editor(read('- [ ] Task ^body\n')); instance.setEditable(false)
  const checkbox = instance.view.dom.querySelector('input')!
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  expect(checkbox.checked).toBe(false)
  expect(json(instance).content![0]!.content![0]!.attrs!.checked).toBe(false)
})

it('roundtrips actual add/delete row and column commands including nondefault header and alignment', () => {
  const note = read(tableSource), instance = editor(note)
  instance.commands.setTextSelection(position(instance, 'headA'))
  expect(instance.commands.addRowBefore()).toBe(true)
  const raw = roundtrip({ ...note, content: json(instance) })
  expect(raw).toContain('<!--amux-cell:cell;align=null-->')
  expect(raw).toContain('<!--amux-cell:header;align=left-->')
  instance.commands.setTextSelection(position(instance, 'cellA'))
  expect(instance.commands.addColumnAfter()).toBe(true)
  roundtrip({ ...note, content: json(instance) })
  expect(instance.commands.deleteColumn()).toBe(true)
  roundtrip({ ...note, content: json(instance) })
  instance.commands.setTextSelection(position(instance, 'headB'))
  expect(instance.commands.deleteRow()).toBe(true)
  roundtrip({ ...note, content: json(instance) })
})

it('Enter in an original table cell preserves a hard break and cell identity through save', () => {
  const note = read(tableSource), instance = editor(note)
  instance.commands.setTextSelection(position(instance, 'cellA') + 1)
  expect(instance.commands.keyboardShortcut('Enter')).toBe(true)
  const raw = roundtrip({ ...note, content: json(instance) })
  expect(raw).toContain('<br>'); expect(raw).toContain('^cellA')
  expect(instance.commands.undo()).toBe(true)
  expect(serializeNoteDocument({ ...note, content: json(instance) })).not.toContain('<br>')
})

it('indexes task/table text and image alternate text without wiki bindings in image attrs', () => {
  const note = read('| [[Real]] ^cell | ![[[not wiki]]](assets/a.png) ^image |\n| --- | --- |\n| text ^lower | tail ^tail |\n\n^table\n\n- [ ] [[Task target]] ^taskBody\n')
  let counter = 0; const prepared = prepareNoteWikiLinks(note, () => 'ref' + ++counter)
  expect(prepared.pending.map(item => item.text)).toEqual(['Real', 'Task target'])
  const tree = noteContentSchema.nodeFromJSON(prepared.note.content)
  expect(indexNoteReferences(tree).map(item => item.blockId)).toEqual(['cell', 'taskBody'])
  const imageParagraph = tree.child(0).child(0).child(1).child(0)
  expect(noteSemanticText(imageParagraph)).toBe('[[not wiki]]')
  const resource = { hostId: 'local', workspaceId: 'workspace', workspacePath: new URL('fixture', new URL('/', import.meta.url)).pathname, path: 'rich.note.md' }
  const corpus = deriveNoteCorpus([{ resource, document: { path: resource.path, content: serializeNoteDocument(prepared.note), revision: 'revision' } }], true, 'not wiki')
  expect(corpus.search.hits).toMatchObject([{ blockId: 'image' }])
})

it('projects exact task body with its original checkbox and list context', () => {
  const note = read('- [x] <!--amux-item:task-->\n\n  Original ^body\n')
  const knowledge = noteKnowledge([{ location: { workspaceId: 'workspace', path: 'rich.note.md' }, document: { path: 'rich.note.md', content: serializeNoteDocument(note), revision: 'revision' } }], 'complete')
  const projected = projectNoteBlocks(knowledge.sources[0]!, ['body'])
  expect(projected.content.content![0]).toMatchObject({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ attrs: { blockId: 'body' } }] }] })
  noteContentSchema.nodeFromJSON(projected.content).check()
})

it('rejects malformed semantic identity and cell metadata without claiming unsupported local recovery', () => {
  expect(readNoteDocument(header + '| A ^duplicate | B ^duplicate |\n| --- | --- |\n')).toMatchObject({ status: 'invalid' })
  expect(readNoteDocument(header + '| <!--amux-cell:header;align=wrong-->A ^a | B ^b |\n| --- | --- |\n')).toMatchObject({ status: 'invalid' })
  expect(readNoteDocument(header + '- [x] <!--amux-item:bad%xx-->\n\n  body ^body\n')).toMatchObject({ status: 'invalid' })
})

it('canonical public writer preserves creators and untouched blocks while editing task, image and table content', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-rich-writer-'))), path = 'rich.note.md'
  const workspace = { id: 'workspace', hostId: 'local', path: root, name: 'Private Note', kind: 'folder' as const }
  const resource = { hostId: 'local', workspaceId: workspace.id, workspacePath: root, zoneId: 'zone', zonePath: root, path }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  const metadata = new AgentMuxNotebookStore(join(root, 'notes.sqlite'))
  const writer = new NoteFileWriter(files, undefined, metadata)
  const owner = new FileReadOwner({ workspace: () => workspace, catalog: async () => ({ zones: [{ zoneId: 'zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: root }], bindings: [] }) as never, files: { read: writer.read.bind(writer), write: writer.write.bind(writer), listFiles: files.listFiles.bind(files) } })
  const rpc = new AgentMuxRpcService({ coreClients: () => [], files: owner })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], files: owner })
  try {
    const note = read(tableSource + '\n- [ ] <!--amux-item:task-->\n\n  Task ^taskBody\n\n![original](assets/a.png "title") ^picture\n\nUnchanged ^untouched\n')
    const created = await writer.write(workspace, { path, content: serializeNoteDocument(note), expectedRevision: null }, { actor: { kind: 'agent', id: 'original-author' } })
    expect(created.status).toBe('written'); if (created.status !== 'written') throw new Error('Create must succeed')
    const before = await writer.read(workspace, path); if (before.status !== 'read') throw new Error('Read must succeed')
    const parsed = readNoteDocument(before.document.content); if (parsed.status !== 'valid') throw new Error(parsed.message)
    const visit = (node: JSONContent) => {
      if (node.attrs?.blockId === 'cellA') node.content = [{ type: 'text', text: 'edited cell' }]
      if (node.type === 'image') node.attrs!.alt = 'edited alternate'
      if (node.type === 'taskItem') node.attrs!.checked = true
      node.content?.forEach(visit)
    }; visit(parsed.note.content)
    const result = await rpc.call('file.write', { zoneId: 'zone', path, expectedResource: resource, expectedRevision: created.revision, content: serializeNoteDocument(parsed.note) }, { principal: { kind: 'user', id: 'content-editor' } })
    expect(result.result.status).toBe('written')
    const saved = (await rpc.call('file.read', { zoneId: 'zone', path, expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: root } })).result
    if (saved.status !== 'read') throw new Error('Saved Note must read')
    const old = before.document.noteProvenance!.blocks, next = saved.document.noteProvenance!.blocks
    expect(Object.keys(next).sort()).toEqual(Object.keys(old).sort())
    for (const id of Object.keys(old)) {
      expect(next[id]!.created).toEqual(old[id]!.created)
      if (['cellA', 'picture', 'task'].includes(id)) expect(next[id]!.lastEdited!.actor).toEqual({ kind: 'user', id: 'content-editor' })
      else expect(next[id]).toEqual(old[id])
    }
    expect(saved.document.content).toContain('edited cell'); expect(saved.document.content).toContain('edited alternate'); expect(saved.document.content).toContain('- [x]')
    expect(readNoteDocument(saved.document.content).status).toBe('valid')
    expect(await rpc.call('file.write', { zoneId: 'zone', path, expectedResource: resource, expectedRevision: created.revision, content: serializeNoteDocument(note) })).toMatchObject({ result: { status: 'conflict' } })
    await server.start()
    const cli = async (args: string[], stdin = '') => {
      const result = await runCompiledObjectCli(['--endpoint', 'unix:' + join(root, 'control.sock'), ...args], objectCliEnvironment(root), stdin)
      expect(result.code, result.stderr).toBe(0)
      const envelope = JSON.parse(result.stdout); expect(envelope.ok).toBe(true); return envelope.result
    }
    const cliRead = ['file', 'read', '--zone', 'zone', '--path', 'cli.note.md', '--host', 'local', '--workspace', workspace.id, '--workspace-path', root]
    const absent = await cli(cliRead); expect(absent.result.status).toBe('deleted')
    const cliCreated = await cli(['file', 'create', '--input', '-'], JSON.stringify({ zoneId: 'zone', path: 'cli.note.md', expectedResource: absent.resource, expectedRevision: null, content: serializeNoteDocument({ ...note, noteId: 'rich-cli' }) }))
    expect(cliCreated.result.status).toBe('written')
    const observed = await cli(cliRead); expect(observed.result.status).toBe('read')
    const proposed = observed.result.document.content.replace('![original]', '![CLI alternate]')
    const cliSaved = await cli(['file', 'write', '--zone', 'zone', '--path', 'cli.note.md', '--resource', JSON.stringify(observed.resource), '--expected-revision', observed.result.document.revision], proposed)
    expect(cliSaved.result.status).toBe('written')
    const cliAfter = (await cli(cliRead)).result.document
    expect(cliAfter.content).toBe(proposed)
    expect(cliAfter.revision).toBe(cliSaved.result.revision)
    expect(cliAfter.content).toContain('![CLI alternate](assets/a.png "title")')
    expect(cliAfter.content).toContain('^cellA'); expect(cliAfter.content).toContain('- [ ]')
    expect(cliAfter.noteProvenance.blocks.task).toEqual(observed.result.document.noteProvenance.blocks.task)
    expect(cliAfter.noteProvenance.blocks.picture.created).toEqual(observed.result.document.noteProvenance.blocks.picture.created)
    expect(cliAfter.noteProvenance.status).toBe('recorded')
  } finally { await server.stop(); await rpc.dispose(); await files.dispose(); await rm(root, { recursive: true, force: true }) }
})
