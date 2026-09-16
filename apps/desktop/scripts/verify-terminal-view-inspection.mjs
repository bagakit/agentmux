import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/terminal-view-inspection')
const require = createRequire(path.join(desktop, 'package.json'))
const coreRequire = createRequire(path.join(root, 'packages/core/package.json'))
const { build: viteBuild } = await import(pathToFileURL(require.resolve('vite')).href)
const { build: esbuild } = await import(pathToFileURL(coreRequire.resolve('esbuild')).href)
const privateRoot = await fs.mkdtemp('/tmp/agentmux-terminal-inspect-')
const receiptPath = path.join(root, '.tmp/terminal-view-inspection-last.json')
const coreFile = path.join(root, 'packages/core/dist/index.js')
const productPreload = path.join(desktop, 'out/preload/index.cjs')
const pkg = path.dirname(require.resolve('@xterm/xterm/package.json'))
const critical = [
  ...['control.ts', 'control-host.ts'].map((name) => path.join(root, 'packages/core/src', name)),
  ...['index.js', 'control.js', 'control-host.js', 'agentmux.js'].map((name) => path.join(root, 'packages/core/dist', name)),
  path.join(desktop, 'src/main/control-ipc-bridge.ts'), path.join(desktop, 'src/preload/index.ts'), productPreload,
  path.join(desktop, 'src/renderer/src/components/TerminalView.tsx'),
  path.join(desktop, 'src/renderer/src/components/SessionPane.tsx'),
  path.join(desktop, 'src/renderer/src/store.ts'),
  ...['terminal-view-observation.ts', 'control.ts', 'control-api.ts', 'api.ts'].map((name) => path.join(desktop, 'src/renderer/src/lib', name)),
  path.join(pkg, 'package.json'), path.join(pkg, 'lib/xterm.mjs'),
  path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts'),
  ...['entry.tsx', 'main.cjs', 'preload.cjs', 'index.html'].map((name) => path.join(fixture, name)),
  fileURLToPath(import.meta.url), path.join(desktop, 'scripts/probe-process.mjs'),
  require('electron'), require.resolve('electron/package.json')
]
const hashes = async (files) => Object.fromEntries(await Promise.all(files.map(async (file) => [file,
  createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
const result = { schema: 'agentmux.terminal-view-inspection-delivery.v1', passed: false,
  before: null, after: null, native: null, exit: null, artifactHashes: null,
  userRunTouched: false, runtimeCreated: false,
  cleanup: { remaining: null, rootRemoved: false, errors: [] },
  limitations: ['Private synthetic replay exercises the actual UI and Control transport; no user or model Run is created.',
    'This proves read-only projection inspection, not physical touchpad behavior or the user scroll root cause.',
    'Selected source, distribution, probe and Electron inputs are bound; this is not a manifest of every Vite transitive dependency.'] }
let child, timer
try {
  result.before = await hashes(critical)
  await viteBuild({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"',
      __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
    esbuild: { jsx: 'automatic' },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, minify: false } })
  const bridgeFile = path.join(privateRoot, 'bridge.cjs')
  await esbuild({ entryPoints: [path.join(desktop, 'src/main/control-ipc-bridge.ts')], outfile: bridgeFile,
    platform: 'node', format: 'cjs', bundle: true, logLevel: 'error',
    alias: { '@agentmux/core/control': path.join(root, 'packages/core/dist/control.js') } })
  const artifacts = [bridgeFile]
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await collect(file)
      else artifacts.push(file)
    }
  }
  await collect(path.join(privateRoot, 'renderer'))
  assert.ok(artifacts.length > 1)
  result.artifactHashes = await hashes(artifacts)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(require('electron'), [path.join(fixture, 'main.cjs'),
    path.join(privateRoot, 'renderer/index.html'), privateRoot, bridgeFile, coreFile,
    path.join(fixture, 'preload.cjs'), productPreload], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  result.pid = child.pid
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-16384) })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  result.exit = await Promise.race([exited, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Private terminal inspection deadline exceeded')), 35000)
  })])
  clearTimeout(timer)
  result.native = JSON.parse(await fs.readFile(path.join(privateRoot, 'native.json'), 'utf8'))
  if (result.exit.code !== 0) result.stderr = stderr
  assert.equal(result.exit.code, 0, result.native.failure)
  assert.equal(result.native.passed, true, result.native.failure)
  assert.equal(result.native.cases.length, 5)
  result.after = await hashes(critical)
  assert.deepEqual(result.after, result.before, 'Inputs changed during actual inspection proof')
  result.passed = true
} catch (error) { result.failure = error.stack }
finally {
  clearTimeout(timer)
  if (child?.pid) {
    try { await stopProbeProcesses(child.pid, privateRoot) }
    catch (error) { result.cleanup.errors.push(String(error)); result.passed = false }
    try { result.cleanup.remaining = await listProbeProcesses(child.pid, privateRoot) }
    catch (error) { result.cleanup.errors.push(String(error)); result.passed = false }
  } else result.cleanup.remaining = []
  if (result.cleanup.remaining?.length === 0 && result.cleanup.errors.length === 0) {
    try { await fs.rm(privateRoot, { recursive: true, force: true }); result.cleanup.rootRemoved = true }
    catch (error) { result.cleanup.errors.push(String(error)); result.passed = false }
  } else result.passed = false
  if (!result.cleanup.rootRemoved) result.passed = false
  await fs.mkdir(path.dirname(receiptPath), { recursive: true })
  await fs.writeFile(receiptPath, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ passed: result.passed, pid: result.pid, exit: result.exit,
    cases: result.native?.cases.length, cleanup: result.cleanup, failure: result.failure, receipt: receiptPath }))
}
if (!result.passed) process.exitCode = 1
