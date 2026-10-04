import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const sources = ['apps/desktop/src/shared/workspace-file-format.ts', 'apps/desktop/src/shared/note-format.ts', 'apps/desktop/src/shared/note-document.ts',
  ...['components/FileSurfaceView.tsx', 'components/FilePreviewPane.tsx', 'components/FileDataPreview.tsx', 'components/WorkspaceImage.tsx', 'lib/file-json-preview.ts',
    'lib/file-delimited-preview.ts', 'lib/use-workspace-file-preview.ts'].map(path => 'apps/desktop/src/renderer/src/' + path)]
const fixture = 'apps/desktop/scripts/fixtures/file-surface-quality/vitest.owning.config.mts'
const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path,
  createHash('sha256').update(await readFile(join(root, path))).digest('hex')])) )
async function sourceFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  const lists = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []))
  return lists.flat()
}
const files = await sourceFiles('apps/desktop/src/renderer/src')
assert.ok(files.length > 0, 'Production caller scan must have real files')
const consumers = await Promise.all(files.map(async path => ({ path, source: await readFile(join(root, path), 'utf8') })))
const definitions = { FileDataPreview: 'components/FileDataPreview.tsx', readJsonPreview: 'lib/file-json-preview.ts',
  readDelimitedPreview: 'lib/file-delimited-preview.ts', useWorkspaceFilePreview: 'lib/use-workspace-file-preview.ts',
  workspaceFileFormat: '../../shared/workspace-file-format.ts' }
const outsideCallers = Object.fromEntries(Object.entries(definitions).map(([symbol, definition]) => [symbol,
  consumers.filter(({ path, source }) => path !== 'apps/desktop/src/renderer/src/' + definition &&
    new RegExp(symbol === 'FileDataPreview' ? '<' + symbol + '[\\s/>]' : symbol + '\\(').test(source)).map(({ path }) => path)]))
for (const [symbol, callers] of Object.entries(outsideCallers)) assert.ok(callers.length > 0, 'Outside production caller: ' + symbol)
const hashes = await sourceHashes()
await mkdir(join(root, '.tmp'), { recursive: true, preserveTimestamps: true })
const proof = await mkdtemp(join(root, '.tmp/file-surface-quality-'))
const snapshot = join(proof, 'source')
await mkdir(snapshot)
// Mutations run in a copied source tree; concurrent product authors never load a mutant.
await cp(join(root, 'apps/desktop/src'), join(snapshot, 'apps/desktop/src'), { recursive: true, preserveTimestamps: true })
await cp(join(root, 'apps/desktop/test'), join(snapshot, 'apps/desktop/test'), { recursive: true, preserveTimestamps: true })
await cp(join(root, 'apps/desktop/resources'), join(snapshot, 'apps/desktop/resources'), { recursive: true, preserveTimestamps: true })
await cp(join(root, 'packages'), join(snapshot, 'packages'), { recursive: true,
  preserveTimestamps: true,
  filter: path => !path.split('/').some(segment => ['node_modules', '.tmp', '.bagakit'].includes(segment)) })
for (const path of ['package.json', 'tsconfig.base.json', 'apps/desktop/tsconfig.json', 'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts', fixture]) {
  await mkdir(join(snapshot, path, '..'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, path), join(snapshot, path))
}
await symlink(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir')
await symlink(join(root, 'apps/desktop/node_modules'), join(snapshot, 'apps/desktop/node_modules'), 'dir')
const receipt = { sourceHashes: hashes, scannedFiles: files.length, outsideCallers, proof, phases: [] }
for (const mode of ['green', 'routing', 'json-grammar', 'json-precision', 'tsv-grammar', 'media-readiness', 'image-visibility', 'draft-owner', 'resource-fence', 'restored']) {
  const output = join(proof, mode + '.json'), loaded = join(proof, mode + '.loaded.jsonl'), logs = []
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(join(root, 'node_modules/.bin/vitest'), ['run', '--config', join(snapshot, fixture),
      '--reporter=json', '--outputFile=' + output], { cwd: snapshot, env: { ...process.env,
        AGENTMUX_FILE_SURFACE_MUTATION: ['green', 'restored'].includes(mode) ? '' : mode,
        AGENTMUX_FILE_SURFACE_LOADED_LOG: loaded } })
    child.stdout.on('data', data => logs.push(data)); child.stderr.on('data', data => logs.push(data))
    child.on('error', reject); child.on('exit', resolveExit)
  })
  await writeFile(join(proof, mode + '.log'), Buffer.concat(logs))
  const result = JSON.parse(await readFile(output, 'utf8'))
  const failures = result.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  const loadedSources = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const actualViewport = loadedSources.filter(item => sources.includes(item.path))
  assert.ok(actualViewport.length > 0, 'The real reader implementation must load')
  for (const source of actualViewport) assert.equal(source.sourceSHA256, hashes[source.path], 'Loaded Source must match candidate')
  receipt.phases.push({ mode, exitCode, passed: result.numPassedTests, failed: result.numFailedTests,
    mutations: actualViewport.filter(item => item.mutated),
    assertions: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
  assert.deepEqual(await sourceHashes(), hashes, 'Isolated loaded mutations must leave product Source intact')
  if (['green', 'restored'].includes(mode)) {
    assert.equal(exitCode, 0, 'Original product behavior must pass')
    assert.ok(result.numPassedTests >= 20, 'Real behavior tests must run')
    assert.equal(result.numFailedTests, 0)
  } else {
    assert.notEqual(exitCode, 0)
    assert.ok(actualViewport.some(item => item.mutated && item.loadedSHA256 !== item.sourceSHA256))
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))),
      'Loaded mutation must reach a behavior assertion, not fail compilation')
  }
}
await writeFile(join(proof, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await rm(snapshot, { recursive: true, force: true })
console.log(JSON.stringify({ proof, outsideCallers, phases: receipt.phases.map(({ assertions, mutations, ...phase }) => phase) }))

if (process.argv.includes('integration') || process.argv.includes('--task=integration')) {
  const { execFileSync } = await import('node:child_process')
  execFileSync(join(root, 'node_modules/.bin/vitest'), ['run', 'apps/desktop/test/workface-file-view-control.test.tsx', '--reporter=dot'], { cwd: root, stdio: 'inherit' })
  const capture = JSON.parse(await readFile(join(root, '.tmp/file-surface-quality-visual/capture-receipt.json'), 'utf8'))
  const review = JSON.parse(await readFile(join(root, '.tmp/file-surface-quality-visual/independent-visual-review.json'), 'utf8'))
  assert.equal(capture.passed, true); assert.equal(review.passed, true)
  assert.deepEqual(review.sourceHashes, capture.sourceHashes)
  for (const [file, expected] of Object.entries(capture.sourceHashes)) assert.equal(createHash('sha256').update(await readFile(join(root, file))).digest('hex'), expected)
  assert.ok(capture.frames.length > 0)
  for (const frame of capture.frames) {
    assert.equal(createHash('sha256').update(await readFile(join(root, '.tmp/file-surface-quality-visual', frame.file))).digest('hex'), frame.sha256)
    assert.ok(review.frames.some(item => item.file === frame.file && item.sha256 === frame.sha256))
  }
}
