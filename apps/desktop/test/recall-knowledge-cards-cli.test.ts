import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentMuxControlServer, fileUploadRevision } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { recallCardHref, type RecallCard } from '@agentmux/core/notebook-observation'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NotebookObservationOwner } from '../../host/src/notebook-observation-owner'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'

it('derives saved Recall occurrences from original files through the shipping Notebook CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-recall-cli-'))
  const workspace = { id: 'notes', hostId: 'local', path: root, name: 'Notes', kind: 'folder' as const }
  const catalogPath = join(root, 'catalog.json')
  const store = new AgentMuxNotebookStore(catalogPath)
  const newOwner = () => new NotebookObservationOwner({ workspace: id => id === workspace.id ? workspace : undefined,
    files: { async read(_, path) {
      const content = await readFile(join(root, path), 'utf8')
      return { status: 'read', document: { path, content, revision: fileUploadRevision(new TextEncoder().encode(content)) } }
    } } })
  const newServer = (notebookStore: AgentMuxNotebookStore) => new AgentMuxControlServer({
    socketPath: join(root, 'control.sock'), coreClients: () => [], notebookStore, notebookObservation: newOwner()
  })
  let server = newServer(store)
  try {
    const card: RecallCard = { id: 'checkpoint', title: 'Selected conversation record', routeHostId: 'connection-route',
      reference: { hostId: 'source-namespace', agentSessionId: 'original-agent', source: { kind: 'captured', recordId: 'original-record' } } }
    const note = newNoteDocument('', 'recall-entry', 'capture-block')
    const link = { type: 'link', attrs: { href: recallCardHref(card) } }
    note.content.content![0]!.content = [{ type: 'text', text: card.title, marks: [link] }]
    const path = 'entry.note.md'
    await writeFile(join(root, path), serializeNoteDocument(note))
    await store.apply({ operationId: 'register-entry', expectedRevision: (await store.read()).revision,
      change: { kind: 'register', noteId: note.noteId, title: 'Recall entry', resource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: root, path } } },
    { kind: 'user', id: 'reader' })
    await server.start()
    const env = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
    const graph = async () => {
      const result = await runCompiledObjectCli(['notebook', 'graph', '--note', note.noteId], env)
      expect(result.code, result.stderr + result.stdout).toBe(0)
      return JSON.parse(result.stdout).result
    }
    expect((await graph()).recallCards).toEqual([{ source: { noteId: note.noteId, blockId: 'capture-block' }, card }])

    note.content.content![0]!.content = [
      { type: 'text', text: 'Selected', marks: [link, { type: 'bold' }] },
      { type: 'text', text: ' conversation record', marks: [link] }
    ]
    const formatted = serializeNoteDocument(note)
    expect(formatted).toContain('**Selected**')
    await writeFile(join(root, path), formatted)
    await server.stop()
    server = newServer(new AgentMuxNotebookStore(catalogPath))
    await server.start()
    expect((await graph()).recallCards).toEqual([{ source: { noteId: note.noteId, blockId: 'capture-block' }, card }])

    note.content.content![0]!.content!.push({ type: 'text', text: ' Unrelated comment' })
    await writeFile(join(root, path), serializeNoteDocument(note))
    expect((await graph()).recallCards).toBeUndefined()
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
})
