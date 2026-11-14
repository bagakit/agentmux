import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'darwin', 'Real native host exclusion proof requires macOS')
assert.equal(process.argv.length, 2, 'This verification has no optional skipped slices')
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const nativePackage = join(repository, 'packages/native-desktop')
const require = createRequire(join(repository, 'apps/desktop/package.json'))
const electron = require('electron')
const { build: bundle } = createRequire(require.resolve('vite'))('esbuild')
const state = join(repository, '.local/state/native-host-exclusion')
await mkdir(state, { recursive: true })
const out = await mkdtemp(join(state, 'run-'))
const appRoot = join(out, 'electron-app')
const receipt = { schema: 'agentmux.native-host-exclusion-proof.v1', passed: false,
  boundary: 'Real Electron Main, visible uniquely colored BrowserWindow, native helper discovery and ScreenCaptureKit PNGs. The wrong-PID helper must fail the excluded pixel assertion; compile failures and timeouts are infrastructure failures. No real macOS 12/13 device claim.' }
const wrongPid = {
  before: 'includeHostWindows ? [getpid()] : [getpid(), hostPID]',
  after: 'includeHostWindows ? [getpid()] : [getpid(), hostPID + 1]',
  killedBy: 'excluded isolated-region unique color is absent'
}
async function commandText(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${program} failed: ${result.stderr ?? ''}`)
  return result.stdout.trim()
}
async function buildHelper(name, mutate = false) {
  const directory = join(out, name), packageDirectory = join(directory, 'package')
  await mkdir(packageDirectory, { recursive: true })
  await cp(join(nativePackage, 'macos/Package.swift'), join(packageDirectory, 'Package.swift'))
  await cp(join(nativePackage, 'macos/Sources'), join(packageDirectory, 'Sources'), { recursive: true })
  await cp(join(nativePackage, 'macos/Tests'), join(packageDirectory, 'Tests'), { recursive: true })
  if (mutate) {
    const file = join(packageDirectory, 'Sources/AgentMuxNativeMacOS/NativeDesktopOperations.swift')
    const original = await readFile(file, 'utf8')
    assert.equal(original.split(wrongPid.before).length, 2, 'The real wrong-PID mutation anchor must occur once')
    await writeFile(file, original.replace(wrongPid.before, wrongPid.after))
  }
  const build = spawnSync('swift', ['build', '--package-path', packageDirectory, '--scratch-path', join(directory, 'scratch'),
    '--configuration', 'debug', '--jobs', '1'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180_000 })
  await writeFile(join(directory, 'build.log'), (build.stdout ?? '') + (build.stderr ?? ''))
  if (build.error) throw build.error
  assert.equal(build.status, 0, `${name} did not compile; this is not a behavior kill`)
  const binaryDirectory = await commandText('swift', ['build', '--package-path', packageDirectory, '--scratch-path', join(directory, 'scratch'),
    '--configuration', 'debug', '--jobs', '1', '--show-bin-path'])
  return join(binaryDirectory, 'agentmux-native-macos')
}
function helperPids(executablePath) {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return result.stdout.split('\n').filter(line => line.includes(executablePath + ' --agent '))
    .map(line => Number(line.trim().split(/\s+/, 1)[0])).filter(Number.isSafeInteger)
}
async function assertHelperExited(executablePath) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (helperPids(executablePath).length === 0) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  for (const pid of helperPids(executablePath)) {
    try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  for (const pid of helperPids(executablePath)) {
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  assert.deepEqual(helperPids(executablePath), [], 'Every real native helper must exit after its owner disconnects')
}
async function runElectron(label, executablePath) {
  const directory = join(out, label)
  await mkdir(directory, { recursive: true })
  const environment = { ...process.env, AGENTMUX_NATIVE_HOST_EXCLUSION_OUT: directory,
    AGENTMUX_NATIVE_HOST_EXCLUSION_EXECUTABLE: executablePath }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [appRoot], { cwd: repository, detached: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', timedOut = false, escalation
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
  const timer = setTimeout(() => {
    timedOut = true
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    escalation = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 3000)
  }, 90_000)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(escalation); resolve({ code, signal }) })
    })
    await writeFile(join(directory, 'process.log'), log)
    assert.equal(timedOut, false, `${label} timed out; this is not a behavior result`)
    assert.equal(result.signal, null, `${label} was terminated; this is not a behavior result`)
    const fixture = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'))
    return { ...result, fixture }
  } finally { await assertHelperExited(executablePath) }
}
try {
  await mkdir(join(appRoot, 'out/main'), { recursive: true })
  await symlink(join(repository, 'apps/desktop/node_modules'), join(appRoot, 'node_modules'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  await bundle({ entryPoints: [join(repository, 'apps/desktop/scripts/fixtures/native-host-exclusion/main.ts')],
    outfile: join(appRoot, 'out/main/main.js'), bundle: true, platform: 'node', format: 'esm',
    external: ['electron', '@agentmux/native-desktop'], logLevel: 'silent' })

  const baselineExecutable = await buildHelper('baseline-helper')
  const baseline = await runElectron('baseline', baselineExecutable)
  assert.equal(baseline.code, 0, `Real baseline failed: ${JSON.stringify(baseline.fixture.failure)}`)
  assert.equal(baseline.fixture.passed, true)
  receipt.baseline = { included: baseline.fixture.included, excluded: baseline.fixture.excluded,
    checks: baseline.fixture.checks, hostWindowId: baseline.fixture.hostWindowId }

  const mutantExecutable = await buildHelper('wrong-pid-helper', true)
  const mutant = await runElectron('wrong-pid', mutantExecutable)
  assert.notEqual(mutant.code, 0, 'The real wrong-PID native helper survived')
  assert.equal(mutant.fixture.passed, false)
  assert.equal(mutant.fixture.failure?.name, wrongPid.killedBy,
    `Wrong-PID must fail the owning pixel assertion, not infrastructure or another check: ${JSON.stringify(mutant.fixture.failure)}`)
  assert.equal(mutant.fixture.checks.find(check => check.name === 'included isolated-region unique color is present')?.passed, true,
    'The mutation must reach excluded capture after a passing included pixel proof')
  assert.equal(mutant.fixture.checks.find(check => check.name === wrongPid.killedBy)?.passed, false)
  receipt.wrongPidMutation = { killedBy: wrongPid.killedBy, includedColorPixels: mutant.fixture.included.colorPixels,
    excludedColorPixels: mutant.fixture.excluded.colorPixels }
  receipt.passed = true
} catch (error) {
  receipt.failure = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  if (receipt.passed) await rm(out, { recursive: true, force: true })
  else receipt.output = out
  console.log(JSON.stringify(receipt))
}
