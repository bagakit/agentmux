import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'
import { radixOverlayAliases } from '../../../../../packages/client-ui/scripts/radix-overlay-aliases.ts'
import { currentWorkspaceAliases } from '../session-takeover/workspace-aliases.mjs'

const fixture = import.meta.dirname, root = resolve(fixture, '../../../../..')
const require = createRequire(join(root, 'apps/desktop/package.json')), { build } = await import(require.resolve('vite'))
const coreRequire = createRequire(join(root, 'packages/core/package.json'))
export async function runTakeoverFlow(requestedEvidence) {
const evidence = requestedEvidence ? resolve(root, requestedEvidence) : join(root, '.tmp/takeover-flow', 'visual-' + randomUUID())
const temporary = await mkdtemp(join(tmpdir(), 'amux-takeover-flow-')), compiled = join(temporary, 'renderer')
const hash = value => createHash('sha256').update(value).digest('hex'), inputs = {}, logs = []
const record = async id => { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/') && existsSync(file)) inputs[relative(root, file)] = hash(await readFile(file)) }
const receipt = { schema: 'agentmux.takeover-flow-native.v1', qualification: 'public-takeover-renderer-recovery-v1',
  passed: false, captureOnly: false, aestheticReview: 'not-performed', inputs, frames: [], processes: [],
  boundary: 'Production SessionPane, original menu, shared Stage and persistence in two independent Electron processes with one real Chromium profile and the actual Core spatial file owner. Controlled content inputs and exact same-Run Native snapshots are fixture protocol facts, not Host files or vendor execution. Controlled public creation replies exercise the first ten scenes. The next process only initializes and reads the restored full request; its controlled backend has no admitted creation record and remains unknown. This does not prove real Native execution, Host content, accepted Core admission or installed App recovery. No user Session or packaging operation.' }
await mkdir(evidence, { recursive: true })
try {
  const { aliases, manifests } = await currentWorkspaceAliases(root)
  await Promise.all([...manifests, import.meta.filename, join(fixture, 'main.cjs'), join(fixture, 'preload.cjs')].map(record))
  await symlink(join(root, 'packages/core/node_modules'), join(temporary, 'node_modules'))
  const { build: nodeBuild } = await import(coreRequire.resolve('esbuild'))
  const spatialModule = join(temporary, 'spatial-store.mjs')
  const identityManifest = JSON.parse(await readFile(join(root, 'packages/identity/package.json'), 'utf8'))
  const generatedIdentity = await realpath(resolve(root, 'packages/identity', identityManifest.exports['./runtime-source'].import))
  const spatialBuild = await nodeBuild({ absWorkingDir: root, entryPoints: [join(root, 'packages/core/src/spatial-state.ts')],
    outfile: spatialModule, platform: 'node', format: 'esm', bundle: true, packages: 'external',
    plugins: [{ name: 'original-identity-source', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\/identity(?:\/runtime-source)?$/ }, ({ path }) => path === '@agentmux/identity'
        ? { path: join(root, 'packages/identity/src/index.ts') } : { path: generatedIdentity, external: true })
    } }], metafile: true, logLevel: 'silent' })
  receipt.coreSpatialInputs = {}
  for (const name of Object.keys(spatialBuild.metafile.inputs)) {
    const file = await realpath(resolve(root, name))
    assert.ok(file.startsWith(root + '/') && !file.includes('/dist/'), 'The spatial owner compiles this checkout source')
    receipt.coreSpatialInputs[relative(root, file)] = hash(await readFile(file)); await record(file)
  }
  receipt.coreSpatialModuleSha256 = hash(await readFile(spatialModule))
  receipt.generatedIdentitySource = { file: relative(root, generatedIdentity), sha256: hash(await readFile(generatedIdentity)),
    qualification: 'Existing generated-only identity source-text artifact; it has no source counterpart and is not rebuilt or replaced by this fixture.' }
  const observe = { name: 'original-takeover-source-renderer', enforce: 'pre', async transform(_source, id) { await record(id) },
    async generateBundle() { await Promise.all(this.getWatchFiles().map(record)) } }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: [...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement })), { find: /^@agentmux\/core$/u, replacement: join(fixture, 'core-exports.ts') }, ...aliases, { find: 'node:util', replacement: join(root, 'apps/desktop/scripts/lib/browser-util.mjs') }, { find: 'node:crypto', replacement: join(root, 'apps/desktop/scripts/lib/browser-crypto.mjs') }] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [observe], worker: { format: 'es', plugins: () => [observe] }, build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  for (const file of ['SessionPane.tsx', 'SessionTakeoverSurface.tsx', 'AgentRegionHeader.tsx', 'AgentMenuContent.tsx', 'session-takeover.ts', 'session-takeover.css', 'store.ts'])
    assert.ok(Object.keys(inputs).some(path => path.endsWith('/' + file)), 'The actual flow consumer is compiled: ' + file)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const mode of ['first', 'second']) {
    const outcome = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(compiled, 'index.html'), temporary, evidence, mode, spatialModule],
      { temporaryRoot: temporary, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(mode + ': ' + line) })
    const actual = JSON.parse(await readFile(join(evidence, mode + '-actual.json'), 'utf8'))
    receipt.processes.push({ mode, outcome, actual })
    assert.equal(outcome.exitCode, 0, JSON.stringify(actual.error)); assert.equal(actual.passed, true)
    receipt.frames.push(...await Promise.all(actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) }))))
  }
  assert.notEqual(receipt.processes[0].actual.processId, receipt.processes[1].actual.processId)
  assert.equal(receipt.processes[0].actual.frames.length, 15, 'The ten original flow scenes and five local default scenes are retained')
  assert.equal(receipt.frames.length, 16, 'A fresh Renderer also shows the restored original intent')
  assert.equal(receipt.processes[1].actual.restart.noWorkfaceReseed, true)
  assert.equal(receipt.processes[1].actual.restart.noReplay, true)
  receipt.sourceDrift = []
  for (const [path, sourceHash] of Object.entries(inputs)) if (hash(await readFile(join(root, path))) !== sourceHash) receipt.sourceDrift.push(path)
  // The compiled private candidate remains fixed while peers work. Only changes
  // to the exercised UI/selection and spatial-file owner invalidate this proof;
  // retain other source drift rather than rerunning for unrelated services.
  const critical = ['SessionTakeoverSurface.tsx', 'AgentExecutorPicker.tsx', 'SelectionField.tsx', 'WindowOverlayHost.tsx',
    'agent-new-tab-destination.ts', 'session-takeover.ts', 'session-takeover.css', 'spatial-state.ts', 'spatial-graph.ts', 'spatial-store-codec.ts']
  receipt.stableSourceScope = critical
  receipt.drift = receipt.sourceDrift.filter(path => critical.some(name => path.endsWith('/' + name)))
  assert.deepEqual(receipt.drift, [], 'Exercised selection/UI and spatial file owners remain current; other compiled input versions are retained in sourceDrift')
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  receipt.cleanup = { remaining: await listProbeProcesses(-1, temporary), removed: false }
  if (receipt.cleanup.remaining.length === 0) { await rm(temporary, { recursive: true, force: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log('Takeover flow visual evidence: ' + relative(root, evidence))
}
if (!receipt.passed) throw new Error('Public Takeover Renderer recovery failed; evidence: ' + relative(root, evidence) + ': ' + receipt.error?.message)
return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try { await runTakeoverFlow(process.argv.find(value => value.startsWith('--evidence='))?.slice('--evidence='.length)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
