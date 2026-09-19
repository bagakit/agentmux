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
const fixture = path.join(desktop, 'scripts/fixtures/space-tree-alignment')
const proof = path.resolve(process.argv[2] ?? path.join(root, '.tmp/space-tree-alignment'))
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-space-tree-'))
let inputs = [fileURLToPath(import.meta.url), path.join(desktop, 'scripts/probe-process.mjs'),
  ...['main.cjs', 'entry.mjs', 'index.html'].map(name => path.join(fixture, name)),
  ...(await fs.readdir(path.join(desktop, 'src/renderer/src/styles'))).filter(name => name.endsWith('.css')).map(name => path.join(desktop, 'src/renderer/src/styles', name))]
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [path.relative(root, file), createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
const result = { passed: false, inputs: null, native: null, cleanup: null }
await fs.mkdir(proof, { recursive: true })
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-tree-source', buildEnd() {
      inputs = [...new Set([...inputs, ...this.getModuleIds()].filter(file => file.startsWith(root + '/') && !file.includes('/node_modules/') && !file.includes('?')))]
    } }],
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  result.inputs = await hashes()
  assert.ok(Object.keys(result.inputs).some(file => file.endsWith('/WorkspaceSidebar.tsx')))
  assert.ok(Object.keys(result.inputs).some(file => file.endsWith('/SpaceTopicsTree.tsx')))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  result.exit = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 25000 })
  result.native = JSON.parse(await fs.readFile(path.join(privateRoot, 'native.json'), 'utf8'))
  for (const name of ['default.png', 'compact.png', 'dense.png', 'narrow.png', 'scrolled.png', 'collapsed.png']) {
    await fs.copyFile(path.join(privateRoot, name), path.join(proof, name)).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  assert.equal(result.exit.timedOut, false)
  assert.equal(result.exit.exitCode, 0, result.native.failure?.message)
  assert.equal(result.native.passed, true)
  assert.deepEqual(await hashes(), result.inputs)
  result.passed = true
} catch (error) { result.failure = { message: error.message, stack: error.stack } }
finally {
  result.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), rootRemoved: false }
  if (!result.cleanup.remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); result.cleanup.rootRemoved = true }
  await fs.writeFile(path.join(proof, 'receipt.json'), JSON.stringify(result, null, 2))
}
assert.equal(result.cleanup.remaining.length, 0)
assert.equal(result.cleanup.rootRemoved, true)
assert.equal(result.passed, true, result.failure?.message)
console.log(JSON.stringify({ passed: true, pid: result.native.pid, inputs: Object.keys(result.inputs).length, cleanup: result.cleanup }))
