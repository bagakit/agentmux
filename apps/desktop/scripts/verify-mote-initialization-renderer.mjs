import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const reliability = process.env.MOTE_SETUP_RELIABILITY === '1'
const recoveryVisualOnly = reliability && process.env.MOTE_RECOVERY_VISUAL_ONLY === '1'
const visualOnly = recoveryVisualOnly || reliability && process.env.MOTE_HEARTBEAT_ICON === '1'
const fixture = join(desktop, 'scripts/fixtures/' + (reliability ? 'mote-reliability' : 'mote-initialization')), require = createRequire(join(desktop, 'package.json'))
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-initialization-'))
const evidence = resolve(process.env.MOTE_INITIALIZATION_VISUAL_EVIDENCE ?? join(repository, '.local/state/mote-initialization/visual', 'capture-' + globalThis.crypto.randomUUID()))
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
const result = { schema: 'agentmux.mote-initialization-renderer-proof.v1', passed: false, captureOnly: true, aestheticReview: 'not-performed', phases: [],
  boundary: 'Complete production App and ordinary Store initialize; controlled public API facts, current source compilation, private original durable profile, ' + (visualOnly ? 'one capture-only Electron process' : 'two independent Electron processes') + '. No user App/Session/Run, real Runtime lifecycle, package or install is touched.' }
await mkdir(evidence, { recursive: true })
try {
  for (const file of [import.meta.filename, join(desktop, 'scripts/probe-process.mjs'), join(desktop, 'scripts/fixtures/mote-shared-space-frame/entry.mjs'), ...['main.cjs', 'entry.mjs', 'index.html', 'scenario.md'].map(name => join(fixture, name))]) inputs.set(file, hash(await readFile(file)))
  // Bind maintained public package exports to current Source, never a stale dist.
  const aliases = []
  for (const name of ['core', 'demand', 'layout', 'host']) {
    const directory = join(repository, name === 'host' ? 'apps' : 'packages', name)
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
    assert.ok(source && !source.startsWith('./dist/'), 'Client UI consumes public current Source: ' + subpath)
    const specifier = '@agentmux/client-ui' + (subpath === '.' ? '' : subpath.slice(1))
    const expression = specifier.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
    aliases.push({ find: new RegExp('^' + expression + '$'), replacement: resolve(client, source).replace('*', '$1') })
  }
  const outDir = join(privateRoot, 'renderer')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    worker: { format: 'es' },
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
  for (const owner of ['App.tsx', 'store.ts', 'PmoTeamsTopicEntry.tsx', 'PmoTeamsTopicFloatingPanel.tsx', 'WorkspaceWorkbench.tsx', 'MoteWorkface.tsx', 'MoteDetailsPanel.tsx', 'SurfaceToolDock.tsx', 'pmo-teams-topic-floating.ts', 'MoteProfileDialog.tsx', 'MoteQuickMode.tsx', ...(reliability ? ['MoteHeartbeatStatus.tsx', 'MoteStartupStatus.tsx'] : [])])
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
  for (const phase of visualOnly ? ['seed'] : ['seed', 'restore']) {
    const logs = []
    const exit = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), privateRoot, phase, evidence],
      { temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 90000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, phase + '.log'), logs.join('\n'))
    const app = JSON.parse(await readFile(join(evidence, phase + '.json'), 'utf8'))
    result.phases.push({ phase, exit, app })
    assert.equal(exit.exitCode, 0, app.failure?.message); assert.equal(app.passed, true, app.failure?.message)
  }
  assert.equal(new Set(result.phases.map(one => one.app.pid)).size, visualOnly ? 1 : 2, 'Actual independent Electron capture processes')
  if (reliability && !visualOnly) {
    const seed = result.phases.find(one => one.phase === 'seed').app, restore = result.phases.find(one => one.phase === 'restore').app
    assert.ok(seed.original.agentDrafts[seed.original.session.id]?.trim() && seed.original.drafts['private-mote-reliability-original-draft']?.prompt?.trim(), 'Nonempty original inputs are required')
    assert.deepEqual(seed.persistedInputs, { agentDrafts: seed.original.agentDrafts, drafts: seed.original.drafts })
    assert.deepEqual(restore.restored.inputAtEntry.agentDrafts, seed.original.agentDrafts)
    assert.deepEqual(restore.restored.inputAtEntry.drafts, seed.original.drafts)
    assert.deepEqual(restore.restored.agentDrafts, seed.original.agentDrafts)
    assert.deepEqual(restore.restored.drafts, seed.original.drafts)
    assert.deepEqual(restore.persistedInputs, seed.persistedInputs)
    assert.deepEqual(restore.restored.fixtureWrites, [])
    result.draftRestore = { restoreDidNotSeed: true, persistedOriginalVerified: true, nonemptyOriginalVerified: true,
      seedPid: seed.pid, restorePid: restore.pid, seedWitness: seed.draftWitness,
      seed: { file: 'seed.json', sha256: hash(await readFile(join(evidence, 'seed.json'))) },
      restore: { file: 'restore.json', sha256: hash(await readFile(join(evidence, 'restore.json'))) },
      fields: { seedInputs: 'original.{drafts,agentDrafts}', persistedInputs: 'persistedInputs', restoredBeforeFixture: 'restored.inputAtEntry', restoredInputs: 'restored.{drafts,agentDrafts}', topology: 'original/restored.{tabs,layouts,selection,focus,session.control}' } }
  }
  result.passed = true
  await writeFile(join(evidence, 'review.md'), ['# Mote initialization screenshots - independent review pending', '',
    result.boundary, '', ...result.phases.flatMap(one => one.app.frames.map(frame => '- ' + one.phase + ' / ' + frame.name + ': [' + frame.name + '](' + frame.file + ')')), ''].join('\n'))
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const drift = []
  for (const [file, digest] of inputs) {
    try { const actual = hash(await readFile(file)); if (actual !== digest) drift.push({ file: relative(repository, file), expected: digest, actual }) }
    catch (error) { drift.push({ file: relative(repository, file), expected: digest, unavailable: error.message }) }
  }
  result.sourceReadback = { status: inputs.size && !drift.length ? 'exact' : 'unconfirmed', count: inputs.size, drift }
  if (drift.length) { result.passed = false; result.sourceIdentityFailure = 'Consumed Source changed during capture' }
  const remaining = await listProbeProcesses(-1, privateRoot)
  result.cleanup = { remaining, privateRootRemoved: false }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); result.cleanup.privateRootRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, evidence, failure: result.failure, cleanup: result.cleanup }))
assert.equal(result.cleanup.remaining.length, 0, 'Private process cleanup confirmed')
assert.equal(result.passed, true, result.failure?.message)
