import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const files = ['apps/desktop/native/workspace-move.c', 'apps/desktop/scripts/migrate-topic-directories.mjs', 'apps/desktop/test/topic-directory-migration.native.test.mjs', 'apps/desktop/src/main/scratch-directory-identity.mjs']
const digest = source => createHash('sha256').update(source).digest('hex')
const full = 'actual helper and script retain cwd'
const mutations = [
  { id: 'primary-misclassified', file: files[1], from: "if (id === 'launcher:leader') return 'mote'", to: "if (id === 'launcher:leader') return 'topic'", pattern: 'dry-run is read-only' },
  { id: 'identity-not-saved', file: files[1], from: 'await retainIdentity(sourcePath, sourcePath, helperPath)', to: '/* omit identity persistence */', pattern: full },
  { id: 'non-atomic-alias-move', file: files[0], from: 'RENAME_SWAP | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH', to: 'RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH', pattern: full },
  { id: 'source-inode-not-bound', file: files[0], from: '(unsigned long long)original.st_ino != expected_ino', to: '(unsigned long long)original.st_ino == expected_ino', pattern: 'native action refuses source identity drift' },
  { id: 'target-conflict-not-preflighted', file: files[1], from: "if (await optionalInfo(destinationPath)) throw failure('The canonical target already exists; neither object is replaced.', 'DIRECTORY_MIGRATION_TARGET_EXISTS')", to: 'await optionalInfo(destinationPath)', pattern: 'existing target content and conflicting durable identity' }
]

/** Recompile actual mutated C and run original native consumers in fresh isolated source trees. */
export async function runTopicDirectoryMigrationMutations({
  repository = resolve(import.meta.dirname, '../../..'),
  outputDirectory = join(repository, '.tmp/topic-directory-mutations')
} = {}) {
  repository = resolve(repository)
  outputDirectory = resolve(outputDirectory)
  const originals = Object.fromEntries(await Promise.all(files.map(async path => [path, await readFile(join(repository, path), 'utf8')])))
  await mkdir(outputDirectory, { recursive: true })
  const output = await mkdtemp(join(outputDirectory, 'source-mutations-'))
  const receipt = { source: Object.fromEntries(files.map(file => [file, digest(originals[file])])), mutations: [] }
  for (const mutation of mutations) {
    const isolated = join(output, mutation.id)
    for (const file of files) {
      await mkdir(dirname(join(isolated, file)), { recursive: true })
      await writeFile(join(isolated, file), originals[file])
    }
    const source = originals[mutation.file]
    assert.equal(source.split(mutation.from).length, 2, `${mutation.id}: source anchor must match once`)
    const replacement = source.replace(mutation.from, mutation.to)
    await writeFile(join(isolated, mutation.file), replacement)
    const args = ['--test', '--test-reporter=spec', '--test-name-pattern=' + mutation.pattern, files[2]]
    const red = spawnSync(process.execPath, args, { cwd: isolated, encoding: 'utf8', timeout: 45000 })
    const redOutput = (red.stdout ?? '') + (red.stderr ?? '')
    await writeFile(join(isolated, 'red.log'), redOutput)
    assert.equal(red.error, undefined, `${mutation.id}: process failure is not RED`)
    assert.equal(red.signal, null, `${mutation.id}: termination is not RED`)
    assert.ok(Number.isInteger(red.status) && red.status > 0, `${mutation.id}: mutation survived`)
    assert.match(redOutput, /AssertionError \[ERR_ASSERTION\]/, `${mutation.id}: expected a real behavior assertion`)
    assert.doesNotMatch(redOutput, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|error:.*\[-W|hookFailed|AssertionError \[ERR_ASSERTION\]: xcrun:/, `${mutation.id}: infrastructure failure is not RED`)
    assert.ok(redOutput.includes(mutation.pattern), `${mutation.id}: selected oracle missing`)
    await writeFile(join(isolated, mutation.file), source)
    const green = spawnSync(process.execPath, args, { cwd: isolated, encoding: 'utf8', timeout: 45000 })
    await writeFile(join(isolated, 'restored.log'), (green.stdout ?? '') + (green.stderr ?? ''))
    assert.equal(green.status, 0, `${mutation.id}: restored candidate failed`)
    assert.match(green.stdout, /pass 1\b/, `${mutation.id}: empty restored oracle`)
    receipt.mutations.push({ id: mutation.id, file: mutation.file, changedSha256: digest(replacement), command: [process.execPath, ...args], redExit: red.status, restoredExit: green.status, redLog: join(isolated, 'red.log'), restoredLog: join(isolated, 'restored.log') })
    process.stdout.write(mutation.id + ': assertion RED / restored GREEN\n')
  }
  for (const file of files) assert.equal(await readFile(join(repository, file), 'utf8'), originals[file], 'Shared production source changed during mutation proof: ' + file)
  const receiptPath = join(output, 'receipt.json')
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2))
  return { ...receipt, receiptPath }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await runTopicDirectoryMigrationMutations()
  process.stdout.write('receipt: ' + result.receiptPath + '\n')
}
