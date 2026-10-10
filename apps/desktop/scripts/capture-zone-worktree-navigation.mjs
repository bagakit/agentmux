import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative, extname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { products } from './fixtures/zone-worktree-navigation/inputs.mjs'

const root = resolve(import.meta.dirname, '../../..')
const fixture = resolve(import.meta.dirname, 'fixtures/zone-worktree-navigation')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(resolve(root, '.tmp'), { recursive: true })
const evidence = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(resolve(root, '.tmp/zone-worktree-navigation-'))
await mkdir(evidence, { recursive: true })
assert.equal((await readdir(evidence)).length, 0, 'Use a new empty evidence directory; never overwrite original frames')
const privateRoot = await mkdtemp(resolve(tmpdir(), 'agentmux-zone-capture-'))
const compiled = resolve(privateRoot, 'compiled')
const receipt = { schema: 'agentmux.zone-worktree-navigation-capture.v1', passed: false, captureOnly: true,
  aestheticReview: 'not-performed', scope: 'Actual current Renderer Dock, Store, catalog projection and complete product CSS. Controlled Git/file observations and configured logical fixture paths; no real Git, Core Runtime, user data, Main, restart or installed App proof.',
  guardedProducts: products, sourceBefore: {}, sourceAfter: {}, compiledInputs: {}, outputs: {}, frames: [] }
let server
await mkdir(evidence, { recursive: true })
try {
  for (const file of products) receipt.sourceBefore[file] = hash(await readFile(resolve(root, file)))
  const core = JSON.parse(await readFile(resolve(root, 'packages/core/package.json'), 'utf8'))
  const aliases = Object.entries(core.exports).map(([key, value]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: resolve(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  await build({ configFile: false, logLevel: 'error', root: fixture, worker: { format: 'es' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
    resolve: { alias: [{ find: /^@agentmux\/git\/types$/, replacement: resolve(root, 'packages/git/src/types.ts') },
      { find: /^@agentmux\/git$/, replacement: resolve(root, 'packages/git/src/index.ts') }, ...aliases], conditions: ['browser', 'import', 'production', 'default'] },
    build: { outDir: compiled, emptyOutDir: true, target: 'esnext', minify: false },
    plugins: [{ name: 'zone-navigation-input-identity', enforce: 'pre', transform(source, id) {
      if (id.startsWith(root + sep) && !id.includes('/node_modules/') && !id.includes('?') && /\.(tsx?|css|mjs)$/.test(id)) {
        assert.ok(source.length, 'Empty compilation input: ' + id)
        receipt.compiledInputs[relative(root, id)] = hash(source)
      }
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + sep) && !file.includes('/node_modules/') && file.endsWith('.css')) {
        const bytes = await readFile(file); assert.ok(bytes.length)
        receipt.compiledInputs[relative(root, file)] = hash(bytes)
      }
    } }] })
  for (const file of products) assert.equal(receipt.compiledInputs[file], receipt.sourceBefore[file], 'Owning product must actually compile: ' + file)
  for (const name of ['entry.tsx', 'host.css', 'index.html', 'main.cjs', 'inputs.mjs', 'README.md']) {
    receipt.compiledInputs[relative(root, resolve(fixture, name))] = hash(await readFile(resolve(fixture, name)))
  }
  receipt.harness = { [relative(root, resolve(import.meta.dirname, 'capture-zone-worktree-navigation.mjs'))]: hash(await readFile(new URL(import.meta.url))),
    'apps/desktop/scripts/probe-process.mjs': hash(await readFile(resolve(import.meta.dirname, 'probe-process.mjs'))),
    ...Object.fromEntries(['entry.tsx', 'host.css', 'index.html', 'main.cjs', 'inputs.mjs', 'README.md'].map(name => {
      const file = relative(root, resolve(fixture, name)); return [file, receipt.compiledInputs[file]]
    })) }
  async function recordOutputs(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name)
      if (entry.isDirectory()) await recordOutputs(file)
      else { const bytes = await readFile(file); assert.ok(bytes.length); receipt.outputs[relative(compiled, file)] = hash(bytes) }
    }
  }
  await recordOutputs(compiled)
  assert.ok(Object.keys(receipt.outputs).some(file => file.endsWith('.css')))
  assert.ok(Object.keys(receipt.outputs).some(file => file.endsWith('.js')))
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
    `http://127.0.0.1:${server.address().port}/`, privateRoot, evidence], { cwd: root, env, timeoutMs: 120_000 })
  const actual = JSON.parse(await readFile(resolve(evidence, 'actual.json'), 'utf8'))
  receipt.actual = actual
  for (const frame of actual.frames) receipt.frames.push({ ...frame, sha256: hash(await readFile(resolve(evidence, frame.file))) })
  assert.equal(actual.passed, true, JSON.stringify(actual.failure))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.process.exitSignal, null); assert.equal(receipt.process.timedOut, false)
  assert.ok(receipt.frames.length >= 4)
  for (const resource of actual.loaded) if (/\.(js|css)$/.test(new URL(resource).pathname)) {
    const file = new URL(resource).pathname.slice(1)
    assert.ok(receipt.outputs[file], 'Loaded unrecorded bundle: ' + file)
  }
  assert.ok(actual.loaded.some(url => url.endsWith('.css'))); assert.ok(actual.loaded.some(url => url.endsWith('.js')))
  for (const file of products) receipt.sourceAfter[file] = hash(await readFile(resolve(root, file)))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Owning product changed during capture; recapture the same scenes')
  for (const [file, digest] of Object.entries(receipt.harness)) assert.equal(hash(await readFile(resolve(root, file))), digest)
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
  if (error.probe) receipt.process = error.probe
  process.exitCode = 1
} finally {
  if (server) await new Promise(done => server.close(done))
  for (const file of products) receipt.sourceAfter[file] = hash(await readFile(resolve(root, file)))
  if (JSON.stringify(receipt.sourceBefore) !== JSON.stringify(receipt.sourceAfter)) {
    receipt.sourceDrift = true; receipt.passed = false; process.exitCode = 1
  }
  try {
    await stopProbeProcesses(-1, privateRoot)
    const remaining = await listProbeProcesses(-1, privateRoot)
    receipt.cleanup = { remaining, privateRootRemoved: remaining.length === 0 }
    if (!remaining.length) await rm(privateRoot, { recursive: true, force: true })
  } catch (error) { receipt.cleanup = { error: error.message, privateRootRemoved: false }; receipt.passed = false; process.exitCode = 1 }
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure, pendingIndependentVisualReview: true }))
}
