import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), fixture = join(root, 'apps/desktop/scripts/fixtures/input-waiting-control')
const evidence = join(root, '.local/channel-protocol/T-038/visual/runs', randomUUID())
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-original-input-'))
const outDir = join(privateRoot, 'renderer'), require = createRequire(import.meta.url)
const hash = value => createHash('sha256').update(value).digest('hex')
const mode = process.argv.includes('--repair-results') ? 'repair-results' : 'all'
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', mode, loaded: {}, styles: {}, compiled: {}, cleanup: {} }
await mkdir(evidence, { recursive: true })
try {
  const { build } = await import('vite')
  const exports = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8')).exports
  const alias = Object.entries(exports).map(([name, target]) => ({
    find: new RegExp('^@agentmux/core' + (name === '.' ? '' : name.slice(1)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: join(root, 'packages/core', target.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    resolve: { dedupe: ['react', 'react-dom'], alias }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' }, build: { outDir, emptyOutDir: true },
    plugins: [{ name: 'original-waiting-capture-inputs', enforce: 'pre', transform(code, file) {
      if (!file.includes('?') && file.startsWith(root + '/') && !file.includes('/node_modules/')) receipt.loaded[relative(root, file)] = hash(code)
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + '/') && file.endsWith('.css')) receipt.styles[relative(root, file)] = hash(await readFile(file))
    } }] })
  for (const file of ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'apps/desktop/src/renderer/src/components/OriginalInputWaitingControl.tsx', 'packages/client-ui/src/components/AgentComposer.tsx']) assert.ok(receipt.loaded[file], 'Actual product is compiled: ' + file)
  assert.ok(receipt.styles['apps/desktop/src/renderer/src/styles/original-input-waiting.css'])
  for (const file of await readdir(outDir, { recursive: true })) {
    try { receipt.compiled[file] = hash(await readFile(join(outDir, file))) } catch (error) { if (error.code !== 'EISDIR') throw error }
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const log = []
  receipt.execution = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), privateRoot, evidence, mode],
    { cwd: root, env, timeoutMs: 90_000, onLine: line => log.push(line) })
  await writeFile(join(evidence, 'process.log'), log.join('\n'))
  const render = JSON.parse(await readFile(join(evidence, 'render.json'), 'utf8'))
  receipt.render = { path: relative(root, join(evidence, 'render.json')), sha256: hash(await readFile(join(evidence, 'render.json'))) }
  assert.equal(receipt.execution.exitCode, 0, JSON.stringify(render.failure)); assert.equal(render.passed, true)
  receipt.images = Object.fromEntries(await Promise.all(render.frames.map(async frame => [relative(root, join(evidence, frame.file)), hash(await readFile(join(evidence, frame.file)))])))
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
} finally {
  const group = receipt.execution?.originalPid
  if (group) {
    const remaining = await listProbeProcesses(group, privateRoot)
    if (remaining.length) await stopProbeProcesses(group, privateRoot)
    receipt.cleanup.remaining = await listProbeProcesses(group, privateRoot)
  }
  if (!receipt.cleanup.remaining?.length) { await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateCompiledAndProfileRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(relative(root, join(evidence, 'receipt.json')))
}
