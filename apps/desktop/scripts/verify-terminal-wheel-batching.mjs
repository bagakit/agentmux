import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { mutateMouseSource } from './fixtures/terminal-wheel-batching/source-mutations.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '../..')
const require = createRequire(path.join(desktop, 'package.json'))
const coreRequire = createRequire(path.join(root, 'packages/core/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const { build: compileSource } = await import(pathToFileURL(coreRequire.resolve('esbuild')).href)
const fixture = path.join(desktop, 'scripts/fixtures/terminal-wheel-batching')
const receiptPath = path.join(root, '.tmp/terminal-wheel-batching-last.json')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amwb-'))
const pkg = path.dirname(require.resolve('@xterm/xterm/package.json'))
const mutations = ['source-unbatch', 'source-drop-report', 'source-coordinate-drift', 'source-legacy-reencoding', 'source-cross-event', 'source-restore-damping', 'source-retain-reversal']
const critical = [
  path.join(root, 'patches/@xterm__xterm@6.1.0-beta.303.patch'), path.join(root, 'pnpm-lock.yaml'),
  ...['package.json', 'src/browser/services/MouseService.ts', 'src/browser/scrollable/mouseEvent.ts',
    'src/browser/public/Terminal.ts', 'src/browser/Viewport.ts', 'src/common/input/WriteBuffer.ts', 'lib/xterm.js', 'lib/xterm.mjs'].map(name => path.join(pkg, name)),
  ...['components/TerminalView.tsx', 'components/SessionPane.tsx', 'lib/terminal-paste.ts', 'store.ts'].map(name => path.join(desktop, 'src/renderer/src', name)),
  path.join(root,'packages/client-ui/src/terminal/input.ts'), path.join(desktop, 'src/preload/index.ts'), path.join(desktop, 'src/main/ipc.ts'), path.join(desktop, 'src/main/runtime-controller.ts'),
  ...['client.ts', 'ctxmux-run-adapter.ts', 'ctxmux-artifact-contract.json'].map(name => path.join(root, 'packages/core/src', name)),
  ...['client.js', 'ctxmux-run-adapter.js', 'ctxmux-artifact-manifest.json'].map(name => path.join(root, 'packages/core/dist', name)),
  ...['entry.tsx', 'xterm-instrumented.ts', 'index.html', 'main.cjs', 'preload.cjs', 'program.mjs', 'source-mutations.mjs', 'distance-cases.cjs'].map(name => path.join(fixture, name)), fileURLToPath(import.meta.url)
]
const hashes = async files => Object.fromEntries(await Promise.all(files.map(async file => [file,
  createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
const result = { schema: 'agentmux.terminal-wheel-batching-delivery.v1', passed: false, mutations: [],
  userRunTouched: false, physicalDeviceTested: false, naturalIncidentAttribution: false,
  cleanup: { remaining: [], rootRemoved: false, errors: [] } }
const childRoots = []
async function native(phase, variant) {
  const runRoot = path.join(privateRoot, `r${childRoots.length}`); await fs.mkdir(runRoot)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.env.AGENTMUX_ELECTRON_BINARY ?? require('electron'), [path.join(fixture, 'main.cjs'),
    path.join(privateRoot, 'renderer/index.html'), runRoot, path.join(root, 'packages/core/dist/index.js'), process.execPath, phase, variant],
    { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  childRoots.push({ pid: child.pid, root: runRoot })
  let stderr = '', timer
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-8000) })
  try {
    const exit = await Promise.race([
      new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Private Native wheel proof deadline exceeded')), 120000) })
    ])
    const browser = JSON.parse(await fs.readFile(path.join(runRoot, 'browser.json'), 'utf8'))
    return { exit, browser, stderr }
  } finally {
    clearTimeout(timer)
    await stopProbeProcesses(child.pid, runRoot)
    assert.deepEqual(await listProbeProcesses(child.pid, runRoot), [], 'Private Native proof must release only its own processes')
  }
}
try {
  await fs.mkdir(path.dirname(receiptPath), { recursive: true })
  result.sourceAndPackageBefore = await hashes(critical)
  const version = JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8'))
  assert.equal(version.version, '6.1.0-beta.303'); assert.equal(version.commit, 'd3e32b344dfe7dd6015cff6a9aeaaeaeccdc2789')
  for (const file of ['xterm.js', 'xterm.mjs']) assert.ok(!(await fs.readFile(path.join(pkg, 'lib', file), 'utf8')).includes('sourceMappingURL'), 'Published patch cannot name a stale source map')
  result.productionConsumers = []
  for (const [file, pattern] of [
    ['src/renderer/src/components/SessionPane.tsx', /<TerminalView/],
    ['src/renderer/src/components/TerminalView.tsx', /subscribeTerminalInput\(terminal/],
    ['../../packages/client-ui/src/terminal/input.ts', /source\.onBinary/],
    ['src/preload/index.ts', /ipcRenderer\.invoke\('sessions:write', session, data, source/],
    ['src/main/ipc.ts', /args\.runtime\.write\(session, data, source/],
    ['src/main/runtime-controller.ts', /client\.writeAgent\(/]
  ]) { assert.match(await fs.readFile(path.join(desktop, file), 'utf8'), pattern); result.productionConsumers.push(file) }
  assert.equal(result.productionConsumers.length, 6)
  // Compile the installed production owner and each one-site behavioral mutation. Source, UMD and ESM
  // remain separate Native consumers; the source build does not replace either published distribution.
  const sourceUrls = {}, mouse = path.join(pkg, 'src/browser/services/MouseService.ts')
  const mouseSource = await fs.readFile(mouse, 'utf8')
  for (const variant of ['source', 'source-old-distance', ...mutations]) {
    const out = path.join(privateRoot, `${variant}.mjs`)
    await compileSource({ entryPoints: [path.join(pkg, 'src/browser/public/Terminal.ts')], outfile: out,
      bundle: true, platform: 'browser', format: 'esm', target: 'esnext', logLevel: 'silent',
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
      plugins: [{ name: 'production-mouse-mutation', setup(api) {
        api.onLoad({ filter: /\/browser\/services\/MouseService\.ts$/ }, () => ({ contents: mutateMouseSource(mouseSource, variant), loader: 'ts', resolveDir: path.dirname(mouse) }))
      } }] })
    sourceUrls[variant] = pathToFileURL(out).href
  }
  result.sourceArtifacts = await hashes(Object.values(sourceUrls).map(url => fileURLToPath(url)))
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"',
      __TERMINAL_WHEEL_UMD_URL__: JSON.stringify(pathToFileURL(path.join(pkg, 'lib/xterm.js')).href),
      __TERMINAL_WHEEL_SOURCE_URLS__: JSON.stringify(sourceUrls) },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(fixture, 'xterm-instrumented.ts') }] },
    esbuild: { jsx: 'automatic' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, minify: false } })
  result.reference = await native('baseline', 'source-unbatch')
  assert.equal(result.reference.exit.code, 0, result.reference.browser.failure)
  assert.equal(result.reference.browser.passed, true)
  assert.equal(result.reference.browser.cases.length, 28)
  result.candidate = { distributions: [], browser: { passed: true, cases: [] } }
  for (const distribution of ['esm', 'umd', 'source']) {
    const evidence = await native('candidate', distribution)
    assert.equal(evidence.exit.code, 0, evidence.browser.failure)
    assert.equal(evidence.browser.passed, true)
    assert.equal(evidence.browser.cases.length, 28)
    result.candidate.distributions.push({ distribution, ...evidence })
    result.candidate.browser.cases.push(...evidence.browser.cases)
  }
  assert.equal(result.candidate.browser.cases.length, 84)
  result.oldDistance = await native('old-distance', 'source-old-distance')
  assert.equal(result.oldDistance.exit.code, 0, result.oldDistance.browser.failure)
  assert.equal(result.oldDistance.browser.passed, true)
  assert.equal(result.oldDistance.browser.cases.length, 6)
  const oldTiny = result.oldDistance.browser.cases.find(item => item.name === 'pixel-tiny-distance')
  const newTiny = result.candidate.browser.cases.find(item => item.name === 'pixel-tiny-distance')
  assert.equal(oldTiny.native.program.reports, 0); assert.equal(oldTiny.native.program.top, 500)
  assert.equal(oldTiny.pixels.initial.sha256, oldTiny.pixels.final.sha256)
  assert.ok(newTiny.native.program.reports > 0)
  assert.notEqual(newTiny.pixels.initial.sha256, newTiny.pixels.final.sha256)
  const original = new Map(result.reference.browser.cases.map(item => [item.name, item]))
  for (const item of result.candidate.browser.cases) {
    const baseline = original.get(item.name); assert.ok(baseline)
    assert.deepEqual(item.native.requests.flatMap(value => value.bytes), baseline.native.requests.flatMap(value => value.bytes),
      'Every distribution preserves the baseline complete ordered byte stream: ' + item.distribution + ':' + item.name)
    assert.equal(item.native.program.reports, baseline.native.program.reports)
    assert.equal(item.native.program.top, baseline.native.program.top)
    if (item.name === 'controlled-service-latency') assert.ok(item.keyboardQueueMs < baseline.keyboardQueueMs * .65,
      'Batching reduces following-key FIFO wait in the explicitly controlled service experiment')
  }
  for (const mutation of mutations) {
    const evidence = await native('candidate', mutation)
    assert.equal(evidence.exit.code, 1, 'Mutated production behavior must fail the same Native oracle: ' + mutation)
    assert.equal(evidence.browser.passed, false)
    assert.match(evidence.browser.failure, /AssertionError/, 'Compile/startup failure is not a behavioral mutation RED')
    result.mutations.push({ mutation, ...evidence })
  }
  assert.equal(result.mutations.length, 7)
  result.sourceAndPackageAfter = await hashes(critical)
  assert.deepEqual(result.sourceAndPackageAfter, result.sourceAndPackageBefore, 'Proof may not silently alter production or dependency inputs')
  result.passed = true
} catch (error) { result.failure = error.stack }
finally {
  for (const child of childRoots) {
    try { await stopProbeProcesses(child.pid, child.root); result.cleanup.remaining.push(...await listProbeProcesses(child.pid, child.root)) }
    catch (error) { result.cleanup.errors.push(String(error)); result.passed = false }
  }
  if (!result.cleanup.remaining.length && !result.cleanup.errors.length) {
    await fs.rm(privateRoot, { recursive: true, force: true }); result.cleanup.rootRemoved = true
  } else result.passed = false
  await fs.writeFile(receiptPath, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ passed: result.passed, candidateCases: result.candidate?.browser.cases.length,
    referenceCases: result.reference?.browser.cases.length, mutations: result.mutations.map(value => value.mutation),
    cleanup: result.cleanup, failure: result.failure, receipt: receiptPath }))
}
if (!result.passed) process.exitCode = 1
