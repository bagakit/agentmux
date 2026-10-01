import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, extname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbeProcess, listProbeProcesses } from '../../../apps/desktop/scripts/probe-process.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const gallery = resolve(root, 'apps/desktop/dist/gallery')
const evidence = resolve(root, '.tmp/agentmux-private-mobile-client/shared-ui/visual')
const privateRoot = await mkdtemp(resolve(tmpdir(), 'agentmux-client-ui-'))
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const hash = data => createHash('sha256').update(data).digest('hex')
const receipt = { schema: 'agentmux.shared-conversation-visual-capture.v1', passed: false,
  scope: 'Actual compiled Desktop component gallery in a private Electron profile. Shared UI and Desktop adapter; no mobile auth, device, user App or healthy Run claim.',
  independentVisualReview: 'pending', source: {}, compiled: {}, commands: [], stderr: [] }
let server
async function files(folder) {
  const result = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else result.push(path)
  }
  return result
}
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  receipt.commands.push({ argv: ['pnpm', ...args], exitCode: result.status, output: result.stdout + result.stderr })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}
await mkdir(evidence, { recursive: true })
try {
  for (const path of [...await files(resolve(root, 'packages/client-ui/src')),
    ...['gallery-main.tsx', 'components/WorkflowComponentGallery.tsx', 'components/ObservationSurfaceGallery.tsx', 'components/DesktopClientUiProvider.tsx', 'styles/index.css'].map(path => resolve(root, 'apps/desktop/src/renderer/src', path))]) {
    receipt.source[relative(root, path)] = hash(await readFile(path))
  }
  run(['--filter', '@agentmux/client-ui', 'build'])
  run(['--filter', '@agentmux/desktop', 'build:gallery'])
  for (const path of await files(gallery)) receipt.compiled[relative(root, path)] = hash(await readFile(path))
  assert.ok(Object.keys(receipt.compiled).some(path => path.endsWith('.js')))
  assert.ok(Object.keys(receipt.compiled).some(path => path.endsWith('.css')))
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      assert.ok(pathname.startsWith('/agentmux-gallery/'))
      const path = resolve(gallery, pathname.slice('/agentmux-gallery/'.length))
      assert.ok(path.startsWith(gallery + sep))
      response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' })
      response.end(await readFile(path))
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/agentmux-gallery/gallery.html`
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [resolve(root, 'packages/client-ui/scripts/shared-conversation-electron.cjs'), url, privateRoot, evidence],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 45_000, onLine: line => receipt.stderr.push(line) })
  assert.equal(receipt.process.exitCode, 0, 'Private Electron capture failed')
  const actual = JSON.parse(await readFile(resolve(evidence, 'actual.json'), 'utf8'))
  assert.equal(actual.passed, true, JSON.stringify(actual.failure))
  assert.equal(actual.frames.length, 4)
  for (const frame of actual.frames) {
    const bytes = await readFile(resolve(evidence, frame.file))
    assert.ok(bytes.length > 1000)
    frame.sha256 = hash(bytes)
  }
  receipt.frames = actual.frames
  for (const [path, digest] of Object.entries(receipt.source)) assert.equal(hash(await readFile(resolve(root, path))), digest, 'Source changed during capture: ' + path)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  if (server) await new Promise(done => server.close(done))
  const remaining = await listProbeProcesses(-1, privateRoot)
  receipt.cleanup = { privateRoot, remaining, removed: false, evidencePreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ captured: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure, pendingIndependentVisualReview: true }))
}
