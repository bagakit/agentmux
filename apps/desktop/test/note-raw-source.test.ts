// @vitest-environment happy-dom
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { expect, it } from 'vitest'
import { type JSONContent } from '@tiptap/core'
import { noteContentSchema } from '@agentmux/client-ui/note/note-content-schema'
import { indexNoteReferences, prepareNoteWikiLinks } from '@agentmux/client-ui/note/note-wikilinks'
import { deriveNoteCorpus } from '@agentmux/client-ui/note/note-corpus'
import { readNoteDocument, serializeNoteDocument, type NoteDocument } from '../src/shared/note-document'
const header = '---\nschema: agentmux.note.md.v1\nnote-id: raw-note\n---\n\n'
function read(body: string) {
  const result = readNoteDocument(header + body)
  expect(result.status, result.status === 'invalid' ? result.message : '').toBe('valid')
  if (result.status !== 'valid') throw new Error(result.message)
  return result.note
}
function roundtrip(note: NoteDocument) {
  const raw = serializeNoteDocument(note), result = readNoteDocument(raw)
  expect(result.status, result.status === 'invalid' ? result.message : raw).toBe('valid')
  if (result.status !== 'valid') throw new Error(result.message)
  expect(noteContentSchema.nodeFromJSON(result.note.content).toJSON()).toEqual(noteContentSchema.nodeFromJSON(note.content).toJSON())
  expect(serializeNoteDocument(result.note)).toBe(raw)
  return { raw, note: result.note }
}
const rawBlock = (source: string, format = 'markdown'): JSONContent => ({ type: 'noteRawBlock', attrs: { blockId: 'source', source, format } })

it('keeps a complete HTML region across blank lines beside rich paragraphs', () => {
  const source = '<section data-x="a > b">\r\n\r\nFirst <em>line</em>\r\n\r\n<svg><text>second</text></svg>\r\n</section>'
  const note = read('Before **rich** ^before\r\n\r\n' + source + '\r\n\r\n^source\r\n\r\nAfter $x$ ^after\r\n')
  expect(note.content.content!.map(block => block.type)).toEqual(['paragraph', 'noteRawBlock', 'paragraph'])
  expect(note.content.content![1]!.attrs).toEqual({ source, format: 'html', blockId: 'source' })
  roundtrip(note)
  for (const source of ['  <section>\n\nIndented\n\n  </section>', '<div>first</div>\n<section>\n\nSecond\n\n</section>']) {
    const grouped = read(source + '\n\n^source\n\nAfter ^after\n')
    expect(grouped.content.content!.map(block => block.type)).toEqual(['noteRawBlock', 'paragraph'])
    expect(grouped.content.content![0]!.attrs!.source).toBe(source); roundtrip(grouped)
  }
})
it('preserves unknown inline HTML as its complete paragraph and retains its original anchor', () => {
  const source = 'Before <span class="badge">raw **text**</span> after'
  const note = read(source + ' ^source\n\nStill **rich** ^after\n')
  expect(note.content.content![0]!.attrs).toEqual({ source, format: 'html', blockId: 'source' })
  expect(note.content.content![1]!.type).toBe('paragraph'); roundtrip(note)
  const trailing = read(source + ' ^source  \n')
  expect(trailing.content.content![0]!.attrs).toEqual({ source: source + '  ', format: 'html', blockId: 'source' }); roundtrip(trailing)
})
it('keeps unsupported fence metadata and directive source locally without converting ordinary html fences', () => {
  const source = '```js title="original"\r\nconsole.log(`[[Literal]]`)\r\n```'
  const note = read(source + '\n\n^source\n\n:::custom{key="value"}\n\nBody\n\n:::\n\n```html\n<div>ordinary code</div>\n```\n')
  expect(note.content.content!.map(block => block.type)).toEqual(['noteRawBlock', 'noteRawBlock', 'codeBlock'])
  expect(note.content.content![0]!.attrs!.source).toBe(source); roundtrip(note)
  note.content.content![2]!.attrs!.language = 'note-raw'; roundtrip(note)
})
it('roundtrips every source byte including CRLF, terminal CR, spaces and embedded longer fences', () => {
  for (const source of ['', '\n', '\r', '\r\n', '  source  ', 'a\r\nb\n\n', 'a\r', '```\n````\n~~~~\n[[Literal]]\r\n', 'ordinary\n\nparagraphs\n']) {
    const note = read('Neighbor ^neighbor\n'); note.content.content!.unshift(rawBlock(source))
    const saved = roundtrip(note)
    expect(saved.note.content.content![0]!.attrs!.source).toBe(source)
    expect(saved.raw).toContain('note-raw markdown')
  }
})
it('preserves raw source bytes inside existing blockquote and list containers', () => {
  const note = read('> Quote ^quote\n\n- Item ^itemBody\n')
  note.content.content![0]!.content!.push(rawBlock('html\r\n\r\n  source\r', 'html'))
  note.content.content![1]!.content![0]!.content!.push({ ...rawBlock('`\nsource\n'), attrs: { ...rawBlock('').attrs, source: '`\nsource\n', blockId: 'listSource' } })
  roundtrip(note)
})
it('preserves complete unsupported list and table regions without reassigning inner identities', () => {
  for (const source of ['- <span class="raw">item</span>', '| Header |\n| --- |\n| <span>cell</span> |']) {
    const note = read('Before ^before\n\n' + source + '\n\nAfter ^after\n')
    expect(note.content.content!.map(block => block.type)).toEqual(['paragraph', 'noteRawBlock', 'paragraph'])
    expect(note.content.content![1]!.attrs!.source).toBe(source); roundtrip(note)
  }
  expect(readNoteDocument(header + '- <span>item</span> ^owned\n')).toMatchObject({ status: 'invalid' })
  expect(readNoteDocument(header + '| <span>cell</span> ^owned |\n| --- |\n')).toMatchObject({ status: 'invalid' })
})
it('keeps malformed or ambiguous identity annotations in whole Source recovery', () => {
  for (const body of ['<span>unknown</span> <!--amux-ref:%ZZ-->\n', '<span>unknown</span> ^%ZZ\n', '<div>\n\nUnclosed\n\nAfter ^after\n', '<div>\n\nUnclosed\n\nAfter\n', '<section>\n\n<!--amux-empty:owned-->\n\n</section>\n', '```note-raw html extra\nsource\n```\n', '```note-raw html\nsource\n', 'A ^same\n\n<span>B</span> ^same\n', '<!--amux-unknown:field-->\n']) {
    const original = header + body, result = readNoteDocument(original)
    expect(result, body).toMatchObject({ status: 'invalid', raw: original })
  }
})
it('indexes literal raw source without minting wiki references', () => {
  const note = read('Neighbor ^neighbor\n'); note.content.content!.unshift(rawBlock('<div>Search needle [[Never bind]]</div>', 'html'))
  let next = 0
  expect(prepareNoteWikiLinks(note, () => 'ref-' + next++)).toMatchObject({ pending: [] })
  expect(next).toBe(0); expect(indexNoteReferences(noteContentSchema.nodeFromJSON(note.content))).toEqual([])
  const raw = serializeNoteDocument(note)
  const corpus = deriveNoteCorpus([{ resource: { hostId: 'local', workspaceId: 'workspace', workspacePath: new URL("fixture", new URL('/', import.meta.url)).pathname, path: 'raw.note.md' }, document: { path: 'raw.note.md', content: raw, revision: 'revision' } }], true, 'needle')
  expect(corpus.references).toEqual([])
  expect(corpus.search.hits).toMatchObject([{ blockId: 'source', excerpt: '<div>Search needle [[Never bind]]</div>' }])
  expect(corpus.pages[0]!.blocks.find(block => block.blockId === 'source')!.text).toContain('needle')
})
it('persists original raw regions and adjacent edits through the public writer and executable CLI', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'note-raw-writer-'))), path = 'raw.note.md'
  const workspace = { id: 'workspace', hostId: 'local', path: root, name: 'Private Note', kind: 'folder' as const }
  const resource = { hostId: 'local', workspaceId: workspace.id, workspacePath: root, zoneId: 'zone', zonePath: root, path }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  const metadata = new AgentMuxNotebookStore(join(root, 'notes.sqlite'))
  const writer = new NoteFileWriter(files, undefined, metadata)
  const owner = new FileReadOwner({ workspace: () => workspace, catalog: async () => ({ zones: [{ zoneId: 'zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: root }], bindings: [] }) as never, files: { read: writer.read.bind(writer), write: writer.write.bind(writer), listFiles: files.listFiles.bind(files) } })
  const rpc = new AgentMuxRpcService({ coreClients: () => [], files: owner })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], files: owner })
  try {
    const source = '<section data-source="original">\r\n\r\n[[Never bind]]\r\n</section>'
    const imported = header + source + '\n\n^source\n\nNeighbor ^neighbor\n'
    const created = await writer.write(workspace, { path, content: imported, expectedRevision: null }, { actor: { kind: 'agent', id: 'original-author' } })
    expect(created.status).toBe('written'); if (created.status !== 'written') throw new Error('Create must succeed')
    const before = await writer.read(workspace, path); if (before.status !== 'read') throw new Error('Read must succeed')
    const parsed = readNoteDocument(before.document.content); if (parsed.status !== 'valid') throw new Error(parsed.message)
    expect(parsed.note.content.content![0]!.attrs!.source).toBe(source)
    parsed.note.content.content![1]!.content = [{ type: 'text', text: 'Neighbor edited' }]
    const saved = (await rpc.call('file.write', { zoneId: 'zone', path, expectedResource: resource, expectedRevision: created.revision, content: serializeNoteDocument(parsed.note) }, { principal: { kind: 'user', id: 'neighbor-editor' } })).result
    expect(saved.status).toBe('written')
    const observed = await writer.read(workspace, path); if (observed.status !== 'read') throw new Error('Read must succeed')
    expect(observed.document.noteProvenance!.blocks.source).toEqual(before.document.noteProvenance!.blocks.source)
    expect(observed.document.noteProvenance!.blocks.neighbor!.created).toEqual(before.document.noteProvenance!.blocks.neighbor!.created)
    expect(observed.document.noteProvenance!.blocks.neighbor!.lastEdited!.actor).toEqual({ kind: 'user', id: 'neighbor-editor' })
    expect(observed.document.content).toContain('note-raw html')
    expect(readNoteDocument(observed.document.content)).toMatchObject({ status: 'valid', note: { content: { content: [{ attrs: { source } }, { type: 'paragraph' }] } } })
    await server.start()
    const cli = async (args: string[], stdin = '') => {
      const result = await runCompiledObjectCli(['--endpoint', 'unix:' + join(root, 'control.sock'), ...args], objectCliEnvironment(root), stdin)
      expect(result.code, result.stderr).toBe(0)
      const envelope = JSON.parse(result.stdout); expect(envelope.ok).toBe(true); return envelope.result
    }
    const cliRead = ['file', 'read', '--zone', 'zone', '--path', path, '--host', 'local', '--workspace', workspace.id, '--workspace-path', root]
    const cliBefore = await cli(cliRead), cliParsed = readNoteDocument(cliBefore.result.document.content)
    if (cliParsed.status !== 'valid') throw new Error(cliParsed.message)
    const editedSource = 'ordinary\r\n\r\nparagraphs\n```\n[[Still literal]]\r\n'
    cliParsed.note.content.content![0]!.attrs!.source = editedSource
    const proposed = serializeNoteDocument(cliParsed.note)
    const cliSaved = await cli(['file', 'write', '--zone', 'zone', '--path', path, '--resource', JSON.stringify(cliBefore.resource), '--expected-revision', cliBefore.result.document.revision], proposed)
    expect(cliSaved.result.status).toBe('written')
    const after = (await cli(cliRead)).result.document, result = readNoteDocument(after.content)
    expect(after.content).toBe(proposed); expect(after.revision).toBe(cliSaved.result.revision)
    expect(result).toMatchObject({ status: 'valid', note: { content: { content: [{ type: 'noteRawBlock', attrs: { blockId: 'source', source: editedSource } }, { type: 'paragraph' }] } } })
    expect(after.noteProvenance.blocks.source.created).toEqual(before.document.noteProvenance!.blocks.source!.created)
    expect(after.noteProvenance.blocks.neighbor).toEqual(cliBefore.result.document.noteProvenance.blocks.neighbor)
    if (result.status === 'valid') expect(indexNoteReferences(noteContentSchema.nodeFromJSON(result.note.content))).toEqual([])
    expect(await rpc.call('file.write', { zoneId: 'zone', path, expectedResource: resource, expectedRevision: created.revision, content: imported })).toMatchObject({ result: { status: 'conflict' } })
  } finally { await server.stop(); await rpc.dispose(); await files.dispose(); await rm(root, { recursive: true, force: true }) }
})
