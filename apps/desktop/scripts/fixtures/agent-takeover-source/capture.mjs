import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'
import { radixOverlayAliases } from '../../../../../packages/client-ui/scripts/radix-overlay-aliases.ts'
import { currentWorkspaceAliases } from '../session-takeover/workspace-aliases.mjs'

const fixture = import.meta.dirname, root = resolve(fixture, '../../../../..')
const require = createRequire(join(root, 'apps/desktop/package.json')), { build } = await import(require.resolve('vite'))
const evidence = join(root, '.tmp/agent-takeover-source', 'visual-' + randomUUID())
const temporary = await mkdtemp(join(tmpdir(), 'amux-takeover-source-')), compiled = join(temporary, 'renderer')
const hash = value => createHash('sha256').update(value).digest('hex'), inputs = {}, logs = []
const record = async id => { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/') && existsSync(file)) inputs[relative(root, file)] = hash(await readFile(file)) }
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', inputs, frames: [],
  boundary: 'Production WorkspaceAgentRow, original AgentInformationReader Source page, shared metadata consumer, Store and original styles in a private Electron Renderer. Typed controlled read responses; actual pointer, pin, resize, scroll, pagination and theme actions. No user Session, native Agent, backend lifecycle, installed App or packaging claim.' }
await mkdir(evidence, { recursive: true })
try {
  const { aliases, manifests } = await currentWorkspaceAliases(root)
  await Promise.all([...manifests, import.meta.filename, join(fixture, 'main.cjs')].map(record))
  const observe = { name: 'original-takeover-source-renderer', enforce: 'pre', async transform(_source, id) { await record(id) },
    async generateBundle() { await Promise.all(this.getWatchFiles().map(record)) } }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: [...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement })), ...aliases] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [observe], worker: { format: 'es', plugins: () => [observe] }, build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  for (const file of ['AgentInformationReader.tsx', 'AgentTakeoverRelations.tsx', 'WorkspaceAgentRow.tsx', 'AgentInformationDetails.tsx', 'focus-context.css', 'store.ts'])
    assert.ok(Object.keys(inputs).some(path => path.endsWith('/' + file)), 'The actual Source consumer is compiled: ' + file)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(compiled, 'index.html'), temporary, evidence],
    { temporaryRoot: temporary, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0, JSON.stringify(receipt.actual.error)); assert.equal(receipt.actual.passed, true)
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  assert.equal(receipt.frames.length, 10, 'The affected Source scenes are nonempty')
  receipt.drift = []
  for (const [path, sourceHash] of Object.entries(inputs)) if (hash(await readFile(join(root, path))) !== sourceHash) receipt.drift.push(path)
  assert.deepEqual(receipt.drift, [], 'Current loaded source remains unchanged through this capture')
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  receipt.cleanup = { remaining: await listProbeProcesses(-1, temporary), removed: false }
  if (receipt.cleanup.remaining.length === 0) { await rm(temporary, { recursive: true, force: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log('Agent Source visual evidence: ' + relative(root, evidence))
}
