import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const fixture = join(desktop, 'scripts/fixtures/mote-closed-tab-target'), require = createRequire(join(desktop, 'package.json'))
const affectedEmptyOnly = process.argv.includes('--affected-empty-only')
const overlayActions = process.argv.includes('--overlay-actions')
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-closed-tab-'))
const evidence = join(repository, '.tmp/mote-closed-tab-target', `attempt-${Date.now()}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = new Map(), styles = new Set(), watchedStyles = new Set()
const localStyle = file => file?.startsWith(repository + '/') && file.endsWith('.css') && !file.includes('/node_modules/')
const stylesheetBinding = { postcssPlugin: 'bind-closed-tab-consumed-styles', async Once(root) {
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
const binding = { name: 'bind-closed-tab-current-source', enforce: 'pre', async load(id) {
  const file = id.split('?')[0]
  if (file.startsWith(repository + '/') && !file.includes('/node_modules/') && !inputs.has(file)) inputs.set(file, hash(await readFile(file)))
  return null
}, buildEnd() {
  for (const file of this.getWatchFiles()) if (localStyle(file)) {
    watchedStyles.add(file); assert.ok(styles.has(file), 'Missing consumed stylesheet: ' + relative(repository, file))
  }
} }
let controlledApiTransforms = 0
const result = { schema: 'agentmux.mote-closed-tab-proof.v1', passed: false, aestheticReview: 'not-performed', userRunTouched: false,
  phases: [], affectedEmptyOnly, privateProfile: join(privateRoot, 'user-data'), cleanup: null,
  limitations: ['Only controlled public Session/API facts. Real ordinary initialize consumes durable workbench and requests exact retained Session/Run recovery in the second process; no Core/ctxmux/CLI survival claim.',
    'Complete production desktop App branch; no Browser Region is seeded and no Native Browser input/composition claim is made. CDP exercises real Chromium controls, not hardware or OS IME.',
    'Lightweight isolated Renderer compilation, not a formal build/package/install. Screenshot success does not constitute independent aesthetic approval.'] }
await mkdir(evidence, { recursive: true })
try {
  for (const file of [import.meta.filename, join(desktop, 'scripts/probe-process.mjs'), ...['main.cjs', 'index.html', 'scenario.md'].map(name => join(fixture, name))]) inputs.set(file, hash(await readFile(file)))
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
  const outDir = join(privateRoot, 'renderer')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: aliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    css: { postcss: { plugins: [stylesheetBinding] } }, plugins: [binding, {
      name: 'private-closed-tab-public-api-boundary', enforce: 'pre', transform(code, id) {
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
  for (const owner of ['App.tsx', 'store.ts', 'PmoTeamsTopicEntry.tsx', 'PmoTeamsTopicFloatingPanel.tsx', 'WorkspaceWorkbench.tsx', 'pmo-teams-topic-floating.ts'])
    assert.ok([...inputs.keys()].some(file=>file.endsWith('/'+owner)), 'Actual product consumer compiled: '+owner)
  const compiled = {}
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name); compiled[relative(outDir, file)] = hash(await readFile(file))
  }
  assert.ok(Object.keys(compiled).length > 0, 'Original compiled bytes are nonempty')
  result.inputs = Object.fromEntries([...inputs].map(([file, digest]) => [relative(repository, file), digest]))
  result.stylesheets = Object.fromEntries([...styles].sort().map(file => [relative(repository, file), inputs.get(file)]))
  result.compiled = compiled; result.controlledApiTransforms = controlledApiTransforms
  const env = { ...process.env, MOTE_CLOSED_TAB_AFFECTED_EMPTY_ONLY: affectedEmptyOnly ? '1' : '0', MOTE_CLOSED_TAB_OVERLAY_ACTIONS: overlayActions ? '1' : '0' }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    for (const [file, digest] of Object.entries(compiled)) assert.equal(hash(await readFile(join(outDir, file))), digest, 'Both processes consume immutable compile: '+file)
    const logs = []
    const exit = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), privateRoot, phase, evidence],
      { temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 60000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, phase + '.log'), logs.join('\n'))
    const phaseResult = { phase, exit }; result.phases.push(phaseResult)
    assert.equal(exit.timedOut, false, 'Bounded phase published: '+phase)
    phaseResult.app = JSON.parse(await readFile(join(evidence, phase+'.json'), 'utf8'))
    assert.equal(exit.exitCode, 0, phaseResult.app.failure?.message)
    assert.equal(phaseResult.app.passed, true)
  }
  assert.equal(new Set(result.phases.map(one => one.app.pid)).size, 2, 'Two independent real Electron processes')
  for (const [file, digest] of inputs) assert.equal(hash(await readFile(file)), digest, 'Source unchanged during proof: '+relative(repository,file))
  result.passed = true
  await writeFile(join(evidence, 'review.md'), ['# Mote closed Tab screenshots — independent review pending', '',
    'Complete production App, real durable Store initialize, one immutable compile and private profile, two actual independent processes. Controlled public Session requests do not prove Core/ctxmux/CLI survival. No Native Browser scope is claimed. Capture success is not aesthetic approval.', '',
    ...result.phases.flatMap(one => one.app.frames.map(frame => '- ' + one.phase + ' / ' + frame.name + ': [' + frame.source + '](' + frame.file + ')')), '',
    'Review the complete images against the owning Mote SSOT. Source, styles, fixture, compiled identities and profile are in receipt.json.', ''].join('\n'))
} catch (error) { result.failure = { name:error.name, message:error.message, stack:error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot)
  result.cleanup = { remaining, privateRootRemoved: false }
  if (remaining.length === 0) { await rm(privateRoot, { recursive: true }); result.cleanup.privateRootRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({passed:result.passed,receipt:join(evidence,'receipt.json'),failure:result.failure,cleanup:result.cleanup}))
assert.equal(result.cleanup.remaining.length, 0, 'Strict private process cleanup; preserve profile when unconfirmed')
assert.equal(result.passed, true, result.failure?.message)
