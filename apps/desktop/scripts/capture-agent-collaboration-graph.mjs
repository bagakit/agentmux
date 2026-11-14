import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rename, link, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative, extname, sep, join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { createCssSourceOverlay } from './fixtures/agent-collaboration-graph/css-source-overlay.mjs'
import { createCaptureSourcePin, pinnedSourceAfter, captureResolverMetadata } from './fixtures/agent-collaboration-graph/capture-source-pin.mjs'
import { rendererCacheContext, loadRendererCache, saveRendererCache, rendererOutputHashes } from './fixtures/agent-collaboration-graph/renderer-cache.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/agent-collaboration-graph')
const scriptPath = fileURLToPath(import.meta.url)
const compiling = process.argv[2] === '--compile'
const verifying = process.argv[2] === '--verify'
const scenarioIndex = compiling ? 5 : 4
const scenario = process.argv[scenarioIndex] === '--scenario' ? process.argv[scenarioIndex + 1] : 'readability'
const listCostOnly = !verifying && scenario === 'list-feedback' && process.env.COLLABORATION_CAPTURE_LIST_COST_ONLY === '1'
const listVisualRefresh = !verifying && scenario === 'list-feedback' && process.env.COLLABORATION_CAPTURE_LIST_VISUAL_REFRESH === '1'
assert.ok(!listVisualRefresh || !listCostOnly, 'The two-frame visual refresh never runs cost actions')
assert.ok(['readability', 'perception', 'perception-scale', 'endpoints', 'dispatch-motion', 'region-headers', 'list-feedback'].includes(scenario), 'Use a declared capture scenario')
assert.ok(compiling ? process.argv.length === 5 || process.argv.length === 7 && process.argv[5] === '--scenario' : ['--evidence', '--verify'].includes(process.argv[2]) && process.argv[3] && (process.argv.length === 4 || process.argv.length === 6 && process.argv[4] === '--scenario'), 'Use --evidence <new private evidence directory> or --verify <completed evidence directory> [--scenario perception|perception-scale|endpoints|dispatch-motion]')
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
  if (scenario === 'dispatch-motion') createRequire(import.meta.url)(join(fixture, 'dispatch-motion.cjs')).verify(receipt.actual.dispatchMotion, receipt.frames)
  if (scenario === 'list-feedback') {
    const refresh = receipt.captureMode === 'visual-refresh'
    const scene = createRequire(import.meta.url)(join(fixture, receipt.captureMode === 'cost-only' ? 'list-feedback-cost.cjs' : refresh ? 'list-feedback-visual-refresh.cjs' : 'list-feedback.cjs'))
    scene.verify(receipt.captureMode === 'cost-only' ? receipt.actual.listFeedbackCost : refresh ? receipt.actual.listFeedbackVisualRefresh : receipt.actual.listFeedback, receipt.frames, receipt)
    assert.deepEqual(receipt.changedResolverMetadata, [])
    for (const name of scene.checks ?? (refresh ? ['list-visual-refresh-painted-middle', 'list-visual-refresh-original-failed-detail'] : ['list-native-bounded-cost'])) assert.ok(receipt.actual.checks.some(check => check.name === name && check.passed))
    assert.equal(receipt.listSource.revision, receipt.compilation.sourceOverlay.revision)
    for (const [file, field] of [['agent-operation-feedback.css', 'cssSHA256'], ['focus-context.css', 'focusContextCSSSHA256'], ['focus.css', 'focusCSSSHA256']]) assert.equal(receipt.listSource[field], receipt.compilation.cssSourceProof.loaded['apps/desktop/src/renderer/src/styles/' + file].sourceSHA256)
    for (const cost of receipt.actual.listFeedbackCost?.costs ?? []) assert.equal(digest(await readFile(join(directory, cost.trace))), cost.traceSHA256)
  }
  if (scenario === 'region-headers') {
    createRequire(import.meta.url)(join(fixture, 'region-headers.cjs')).verify(receipt.actual.regionHeaders, receipt.frames)
    assert.deepEqual(receipt.actual.regionHeaders.source, receipt.headerSource)
    assert.equal(receipt.headerSource.revision, receipt.compilation.sourceOverlay.revision)
    assert.equal(receipt.headerSource.cssSHA256, receipt.compilation.cssSourceProof.loaded['apps/desktop/src/renderer/src/styles/collaboration.css'].sourceSHA256)
    for (const [file, sha] of Object.entries(receipt.headerSource.geometryInputs)) assert.equal(receipt.inputs[file], sha, 'The original geometry owner is bound to the actual consumed input')
    assert.equal(receipt.actual.frameSettlements?.length, 1)
    const foldedFrame = receipt.actual.frameSettlements[0]
    assert.equal(foldedFrame.label, 'headers-mote-narrow-light-folded'); assert.equal(foldedFrame.owner, 'original-delivered-fold'); assert.equal(foldedFrame.observed.busy, false); assert.equal(foldedFrame.observed.transitioning, false); assert.equal(foldedFrame.observed.box.folded, true); assert.equal(foldedFrame.observed.applied, true); assert.equal(foldedFrame.observed.active, false)
    assert.deepEqual(receipt.changedResolverMetadata, [])
    const headerRules = Object.values(receipt.compilation.cssSourceProof.outputs).flatMap(output => output.headerRules ?? [])
    const neutral = headerRules.find(rule => rule.selector === '.collaboration-area__overview-label')
    assert.ok(neutral?.declarations.some(declaration => declaration.property === 'border' && declaration.value === '1px solid transparent'))
    assert.ok(neutral.declarations.some(declaration => declaration.property === 'box-shadow' && declaration.value === 'none'))
    assert.ok(headerRules.some(rule => rule.selector.includes('data-current') && rule.selector.endsWith('em::before') && rule.declarations.some(declaration => declaration.property === 'width' && declaration.value === '3px')))
    if (receipt.headerMaterialReuse) {
      const reuse = receipt.headerMaterialReuse, bytes = await readFile(join(directory, reuse.receiptFile)), original = JSON.parse(bytes)
      assert.equal(digest(bytes), reuse.receiptSHA256); assert.equal(original.actual.checks.find(check => check.name === 'region-headers-native-material-and-placement')?.passed, true)
      assert.deepEqual(receipt.inputs, original.inputs); assert.deepEqual(receipt.outputs, original.outputs)
      assert.equal(original.headerSource.revision, receipt.headerSource.revision); assert.equal(original.headerSource.cssSHA256, receipt.headerSource.cssSHA256)
      assert.equal(digest(await readFile(join(directory, reuse.manifestFile))), reuse.manifestSHA256)
      for (const frame of receipt.frames.slice(0, 9)) { assert.equal(frame.capture, 'reused-qualified-material'); assert.equal(frame.originReceiptSHA256, reuse.receiptSHA256); assert.equal(frame.sha256, original.frames.find(old => old.label === frame.label)?.sha256) }
      assert.equal(receipt.frames.filter(frame => frame.capture === 'reused-qualified-material').length, 9)
    }
  }
  const cameraWaits = receipt.actual.cameraWaits
  if (scenario !== 'list-feedback') assert.ok(cameraWaits?.length && cameraWaits.some(wait => wait.kind === 'locate'), 'Original camera completion must be observed for actual locates')
  for (const wait of cameraWaits ?? []) {
    assert.ok(['locate', 'frame'].includes(wait.kind) && typeof wait.label === 'string' && wait.label)
    assert.ok(wait.samples?.length && Object.hasOwn(wait, 'before') && wait.final)
    assert.deepEqual(wait.samples[0], wait.before); assert.deepEqual(wait.samples.at(-1), wait.final)
    assert.equal(wait.final.ready, true); assert.equal(wait.final.initialized, true); assert.equal(wait.final.applied, true); assert.equal(wait.final.active, false)
    assert.ok(typeof wait.final.camera === 'string' && wait.final.camera.includes('scale('))
    if (wait.kind === 'locate') {
      assert.equal(wait.final.advanced, true, 'An old completed camera intent cannot substitute for this original locate')
      assert.equal(wait.final.agentId, JSON.stringify(['local', wait.id]))
    }
  }
  for (const name of scenario === 'list-feedback' ? [] : scenario === 'region-headers' ? ['region-headers-native-material-and-placement', 'region-headers-native-keyboard-and-fold', 'region-headers-native-css-counterfactuals'] : scenario === 'dispatch-motion' ? ['dispatch-native-stages', ...(receipt.actual.dispatchMotion.refresh ? [] : ['dispatch-native-motion-policies']), 'dispatch-native-cost'] : scenario === 'endpoints' ? ['endpoints-original-phases-parallel-and-input', 'endpoints-original-theme-point-and-static', 'endpoints-original-mixed-group-and-keyboard'] : ['initial-gui-entry-keeps-accurate-context-and-full-width', 'source-cli-original-app-admission-and-dom-inspect', 'focus-list-map-and-original-return', ...(scenario === 'perception-scale' ? ['perception-original-large-world-and-consumer-cost', 'terrain-original-nesting-fold-and-exact-reveal', 'terrain-native-continuous-lod-and-selection-cost', 'terrain-held-reader-keyboard-and-motion-choice'] : [])]) assert.ok(receipt.actual.checks.some(check => check.name === name && check.passed === true), 'Missing actual native check: ' + name)
  const verifiedPinned = pinnedSourceAfter(root, receipt.compilation.sourceOverlay, receipt.inputs)
  for (const key of ['inputs', 'harness']) {
    const entries = Object.entries(receipt[key] ?? {}); assert.ok(entries.length, 'Nonempty exact ' + key)
    for (const [file, sha] of entries) { const target = resolve(root, file); assert.ok(target.startsWith(root + sep)); const snapshot = receipt.harnessSnapshot?.[file]; const overlay = key === 'inputs' && receipt.compilation.sourceOverlay?.files[file]; const actual = key === 'inputs' && verifiedPinned[file] ? verifiedPinned[file] : digest(await readFile(snapshot ? join(directory, snapshot) : overlay?.file ? join(directory, overlay.file) : target)); assert.equal(actual, sha, 'Changed declared ' + key + ': ' + file) }
  }
  if (receipt.rendererCache?.manifestFile) {
    const bytes = await readFile(join(directory, receipt.rendererCache.manifestFile)), manifest = JSON.parse(bytes)
    assert.equal(digest(bytes), receipt.rendererCache.manifestSHA256)
    assert.equal(manifest.context.revision, manifest.compilation.sourceOverlay.revision)
    assert.equal(manifest.context.revision, receipt.compilation.sourceOverlay.revision)
    assert.deepEqual(manifest.compilation, receipt.compilation); assert.deepEqual(manifest.outputs, receipt.outputs)
    assert.deepEqual(receipt.changedWatchInputs, [])
    for (const [file, sha] of Object.entries(receipt.compilation.watchInputs)) assert.equal(receipt.watchInputsAfter[file], sha)
    for (const [file, sha] of Object.entries(receipt.inputs)) {
      if (receipt.compilation.sourceOverlay.files[file]?.origin === 'git-blob') assert.equal(receipt.compilation.sourceOverlay.files[file].sha256, sha)
      else assert.equal(receipt.compilation.watchInputs[resolve(root, file)], sha)
    }
  }
  assert.ok(receipt.frames?.length || receipt.captureMode === 'cost-only' && receipt.actual.listFeedbackCost.costs.length === 8)
  assert.deepEqual(receipt.frames.map(({ sha256, ...frame }) => frame), receipt.actual.frames)
  for (const frame of receipt.frames) { const target = resolve(directory, frame.file); assert.ok(target.startsWith(directory + sep)); assert.equal(digest(await readFile(target)), frame.sha256, 'Changed native frame: ' + frame.file) }
  if (scenario === 'endpoints') createRequire(import.meta.url)(join(fixture, 'endpoints.cjs')).verify(receipt.actual.endpoints, receipt.frames, receipt.actual.nativeWorkers)
  if (scenario === 'perception-scale') {
    assert.ok(receipt.actual.perceptionScale?.input?.nodes >= 240)
    assert.equal(receipt.actual.perceptionScale.boxes.agents, receipt.actual.perceptionScale.input.nodes)
    for (const label of ['workbench-entry', 'unselected-focus-list', 'map-first-context-readable', 'public-cli-map', 'public-cli-list', 'public-cli-exact-focus-agent', 'public-cli-retained-focus-short-window', 'public-cli-space', 'focus-entry', 'map-dark', 'focus-list-return', 'workbench-return', 'perception-dense-empty-projects-overview', 'perception-dense-empty-projects-panned', 'terrain-parent-readable-destination', 'terrain-nested-dark', 'terrain-folded-dark', 'terrain-expanded-dark', 'terrain-deep-agent-revealed', 'terrain-lod-0-319', 'terrain-lod-0-321', 'terrain-lod-0-44', 'terrain-lod-0-46', 'terrain-lod-0-62', 'terrain-lod-0-72', 'terrain-lod-0-82', 'terrain-nested-communication-live', 'terrain-lod-light', 'terrain-narrow-light', 'terrain-narrow-dark', 'terrain-held-reader-overview', 'terrain-held-focus-overview', 'terrain-motion-off-static']) assert.ok(receipt.frames.some(frame => frame.label === label), 'Missing original complete native frame: ' + label)
    const samples = receipt.actual.terrainLod.samples
    assert.ok(samples.length >= 7 && samples.find(sample => sample.target === .319)?.actual < .32 && samples.find(sample => sample.target === .321)?.actual > .32, 'Actual camera samples cross the glyph boundary')
    createRequire(import.meta.url)(join(fixture, 'terrain.cjs')).verifyVisualGuards(receipt.actual.terrainVisualGuards, receipt.frames, JSON.stringify(['area', receipt.actual.terrain.original.areas[0].id]))
    assert.ok(receipt.actual.checks.some(check => check.name === 'adaptive-original-structure-and-motion-consumers' && check.passed === true), 'The original adaptive native check must actually execute')
    createRequire(import.meta.url)(join(fixture, 'adaptive.cjs')).verify(receipt.actual.adaptive, receipt.frames)
    assert.ok(receipt.actual.checks.some(check => check.name === 'settings-original-edit-save-reopen-and-map-consumers' && check.passed === true), 'The original Map settings native check must execute')
    createRequire(import.meta.url)(join(fixture, 'settings.cjs')).verify(receipt.actual.mapSettings, receipt.frames)
  }
  console.log(JSON.stringify({ passed: true, evidence: directory, receiptSHA256: digest(await readFile(join(directory, 'receipt.json'))), nativeChecks: receipt.actual.checks.length, completeFrames: receipt.frames.length, aestheticReview: 'separate-independent-artifact', restart: 'separate-runtime-artifact' }))
  process.exit(0)
}
const evidence = resolve(process.argv[compiling ? 4 : 3]); await mkdir(evidence, { recursive: true })
if (!compiling) assert.equal((await readdir(evidence)).length, 0, 'Keep prior captures; use an empty evidence directory')
const privateRoot = compiling ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'amux-collaboration-capture-'))
let compiled = join(privateRoot, 'compiled')
assert.ok(privateRoot.startsWith(join(tmpdir(), 'amux-collaboration-capture-')) && !relative(tmpdir(), privateRoot).includes(sep), 'Compilation stays in its own private capture root')
const require = createRequire(join(desktop, 'package.json')), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = {}, foreignWorkspaceSources = {}, watchInputs = {}, isolated = [], instrumented = [], logs = []
let cssSourceProof
const sourceRef = process.env.COLLABORATION_CAPTURE_SOURCE_REF
const sourcePin = createCaptureSourcePin({ root, revision: sourceRef })
const sourceOverlay = { revision: sourcePin.revision, files: sourcePin.files, boundary: sourcePin.boundary }
const overlayBytes = new Map()
if (sourceRef) {
  assert.ok(['dispatch-motion', 'region-headers', 'list-feedback'].includes(scenario), 'Git byte overlays are bounded to declared presentation captures')
  const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=M', sourceOverlay.revision, '--', 'apps/desktop/src', 'packages'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(file => /\/src\/.+\.css$/.test(file))
  const leaves = new Set([...changed, 'apps/desktop/src/renderer/src/styles/collaboration.css', 'apps/desktop/src/renderer/src/styles/agent-operation-feedback.css'])
  for (const file of leaves) overlayBytes.set(join(root, file), await sourcePin.read(join(root, file)))
}
const sourceBytes = file => sourcePin.read(file)
const resolverMetadata = await captureResolverMetadata(root)
const receipt = { schema: 'agentmux.collaboration-graph-capture.v1', scenario: 'focus-map-' + scenario, capturedPass: false, captureOnly: true, aestheticReview: 'not-performed',
  captureMode: listCostOnly ? 'cost-only' : listVisualRefresh ? 'visual-refresh' : 'visual-native',
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
  const privateCanonical = await realpath(privateRoot), packageDirectories = new Map()
  const watchPackage = folder => {
    if (!packageDirectories.has(folder)) packageDirectories.set(folder, (async () => {
      const file = join(folder, 'package.json')
      try { watchInputs[file] = hash(await readFile(file)) } catch (error) { if (error.code !== 'ENOENT') throw error; if (dirname(folder) !== folder) await watchPackage(dirname(folder)) }
    })())
    return packageDirectories.get(folder)
  }
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
  const sourcePlugin = { name: 'collaboration-source-and-unrelated-paint', enforce: 'pre', async load(id) { const file = id.split('?')[0]; if (sourcePin.owns(file) && /\.(?:[cm]?[jt]sx?|css|json)$/.test(file) && !id.includes('?')) return (await sourcePin.read(file)).toString('utf8') }, async transform(source, id) {
      const file = id.split('?')[0]
      if (!file.startsWith(root + sep) && !file.includes('/node_modules/') && /\/(?:packages|apps)\/[^/]+\/src\/.+\.(?:tsx?|jsx?|css)$/.test(file)) foreignWorkspaceSources[relative(root, file)] = hash(await readFile(file))
      if (!file.startsWith(root + sep) || file.includes('/node_modules/') || !/\.(?:[cm]?[jt]sx?|css)$/.test(file)) return
      if (id.includes('?')) { sources[relative(root, file)] = hash(await sourceBytes(file)); return }
      if (sourcePin.owns(file)) assert.equal(hash(source), hash(await sourcePin.read(file)), 'Actual Vite product input is not the pinned Git bytes: ' + relative(root, file))
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
      if (id === join(desktop, 'src/renderer/src/lib/use-collaboration-layout.ts')) {
        const anchor = '  return { ...frame, busy: busy || transitioning, issues, settle, retry:'
        assert.equal(source.split(anchor).length, 2, 'Observe the one original delivered layout owner')
        const effective = source.replace(anchor, '  ;(globalThis as any).__collaborationCaptureLayout = { ...frame, busy: busy || transitioning, transitioning, issues }\n' + anchor)
        instrumented.push({ file: relative(root, id), originalSHA256: hash(source), effectiveSHA256: hash(effective), boundary: 'Reference-only O(1) observation of the actual presented hook frame and effective busy state, including its finite transition. No canonical Worker geometry is substituted for presentation; no state, input or camera replacement. Uncalibrated reference-publication cost; arrays copy only at explicit evidence boundaries or the declared finite related-neighborhood sampler.' })
        return effective
      }
      if (id === join(desktop, 'src/renderer/src/components/AgentCollaborationGraph.tsx')) {
        const anchor = '  const motion = useContext(MapMotionContext), preferences = useContext(CollaborationMapPreferences)'
        assert.equal(source.split(anchor).length, 2, 'Observe the one original viewport camera owner')
        const effective = source.replace(anchor, anchor + '\n  ;(globalThis as any).__collaborationCaptureCamera = { cameraAnimation, initialized, applied, locate, ready }')
        instrumented.push({ file: relative(root, id), originalSHA256: hash(source), effectiveSHA256: hash(effective), boundary: 'Reference-only O(1) publication of the original viewport camera owner and its exact request/applied tokens. No completion state, camera, input or scheduling is replaced. Publication and explicit-boundary polling overhead are uncalibrated, not subtracted.' })
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
      if (process.env.COLLABORATION_CAPTURE_RENDERER_CACHE) await Promise.all(this.getWatchFiles().map(async watched => {
        if (!isAbsolute(watched)) return
        let file
        try { file = await realpath(watched) } catch (error) { if (error.code === 'ENOENT') return; throw error }
        if (file.startsWith(privateCanonical + sep) || !(await stat(file)).isFile()) return
        if (sourcePin.files[relative(root, file)]?.origin === 'git-blob') return
        watchInputs[file] = hash(await readFile(file))
        if (file.includes('/node_modules/')) await watchPackage(dirname(file))
      }))
      for (const file of this.getWatchFiles()) if (file.startsWith(root + sep) && !file.includes('/node_modules/') && file.endsWith('.css')) sources[relative(root, file)] = hash(await sourceBytes(file))
    } }
  const css = await createCssSourceOverlay({ root, privateRoot, overlays: overlayBytes, inputs: sources, sourcePin, vitePackage: require.resolve('vite/package.json') })
  await build({ configFile: false, logLevel: 'error', root: fixture, worker: { format: 'es', plugins: () => [sourcePlugin, css.plugin] },
    css: { postcss: { plugins: [css.observer] } },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
    resolve: { alias: [...aliases, { find: '@agentmux/identity', replacement: join(root, 'packages/identity/src/index.ts') }], conditions: ['browser', 'import', 'production', 'default'], dedupe: ['react', 'react-dom'] },
    build: { outDir: compiled, emptyOutDir: true, target: 'esnext', minify: false },
    plugins: [sourcePlugin, css.plugin] })
  cssSourceProof = { ...css.verify(), outputs: {} }
  async function bindCSSOutputs(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await bindCSSOutputs(file)
      else if (file.endsWith('.css')) cssSourceProof.outputs[relative(compiled, file)] = css.emitted(await readFile(file))
    }
  }
  await bindCSSOutputs(compiled)
}
if (compiling) {
  await publishCompilation({ phase: 'starting', transformed: 0 })
  try {
    await compileRenderer()
    await publishCompilation({ phase: 'complete', inputs: sources, foreignWorkspaceSources, watchInputs, isolated, instrumented, sourceOverlay, cssSourceProof, resolverMetadata })
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
  const harnessFiles = ['index.html', 'entry.tsx', 'main.cjs', 'perception.cjs', 'terrain.cjs', 'adaptive.cjs', 'adaptive-observer.ts', 'settings.cjs', 'server-host.mjs', 'scenario.md', 'css-source-overlay.mjs', 'capture-source-pin.mjs', 'renderer-cache.mjs', ...(scenario === 'list-feedback' ? ['list-feedback.cjs', 'list-feedback-cost.cjs', 'list-feedback.md', 'dispatch-motion.cjs', ...(listVisualRefresh ? ['list-feedback-visual-refresh.cjs'] : [])] : []), ...(scenario === 'region-headers' ? ['region-headers.cjs'] : []), ...(scenario === 'endpoints' ? ['endpoints.cjs'] : []), ...(scenario === 'dispatch-motion' ? ['dispatch-motion.cjs', 'dispatch-motion.md'] : [])].map(name => join(fixture, name)).concat([scriptPath, join(desktop, 'scripts/probe-process.mjs'), join(desktop, 'scripts/fixtures/desktop-map/source-loader.mjs'), join(desktop, 'scripts/fixtures/performance-failure-evidence/source-loader.mjs'), join(desktop, 'test/helpers/desktop-map-source-mutations.mjs'), join(root, 'packages/core/dist/control-endpoint-listener-worker.js'), join(root, 'packages/core/src/control-endpoint-listener-worker.ts')])
  receipt.harness = Object.fromEntries(await Promise.all(harnessFiles.map(async file => [relative(root, file), hash(await readFile(file))])))
  receipt.harnessSnapshot = {}
  for (const file of harnessFiles) { const name = relative(root, file), stored = join('harness-snapshot', name); await mkdir(join(evidence, stored, '..'), { recursive: true }); const bytes = await readFile(file); assert.equal(hash(bytes), receipt.harness[name]); await writeFile(join(evidence, stored), bytes); receipt.harnessSnapshot[name] = stored }
  receipt.publicTransport = scenario === 'list-feedback' ? { boundary: 'Original List menu and confirmation reach only the declared private typed deferred Stop API. No Core/Provider lifecycle, public CLI or user Run executes. CLI navigation is separately owned evidence.' } : ['endpoints', 'dispatch-motion', 'region-headers'].includes(scenario) ? { boundary: 'No public transport or lifecycle operation is exercised by the isolated presentation increment. CLI navigation is separately owned evidence, not claimed by these frames.' } : { boundary: 'Original Core source publication spawns its existing compiled listener asset; only listener transport uses dist. Its bytes and corresponding source are bound in harness; CLI, Core business and Renderer remain original source.', file: 'packages/core/dist/control-endpoint-listener-worker.js' }
  receipt.phase = 'compiling'; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  const cacheDirectory = process.env.COLLABORATION_CAPTURE_RENDERER_CACHE ? resolve(process.env.COLLABORATION_CAPTURE_RENDERER_CACHE) : null
  if (cacheDirectory) assert.equal(cacheDirectory, join(dirname(evidence), 'native-renderer-cache'), 'Only this task evidence parent owns the single renderer cache')
  const cacheContext = cacheDirectory ? await rendererCacheContext({ root, revision: sourcePin.revision, compilerFiles: [scriptPath, ...['capture-source-pin.mjs', 'css-source-overlay.mjs', 'renderer-cache.mjs'].map(file => join(fixture, file)), require.resolve('vite/package.json'), require.resolve('typescript/package.json')], metadata: resolverMetadata }) : null
  const cache = cacheDirectory ? await loadRendererCache({ directory: cacheDirectory, context: cacheContext, sourcePin }) : { reused: false, reason: 'disabled' }
  receipt.rendererCache = { directory: cacheDirectory, reused: cache.reused, reason: cache.reason, context: cacheContext }
  if (cache.reused) {
    compiled = cache.compiled; receipt.compilation = cache.manifest.compilation
    receipt.rendererCache.manifestSHA256 = cache.manifestSHA256
    receipt.compilationReuse = { manifestSHA256: cache.manifestSHA256, originEvidence: cache.manifest.originEvidence, originalCompilationProcess: cache.manifest.compilationProcess, boundary: 'No compiler ran in this attempt; original qualified renderer bytes and actual inputs were revalidated. Observer/Native evidence is new.' }
    await writeFile(join(evidence, 'compilation.json'), JSON.stringify(receipt.compilation))
  } else {
    receipt.compilationProcess = await runProbeProcess(process.execPath, [scriptPath, '--compile', privateRoot, evidence, '--scenario', scenario],
      { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 120000, onLine: line => logs.push(line) })
    const compilationText = await readFile(join(evidence, 'compilation.json'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
    if (compilationText.trim()) receipt.compilation = JSON.parse(compilationText)
    assert.equal(receipt.compilationProcess.timedOut, false, 'Source compilation timed out; retain its phase receipt')
    assert.equal(receipt.compilationProcess.exitConfirmed, true, 'The source compiler exit is unconfirmed')
    assert.equal(receipt.compilationProcess.exitCode, 0, receipt.compilation?.failure ?? 'Source compilation failed')
  }
  assert.equal(receipt.compilation?.phase, 'complete')
  assert.deepEqual(receipt.compilation.foreignWorkspaceSources, {}, 'The exact candidate must not consume another worktree source')
  Object.assign(sources, receipt.compilation.inputs); isolated.push(...receipt.compilation.isolated); instrumented.push(...receipt.compilation.instrumented)
  receipt.inputs = sources; receipt.isolated = isolated; receipt.instrumented = instrumented
  for (const [name, sha] of Object.entries(sources)) if (!receipt.compilation.sourceOverlay.files[name] && !receipt.harness[name]) {
    const file = join(root, name), bytes = await readFile(file); assert.equal(hash(bytes), sha, 'Current renderer fixture remains the actually consumed bytes')
    const stored = join('harness-snapshot', name); await mkdir(join(evidence, stored, '..'), { recursive: true }); await writeFile(join(evidence, stored), bytes)
    receipt.harness[name] = sha; receipt.harnessSnapshot[name] = stored; harnessFiles.push(file)
  }
  for (const owner of ['App.tsx', 'GlobalFocusSurface.tsx', 'FocusToolbar.tsx', 'FocusViewSwitch.tsx', 'SurfaceToolDock.tsx', 'WorkspaceCollaboration.tsx', 'CollaborationMapToolbar.tsx', 'collaboration-areas.ts', 'collaboration-presentation.ts', 'collaboration-hierarchy.ts', 'workspace-agent-scope.ts', 'AgentCollaborationMap.tsx', 'AgentCollaborationGraph.tsx', 'collaboration-layout.worker.ts', 'collaboration-layout-engine.ts', 'collaboration-layout-refinement.ts', 'collaboration-map-transition.ts', 'collaboration-map-geometry.ts', 'desktop-presentation.ts', 'FocusContextCards.tsx', 'use-collaboration-layout.ts', 'FocusContextCardBody.tsx', 'FocusContextRow.tsx', 'AgentInformationPreview.tsx', 'AgentInformationReader.tsx', 'store.ts', 'collaboration.css']) {
    assert.ok(Object.keys(sources).some(file => file.endsWith('/' + owner)), 'Actual owning module must compile: ' + owner)
  }
  if (scenario === 'endpoints') for (const owner of ['CollaborationRelationMark.tsx', 'collaboration-relation-presentation.ts', 'icon-catalog.ts', 'icon-glyphs.ts', 'icons.tsx', 'icon-sprite.ts']) assert.ok(Object.keys(sources).some(file => file.endsWith('/' + owner)), 'The original endpoint and theme owner actually compiles: ' + owner)
  receipt.outputs = {}
  async function recordOutputs(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await recordOutputs(file)
      else receipt.outputs[relative(compiled, file)] = hash(await readFile(file))
    }
  }
  await recordOutputs(compiled)
  if (cacheDirectory && !cache.reused) {
    assert.deepEqual(receipt.compilation.resolverMetadata, resolverMetadata)
    const retained = await saveRendererCache({ directory: cacheDirectory, context: cacheContext, compiled, compilation: receipt.compilation, compilationProcess: receipt.compilationProcess, outputs: receipt.outputs, evidence: relative(root, evidence), sourcePin })
    compiled = retained.compiled; receipt.rendererCache.retained = true; receipt.rendererCache.manifestSHA256 = retained.manifestSHA256
  }
  if (cacheDirectory) {
    const bytes = await readFile(join(cacheDirectory, 'manifest.json'))
    assert.equal(hash(bytes), receipt.rendererCache.manifestSHA256)
    receipt.rendererCache.manifestFile = 'renderer-cache-manifest.json'; await writeFile(join(evidence, receipt.rendererCache.manifestFile), bytes)
  }
  if (scenario === 'region-headers') {
    assert.ok(sourcePin.revision && process.env.COLLABORATION_CAPTURE_HEADER_BASE_REF, 'Declare the immutable heading candidate and geometry baseline refs')
    const baseline = createCaptureSourcePin({ root, revision: process.env.COLLABORATION_CAPTURE_HEADER_BASE_REF })
    const cssFile = 'apps/desktop/src/renderer/src/styles/collaboration.css', baselineBytes = await baseline.read(join(root, cssFile))
    const postcss = createRequire(require.resolve('vite/package.json'))('postcss'), tree = postcss.parse(baselineBytes)
    const stripes = []; tree.walkRules(rule => { if (rule.selector === '.collaboration-area__overview-label::before') stripes.push(rule.toString()) })
    assert.equal(stripes.length, 1, 'One exact original left-line rule supplies the native CSS counterfactual')
    const geometryInputs = {}
    for (const file of ['components/AgentCollaborationGraph.tsx', 'components/CollaborationRegionLabels.tsx', 'lib/collaboration-map-camera.ts', 'lib/use-collaboration-layout.ts', 'lib/collaboration-layout.worker.ts', 'lib/collaboration-layout-engine.ts']) {
      const path = 'apps/desktop/src/renderer/src/' + file, sha256 = hash(await sourcePin.read(join(root, path)))
      assert.equal(sources[path], sha256, 'The actual heading geometry owner must consume the declared source')
      assert.equal(sha256, hash(await baseline.read(join(root, path))), 'Headings retain the original geometry owner: ' + path)
      geometryInputs[path] = sha256
    }
    receipt.headerSource = { revision: sourcePin.revision, cssSHA256: hash(await sourcePin.read(join(root, cssFile))), baselineRevision: baseline.revision, baselineCSSSHA256: hash(baselineBytes), stripeRule: stripes[0], geometryInputs,
      boundary: 'Baseline CSS is used only for a declared temporary native left-line counterfactual, not a mixed-source baseline screenshot or cost arm. Product JS/CSS inputs are pinned; current fixture and resolver metadata stay separately hashed.' }
    assert.equal(receipt.compilation.cssSourceProof.loaded[cssFile].sourceSHA256, receipt.headerSource.cssSHA256)
    env.COLLABORATION_CAPTURE_HEADER_SOURCE = JSON.stringify(receipt.headerSource)
    if (process.env.COLLABORATION_CAPTURE_HEADER_MATERIAL_EVIDENCE) {
      const originalDirectory = resolve(process.env.COLLABORATION_CAPTURE_HEADER_MATERIAL_EVIDENCE), bytes = await readFile(join(originalDirectory, 'receipt.json')), original = JSON.parse(bytes)
      assert.equal(original.scenario, 'focus-map-region-headers'); assert.equal(original.compilation.phase, 'complete')
      assert.equal(original.actual.checks.find(check => check.name === 'region-headers-native-material-and-placement')?.passed, true)
      assert.deepEqual(original.changedInputs, []); assert.deepEqual(original.changedHarness, []); assert.deepEqual(original.actual.rendererErrors, [])
      assert.equal(original.headerSource.revision, receipt.headerSource.revision); assert.equal(original.headerSource.cssSHA256, receipt.headerSource.cssSHA256)
      assert.deepEqual(original.inputs, sources); assert.deepEqual(original.outputs, receipt.outputs, 'Material reuse requires identical actual renderer input and output bytes')
      const receiptSHA256 = hash(bytes), directory = join(evidence, 'reused-material'); await mkdir(directory)
      const materialFrames = original.frames.slice(0, 9), stages = original.actual.regionHeaders.stages.slice(0, 9)
      assert.equal(materialFrames.length, 9); assert.ok(materialFrames.slice(0, 6).every(frame => frame.label.endsWith('-static')) && materialFrames.slice(6).every(frame => frame.label.endsWith('-hover')))
      assert.deepEqual(stages.map(stage => stage.label), materialFrames.map(frame => frame.label))
      await link(join(originalDirectory, 'receipt.json'), join(directory, 'source-receipt.json'))
      const frames = []
      for (const frame of materialFrames) {
        assert.equal(hash(await readFile(join(originalDirectory, frame.file))), frame.sha256)
        const file = join('reused-material', frame.label + '.png'); await link(join(originalDirectory, frame.file), join(evidence, file))
        const { sha256, ...descriptor } = frame
        frames.push({ ...descriptor, file, capture: 'reused-qualified-material', originReceiptSHA256: receiptSHA256, originFile: frame.file })
      }
      const manifest = { receiptSHA256, originalEvidence: relative(root, originalDirectory), originalOverallPassed: original.capturedPass, frames, stages,
        boundary: 'Only the original passed nine-frame material subset is reused. The original overall failure remains unchanged. Exact actual renderer inputs and outputs match; new native interaction/CSS counterfactuals are not inherited.' }
      const manifestBytes = JSON.stringify(manifest), manifestFile = join('reused-material', 'material.json'); await writeFile(join(evidence, manifestFile), manifestBytes)
      receipt.headerMaterialReuse = { receiptFile: join('reused-material', 'source-receipt.json'), receiptSHA256, manifestFile, manifestSHA256: hash(manifestBytes), originalEvidence: manifest.originalEvidence, originalOverallPassed: original.capturedPass, newPNGs: 3, reusedPNGs: 9 }
      env.COLLABORATION_CAPTURE_HEADER_MATERIAL_FILE = join(evidence, manifestFile)
    }
  }
  if (sourceRef && scenario === 'dispatch-motion') {
    const names = [...new Set(Object.values(receipt.compilation.cssSourceProof.outputs).flatMap(output => output.packetAnimationNames))]
    assert.equal(names.length, 1, 'The original emitted packet animation must be unambiguous before Native observation')
    env.COLLABORATION_CAPTURE_EXPECT_PACKET_ANIMATION = names[0]
  }
  if (scenario === 'list-feedback') {
    const file = 'apps/desktop/src/renderer/src/styles/agent-operation-feedback.css'
    assert.ok(sourcePin.revision && receipt.compilation.cssSourceProof.loaded[file], 'List Native requires exact product pin and actual CSS reader')
    const baseline = listCostOnly && process.env.COLLABORATION_CAPTURE_LIST_BASELINE === '1'
    assert.equal(Object.values(receipt.compilation.cssSourceProof.outputs).some(output => output.keyframes.includes('focus-list-communication-arrive')), !baseline, 'The actual emitted List animation must match the declared original/candidate arm before Native')
    receipt.listSource = { revision: sourcePin.revision, cssSHA256: receipt.compilation.cssSourceProof.loaded[file].sourceSHA256,
      focusContextCSSSHA256: receipt.compilation.cssSourceProof.loaded['apps/desktop/src/renderer/src/styles/focus-context.css'].sourceSHA256,
      focusCSSSHA256: receipt.compilation.cssSourceProof.loaded['apps/desktop/src/renderer/src/styles/focus.css'].sourceSHA256,
      baseline,
      comparisonBoundary: 'The immutable original baseline retains its original percentage-fill behavior and has no List A2A feedback. Candidate costs include visible feedback and the declared sibling-layout correction. Original identities/output/pending intent are protected, not pixel-equivalent UI; no mixed baseline, backport or pure-animation improvement claim.',
      boundary: 'Exact Git product JS/CSS. Current fixture, observer, package/resolver metadata are separately hashed; no all-repository hermetic claim.' }
  }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm' }
  server = createServer(async (request, response) => {
    try { const pathname = decodeURIComponent(new URL(request.url, 'http://fixture.test').pathname)
      const file = resolve(compiled, pathname === '/' ? 'index.html' : pathname.slice(1)); assert.ok(file.startsWith(compiled + sep))
      const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }); response.end(bytes)
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  receipt.phase = 'capturing'; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), `http://127.0.0.1:${server.address().port}/?scenario=${scenario}${listCostOnly ? '&cost=1' : ''}`, privateRoot, evidence, scenario],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: ['perception-scale', 'dispatch-motion'].includes(scenario) ? 360000 : 210000, onLine: line => logs.push(line) })
  const actualText = await readFile(join(evidence, 'actual.json'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
  if (actualText.trim()) receipt.actual = JSON.parse(actualText)
  assert.equal(receipt.process.timedOut, false, 'The original source capture timed out; retain its partial scene evidence')
  assert.equal(receipt.process.exitConfirmed, true, 'The original capture process exit is unconfirmed')
  assert.ok(receipt.actual, 'The original source capture did not publish scene evidence')
  const controlLoaded = await readFile(join(evidence, 'control-loaded.jsonl'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
  receipt.controlInputs = controlLoaded.trim() ? controlLoaded.trim().split('\n').map(line => JSON.parse(line)) : []
  if (!['endpoints', 'dispatch-motion', 'region-headers', 'list-feedback'].includes(scenario)) assert.ok(receipt.controlInputs.some(input => input.path === 'packages/core/src/public-rpc-server.ts') && receipt.controlInputs.some(input => input.path === 'packages/core/src/agentmux-cli-commands.ts'), 'Original Core server and source CLI must load in the public App join')
  for (const input of receipt.controlInputs) { assert.equal(input.originalSHA256, input.effectiveSHA256, 'Public join uses unmodified source'); if (sources[input.path]) assert.equal(sources[input.path], input.originalSHA256); sources[input.path] = input.originalSHA256 }
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  const pinnedAfter = pinnedSourceAfter(root, receipt.compilation.sourceOverlay, sources)
  receipt.sourceAfter = Object.fromEntries(await Promise.all(Object.keys(sources).map(async file => [file, pinnedAfter[file] ?? hash(await readFile(join(root, file)))])))
  receipt.resolverMetadata = receipt.compilation.resolverMetadata
  receipt.resolverMetadataAfter = await captureResolverMetadata(root)
  receipt.changedResolverMetadata = Object.keys(receipt.resolverMetadata).filter(file => receipt.resolverMetadata[file] !== receipt.resolverMetadataAfter[file])
  assert.deepEqual(receipt.changedResolverMetadata, [], 'Declared current resolver metadata changed during capture')
  receipt.harnessAfter = Object.fromEntries(await Promise.all(harnessFiles.map(async file => [relative(root, file), hash(await readFile(file))])))
  receipt.changedInputs = Object.keys(sources).filter(file => sources[file] !== receipt.sourceAfter[file])
  receipt.changedHarness = Object.keys(receipt.harness).filter(file => receipt.harness[file] !== receipt.harnessAfter[file])
  if (cacheDirectory) {
    receipt.watchInputsAfter = Object.fromEntries(await Promise.all(Object.keys(receipt.compilation.watchInputs ?? {}).map(async file => [file, hash(await readFile(file))])))
    receipt.changedWatchInputs = Object.keys(receipt.compilation.watchInputs ?? {}).filter(file => receipt.compilation.watchInputs[file] !== receipt.watchInputsAfter[file])
    assert.deepEqual(receipt.changedWatchInputs, [], 'Actual current renderer dependencies/assets changed during capture')
    assert.deepEqual(await rendererOutputHashes(compiled), receipt.outputs, 'The served renderer bytes remain unchanged')
  }
  assert.equal(receipt.process.exitCode, 0, JSON.stringify(receipt.actual.failures.map(({ name, message }) => ({ name, message })))); assert.equal(receipt.actual.passed, true)
  assert.equal(receipt.changedInputs.length, 0, 'Candidate changed during capture: ' + receipt.changedInputs.join(', '))
  assert.equal(receipt.changedHarness.length, 0, 'Capture harness changed during execution: ' + receipt.changedHarness.join(', '))
  if (scenario === 'endpoints') require(join(fixture, 'endpoints.cjs')).verify(receipt.actual.endpoints, receipt.frames, receipt.actual.nativeWorkers)
  if (scenario === 'dispatch-motion') require(join(fixture, 'dispatch-motion.cjs')).verify(receipt.actual.dispatchMotion, receipt.frames)
  if (scenario === 'list-feedback') require(join(fixture, listCostOnly ? 'list-feedback-cost.cjs' : listVisualRefresh ? 'list-feedback-visual-refresh.cjs' : 'list-feedback.cjs')).verify(listCostOnly ? receipt.actual.listFeedbackCost : listVisualRefresh ? receipt.actual.listFeedbackVisualRefresh : receipt.actual.listFeedback, receipt.frames, receipt)
  if (scenario === 'region-headers') require(join(fixture, 'region-headers.cjs')).verify(receipt.actual.regionHeaders, receipt.frames)
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
