import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, writeFile, symlink, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { release } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fixture = 'apps/desktop/scripts/fixtures/capture-real-startup/main.ts'
const smoke = process.argv.slice(2).join(' ') === '--smoke'
assert.ok(process.argv.length === 2 || smoke, 'Usage: verify-capture-real-startup.mjs [--smoke]')
assert.equal(process.platform, 'darwin', 'Real ScreenCaptureKit measurement requires macOS')
assert.ok(Number(release().split('.')[0]) >= 23, 'Real host exclusion requires macOS 14 or later')
const login = spawnSync('ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 })
assert.equal(login.status, 0, 'The original loginwindow state must be readable')
const locked = login.stdout.match(/<key>IOConsoleLocked<\/key>\s*<(true|false)\s*\/>/)
assert.ok(locked, 'The original loginwindow lock state is unavailable')
assert.equal(locked[1], 'false', 'Unlock the original macOS session before real capture')
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim(), '', 'Pin a clean candidate before measuring')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
function baselinePath() {
  for (let directory = root; ; directory = dirname(directory)) {
    const file = join(directory, '.local/state/capture-startup/baseline.json')
    if (existsSync(file)) return file
    assert.notEqual(dirname(directory), directory, 'The original baseline reference is unavailable')
  }
}
const baseline = JSON.parse(await readFile(baselinePath(), 'utf8'))
assert.equal(baseline.schema, 'agentmux.capture-startup-baseline.v2')
execFileSync('git', ['merge-base', '--is-ancestor', baseline.ref, head], { cwd: root })
const outRoot = join(root, '.local/capture-real-startup')
await mkdir(outRoot, { recursive: true })
const out = await mkdtemp(join(outRoot, 'run-'))
const mainRoot = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }).split('\n')[0].slice(9)
const baselineTree = join(mainRoot, '.worktrees', 'capture-real-baseline-' + process.pid)
const receipt = { schema: 'agentmux.capture-real-startup-proof.v1', passed: false, smoke, candidate: { head }, baseline: { ref: baseline.ref }, productionInputs: {}, samples: [], comparisons: [], cleanup: {}, boundary: 'Real ScreenCaptureKit and actual display topology. Time starts at the registered shortcut callback; physical keydown before it remains unknown.' }
let added = false
const temporaryUserData = new Set()
async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.swift')) files.push(path)
  }
  return files
}
const command = async (label, executable, args, env, timeout = 120000) => {
  const result = await new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false, kill
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 3000) }, timeout)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(kill); done({ code, signal, timedOut, log }) })
  })
  await writeFile(join(out, label + '.log'), result.log)
  assert.equal(result.timedOut, false, label + ': timeout is not behavior evidence')
  assert.equal(result.signal, null, label + ': external termination is not a completed sample')
  return result
}
try {
  execFileSync('git', ['worktree', 'add', '--detach', baselineTree, baseline.ref], { cwd: root, stdio: 'pipe', timeout: 120000 }); added = true
  for (const directory of ['', 'apps/desktop', 'apps/host', 'packages/client-ui', 'packages/core', 'packages/native-desktop', 'packages/identity', 'packages/browser', 'packages/capsule', 'packages/connectors', 'packages/demand', 'packages/editor-extensions', 'packages/git', 'packages/layout']) {
    const link = join(baselineTree, directory, 'node_modules'), target = join(root, directory, 'node_modules')
    if (existsSync(target)) await symlink(target, link, 'dir')
  }
  await mkdir(join(baselineTree, dirname(fixture)), { recursive: true })
  await copyFile(join(root, fixture), join(baselineTree, fixture))
  const variants = {}
  for (const [variant, tree, ref] of [['baseline', baselineTree, baseline.ref], ['candidate', root, head]]) {
    const appRoot = join(out, variant + '-app'), main = join(appRoot, 'out/main'), preload = join(appRoot, 'out/preload'), renderer = join(appRoot, 'out/renderer/screenshot-editor')
    for (const path of [main, preload, renderer]) await mkdir(path, { recursive: true })
    await symlink(join(root, 'apps/desktop/node_modules'), join(appRoot, 'node_modules'), 'dir')
    await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
    const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@agentmux/client-ui/theme': join(tree, 'packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': join(tree, 'packages/native-desktop/src/image.ts'),
      '@agentmux/native-desktop': join(tree, 'packages/native-desktop/src/index.ts') }
    const results = []
    results.push(await build({ absWorkingDir: root, entryPoints: [join(tree, fixture)], outfile: join(main, 'main.js'), bundle: true, platform: 'node', format: 'esm', external: ['electron', '@agentmux/core', '@agentmux/core/*', '@agentmux/host/*'], alias,
      banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" }, metafile: true, logLevel: 'silent' }))
    for (const name of ['capture-surface', 'screenshot-editor']) results.push(await build({ absWorkingDir: root, entryPoints: [join(tree, 'apps/desktop/src/preload/' + name + '.ts')], outfile: join(preload, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], alias, metafile: true, logLevel: 'silent' }))
    results.push(await build({ absWorkingDir: root, entryPoints: [join(tree, 'apps/desktop/src/renderer/screenshot-editor/entry.tsx')], outfile: join(renderer, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias, conditions: ['browser'], metafile: true, logLevel: 'silent' }))
    const html = await readFile(join(tree, 'apps/desktop/src/renderer/screenshot-editor/index.html'), 'utf8')
    await writeFile(join(renderer, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
    const inputFiles = new Set(results.flatMap(result => Object.keys(result.metafile.inputs)).filter(file => !file.startsWith('<')).map(file => resolve(root, file)))
    inputFiles.add(join(tree, 'apps/desktop/src/renderer/screenshot-editor/index.html'))
    const consumed = {}
    for (const path of inputFiles) { const name = relative(tree, path); if (!name.startsWith('..')) consumed[name] = sha(await readFile(path)) }
    for (const path of [join(tree, 'packages/native-desktop/macos/Package.swift'), join(tree, 'packages/native-desktop/scripts/build-macos.mjs'), ...await sourceFiles(join(tree, 'packages/native-desktop/macos/Sources'))]) consumed[relative(tree, path)] = sha(await readFile(path))
    for (const required of ['apps/desktop/src/main/capture-surface.ts', 'apps/desktop/src/main/screen-capture.ts', 'apps/desktop/src/main/global-screenshot.ts', 'apps/desktop/src/main/screenshot-shortcut.ts', 'apps/desktop/src/preload/capture-surface.ts', 'apps/desktop/src/renderer/screenshot-editor/entry.tsx', 'packages/native-desktop/src/client.ts']) assert.ok(consumed[required], variant + ': production input missing: ' + required)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const built = await command(variant + '-native-build', process.execPath, [join(tree, 'packages/native-desktop/scripts/build-macos.mjs'), '--bare', '--configuration', 'debug', '--scratch-path', join(out, variant + '-native-scratch')], env, 180000)
    assert.equal(built.code, 0, variant + ': native build failed')
    const buildReceipt = built.log.split('\n').find(line => line.startsWith('{"schema":"agentmux.native-build.v1"'))
    assert.ok(buildReceipt, variant + ': native build receipt is missing')
    const nativeBuild = JSON.parse(buildReceipt)
    variants[variant] = { appRoot, executablePath: nativeBuild.executablePath }
    receipt.productionInputs[variant] = { ref, files: consumed, nativeBinarySha256: sha(await readFile(nativeBuild.executablePath)) }
  }
  let index = 0
  for (const background of smoke ? ['included'] : ['included', 'excluded']) for (const iteration of smoke ? [2] : [1, 2]) for (const pair of smoke ? [1] : [1, 2, 3]) {
    const order = (pair + iteration + (background === 'excluded' ? 1 : 0)) % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    for (const variant of order) {
      const label = [background, iteration, pair, variant, ++index].join('-'), scene = join(out, label), userData = join(out, label + '-user-data')
      await mkdir(scene); await mkdir(userData)
      temporaryUserData.add(userData)
      const env = { ...process.env, AGENTMUX_CAPTURE_REAL_OUT: scene, AGENTMUX_CAPTURE_REAL_USER_DATA: userData, AGENTMUX_CAPTURE_REAL_EXECUTABLE: variants[variant].executablePath,
        AGENTMUX_CAPTURE_REAL_VARIANT: variant, AGENTMUX_CAPTURE_REAL_BACKGROUND: background, AGENTMUX_CAPTURE_REAL_ITERATION: String(iteration), ELECTRON_RENDERER_URL: '' }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await command(label, require('electron'), [variants[variant].appRoot], env, 120000)
      const sample = JSON.parse(await readFile(join(scene, 'native.json'), 'utf8'))
      assert.equal(result.code, 0, JSON.stringify(sample.failure))
      assert.equal(sample.passed, true); assert.equal(sample.cleanup.nativeDisposed, true); assert.equal(sample.cleanup.windowsRemaining, 0)
      assert.equal(sample.captures.length, 1); assert.equal(sample.captures[0].iteration, iteration)
      if (receipt.samples.length) assert.deepEqual(sample.topology, receipt.samples[0].topology, 'The exact physical display topology must remain stable')
      receipt.samples.push({ pair, ...sample })
      await rm(userData, { recursive: true, force: true })
    }
  }
  const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }
  for (const background of smoke ? ['included'] : ['included', 'excluded']) for (const iteration of smoke ? [2] : [1, 2]) {
    const pairs = (smoke ? [1] : [1, 2, 3]).map(pair => {
      const rows = receipt.samples.filter(s => s.pair === pair && s.background === background && s.iteration === iteration)
      const before = rows.find(s => s.variant === 'baseline')?.captures[0].actualShownMs, after = rows.find(s => s.variant === 'candidate')?.captures[0].actualShownMs
      assert.ok(Number.isFinite(before) && Number.isFinite(after), 'Each exact paired measurement must be present')
      return { pair, baseline: before, candidate: after }
    })
    const before = pairs.map(p => p.baseline), after = pairs.map(p => p.candidate), gainMs = median(before) - median(after), ratio = gainMs / median(before)
    const comparison = { background, iteration, pairs, baselineMedian: median(before), candidateMedian: median(after), baselineRange: [Math.min(...before), Math.max(...before)], candidateRange: [Math.min(...after), Math.max(...after)], gainMs, ratio }
    receipt.comparisons.push(comparison)
    if (!smoke) assert.ok(gainMs >= (background === 'included' ? 100 : 50) && ratio >= (background === 'included' ? 0.15 : 0.10), 'Real OS threshold not met: ' + JSON.stringify(comparison))
  }
  assert.equal(receipt.samples.length, smoke ? 2 : 24)
  for (const [variant, tree] of [['baseline', baselineTree], ['candidate', root]]) {
    for (const [file, hash] of Object.entries(receipt.productionInputs[variant].files)) assert.equal(sha(await readFile(join(tree, file))), hash, variant + ': production input changed during measurement: ' + file)
  }
  receipt.passed = !smoke; if (smoke) receipt.developmentSmokePassed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1
} finally {
  if (added) {
    const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: baselineTree, encoding: 'utf8' }).trim()
    assert.equal(changed, '', 'Do not remove a baseline checkout with tracked edits')
    execFileSync('git', ['worktree', 'remove', '--force', baselineTree], { cwd: root, stdio: 'pipe', timeout: 120000 })
    receipt.cleanup.baselineWorktreeRemoved = !existsSync(baselineTree)
  }
  for (const path of temporaryUserData) await rm(path, { recursive: true, force: true })
  for (const name of ['baseline-app', 'candidate-app', 'baseline-native-scratch', 'candidate-native-scratch']) await rm(join(out, name), { recursive: true, force: true })
  receipt.cleanup.generatedArtifactsRemoved = [...temporaryUserData].every(path => !existsSync(path)) && ['baseline-app', 'candidate-app', 'baseline-native-scratch', 'candidate-native-scratch'].every(name => !existsSync(join(out, name)))
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, developmentSmokePassed: receipt.developmentSmokePassed, failure: receipt.failure, receipt: join(out, 'receipt.json') }) + '\n')
