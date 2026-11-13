import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const output = resolve(root, process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? '.tmp/editor-public-consumer')
await mkdir(output, { recursive: true })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const files = [
  'packages/editor-extensions/src/catalog.ts', 'packages/core/src/note-format-metadata.ts', 'packages/core/dist/note-format-metadata.js',
  ...['agentmux', 'agentmux-cli-commands', 'public-rpc', 'public-rpc-client', 'public-rpc-service', 'control-host', 'space-control-parser'].flatMap(name => [`packages/core/src/${name}.ts`, `packages/core/dist/${name}.js`]),
  'packages/core/bin/amux', 'apps/desktop/src/renderer/src/store.ts',
  ...['workface-file-open', 'workface-file-view', 'file-region-presentation', 'file-workbench-state'].map(name => `apps/desktop/src/renderer/src/lib/${name}.ts`),
  'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx', 'apps/desktop/src/renderer/src/components/FilePreviewPane.tsx',
  'apps/desktop/test/editor-extension-public-consumer.test.tsx', 'apps/desktop/test/vitest.editor-public.config.mts',
  'apps/desktop/test/helpers/workface-control-fixture.ts', 'apps/desktop/test/helpers/workface-file-fixture.ts',
  'apps/desktop/scripts/verify-editor-public-consumer.mjs',
]
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, sha256(await readFile(join(root, file)))])))
const receipt = { passed: false, sources, mutations: [], scope: 'Compiled CLI and typed SDK → actual Unix JSON-RPC service/control codec → Desktop executeControl → original File owner and hidden FileSurfaceView. Content decoding remains unconfirmed here.' }
const hits = join(output, 'mutation-loaded.ndjson'); await writeFile(hits, '')
const run = async (name, mutation, testName) => {
  const report = join(output, name + '-tests.json'), product = join(output, name + '-public.json')
  const child = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', 'apps/desktop/test/vitest.editor-public.config.mts', '--reporter=json', '--outputFile=' + report, ...(testName ? ['--testNamePattern', testName] : [])],
    { cwd: root, env: { ...globalThis.process.env, EDITOR_PUBLIC_RECEIPT: product, EDITOR_PUBLIC_MUTATION: mutation ?? '', EDITOR_PUBLIC_HITS: hits }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const parsed = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(parsed.numTotalTests, 14, 'All eight binary paths, FB2 source/draft evidence, typed SDK and CLI discovery actually run')
  assert.equal(parsed.numPassedTests + parsed.numFailedTests, testName ? 1 : 14, 'The intended nonempty public consumer actually executes')
  assert.equal(parsed.testResults.length, 1, 'No other worktree or test copy owns this proof')
  return { name, exitCode: child.status, passed: parsed.numPassedTests, failed: parsed.numFailedTests,
    assertionFailures: parsed.testResults.flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'failed').every(test => test.failureMessages.some(message => /AssertionError/.test(message))),
    report, product, stderr: child.stderr }
}
try {
  const catalog = await build({ absWorkingDir: root, entryPoints: ['packages/editor-extensions/src/catalog.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'error' })
  const inputs = Object.keys(catalog.metafile.inputs), bytes = catalog.outputFiles[0].contents.length
  assert.ok(inputs.length >= 2 && inputs.some(file => file.endsWith('note-format-metadata.js')), 'Actual catalog consumes the inert original metadata leaf')
  assert.ok(!inputs.some(file => /node_modules|\/engines\/|\/books\/|\/ui\/|\/pdf\//.test(file)), 'Discovery pulls no parser, reader, UI, formatter or worker engine')
  assert.ok(bytes < 32 * 1024, 'Actual bundled metadata catalog is lightweight')
  receipt.catalog = { inputs, bytes }
  receipt.baseline = await run('baseline'); assert.equal(receipt.baseline.exitCode, 0, receipt.baseline.stderr)
  for (const name of ['catalog-disconnected', 'readonly-file-only', 'view-modes', 'false-decoder-ready', 'editable-book-modes', 'book-default-open', 'fb2-dirty-default', 'dirty-without-buffer']) {
    const selected = ['editable-book-modes', 'book-default-open'].includes(name) ? 'discovers FB2' : name === 'fb2-dirty-default' ? 'existing dirty FB2.*binary=false' : name === 'dirty-without-buffer' ? 'does not invent an editable FB2' : 'opens chapter\\.epub'
    const red = await run(name, name, selected)
    assert.notEqual(red.exitCode, 0, 'The public consumer must fail with ' + name)
    assert.ok(red.failed > 0 && red.assertionFailures, 'A real public behavior assertion, not a module/setup failure, must turn RED')
    receipt.mutations.push(red)
  }
  receipt.loaded = (await readFile(hits, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const mutation of receipt.mutations) assert.ok(receipt.loaded.some(hit => hit.name === mutation.name && hit.anchors === 1 && hit.sha256 === sources[hit.file]), mutation.name + ' loaded the current exact source')
  receipt.restored = await run('restored'); assert.equal(receipt.restored.exitCode, 0, receipt.restored.stderr)
  const publicResults = JSON.parse(await readFile(receipt.restored.product, 'utf8'))
  assert.equal(publicResults.receipts.length, 14, 'Actual public receipts and hidden File consumers are retained')
  receipt.passed = true
} catch (error) { receipt.failure = error.stack ?? String(error) }
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ passed: receipt.passed, output, tests: receipt.baseline?.passed, catalogBytes: receipt.catalog?.bytes, mutations: receipt.mutations.map(({name, failed}) => ({name, failed})), failure: receipt.failure }))
process.exitCode = receipt.passed ? 0 : 1
