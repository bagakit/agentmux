import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('verify-selection-pixel-lifetime.mjs --source [--output DIRECTORY]\nCompiles only Core ownership and exact extracted production capture/SCK/BlockingAsync methods against controlled IO. Preserves the production ten-second observer timeout. Runs non-cooperative pixel lifetime assertions and two source-loaded mutants. No AppKit/UI, actual screenshot, permission prompt, App assembly, signing or installation.')
  process.exit(0)
}
assert(args.includes('--source'), 'Choose --source')
let output = join(repository, '.local/state/screenshot-experience/pixel-lifetime')
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--source') continue
  if (args[index] === '--output') {
    assert(args[index + 1] && !args[index + 1].startsWith('--'), '--output requires a directory')
    output = resolve(args[++index]); continue
  }
  throw new Error(`Unknown argument: ${args[index]}`)
}
assert.equal(process.platform, 'darwin', 'The exact CoreGraphics production branch requires macOS')
mkdirSync(output, { recursive: true })
const macos = join(repository, 'packages/native-desktop/macos')
const core = ['NativeCaptureGeometry.swift', 'NativeImageLimits.swift', 'NativeSelectionCaptureLease.swift'].map(name => join(macos, 'Sources/AgentMuxNativeMacOSCore', name))
const operationsPath = join(macos, 'Sources/AgentMuxNativeMacOS/NativeDesktopOperations.swift')
const mainPath = join(macos, 'Sources/AgentMuxNativeMacOS/main.swift')
const fixturePath = join(macos, 'Verification/SelectionPixelLifetimeChecks.swift')
const leaseChecksPath = join(macos, 'Verification/SelectionLeaseChecks.swift')
const consumerChecksPath = join(macos, 'Verification/SelectionCaptureConsumerChecks.swift')
const sources = [...core, operationsPath, mainPath, fixturePath, leaseChecksPath, consumerChecksPath, fileURLToPath(import.meta.url)]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = new Map(sources.map(path => [path, readFileSync(path)]))
const hashes = () => Object.fromEntries(sources.map(path => [path.slice(repository.length + 1), hash(readFileSync(path))]))
const report = { schema: 'agentmux.selection-pixel-lifetime-verification.v1', passed: false, sourceHashes: hashes(),
  boundary: 'Exact source-loaded production capture, rectangle/SCK and BlockingAsync methods with real Core ownership; controlled selector/SCK service and PNG/permission IO. No AppKit, WindowServer, actual screenshot, physical shortcut/focus, TCC or signed/installed-app proof.',
  originalProductionTimeoutSeconds: 10, mutations: [] }
const cache = join(output, 'module-cache')
mkdirSync(cache, { recursive: true })
const options = ['-swift-version', '6', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`, '-module-cache-path', cache]
function command(parameters, log) {
  const space = statfsSync(output)
  process.stderr.write(`Pixel lifetime narrow compile: ${(Number(space.bavail) * Number(space.bsize) / 1024 / 1024).toFixed(0)} MiB available; same-run module cache.\n`)
  const result = spawnSync('swiftc', parameters, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''))
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Compiler failed: ${log}\n${result.stderr ?? ''}`)
}
function slice(source, from, until) {
  assert.equal(source.split(from).length, 2, `Production extraction start must be unique: ${from}`)
  const start = source.indexOf(from), end = source.indexOf(until, start)
  assert(end > start, `Production extraction end is missing: ${until}`)
  return source.slice(start, end)
}
function replace(source, from, to) {
  assert.equal(source.split(from).length, 2, `Source-loaded substitution must be unique: ${from}`)
  return source.replace(from, to)
}
const operations = inputs.get(operationsPath).toString(), main = inputs.get(mainPath).toString()
const extracted = {
  capture: slice(operations, '    static func capture(_ params:', '    static func listDisplays()'),
  rectangle: slice(operations, '    private static func captureRect(_ rect:', '    private static func displayScale(for rect:'),
  permission: slice(operations, '    static func permissionStatus()', '    static func clipboardRead('),
  blocking: slice(main, 'private final class AsyncBox<T>:', 'private struct BoundedPNG {'),
}
report.productionSlices = Object.fromEntries(Object.entries(extracted).map(([name, value]) => [name, { sha256: hash(value), byteLength: Buffer.byteLength(value) }]))
function build(name, mutation) {
  const directory = join(output, name)
  mkdirSync(directory, { recursive: true })
  const loaded = { ...extracted }
  if (mutation) loaded[mutation.part] = replace(loaded[mutation.part], mutation.before, mutation.after)
  let fixture = inputs.get(fixturePath).toString()
  for (const [part, marker] of Object.entries({ capture: 'CAPTURE_METHODS', rectangle: 'RECTANGLE_METHODS', permission: 'PERMISSION_QUERY', blocking: 'BLOCKING_ASYNC' })) {
    fixture = replace(fixture, `/* PRODUCTION_${marker} */`, loaded[part])
    writeFileSync(join(directory, 'production-' + part + '.swift.txt'), loaded[part])
  }
  const generated = join(directory, 'CompiledSelectionPixelLifetimeChecks.swift')
  writeFileSync(generated, fixture)
  const loading = { inputs: report.sourceHashes, generatedSha256: hash(fixture),
    productionSlices: Object.fromEntries(Object.entries(loaded).map(([part, value]) => [part, hash(value)])),
    mutation: mutation ? { name: mutation.name, part: mutation.part, before: mutation.before, after: mutation.after } : null }
  writeFileSync(join(directory, 'loaded-source.json'), JSON.stringify(loading, null, 2) + '\n')
  command([...options, '-emit-module', '-emit-library', '-module-name', 'AgentMuxNativeMacOSCore', ...core,
    '-emit-module-path', join(directory, 'AgentMuxNativeMacOSCore.swiftmodule'), '-o', join(directory, 'libAgentMuxNativeMacOSCore.dylib')], join(directory, 'core-build.log'))
  const link = [...options, '-parse-as-library', '-I', directory, '-L', directory, '-lAgentMuxNativeMacOSCore', '-Xlinker', '-rpath', '-Xlinker', '@executable_path']
  command([...link, generated, '-o', join(directory, 'selection-pixel-lifetime-checks')], join(directory, 'checks-build.log'))
  return { directory, link, loading }
}
function run(directory, binary) {
  const result = spawnSync(join(directory, binary), [], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(join(directory, binary + '.stdout.json'), result.stdout ?? '')
  writeFileSync(join(directory, binary + '.stderr.log'), result.stderr ?? '')
  if (result.error) throw result.error
  assert.equal(result.signal, null, 'Fixture process terminated outside a behavior assertion')
  const value = JSON.parse(result.stdout)
  assert(Number.isSafeInteger(value.tests) && value.tests > 0 && Array.isArray(value.cases) && value.cases.length === value.tests && Array.isArray(value.failures), 'Requested behavioral cases must be nonempty')
  assert(value.failures.every(failure => value.cases.includes(failure)), 'Failure must identify an executed assertion')
  return { ...value, exitCode: result.status, stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr ?? '') }
}
try {
  const baseline = build('baseline')
  report.baseline = run(baseline.directory, 'selection-pixel-lifetime-checks')
  assert.equal(report.baseline.exitCode, 0, JSON.stringify(report.baseline.failures))
  assert.equal(report.baseline.failures.length, 0)
  report.compatibility = []
  for (const [name, path] of [['lease', leaseChecksPath], ['consumer', consumerChecksPath]]) {
    let source = inputs.get(path).toString()
    if (name === 'consumer') source = replace(source, '/* PRODUCTION_CAPTURE_METHODS */', extracted.capture)
    const generated = join(baseline.directory, 'CompiledCompatibility' + name + '.swift')
    writeFileSync(generated, source)
    const binary = 'selection-compatibility-' + name
    command([...baseline.link, generated, '-o', join(baseline.directory, binary)], join(baseline.directory, binary + '-build.log'))
    const result = run(baseline.directory, binary)
    assert.equal(result.exitCode, 0, JSON.stringify(result.failures)); assert.equal(result.failures.length, 0)
    report.compatibility.push({ name, generatedSha256: hash(source), ...result })
  }
  const mutations = [
    { name: 'consumer-ownership', part: 'capture', before: 'return try capturedRectangle(selection, ownership: ownership)', after: 'return try capturedRectangle(selection)' },
    { name: 'async-ownership', part: 'rectangle', before: '            defer { withExtendedLifetime(ownership) {} }', after: '            // Test mutant: asynchronous producer does not retain physical ownership.' },
  ]
  assert(mutations.length > 0)
  for (const mutation of mutations) {
    const candidate = build('mutant-' + mutation.name, mutation)
    const result = run(candidate.directory, 'selection-pixel-lifetime-checks')
    assert.notEqual(result.exitCode, 0, `Surviving lifetime mutation: ${mutation.name}`)
    assert(result.failures.includes('B returns capture_busy until A physical pixel producer exits'), 'Mutation must fail the original physical-exclusivity counterexample')
    assert(result.failures.includes('B cannot open a second selector after A observer timeout'), 'Mutation must expose the second selector after the original observer timeout')
    report.mutations.push({ name: mutation.name, state: 'killed-by-lifetime-assertions', loading: candidate.loading, result })
  }
  assert.deepEqual(hashes(), report.sourceHashes, 'Source changed during bounded proof')
  report.passed = true
} catch (error) {
  report.failure = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, receipt: join(output, 'receipt.json'), failure: report.failure }))
}
