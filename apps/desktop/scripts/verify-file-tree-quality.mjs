import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const product = 'apps/desktop/src/renderer/src/components/FileExplorer.tsx'
const viewport = 'apps/desktop/src/renderer/src/components/file-tree/useFileTreeViewport.ts'
const fixture = 'apps/desktop/scripts/fixtures/file-tree-quality/vitest.owning.config.mts'
const sources = [product, viewport, 'apps/desktop/src/renderer/src/components/file-tree/file-explorer-row-projection.ts',
  'apps/desktop/src/renderer/src/styles/file-explorer.css']
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
const outsideCallers = {
  viewport: consumers.filter(({ path, source }) => path !== viewport && /useFileTreeViewport\(/.test(source)).map(({ path }) => path),
  explorer: consumers.filter(({ path, source }) => path !== product && /<FileExplorer[\s/>]/.test(source)).map(({ path }) => path)
}
assert.ok(outsideCallers.viewport.length > 0, 'Viewport needs an outside-definition production caller')
assert.ok(outsideCallers.explorer.length > 0, 'Explorer needs real product consumers')
const hashes = await sourceHashes()
await mkdir(join(root, '.tmp'), { recursive: true })
const proof = await mkdtemp(join(root, '.tmp/file-tree-quality-'))
const snapshot = join(proof, 'source')
await mkdir(snapshot)
// Mutations run in a copied source tree; concurrent product authors never load a mutant.
await cp(join(root, 'apps/desktop/src'), join(snapshot, 'apps/desktop/src'), { recursive: true })
await cp(join(root, 'apps/desktop/test'), join(snapshot, 'apps/desktop/test'), { recursive: true })
await cp(join(root, 'packages'), join(snapshot, 'packages'), { recursive: true,
  preserveTimestamps: true,
  filter: path => !path.split('/').some(segment => ['node_modules', '.tmp', '.bagakit'].includes(segment)) })
for (const path of ['package.json', 'tsconfig.base.json', 'apps/desktop/tsconfig.json', 'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts', fixture]) {
  await mkdir(join(snapshot, path, '..'), { recursive: true })
  await cp(join(root, path), join(snapshot, path))
}
await symlink(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir')
await symlink(join(root, 'apps/desktop/node_modules'), join(snapshot, 'apps/desktop/node_modules'), 'dir')
const receipt = { sourceHashes: hashes, scannedFiles: files.length, outsideCallers, proof, phases: [] }
for (const mode of ['green', 'unbounded-dom', 'lost-interaction', 'no-scroll', 'restored']) {
  const output = join(proof, mode + '.json'), loaded = join(proof, mode + '.loaded.jsonl'), logs = []
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(join(root, 'node_modules/.bin/vitest'), ['run', '--config', join(snapshot, fixture),
      '--reporter=json', '--outputFile=' + output], { cwd: snapshot, env: { ...process.env,
        AGENTMUX_FILE_TREE_MUTATION: ['green', 'restored'].includes(mode) ? '' : mode,
        AGENTMUX_FILE_TREE_LOADED_LOG: loaded } })
    child.stdout.on('data', data => logs.push(data)); child.stderr.on('data', data => logs.push(data))
    child.on('error', reject); child.on('exit', resolveExit)
  })
  await writeFile(join(proof, mode + '.log'), Buffer.concat(logs))
  const result = JSON.parse(await readFile(output, 'utf8'))
  const failures = result.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  const loadedSources = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const actualViewport = loadedSources.filter(item => item.path === viewport)
  assert.ok(actualViewport.length > 0, 'The real viewport implementation must load')
  for (const source of actualViewport) assert.equal(source.sourceSHA256, hashes[viewport], 'Loaded Source must match candidate')
  receipt.phases.push({ mode, exitCode, passed: result.numPassedTests, failed: result.numFailedTests,
    mutations: actualViewport.filter(item => item.mutated),
    assertions: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
  assert.deepEqual(await sourceHashes(), hashes, 'Isolated loaded mutations must leave product Source intact')
  if (['green', 'restored'].includes(mode)) {
    assert.equal(exitCode, 0, 'Original product behavior must pass')
    assert.ok(result.numPassedTests >= 5, 'Real behavior tests must run')
    assert.equal(result.numFailedTests, 0)
  } else {
    assert.notEqual(exitCode, 0)
    assert.ok(actualViewport.some(item => item.mutated && item.loadedSHA256 !== item.sourceSHA256))
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))),
      'Loaded mutation must reach a behavior assertion, not fail compilation')
  }
}
await writeFile(join(proof, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ proof, outsideCallers, phases: receipt.phases.map(({ assertions, mutations, ...phase }) => phase) }))
