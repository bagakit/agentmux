// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { buildNoteFileLibraryRecovery } from './helpers/note-file-library-recovery-build.mjs'

const evidence = resolve(process.env.AGENTMUX_NOTE_RECOVERY_EVIDENCE ?? '.tmp/note-file-library-recovery')
const output = join(evidence, 'compiled')
let build: Awaited<ReturnType<typeof buildNoteFileLibraryRecovery>>
const ownedDirectories: string[] = []
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
beforeAll(async () => { build = await buildNoteFileLibraryRecovery(output) }, 60000)
afterAll(async () => { for (const directory of ownedDirectories) await rm(directory, { recursive: true, force: true }) })

async function inventory(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name
    if (entry.isDirectory()) Object.assign(result, await inventory(join(directory, entry.name), path + '/'))
    else if (entry.isFile()) result[path] = sha256(await readFile(join(directory, entry.name)))
    else throw Error('The private saved library must not borrow an external symlink: ' + path)
  }
  return result
}
async function launch(mode: 'writer' | 'reader', library: string, environmentRoot: string) {
  const args = [build.worker, mode, library, environmentRoot, build.adapter]
  const environment = objectCliEnvironment(environmentRoot, { HOME: join(environmentRoot, 'home'), XDG_CONFIG_HOME: join(environmentRoot, 'config'), AGENTMUX_TEST_OBJECT_CLI: build.cli })
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((yes, no) => {
    const child = spawn(process.execPath, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(Error('Owned recovery worker exceeded 60 seconds; this is not behavioral RED.')) }, 60000)
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); no(error) })
    child.once('close', code => { clearTimeout(timer); yes({ code, stdout, stderr }) })
  })
  await writeFile(join(evidence, mode + '.json'), JSON.stringify({ command: [process.execPath, ...args], ...result }, null, 2) + '\n')
  expect(result.code, result.stderr + result.stdout).toBe(0)
  return JSON.parse(result.stdout)
}

it('recovers the original saved library in a fresh Main/CLI process without a profile, SQL or draft seed', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'note-library-'))); ownedDirectories.push(directory)
  const library = join(directory, 'notes'), writerEnvironment = join(directory, 'writer'), readerEnvironment = join(directory, 'reader')
  await mkdir(library)
  const writer = await launch('writer', library, writerEnvironment), savedFiles = await inventory(library)
  expect(Object.keys(savedFiles)).toContain('notebooks.root.json')
  expect(Object.keys(savedFiles).some(path => path.startsWith('notebooks.root.json.files/'))).toBe(true)
  const savedDataFiles = Object.keys(savedFiles).filter(path => !(path.endsWith('.lock') && savedFiles[path] === sha256('')))
  expect(savedDataFiles.filter(path => /\.(?:sqlite|db)(?:-|$)|notebooks\.json(?:\.|$)/u.test(path))).toEqual([])
  // Delete all writer environment files, including its locator. Keep only the saved library.
  await rm(writerEnvironment, { recursive: true })
  expect((await readdir(directory)).sort()).toEqual(['notes'])
  const reader = await launch('reader', library, readerEnvironment)
  expect(reader.pid).not.toBe(writer.pid)
  expect(reader.freshLocator).toBe(true)
  expect(reader.restored).toEqual(writer.restored)
  const state = reader.restored.state
  expect(Object.keys(state.pages).sort()).toEqual(['child-note', 'source-note'])
  expect(state.pages['child-note']).toMatchObject({ notebookId: 'original-book', parentNoteId: 'source-note', followers: [{ actor: { kind: 'user' } }] })
  expect(reader.restored.originalCatalogOperation.recordedOperation).toEqual(state.operations['register-child'])
  const source = reader.restored.originals['source-note'], child = reader.restored.originals['child-note'], shared = reader.restored.originals['shared-note']
  expect(source.read.result.document.content).toContain('Tail written with missing receipt')
  expect(source.read.result.document.content).toContain('::note-include')
  expect(child.read.result.document.content).toContain('::note-include')
  expect(shared.read.result.document.content).toContain('Knowledge refined by the original researcher')
  expect(shared.read.result.document.noteProvenance).toMatchObject({ status: 'recorded', blocks: { 'source-block': { created: { actor: { kind: 'user', id: 'original-person' } }, lastEdited: { actor: { kind: 'agent', id: 'original-research-agent' } } } } })
  expect(source.history.find((entry: { eventId: string }) => entry.eventId === 'researcher-edit')).toMatchObject({ beforeContent: expect.stringContaining('Knowledge from the original researcher'), content: expect.stringContaining('Knowledge refined by the original researcher'), status: 'committed' })
  expect(source.operations.find((entry: { eventId: string }) => entry.eventId === 'unknown-original')).toMatchObject({ eventId: 'unknown-original', status: 'unconfirmed' })
  expect(reader.restored.inspect).toMatchObject({ mode: 'shared', declaration: { status: 'confirmed' }, create: { status: 'read', event: { eventId: 'promote-original:create', status: 'committed' } }, destination: { status: 'read', event: { eventId: 'destination-share', status: 'committed' } } })
  expect(reader.continued.repeated).toMatchObject({ status: 'unknown', code: 'NOTE_OPERATION_UNCONFIRMED' })
  expect(reader.continued.missing).toMatchObject({ history: { result: { status: 'unknown', code: 'FILE_HISTORY_UNCONFIRMED' } }, readable: { result: { status: 'read', document: { noteProvenance: { status: 'unconfirmed' } } } } })
  expect(reader.continued.edited).toMatchObject({ result: { status: 'written', noteHistory: { status: 'committed' } } })
  expect(reader.continued.editedRead).toMatchObject({ result: { status: 'read', document: { content: expect.stringContaining('Destination edited after restart') } } })
  expect(reader.continued.history.result.entries).toHaveLength(child.history.length + 2) // Valid write plus the original CAS rejection.
  const receipt = { schema: 'agentmux.note-file-library-recovery.v1', boundary: 'Two real Node Main-owner processes and executable CLI; not an Electron GUI restart.', source: build.manifest, writer, reader, savedFiles, finalFiles: await inventory(library), writerEnvironmentRemovedBeforeReader: true, profileOrDraftSeed: false, noDatabaseInLibrary: true, ownedRuntimeDirectory: directory }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}, 120000)
