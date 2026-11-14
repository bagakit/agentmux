import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
if (process.argv.includes('--help')) {
  console.log('verify-native-frames.mjs [--keep]\nCompiles the Core frame reader and display lease and the exact production capture dispatch and captureDisplays/window snapshot/displayPixels/BlockingAsync source against controlled display, window, ScreenCaptureKit, CoreGraphics, PNG and exact-source services. Runs modern and forced pre-14 behavior checks plus behavioral mutants, including PID/panel exclusion, legacy refusal and timing. No AppKit, real pixels, permission prompt, App assembly, real macOS 12/13 device claim or installation. The run directory is removed unless --keep.')
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
  dispatch: slice(operations, '    static func capture(_ params: [String: JSONValue]) -> [String: Any] {', '    private static func capturedRectangle(_ rect:'),
  frames: slice(operations, '    static func captureDisplays(hostPID: pid_t, includeHostWindows: Bool = false) throws', '    private static func captureRect(_ rect:'),
  displayRequest: slice(main, '        case "captureDisplays":', '        case "clipboardRead":'),
  blocking: slice(main, 'private final class AsyncBox<T>:', 'private struct BoundedPNG {'),
  lease: readFileSync(core[2], 'utf8'),
}
function swiftc(parameters, log) {
  const result = spawnSync('swiftc', parameters, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''))
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Compiler failed: ${log}\n${result.stderr ?? ''}`)
}
function build(name, mutation, forceCoreGraphics = false) {
  const directory = join(output, name)
  mkdirSync(directory)
  const loaded = { ...production }
  if (forceCoreGraphics) loaded.frames = replaceOnce(loaded.frames, 'if #available(macOS 14.0, *) {', 'if #available(macOS 14.0, *), false {')
  if (mutation) loaded[mutation.part] = replaceOnce(loaded[mutation.part], mutation.before, mutation.after)
  const lease = join(directory, 'NativeDisplayCaptureLease.swift')
  writeFileSync(lease, loaded.lease)
  swiftc([...options, '-emit-module', '-emit-library', '-module-name', 'AgentMuxNativeMacOSCore', core[0], core[1], lease,
    '-emit-module-path', join(directory, 'AgentMuxNativeMacOSCore.swiftmodule'), '-o', join(directory, 'libAgentMuxNativeMacOSCore.dylib')], join(directory, 'core.log'))
  const checks = [['/* PRODUCTION_CAPTURE_DISPATCH */', loaded.dispatch], ['/* PRODUCTION_DISPLAY_FRAMES */', loaded.frames],
    ['/* PRODUCTION_DISPLAY_REQUEST */', loaded.displayRequest],
    ['/* PRODUCTION_BLOCKING_ASYNC */', loaded.blocking]].reduce((source, [marker, code]) => replaceOnce(source, marker, code), fixture)
  const source = join(directory, 'CompiledDisplayFramesChecks.swift')
  writeFileSync(source, checks)
  swiftc([...options, ...(forceCoreGraphics ? ['-D', 'FORCE_CORE_GRAPHICS'] : []), '-parse-as-library', '-I', directory, '-L', directory, '-lAgentMuxNativeMacOSCore',
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
  { name: 'unknown-mode-falls-back-to-main-display', part: 'dispatch', before: 'throw ProviderError.coded("invalid_argument", "mode must be display, rect or window")', after: 'rect = CGDisplayBounds(CGMainDisplayID())', kills: 'selection is an unknown native mode and starts no capture' },
  { name: 'drop-issue', part: 'frames', before: 'entry["issue"] = ', after: '_ = ', kills: 'a display that cannot be captured carries its issue and no pixels' },
  { name: 'empty-success', part: 'frames', before: 'guard displays.contains(where: { $0["png"] != nil }) else {', after: 'guard true else {', kills: 'no captured display is a typed failure, not an empty success' },
  { name: 'drop-safe-top', part: 'frames', before: '$0.uint32Value, screen.backingScaleFactor, screen.safeAreaInsets.top', after: '$0.uint32Value, screen.backingScaleFactor, 0', kills: 'each display reports the band its camera housing covers at the top, zero without one' },
  { name: 'ignore-scale', part: 'frames', before: 'let width = ceil(frame.width * scale), height = ceil(frame.height * scale)', after: 'let width = ceil(frame.width), height = ceil(frame.height)', kills: "pixels follow each display's own scale" },
  { name: 'show-cursor', part: 'frames', before: 'configuration.showsCursor = false', after: '', kills: 'grabs never include the cursor' },
  { name: 'producer-drops-ownership', part: 'frames', before: 'defer { withExtendedLifetime(ownership) {} }', after: '', kills: 'a second capture is busy while the first producer still owns the display' },
  { name: 'no-frame-budget', part: 'frames', before: 'guard encodedBytes <= remainingFrameBytes else {', after: 'guard true else {', kills: 'a display whose pixels overflow the response frame carries its own issue' },
  { name: 'budget-not-cumulative', part: 'frames', before: 'remainingFrameBytes -= encodedBytes', after: '_ = encodedBytes', kills: 'a display whose pixels overflow the response frame carries its own issue' },
  { name: 'grab-past-image-limits', part: 'frames', before: 'guard NativeImageLimits.permits(width: width, height: height) else {\n            throw ProviderError.coded("image_too_large", "display pixels exceed the host image allocation limit")\n        }\n        guard let match', after: 'guard let match', kills: 'a display past the host image limits carries image_too_large and is never grabbed' },
  { name: 'ignore-configuration-change', part: 'frames', before: 'guard match.frame == frame else {', after: 'guard true else {', kills: 'a display whose bounds changed since enumeration carries its issue and no pixels' },
  { name: 'enumerate-per-display', part: 'frames', before: 'content: resolved.shareable,', after: 'content: BlockingAsync.run(timeout: 10) { try await SCShareableContent.current },', kills: "one window enumeration serves every display's grab" },
  { name: 'timestamp-after-grabs', part: 'frames', before: '"capturedAt": capturedAt', after: '"capturedAt": Date().timeIntervalSince1970 * 1000', kills: 'capturedAt is taken before the first grab' },
  { name: 'list-host-windows', part: 'frames', before: 'let windows = allWindows.filter { $0.normalLayer && !excludedOwners.contains($0.pid) }', after: 'let windows = allWindows.filter { $0.normalLayer && $0.pid != getpid() }', kills: "the host's windows are not capture content" },
  { name: 'list-helper-windows', part: 'frames', before: 'let windows = allWindows.filter { $0.normalLayer && !excludedOwners.contains($0.pid) }', after: 'let windows = allWindows.filter { $0.normalLayer && $0.pid != hostPID }', kills: "the helper's own windows are not capture content" },
  { name: 'omit-included-host-windows', part: 'frames', before: 'includeHostWindows ? [getpid()] :', after: 'includeHostWindows ? [getpid(), hostPID] :', kills: "the included background lists the host's visible windows in place" },
  { name: 'include-helper-windows', part: 'frames', before: 'includeHostWindows ? [getpid()] :', after: 'includeHostWindows ? [] :', kills: "the included background still excludes the helper's windows" },
  { name: 'excluded-pixels-keep-host-wrong-pid', part: 'frames', before: ': [getpid(), hostPID]', after: ': [getpid(), hostPID + 1]', kills: 'excluded pixels remove helper and every capturable host window by PID, including panels, and no other PID' },
  { name: 'excluded-pixels-drop-host', part: 'frames', before: ': [getpid(), hostPID]', after: ': [getpid()]', kills: 'excluded pixels remove helper and every capturable host window by PID, including panels, and no other PID' },
  { name: 'excluded-pixels-drop-helper', part: 'frames', before: ': [getpid(), hostPID]', after: ': [hostPID]', kills: 'excluded pixels remove helper and every capturable host window by PID, including panels, and no other PID' },
  { name: 'pixel-filter-drops-panels', part: 'frames', before: 'return excludedOwners.contains(pid)', after: 'return excludedOwners.contains(pid) && window.windowLayer == 0', kills: 'excluded pixels remove helper and every capturable host window by PID, including panels, and no other PID' },
  { name: 'pixel-filter-excludes-other-pids', part: 'frames', before: 'return excludedOwners.contains(pid)', after: 'return true', kills: 'included pixels exclude every helper window and no host or other-PID window' },
  { name: 'included-excludes-no-windows', part: 'frames', before: 'SCContentFilter(display: display, excludingWindows: exclusions)', after: 'SCContentFilter(display: display, excludingWindows: [])', kills: 'included pixels exclude every helper window and no host or other-PID window' },
  { name: 'drop-native-timing', part: 'frames', before: '"timing": ["contentMs": contentMs, "windowListMs": windowListMs, "totalMs": captureMilliseconds(since: totalStarted)]', after: '"timing": [:]', kills: "native timing covers content, window list, total and every display's capture, PNG, base64 and total" },
  { name: 'drop-per-display-timing', part: 'frames', before: 'entry["timing"] = ', after: '_ = ', kills: "native timing covers content, window list, total and every display's capture, PNG, base64 and total" },
  { name: 'old-os-silent-coregraphics-fallback', part: 'frames', before: 'if !includeHostWindows && hostWindows.contains(where: { $0.frame.intersects(frame) }) {', after: 'if false {', kills: 'forced CoreGraphics exclusion refuses only the display containing the visible host', forceCoreGraphics: true },
  { name: 'drop-include-host-option', part: 'displayRequest', before: 'includeHostWindows: params["includeHostWindows"]?.bool ?? false', after: 'includeHostWindows: false', kills: "the included background lists the host's visible windows in place" },
  { name: 'accept-nonboolean-host-option', part: 'displayRequest', before: 'value.bool == nil', after: 'false', kills: 'a nonboolean host-window option is refused before a grab' },
  { name: 'list-every-layer', part: 'frames', before: 'let windows = allWindows.filter { $0.normalLayer && !excludedOwners.contains($0.pid) }', after: 'let windows = allWindows.filter { !excludedOwners.contains($0.pid) }', kills: 'only normal-layer windows are listed' },
  { name: 'list-transparent-windows', part: 'frames', before: '((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,', after: '', kills: 'windows absent from the pixels are not listed' },
  { name: 'list-unshared-windows', part: 'frames', before: '(info[kCGWindowSharingState as String] as? NSNumber)?.intValue != 0,', after: '', kills: 'windows absent from the pixels are not listed' },
  { name: 'list-windows-off-display', part: 'frames', before: 'windows.filter { $0.frame.intersects(frame) }', after: 'windows', kills: 'a window on no display is not listed' },
  { name: 'windows-back-to-front', part: 'frames', before: '.filter { $0.frame.intersects(frame) }.map(\\.entry)', after: '.filter { $0.frame.intersects(frame) }.reversed().map(\\.entry)', kills: 'each display lists the normal windows over it front to back' },
  { name: 'drop-window-owner', part: 'frames', before: 'entry["owner"] = owner', after: '_ = owner', kills: 'a window across displays is listed on each with its global frame and owner' },
  { name: 'list-windows-per-display', part: 'frames', before: '"windows": windows.filter', after: '"windows": visibleWindows(excludingOwners: excludedOwners).filter', kills: 'one window list serves every display' },
  { name: 'lease-never-busy', part: 'lease', before: 'guard !occupied else { lock.unlock(); throw Failure.busy }', after: '', kills: 'a second capture is busy while the first producer still owns the display' },
]
const receipt = { schema: 'agentmux.native-frames-verification.v1', passed: false, mutants: [] }
try {
  const baseline = build('baseline')
  receipt.baseline = { tests: baseline.tests, failures: baseline.failures }
  assert.equal(baseline.exitCode, 0, `Baseline failed: ${JSON.stringify(baseline.failures)}`)
  const legacyBaseline = build('legacy-baseline', undefined, true)
  receipt.legacyBaseline = { tests: legacyBaseline.tests, failures: legacyBaseline.failures }
  assert.equal(legacyBaseline.exitCode, 0, `Forced CoreGraphics baseline failed: ${JSON.stringify(legacyBaseline.failures)}`)
  for (const mutation of mutations) {
    const result = build('mutant-' + mutation.name, mutation, mutation.forceCoreGraphics === true)
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
