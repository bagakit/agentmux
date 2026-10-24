import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(packageRoot, 'macos')
const args = process.argv.slice(2)
const sourceOnly = args.includes('--source-only')
const option = name => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`)
  return args[index + 1]
}
if (args.includes('--help')) {
  process.stdout.write(`Usage: node packages/native-desktop/scripts/verify-native.mjs --source-only
       node packages/native-desktop/scripts/verify-native.mjs --source [--scratch-path PATH]
--source-only parses Swift syntax only; no SDK typecheck, test, build or UI.
--source runs real Swift tests/build, two nonempty test-killed mutants and the production Node client against native OS dispatch.
It launches an isolated AppKit window, sends real input to that exact process/window and captures only its pixels.
No application assembly, signing, installation, permission changes or user clipboard writes.
Actual capture may show macOS consent; the runner never approves it. Missing authorization fails the requested scope.
`)
  process.exit(0)
}
for (let index = 0; index < args.length; index++) {
  if (['--source', '--source-only'].includes(args[index])) continue
  if (args[index] === '--scratch-path') { option('--scratch-path'); index++; continue }
  throw new Error(`Unknown argument: ${args[index]}`)
}
if (sourceOnly === args.includes('--source')) throw new Error('Choose exactly one of --source-only and --source')
if (process.platform !== 'darwin') throw new Error('Native verification requires macOS')

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const errorRecord = error => ({ name: error?.name ?? 'Error', message: error instanceof Error ? error.message : String(error),
  ...(error?.code ? { code: error.code } : {}), ...(error?.fixture ? { fixture: error.fixture } : {}),
  ...(error instanceof AggregateError ? { errors: error.errors.map(errorRecord) } : {}) })
function command(command, parameters, { log, capture = false, allowFailure = false } = {}) {
  const fd = log ? openSync(log, 'w', 0o600) : undefined
  let result
  try {
    result = spawnSync(command, parameters, { encoding: 'utf8',
      stdio: capture ? 'pipe' : ['ignore', fd ?? 2, fd ?? 2], maxBuffer: 2 * 1024 * 1024 })
  } finally { if (fd !== undefined) closeSync(fd) }
  if (result.error) throw result.error
  if (result.signal || (!allowFailure && result.status !== 0)) throw new Error(`${command} failed (${result.status ?? result.signal}); ${log ?? result.stderr ?? 'see stderr'}`)
  return result
}
function swiftFiles(directory) {
  const files = readdirSync(directory).filter(name => name.endsWith('.swift')).sort().map(name => join(directory, name))
  assert(files.length > 0, `Swift syntax selection is empty: ${directory}`)
  return files
}
function parseSources() {
  for (const directory of ['Sources/AgentMuxNativeMacOS', 'Sources/AgentMuxNativeMacOSCore', 'Tests/AgentMuxNativeMacOSTests', 'Verification']) {
    command('swiftc', ['-frontend', '-parse', ...swiftFiles(join(root, directory))])
  }
}
function testCounts(report) {
  const count = xpath => Number(command('/usr/bin/xmllint', ['--nonet', '--xpath', xpath, report], { capture: true }).stdout.trim())
  const tests = count('count(//testcase)')
  const failures = count('count(//testcase/failure | //testcase/error)')
  assert(Number.isSafeInteger(tests) && tests > 0, `Empty/non-XCTest report: ${report}`)
  assert(Number.isSafeInteger(failures) && failures >= 0, `Invalid XCTest failure count: ${report}`)
  return { tests, failures }
}

// Mutants live in this invocation's private copy. Missing reports, compilation
// errors and empty test selections are infrastructure failures, never kills.
function verifyMutations(evidence, moduleCache) {
  const definitions = [
    { name: 'ax-unknown-must-not-fallback', file: 'NativeAXReply.swift', from: 'default: .unknown', to: 'default: .unsupported', filter: 'NativeAXReplyTests' },
    { name: 'pixels-are-mutations', file: 'NativePeerPolicy.swift', from: 'case "getAppState": includesScreenshot', to: 'case "getAppState": false', filter: 'NativePeerPolicyTests' },
  ]
  assert(definitions.length > 0, 'Mutation collection must not be empty')
  return definitions.map(definition => {
    const directory = join(evidence, definition.name)
    mkdirSync(directory, { recursive: true })
    for (const part of ['Sources/AgentMuxNativeMacOSCore', 'Tests/AgentMuxNativeMacOSTests']) {
      cpSync(join(root, part), join(directory, part), { recursive: true, errorOnExist: true, force: false })
    }
    writeFileSync(join(directory, 'Package.swift'), `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "NativeMutation", platforms: [.macOS(.v12)], targets: [
.target(name: "AgentMuxNativeMacOSCore"),
.testTarget(name: "AgentMuxNativeMacOSTests", dependencies: ["AgentMuxNativeMacOSCore"])])
`)
    const path = join(directory, 'Sources/AgentMuxNativeMacOSCore', definition.file)
    const source = readFileSync(path, 'utf8')
    assert(source.split(definition.from).length === 2, `Mutant must change one actual branch: ${definition.name}`)
    writeFileSync(path, source.replace(definition.from, definition.to))
    const report = join(directory, 'tests.xml')
    const result = command('swift', ['test', '--package-path', directory, '--scratch-path', join(directory, '.build'), '--jobs', '1',
      '--disable-index-store', '-Xswiftc', '-module-cache-path', '-Xswiftc', moduleCache,
      '--filter', definition.filter, '--xunit-output', report], { log: join(directory, 'test.log'), allowFailure: true })
    const counts = testCounts(report)
    assert(result.status !== 0 && counts.failures > 0, `Mutant survived or failed outside a test assertion: ${definition.name}`)
    return { name: definition.name, changedBranches: 1, ...counts, state: 'killed-by-test', report }
  })
}

class FixtureProcess {
  pending = new Map()
  sequence = 0
  constructor(executable, log) {
    this.executablePath = executable
    this.log = openSync(log, 'w', 0o600)
    this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', this.log] })
    this.closed = new Promise(resolve => this.child.once('close', () => { closeSync(this.log); resolve() }))
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated fixture did not become ready')), 10_000)
      this.acceptReady = value => { clearTimeout(timer); resolve(value) }
      this.failReady = error => { clearTimeout(timer); reject(error) }
    })
    this.ready.catch(() => {})
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      try {
        assert(Buffer.byteLength(line) < 64 * 1024, 'Fixture control frame too large')
        const value = JSON.parse(line)
        if (value.kind === 'ready') this.acceptReady(value)
        else { const pending = this.pending.get(value.id); if (pending) { this.pending.delete(value.id); pending.resolve(value) } }
      } catch (error) { this.fail(error) }
    })
    this.child.once('error', error => this.fail(error))
    this.child.once('close', () => { lines.close(); this.fail(new Error('Isolated fixture closed')) })
    this.child.stdin.on('error', error => this.fail(error))
  }
  fail(error) {
    this.failReady(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
  request(method) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Fixture ${method} timed out`)) }, 5000)
      const done = callback => value => { clearTimeout(timer); callback(value) }
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) })
      this.child.stdin.write(JSON.stringify({ id, method }) + '\n')
    })
  }
  async stop() {
    // EOF closes only the subprocess returned by our own spawn. No PID lookup,
    // global process matching or permission/reset operation is involved.
    this.child.stdin.end()
    if (!await Promise.race([this.closed.then(() => true), delay(2000).then(() => false)])) {
      this.child.kill('SIGTERM')
      if (!await Promise.race([this.closed.then(() => true), delay(2000).then(() => false)])) {
        throw Object.assign(new Error('The exact spawned fixture did not confirm closure after EOF and SIGTERM'), {
          code: 'fixture_cleanup_unknown', fixture: { pid: this.child.pid ?? null, executablePath: this.executablePath },
        })
      }
    }
  }
}
async function observeUntil(observe, accepts, description) {
  const deadline = Date.now() + 5000
  do {
    const value = await observe()
    if (accepts(value)) return value
    await delay(50) // Repeat observations only; never replay an input.
  } while (Date.now() < deadline)
  throw new Error(`Unconfirmed fixture effect: ${description}; the original input was not retried`)
}
async function verifyOSFixture(desktop, instanceId, evidence, swiftArgs, pngFromBytes, pngBytes) {
  const binary = join(evidence, 'native-verification-fixture')
  command('swiftc', [...swiftArgs, join(root, 'Verification/Fixture.swift'), '-o', binary], { log: join(evidence, 'fixture-build.log') })
  const fixture = new FixtureProcess(binary, join(evidence, 'fixture.log'))
  let primaryError
  try {
    const ready = await fixture.ready
    assert(ready.pid === fixture.child.pid && Number.isSafeInteger(ready.windowId) && ready.windowId > 0, 'Fixture did not identify its actual process/window')
    const discovered = await observeUntil(() => desktop.request('listApps'), value => value.apps?.some(app => app.pid === ready.pid), 'fixture process discovery')
    const app = discovered.apps.find(app => app.pid === ready.pid)
    assert(Number.isFinite(app.processStartedAt), 'Fixture process birth is unknown')
    const target = { app: `pid:${ready.pid}`, processStartedAt: app.processStartedAt, windowId: ready.windowId,
      clientScope: `native-verification:${randomUUID()}`, noScreenshot: true }
    const windows = await desktop.request('listWindows', target)
    const window = windows.windows?.find(window => window.id === ready.windowId)
    assert(window && window.app.pid === ready.pid, 'Production discovery did not find the exact fixture window')
    const operations = []
    const act = async (method, parameters) => {
      const snapshot = await desktop.request('getAppState', target)
      assert(typeof snapshot.snapshotId === 'string' && snapshot.snapshot?.window?.id === ready.windowId, 'Native snapshot did not preserve fixture window identity')
      const operationId = randomUUID()
      const result = await desktop.request(method, { ...target, snapshotId: snapshot.snapshotId, ...parameters }, { operationId, expectedInstanceId: instanceId })
      const operation = desktop.inspectOperation(operationId, instanceId)
      assert(operation.state === 'completed' && operation.instanceId === instanceId && result.action?.targetWindowId === ready.windowId,
        'Production action lost its original operation/window receipt')
      operations.push({ operationId, instanceId, method, state: operation.state, action: result.action })
      return result
    }
    const click = point => {
      assert(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'Fixture point is unavailable')
      return act('click', { x: point.x - window.x, y: point.y - window.y })
    }
    await click(ready.textCenter)
    await act('hotkey', { key: 'cmd+a' })
    const expectedText = `AgentMux fixture ${randomUUID()}`
    await act('typeText', { text: expectedText })
    await observeUntil(() => fixture.request('state'), state => state.text === expectedText, 'typed text')
    const before = await fixture.request('state')
    assert(Number.isSafeInteger(before.presses), 'Fixture counter is not a machine integer')
    await click(ready.buttonCenter)
    const actual = await observeUntil(() => fixture.request('state'), state => state.presses === before.presses + 1, 'button click')
    const operationId = randomUUID()
    const capture = await desktop.request('captureScreenshot', { mode: 'window', app: target.app,
      processStartedAt: target.processStartedAt, windowId: ready.windowId }, { operationId, expectedInstanceId: instanceId })
    assert(capture.state === 'captured', `Fixture capture did not produce pixels: ${JSON.stringify(capture)}`)
    const image = pngFromBytes(Buffer.from(capture.screenshot.data, 'base64'))
    assert(capture.screenshot.format === 'png' && image.width === capture.screenshot.width && image.height === capture.screenshot.height,
      'Captured PNG does not match native metadata')
    assert(Number.isFinite(capture.screenshot.scale) && capture.screenshot.scale > 0, 'Capture scale is unavailable')
    const pixels = pngBytes({ ...image, dataUrl: 'data:image/png;base64,' + capture.screenshot.data })
    const captureOperation = desktop.inspectOperation(operationId, instanceId)
    assert(captureOperation.state === 'completed', 'Native capture lost its original operation receipt')
    const pngPath = join(evidence, 'fixture-window.png')
    writeFileSync(pngPath, pixels, { mode: 0o600 })
    return { state: 'passed', pid: ready.pid, processStartedAt: target.processStartedAt, windowId: ready.windowId,
      operations, textMatched: actual.text === expectedText, buttonPresses: actual.presses,
      capture: { operationId, instanceId, state: captureOperation.state, pngPath,
        width: capture.screenshot.width, height: capture.screenshot.height, engine: capture.engine } }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { await fixture.stop() } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], 'Native fixture operation and exact-process cleanup both failed')
      throw cleanupError
    }
  }
}

let evidence
const report = { schema: 'agentmux.native-verification.v1', mode: sourceOnly ? 'source-only' : 'source',
  featureAccepted: false, unverified: ['release signer peer positive/negative cases', 'LaunchServices/TCC/permission continuity',
    'selection success/cancel and multi-display/HiDPI', 'clipboard text/PNG and partial-input OS branches', 'macOS 12/13 runtime'] }
try {
  parseSources()
  report.syntax = 'passed'
  if (sourceOnly) {
    report.unverified.unshift('SDK typecheck/link', 'Swift tests and nonempty mutation tests', 'production native dispatch', 'isolated fixture input/capture')
  } else {
    const scratch = resolve(option('--scratch-path') ?? join(root, '.build', 'verification'))
    mkdirSync(scratch, { recursive: true })
    evidence = mkdtempSync(join(scratch, 'run-'))
    report.evidence = evidence
    const moduleCache = join(evidence, 'module-cache')
    const buildDirectory = join(evidence, 'native-build')
    const swiftArgs = ['-module-cache-path', moduleCache]
    const shared = ['--package-path', root, '--scratch-path', buildDirectory, '--jobs', '1', '--disable-index-store',
      '-Xswiftc', '-module-cache-path', '-Xswiftc', moduleCache]
    const xunit = join(evidence, 'tests.xml')
    command('swift', ['test', ...shared, '--xunit-output', xunit], { log: join(evidence, 'test.log') })
    report.tests = testCounts(xunit)
    assert(report.tests.failures === 0, 'Baseline XCTest report has failing tests')
    report.mutations = verifyMutations(evidence, moduleCache)
    command('swift', ['build', ...shared, '--configuration', 'debug', '--product', 'agentmux-native-macos'], { log: join(evidence, 'build.log') })
    const binDirectory = command('swift', ['build', ...shared, '--configuration', 'debug', '--show-bin-path'], { capture: true }).stdout.trim()
    assert(binDirectory && !binDirectory.includes('\n'), 'SwiftPM did not identify one binary directory')
    const sdkDirectory = join(evidence, 'sdk')
    command('pnpm', ['exec', 'tsc', '-p', join(packageRoot, 'tsconfig.json'), '--outDir', sdkDirectory],
      { log: join(evidence, 'sdk-build.log') })
    writeFileSync(join(sdkDirectory, 'package.json'), '{"type":"module"}\n')
    const { NativeDesktop, pngFromBytes, pngBytes } = await import(pathToFileURL(join(sdkDirectory, 'index.js')).href)
    const desktop = new NativeDesktop({ executablePath: join(binDirectory, 'agentmux-native-macos') })
    try {
      const hello = await desktop.request('handshake')
      assert(hello.provider === 'agentmux-native-macos' && hello.protocolVersion === 1 && typeof hello.instanceId === 'string', 'Production handshake mismatch')
      const [applications, displays, permissions] = await Promise.all([
        desktop.request('listApps'), desktop.request('listDisplays'), desktop.request('permissionStatus'),
      ])
      assert(Array.isArray(applications.apps) && applications.apps.length > 0, 'OS application discovery was empty')
      assert(Array.isArray(displays.displays) && displays.displays.length > 0, 'OS display discovery was empty')
      assert(permissions.source === 'macOS-preflight' && permissions.authoritativeForOperation === false, 'Permission readout lost its non-authoritative source')
      report.production = { state: 'passed', provider: hello.provider, instanceId: hello.instanceId,
        appCount: applications.apps.length, displayCount: displays.displays.length, permissions }
      report.fixture = await verifyOSFixture(desktop, hello.instanceId, evidence, swiftArgs, pngFromBytes, pngBytes)
    } finally { await desktop.dispose() }
  }
  report.state = 'passed-requested-scope'
} catch (error) {
  report.state = 'failed'
  report.error = errorRecord(error)
  process.exitCode = 1
}
if (evidence) writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
