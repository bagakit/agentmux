import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative, extname, sep, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/agent-collaboration-graph')
const scriptPath = fileURLToPath(import.meta.url)
const compiling = process.argv[2] === '--compile'
const verifying = process.argv[2] === '--verify'
const scenario = process.argv[4] === '--scenario' ? process.argv[5] : 'readability'
assert.ok(['readability', 'perception', 'perception-scale'].includes(scenario), 'Use a declared capture scenario')
assert.ok(compiling ? process.argv.length === 5 : ['--evidence', '--verify'].includes(process.argv[2]) && process.argv[3] && (process.argv.length === 4 || process.argv.length === 6 && process.argv[4] === '--scenario'), 'Use --evidence <new private evidence directory> or --verify <completed evidence directory> [--scenario perception|perception-scale]')
if (verifying) {
  // Join the exact completed native observation once; never recapture or turn a
  // failed observation green. A changed source, harness or PNG requires new evidence.
  const directory = resolve(process.argv[3]), receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'))
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.equal(receipt.schema, 'agentmux.collaboration-graph-capture.v1')
  assert.equal(receipt.scenario, 'focus-map-' + scenario)
  assert.equal(receipt.phase, 'complete'); assert.equal(receipt.capturedPass, true); assert.equal(receipt.actual?.passed, true)
  assert.equal(receipt.process?.exitConfirmed, true); assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.process.timedOut, false)
  assert.deepEqual(receipt.changedInputs, []); assert.deepEqual(receipt.changedHarness, [])
  assert.deepEqual(receipt.actual.failures, []); assert.deepEqual(receipt.actual.rendererErrors, [])
  assert.ok(receipt.actual.checks?.length && receipt.actual.checks.every(check => check.passed === true))
  for (const name of ['initial-gui-entry-keeps-accurate-context-and-full-width', 'source-cli-original-app-admission-and-dom-inspect', 'focus-list-map-and-original-return', ...(scenario === 'perception-scale' ? ['perception-original-large-world-and-consumer-cost', 'terrain-original-nesting-fold-and-exact-reveal', 'terrain-native-continuous-lod-and-selection-cost', 'terrain-held-reader-keyboard-and-motion-choice'] : [])]) assert.ok(receipt.actual.checks.some(check => check.name === name && check.passed === true), 'Missing actual native check: ' + name)
  for (const key of ['inputs', 'harness']) {
    const entries = Object.entries(receipt[key] ?? {}); assert.ok(entries.length, 'Nonempty exact ' + key)
    for (const [file, sha] of entries) { const target = resolve(root, file); assert.ok(target.startsWith(root + sep)); assert.equal(digest(await readFile(target)), sha, 'Changed candidate ' + key + ': ' + file) }
  }
  assert.ok(receipt.frames?.length)
  assert.deepEqual(receipt.frames.map(({ sha256, ...frame }) => frame), receipt.actual.frames)
  for (const frame of receipt.frames) { const target = resolve(directory, frame.file); assert.ok(target.startsWith(directory + sep)); assert.equal(digest(await readFile(target)), frame.sha256, 'Changed native frame: ' + frame.file) }
  if (scenario === 'perception-scale') {
    assert.ok(receipt.actual.perceptionScale?.input?.nodes >= 240)
    assert.equal(receipt.actual.perceptionScale.boxes.agents, receipt.actual.perceptionScale.input.nodes)
    for (const label of ['terrain-parent-readable-destination', 'terrain-nested-dark', 'terrain-folded-dark', 'terrain-expanded-dark', 'terrain-deep-agent-revealed', 'terrain-lod-0-319', 'terrain-lod-0-321', 'terrain-lod-0-44', 'terrain-lod-0-46', 'terrain-lod-0-62', 'terrain-lod-0-72', 'terrain-lod-0-82', 'terrain-lod-light', 'terrain-narrow-light', 'terrain-narrow-dark', 'terrain-held-reader-overview', 'terrain-held-focus-overview', 'terrain-motion-off-static']) assert.ok(receipt.frames.some(frame => frame.label === label), 'Missing complete native frame: ' + label)
    const samples = receipt.actual.terrainLod.samples
    assert.ok(samples.length >= 7 && samples.find(sample => sample.target === .319)?.actual < .32 && samples.find(sample => sample.target === .321)?.actual > .32, 'Actual camera samples cross the glyph boundary')
  }
  console.log(JSON.stringify({ passed: true, evidence: directory, receiptSHA256: digest(await readFile(join(directory, 'receipt.json'))), nativeChecks: receipt.actual.checks.length, completeFrames: receipt.frames.length, aestheticReview: 'separate-independent-artifact', restart: 'separate-runtime-artifact' }))
  process.exit(0)
}
const evidence = resolve(process.argv[compiling ? 4 : 3]); await mkdir(evidence, { recursive: true })
if (!compiling) assert.equal((await readdir(evidence)).length, 0, 'Keep prior captures; use an empty evidence directory')
const privateRoot = compiling ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'amux-collaboration-capture-')), compiled = join(privateRoot, 'compiled')
assert.ok(privateRoot.startsWith(join(tmpdir(), 'amux-collaboration-capture-')) && !relative(tmpdir(), privateRoot).includes(sep), 'Compilation stays in its own private capture root')
const require = createRequire(join(desktop, 'package.json')), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = {}, foreignWorkspaceSources = {}, isolated = [], instrumented = [], logs = []
const receipt = { schema: 'agentmux.collaboration-graph-capture.v1', scenario: 'focus-map-' + scenario, capturedPass: false, captureOnly: true, aestheticReview: 'not-performed',
  boundary: 'Current source App, actual initialization/Store, Focus List/Map and original Space workfaces, original area owners, Graph, shared Focus cards and sole AgentInformationPreviewHost/Reader. The distribution includes permanent empty areas, uneven populated groups, isolated members and observed dense cross-area relations. Only platform API facts and unrelated PTY/Monaco painting are controlled. Private synthetic identities, events and content; no live Core lifecycle, Provider, Runtime, real messages, restart or installed-product claim.' }
let compilationWrites = Promise.resolve()
function publishCompilation(value) {
  return compilationWrites = compilationWrites.then(async () => {
    const file = join(evidence, 'compilation.json'), next = file + '.next'
    await writeFile(next, JSON.stringify(value) + '\n'); await rename(next, file)
  })
}
async function compileRenderer() {
  let transformed = 0
  const core = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8'))
  const aliases = Object.entries(core.exports).map(([key, entry]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: resolve(root, 'packages/core', entry.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))
  // Resolve these UI/layout browser exports against this exact candidate, even
  // when dependencies are shared with another worktree. Core and identity use
  // their explicit source aliases below; third-party dependencies stay original.
  for (const name of ['client-ui', 'layout']) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'))
    const entries = Object.entries(manifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
    for (const [key, entry] of entries) {
      const target = typeof entry === 'string' ? entry : entry.browser ?? entry.types ?? entry.import
      const specifier = '@agentmux/' + name + (key === '.' ? '' : key.slice(1))
      const pattern = specifier.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')
      aliases.push({ find: new RegExp('^' + pattern + '$'), replacement: resolve(root, 'packages', name, target).replace('*', '$1') })
    }
  }
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const sourcePlugin = { name: 'collaboration-source-and-unrelated-paint', enforce: 'pre', async transform(source, id) {
      const file = id.split('?')[0]
      if (!file.startsWith(root + sep) && !file.includes('/node_modules/') && /\/(?:packages|apps)\/[^/]+\/src\/.+\.(?:tsx?|jsx?|css)$/.test(file)) foreignWorkspaceSources[relative(root, file)] = hash(await readFile(file))
      if (!file.startsWith(root + sep) || file.includes('/node_modules/') || !/\.(tsx?|css|mjs)$/.test(file)) return
      if (id.includes('?')) { sources[relative(root, file)] = hash(await readFile(file)); return }
      sources[relative(root, id)] = hash(source)
      if (++transformed % 200 === 0) {
        const progress = { phase: 'transforming', transformed }
        await publishCompilation(progress)
        process.stdout.write(JSON.stringify(progress) + '\n')
      }
      if (id === join(desktop, 'src/renderer/src/lib/focus-context.ts')) {
        const ts = require('typescript'), ast = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true)
        const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'agentContextForSession')
        assert.equal(functions.length, 1, 'Instrument the one original context owner')
        const position = functions[0].body.getStart(ast) + 1
        const counter = `;{const start=performance.now(),sample=(globalThis.__collaborationCaptureMetrics??={contextCalls:0,contextIds:{},contextCounterMS:0});sample.contextCalls++;sample.contextIds[session.id]=(sample.contextIds[session.id]??0)+1;sample.contextCounterMS+=performance.now()-start;}`
        const effective = source.slice(0, position) + counter + source.slice(position)
        instrumented.push({ file: relative(root, id), originalSHA256: hash(source), effectiveSHA256: hash(effective), boundary: 'Counters only; original context function body and result remain intact' })
        return effective
      }
      const component = id.slice(id.lastIndexOf('/') + 1)
      if (component === 'SessionPane.tsx') {
        isolated.push({ file: relative(root, id), boundary: 'Unrelated PTY/Agent painting only; original Store draft' })
        return `import{useAppStore}from${JSON.stringify(join(desktop, 'src/renderer/src/store.ts'))};export function SessionPane({sessionId}){const draft=useAppStore(s=>s.agentComposerDrafts[sessionId]??'');return <section data-fixture-session={sessionId} style={{height:'100%',display:'flex',flexDirection:'column',gap:16,padding:24,color:'var(--text-2)'}}><small>Original Agent workface</small><strong style={{color:'var(--text)'}}>{sessionId}</strong><textarea aria-label="Original unsent reply" readOnly value={draft} style={{flex:1,minHeight:80,resize:'none',color:'var(--text)',background:'var(--surface-1)',border:'1px solid var(--line)',padding:16,borderRadius:8}}/></section>}`
      }
      if (component === 'EditorPane.tsx' || component === 'GitBranchDiffPane.tsx') {
        isolated.push({ file: relative(root, id), boundary: 'Unused Monaco painting; no file Region in scene' })
        return `export function ${component.slice(0, -4)}(){return null}`
      }
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + sep) && !file.includes('/node_modules/') && file.endsWith('.css')) sources[relative(root, file)] = hash(await readFile(file))
    } }
  await build({ configFile: false, logLevel: 'error', root: fixture, worker: { format: 'es', plugins: () => [sourcePlugin] },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
    resolve: { alias: [...aliases, { find: '@agentmux/identity', replacement: join(root, 'packages/identity/src/index.ts') }], conditions: ['browser', 'import', 'production', 'default'], dedupe: ['react', 'react-dom'] },
    build: { outDir: compiled, emptyOutDir: true, target: 'esnext', minify: false },
    plugins: [sourcePlugin] })
}
if (compiling) {
  await publishCompilation({ phase: 'starting', transformed: 0 })
  try {
    await compileRenderer()
    await publishCompilation({ phase: 'complete', inputs: sources, foreignWorkspaceSources, isolated, instrumented })
    process.exit(0)
  } catch (error) {
    await publishCompilation({ phase: 'failed', failure: error.message })
    process.exit(1)
  }
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !/^(AGENTMUX_|CTXMUX_)/.test(key)))
Object.assign(env, { AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'), COLLABORATION_CAPTURE_NODE: process.execPath })
let server
try {
  const harnessFiles = ['index.html', 'entry.tsx', 'main.cjs', 'perception.cjs', 'terrain.cjs', 'server-host.mjs', 'scenario.md'].map(name => join(fixture, name)).concat([scriptPath, join(desktop, 'scripts/probe-process.mjs'), join(desktop, 'scripts/fixtures/desktop-map/source-loader.mjs'), join(desktop, 'scripts/fixtures/performance-failure-evidence/source-loader.mjs'), join(desktop, 'test/helpers/desktop-map-source-mutations.mjs'), join(root, 'packages/core/dist/control-endpoint-listener-worker.js'), join(root, 'packages/core/src/control-endpoint-listener-worker.ts')])
  receipt.harness = Object.fromEntries(await Promise.all(harnessFiles.map(async file => [relative(root, file), hash(await readFile(file))])))
  receipt.publicTransport = { boundary: 'Original Core source publication spawns its existing compiled listener asset; only listener transport uses dist. Its bytes and corresponding source are bound in harness; CLI, Core business and Renderer remain original source.', file: 'packages/core/dist/control-endpoint-listener-worker.js' }
  receipt.phase = 'compiling'; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  receipt.compilationProcess = await runProbeProcess(process.execPath, [scriptPath, '--compile', privateRoot, evidence],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 120000, onLine: line => logs.push(line) })
  const compilationText = await readFile(join(evidence, 'compilation.json'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
  if (compilationText.trim()) receipt.compilation = JSON.parse(compilationText)
  assert.equal(receipt.compilationProcess.timedOut, false, 'Source compilation timed out; retain its phase receipt')
  assert.equal(receipt.compilationProcess.exitConfirmed, true, 'The source compiler exit is unconfirmed')
  assert.equal(receipt.compilationProcess.exitCode, 0, receipt.compilation?.failure ?? 'Source compilation failed')
  assert.equal(receipt.compilation?.phase, 'complete')
  assert.deepEqual(receipt.compilation.foreignWorkspaceSources, {}, 'The exact candidate must not consume another worktree source')
  Object.assign(sources, receipt.compilation.inputs); isolated.push(...receipt.compilation.isolated); instrumented.push(...receipt.compilation.instrumented)
  receipt.inputs = sources; receipt.isolated = isolated; receipt.instrumented = instrumented
  for (const owner of ['App.tsx', 'GlobalFocusSurface.tsx', 'FocusToolbar.tsx', 'FocusViewSwitch.tsx', 'SurfaceToolDock.tsx', 'WorkspaceCollaboration.tsx', 'CollaborationMapToolbar.tsx', 'collaboration-areas.ts', 'collaboration-presentation.ts', 'workspace-agent-scope.ts', 'AgentCollaborationMap.tsx', 'AgentCollaborationGraph.tsx', 'collaboration-layout.worker.ts', 'collaboration-layout-engine.ts', 'collaboration-map-geometry.ts', 'desktop-presentation.ts', 'FocusContextCards.tsx', 'use-collaboration-layout.ts', 'FocusContextCardBody.tsx', 'FocusContextRow.tsx', 'AgentInformationPreview.tsx', 'AgentInformationReader.tsx', 'store.ts', 'collaboration.css']) {
    assert.ok(Object.keys(sources).some(file => file.endsWith('/' + owner)), 'Actual owning module must compile: ' + owner)
  }
  receipt.outputs = {}
  async function recordOutputs(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await recordOutputs(file)
      else receipt.outputs[relative(compiled, file)] = hash(await readFile(file))
    }
  }
  await recordOutputs(compiled)
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm' }
  server = createServer(async (request, response) => {
    try { const pathname = decodeURIComponent(new URL(request.url, 'http://fixture.test').pathname)
      const file = resolve(compiled, pathname === '/' ? 'index.html' : pathname.slice(1)); assert.ok(file.startsWith(compiled + sep))
      const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }); response.end(bytes)
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  receipt.phase = 'capturing'; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), `http://127.0.0.1:${server.address().port}/?scenario=${scenario}`, privateRoot, evidence, scenario],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 210000, onLine: line => logs.push(line) })
  const actualText = await readFile(join(evidence, 'actual.json'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
  if (actualText.trim()) receipt.actual = JSON.parse(actualText)
  assert.equal(receipt.process.timedOut, false, 'The original source capture timed out; retain its partial scene evidence')
  assert.equal(receipt.process.exitConfirmed, true, 'The original capture process exit is unconfirmed')
  assert.ok(receipt.actual, 'The original source capture did not publish scene evidence')
  const controlLoaded = await readFile(join(evidence, 'control-loaded.jsonl'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
  receipt.controlInputs = controlLoaded.trim() ? controlLoaded.trim().split('\n').map(line => JSON.parse(line)) : []
  assert.ok(receipt.controlInputs.some(input => input.path === 'packages/core/src/public-rpc-server.ts') && receipt.controlInputs.some(input => input.path === 'packages/core/src/agentmux-cli-commands.ts'), 'Original Core server and source CLI must load in the public App join')
  for (const input of receipt.controlInputs) { assert.equal(input.originalSHA256, input.effectiveSHA256, 'Public join uses unmodified source'); if (sources[input.path]) assert.equal(sources[input.path], input.originalSHA256); sources[input.path] = input.originalSHA256 }
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  receipt.sourceAfter = Object.fromEntries(await Promise.all(Object.keys(sources).map(async file => [file, hash(await readFile(join(root, file)))])))
  receipt.harnessAfter = Object.fromEntries(await Promise.all(harnessFiles.map(async file => [relative(root, file), hash(await readFile(file))])))
  receipt.changedInputs = Object.keys(sources).filter(file => sources[file] !== receipt.sourceAfter[file])
  receipt.changedHarness = Object.keys(receipt.harness).filter(file => receipt.harness[file] !== receipt.harnessAfter[file])
  assert.equal(receipt.process.exitCode, 0, JSON.stringify(receipt.actual.failures.map(({ name, message }) => ({ name, message })))); assert.equal(receipt.actual.passed, true)
  assert.equal(receipt.changedInputs.length, 0, 'Candidate changed during capture: ' + receipt.changedInputs.join(', '))
  assert.equal(receipt.changedHarness.length, 0, 'Capture harness changed during execution: ' + receipt.changedHarness.join(', '))
  receipt.capturedPass = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await new Promise(done => server ? server.close(done) : done())
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  let remaining = await listProbeProcesses(-1, privateRoot)
  if (remaining.length) { await stopProbeProcesses(-1, privateRoot); remaining = await listProbeProcesses(-1, privateRoot) }
  receipt.cleanup = { remaining, removed: false, evidencePreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  receipt.phase = receipt.capturedPass ? 'complete' : 'failed'
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ capturedPass: receipt.capturedPass, evidence, failure: receipt.failure?.message, pendingIndependentVisualReview: true }))
}
