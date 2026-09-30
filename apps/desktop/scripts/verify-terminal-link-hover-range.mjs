import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/terminal-link-hover')
const require = createRequire(path.join(desktop, 'package.json'))
const argument = (name, fallback) => process.argv.find(item => item.startsWith(name + '='))?.slice(name.length + 1) ?? fallback
const receiptFile = path.resolve(root, argument('--receipt', 'docs/reviews/evidence/terminal-link-hover-2026-10-04/integrated-receipt.json'))
const evidence = path.dirname(receiptFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(file))])))
if (process.argv.includes('--verify-existing')) {
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'))
  assert.equal(receipt.passed, true); assert.equal(receipt.native.passed, true)
  assert.deepEqual(await hashes(Object.keys(receipt.sourceInputs)), receipt.sourceInputs, 'Integrated compiled inputs changed after native capture')
  for (const frame of receipt.native.frames) assert.equal(sha(await fs.readFile(path.join(evidence, frame.file))), frame.sha256)
  const reviewFile = path.resolve(root, argument('--review', 'docs/reviews/evidence/terminal-link-hover-2026-10-04/independent-review.json'))
  const review = JSON.parse(await fs.readFile(reviewFile, 'utf8'))
  assert.equal(review.status, 'pass'); assert.equal(review.mustFix.length, 0)
  assert.deepEqual(review.frames.map(frame => ({ file: frame.file, sha256: frame.sha256 })), receipt.native.frames.map(frame => ({ file: frame.file, sha256: frame.sha256 })))
  console.log(JSON.stringify({ passed: true, receipt: receiptFile, independentReview: reviewFile, frames: receipt.native.frames.length }))
  process.exit(0)
}
await fs.mkdir(evidence, { recursive: true })
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-link-hover-'))
const sourceInputs = new Map(), compiledModules = new Set()
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild'), electron = require('electron')
const coreFile = path.join(root, 'packages/core/dist/index.js')
const vendor = path.join(root, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch)
const binary = path.join(vendor, 'bin/ctxmuxd'), manifest = JSON.parse(await fs.readFile(path.join(vendor, 'manifest.json'), 'utf8'))
assert.equal(sha(await fs.readFile(binary)), manifest.binaries.find(item => item.name === 'ctxmuxd').sha256)
const selected = [fileURLToPath(import.meta.url), fileURLToPath(new URL('./probe-process.mjs', import.meta.url)), ...['index.html', 'entry.tsx', 'main.cjs', 'program.py', 'xterm-observed.ts'].map(name => path.join(fixture, name)),
  coreFile, binary, path.join(vendor, 'manifest.json'),
  path.join(desktop, 'src/preload/index.ts'), path.join(desktop, 'src/shared/contracts.ts')]
async function runtimeFiles(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
  const file = path.join(directory, entry.name); if (entry.isDirectory()) await runtimeFiles(file); else if (/\.(js|json)$/.test(file)) selected.push(file)
} }
await runtimeFiles(path.join(root, 'packages/core/dist'))
for (const [file, hash] of Object.entries(await hashes(selected))) sourceInputs.set(file, hash)
const receipt = { schema: 'agentmux.terminal-link-hover-integrated.v1', passed: false, captureOnly: true,
  aestheticReview: 'not-performed', userRunTouched: false, sourceInputs: null, compiledInputs: null, native: null }
let child, deadline
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(fixture, 'xterm-observed.ts') }] },
    esbuild: { jsx: 'automatic' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), minify: false, emptyOutDir: true },
    plugins: [{ name: 'source-binding', async transform(_code, id) {
      const file = id.split('?')[0]
      if (path.isAbsolute(file)) { try { sourceInputs.set(file, sha(await fs.readFile(file))); compiledModules.add(file) } catch (error) { if (error.code !== 'ENOENT') throw error } }
    } }] })
  const preload = path.join(privateRoot, 'preload.cjs')
  const preloadBuild = await esbuild.build({ entryPoints: [path.join(desktop, 'src/preload/index.ts')], outfile: preload,
    platform: 'node', bundle: true, format: 'cjs', external: ['electron'], metafile: true, logLevel: 'error' })
  for (const file of Object.keys(preloadBuild.metafile.inputs).map(file => path.resolve(root, file))) sourceInputs.set(file, sha(await fs.readFile(file)))
  receipt.sourceInputs = Object.fromEntries([...sourceInputs].sort(([a], [b]) => a.localeCompare(b)))
  assert.ok(compiledModules.size > 100, 'Actual production component bundle has populated dependencies')
  assert.deepEqual(await hashes(Object.keys(receipt.sourceInputs)), receipt.sourceInputs, 'Source inputs changed while compiling')
  const artifacts = []
  async function collect(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name); if (entry.isDirectory()) await collect(file); else artifacts.push(file)
  } }
  await collect(path.join(privateRoot, 'renderer')); artifacts.push(preload)
  receipt.compiledInputs = await hashes(artifacts)
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'runtime/state'), AGENTMUX_MESSAGE_QUEUE_PATH: path.join(privateRoot, 'messages.ndjson') }; delete env.ELECTRON_RUN_AS_NODE
  await fs.mkdir(path.join(privateRoot, 'runtime/state'), { recursive: true })
  child = spawn(electron, [path.join(fixture, 'main.cjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, preload, evidence, coreFile, binary],
    { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''; child.stderr.on('data', data => { stderr = (stderr + data).slice(-5000) })
  const exit = await Promise.race([new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) }),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Private native hover deadline exceeded')), 90000) })])
  clearTimeout(deadline); receipt.exit = exit
  receipt.native = JSON.parse(await fs.readFile(path.join(evidence, 'native.json'), 'utf8'))
  assert.equal(exit.code, 0, receipt.native.failure + '\n' + stderr); assert.equal(receipt.native.passed, true)
  assert.ok(receipt.native.frames.length >= 8, 'Native new screenshots are nonempty')
  assert.deepEqual(await hashes(Object.keys(receipt.sourceInputs)), receipt.sourceInputs, 'Source inputs changed during native capture')
  assert.deepEqual(await hashes(artifacts), receipt.compiledInputs)
  await fs.rm(path.join(evidence, 'compiled'), { recursive: true, force: true })
  await fs.mkdir(path.join(evidence, 'compiled'), { recursive: true })
  // Keep exact generated input bytes for the independent review; private profile is disposable.
  receipt.preservedCompiled = {}
  for (const file of artifacts) {
    const relative = path.relative(privateRoot, file), saved = path.join(evidence, 'compiled', relative)
    await fs.mkdir(path.dirname(saved), { recursive: true }); await fs.copyFile(file, saved)
    assert.equal(sha(await fs.readFile(saved)), receipt.compiledInputs[file]); receipt.preservedCompiled[saved] = receipt.compiledInputs[file]
  }
  receipt.passed = true
} catch (error) { receipt.failure = error.stack }
finally {
  clearTimeout(deadline)
  // Only this invocation's direct private Electron is ever signaled; user App is untouched.
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
  await stopProbeProcesses(child?.pid ?? 0, privateRoot)
  assert.deepEqual(await listProbeProcesses(child?.pid ?? 0, privateRoot), [], 'Only this private owner may be cleaned; no live descendants remain')
  await fs.rm(privateRoot, { recursive: true, force: true })
  receipt.privateProfileRemoved = true
  await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: receiptFile, failure: receipt.failure }))
if (!receipt.passed) process.exitCode = 1
