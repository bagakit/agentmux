import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDebouncedPersistentStorage, createWriteFencedStorage } from '../../src/renderer/src/lib/persisted-ui-writer'
import { readNoteDocument } from '../../src/shared/note-document'
import { boundary, digest, groupId, noteRetentionFixture, restoreRetentionState, sources, store, unrelatedTabId, workspaceId } from './note-draft-retention'

it('runs one isolated persistence process against the original Store', async () => {
  const stage = process.env.NOTE_DRAFT_RETENTION_STAGE!, root = process.env.NOTE_DRAFT_RETENTION_ROOT!
  expect(['writer', 'reader']).toContain(stage)
  expect(root).toBeTruthy()
  const storagePath = join(root, 'storage.json'), reads: string[] = []
  type PersistedState = ReturnType<NonNullable<ReturnType<typeof store.persist.getOptions>['partialize']>>
  const persistent = createDebouncedPersistentStorage<PersistedState>({
    getItem(name) {
      expect(name).toBe('agentmux-workbench-v1')
      try { const bytes = readFileSync(storagePath, 'utf8'); reads.push(digest(bytes)); return bytes }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    setItem(name, value) { expect(name).toBe('agentmux-workbench-v1'); writeFileSync(storagePath, value) },
    removeItem() { throw Error('Removing original persisted content is outside this proof') }
  })
  const fence = createWriteFencedStorage(persistent.storage)
  store.persist.setOptions({ storage: fence.storage })
  const fixture = await noteRetentionFixture(root, stage === 'writer')
  try {
    if (stage === 'writer') {
      fence.openWrites()
      const release = await fixture.observe(sources.original); release()
      expect(await store.getState().closeTab(workspaceId, groupId, unrelatedTabId)).toBe(true)
      const document = fixture.retained(sources.original)
      persistent.flush()
      const storage = await readFile(storagePath, 'utf8')
      expect(JSON.parse(storage).state.documents[fixture.key(sources.original)].content).toBe(document.content)
      expect(boundary.files.write).not.toHaveBeenCalled()
      await fixture.originalUnchanged()
      await writeFile(join(root, 'writer.json'), JSON.stringify({ pid: process.pid, storageHash: digest(storage), draftHash: digest(document.content),
        originalFileHash: digest(await readFile(join(fixture.workspace.path, sources.original.path))), noteId: sources.original.noteId, blockId: sources.original.blockId }))
    } else {
      expect(store.getState().documents).toEqual({})
      expect(store.getState().dirtyDocuments).toEqual({})
      const originalStorage = await readFile(storagePath, 'utf8')
      await store.persist.rehydrate()
      expect(store.persist.hasHydrated()).toBe(true)
      expect(reads).toContain(digest(originalStorage))
      const document = fixture.retained(sources.original)
      const note = readNoteDocument(document.content)
      expect(note.status).toBe('valid')
      if (note.status !== 'valid') throw Error('Restored original Note did not parse')
      const release = await fixture.observe(sources.original, false); release()
      expect(store.getState().documents[fixture.key(sources.original)]).toBe(document)
      const disk = await fixture.files.read(fixture.workspace, sources.original.path)
      expect(disk).toMatchObject({ status: 'read', document: { content: sources.original.saved } })
      expect(document.content).not.toBe(sources.original.saved)
      expect(boundary.files.write).not.toHaveBeenCalled()
      expect(await readFile(storagePath, 'utf8')).toBe(originalStorage)
      await fixture.originalUnchanged()
      await writeFile(join(root, 'reader.json'), JSON.stringify({ pid: process.pid, storageReadHash: digest(originalStorage), restoredDraftHash: digest(document.content),
        originalFileHash: digest(await readFile(join(fixture.workspace.path, sources.original.path))), dirty: store.getState().dirtyDocuments[fixture.key(sources.original)],
        noteId: note.note.noteId, blockId: note.note.content.content![0]!.attrs!.blockId, writeCalls: boundary.files.write.mock.calls.length }))
    }
    console.log('NOTE_RETENTION_PROCESS_ASSERTIONS', stage, expect.getState().assertionCalls)
  } finally { await fixture.dispose(); restoreRetentionState() }
})
