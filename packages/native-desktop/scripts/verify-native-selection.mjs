import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, statfsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const macos = join(repository, 'packages/native-desktop/macos')
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('verify-native-selection.mjs --source | --preview [--output DIRECTORY]\nCompiles only the real selection/Core sources and bare AppKit host; no App assembly/signing/install. --source requires two distinct active displays, drives real AppKit events and buttons, exports explicitly scoped AppKit view-layout frames and kills nonempty behavioral mutants. --preview opens the same production picker for manual interaction. No screen capture or permission request is used by the view-layout export; WindowServer layering and system focus remain unverified.')
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
const outputRoot = join(repository, '.local/state/screenshot-experience/native-selection')
mkdirSync(outputRoot, { recursive: true })
const output = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : mkdtempSync(join(outputRoot, 'run-'))
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
    throw new Error('Expected real picker completion did not arrive; observation timed out')
  }
  async stop() {
    this.child.stdin.end()
    let closed = await Promise.race([this.closed, delay(2000).then(() => null)])
    if (!closed) { this.child.kill('SIGTERM'); closed = await Promise.race([this.closed, delay(2000).then(() => null)]) }
    assert(closed, `Exact preview process ${this.child.pid} closure is unknown`)
    assert.equal(closed.code, 0, `Exact preview process ${this.child.pid} did not exit normally`)
    assert.equal(closed.signal, null, `Exact preview process ${this.child.pid} was terminated`)
    return { pid: this.child.pid, ...closed }
  }
}
const behavioral = (condition, message) => { if (!condition) throw Object.assign(new Error(message), { assertion: true }) }
async function exercise(directory, capture) {
  const host = new Host(join(directory, 'selection-preview'))
  let primary
  let receipt
  const cases = []
  try {
    const verify = (condition, message) => { cases.push(message); behavioral(condition, message) }
    const ready = await host.ready()
    const screen = ready.screen
    const begin = await host.request('begin', { allowEditing: true })
    verify(Array.isArray(ready.screens) && ready.screens.length >= 2, 'Multidisplay proof requires at least two actual displays')
    verify(new Set(ready.screens.map(display => display.displayId)).size === ready.screens.length, 'Actual display identities are distinct')
    verify(begin.surfaces.length === ready.screens.length, 'Every actual display owns a distinct production overlay')
    verify(begin.surfaces.length > 0 && begin.surfaces.every(surface => surface.acceptsFirstMouse), 'Every display accepts the first selection click without losing it to window activation')
    for (const display of ready.screens) {
      const surface = begin.surfaces.find(surface => surface.displayId === display.displayId)
      verify(surface && JSON.stringify(surface.frame) === JSON.stringify(display.frame), 'Each overlay occupies its exact actual display frame')
    }
    const offset = { x: screen.x - begin.window.x, y: screen.y - begin.window.y }
    let rectangle = { x: offset.x + screen.width * 0.22, y: offset.y + screen.height * 0.28,
      width: screen.width * 0.38, height: screen.height * 0.35 }
    const sameRect = (actual, expected) => actual && Object.keys(expected).every(key => Math.abs(actual[key] - expected[key]) < 0.01)
    const point = (x, y) => ({ x, y })
    const drag = (from, to) => host.request('drag', { from, to, displayId: ready.displayId })
    const images = []
    const image = async (name, viewport = {}) => {
      if (!capture) return
      await delay(60)
      const path = join(directory, name + '-layout.png')
      const value = await host.request('layout', { path, ...viewport })
      assert.equal(value.source, 'AppKit-view-layout-only')
      assert.equal(value.windowServerFrame, false)
      const bytes = readFileSync(path)
      assert(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(16) === value.width && bytes.readUInt32BE(20) === value.height, 'Actual AppKit layout PNG metadata mismatch')
      images.push({ name, state: 'captured', path, width: value.width, height: value.height, source: value.source,
        windowServerFrame: false, rasterization: value.rasterization, compositing: value.compositing, scale: value.scale,
        constrainedViewport: value.constrainedViewport, displayId: value.displayId, viewport: value.viewport,
        sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    for (const display of ready.screens) await image('initial-display-' + display.displayId, { displayId: display.displayId })
    await host.request('useDisplay', { displayId: ready.displayId })
    const firstReleased = await drag(point(rectangle.x, rectangle.y), point(rectangle.x + rectangle.width, rectangle.y + rectangle.height))
    const firstGlobal = { ...rectangle, x: rectangle.x + begin.window.x, y: rectangle.y + begin.window.y }
    verify(firstReleased.surfaces.length > 0 && firstReleased.surfaces.every(surface => sameRect(surface.selection, firstGlobal)), 'Every display reads the same original selection immediately after a gesture')
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
    await drag(point(toolbar.x + 95, toolbar.y + 21), point(toolbar.x + 95, toolbar.y + 22))
    const controls = (await host.request('inspect')).controls
    verify(controls.some(button => button.identifier === 'native-selection-confirm' && button.enabled), 'Real confirm button is enabled for a valid released selection')
    await host.request('button', { identifier: 'native-selection-confirm' })
    const confirmed = await host.completion(1)
    verify(confirmed.visiblePickerWindows === 0, 'Confirmation retires every display overlay before completion')
    verify(confirmed.state === 'confirmed' && confirmed.completionAction === 'capture', 'Confirm button must preserve direct capture intent rather than cancel or edit')
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
    verify(redrawResult.completionAction === undefined, 'Pure capture completion does not leak a host editing intent')
    await host.request('begin', { allowEditing: true })
    await host.request('key', { keyCode: 14 })
    await delay(40)
    verify(host.completions.length === 4, 'Edit shortcut cannot complete an empty selection')
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    const editableControls = (await host.request('inspect')).controls
    verify(editableControls.some(button => button.identifier === 'native-selection-edit' && button.enabled), 'Opt-in exposes a real enabled Edit button for the selected image')
    await image('editable-selected')
    await image('narrow', { width: 280, height: 360 })
    await image('short', { width: 640, height: 240 })
    await host.request('button', { identifier: 'native-selection-edit' })
    verify((await host.completion(5)).completionAction === 'edit', 'Real Edit button passes the typed editing intent with original geometry')
    await host.request('begin', { allowEditing: true })
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    await host.request('key', { keyCode: 14 })
    verify((await host.completion(6)).completionAction === 'edit', 'E shortcut passes the same typed editing intent')
    await host.request('begin', { allowEditing: true })
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    await host.request('key', { keyCode: 36 })
    verify((await host.completion(7)).completionAction === 'capture', 'Return keeps direct completion for an opt-in request')
    await host.request('begin')
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    const pureControls = (await host.request('inspect')).controls
    verify(!pureControls.some(button => button.identifier === 'native-selection-edit'), 'No opt-in means no edit control without a consumer')
    await host.request('key', { keyCode: 14 })
    await delay(40)
    verify(host.completions.length === 7, 'No opt-in means E cannot open an editor or complete selection')
    await host.request('key', { keyCode: 53 })
    verify((await host.completion(8)).state === 'cancelled', 'Pure capture retains cancellation after an unused edit shortcut')
    let count = 8
    const globalDrag = async (display, from, to) => host.request('drag', { displayId: display.displayId,
      from: point(from.x - display.frame.x, from.y - display.frame.y), to: point(to.x - display.frame.x, to.y - display.frame.y) })
    const confirmGlobal = async expected => {
      await host.request('key', { keyCode: 36 })
      const completion = await host.completion(++count)
      const quartz = { x: expected.x, y: screen.y + screen.height - expected.y - expected.height, width: expected.width, height: expected.height }
      verify(completion.state === 'confirmed' && sameRect(completion.rect, quartz), 'Original shared selection completes with exact global Quartz coordinates')
      verify(completion.visiblePickerWindows === 0, 'All production display overlays close before the original request completes')
    }
    for (const display of ready.screens) {
      await host.request('begin', { allowEditing: true })
      const frame = display.frame
      const from = point(frame.x + frame.width * 0.20, frame.y + frame.height * 0.26)
      const to = point(frame.x + frame.width * 0.57, frame.y + frame.height * 0.62)
      const empty = await globalDrag(display, from, from)
      verify(empty.surfaces.filter(surface => surface.toolbarVisible).length === 1 && empty.surfaces.find(surface => surface.toolbarVisible).displayId === display.displayId, 'An empty click on another display moves the original toolbar to that event display')
      const result = await globalDrag(display, from, to)
      const expected = { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y }
      verify(result.surfaces.length > 0 && result.surfaces.every(surface => sameRect(surface.selection, expected)), 'Main and secondary views consume one identical global selection state')
      verify(result.surfaces.filter(surface => surface.toolbarVisible).length === 1, 'Exactly one toolbar belongs to the released global selection')
      await image('display-' + display.displayId)
      await confirmGlobal(expected)
    }
    if (ready.screens.length > 1) {
      const primaryDisplay = ready.screens[0], secondary = ready.screens[1]
      for (const [source, destination] of [[primaryDisplay, secondary], [secondary, primaryDisplay]]) {
        await host.request('begin', { allowEditing: true })
        const from = point(source.frame.x + source.frame.width * 0.31, source.frame.y + source.frame.height * 0.38)
        const to = point(destination.frame.x + destination.frame.width * 0.63, destination.frame.y + destination.frame.height * 0.55)
        const expected = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) }
        const result = await globalDrag(source, from, to)
        verify(result.surfaces.length > 1 && result.surfaces.every(surface => sameRect(surface.selection, expected)), 'A gesture continues outside its original display using the actual source window')
        await host.request('useDisplay', { displayId: destination.displayId })
        await host.request('key', { keyCode: 124 })
        expected.x += 1
        const adjusted = await host.request('inspect')
        verify(adjusted.surfaces.length > 1 && adjusted.surfaces.every(surface => sameRect(surface.selection, expected)), 'A key from another display adjusts the original shared selection')
        for (const display of ready.screens) await image('cross-from-' + source.displayId + '-display-' + display.displayId, { displayId: display.displayId })
        await confirmGlobal(expected)
      }
    }
    await host.request('begin')
    await host.request('displayChange')
    const configurationChange = await host.completion(++count)
    verify(configurationChange.state === 'failed' && configurationChange.code === 'display_configuration_changed', 'A display-change notification fails the original request explicitly')
    verify(host.completions.length > 0 && host.completions.every(value => value.visiblePickerWindows === 0), 'Capture, edit and cancellation each retire every original overlay')
    receipt = { tests: cases.length, cases, displays: ready.screens, separateSpaces: ready.separateSpaces, multidisplayExercised: ready.screens.length > 1,
      completions: host.completions, images, events: host.events }
    return receipt
  } catch (error) {
    error.diagnostics = { cases, events: host.events, completions: host.completions, stderr: host.errors }
    primary = error
    throw error
  } finally {
    try { const cleanup = await host.stop(); if (primary) primary.diagnostics.cleanup = cleanup; else if (receipt) receipt.cleanup = cleanup } catch (cleanup) { if (primary) throw new AggregateError([primary, cleanup], 'Picker test and exact-host cleanup failed'); throw cleanup }
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
    report.unverified = ['WindowServer fullscreen/layering', 'system foreground/focus and physical event delivery', 'screen capture permissions and installed application', 'physical mixed-scale displays and final system PNG']
    const state = core[1], view = picker[0]
    const mutations = [
      { name: 'display-enumeration', path: view, before: 'for screen in screens {', after: 'for screen in screens.prefix(1) {' },
      { name: 'global-event-coordinates', path: view, before: 'event.window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow', after: 'event.locationInWindow' },
      { name: 'shared-selection-owner', path: view, before: 'window.contentView = NativeScreenSelection(viewport: screen.frame, coordinator: coordinator)',
        after: 'window.contentView = NativeScreenSelection(viewport: screen.frame, coordinator: NativeSelectionCoordinator(screenFrames: screens.map(\\.frame), primaryTop: primary.frame.maxY, initialPoint: coordinator.initialPoint, allowEditing: allowEditing))' },
      { name: 'close-all-displays', path: view, before: 'for window in presentation.windows {', after: 'for window in presentation.windows.prefix(1) {' },
      { name: 'first-display-click', path: view, before: 'override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }', after: 'override func acceptsFirstMouse(for event: NSEvent?) -> Bool { false }' },
      { name: 'move', path: state, before: 'rectangle = translated(original, dx: location.x - anchor.x, dy: location.y - anchor.y)', after: 'rectangle = original' },
      { name: 'nudge', path: state, before: 'self.rectangle = translated(rectangle, dx: dx, dy: dy)', after: 'self.rectangle = rectangle' },
      { name: 'resize', path: state, before: 'right = min(bounds.maxX, max(location.x, left + minimumWidth))', after: 'right = original.maxX' },
      { name: 'panel-bounds', path: state, before: 'x: min(max(preferredOrigin.x, available.minX), available.maxX - width)', after: 'x: preferredOrigin.x' },
      { name: 'capture-lease', path: core[3], before: '        guard !occupied else { lock.unlock(); throw Failure.busy }', after: '        // Test mutant: concurrent ownership is admitted.' },
      { name: 'consumer-lease', path: operationsSource, before: 'return try NativeSelectionCaptureLease.shared.withCapture {', after: 'return try unleasedCapture {' },
      { name: 'release', path: view, before: 'func pointerUp(_ point: NSPoint) { selection.pointerUp(point); refresh() }', after: 'func pointerUp(_ point: NSPoint) { selection.pointerUp(point); refresh(); complete(action: .capture) }' },
      { name: 'escape', path: view, before: 'case 53: cancel()', after: 'case 53: confirm()' },
      { name: 'toolbar', path: view, before: 'confirmButton.action = #selector(confirm)', after: 'confirmButton.action = #selector(cancel)' },
      { name: 'edit-action', path: view, before: 'editButton.action = #selector(edit)', after: 'editButton.action = #selector(confirm)' },
      { name: 'edit-opt-in', path: view, before: 'guard allowEditing else { return }', after: '// Mutant: ignores the original host opt-in.' },
      { name: 'consumer-edit-intent', path: operationsSource, before: 'if allowEditing { result["completionAction"] = selection.completionAction.rawValue }', after: 'if allowEditing { result["completionAction"] = "capture" }' },
      { name: 'dimensions-toolbar', path: view, before: 'selection: rect, toolbar: toolbar.frame, screen: screen)', after: 'selection: rect, toolbar: .zero, screen: screen)' },
    ]
    assert(mutations.length > 0)
    report.mutations = []
    for (const mutation of mutations) {
      const directory = build(join(output, 'mutant-' + mutation.name), mutation)
      const result = checks(directory)
      if (result.failures.length > 0 && result.exitCode !== 0) { report.mutations.push({ name: mutation.name, state: 'killed-by-state-assertion', tests: result.tests, failures: result.failures }); continue }
      assert.equal(result.exitCode, 0, 'Mutation failed outside state assertions')
      let failure
      try { await exercise(directory, false) } catch (error) {
        if (!error.assertion) throw error
        assert(error.diagnostics.cases.length > 0, 'AppKit mutant must execute a nonempty behavior assertion set')
        failure = { assertion: error.message, cases: error.diagnostics.cases, cleanup: error.diagnostics.cleanup }
      }
      assert(failure, `Surviving behavior mutation: ${mutation.name}`)
      report.mutations.push({ name: mutation.name, state: 'killed-by-AppKit-assertion', ...failure })
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
