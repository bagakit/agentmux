import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative } from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop'),
  fixture = join(desktop, 'scripts/fixtures/terminal-wheel-batching'),
  require = createRequire(join(desktop, 'package.json')),
  { build } = await import('vite'), ts = require('typescript'),
  evidence = process.env.AGENTMUX_SERVICE_FANOUT_EVIDENCE ?? join(root, '.local/state/terminal-service-fanout', crypto.randomUUID()),
  privateRoot = await mkdtemp(join(tmpdir(), 'amservice-')),
  receipt = { schema: 'agentmux.terminal-service-fanout.v1', passed: false, userRunTouched: false,
    physicalDeviceTested: false, naturalIncidentResolved: false,
    reactBuild: 'production profiling build for actual consumer commit counts; durations are private-fixture evidence', cases: [], cleanup: {} },
  children = []
await mkdir(evidence, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex'),
  oldStore = execFileSync('git', ['show', '9e28294e:apps/desktop/src/renderer/src/store.ts'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }),
  oldProjection = execFileSync('git', ['show', '9e28294e:apps/desktop/src/renderer/src/lib/session-state.ts'], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
function method(source) {
  const ast = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true), found = []
  const visit = node => { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'applyEvent') found.push(node); ts.forEachChild(node, visit) }
  visit(ast); assert.equal(found.length, 1, 'Exactly one actual Store ingress')
  return { start: found[0].getStart(ast), end: found[0].end, text: found[0].getText(ast) }
}
async function variant(mode) {
  const output = join(privateRoot, mode), runRoot = join(output, 'run'), inputs = new Map()
  await mkdir(runRoot, { recursive: true })
  let mutated = 0
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    worker: { format: 'es' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"',
      __TERMINAL_WHEEL_UMD_URL__: '"unused"', __TERMINAL_WHEEL_SOURCE_URLS__: '{}' },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: join(fixture, 'xterm-instrumented.ts') },
      { find: /^react-dom\/client$/, replacement: require.resolve('react-dom/profiling') }] },
    plugins: [{ name: 'exact-service-owner-source', enforce: 'pre', async transform(source, id) {
      const file = id.split('?')[0]
      if (file.startsWith(root + '/') && !file.includes('/node_modules/')) inputs.set(relative(root, file), hash(source))
      if (mode !== 'reference') return null
      if (file === join(desktop, 'src/renderer/src/store.ts')) {
        const current = method(source), prior = method(oldStore)
        assert.notEqual(current.text, prior.text, 'Counterfactual restores actual old global ingress')
        mutated++
        return { code: source.slice(0, current.start) + prior.text + source.slice(current.end), map: null }
      }
      if (file === join(desktop, 'src/renderer/src/lib/session-state.ts')) {
        assert.notEqual(source, oldProjection, 'Counterfactual restores actual old run-service Session reducer')
        mutated++
        return { code: oldProjection, map: null }
      }
    } }],
    build: { target: 'esnext', minify: false, outDir: join(output, 'renderer'), emptyOutDir: true,
      rollupOptions: { input: join(fixture, 'service-index.html') } } })
  if (mode === 'reference') assert.equal(mutated, 2)
  for (const file of ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/SessionPane.tsx',
    'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx',
    'apps/desktop/src/renderer/src/components/QuickSwitcher.tsx', 'apps/desktop/src/renderer/src/components/TerminalView.tsx',
    'apps/desktop/src/renderer/src/lib/run-service-projection.ts', 'apps/desktop/src/renderer/src/lib/session-service-notices.ts',
    'apps/desktop/src/renderer/src/lib/service-window-notice.ts']) assert.ok(inputs.has(file), 'Actual product consumer compiled: ' + file)
  const before = await readFile(join(fixture, 'main.cjs')), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.env.AGENTMUX_ELECTRON_BINARY ?? require('electron'), [join(fixture, 'main.cjs'),
    join(output, 'renderer/service-index.html'), runRoot, join(root, 'packages/core/dist/index.js'), process.execPath,
    mode === 'reference' ? 'service-global-reference' : 'service-fanout', 'esm'],
  { cwd: root, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  children.push({ pid: child.pid, root: runRoot })
  let stderr = '', timer
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-12000) })
  try {
    const exit = await Promise.race([new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }))
    }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned Native service proof exceeded deadline')), 90000) })])
    const browser = JSON.parse(await readFile(join(runRoot, 'browser.json'), 'utf8'))
    await writeFile(join(evidence, mode + '.json'), JSON.stringify({ exit, browser, stderr, inputs: Object.fromEntries(inputs),
      mainSourceHash: hash(before), mutationSource: mode === 'reference' ? '9e28294e actual applyEvent and session-state' : null }, null, 2))
    for (const population of [200, 2000]) {
      const png = join(runRoot, `service-${population}.png`)
      try { await cp(png, join(evidence, `${mode}-${population}.png`)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    assert.equal(exit.code, 0, browser.failure ?? stderr); assert.equal(browser.passed, true)
    return { mode, cases: browser.cases, compiledProductSources: inputs.size, mutated }
  } finally { clearTimeout(timer); await stopProbeProcesses(child.pid, runRoot); assert.deepEqual(await listProbeProcesses(child.pid, runRoot), []) }
}
try {
  const unitDirectory = process.env.AGENTMUX_SERVICE_UNIT_RECEIPT
    ? dirname(resolve(process.env.AGENTMUX_SERVICE_UNIT_RECEIPT)) : join(evidence, 'unit')
  if (!process.env.AGENTMUX_SERVICE_UNIT_RECEIPT) {
    const unit = spawnSync(process.execPath, [join(desktop, 'scripts/verify-run-service-projection.mjs')], {
      cwd: root, env: { ...process.env, AGENTMUX_SERVICE_UNIT_EVIDENCE: unitDirectory },
      encoding: 'utf8', timeout: 300000, maxBuffer: 2 * 1024 * 1024
    })
    await writeFile(join(evidence, 'unit-run.log'), unit.stdout + unit.stderr)
    assert.equal(unit.status, 0, 'Scoped behavioral mutations must pass; see unit-run.log')
  }
  const unitPath = process.env.AGENTMUX_SERVICE_UNIT_RECEIPT ?? join(unitDirectory, 'receipt.json')
  const unit = JSON.parse(await readFile(unitPath, 'utf8'))
  assert.equal(unit.passed, true)
  assert.equal(unit.temporaryConfigRemoved, true)
  assert.equal(unit.cases.length, 12)
  assert.ok(unit.cases.every(value => value.passed && value.consumed))
  for (const file of ['apps/desktop/src/renderer/src/lib/run-service-projection.ts',
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/test/run-service-projection.test.ts']) {
    assert.equal(unit.inputs[file], hash(await readFile(join(root, file))), 'Mutation proof binds current production source: ' + file)
  }
  receipt.unit = { receipt: resolve(unitPath), sha256: hash(await readFile(unitPath)), cases: unit.cases }
  receipt.cases.push(await variant('reference'))
  receipt.cases.push(await variant('candidate'))
  receipt.passed = true
} catch (error) { receipt.failure = error.stack }
finally {
  try {
    for (const child of children) { await stopProbeProcesses(child.pid, child.root); assert.deepEqual(await listProbeProcesses(child.pid, child.root), []) }
    await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup = { ownedProcessesExited: true, temporaryRootRemoved: true }
  } catch (error) { receipt.cleanup = { error: String(error) }; receipt.passed = false }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, cases: receipt.cases.map(x => ({ mode: x.mode, cases: x.cases.length })), evidence, cleanup: receipt.cleanup, failure: receipt.failure }))
}
if (!receipt.passed) process.exitCode = 1
