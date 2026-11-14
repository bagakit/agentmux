import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyPackagedPreviews } from './verify-packaged-previews.mjs'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite'))('esbuild')
const output = join(root, '.tmp/editor-extensions-package'); await mkdir(output, { recursive: true })
const graph = await build({ absWorkingDir: root, entryPoints: ['packages/editor-extensions/src/catalog.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'error' })
const inputs = Object.keys(graph.metafile.inputs)
assert.ok(inputs.length >= 2, 'The catalog consumes its real metadata owner')
assert.ok(inputs.some(path => path.endsWith('note-format-metadata.js')), 'Original Core metadata leaf is consumed')
assert.equal(inputs.some(path => /node_modules|\/ui\/|\/engines\/|\/books\//.test(path)), false, 'Metadata discovery loads no parser, UI or engine')
assert.ok(graph.outputFiles[0].contents.length < 32 * 1024, 'Actual bundled catalog stays small')
const vitest = join(root, 'node_modules/.bin/vitest'), config = 'packages/editor-extensions/vitest.engines.config.mts'
const run = (name, args, env = {}) => {
  const report = join(output, name + '.json'), result = spawnSync(vitest, ['run', '--config', config, '--reporter=json', '--outputFile=' + report, ...args],
    { cwd: root, env: { ...process.env, NODE_ENV: 'test', ...env }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return { name, report, status: result.status, stdout: result.stdout, stderr: result.stderr }
}
const green = run('green', []); assert.equal(green.status, 0, green.stderr || green.stdout)
const greenReport = JSON.parse(await readFile(green.report, 'utf8')); assert.ok(greenReport.numPassedTests > 0)
const hit = join(output, 'mutation-loaded.txt')
const red = run('catalog-disconnected', ['-t', 'packaged capabilities reach existing File and language consumers'],
  { EDITOR_EXTENSION_MUTATION: 'catalog-disconnected', EDITOR_EXTENSION_HITS: hit })
const redReport = JSON.parse(await readFile(red.report, 'utf8'))
assert.notEqual(red.status, 0); assert.equal(redReport.numFailedTests, 1)
assert.match(JSON.stringify(redReport), /AssertionError/); assert.match(await readFile(hit, 'utf8'), /src\/catalog.ts/)
const restored = run('restored', ['-t', 'packaged capabilities reach existing File and language consumers'])
assert.equal(restored.status, 0, restored.stderr || restored.stdout)
const previews = await verifyPackagedPreviews(async folder => {
  const consumer = run('archived-notebook', ['file-format-integration.test.tsx', '-t', 'analysis.ipynb'],
    { EDITOR_EXTENSION_ARCHIVE: folder })
  const result = JSON.parse(await readFile(consumer.report, 'utf8'))
  assert.equal(consumer.status, 0, JSON.stringify(result.testResults.flatMap(file => file.assertionResults)
    .filter(test => test.status === 'failed').map(test => ({ name: test.title, failures: test.failureMessages }))))
  assert.ok(result.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'passed' && test.fullName.includes('analysis.ipynb')),
    'Desktop Source and the archived Notebook preview must read the active input')
})
const receipt = { passed: true, previews, inputs, catalogBytes: graph.outputFiles[0].contents.length, tests: greenReport.numPassedTests,
  mutation: { name: red.name, failedTests: redReport.numFailedTests, loaded: true }, restored: true }
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify(receipt))
