// @vitest-environment happy-dom
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { boundary, groupId, noteRetentionFixture, restoreRetentionState, sources, store, survivingTabId, unrelatedTabId, workspaceId, type Fixture } from './fixtures/note-draft-retention'

let root: string, fixture: Fixture | undefined
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-retention-'))) })
afterEach(async () => {
  await fixture?.dispose(); fixture = undefined; restoreRetentionState()
  console.log('NOTE_RETENTION_ASSERTIONS', expect.getState().currentTestName, expect.getState().assertionCalls)
  await rm(root, { recursive: true, force: true })
})

it('keeps the original draft when only an unrelated clean Tab closes', async () => {
  const f = fixture = await noteRetentionFixture(root, true)
  const release = await f.observe(sources.original); release()
  const draft = f.retained(sources.original), survivor = store.getState().tabs[survivingTabId]
  expect(await store.getState().closeTab(workspaceId, groupId, unrelatedTabId)).toBe(true)
  expect(f.retained(sources.original)).toBe(draft)
  expect(store.getState().tabs[unrelatedTabId]).toBeUndefined()
  expect(store.getState().tabs[survivingTabId]).toBe(survivor)
  expect(boundary.files.write).not.toHaveBeenCalled()
  await f.originalUnchanged()
})

it('keeps the original draft and exact unknown save while a distinct clean consumer releases', async () => {
  const f = fixture = await noteRetentionFixture(root, true)
  const release = await f.observe(sources.original)
  boundary.files.write.mockResolvedValueOnce({ status: 'unknown', code: 'ORIGINAL_RECEIPT_MISSING', message: 'Original save receipt is unknown' })
  await store.getState().saveNoteFile(f.target(sources.original))
  const id = f.key(sources.original), attempted = store.getState().documents[id]!.noteEditing!.attempt!
  const issue = store.getState().documentIssues[id]
  expect(attempted).toMatchObject({ noteId: sources.original.noteId, content: sources.original.draft, phase: 'unknown' })
  expect(issue).toMatchObject({ kind: 'write-unknown', code: 'ORIGINAL_RECEIPT_MISSING' })
  // An already captured editor conflict is a separate original recovery fact.
  // Its merge producer is unchanged; this cleanup must preserve its exact identity.
  const input = { baseContent: sources.original.saved, observedContent: sources.original.draft, proposedContent: sources.original.draft + '\nEarlier unmerged input',
    phase: 'conflict' as const, resource: attempted.resource }
  store.setState(state => ({ documents: { ...state.documents, [id]: { ...state.documents[id]!, noteEditing: { ...state.documents[id]!.noteEditing, input } } } }))
  release(); f.retained(sources.original)
  const releaseClean = await f.observe(sources.other, false)
  expect(store.getState().documents[f.key(sources.other)]?.content).toBe(sources.other.saved)
  releaseClean()
  expect(store.getState().documents[f.key(sources.other)]).toBeUndefined()
  expect(f.retained(sources.original).noteEditing?.attempt).toBe(attempted)
  expect(store.getState().documents[id]!.noteEditing?.input).toBe(input)
  const preservedIssue = store.getState().documentIssues[id]
  expect(preservedIssue).toBe(issue)
  expect(preservedIssue?.kind === 'write-unknown' ? preservedIssue.attempted : undefined).toBe(issue?.kind === 'write-unknown' ? issue.attempted : undefined)
  expect(boundary.files.write).toHaveBeenCalledTimes(1)
  await f.originalUnchanged()
})

it('discards only the selected dirty File while keeping the unrelated original draft', async () => {
  const f = fixture = await noteRetentionFixture(root, true)
  const release = await f.observe(sources.original); release()
  const original = f.retained(sources.original)
  const selected = await f.fileTab(sources.other)
  expect(store.getState().dirtyDocuments[f.key(sources.other)]).toBe(true)
  // This is the existing Store operation reached after the UI accepts Discard & Close.
  expect(await store.getState().closeTab(workspaceId, groupId, selected.id)).toBe(true)
  expect(store.getState().documents[f.key(sources.other)]).toBeUndefined()
  expect(store.getState().dirtyDocuments[f.key(sources.other)]).toBeUndefined()
  expect(store.getState().retainedDocumentDrafts[f.key(sources.other)]).toBeUndefined()
  expect(f.retained(sources.original)).toBe(original)
  expect(boundary.files.write).not.toHaveBeenCalled()
  await f.originalUnchanged()
})

it('preserves the shared original draft when its final File occurrence closes', async () => {
  const f = fixture = await noteRetentionFixture(root, true)
  const selected = await f.fileTab(sources.shared)
  const draft = store.getState().documents[f.key(sources.shared)]
  expect(await store.getState().closeTab(workspaceId, groupId, selected.id)).toBe(true)
  expect(f.retained(sources.shared)).toBe(draft)
  expect(boundary.files.write).not.toHaveBeenCalled()
  await f.originalUnchanged()
})

it('restores original content in a second Node process from the first process saved bytes', async () => {
  const repository = resolve(import.meta.dirname, '../../..')
  const results: Array<{ stage: string; code: number | null; pid: number; output: string }> = []
  for (const stage of ['writer', 'reader']) {
    const result = await new Promise<typeof results[number]>((yes, no) => {
      const child = spawn(process.execPath, [resolve(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', resolve(import.meta.dirname, 'note-draft-retention.config.mts')],
        { cwd: repository, env: { ...process.env, NOTE_DRAFT_RETENTION_STAGE: stage, NOTE_DRAFT_RETENTION_ROOT: root,
          NOTE_DRAFT_RETENTION_LOAD_REPORT: join(root, stage + '-loaded.json') }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.on('error', no); child.on('close', code => yes({ stage, code, pid: child.pid!, output }))
    })
    results.push(result)
    await writeFile(join(root, stage + '.log'), result.output)
    expect(result.code, result.output).toBe(0)
  }
  const writer = JSON.parse(await readFile(join(root, 'writer.json'), 'utf8')), reader = JSON.parse(await readFile(join(root, 'reader.json'), 'utf8'))
  expect(writer.pid).not.toBe(reader.pid)
  expect(results[0]!.pid).not.toBe(results[1]!.pid)
  expect(reader.storageReadHash).toBe(writer.storageHash)
  expect(reader.restoredDraftHash).toBe(writer.draftHash)
  expect(reader.originalFileHash).toBe(writer.originalFileHash)
  expect(reader.dirty).toBe(true); expect(reader.writeCalls).toBe(0)
  expect(reader.noteId).toBe(sources.original.noteId); expect(reader.blockId).toBe(sources.original.blockId)
  const evidence = process.env.NOTE_DRAFT_RETENTION_PROCESS_REPORT
  if (evidence) {
    const files = ['writer.json', 'reader.json', 'writer-loaded.json', 'reader-loaded.json', 'writer.log', 'reader.log', 'storage.json']
    const artifacts = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(root, file), 'utf8')])))
    await writeFile(evidence, JSON.stringify({ passed: true, writer, reader, processes: results.map(({ output: _output, ...result }) => result), artifacts }, null, 2) + '\n')
  }
}, 60_000)
