// @vitest-environment happy-dom
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { AgentMuxRpcService } from '@agentmux/core'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import type { WorkspaceRecord } from '../src/shared/contracts'

it('mints missing block and wiki occurrence IDs through the actual public file consumer and preserves original persisted Note addresses', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-note-identities-')))
  const workspace: WorkspaceRecord = { id: 'original-workspace', hostId: 'local', name: 'Original', kind: 'folder', path: directory }
  const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  try {
    const writer = new NoteFileWriter(files, undefined, new AgentMuxNotebookStore(join(directory, 'notebooks.sqlite')))
    const port = new FileReadOwner({ workspace: () => workspace, catalog: async () => ({ zones: [{ zoneId: 'original-zone', workspaceId: workspace.id, kind: 'directory', hostId: 'local', directoryPath: directory }], bindings: [] }) as never,
      files: { read: writer.read.bind(writer), listFiles: files.listFiles.bind(files), write: writer.write.bind(writer) } })
    const service = new AgentMuxRpcService({ files: port })
    const params = { zoneId: 'original-zone', path: 'original.note.md', expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: directory } }
    const absent = await service.call('file.read', params)
    const legacyId = '11111111-1111-4111-8111-111111111111'
    const note = newNoteDocument('Original body', legacyId, legacyId)
    note.content.content!.push({ type: 'paragraph', content: [{ type: 'text', text: '[[Another page]]' }] })
    const created = await service.call('file.create', { ...params, expectedResource: absent.resource!, expectedRevision: null, content: serializeNoteDocument(note) })
    expect(created.result.status).toBe('written')
    const saved = await service.call('file.read', params)
    expect(saved.result.status).toBe('read'); if (saved.result.status !== 'read') throw Error('The saved original Note must be readable')
    const parsed = readNoteDocument(saved.result.document.content)
    expect(parsed.status).toBe('valid'); if (parsed.status !== 'valid') throw Error('The original saved Note must parse')
    expect(parsed.note.noteId).toBe(legacyId)
    expect(parsed.note.content.content![0]!.attrs!.blockId).toBe(legacyId)
    const added = parsed.note.content.content![1]!
    expect(added.attrs!.blockId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    expect(added.content!.find(node => node.type === 'noteLink')!.attrs!.referenceId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
    expect(await service.call('file.read', params)).toEqual(saved)
  } finally { await files.dispose(); await rm(directory, { recursive: true, force: true }) }
})
