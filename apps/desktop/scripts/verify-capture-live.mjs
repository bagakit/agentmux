import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { release } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const args = process.argv.slice(2)
assert.deepEqual(args, ['--scenario', 'lifecycle'], 'Usage: verify-capture-live.mjs --scenario lifecycle')
assert.equal(process.platform, 'darwin', 'The real ScreenCaptureKit lifecycle proof requires macOS')
const out = resolve(root, '.local/capture-live', 'run-' + new Date().toISOString().replaceAll(':', '').replaceAll('.', '') + '-' + process.pid)
await mkdir(out, { recursive: true })
const receipt = {
  schema: 'agentmux.capture-live-proof.v1', passed: false, scenario: 'lifecycle', inputs: {}, nativeBuild: null, native: null,
  log: join(out, 'electron.log'), pending: null,
  boundary: 'Real Electron CaptureSurface, production preload/Renderer, visible host/pin windows and real native ScreenCaptureKit. No controlled pixels or OS-capture substitute. The macOS loginwindow must be unlocked.'
}
await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))

function lockedSession() {
  const registry = spawnSync('ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  assert.equal(registry.status, 0, registry.stderr || 'Unable to read the macOS loginwindow state')
  const match = registry.stdout.match(/<key>IOConsoleLocked<\/key>\s*<(true|false)\s*\/>/)
  assert.ok(match, 'Unable to parse the exact IOConsoleLocked Boolean from the macOS loginwindow plist')
  return match[1] === 'true'
}
async function persist() {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
function helperPids(executablePath) {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split('\n').filter(line => line.includes(executablePath + ' --agent '))
    .map(line => Number(line.trim().split(/\s+/, 1)[0])).filter(Number.isSafeInteger)
}
async function assertHelperExited(executablePath) {
  for (let attempt = 0; attempt < 100 && helperPids(executablePath).length; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
  const remaining = helperPids(executablePath)
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  for (const pid of helperPids(executablePath)) {
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  assert.deepEqual(helperPids(executablePath), [], 'Every real native helper must release its lifecycle lease')
  assert.deepEqual(remaining, [], 'The real native helper must exit after dispose; cleanup cannot disguise a lease leak')
}
async function nativeSourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await nativeSourceFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.swift')) files.push(path)
  }
  return files
}

if (lockedSession()) {
  receipt.pending = { gate: 'macos-unlocked-loginwindow', reason: 'IOConsoleLocked=true; real screen capture was not started.' }
  await persist()
  process.exitCode = 2
} else if (Number(release().split('.')[0]) < 23) {
  receipt.pending = { gate: 'macos-14-screen-capture-kit', reason: 'Real native excluded pixels require macOS 14 or later; no included substitute was used.' }
  await persist()
  process.exitCode = 2
} else {
  let work, executablePath
  try {
    work = join(out, 'work')
    const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor')
    const fixtureOut = join(out, 'fixture'), userData = join(work, 'user-data')
    for (const directory of [mainRoot, preloadRoot, rendererRoot, fixtureOut, userData]) await mkdir(directory, { recursive: true })
    await symlink(join(root, 'apps/desktop/node_modules'), join(appRoot, 'node_modules'))
    await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
    const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@agentmux/client-ui/theme': join(root, 'packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': join(root, 'packages/native-desktop/src/image.ts') }
    const results = []
    results.push(await build({ entryPoints: [join(root, 'apps/desktop/scripts/fixtures/capture-live/main.ts')], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
      external: ['electron', '@agentmux/native-desktop', '@agentmux/core', '@agentmux/core/*', '@agentmux/host/*'],
      banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" }, alias, metafile: true, logLevel: 'silent' }))
    for (const name of ['capture-surface', 'screenshot-editor']) results.push(await build({ entryPoints: [join(root, 'apps/desktop/src/preload/' + name + '.ts')], outfile: join(preloadRoot, name + '.cjs'),
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true, logLevel: 'silent' }))
    results.push(await build({ entryPoints: [join(root, 'apps/desktop/src/renderer/screenshot-editor/entry.tsx')], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm',
      jsx: 'automatic', alias, conditions: ['browser'], metafile: true, logLevel: 'silent' }))
    const htmlFile = join(root, 'apps/desktop/src/renderer/screenshot-editor/index.html'), html = await readFile(htmlFile, 'utf8')
    await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))

    const nativeBuild = spawnSync(process.execPath, [join(root, 'packages/native-desktop/scripts/build-macos.mjs'), '--bare', '--configuration', 'debug', '--scratch-path', join(work, 'native-scratch')],
      { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000 })
    await writeFile(join(out, 'native-build.log'), (nativeBuild.stdout ?? '') + (nativeBuild.stderr ?? ''))
    if (nativeBuild.error) throw nativeBuild.error
    assert.equal(nativeBuild.status, 0, 'The real native helper must compile; compilation failure is not behavior proof')
    receipt.nativeBuild = JSON.parse(nativeBuild.stdout.trim().split('\n').at(-1))
    executablePath = receipt.nativeBuild.executablePath
    receipt.nativeBuild.executableSha256 = sha(await readFile(executablePath))

    const files = new Set(results.flatMap(result => Object.keys(result.metafile.inputs)).filter(file => !file.startsWith('<')).map(file => resolve(root, file)))
    for (const file of [htmlFile, fileURLToPath(import.meta.url), join(root, 'apps/desktop/scripts/fixtures/capture-live/main.ts'),
      join(root, 'packages/native-desktop/scripts/build-macos.mjs'), ...await nativeSourceFiles(join(root, 'packages/native-desktop/macos/Sources'))]) files.add(file)
    receipt.inputs = Object.fromEntries(await Promise.all([...files].sort().map(async file => [file.slice(root.length + 1), sha(await readFile(file))])))

    const result = await new Promise((done, reject) => {
      const env = { ...process.env, AGENTMUX_CAPTURE_LIVE_OUT: fixtureOut, AGENTMUX_CAPTURE_LIVE_EXECUTABLE: executablePath,
        AGENTMUX_CAPTURE_LIVE_USER_DATA: userData, ELECTRON_RENDERER_URL: '' }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(require('electron'), [appRoot], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = '', timeout = false, kill
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; process.stdout.write(bytes) })
      const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 3000) }, 120000)
      child.once('error', reject)
      child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(kill); done({ code, signal, timeout, log }) })
    })
    await writeFile(receipt.log, result.log)
    assert.equal(result.timeout, false, 'A timed-out real capture is infrastructure failure, not a behavioral kill')
    assert.equal(result.signal, null, 'External termination is not a lifecycle result')
    receipt.native = JSON.parse(await readFile(join(fixtureOut, 'native.json'), 'utf8'))
    assert.equal(result.code, 0, JSON.stringify(receipt.native.failure) + result.log)
    assert.equal(receipt.native.passed, true)
    assert.equal(receipt.native.cases.length, 3, 'Included-first, excluded-first and cancelled-old late-result scenes must all execute')
    assert.deepEqual(receipt.native.cases.map(row => row.label), ['lifecycle', 'excluded-first-deferred', 'late-result-isolation'])
    assert.ok(receipt.native.checks.length >= 30 && receipt.native.checks.every(check => check.passed), 'Nonempty real native and Renderer checks are required')
    assert.deepEqual(receipt.native.opacityWrites, [], 'The real lifecycle must contain no host opacity writes')
    assert.equal(receipt.native.cleanup.nativeDisposed, true)
    assert.equal(receipt.native.cleanup.windowsRemaining, 0)
    await assertHelperExited(executablePath)
    for (const [file, hash] of Object.entries(receipt.inputs)) assert.equal(sha(await readFile(join(root, file))), hash, 'Candidate changed during real proof: ' + file)
    receipt.passed = true
  } catch (error) {
    receipt.failure = { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }
    if (executablePath) {
      try { await assertHelperExited(executablePath) } catch (cleanupError) { receipt.cleanupFailure = String(cleanupError) }
    }
    process.exitCode = 1
  } finally {
    if (work) await rm(work, { recursive: true, force: true })
    await persist()
  }
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, pending: receipt.pending, failure: receipt.failure, receipt: join(out, 'receipt.json') }) + '\n')
