import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, extname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from '../../../apps/desktop/scripts/probe-process.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const evidence = resolve(root, '.tmp/markdown-code-copy')
const privateRoot = await mkdtemp(resolve(tmpdir(), 'agentmux-code-copy-'))
const compiled = resolve(privateRoot, 'compiled')
const hash = data => createHash('sha256').update(data).digest('hex')
const source = {}
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', source, frames: [],
  scope: 'Actual ConversationMessage and AgentMarkdown with the original code block, highlighter worker, theme and an explicit controlled clipboard adapter; isolated Electron, no system clipboard or installed Host claim.' }
let server
await mkdir(evidence, { recursive: true })
try {
  await build({ configFile: false, logLevel: 'error', worker: { format: 'es' }, root: resolve(root, 'packages/client-ui/test/fixtures/code-copy'),
    esbuild: { jsx: 'automatic' }, build: { outDir: compiled, emptyOutDir: true, target: 'esnext' },
    plugins: [{ name: 'code-copy-input-identity', enforce: 'pre', transform(code, id) {
      if (id.startsWith(root + sep) && !id.includes('/node_modules/') && !id.includes('?') && /\.(tsx?|css)$/.test(id)) source[relative(root, id)] = hash(code)
    }, async generateBundle() {
      // PostCSS follows local @imports without passing every leaf through transform.
      for (const path of this.getWatchFiles()) if (path.startsWith(root + sep) && !path.includes('/node_modules/') && path.endsWith('.css')) source[relative(root, path)] = hash(await readFile(path))
    } }] })
  assert.ok(source['packages/client-ui/src/styles/markdown.css'], 'The actual owning Markdown CSS must be captured')
  for (const name of ['capture-code-copy.mjs', 'code-copy-electron.cjs']) {
    const path = resolve(root, 'packages/client-ui/scripts', name); source[relative(root, path)] = hash(await readFile(path))
  }
  assert.ok(Object.keys(source).length > 5)
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://fixture.test').pathname)
      const path = resolve(compiled, pathname === '/' ? 'index.html' : pathname.slice(1))
      assert.ok(path.startsWith(compiled + sep))
      response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' }); response.end(await readFile(path))
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [resolve(root, 'packages/client-ui/scripts/code-copy-electron.cjs'),
    `http://127.0.0.1:${server.address().port}/`, privateRoot, evidence],
  { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60_000 })
  assert.equal(receipt.process.exitCode, 0, 'Code copy scene failed')
  const actual = JSON.parse(await readFile(resolve(evidence, 'actual.json'), 'utf8'))
  assert.equal(actual.passed, true, JSON.stringify(actual.failure))
  assert.ok(actual.frames.length >= 6)
  for (const frame of actual.frames) frame.sha256 = hash(await readFile(resolve(evidence, frame.file)))
  receipt.frames = actual.frames; receipt.operations = actual.operations
  for (const [path, digest] of Object.entries(source)) assert.equal(hash(await readFile(resolve(root, path))), digest, 'Source changed during capture: ' + path)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  if (server) await new Promise(done => server.close(done))
  // The probe owner has already terminated its isolated process before this directory is removed.
  const remaining = await listProbeProcesses(-1, privateRoot)
  receipt.cleanup = { remaining, removed: remaining.length === 0 }
  if (!remaining.length) await rm(privateRoot, { recursive: true, force: true })
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ captured: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure, pendingIndependentVisualReview: true }))
}
