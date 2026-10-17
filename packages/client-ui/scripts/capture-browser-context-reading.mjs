import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runProbeProcess, listProbeProcesses } from '../../../apps/desktop/scripts/probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'packages/core/package.json'))
const { build } = require('esbuild'), output = join(root, '.tmp/browser-context-reading-visual', randomUUID())
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-context-reading-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.browser-context-reading-visual.v1', passed: false, source: {}, frames: [], independentVisualReview: 'pending',
  scope: 'Candidate production shared readers with actual Desktop tokens, compiled and mounted in private Electron. Fixed Core records only; not full Desktop shell, native Browser, upstream model or delivery qualification.' }
let server
await mkdir(output, { recursive: true })
try {
  const core = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8')), alias = {}
  for (const [key, spec] of Object.entries(core.exports)) {
    const target = typeof spec === 'string' ? spec : spec.import
    if (target?.startsWith('./dist/')) alias[key === '.' ? core.name : core.name + key.slice(1)] = join(root, 'packages/core', target.replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
  }
  const assets = join(output, 'assets'); await mkdir(assets)
  const built = await build({ absWorkingDir: root, entryPoints: ['packages/client-ui/test/fixtures/browser-context-reading/main.tsx'], outdir: assets,
    bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', alias, metafile: true, logLevel: 'warning',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  for (const file of Object.keys(built.metafile.inputs)) receipt.source[relative(root, resolve(root, file))] = hash(await readFile(resolve(root, file)))
  await writeFile(join(output, 'index.html'), '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/main.css"></head><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>')
  server = createServer(async (request, response) => {
    try {
      const path = resolve(output, '.' + new URL(request.url, 'http://127.0.0.1').pathname)
      assert.ok(path.startsWith(output + '/')); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }
      response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' }); response.end(await readFile(path))
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(join(root, 'apps/desktop/package.json'))('electron')
  receipt.process = await runProbeProcess(electron, [join(root, 'packages/client-ui/scripts/browser-context-reading-electron.cjs'),
    `http://127.0.0.1:${server.address().port}/index.html`, privateRoot, output], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 45000 })
  assert.equal(receipt.process.exitCode, 0, 'Private actual reader capture must complete')
  const actual = JSON.parse(await readFile(join(output, 'actual.json'), 'utf8'))
  assert.equal(actual.passed, true, JSON.stringify(actual.failure)); assert.equal(actual.frames.length, 4)
  for (const frame of actual.frames) { const bytes = await readFile(join(output, frame.file)); assert.ok(bytes.length > 1000); frame.sha256 = hash(bytes) }
  for (const [file, digest] of Object.entries(receipt.source)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Captured source changed')
  receipt.frames = actual.frames; receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  if (server) await new Promise(resolveClose => server.close(resolveClose))
  const remaining = await listProbeProcesses(-1, privateRoot)
  if (!remaining.length) await rm(privateRoot, { recursive: true })
  receipt.cleanup = { remaining, removed: remaining.length === 0 }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(relative(root, output))
}
