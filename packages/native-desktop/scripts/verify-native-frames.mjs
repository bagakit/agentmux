import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
if (process.argv.includes('--help')) {
  console.log('verify-native-frames.mjs [--keep]\nCompiles the Core display lease and the exact production captureDisplays/displayPixels/BlockingAsync source against a controlled display list, ScreenCaptureKit and PNG encoder, runs the checks and one-branch mutants. No AppKit, real pixels, permission prompt, App assembly or installation. The run directory is removed unless --keep.')
  process.exit(0)
}
assert.equal(process.platform, 'darwin', 'The production capture source compiles only on macOS')
const macos = join(repository, 'packages/native-desktop/macos')
const core = ['NativeImageLimits.swift', 'NativeNDJSONReader.swift', 'NativeDisplayCaptureLease.swift'].map(name => join(macos, 'Sources/AgentMuxNativeMacOSCore', name))
const operations = readFileSync(join(macos, 'Sources/AgentMuxNativeMacOS/NativeDesktopOperations.swift'), 'utf8')
const main = readFileSync(join(macos, 'Sources/AgentMuxNativeMacOS/main.swift'), 'utf8')
const fixture = readFileSync(join(macos, 'Verification/DisplayFramesChecks.swift'), 'utf8')
const state = join(repository, '.local/state/native-frames')
mkdirSync(state, { recursive: true })
const space = statfsSync(state)
const available = Number(space.bavail) * Number(space.bsize) / 1024 / 1024
assert(available > 500, `Only ${available.toFixed(0)} MiB free; refusing to compile`)
const output = mkdtempSync(join(state, 'run-'))
const cache = join(state, 'module-cache')
const options = ['-swift-version', '6', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`, '-module-cache-path', cache]

function once(source, needle) {
  assert.equal(source.split(needle).length, 2, `Must occur exactly once: ${needle}`)
  return source.indexOf(needle)
}
function replaceOnce(source, from, to) {
  once(source, from)
  return source.replace(from, () => to)
}
function slice(source, from, until) {
  const start = once(source, from), end = source.indexOf(until, start)
  assert(end > start, `Extraction end is missing: ${until}`)
  return source.slice(start, end)
}
const production = {
  frames: slice(operations, '    static func captureDisplays() throws', '    private static func captureRect(_ rect:'),
  blocking: slice(main, 'private final class AsyncBox<T>:', 'private struct BoundedPNG {'),
  lease: readFileSync(core[2], 'utf8'),
}
function swiftc(parameters, log) {
  const result = spawnSync('swiftc', parameters, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''))
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Compiler failed: ${log}\n${result.stderr ?? ''}`)
}
function build(name, mutation) {
  const directory = join(output, name)
  mkdirSync(directory)
  const loaded = { ...production }
  if (mutation) loaded[mutation.part] = replaceOnce(loaded[mutation.part], mutation.before, mutation.after)
  const lease = join(directory, 'NativeDisplayCaptureLease.swift')
  writeFileSync(lease, loaded.lease)
  swiftc([...options, '-emit-module', '-emit-library', '-module-name', 'AgentMuxNativeMacOSCore', core[0], core[1], lease,
    '-emit-module-path', join(directory, 'AgentMuxNativeMacOSCore.swiftmodule'), '-o', join(directory, 'libAgentMuxNativeMacOSCore.dylib')], join(directory, 'core.log'))
  const checks = replaceOnce(replaceOnce(fixture, '/* PRODUCTION_DISPLAY_FRAMES */', loaded.frames), '/* PRODUCTION_BLOCKING_ASYNC */', loaded.blocking)
  const source = join(directory, 'CompiledDisplayFramesChecks.swift')
  writeFileSync(source, checks)
  swiftc([...options, '-parse-as-library', '-I', directory, '-L', directory, '-lAgentMuxNativeMacOSCore',
    '-Xlinker', '-rpath', '-Xlinker', '@executable_path', source, '-o', join(directory, 'checks')], join(directory, 'checks.log'))
  const result = spawnSync(join(directory, 'checks'), [], { encoding: 'utf8', timeout: 60_000 })
  if (result.error) throw result.error
  assert.equal(result.signal, null, `${name} terminated outside an assertion`)
  const report = JSON.parse(result.stdout)
  assert(Number.isSafeInteger(report.tests) && report.tests > 0 && report.cases.length === report.tests, `${name} ran no cases`)
  assert(report.failures.every(failure => report.cases.includes(failure)), `${name} reported a failure it never ran`)
  return { exitCode: result.status, ...report }
}

const mutations = [
  { name: 'drop-issue', part: 'frames', before: 'entry["issue"] = ', after: '_ = ', kills: 'a display that cannot be captured carries its issue and no pixels' },
  { name: 'empty-success', part: 'frames', before: 'guard displays.contains(where: { $0["png"] != nil }) else {', after: 'guard true else {', kills: 'no captured display is a typed failure, not an empty success' },
  { name: 'every-display-main', part: 'frames', before: '"isMain": screen.id == CGMainDisplayID()', after: '"isMain": true', kills: 'main display is the OS main display only' },
  { name: 'ignore-scale', part: 'frames', before: 'let width = ceil(frame.width * scale), height = ceil(frame.height * scale)', after: 'let width = ceil(frame.width), height = ceil(frame.height)', kills: "pixels follow each display's own scale" },
  { name: 'show-cursor', part: 'frames', before: 'configuration.showsCursor = false', after: '', kills: 'grabs never include the cursor' },
  { name: 'producer-drops-ownership', part: 'frames', before: 'defer { withExtendedLifetime(ownership) {} }', after: '', kills: 'a second capture is busy while the first producer still owns the display' },
  { name: 'lease-never-busy', part: 'lease', before: 'guard !occupied else { lock.unlock(); throw Failure.busy }', after: '', kills: 'a second capture is busy while the first producer still owns the display' },
]
const receipt = { schema: 'agentmux.native-frames-verification.v1', passed: false, mutants: [] }
try {
  const baseline = build('baseline')
  receipt.baseline = { tests: baseline.tests, failures: baseline.failures }
  assert.equal(baseline.exitCode, 0, `Baseline failed: ${JSON.stringify(baseline.failures)}`)
  for (const mutation of mutations) {
    const result = build('mutant-' + mutation.name, mutation)
    assert.notEqual(result.exitCode, 0, `Surviving mutant: ${mutation.name}`)
    assert(result.failures.includes(mutation.kills), `Mutant ${mutation.name} must fail "${mutation.kills}", failed ${JSON.stringify(result.failures)}`)
    receipt.mutants.push({ name: mutation.name, killedBy: mutation.kills })
  }
  receipt.passed = true
} catch (error) {
  receipt.failure = error.message
  process.exitCode = 1
} finally {
  if (process.argv.includes('--keep') || !receipt.passed) receipt.output = output
  else rmSync(output, { recursive: true, force: true })
  console.log(JSON.stringify(receipt))
}
