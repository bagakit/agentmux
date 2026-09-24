import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const fixture = join(desktop, 'scripts/fixtures/mote-shortcut'), require = createRequire(join(desktop, 'package.json'))
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-shortcut-'))
const evidence = join(repository, '.tmp/mote-shortcut', `attempt-${Date.now()}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = new Map(), styles = new Set()
const result = { schema: 'agentmux.mote-shortcut-proof.v1', passed: false, captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false,
  phases: [], privateProfile: join(privateRoot, 'user-data'), limitations: ['Session snapshots, attachment and recovery use a controlled public API boundary. The second process receives a retained ended Session with fresh native idle-entry evidence, and ordinary initialization asks recovery for its exact original identity; the controlled API returns it as reattachable. These receipts do not claim actual Core/ctxmux Run survival or whole-product acceptance.'], cleanup: null }
await mkdir(evidence, { recursive: true })
try {
  for (const file of [import.meta.filename, join(desktop, 'scripts/probe-process.mjs'), join(fixture, 'main.cjs'), join(fixture, 'index.html')]) inputs.set(file, hash(await readFile(file)))
  const outDir = join(privateRoot, 'renderer')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-mote-proof-source', enforce: 'pre', async load(id) {
      const file = id.split('?')[0]
      // Asset loaders return JavaScript URLs, so bind original file bytes before
      // those loaders run rather than hashing their transformed module wrapper.
      if (file.startsWith(repository + '/') && !file.includes('/node_modules/') && !inputs.has(file)) inputs.set(file, hash(await readFile(file)))
      return null
    }, buildEnd() {
      for (const file of this.getModuleIds()) if (file.startsWith(repository + '/') && file.endsWith('.css')) styles.add(file)
    } }], build: { target: 'esnext', outDir, emptyOutDir: true } })
  for (const file of styles) if (!inputs.has(file)) inputs.set(file, hash(await readFile(file)))
  assert.ok([...inputs.keys()].some(file => file.endsWith('/PmoTeamsTopicEntry.tsx')), 'The actual production entry is compiled')
  assert.ok([...inputs.keys()].some(file => file.endsWith('/App.tsx')), 'The complete production App is compiled')
  const compiled = {}
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name); compiled[relative(outDir, file)] = hash(await readFile(file))
  }
  assert.ok(Object.keys(compiled).length > 0)
  result.inputs = Object.fromEntries([...inputs].map(([file, digest]) => [relative(repository, file), digest]))
  result.compiled = compiled
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const logs = []
    const exit = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), privateRoot, phase, evidence], {
      temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 45000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, `${phase}.log`), logs.join('\n'))
    const native = JSON.parse(await readFile(join(evidence, `${phase}.json`), 'utf8'))
    result.phases.push({ phase, exit, native })
    assert.equal(exit.timedOut, false)
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true)
  }
  assert.equal(new Set(result.phases.map(one => one.native.pid)).size, 2, 'Restart uses two distinct real Electron processes')
  for (const [file, digest] of inputs) assert.equal(hash(await readFile(file)), digest, `Compiled source changed during proof: ${relative(repository, file)}`)
  result.passed = true
  await writeFile(join(evidence, 'review.md'), ['# Mote shortcut screenshots — independent review pending', '',
    'Complete production App, footer, floating workbench and CSS. Two ordinary Electron processes use one private profile. Controlled public Session facts do not prove Core/ctxmux Run survival; original user App and Runs are untouched.', '',
    ...result.phases.flatMap(one => one.native.frames.map(frame => `- ${one.phase} / ${frame.name}: [complete screenshot](${frame.file})`)), '',
    'Review the actual full images against the Mote shortcut SSOT. Capture success is not aesthetic approval. Exact imported source/style and compiled identities are in receipt.json.', ''].join('\n'))
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot)
  result.cleanup = { remaining, privateRootRemoved: false }
  if (remaining.length === 0) { await rm(privateRoot, { recursive: true }); result.cleanup.privateRootRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, receipt: join(evidence, 'receipt.json'), review: join(evidence, 'review.md'), failure: result.failure, cleanup: result.cleanup }))
assert.equal(result.cleanup.remaining.length, 0, 'Only this invocation private processes may remain; preserve the root if cleanup is unconfirmed')
assert.equal(result.passed, true, result.failure?.message)
