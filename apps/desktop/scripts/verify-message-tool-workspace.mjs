import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'
import { mutations } from './fixtures/message-tool-workspace/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/message-tool-workspace')
const evidence = join(root, '.tmp/message-tool-workspace', 'attempt-' + globalThis.crypto.randomUUID())
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-message-workspace-'))
const require = createRequire(import.meta.url), exec = promisify(execFile)
// Compile the same public Core exports from source; never rewrite a concurrent shared dist.
const coreExports = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8')).exports
const coreAliases = Object.entries(coreExports).map(([key, target]) => ({
  find: new RegExp('^@agentmux/core' + (key === '.' ? '' : key.slice(1)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
  replacement: join(root, 'packages/core', target.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
const hash = value => createHash('sha256').update(value).digest('hex')
const densityMutation = process.argv.includes('--density-mutation')
const interactionStates = process.argv.includes('--interaction-states'), recovery = process.argv.includes('--notification-recovery'), resumed = process.argv.includes('--notification-resumed'), manualNotify = process.argv.includes('--manual-notify') || recovery || resumed
const emptyStates = process.argv.includes('--empty-states'), emptyMutation = process.argv.includes('--empty-mutation')
const automation = process.argv.includes('--automation')
assert.ok([densityMutation, interactionStates, manualNotify, emptyStates, emptyMutation, automation, process.argv.includes('--mutations')].filter(Boolean).length <= 1, 'Renderer and mutation modes are separate')
const selectedMutation = process.argv.includes('--mutation') ? process.argv[process.argv.indexOf('--mutation') + 1] : undefined
assert.ok(!selectedMutation || mutations.some(item => item.name === selectedMutation), 'The named mutation exists')
const result = { schema: 'agentmux.message-workspace-proof.v1', passed: false, userRunTouched: false, productionWritten: false,
  mode: resumed ? 'notification-resumed' : recovery ? 'notification-recovery' : manualNotify ? 'manual-notify' : emptyMutation ? 'empty-mutation' : emptyStates ? 'empty-states' : densityMutation ? 'density-mutation' : interactionStates ? 'interaction-states' : automation ? 'automation' : process.argv.includes('--mutations') ? 'mutations' : 'renderer', aestheticReview: 'not-performed', cleanup: {} }
await mkdir(evidence, { recursive: true })

async function mounted(label, mutation) {
  const directory = join(evidence, label)
  const env = { ...process.env, AGENTMUX_MESSAGE_WORKSPACE_EVIDENCE: relative(root, directory) }
  if (mutation) env.AGENTMUX_MESSAGE_WORKSPACE_MUTATION = mutation
  else delete env.AGENTMUX_MESSAGE_WORKSPACE_MUTATION
  let code = 0, output = ''
  try {
    const run = await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
      'apps/desktop/scripts/fixtures/message-tool-workspace/vitest.config.mts', 'apps/desktop/test/message-tool-workspace.test.tsx'],
    { cwd: root, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    output = run.stdout + run.stderr
  } catch (error) { code = error.code; output = (error.stdout ?? '') + (error.stderr ?? '') }
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'test.log'), output)
  const discovery = JSON.parse(await readFile(join(directory, 'discovery.json'), 'utf8'))
  const tests = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
  assert.equal(discovery.requested.length, 1); assert.equal(discovery.discovered.length, 1)
  assert.ok(discovery.discovered[0].tests > 0, 'The real suite is nonempty')
  if (mutation) {
    assert.equal(discovery.applied.length, 1, 'The actual production consumer was mutated')
    assert.equal(typeof code, 'number'); assert.notEqual(code, 0)
    assert.ok(tests.numFailedTests > 0 && tests.testResults.every(suite => suite.assertionResults.length > 0), 'A behavioral assertion kills the mutation, not import failure or timeout')
    assert.match(output, /AssertionError:/)
  } else { assert.equal(code, 0, output); assert.ok(tests.numPassedTests > 0); assert.equal(tests.numFailedTests, 0) }
  return { label, code, tests: tests.numTotalTests, failed: tests.numFailedTests, applied: discovery.applied }
}

async function renderer({ label = 'full', density = false, mutate = false, interactions = false, empty = false } = {}) {
  const { build } = await import('vite'), outDir = join(privateRoot, label, 'renderer')
  const directory = density || empty ? join(evidence, label) : evidence
  await mkdir(directory, { recursive: true })
  const xterm = require.resolve('@xterm/xterm'), wrapper = join(privateRoot, 'record-xterm.mjs')
  await writeFile(wrapper, `import xterm from ${JSON.stringify(xterm)};
    export class Terminal extends xterm.Terminal { constructor(...args){super(...args);const entries=globalThis.identityTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}
      dispose(){this.probeIdentity.disposed=true;return super.dispose()} }
  `)
  const loaded = {}, styles = {}, applied = []
  const owner = 'packages/client-ui/src/styles/composer.css'
  const selector = empty ? '.composer-mailbox__empty' : '.composer-mailbox__folders > button'
  const property = empty ? 'padding' : 'min-height', mutatedValue = empty ? '32px 6px' : '48px'
  const mutatedDeclarations = new WeakSet()
  const cssMutation = { postcssPlugin: 'message-workspace-owning-css-mutation', Declaration(declaration) {
    if (!mutate || mutatedDeclarations.has(declaration) || declaration.prop !== property ||
      declaration.parent.selector !== selector || declaration.source?.input.file !== join(root, owner)) return
    assert.equal(applied.length, 0, 'The original density declaration is uniquely consumed')
    assert.notEqual(declaration.value, mutatedValue, 'The density mutation changes the actual owner')
    applied.push({ file: owner, original: hash(declaration.source.input.css), phase: 'postcss-imported-declaration',
      selector: declaration.parent.selector, property: declaration.prop,
      ...(empty ? { originalPadding: declaration.value, mutatedPadding: mutatedValue } : { originalMinHeight: declaration.value, mutatedMinHeight: mutatedValue }) })
    mutatedDeclarations.add(declaration)
    declaration.value = mutatedValue
  } }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    resolve: { dedupe: ['react', 'react-dom'], alias: [{ find: /^@xterm\/xterm$/, replacement: wrapper }, ...coreAliases] },
    css: { postcss: { plugins: [cssMutation] } },
    plugins: [{ name: 'record-message-workspace-inputs', enforce: 'pre', transform(source, id) {
      if ((id.startsWith(join(desktop, 'src') + '/') || id.startsWith(join(root, 'packages/client-ui/src') + '/') || id.startsWith(join(root, 'packages/core/src') + '/') || id.startsWith(fixture + '/')) && !id.includes('?')) loaded[relative(root, id)] = hash(source)
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + '/') && file.endsWith('.css')) styles[relative(root, file)] = hash(await readFile(file))
    } }], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  for (const file of ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/components/SessionPane.tsx',
    'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    'packages/client-ui/src/components/InputMailboxRecords.tsx', 'packages/client-ui/src/components/InputHistoryList.tsx']) assert.ok(loaded[file], 'The actual production source is compiled: ' + file)
  assert.ok(styles[owner], 'The actual owner stylesheet is compiled')
  if (empty) assert.ok(loaded['apps/desktop/src/renderer/src/components/MailboxReading.tsx'], 'The original empty-state component is compiled')
  assert.equal(applied.length, mutate ? 1 : 0, 'Only the requested source consumer is mutated')
  if (mutate) assert.equal(applied[0].original, styles[owner], 'The imported declaration binds the unchanged original owner source')
  const outputs = {}
  for (const file of await readdir(outDir, { recursive: true })) {
    try { outputs[file] = hash(await readFile(join(outDir, file))) } catch (error) { if (error.code !== 'EISDIR') throw error }
  }
  assert.ok(Object.keys(outputs).length > 0)
  const proof = { label, compilation: { loaded, styles, outputs, applied } }
  if (!density) result.compilation = proof.compilation
  await writeFile(join(directory, 'compilation.json'), JSON.stringify(proof.compilation, null, 2) + '\n')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const log = []
  result.process = proof.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), privateRoot, directory, resumed ? 'notification-resumed' : recovery ? 'notification-recovery' : manualNotify ? 'manual-notify' : empty ? mutate ? 'empty-mutation' : 'empty-states' : density ? 'density' : interactions ? 'interaction-states' : automation ? 'automation' : 'full'],
    { cwd: root, env, timeoutMs: 180000, onLine: line => log.push(line) })
  await writeFile(join(directory, 'process.log'), log.join('\n'))
  proof.render = JSON.parse(await readFile(join(directory, 'render.json'), 'utf8'))
  assert.equal(proof.process.timedOut, false)
  if (mutate) {
    assert.equal(proof.process.exitCode, 1, 'The mutant must reach the Renderer and fail its assertion')
    assert.equal(proof.render.passed, false)
    assert.equal(proof.render.failure?.name, 'AssertionError')
    const code = empty ? 'EMPTY_STATE_HEIGHT' : 'PRIMARY_NAV_HEIGHT'
    assert.equal(proof.render.failure?.density?.code, code, 'Only the intended measured density regression kills this mutation')
    assert.deepEqual(proof.render.failure.density.actual, empty ? 82 : [48, 48, 48], 'The original consumer uses the mutated spacing')
    proof.expectedFailure = { kind: 'measured-density-assertion', code, actual: proof.render.failure.density.actual }
    return proof
  }
  assert.equal(proof.process.exitCode, 0, JSON.stringify(proof.render.failure))
  assert.equal(proof.render.passed, true)
  assert.equal(proof.render.scenes.length, manualNotify || automation ? 3 : density || interactions ? 1 : 6)
  if (density) return proof
  result.render = proof.render
  assert.ok(result.render.frames.length > 0)
  if (automation) {
    assert.ok(result.render.scenes.every(scene => scene.originalSurfacePreserved && scene.retainedAutomation && scene.controlsReachable))
    assert.equal(result.render.frames.length, 12, 'Each actual workface provides list, controls, minute-form and save captures')
  } else if (manualNotify) {
    assert.equal(result.render.frames.length, recovery ? 15 : 9)
    if (recovery) assert.equal(result.render.scenes.find(scene => scene.width === 640)?.reloadedIdentity, true)
    assert.ok(result.render.scenes.every(scene => scene.explicitNotification && scene.observationOnlyRefresh && scene.originalSurfacePreserved && (!recovery || scene.retainedUnknown && scene.keyboardReceipt && scene.sentRecipient)))
    if (resumed) {
      assert.equal(result.render.scenes.find(scene => scene.width === 640)?.reloadedIdentity, true)
      assert.ok(result.render.scenes.every(scene => scene.historicalRun !== scene.inputRun && scene.nullIsNotRefusal && scene.visibleFailureReason))
    }
  } else if (empty) {
    assert.deepEqual(result.render.frames.map(frame => [frame.width, frame.theme, frame.state]),
      ['dark', 'light'].flatMap(theme => [320, 380, 440].flatMap(width => ['empty-notices', 'empty-collaboration'].map(state => [width, theme, state]))))
    assert.ok(result.render.scenes.every(scene => scene.originalSurfacePreserved && scene.automationReturn && scene.keyboardClose))
  } else if (interactions) {
    assert.deepEqual(result.render.frames.map(frame => [frame.width, frame.theme, frame.state]), [[380, 'dark', 'record-hover'], [380, 'dark', 'search-focus']])
    assert.equal(result.render.scenes[0].originalSurfacePreserved, true)
  } else {
    assert.ok(result.render.short?.geometry.density.fullyVisibleRecords.length > 0, 'The short narrow surface exposes a complete original record')
    assert.equal(result.render.short.coarseInputs.pointer, 'coarse')
    assert.equal(result.render.short.coarseAgents.pointer, 'coarse')
  }
  await writeFile(join(directory, 'review.md'), ['# Message workspace visual review', '',
    'Actual isolated Electron Renderer: WorkspaceWorkbench → SessionPane → AgentSessionComposer → SessionMailbox.',
    'The original API ports receive bounded fixture records. This does not certify a live Host, CLI, installed app or Session recovery.',
    'User Sessions were not operated. Capture success does not certify aesthetic quality; open every complete image independently.', '',
    ...result.render.frames.map(frame => `- [${frame.theme} ${frame.width} ${frame.state}](${frame.file})`), ''].join('\n'))
  return proof
}
try {
  if (result.mode === 'mutations') {
    result.baseline = await mounted('baseline')
    result.mutations = []
    for (const item of mutations.filter(item => !selectedMutation || item.name === selectedMutation)) result.mutations.push(await mounted(item.name, item.name))
    result.restored = await mounted('restored')
  } else if (result.mode === 'empty-mutation') {
    result.emptyMutation = { mutant: await renderer({ label: 'mutant', empty: true, mutate: true }) }
    result.emptyMutation.restored = await renderer({ label: 'restored', empty: true })
    const original = result.emptyMutation.mutant.compilation.applied[0]
    assert.equal(result.emptyMutation.restored.compilation.styles[original.file], original.original, 'The restored empty views consume the unchanged original owner source')
  } else if (result.mode === 'density-mutation') {
    result.densityMutation = { mutant: await renderer({ label: 'mutant', density: true, mutate: true }) }
    result.densityMutation.restored = await renderer({ label: 'restored', density: true })
    const original = result.densityMutation.mutant.compilation.applied[0]
    assert.equal(result.densityMutation.restored.compilation.styles[original.file], original.original, 'The restored probe consumes the unchanged original owner source')
  } else await renderer({ interactions: interactionStates, empty: emptyStates })
  result.passed = true
} catch (error) {
  result.failure = { name: error.name, message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  const groupId = result.process?.originalPid
  try {
    const processes = await listProbeProcesses(groupId, privateRoot)
    if (processes.length) await stopProbeProcesses(groupId, privateRoot)
    result.cleanup.remaining = await listProbeProcesses(groupId, privateRoot)
    assert.equal(result.cleanup.remaining.length, 0)
    await rm(privateRoot, { recursive: true, force: true }); result.cleanup.privateRootRemoved = true
  } catch (error) { result.cleanup.failure = error.message; result.passed = false; process.exitCode = 1 }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: result.passed, mode: result.mode, evidence: relative(root, evidence), failure: result.failure }))
