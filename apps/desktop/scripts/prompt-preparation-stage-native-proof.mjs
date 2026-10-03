import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { build as viteBuild } from 'vite'
import { runProbeProcess } from './probe-process.mjs'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(import.meta.url)
const receiptPath = process.argv.find(a => a.startsWith('--receipt-path='))?.slice(15)
const probeRoot = process.argv.find(a => a.startsWith('--probe-root='))?.slice(13)
for (const arg of process.argv.slice(2)) assert.ok(arg === '--prompt-preparation-stage' || arg.startsWith('--receipt-path=') || arg.startsWith('--probe-root='), 'Unknown finite phase option')
assert.ok(receiptPath && probeRoot && process.env.AGENTMUX_PROMPT_PREPARATION_BUILD_RECEIPT)
const buildPath = process.env.AGENTMUX_PROMPT_PREPARATION_BUILD_RECEIPT, productBuildBytes = await readFile(buildPath), productBuild = JSON.parse(productBuildBytes.toString('utf8'))
assert.match(productBuild.sourceCommit, /^[a-f0-9]{40}$/, 'Actual phase product Source commit is present')
assert.equal(productBuild.privateRoot, root); assert.equal(await realpath(probeRoot), root)
const sha = b => createHash('sha256').update(b).digest('hex')
const fixture = join(root, 'apps/desktop/scripts/fixtures/prompt-preparation-stage'), owned = join(root, 'apps/desktop/phase-capture'), evidence = dirname(receiptPath)
await mkdir(owned); await mkdir(evidence, { recursive: true })
const buildSnapshotPath = join(evidence, 'phase-product-build-at-worker.json')
await writeFile(buildSnapshotPath, productBuildBytes)
const preload = join(root, 'apps/desktop/out/preload/index.cjs')
assert.equal(sha(await readFile(preload)), productBuild.compiled['apps/desktop/out/preload/index.cjs'])
const report = { schema: 'agentmux.prompt-preparation-stage.gui-proof.v1', passed: false,
  captureOnly: true, aestheticReview: 'not-performed', promptPreparationStage: { passed: false },
  nativeHealthyRunQualified: false, corePhaseProducerQualified: false, productSourceRef: productBuild.sourceCommit,
  productBuild: { path: buildSnapshotPath, originalInputPath: buildPath, sha256: sha(productBuildBytes), sourceCommit: productBuild.sourceCommit, sourceMode: productBuild.sourceMode }, inputTransport: 'actual Electron IPC + production preload + production registerIpc + production RuntimeController.submitPrompt + finite SDK refusal producer',
  userRunTouched: false, sharedSourceWritten: false, loaded: {}, transforms: [], compiled: {} }
const sourceRecord = async path => {
  const bytes = await readFile(path), key = relative(root, path)
  if (productBuild.sources[key]) assert.equal(sha(bytes), productBuild.sources[key], 'Actual bounded phase consumes captured Source ' + key)
  report.loaded[key] = sha(bytes); return bytes
}
let failure
try {
  const esbuildEntry = require.resolve('esbuild', { paths: [join(root, 'packages/core')] })
  const { build: bundleMain } = require(esbuildEntry)
  const esbuildRealPath = await realpath(esbuildEntry)
  report.bundleToolConsumer = { declaredOwner: 'packages/core/package.json', entry: esbuildRealPath, sha256: sha(await readFile(esbuildRealPath)) }
  const xterm = require.resolve('@xterm/xterm'), wrapper = join(owned, 'record-xterm.mjs')
  report.xterm = { path: await realpath(xterm), sha256: sha(await readFile(xterm)), scope: 'GUI/xterm availability only; no actual PTY/healthyRun claim' }
  await writeFile(wrapper, `import xterm from ${JSON.stringify(xterm)};export class Terminal extends xterm.Terminal{constructor(...args){super(...args);const entries=globalThis.resultReadyTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}dispose(){this.probeIdentity.disposed=true;return super.dispose()}}`)
  await viteBuild({ configFile: false, root: fixture, base: './', logLevel: 'error',
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: wrapper }] },
    plugins: [{ name: 'finite-phase-actual-source', enforce: 'pre', async transform(bytes, id) {
      if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?')) return
      await sourceRecord(id)
      if (id === join(root, 'apps/desktop/scripts/fixtures/result-ready-input-continuity/entry.tsx')) {
        const start = bytes.indexOf("Object.defineProperty(window, 'agentmux',"), end = bytes.indexOf('const openFileDiff =', start)
        assert.ok(start >= 0 && end > start, 'Exactly the old test-owned Git mock replacement exists')
        const transformed = bytes.slice(0, start) + bytes.slice(end)
        report.transforms.push({ path: relative(root, id), sourceSha256: sha(bytes), resultSha256: sha(transformed),
          declaration: 'Remove test-owned window.agentmux Git-mock replacement only; real production preload namespace remains exposed. Git action not exercised.' })
        return transformed
      }
    } }], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir: join(owned, 'renderer'), emptyOutDir: true, minify: false, commonjsOptions: { include: [/node_modules/, /xterm/] } } })
  const main = join(owned, 'main.mjs')
  const mainBuild = await bundleMain({ entryPoints: [join(fixture, 'main.ts')], outfile: main, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    packages: 'external', metafile: true, alias: { '@agentmux/client-ui/pasted-images': join(root, 'packages/client-ui/src/lib/pasted-images.ts') } })
  for (const path of Object.keys(mainBuild.metafile.inputs)) { const actual = resolve(path); if (actual.startsWith(root + '/') && !actual.includes('/node_modules/')) await sourceRecord(actual) }
  report.compiled.main = sha(await readFile(main)); report.compiled.preload = sha(await readFile(preload))
  for (const path of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/shared/session-input-result.ts', 'apps/desktop/src/renderer/src/store.ts']) {
    assert.match(report.loaded[path] ?? '', /^[a-f0-9]{64}$/, 'Actual owning production Source was loaded ' + path)
    assert.match(productBuild.sources[path] ?? '', /^[a-f0-9]{64}$/, 'Captured owning production Source is present ' + path)
    assert.equal(report.loaded[path], productBuild.sources[path], 'Original owning production Source loaded ' + path)
  }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(owned, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(owned, 'runtime'),
    AGENTMUX_STATE_DIRECTORY: join(owned, 'runtime/state'), AGENTMUX_SPATIAL_STATE_STORE: join(owned, 'runtime/state/spatial.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(owned, 'queue.ndjson') }
  for (const key of Object.keys(env)) if (/^AGENTMUX_(?:CLI|ENV|AGENT_SESSION(?:_.*)?|AGENT_CAPABILITY|HOOK(?:_.*)?|PROVIDER_ID|EXECUTOR_ID|LIFECYCLE_OPERATION_ID)$/.test(key)) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  const lines = [], outcome = await runProbeProcess(require('electron'), [main, join(owned, 'renderer/index.html'), owned, evidence, preload],
    { cwd: root, temporaryRoot: owned, env, timeoutMs: 90_000, onLine: line => lines.push(line) })
  await writeFile(join(evidence, 'phase-electron.log'), lines.join('\n')); report.outcome = outcome
  const actual = JSON.parse(await readFile(join(evidence, 'render.json'), 'utf8')); report.actual = actual
  assert.equal(outcome.timedOut, false); assert.equal(outcome.exitCode, 0); assert.equal(actual.passed, true)
  assert.equal(actual.frames.length, 9); report.passed = true; report.promptPreparationStage.passed = true
} catch (e) { failure = e; report.failure = { name: e.name, message: e.message, stack: e.stack } }
finally { await writeFile(receiptPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, receiptPath, captureOnly: true, failure: failure?.message })) }
if (failure) process.exitCode = 1
