import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, loadavg, availableParallelism, freemem, totalmem, release } from 'node:os'

const flags = process.argv.slice(2)
assert.ok(flags.includes('--mutations') && flags.every(flag => ['--mutations', '--unit-only'].includes(flag)) && new Set(flags).size === flags.length,
  'Usage: verify-capture-startup.mjs --mutations [--unit-only]; unit-only is a development check, never the complete Task gate')
const unitOnly = flags.includes('--unit-only'), root = process.cwd()
const require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const surface = 'apps/desktop/src/main/capture-surface.ts', ipc = 'apps/desktop/src/main/ipc.ts', test = 'apps/desktop/test/capture-surface.test.ts'
const config = 'apps/desktop/test/capture-startup.config.mts', script = 'apps/desktop/scripts/verify-capture-startup.mjs'
const sources = Object.fromEntries(await Promise.all([surface, ipc].map(async file => [file, await readFile(file, 'utf8')])))
const mutations = [
  { id: 'serial-window-start', file: surface, from: 'this.prepareWindows(active)\n    const included = await includedPending', to: 'const included = await includedPending\n    this.prepareWindows(active)', expected: 'boots hidden overlay renderers while both current exposures are pending' },
  { id: 'load-skips-current-inputs', file: surface, from: 'await active.inputsReady', to: 'void active.inputsReady', expected: 'boots hidden overlay renderers while both current exposures are pending' },
  { id: 'cancel-leaves-load-waiting', file: surface, from: 'this.active = null\n        active.releaseInputs()', to: 'this.active = null', expected: 'cancel releases an early load' },
  { id: 'diagnostic-not-written', file: surface, from: 'this.ports.recordTiming?.(timing)', to: 'undefined', expected: 'logs one timing line from present()' },
  { id: 'diagnostic-failure-closes-capture', file: surface, from: ".catch(error => console.warn('Capture timing could not be recorded: ' + message(error)))", to: '.catch(error => active.end(error))', expected: 'a timing writer that will' },
  { id: 'latest-write-not-ordered', file: ipc, from: 'const write = captureTimingWrite.then(', to: 'const write = Promise.resolve().then(', expected: 'the production IPC timing port writes only the latest small diagnostic' }
]
await mkdir(resolve('.local/capture-startup'), { recursive: true })
const out = await mkdtemp(resolve('.local/capture-startup/run-'))
const inputs = Object.fromEntries(await Promise.all([surface, ipc, test, config, script, 'apps/desktop/scripts/fixtures/capture-startup/main.ts',
  'apps/desktop/scripts/fixtures/capture-startup/scenario.md'].map(async file => [file, sha(await readFile(file))])))
const receipt = { schema: 'agentmux.capture-startup-proof.v1', passed: false, unitOnly, units: [], inputs, baseline: null, native: [], comparisons: [],
  conditions: { loadavg: loadavg(), availableParallelism: availableParallelism(), freeMemory: freemem(), totalMemory: totalmem(), os: release(), platform: process.platform, arch: process.arch },
  boundary: 'Production source unit mutations and actual Electron startup with controlled native pixels, virtual displays and 200 ms/exposure. No real OS capture cost, TCC, physical display or installed-app improvement is claimed.' }
async function command(label, executable, args, extra = {}, timeoutMs = 45000) {
  const result = await new Promise((done, reject) => {
    const env = { ...process.env, ...extra }
    if (executable !== process.execPath) delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false, kill
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 3000) }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); clearTimeout(kill); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(kill); done({ code, signal, timedOut, log }) })
  })
  await writeFile(join(out, label + '.log'), result.log)
  assert.equal(result.timedOut, false, label + ': observation timeout is infrastructure failure, never behavioral proof')
  assert.equal(result.signal, null, label + ': external termination is not an owning assertion')
  return result
}
async function units() {
  assert.equal(mutations.length, 6)
  for (const mutation of mutations) assert.equal(sources[mutation.file].split(mutation.from).length, 2, 'Unique production anchor: ' + mutation.id)
  for (const mutation of [null, ...mutations]) {
    const label = mutation?.id ?? 'unit-baseline', loaded = join(out, label + '.loaded.ndjson'), json = join(out, label + '.tests.json')
    const args = [resolve('node_modules/vitest/vitest.mjs'), 'run', test, '--config', config, '--reporter=json', '--outputFile=' + json]
    if (mutation) args.push('--testNamePattern', mutation.expected)
    const result = await command(label, process.execPath, args, { CAPTURE_STARTUP_LOADED: loaded, CAPTURE_STARTUP_MUTATION: mutation ? JSON.stringify(mutation) : '' })
    assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
    const report = JSON.parse(await readFile(json, 'utf8'))
    for (const file of report.testResults) assert.equal(file.message, '', label + ': collection/transpile failures cannot kill a behavior mutant')
    const assertions = report.testResults.flatMap(file => file.assertionResults).filter(row => ['passed', 'failed'].includes(row.status))
    assert.ok(assertions.length > 0, label + ': actual nonempty consumers required')
    const consumed = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(consumed.length > 0 && consumed.every(row => row.original === sha(sources[row.file]) && row.consumed === (mutation && row.file === mutation.file
      ? sha(sources[row.file].replace(mutation.from, mutation.to)) : row.original) && row.mutation === (mutation && row.file === mutation.file ? mutation.id : null)), label + ': exact original/current source consumption')
    if (mutation) {
      assert.ok(consumed.some(row => row.file === mutation.file && row.mutation === mutation.id), label + ': exact mutation was actually loaded')
      assert.equal(result.code, 1, label + ': mutant must fail in its owning assertion')
      const owner = assertions.find(row => row.fullName.includes(mutation.expected))
      assert.equal(owner?.status, 'failed', label + ': owning assertion required')
      assert.match(owner.failureMessages.join('\n'), /AssertionError|promise resolved|promise rejected/)
    } else {
      assert.equal(result.code, 0, result.log)
      assert.equal(assertions.length, report.numTotalTests)
      assert.ok(assertions.length >= 46 && assertions.every(row => row.status === 'passed'))
      for (const file of [surface, ipc]) assert.ok(consumed.some(row => row.file === file))
    }
    receipt.units.push({ label, code: result.code, executed: assertions.length, consumed })
    process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
  }
}
const median = values => { const sorted = [...values].sort((a, b) => a-b), half = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[half] : (sorted[half-1]+sorted[half])/2 }
async function electron() {
  assert.equal(process.platform, 'darwin', 'This startup proof uses the actual macOS Electron capture owner')
  const baselineFile = '.local/state/capture-startup/baseline.json'
  const baseline = JSON.parse(await readFile(baselineFile, 'utf8'))
  assert.match(baseline.ref, /^[0-9a-f]{7,40}$/i, 'Pin a Git commit, never a moving branch or arbitrary revision expression')
  assert.equal(typeof baseline.source, 'string')
  assert.equal(sha(baseline.source), baseline.sourceHash, 'baseline source must match its declared hash')
  const committed = execFileSync('git', ['show', baseline.ref + ':' + surface], { encoding: 'utf8', cwd: root })
  assert.equal(committed, baseline.source, 'baseline is the actual source at its exact Git commit')
  assert.notEqual(baseline.sourceHash, sha(sources[surface]), 'a changed source is required for a before/after comparison')
  inputs[baselineFile] = sha(await readFile(baselineFile))
  receipt.baseline = { ref: baseline.ref, sourceHash: baseline.sourceHash }
  const work = await mkdtemp(join(tmpdir(), 'agentmux-capture-startup-'))
  try {
    const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor')
    for (const directory of [mainRoot, preloadRoot, rendererRoot, join(mainRoot, 'user-data')]) await mkdir(directory, { recursive: true })
    await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
    await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
    const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
    const builds = []
    builds.push(await build({ entryPoints: ['apps/desktop/src/preload/capture-surface.ts'], outfile: join(preloadRoot, 'capture-surface.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true, logLevel: 'silent' }))
    builds.push(await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/entry.tsx'], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias, conditions: ['browser'], metafile: true, logLevel: 'silent' }))
    const htmlFile = 'apps/desktop/src/renderer/screenshot-editor/index.html', html = await readFile(htmlFile, 'utf8')
    inputs[htmlFile] = sha(html)
    await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
    for (const count of [1, 2]) for (const variant of count === 1 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const label = variant + '-' + count, scene = join(out, label), userData = join(work, label + '-user-data')
      await mkdir(scene); await mkdir(userData)
      const consumed = []
      const result = await build({ entryPoints: ['apps/desktop/scripts/fixtures/capture-startup/main.ts'], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
        external: ['electron', '@agentmux/core', '@agentmux/core/*', '@agentmux/host/*'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" }, alias, metafile: true, logLevel: 'silent',
        plugins: [{ name: 'exact-startup-candidate-source', setup(builder) { builder.onLoad({ filter: /\/apps\/desktop\/src\/main\/capture-surface\.ts$/ }, args => {
          assert.equal(args.path, resolve(surface))
          const contents = variant === 'baseline' ? baseline.source : sources[surface]
          consumed.push({ file: surface, original: sha(sources[surface]), consumed: sha(contents), variant })
          return { contents, loader: 'ts', resolveDir: dirname(args.path) }
        }) } }] })
      assert.deepEqual(consumed, [{ file: surface, original: sha(sources[surface]), consumed: variant === 'baseline' ? baseline.sourceHash : sha(sources[surface]), variant }], 'actual Main bundle consumes exactly its declared source')
      builds.push(result)
      const processResult = await command(label, require('electron'), [appRoot], { AGENTMUX_CAPTURE_STARTUP_OUT: scene, AGENTMUX_CAPTURE_STARTUP_VARIANT: variant, AGENTMUX_CAPTURE_STARTUP_DISPLAYS: String(count), AGENTMUX_CAPTURE_STARTUP_USER_DATA: userData, ELECTRON_RENDERER_URL: '' })
      const native = JSON.parse(await readFile(join(scene, 'native.json'), 'utf8'))
      assert.equal(processResult.code, 0, JSON.stringify(native.failure) + processResult.log)
      assert.equal(native.passed, true)
      assert.equal(native.captures.length, 2, label + ': first and repeat capture must actually execute')
      assert.equal(native.count, count)
      receipt.native.push({ label, consumed, ...native })
    }
    const bundled = new Set(builds.flatMap(result => Object.keys(result.metafile.inputs)).filter(file => !file.startsWith('<')))
    for (const file of bundled) if (!(file in inputs)) inputs[file] = sha(await readFile(file))
    assert.equal(receipt.native.length, 4, 'four independent Electron processes, not one prewarmed scene')
    for (const count of [1, 2]) for (const iteration of [1, 2]) {
      const row = variant => receipt.native.find(scene => scene.variant === variant && scene.count === count).captures.find(capture => capture.iteration === iteration)
      const before = row('baseline'), after = row('candidate')
      receipt.comparisons.push({ count, iteration, before: before.timing, after: after.timing,
        actualShownGainMs: before.actualShownMs - after.actualShownMs, shownGainMs: before.timing.shownMs - after.timing.shownMs, framesDeltaMs: after.timing.framesMs - before.timing.framesMs,
        rendererTailBeforeMs: before.actualShownMs - before.grabs.at(-1).returnedMs, rendererTailAfterMs: after.actualShownMs - after.grabs.at(-1).returnedMs })
    }
    assert.equal(receipt.comparisons.length, 4)
    assert.ok(median(receipt.comparisons.map(row => row.actualShownGainMs)) > 0, 'independently observed native window visibility must establish the median gain')
    assert.ok(median(receipt.comparisons.map(row => row.shownGainMs)) > 0, 'matched first/repeat single/multi display median must show an actual improvement')
    assert.ok(median(receipt.comparisons.map(row => row.rendererTailBeforeMs - row.rendererTailAfterMs)) > 0, 'improvement must include the measured Renderer tail after native, not a fabricated native speed claim')
  } finally { await rm(work, { recursive: true, force: true }) }
}
try {
  await units()
  if (!unitOnly) await electron()
  for (const [file, hash] of Object.entries(inputs)) assert.equal(sha(await readFile(file)), hash, 'Candidate changed during proof: ' + file)
  receipt.passed = !unitOnly
  if (unitOnly) receipt.developmentUnitsPassed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message }; throw error }
finally { await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
process.stdout.write(JSON.stringify({ passed: receipt.passed, unitOnly, developmentUnitsPassed: receipt.developmentUnitsPassed, receipt: join(out, 'receipt.json') }) + '\n')
