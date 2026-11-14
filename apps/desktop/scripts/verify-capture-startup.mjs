import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { loadavg, availableParallelism, freemem, totalmem, release } from 'node:os'
import { fileURLToPath } from 'node:url'

const flags = process.argv.slice(2)
assert.ok(flags.includes('--mutations') && flags.every(flag => ['--mutations', '--unit-only'].includes(flag)) && new Set(flags).size === flags.length,
  'Usage: verify-capture-startup.mjs --mutations [--unit-only]; unit-only is a development check, never the complete Task gate')
const unitOnly = flags.includes('--unit-only'), root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const surface = 'apps/desktop/src/main/capture-surface.ts', ipc = 'apps/desktop/src/main/ipc.ts', test = 'apps/desktop/test/capture-surface.test.ts'
const preload = 'apps/desktop/src/preload/capture-surface.ts', view = 'apps/desktop/src/renderer/screenshot-editor/CaptureSurfaceView.tsx'
const globalScreenshot = 'apps/desktop/src/main/global-screenshot.ts', screenCapture = 'apps/desktop/src/main/screen-capture.ts'
const config = 'apps/desktop/test/capture-startup.config.mts', script = 'apps/desktop/scripts/verify-capture-startup.mjs'
const fixture = 'apps/desktop/scripts/fixtures/capture-startup/main.ts', scenario = 'apps/desktop/scripts/fixtures/capture-startup/scenario.md'
const production = [surface, ipc, preload, view, globalScreenshot, screenCapture, 'apps/desktop/src/main/screenshot-shortcut.ts', 'apps/desktop/src/shared/capture-surface.ts']
const sources = Object.fromEntries(await Promise.all(production.map(async file => [file, await readFile(join(root, file), 'utf8')])))
const progressive = 'shows the selected first frame before the deferred exposure settles'
const mutations = [
  { id: 'serial-window-start', file: surface, from: 'this.prepareWindows(active)\n    const first = await firstPending', to: 'const first = await firstPending\n    this.prepareWindows(active)', expected: progressive },
  { id: 'load-skips-current-inputs', file: surface, from: 'await active.inputsReady', to: 'void active.inputsReady', expected: progressive },
  { id: 'cancel-leaves-load-waiting', file: surface, from: 'this.active = null\n        active.releaseInputs()', to: 'this.active = null', expected: 'cancel releases an early load' },
  { id: 'selected-background-not-first', file: surface, from: "const firstMode = active.background, secondMode: CaptureBackground = firstMode === 'included' ? 'excluded' : 'included'\n    const firstPending", to: "const firstMode: CaptureBackground = active.background === 'included' ? 'excluded' : 'included', secondMode: CaptureBackground = firstMode === 'included' ? 'excluded' : 'included'\n    const firstPending", expected: progressive },
  { id: 'wait-for-alternate-before-release', file: surface, from: 'const secondPending = this.freeze(active, secondMode)\n    this.release(active)\n    void secondPending.then(second => this.completeBackup(active, secondMode, second))', to: 'const second = await this.freeze(active, secondMode)\n    this.completeBackup(active, secondMode, second)\n    this.release(active)', expected: progressive },
  { id: 'deferred-ready-auto-switches', file: view, from: 'revision.current = event.revision\n      const next', to: 'revision.current = event.revision\n      setBackground(event.background)\n      const next', expected: 'a deferred ready snapshot preserves' },
  { id: 'load-drops-settled-snapshot', file: preload, from: 'latest = deferred ? merge(loaded, deferred) : loaded', to: 'latest = loaded', expected: 'replays a settled deferred frame' },
  { id: 'pending-background-output', file: view, from: "if (target.status === 'pending') { setStatus('The other frozen background is still preparing. The current image and annotations remain available.'); setSwitching(false); return }", to: "if (target.status === 'pending') { setBackground(next); setStatus(null); setSwitching(false); return }", expected: 'a pending background announcement' },
  { id: 'deferred-partial-geometry', file: surface, from: 'for (const frame of result.displays) {', to: 'for (const frame of result.displays.slice(0, 1)) {', expected: 'one bad display' },
  { id: 'deferred-safe-top-not-compared', file: surface, from: '|| (prepared.input !== undefined && prepared.input.safeTop !== frame.safeTop)\n        ', to: '', expected: 'changed safeTop' },
  { id: 'double-failure-loses-requested-error', file: surface, from: 'if (first instanceof Error && second instanceof Error) throw first', to: "if (first instanceof Error && second instanceof Error) throw firstMode === 'included' ? first : second", expected: 'excluded-first double failure' },
  { id: 'replacement-bypasses-producer-tail', file: surface, from: 'const result = this.producerTail.then(produce)', to: 'const result = produce()', expected: 'replacement native work sequential' },
  { id: 'capture-busy-becomes-source-failure', file: surface, from: 'if (!captureBusy(error)) throw error', to: 'if (true) throw error', expected: 'capture_busy waits for the actual lease' },
  { id: 'busy-observation-never-ends', file: surface, from: 'if (performance.now() - busySince >= CAPTURE_BUSY_OBSERVE_MS)', to: 'if (false)', expected: 'persistent capture_busy' },
  { id: 'final-overwrites-first-shown-time', file: surface, from: 'shownMs: active.shownMs!,', to: 'shownMs: since(active.startedAt),', expected: progressive },
  { id: 'late-deferred-pollution', file: surface, from: 'private completeBackup(active: Active, mode: CaptureBackground, result: NativeDisplayFrames | Error): void {\n    if (this.active !== active) return', to: 'private completeBackup(active: Active, mode: CaptureBackground, result: NativeDisplayFrames | Error): void {', expected: 'a late deferred snapshot' },
  { id: 'final-diagnostic-missing', file: surface, from: 'if (active.shown) this.recordTiming(active, true)', to: 'void 0', expected: progressive },
  { id: 'final-native-timings-dropped', file: surface, from: 'nativeIncluded: active.nativeIncluded, nativeExcluded: active.nativeExcluded,', to: 'nativeIncluded: null, nativeExcluded: null,', expected: progressive },
  { id: 'stale-diagnostic-overwrites-new-request', file: ipc, from: 'timing.requestId === latestCaptureTimingRequest', to: 'true', expected: 'old request final overwrite' },
  { id: 'diagnostic-not-written', file: surface, from: 'this.ports.recordTiming?.(timing)', to: 'undefined', expected: 'logs one timing line' },
  { id: 'diagnostic-failure-closes-capture', file: surface, from: ".catch(error => console.warn('Capture timing could not be recorded: ' + message(error)))", to: '.catch(error => active.end(error))', expected: 'a timing writer that will' },
  { id: 'shortcut-wiring-removed', file: ipc, from: 'request: (background, timing) => { void globalScreenshot.run(background, timing).catch(reportScreenshotIssue) }', to: 'request: () => {}', expected: 'the actual Main callback captures and copies' },
  { id: 'shortcut-bypasses-prepare', file: globalScreenshot, from: 'const attachment = await this.prepare()', to: 'const attachment = null', expected: 'uses a focused exact window' },
  { id: 'present-bypasses-request-clock', file: screenCapture, from: 'complete, background, timing,', to: 'complete, background,', expected: 'threads one timing request' }
]
await mkdir(join(root, '.local/capture-startup'), { recursive: true })
const out = await mkdtemp(join(root, '.local/capture-startup/run-'))
const inputs = Object.fromEntries(await Promise.all([...production, test, config, script, fixture, scenario,
  'apps/desktop/test/capture-startup-preload.test.ts', 'apps/desktop/test/capture-surface-view.test.tsx', 'apps/desktop/test/screenshot-shortcut-wiring.test.ts', 'apps/desktop/test/screenshot-shortcut-global.test.ts'].map(async file => [file, sha(await readFile(join(root, file)))])))
const receipt = { schema: 'agentmux.capture-startup-proof.v2', passed: false, unitOnly, units: [], inputs, candidate: null, baseline: null, productionInputs: {}, native: [], comparisons: [],
  conditions: { loadavg: loadavg(), availableParallelism: availableParallelism(), freeMemory: freemem(), totalMemory: totalmem(), os: release(), platform: process.platform, arch: process.arch },
  boundary: 'Production source unit mutations and actual Electron startup with controlled native pixels, virtual displays and real 200 ms plus per-display producer delays. No real OS capture cost, TCC, physical display or installed-app improvement is claimed.', cleanup: {} }
async function command(label, executable, args, extra = {}, timeoutMs = 60000) {
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
  assert.equal(mutations.length, 24)
  for (const mutation of mutations) assert.equal(sources[mutation.file].split(mutation.from).length, 2, 'Unique production anchor: ' + mutation.id)
  for (const mutation of [null, ...mutations]) {
    const label = mutation?.id ?? 'unit-baseline', loaded = join(out, label + '.loaded.ndjson'), json = join(out, label + '.tests.json')
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile=' + json]
    if (mutation) args.push('--testNamePattern', mutation.expected)
    const result = await command(label, process.execPath, args, { CAPTURE_STARTUP_LOADED: loaded, CAPTURE_STARTUP_MUTATION: mutation ? JSON.stringify(mutation) : '' })
    assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
    const report = JSON.parse(await readFile(json, 'utf8'))
    for (const file of report.testResults) assert.equal(file.message, '', label + ': collection/transpile failures cannot kill a behavior mutant')
    const assertions = report.testResults.flatMap(file => file.assertionResults).filter(row => ['passed', 'failed'].includes(row.status))
    assert.ok(assertions.length > 0, label + ': actual nonempty consumers required')
    const consumed = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(consumed.length > 0 && consumed.every(row => row.original === sha(sources[row.file]) && row.consumed === (mutation && row.file === mutation.file
      ? sha(sources[row.file].replace(mutation.from, mutation.to)) : row.original) && row.mutation === (mutation && row.file === mutation.file ? mutation.id : null)), label + ': exact original/current source consumption')
    if (mutation) {
      assert.ok(consumed.some(row => row.file === mutation.file && row.mutation === mutation.id), label + ': exact mutation was actually loaded')
      assert.equal(result.code, 1, label + ': mutant must fail in its owning assertion')
      const owner = assertions.find(row => row.fullName.includes(mutation.expected) && row.status === 'failed')
      assert.ok(owner, label + ': owning AssertionError required')
      assert.match(owner.failureMessages.join('\n'), /AssertionError|promise resolved|promise rejected/)
    } else {
      assert.equal(result.code, 0, result.log)
      assert.equal(assertions.length, report.numTotalTests)
      assert.ok(assertions.length >= 108 && assertions.every(row => row.status === 'passed'))
      for (const file of [surface, ipc]) assert.ok(consumed.some(row => row.file === file))
    }
    receipt.units.push({ label, code: result.code, executed: assertions.length, consumed })
    process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
  }
}
const median = values => { const sorted = [...values].sort((a, b) => a-b), half = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[half] : (sorted[half-1]+sorted[half])/2 }
function baselinePath() {
  for (let directory = root; ; directory = dirname(directory)) {
    const candidate = join(directory, '.local/state/capture-startup/baseline.json')
    if (existsSync(candidate)) return candidate
    assert.notEqual(dirname(directory), directory, 'baseline.json was not found in this checkout or its feature worktree')
  }
}
function sourceFile(tree, candidates) {
  const file = candidates.find(candidate => existsSync(join(tree, candidate)))
  assert.ok(file, 'No source file in this Git tree: ' + candidates.join(' or '))
  return join(tree, file)
}
async function electron() {
  assert.equal(process.platform, 'darwin', 'This startup proof uses the actual macOS Electron capture owner')
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8', timeout: 30000 }).trim(), '', 'The candidate must be a complete clean Git tree')
  const candidateRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 30000 }).trim()
  const baselineFile = baselinePath(), baseline = JSON.parse(await readFile(baselineFile, 'utf8'))
  assert.equal(baseline.schema, 'agentmux.capture-startup-baseline.v2')
  assert.deepEqual(Object.keys(baseline).sort(), ['ref', 'schema'], 'v2 points only to a complete pre-change Git tree')
  assert.match(baseline.ref, /^[0-9a-f]{40}$/i, 'Pin a full Git commit, never a moving branch')
  assert.notEqual(baseline.ref, candidateRef)
  execFileSync('git', ['merge-base', '--is-ancestor', baseline.ref, candidateRef], { cwd: root, timeout: 30000 })
  receipt.candidate = { ref: candidateRef }
  receipt.baseline = { ref: baseline.ref }
  const mainRoot = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 30000 }).split('\n')[0].slice('worktree '.length)
  const baselineTree = join(mainRoot, '.worktrees', 'capture-startup-baseline-' + baseline.ref.slice(0, 12) + '-' + process.pid)
  const cleanupPaths = new Set()
  let added = false
  try {
    execFileSync('git', ['worktree', 'add', '--detach', baselineTree, baseline.ref], { cwd: root, stdio: 'pipe', timeout: 120000 })
    added = true
    await symlink(join(root, 'node_modules'), join(baselineTree, 'node_modules'), 'dir')
    for (const directory of ['apps/desktop', 'apps/host', 'packages/client-ui', 'packages/core', 'packages/native-desktop', 'packages/identity', 'packages/browser',
      'packages/capsule', 'packages/connectors', 'packages/demand', 'packages/editor-extensions', 'packages/git', 'packages/layout'])
      await symlink(join(root, directory, 'node_modules'), join(baselineTree, directory, 'node_modules'), 'dir')
    await copyFile(join(root, fixture), join(baselineTree, fixture))
    const variants = {}
    for (const [variant, tree, ref] of [['baseline', baselineTree, baseline.ref], ['candidate', root, candidateRef]]) {
      const appRoot = join(out, variant + '-app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor')
      cleanupPaths.add(appRoot)
      for (const directory of [mainRoot, preloadRoot, rendererRoot]) await mkdir(directory, { recursive: true })
      await symlink(join(root, 'apps/desktop/node_modules'), join(appRoot, 'node_modules'), 'dir')
      await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
      const ipcSource = await readFile(join(tree, ipc), 'utf8'), from = '  let captureTimingWrite = Promise.resolve()', until = '  // The editor returns focus only'
      assert.equal(ipcSource.split(from).length, 2, variant + ' production IPC registration is unique')
      const registration = ipcSource.slice(ipcSource.indexOf(from), ipcSource.indexOf(until, ipcSource.indexOf(from)))
      const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
        '@agentmux/client-ui': join(tree, 'packages/client-ui/src'),
        '@agentmux/client-ui/theme': join(tree, 'packages/client-ui/src/theme/index.ts'), '@agentmux/client-ui/error-presentation': join(tree, 'packages/client-ui/src/lib/error-presentation.ts'),
        '@agentmux/client-ui/ime-keyboard-event': join(tree, 'packages/client-ui/src/lib/ime-keyboard-event.ts'), '@agentmux/client-ui/icons': join(tree, 'packages/client-ui/src/theme/icons.tsx'),
        '@agentmux/client-ui/pasted-images': join(tree, 'packages/client-ui/src/lib/pasted-images.ts'),
        '@agentmux/client-ui/input': join(tree, 'packages/client-ui/src/input/index.ts'), '@agentmux/client-ui/input/styles.css': join(tree, 'packages/client-ui/src/input/input.css'),
        '@agentmux/client-ui/styles/theme-transition.css': join(tree, 'packages/client-ui/src/styles/theme-transition.css'),
        '@agentmux/client-ui/styles/semantic-icons.css': join(tree, 'packages/client-ui/src/styles/semantic-icons.css'),
        '@agentmux/native-desktop': join(tree, 'packages/native-desktop/src'),
        '@agentmux/native-desktop/image': join(tree, 'packages/native-desktop/src/image.ts'),
        '@agentmux/core': join(tree, 'packages/core/src'), '@agentmux/identity': join(tree, 'packages/identity/src'), '@agentmux/host': join(tree, 'apps/host/src'),
        '@agentmux/core/mote-preferences': sourceFile(tree, ['packages/core/src/mote/preferences.ts', 'packages/core/src/mote-preferences.ts']),
        '@agentmux/core/mote-dialogue': sourceFile(tree, ['packages/core/src/mote/dialogue.ts', 'packages/core/src/mote-dialogue.ts']),
        '@agentmux/browser': join(tree, 'packages/browser/src'), '@agentmux/capsule': join(tree, 'packages/capsule/src'),
        '@agentmux/connectors': join(tree, 'packages/connectors/src'), '@agentmux/demand': join(tree, 'packages/demand/src'),
        '@agentmux/editor-extensions': join(tree, 'packages/editor-extensions/src'), '@agentmux/git': join(tree, 'packages/git/src'), '@agentmux/layout': join(tree, 'packages/layout/src') }
      const builds = []
      builds.push(await build({ absWorkingDir: root, entryPoints: [join(tree, 'apps/desktop/src/preload/capture-surface.ts')], outfile: join(preloadRoot, 'capture-surface.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], alias, metafile: true, logLevel: 'silent' }))
      builds.push(await build({ absWorkingDir: root, entryPoints: [join(tree, 'apps/desktop/src/renderer/screenshot-editor/entry.tsx')], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias, conditions: ['browser'], define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, metafile: true, logLevel: 'silent' }))
      builds.push(await build({ absWorkingDir: root, entryPoints: [join(tree, fixture)], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
        external: ['electron', '@agentmux/core', '@agentmux/core/*', '@agentmux/host/*', '@agentmux/native-desktop'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" },
        alias, define: { __CAPTURE_STARTUP_IPC_REGISTRATION__: JSON.stringify(registration) }, metafile: true, logLevel: 'silent' }))
      const htmlFile = 'apps/desktop/src/renderer/screenshot-editor/index.html', html = await readFile(join(tree, htmlFile), 'utf8')
      await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
      const consumed = {}
      const record = async (absolute, forcedKind) => {
        const path = isAbsolute(absolute) ? absolute : resolve(root, absolute), bytes = await readFile(path), hash = sha(bytes), rel = relative(tree, path)
        let key, kind = forcedKind
        const dependencyMarker = path.lastIndexOf('/node_modules/')
        if (dependencyMarker >= 0) {
          key = 'dependency/' + path.slice(dependencyMarker + '/node_modules/'.length) + '#' + hash
          kind ??= 'dependency'
        } else if (!rel.startsWith('..') && !isAbsolute(rel)) {
          key = rel
          if (rel === fixture) kind = 'shared-driver'
          else {
            const committed = execFileSync('git', ['show', ref + ':' + rel], { cwd: root, timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
            assert.equal(sha(committed), hash, variant + ' consumed input comes from its exact Git tree: ' + rel)
            kind ??= 'production'
          }
        } else {
          const shared = relative(root, path)
          if (!shared.startsWith('..') && !isAbsolute(shared)) {
            const baselineBlob = execFileSync('git', ['show', baseline.ref + ':' + shared], { cwd: root, timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
            const candidateBlob = execFileSync('git', ['show', candidateRef + ':' + shared], { cwd: root, timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
            assert.equal(sha(baselineBlob), hash, 'shared input must equal the baseline Git blob: ' + shared)
            assert.equal(sha(candidateBlob), hash, 'shared input must equal the candidate Git blob: ' + shared)
            key = 'shared-identical/' + shared
            kind ??= 'shared-identical-git-dependency'
          } else {
            assert.fail(variant + ' input is outside both Git trees and declared dependencies: ' + path)
          }
        }
        if (consumed[key]) assert.equal(consumed[key].sha256, hash, variant + ' has one identity for ' + key)
        else consumed[key] = { sha256: hash, kind }
      }
      for (const result of builds) for (const input of Object.keys(result.metafile.inputs).filter(file => !file.startsWith('<'))) await record(input)
      await record(join(tree, ipc), 'production')
      await record(join(tree, htmlFile), 'production')
      for (const required of [surface, 'apps/desktop/src/shared/capture-surface.ts', preload, view, 'apps/desktop/src/renderer/screenshot-editor/entry.tsx',
        'apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx', globalScreenshot, screenCapture, 'apps/desktop/src/main/screenshot-shortcut.ts', ipc]) {
        assert.ok(consumed[required]?.sha256, variant + ' required production input was not consumed: ' + required)
      }
      variants[variant] = { appRoot, consumed }
      receipt.productionInputs[variant] = consumed
    }
    let processIndex = 0
    for (const count of [1, 2]) for (const background of ['included', 'excluded']) for (const iteration of [1, 2]) for (const pair of [1, 2, 3, 4]) {
      const variantsOrder = (pair + count + iteration + (background === 'excluded' ? 1 : 0)) % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
      for (const variant of variantsOrder) {
        const label = [count, background, iteration, 'pair-' + pair, ++processIndex, variant].join('-'), scene = join(out, label), userData = join(out, label + '-user-data')
        cleanupPaths.add(userData)
        await mkdir(scene); await mkdir(userData)
        const result = await command(label, require('electron'), [variants[variant].appRoot], { AGENTMUX_CAPTURE_STARTUP_OUT: scene, AGENTMUX_CAPTURE_STARTUP_VARIANT: variant,
          AGENTMUX_CAPTURE_STARTUP_DISPLAYS: String(count), AGENTMUX_CAPTURE_STARTUP_BACKGROUND: background, AGENTMUX_CAPTURE_STARTUP_ITERATION: String(iteration),
          AGENTMUX_CAPTURE_STARTUP_NONCE: String(processIndex * 8), AGENTMUX_CAPTURE_STARTUP_USER_DATA: userData, ELECTRON_RENDERER_URL: '' }, 45000)
        const native = JSON.parse(await readFile(join(scene, 'native.json'), 'utf8'))
        assert.equal(result.code, 0, JSON.stringify(native.failure) + result.log)
        assert.equal(native.passed, true)
        assert.equal(native.captures.length, 1, label + ': each independent process executes exactly its assigned iteration')
        assert.equal(native.captures[0].iteration, iteration)
        assert.equal(native.count, count); assert.equal(native.background, background); assert.equal(native.variant, variant)
        receipt.native.push({ label, pair, processIndex, ...native })
      }
    }
    assert.equal(receipt.native.length, 64, 'first/repeat x single/dual x included/excluded each has four independent process pairs')
    for (const count of [1, 2]) for (const background of ['included', 'excluded']) for (const iteration of [1, 2]) {
      const rows = receipt.native.filter(scene => scene.count === count && scene.background === background && scene.captures[0]?.iteration === iteration)
      const pairs = []
      for (const pair of [1, 2, 3, 4]) {
        const before = rows.find(scene => scene.pair === pair && scene.variant === 'baseline')?.captures.find(capture => capture.iteration === iteration)?.actualShownMs
        const after = rows.find(scene => scene.pair === pair && scene.variant === 'candidate')?.captures.find(capture => capture.iteration === iteration)?.actualShownMs
        assert.ok(Number.isFinite(before) && Number.isFinite(after), 'missing paired sample: ' + [count, background, iteration, pair].join('/'))
        pairs.push({ pair, baseline: before, candidate: after })
      }
      const beforeValues = pairs.map(row => row.baseline), afterValues = pairs.map(row => row.candidate), beforeMedian = median(beforeValues), afterMedian = median(afterValues)
      const gainMs = beforeMedian - afterMedian, gainRatio = gainMs / beforeMedian
      const comparison = { count, background, iteration, pairs, baselineMedian: beforeMedian, candidateMedian: afterMedian, gainMs, gainRatio,
        baselineRange: [Math.min(...beforeValues), Math.max(...beforeValues)], candidateRange: [Math.min(...afterValues), Math.max(...afterValues)] }
      receipt.comparisons.push(comparison)
      assert.ok(gainMs >= 100 && gainRatio >= 0.15, 'actualShown threshold failed in cell ' + [count, background, iteration].join('/') + ': ' + JSON.stringify(comparison))
    }
    assert.equal(receipt.comparisons.length, 8, 'first/repeat x single/dual x included/excluded, without cross-cell aggregation')
  } finally {
    try {
      for (const path of cleanupPaths) await rm(path, { recursive: true, force: true })
      receipt.cleanup.generatedArtifactsRemoved = [...cleanupPaths].every(path => !existsSync(path))
    } finally {
      if (added) {
        execFileSync('git', ['worktree', 'remove', '--force', baselineTree], { cwd: root, stdio: 'pipe', timeout: 120000 })
        receipt.cleanup.baselineWorktreeRemoved = !existsSync(baselineTree)
      }
    }
  }
}
try {
  await units()
  if (!unitOnly) await electron()
  for (const [file, hash] of Object.entries(inputs)) assert.equal(sha(await readFile(join(root, file))), hash, 'Candidate changed during proof: ' + file)
  receipt.passed = !unitOnly
  if (unitOnly) receipt.developmentUnitsPassed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message }; throw error }
finally { await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
process.stdout.write(JSON.stringify({ passed: receipt.passed, unitOnly, developmentUnitsPassed: receipt.developmentUnitsPassed, receipt: join(out, 'receipt.json') }) + '\n')
