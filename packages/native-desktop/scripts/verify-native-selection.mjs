import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, statfsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const macos = join(repository, 'packages/native-desktop/macos')
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('verify-native-selection.mjs --source | --preview [--output DIRECTORY]\nCompiles only the real selection/Core sources and bare AppKit host; no App assembly/signing/install. --source drives real AppKit events and buttons, exports explicitly scoped AppKit view-layout frames and kills nonempty behavioral mutants. --preview opens the same production picker for manual interaction. No screen capture or permission request is used by the view-layout export; WindowServer layering and system focus remain unverified.')
  process.exit(0)
}
const preview = args.includes('--preview')
assert(preview !== args.includes('--source'), 'Choose --source or --preview')
const outputIndex = args.indexOf('--output')
if (outputIndex >= 0) assert(args[outputIndex + 1] && !args[outputIndex + 1].startsWith('--'), '--output requires a directory')
for (let i = 0; i < args.length; i++) {
  if (['--source', '--preview'].includes(args[i])) continue
  if (args[i] === '--output') { i++; continue }
  throw new Error(`Unknown argument: ${args[i]}`)
}
assert.equal(process.platform, 'darwin')
const output = resolve(outputIndex >= 0 ? args[outputIndex + 1] : join(repository, '.local/state/screenshot-experience/native-selection'))
mkdirSync(output, { recursive: true })
const cache = join(output, 'module-cache')
mkdirSync(cache, { recursive: true })
const core = ['NativeCaptureGeometry.swift', 'NativeSelectionState.swift', 'UnixSocketPathSafety.swift', 'NativeSelectionCaptureLease.swift'].map(name => join(macos, 'Sources/AgentMuxNativeMacOSCore', name))
const picker = ['NativeScreenSelection.swift', 'NativeSelectionRequest.swift'].map(name => join(macos, 'Sources/AgentMuxNativeMacOS', name))
const hostSource = join(macos, 'Verification/SelectionPreview.swift')
const checksSource = join(macos, 'Verification/SelectionStateChecks.swift')
const leaseChecksSource = join(macos, 'Verification/SelectionLeaseChecks.swift')
const consumerChecksSource = join(macos, 'Verification/SelectionCaptureConsumerChecks.swift')
const operationsSource = join(macos, 'Sources/AgentMuxNativeMacOS/NativeDesktopOperations.swift')
const sources = [...core, ...picker, operationsSource, hostSource, checksSource, leaseChecksSource, consumerChecksSource, fileURLToPath(import.meta.url)]
const hashes = Object.fromEntries(sources.map(path => [path.slice(repository.length + 1), createHash('sha256').update(readFileSync(path)).digest('hex')]))
const report = { schema: 'agentmux.native-selection-verification.v1', sourceHashes: hashes, featureAccepted: false,
  boundary: 'Real production NativeSelectionRequest/picker in a bare AppKit host; direct AppKit responder dispatch after exact own-view hit testing and real NSButton actions. WindowServer key/foreground and physical dispatch remain unknown. Not global shortcut, production signing, TCC continuity or installed-app proof.' }

function command(command, parameters, log) {
  const space = statfsSync(output)
  process.stderr.write(`Native selection compile: ${(Number(space.bavail) * Number(space.bsize) / 1024 / 1024).toFixed(0)} MiB available; reusing this invocation cache.\n`)
  const result = spawnSync(command, parameters, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''))
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Compiler failed: ${log}\n${result.stderr ?? ''}`)
}
function build(directory, change) {
  mkdirSync(directory, { recursive: true })
  const substitute = path => {
    if (!change || path !== change.path) return path
    const source = readFileSync(path, 'utf8')
    assert.equal(source.split(change.before).length, 2, 'Mutation must change exactly one real production branch')
    const copy = join(directory, 'Mutated' + path.slice(path.lastIndexOf('/') + 1))
    writeFileSync(copy, source.replace(change.before, change.after))
    return copy
  }
  const options = ['-swift-version', '6', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`, '-module-cache-path', cache]
  command('swiftc', [...options, '-emit-module', '-emit-library', '-module-name', 'AgentMuxNativeMacOSCore', ...core.map(substitute),
    '-emit-module-path', join(directory, 'AgentMuxNativeMacOSCore.swiftmodule'), '-o', join(directory, 'libAgentMuxNativeMacOSCore.dylib')], join(directory, 'core-build.log'))
  const link = [...options, '-parse-as-library', '-I', directory, '-L', directory, '-lAgentMuxNativeMacOSCore', '-Xlinker', '-rpath', '-Xlinker', '@executable_path']
  command('swiftc', [...link, ...picker.map(substitute), hostSource, '-o', join(directory, 'selection-preview')], join(directory, 'picker-build.log'))
  command('swiftc', [...link, checksSource, '-o', join(directory, 'selection-state-checks')], join(directory, 'checks-build.log'))
  command('swiftc', [...link, leaseChecksSource, '-o', join(directory, 'selection-lease-checks')], join(directory, 'lease-checks-build.log'))
  let operations = readFileSync(operationsSource, 'utf8')
  if (change?.path === operationsSource) {
    assert.equal(operations.split(change.before).length, 2, 'Production consumer mutation must change one actual branch')
    operations = operations.replace(change.before, change.after)
  }
  const start = operations.indexOf('    static func capture(_ params:')
  const end = operations.indexOf('    static func listDisplays()', start)
  assert(start >= 0 && end > start, 'Exact production capture consumer cannot be extracted')
  const template = readFileSync(consumerChecksSource, 'utf8')
  assert.equal(template.split('/* PRODUCTION_CAPTURE_METHODS */').length, 2)
  const consumer = join(directory, 'CompiledSelectionCaptureConsumer.swift')
  writeFileSync(consumer, template.replace('/* PRODUCTION_CAPTURE_METHODS */', operations.slice(start, end)))
  command('swiftc', [...link, consumer, '-o', join(directory, 'selection-consumer-checks')], join(directory, 'consumer-checks-build.log'))
  return directory
}
function checks(directory) {
  const reports = ['selection-state-checks', 'selection-lease-checks', 'selection-consumer-checks'].map(name => {
    const result = spawnSync(join(directory, name), [], { encoding: 'utf8' })
    assert.equal(result.signal, null, 'State tests terminated outside an assertion')
    let value
    try { value = JSON.parse(result.stdout) } catch { throw new Error(`State test report missing: ${result.stderr}`) }
    assert(Number.isSafeInteger(value.tests) && value.tests > 0 && Array.isArray(value.failures), 'State test selection must be nonempty')
    return { ...value, name, exitCode: result.status }
  })
  return { tests: reports.reduce((sum, report) => sum + report.tests, 0), failures: reports.flatMap(report => report.failures),
    cases: reports.flatMap(report => report.cases), exitCode: reports.every(report => report.exitCode === 0) ? 0 : 1, reports }
}

class Host {
  sequence = 0
  pending = new Map()
  events = []
  completions = []
  constructor(binary) {
    this.child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.errors = ''
    this.child.stderr.on('data', bytes => { this.errors += bytes.toString() })
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => resolve({ code, signal })))
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      try {
        assert(Buffer.byteLength(line) < 65536)
        const value = JSON.parse(line)
        this.events.push(value)
        if (value.event === 'completion') this.completions.push(value)
        if (value.id !== undefined) {
          const pending = this.pending.get(value.id)
          if (pending) { this.pending.delete(value.id); clearTimeout(pending.timer); value.ok ? pending.resolve(value) : pending.reject(Object.assign(new Error(value.message ?? 'Native fixture rejected command'), { receipt: value })) }
        }
      } catch (error) { this.fail(error) }
    })
    this.child.once('error', error => this.fail(error))
    this.child.once('close', () => { lines.close(); this.fail(new Error(`Exact preview host closed: ${this.errors}`)) })
    this.child.stdin.on('error', error => this.fail(error))
  }
  fail(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }; this.pending.clear() }
  async ready() {
    for (let i = 0; i < 100; i++) { const value = this.events.find(event => event.event === 'ready'); if (value) return value; await delay(50) }
    throw new Error(`Actual AppKit host did not become ready: ${this.errors}`)
  }
  request(method, params = {}) {
    const id = ++this.sequence
    this.events.push({ direction: 'request', id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`Actual AppKit ${method} did not return`), { receipt: { id, method, params, state: 'unknown' } })) }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, method, ...params }) + '\n')
    })
  }
  async completion(count) {
    for (let i = 0; i < 100; i++) { if (this.completions.length >= count) return this.completions[count - 1]; await delay(20) }
    throw Object.assign(new Error('Expected real picker completion did not arrive'), { assertion: true })
  }
  async stop() {
    this.child.stdin.end()
    let closed = await Promise.race([this.closed, delay(2000).then(() => null)])
    if (!closed) { this.child.kill('SIGTERM'); closed = await Promise.race([this.closed, delay(2000).then(() => null)]) }
    assert(closed, `Exact preview process ${this.child.pid} closure is unknown`)
    return { pid: this.child.pid, ...closed }
  }
}
const behavioral = (condition, message) => { if (!condition) throw Object.assign(new Error(message), { assertion: true }) }
async function exercise(directory, capture) {
  const host = new Host(join(directory, 'selection-preview'))
  let primary
  try {
    const cases = []
    const verify = (condition, message) => { cases.push(message); behavioral(condition, message) }
    const ready = await host.ready()
    const screen = ready.screen
    const begin = await host.request('begin')
    const offset = { x: screen.x - begin.window.x, y: screen.y - begin.window.y }
    let rectangle = { x: offset.x + screen.width * 0.22, y: offset.y + screen.height * 0.28,
      width: screen.width * 0.38, height: screen.height * 0.35 }
    const point = (x, y) => ({ x, y })
    const drag = (from, to) => host.request('drag', { from, to })
    const images = []
    const image = async name => {
      if (!capture) return
      await delay(60)
      const path = join(directory, name + '-layout.png')
      const value = await host.request('layout', { path })
      assert.equal(value.source, 'AppKit-view-layout-only')
      assert.equal(value.windowServerFrame, false)
      const bytes = readFileSync(path)
      assert(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(16) === value.width && bytes.readUInt32BE(20) === value.height, 'Actual AppKit layout PNG metadata mismatch')
      images.push({ name, state: 'captured', path, width: value.width, height: value.height, source: value.source,
        windowServerFrame: false, rasterization: value.rasterization, compositing: value.compositing, scale: value.scale,
        sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    await image('initial')
    await drag(point(rectangle.x, rectangle.y), point(rectangle.x + rectangle.width, rectangle.y + rectangle.height))
    await delay(40)
    verify(host.completions.length === 0, 'Mouse release must wait for explicit confirmation')
    await image('selected')
    const center = point(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2)
    await drag(center, point(center.x + 27, center.y + 19))
    rectangle.x += 27; rectangle.y += 19
    const corner = point(rectangle.x + rectangle.width, rectangle.y + rectangle.height)
    await drag(corner, point(corner.x + 35, corner.y + 25))
    rectangle.width += 35; rectangle.height += 25
    await host.request('key', { keyCode: 124 })
    await host.request('key', { keyCode: 126, shift: true })
    rectangle.x += 1; rectangle.y += 10
    await image('adjusted')
    const inspection = await host.request('inspect')
    const toolbar = inspection.toolbar
    await drag(point(toolbar.x + 3, toolbar.y + 3), point(toolbar.x + 28, toolbar.y + 5))
    await drag(point(toolbar.x + 18, toolbar.y + 21), point(toolbar.x + 35, toolbar.y + 22))
    const controls = (await host.request('inspect')).controls
    verify(controls.some(button => button.identifier === 'native-selection-confirm' && button.enabled), 'Real confirm button is enabled for a valid released selection')
    await host.request('button', { identifier: 'native-selection-confirm' })
    const confirmed = await host.completion(1)
    verify(confirmed.state === 'confirmed', 'Confirm button must confirm rather than cancel')
    const expected = { x: rectangle.x + begin.window.x, y: screen.y + screen.height - (rectangle.y + begin.window.y + rectangle.height), width: rectangle.width, height: rectangle.height }
    for (const key of Object.keys(expected)) verify(Math.abs(confirmed.rect[key] - expected[key]) < 0.01, `Actual moved/resized/nudged ${key} must preserve Quartz geometry`)
    await delay(40)
    verify(host.completions.length === 1, 'Completion must settle exactly once')
    await host.request('begin')
    await drag(point(offset.x + 40, offset.y + 20), point(offset.x + Math.min(screen.width - 10, 350), offset.y + 150))
    const edge = await host.request('inspect')
    const dimensions = edge.dimensions, edgeToolbar = edge.toolbar
    const intersects = dimensions.x < edgeToolbar.x + edgeToolbar.width && dimensions.x + dimensions.width > edgeToolbar.x
      && dimensions.y < edgeToolbar.y + edgeToolbar.height && dimensions.y + dimensions.height > edgeToolbar.y
    verify(dimensions.width > 0 && dimensions.height > 0 && !intersects, 'Real edge dimensions must remain visible without intersecting the actual toolbar')
    await image('edge')
    await host.request('key', { keyCode: 53 })
    verify((await host.completion(2)).state === 'cancelled', 'Escape must cancel an existing selection')
    await host.request('begin')
    await host.request('button', { identifier: 'native-selection-cancel' })
    verify((await host.completion(3)).state === 'cancelled', 'Real Cancel button must cancel an empty selection')
    await host.request('begin')
    await host.request('key', { keyCode: 36 })
    await delay(40)
    verify(host.completions.length === 3, 'Empty selection cannot confirm')
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 280, offset.y + 340))
    const redrawn = { x: offset.x + screen.width * 0.6, y: offset.y + screen.height * 0.6, width: 100, height: 90 }
    await drag(point(redrawn.x, redrawn.y), point(redrawn.x + redrawn.width, redrawn.y + redrawn.height))
    await host.request('key', { keyCode: 36 })
    const redrawResult = await host.completion(4)
    verify(redrawResult.state === 'confirmed' && Math.abs(redrawResult.rect.width - redrawn.width) < 0.01 && Math.abs(redrawResult.rect.height - redrawn.height) < 0.01, 'Outside drag redraws and Return confirms the new selection')
    return { tests: cases.length, cases, completions: host.completions, images, events: host.events }
  } catch (error) {
    error.diagnostics = { events: host.events, completions: host.completions, stderr: host.errors }
    primary = error
    throw error
  } finally {
    try { const cleanup = await host.stop(); if (primary) primary.diagnostics.cleanup = cleanup } catch (cleanup) { if (primary) throw new AggregateError([primary, cleanup], 'Picker test and exact-host cleanup failed'); throw cleanup }
  }
}

try {
  const baseline = build(output)
  report.stateChecks = checks(baseline)
  assert.equal(report.stateChecks.exitCode, 0)
  assert.equal(report.stateChecks.failures.length, 0)
  if (preview) {
    const child = spawn(join(baseline, 'selection-preview'), ['--interactive'], { stdio: 'inherit' })
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)) })
    assert.equal(result, 0)
    report.state = 'preview-closed'
  } else {
    report.appKit = await exercise(baseline, true)
    report.nativeFrames = 'not-verified'
    report.viewLayoutFrames = report.appKit.images.length > 0 && report.appKit.images.every(image => image.source === 'AppKit-view-layout-only') ? 'exported-awaiting-independent-review' : 'incomplete'
    report.unverified = ['WindowServer fullscreen/layering', 'system foreground/focus and physical event delivery', 'screen capture permissions and installed application']
    const state = core[1], view = picker[0]
    const mutations = [
      { name: 'move', path: state, before: 'rectangle = translated(original, dx: location.x - anchor.x, dy: location.y - anchor.y)', after: 'rectangle = original' },
      { name: 'nudge', path: state, before: 'self.rectangle = translated(rectangle, dx: dx, dy: dy)', after: 'self.rectangle = rectangle' },
      { name: 'resize', path: state, before: 'right = min(bounds.maxX, max(location.x, left + minimumWidth))', after: 'right = original.maxX' },
      { name: 'panel-bounds', path: state, before: 'x: min(max(preferredOrigin.x, available.minX), available.maxX - width)', after: 'x: preferredOrigin.x' },
      { name: 'capture-lease', path: core[3], before: '        guard !occupied else { lock.unlock(); throw Failure.busy }', after: '        // Test mutant: concurrent ownership is admitted.' },
      { name: 'consumer-lease', path: operationsSource, before: 'return try NativeSelectionCaptureLease.shared.withCapture {', after: 'return try unleasedCapture {' },
      { name: 'release', path: view, before: 'selection.pointerUp(convert(event.locationInWindow, from: nil)); refresh()', after: 'selection.pointerUp(convert(event.locationInWindow, from: nil)); refresh(); confirm()' },
      { name: 'escape', path: view, before: 'case 53: cancel()', after: 'case 53: confirm()' },
      { name: 'toolbar', path: view, before: 'confirmButton.action = #selector(confirm)', after: 'confirmButton.action = #selector(cancel)' },
      { name: 'dimensions-toolbar', path: view, before: 'selection: rect, toolbar: toolbar.frame, screen: screen)', after: 'selection: rect, toolbar: .zero, screen: screen)' },
    ]
    assert(mutations.length > 0)
    report.mutations = []
    for (const mutation of mutations) {
      const directory = build(join(output, 'mutant-' + mutation.name), mutation)
      const result = checks(directory)
      if (result.failures.length > 0 && result.exitCode !== 0) { report.mutations.push({ name: mutation.name, state: 'killed-by-state-assertion', tests: result.tests, failures: result.failures }); continue }
      assert.equal(result.exitCode, 0, 'Mutation failed outside state assertions')
      let killed = false
      try { await exercise(directory, false) } catch (error) { if (!error.assertion) throw error; killed = true }
      assert(killed, `Surviving behavior mutation: ${mutation.name}`)
      report.mutations.push({ name: mutation.name, state: 'killed-by-AppKit-assertion' })
    }
    report.state = 'behavior-passed-awaiting-independent-image-review'
    report.aestheticReview = 'not-performed-by-runner'
  }
} catch (error) {
  report.state = 'failed'
  report.error = { message: error.message, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(error => ({ message: error.message, diagnostics: error.diagnostics })) } : {}) }
  process.exitCode = 1
}
writeFileSync(join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
