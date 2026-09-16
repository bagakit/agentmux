import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/renderer-session-events')
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = require('electron')
const preload = path.join(desktop, 'out/preload/index.cjs')
const expectation = 'routed'
assert.ok(expectation === 'baseline' || expectation === 'routed', 'Explicit baseline or routed expectation is required')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-bridge-probe-'))
const hash = file => fs.readFile(file).then(data => createHash('sha256').update(data).digest('hex'))
const selected = [fileURLToPath(import.meta.url), ...['main.cjs', 'entry.mjs', 'index.html'].map(name => path.join(fixture, name)),
  path.join(desktop, 'scripts/probe-process.mjs'), path.join(desktop, 'src/preload/index.ts'), preload,
  path.join(desktop, 'src/renderer/src/lib/api.ts'), path.join(desktop, 'src/renderer/src/lib/session-events.ts'),
  path.join(desktop, 'src/shared/contracts.ts'), ...['agent-provider-id.js', 'agent-session-id.js', 'agent-launch-option.js', 'control.js'].map(name => path.join(root, 'packages/core/dist', name)), electron]
const hashes = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, await hash(file)])))
const result = { expectation, passed: false, before: null, after: null, artifacts: null, native: null,
  exit: null, cleanup: { remaining: null, rootRemoved: false } }
try {
  result.before = await hashes(selected)
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, minify: false } })
  const artifacts = []
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await collect(file)
      else artifacts.push(file)
    }
  }
  await collect(path.join(privateRoot, 'renderer'))
  assert.ok(artifacts.length > 0)
  result.artifacts = await hashes(artifacts)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  result.exit = await runProbeProcess(electron, [path.join(fixture, 'main.cjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, preload, expectation],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 15_000 })
  result.native = JSON.parse(await fs.readFile(path.join(privateRoot, 'native-result.json'), 'utf8'))
  result.after = await hashes(selected)
  assert.deepEqual(result.after, result.before, 'Selected actual source/compiled inputs must stay unchanged during this probe')
  assert.equal(result.exit.timedOut, false)
  assert.equal(result.exit.exitCode, 0)
  assert.equal(result.native.passed, true)
  result.passed = true
} catch (error) {
  result.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
  result.cleanup.remaining = await listProbeProcesses(-1, privateRoot)
  if (result.cleanup.remaining.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); result.cleanup.rootRemoved = true }
  await fs.writeFile(path.join(root, '.tmp/renderer-input-response-last.json'), JSON.stringify(result, null, 2))
}
assert.equal(result.cleanup.remaining.length, 0, 'All owned private probe processes must be stopped')
assert.equal(result.cleanup.rootRemoved, true)
assert.equal(result.passed, true, result.failure?.message)
console.log(JSON.stringify({ expectation, passed: result.passed, deliveries: result.native.renderer.deliveries.length,
  identities: result.native.renderer.backingBufferIdentities, receivedBytes: result.native.renderer.receivedBytes,
  cleanup: result.cleanup, receipt: path.join(root, '.tmp/renderer-input-response-last.json') }))
