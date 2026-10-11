import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative, extname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { products as allProducts, fixtures } from './fixtures/space-context-clarity/inputs.mjs'

const root = resolve(import.meta.dirname, '../../..')
const fixture = resolve(import.meta.dirname, 'fixtures/space-context-clarity')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const args = process.argv.slice(2), knowledgeOnly = args.includes('--knowledge-only'), detailsOnly = args.includes('--details-only')
assert.ok(args.filter(value => value.startsWith('--')).every(value => ['--knowledge-only', '--details-only'].includes(value)))
assert.ok(!(knowledgeOnly && detailsOnly))
const destinations = args.filter(value => !value.startsWith('--'))
assert.ok(destinations.length <= 1)
const products = knowledgeOnly ? allProducts.slice(0, 2) : allProducts
const evidenceRoot = resolve(root, '.bagakit/feature-tracker/space-context-clarity')
await mkdir(evidenceRoot, { recursive: true })
const evidence = destinations[0] ? resolve(destinations[0]) : await mkdtemp(resolve(evidenceRoot, 'capture-'))
await mkdir(evidence, { recursive: true })
assert.equal((await readdir(evidence)).length, 0, 'Use a new empty directory; retain original receipts and images')
const privateRoot = await mkdtemp(resolve(tmpdir(), 'agentmux-space-context-'))
const compiled = resolve(privateRoot, 'compiled')
const guardedHarness = [relative(root, fileURLToPath(import.meta.url)), 'apps/desktop/scripts/probe-process.mjs',
  ...fixtures.map(name => relative(root, resolve(fixture, name)))]
const diskBudget = 1_000_000_000
const receipt = { schema: 'agentmux.space-context-clarity-capture.v1', passed: false, captureOnly: true,
  mode: detailsOnly ? 'details-only' : knowledgeOnly ? 'knowledge-only' : 'integrated',
  aestheticReview: 'not-performed', guardedProducts: products, sourceBefore: {}, sourceAfter: {}, compiledInputs: {}, outputs: {}, frames: [],
  scope: 'Current production Sidebar, Dock, Topic Navigation, Knowledge, Mote Files, Store and complete CSS. Configured topology and protocol-validated transport observations; logical fixture directories are not actual disk/Git/Runtime evidence. No installed App, native Main/preload, Session recovery or restart claim.',
  storage: { budgetBytes: diskBudget, sourceCopies: 0, dependencyInstalls: 0 } }
let server
async function treeBytes(directory) {
  let size = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) size += await treeBytes(file)
    else if (entry.isFile()) size += (await stat(file)).size
  }
  return size
}
try {
  for (const file of products) receipt.sourceBefore[file] = hash(await readFile(resolve(root, file)))
  receipt.harness = Object.fromEntries(await Promise.all(guardedHarness.map(async file => [file, hash(await readFile(resolve(root, file)))])))
  const core = JSON.parse(await readFile(resolve(root, 'packages/core/package.json'), 'utf8'))
  const aliases = Object.entries(core.exports).map(([key, value]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: resolve(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  await build({ configFile: false, logLevel: 'error', root: fixture, worker: { format: 'es' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
    resolve: { alias: [{ find: /^@agentmux\/git\/types$/, replacement: resolve(root, 'packages/git/src/types.ts') },
      { find: /^@agentmux\/git$/, replacement: resolve(root, 'packages/git/src/index.ts') }, ...aliases],
    conditions: ['browser', 'import', 'production', 'default'] },
    build: { outDir: compiled, emptyOutDir: true, target: 'esnext', minify: false },
    plugins: [{ name: 'space-context-input-identity', enforce: 'pre', transform(source, id) {
      if (id.startsWith(root + sep) && !id.includes('/node_modules/') && !id.includes('?') && /\.(tsx?|css|mjs)$/.test(id)) {
        assert.ok(source.length, 'Empty actual compilation input: ' + id)
        receipt.compiledInputs[relative(root, id)] = hash(source)
      }
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + sep) && !file.includes('/node_modules/') && file.endsWith('.css')) {
        const bytes = await readFile(file); assert.ok(bytes.length); receipt.compiledInputs[relative(root, file)] = hash(bytes)
      }
    } }] })
  for (const file of products) assert.equal(receipt.compiledInputs[file], receipt.sourceBefore[file], 'Owning input must actually compile: ' + file)
  for (const file of ['apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx', 'apps/desktop/src/renderer/src/components/TopicNavigationPanel.tsx',
    'apps/desktop/src/renderer/src/components/WorkspaceFilesTool.tsx', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/styles/index.css']) assert.ok(receipt.compiledInputs[file], 'Actual consumer is missing: ' + file)
  for (const name of ['entry.tsx', 'host.css']) {
    const file = relative(root, resolve(fixture, name))
    assert.equal(receipt.compiledInputs[file], receipt.harness[file], 'Compiled fixture changed during build: ' + file)
  }
  async function recordOutputs(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) await recordOutputs(file)
      else {
        const bytes = await readFile(file); assert.ok(bytes.length)
        receipt.outputs[relative(compiled, file)] = { sha256: hash(bytes), bytes: bytes.length }
      }
    }
  }
  await recordOutputs(compiled)
  assert.ok(Object.keys(receipt.outputs).some(file => file.endsWith('.js')))
  assert.ok(Object.keys(receipt.outputs).some(file => file.endsWith('.css')))
  receipt.storage.compiledBytes = await treeBytes(compiled)
  assert.ok(receipt.storage.compiledBytes < diskBudget, 'Scoped compilation exceeded private disk budget')
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' }
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://fixture.test').pathname)
      const file = resolve(compiled, pathname === '/' ? 'index.html' : pathname.slice(1))
      assert.ok(file.startsWith(compiled + sep)); const bytes = await readFile(file)
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }); response.end(bytes)
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !/^(AGENTMUX_|CTXMUX_)/.test(key)))
  receipt.process = await runProbeProcess(require('electron'), [resolve(fixture, 'main.cjs'),
    `http://127.0.0.1:${server.address().port}/`, privateRoot, evidence, receipt.mode], { cwd: root, env, timeoutMs: 120_000 })
  const actual = JSON.parse(await readFile(resolve(evidence, 'actual.json'), 'utf8'))
  receipt.actual = actual
  for (const frame of actual.frames) receipt.frames.push({ ...frame, sha256: hash(await readFile(resolve(evidence, frame.file))) })
  assert.equal(actual.passed, true, JSON.stringify(actual.failure))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.process.exitSignal, null); assert.equal(receipt.process.timedOut, false)
  assert.equal(receipt.frames.length, detailsOnly ? 4 : knowledgeOnly ? 12 : 18)
  for (const url of actual.loaded) if (/\.(js|css)$/.test(new URL(url).pathname)) assert.ok(receipt.outputs[new URL(url).pathname.slice(1)], 'Loaded bundle was not bound')
  assert.ok(actual.loaded.some(url => url.endsWith('.js'))); assert.ok(actual.loaded.some(url => url.endsWith('.css')))
  for (const file of products) receipt.sourceAfter[file] = hash(await readFile(resolve(root, file)))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Owning source changed; recapture the same scenes')
  for (const [file, digest] of Object.entries(receipt.harness)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Harness changed: ' + file)
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  if (error.probe) receipt.process = error.probe
  process.exitCode = 1
} finally {
  if (server) await new Promise(done => server.close(done))
  try {
    for (const file of products) receipt.sourceAfter[file] = hash(await readFile(resolve(root, file)))
    if (JSON.stringify(receipt.sourceAfter) !== JSON.stringify(receipt.sourceBefore)) {
      receipt.sourceDrift = true; receipt.passed = false; process.exitCode = 1
    }
  } catch (error) { receipt.sourceCheckFailure = error.message; receipt.passed = false; process.exitCode = 1 }
  try {
    await stopProbeProcesses(-1, privateRoot)
    const remaining = await listProbeProcesses(-1, privateRoot)
    receipt.storage.privateBytesAtCleanup = await treeBytes(privateRoot)
    receipt.storage.evidenceBytes = await treeBytes(evidence)
    receipt.storage.withinBudget = receipt.storage.privateBytesAtCleanup + receipt.storage.evidenceBytes < diskBudget
    receipt.cleanup = { remaining, privateRootRemoved: remaining.length === 0 }
    if (!remaining.length) await rm(privateRoot, { recursive: true, force: true })
    if (!receipt.storage.withinBudget) { receipt.passed = false; process.exitCode = 1 }
  } catch (error) { receipt.cleanup = { error: error.message, privateRootRemoved: false }; receipt.passed = false; process.exitCode = 1 }
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure, pendingIndependentVisualReview: true }))
}
