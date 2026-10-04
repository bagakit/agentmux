import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const fixture = join(desktop, 'scripts/fixtures/mote-shared-space-frame'), require = createRequire(join(desktop, 'package.json'))
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-shared-frame-'))
const evidenceFlag = process.argv.indexOf('--evidence-dir')
const evidenceArgument = evidenceFlag >= 0 ? process.argv[evidenceFlag + 1] : process.argv.find(value => value.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length)
assert.ok(evidenceFlag < 0 || evidenceArgument && !evidenceArgument.startsWith('--'), '--evidence-dir requires a directory')
const evidence = resolve(evidenceArgument ?? process.env.AGENTMUX_SHARED_FRAME_EVIDENCE ?? join(repository, '.tmp/mote-shared-space-frame', ("attempt-" + (globalThis.crypto.randomUUID()) + "")))
const geometryDiagnostic = process.argv.includes('--diagnostic-zero-area')
const serviceHintDiagnostic = process.argv.includes('--diagnostic-service-hint')
const referenceCounterOnly = process.argv.includes('--reference-counter-only')
const preMoveReadDiagnostic = process.argv.includes('--diagnostic-pre-move-read')
const styleMoveTraceDiagnostic = process.argv.includes('--diagnostic-style-move-trace')
const preMoveStyleReadDiagnostic = process.argv.includes('--diagnostic-pre-move-style-read')
const commitIntervalDiagnostic = process.argv.includes('--diagnostic-commit-interval')
const noDisclosureOpenDiagnostic = process.argv.includes('--diagnostic-no-disclosure-open')
const floatSpaceShortcut = process.argv.includes('--float-space-shortcut')
const shortcutPointerDiagnostic = process.argv.includes('--diagnostic-shortcut-pointer-owner')
assert.ok(!shortcutPointerDiagnostic || floatSpaceShortcut, 'Pointer-owner diagnostic requires the narrow shortcut fixture')
const boundedReference = referenceCounterOnly || preMoveReadDiagnostic || styleMoveTraceDiagnostic || preMoveStyleReadDiagnostic || commitIntervalDiagnostic || noDisclosureOpenDiagnostic
assert.ok(!floatSpaceShortcut || !(boundedReference || geometryDiagnostic || serviceHintDiagnostic), 'The floating shortcut journey cannot use a private diagnostic intervention')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = new Map(), styles = new Set(), watchedStyles = new Set()
const localStyle = file => file?.startsWith(repository + '/') && file.endsWith('.css') && !file.includes('/node_modules/')
const stylesheetBinding = { postcssPlugin: 'bind-shared-frame-consumed-styles', async Once(root) {
  const consumed = new Map()
  const remember = node => { const input = node.source?.input; if (localStyle(input?.file)) consumed.set(input.file, input.css) }
  remember(root); root.walk(remember)
  for (const [file, css] of consumed) {
    const digest = hash(css)
    assert.equal(hash(await readFile(file)), digest, 'Consumed style changed: ' + relative(repository, file))
    if (inputs.has(file)) assert.equal(inputs.get(file), digest)
    inputs.set(file, digest); styles.add(file)
  }
} }
const binding = { name: 'bind-shared-frame-current-source', enforce: 'pre', async load(id) {
  const file = id.split('?')[0]
  if (file.startsWith(repository + '/') && !file.includes('/node_modules/') && !inputs.has(file)) inputs.set(file, hash(await readFile(file)))
  return null
}, buildEnd() {
  for (const file of this.getWatchFiles()) if (localStyle(file)) {
    watchedStyles.add(file); assert.ok(styles.has(file), 'Missing consumed stylesheet: ' + relative(repository, file))
  }
} }
let controlledApiTransforms = 0
const result = { schema: 'agentmux.mote-shared-frame-renderer-proof.v1', passed: false, aestheticReview: 'not-performed', userRunTouched: false, acceptanceScope: shortcutPointerDiagnostic ? 'diagnostic-shortcut-pointer-event-owner' : floatSpaceShortcut ? 'floating-space-shortcut-two-process-journey' : noDisclosureOpenDiagnostic ? 'diagnostic-no-disclosure-open' : commitIntervalDiagnostic ? 'diagnostic-commit-interval' : preMoveStyleReadDiagnostic ? 'diagnostic-pre-move-style-read' : styleMoveTraceDiagnostic ? 'diagnostic-style-move-trace' : preMoveReadDiagnostic ? 'diagnostic-pre-move-layout-read' : referenceCounterOnly ? 'bounded-native-reference-counter' : 'complete-two-process-journey',
  privateInterventions: { geometryDiagnostic, serviceHintDiagnostic, preMoveReadDiagnostic, styleMoveTraceDiagnostic, preMoveStyleReadDiagnostic, commitIntervalDiagnostic, noDisclosureOpenDiagnostic },
  phases: [], privateProfile: join(privateRoot, 'user-data'), cleanup: null,
  limitations: ['Only controlled public Session/API facts. Real ordinary initialize consumes durable workbench and requests exact retained Session/Run recovery in the second process; no Core/ctxmux/CLI survival claim.',
    'Complete production desktop App branch; no Browser Region is seeded and no Native Browser input/composition claim is made. CDP exercises real Chromium controls, not hardware or OS IME.',
    'Lightweight isolated Renderer compilation, not a formal build/package/install. Screenshot success does not constitute independent aesthetic approval.'] }
await mkdir(evidence, { recursive: true })
try {
  for (const file of [import.meta.filename, join(desktop, 'scripts/probe-process.mjs'), ...['main.cjs', 'entry.mjs', 'index.html', 'scenario.md'].map(name => join(fixture, name))]) inputs.set(file, hash(await readFile(file)))
  if (floatSpaceShortcut) inputs.set(join(fixture, 'float-space-shortcut.cjs'), hash(await readFile(join(fixture, 'float-space-shortcut.cjs'))))
  // Bind maintained public package exports to current Source, never a stale dist.
  const aliases = []
  for (const name of ['core', 'demand', 'layout']) {
    const directory = join(repository, 'packages', name)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    inputs.set(join(directory, 'package.json'), hash(await readFile(join(directory, 'package.json'))))
    const entries = Object.entries(manifest.exports)
    assert.ok(entries.length > 0, 'Nonempty public Source exports: ' + name)
    for (const [subpath, target] of entries) {
      assert.ok(target.import.startsWith('./dist/') && target.import.endsWith('.js') ||
        target.import.startsWith('./src/') && target.import.endsWith('.ts'), 'Explicit Source mapping: ' + name + subpath)
      const specifier = '@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))
      const source = target.import.endsWith('.ts') ? target.import :
        target.import.replace('./dist/', name === 'demand' ? './' : './src/').replace(/\.js$/, '.ts')
      const replacement = resolve(directory, source)
      await readFile(replacement)
      aliases.push({ find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement })
    }
  }
  const client = join(repository, 'packages/client-ui')
  const clientManifest = JSON.parse(await readFile(join(client, 'package.json'), 'utf8'))
  inputs.set(join(client, 'package.json'), hash(await readFile(join(client, 'package.json'))))
  const clientExports = Object.entries(clientManifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
  for (const [subpath, target] of clientExports) {
    const source = typeof target === 'string' ? target : target.browser ?? target.types
    assert.ok(source.startsWith('./src/'), 'Client UI consumes public current Source: ' + subpath)
    const specifier = '@agentmux/client-ui' + (subpath === '.' ? '' : subpath.slice(1))
    const expression = specifier.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
    aliases.push({ find: new RegExp('^' + expression + '$'), replacement: resolve(client, source).replace('*', '$1') })
  }
  const outDir = join(privateRoot, 'renderer')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: aliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    css: { postcss: { plugins: [stylesheetBinding] } }, plugins: [binding, {
      name: 'private-shared-frame-public-api-boundary', enforce: 'pre', transform(code, id) {
        if (id.split('?')[0] !== join(desktop, 'src/renderer/src/lib/api.ts')) return null
        const anchor = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
        assert.equal(code.split(anchor).length - 1, 1, 'Exactly one actual controlled API boundary')
        controlledApiTransforms += 1
        return { code: code.replace(anchor, 'export const api = mockApi'), map: null }
      }
    }], build: { target: 'esnext', outDir, emptyOutDir: true } })
  assert.equal(controlledApiTransforms, 1)
  assert.ok(styles.size > 1 && watchedStyles.size > 1, 'Actual consumed style graph is nonempty')
  assert.deepEqual([...styles].sort(), [...watchedStyles].sort(), 'Consumed bytes cover Vite stylesheet dependencies')
  for (const owner of ['App.tsx', 'store.ts', 'PmoTeamsTopicEntry.tsx', 'PmoTeamsTopicFloatingPanel.tsx', 'WorkspaceWorkbench.tsx', 'MoteWorkface.tsx', 'MoteDetailsPanel.tsx', 'SurfaceToolDock.tsx', 'pmo-teams-topic-floating.ts'])
    assert.ok([...inputs.keys()].some(file=>file.endsWith('/'+owner)), 'Actual product consumer compiled: '+owner)
  const compiled = {}
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name); compiled[relative(outDir, file)] = hash(await readFile(file))
  }
  assert.ok(Object.keys(compiled).length > 0, 'Original compiled bytes are nonempty')
  result.inputs = Object.fromEntries([...inputs].map(([file, digest]) => [relative(repository, file), digest]))
  result.stylesheets = Object.fromEntries([...styles].sort().map(file => [relative(repository, file), inputs.get(file)]))
  result.compiled = compiled; result.controlledApiTransforms = controlledApiTransforms
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  delete env.AGENTMUX_SHARED_FRAME_SHORTCUT_POINTER_DIAGNOSTIC
  if (shortcutPointerDiagnostic) { env.AGENTMUX_SHARED_FRAME_SHORTCUT_POINTER_DIAGNOSTIC='1'; result.notAcceptance=true; result.diagnostic='Observe only the exact original native input pointer event and delegate Event.preventDefault unchanged while capturing its caller stack. Original private-window setup and strict input counter stay unchanged; one process, not UI or restart acceptance.' }
  delete env.AGENTMUX_SHARED_FRAME_FLOAT_SPACE_SHORTCUT
  if (floatSpaceShortcut) env.AGENTMUX_SHARED_FRAME_FLOAT_SPACE_SHORTCUT = '1'
  for (const key of ['AGENTMUX_SHARED_FRAME_GEOMETRY_DIAGNOSTIC', 'AGENTMUX_SHARED_FRAME_SERVICE_HINT_DIAGNOSTIC', 'AGENTMUX_SHARED_FRAME_PRE_MOVE_READ_DIAGNOSTIC', 'AGENTMUX_SHARED_FRAME_STYLE_MOVE_TRACE_DIAGNOSTIC', 'AGENTMUX_SHARED_FRAME_PRE_MOVE_STYLE_READ_DIAGNOSTIC', 'AGENTMUX_SHARED_FRAME_COMMIT_INTERVAL_DIAGNOSTIC', 'AGENTMUX_SHARED_FRAME_NO_DISCLOSURE_OPEN_DIAGNOSTIC', 'AGENTMUX_SHARED_FRAME_REFERENCE_COUNTER_ONLY']) delete env[key]
  if (geometryDiagnostic) { env.AGENTMUX_SHARED_FRAME_GEOMETRY_DIAGNOSTIC = '1'; result.diagnostic = 'Bounded original path through confirmed-reference cutover; no full journey or two-PID acceptance.' }
  if (serviceHintDiagnostic) { env.AGENTMUX_SHARED_FRAME_SERVICE_HINT_DIAGNOSTIC = '1'; result.diagnostic = 'Private service-details popover auto-to-hint override; bounded original reference/inner close/Escape/input counter only, no production or two-PID acceptance.' }
  if (boundedReference) env.AGENTMUX_SHARED_FRAME_REFERENCE_COUNTER_ONLY='1'
  if (preMoveReadDiagnostic) {
    env.AGENTMUX_SHARED_FRAME_PRE_MOVE_READ_DIAGNOSTIC='1'
    result.notAcceptance=true
    result.diagnostic='Private destination.getBoundingClientRect() read immediately before the original Element.moveBefore call. No style, attribute, selection or DOM repair; one-process diagnostic, no product or restart acceptance.'
  }
  if (styleMoveTraceDiagnostic) {
    assert.equal(geometryDiagnostic || serviceHintDiagnostic || preMoveReadDiagnostic || preMoveStyleReadDiagnostic, false, 'Pure style/move trace does not combine other diagnostic interventions')
    env.AGENTMUX_SHARED_FRAME_STYLE_MOVE_TRACE_DIAGNOSTIC='1'
    result.notAcceptance=true
    result.diagnostic='Pure synchronous body attribute/parent and original moveBefore event trace. No pre-move style/geometry reads or source/DOM/style repair. CSS diagnostics only after the original counter failure or completion; one process, not acceptance.'
  }
  if (preMoveStyleReadDiagnostic) {
    assert.equal(geometryDiagnostic || serviceHintDiagnostic || preMoveReadDiagnostic || styleMoveTraceDiagnostic, false, 'Style-read diagnostic does not combine other interventions')
    env.AGENTMUX_SHARED_FRAME_PRE_MOVE_STYLE_READ_DIAGNOSTIC='1'
    result.notAcceptance=true
    result.diagnostic='Before each connected original moveBefore: read host/source parent/destination/documentElement display, visibility and position; additionally observe both floating bodies computed appearance before/after the original move. The extra body observations may affect the outcome. No geometry read or style/attribute/DOM repair; one-process diagnostic, not product acceptance.'
  }
  if (commitIntervalDiagnostic) {
    assert.equal(geometryDiagnostic || serviceHintDiagnostic || preMoveReadDiagnostic || styleMoveTraceDiagnostic || preMoveStyleReadDiagnostic, false, 'Commit interval trace does not combine other interventions')
    env.AGENTMUX_SHARED_FRAME_COMMIT_INTERVAL_DIAGNOSTIC='1'
    result.notAcceptance=true
    result.diagnostic='Trace only the original bad-reference commit interval: original DOM insert/remove/append/move, relevant attributes and popover methods/events, plus actual Chromium invalidation timeline. No added style/geometry queries, style/attribute/DOM repair or source changes. Original strict counter remains; one-process diagnostic, not product acceptance.'
  }
  if (noDisclosureOpenDiagnostic) {
    assert.equal(geometryDiagnostic || serviceHintDiagnostic || preMoveReadDiagnostic || styleMoveTraceDiagnostic || preMoveStyleReadDiagnostic || commitIntervalDiagnostic, false, 'No-disclosure ablation does not combine other interventions')
    env.AGENTMUX_SHARED_FRAME_NO_DISCLOSURE_OPEN_DIAGNOSTIC='1'
    result.notAcceptance=true
    result.diagnostic='Only omit the original inner disclosure open/close interaction, retaining the original known/unknown/confirmation path, same nodes, strict presented styles and physical Group containment. Stop after first confirmation in one process. No style/DOM repair or production change; ablation, not product acceptance.'
  }
  for (const phase of shortcutPointerDiagnostic || geometryDiagnostic || serviceHintDiagnostic || boundedReference ? ['seed'] : ['seed', 'restore']) {
    for (const [file, digest] of Object.entries(compiled)) assert.equal(hash(await readFile(join(outDir, file))), digest, 'Both processes consume immutable compile: '+file)
    const logs = []
    const exit = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), privateRoot, phase, evidence],
      { temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 120000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, phase + '.log'), logs.join('\n'))
    const phaseResult = { phase, exit }; result.phases.push(phaseResult)
    assert.equal(exit.timedOut, false, 'Bounded phase published: '+phase)
    phaseResult.app = JSON.parse(await readFile(join(evidence, phase+'.json'), 'utf8'))
    assert.equal(exit.exitCode, 0, phaseResult.app.failure?.message)
    assert.equal(phaseResult.app.passed, true)
  }
  assert.equal(new Set(result.phases.map(one => one.app.pid)).size, shortcutPointerDiagnostic || boundedReference ? 1 : 2, shortcutPointerDiagnostic || boundedReference ? 'Bounded original-reference counter uses one private process, no restart claim' : 'Two independent real Electron processes')
  for (const [file, digest] of inputs) assert.equal(hash(await readFile(file)), digest, 'Source unchanged during proof: '+relative(repository,file))
  result.passed = true
  await writeFile(join(evidence, 'review.md'), ['# Mote shared Space frame screenshots — independent review pending', '',
    (noDisclosureOpenDiagnostic ? 'Private inner-disclosure ablation, not product acceptance or independent aesthetic approval. ' : commitIntervalDiagnostic ? 'Private DOM/Chromium invalidation trace, not product acceptance or independent aesthetic approval. ' : preMoveStyleReadDiagnostic ? 'Private pre-move style-read diagnostic with extra body observations, not product acceptance or independent aesthetic approval. ' : styleMoveTraceDiagnostic ? 'Private attribute/move trace, not product acceptance or independent aesthetic approval. ' : preMoveReadDiagnostic ? 'Private pre-move layout-read diagnostic, not product acceptance or independent aesthetic approval. ' : referenceCounterOnly ? 'Bounded actual original-reference counter in one private process; no full journey or restart claim. ' : 'Complete production App, real durable Store initialize, one immutable compile and private profile, two actual independent processes. ') + 'Controlled public Session requests do not prove Core/ctxmux/CLI survival. No Native Browser scope is claimed. Capture success is not aesthetic approval.', '',
    ...result.phases.flatMap(one => one.app.frames.map(frame => '- ' + one.phase + ' / ' + frame.name + ': [' + frame.source + '](' + frame.file + ')')), '',
    'Review the complete images against the owning Mote and shared Space frame SSOT. Source, styles, fixture, compiled identities and profile are in receipt.json.', ''].join('\n'))
} catch (error) { result.failure = { name:error.name, message:error.message, stack:error.stack } }
finally {
  const drift = []
  for (const [file, digest] of inputs) {
    try { const actual = hash(await readFile(file)); if (actual !== digest) drift.push({ file: relative(repository, file), expected: digest, actual }) }
    catch (error) { drift.push({ file: relative(repository, file), expected: digest, unavailable: error.message }) }
  }
  result.sourceReadback = { status: inputs.size > 0 && drift.length === 0 ? 'exact' : 'unconfirmed', count: inputs.size, drift }
  if (drift.length > 0) { result.passed = false; result.sourceIdentityFailure = 'Consumed Source changed during this attempt; it cannot attest the current product.' }
  const remaining = await listProbeProcesses(-1, privateRoot)
  result.cleanup = { remaining, privateRootRemoved: false }
  if (remaining.length === 0) { await rm(privateRoot, { recursive: true }); result.cleanup.privateRootRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({passed:result.passed,receipt:join(evidence,'receipt.json'),failure:result.failure,cleanup:result.cleanup}))
assert.equal(result.cleanup.remaining.length, 0, 'Strict private process cleanup; preserve profile when unconfirmed')
assert.equal(result.passed, true, result.failure?.message)
