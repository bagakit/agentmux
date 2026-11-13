import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, statfsSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const macos = join(repository, 'packages/native-desktop/macos')
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('verify-native-selection.mjs --source [--models-only] | --preview [--output DIRECTORY]\nCompiles only the real selection/Core sources and bare AppKit host; no App assembly/signing/install. --source requires two distinct active displays, drives real AppKit events and buttons, exports explicitly scoped AppKit view-layout frames and kills nonempty behavioral mutants. --preview opens the same production picker for manual interaction. --models-only runs production model/pixel/consumer assertions and their mutations without launching an AppKit host; it cannot sign off UI. No screen capture or permission request is used by the view-layout export; WindowServer layering and system focus remain unverified.')
  process.exit(0)
}
const preview = args.includes('--preview')
const modelsOnly = args.includes('--models-only')
assert(!modelsOnly || args.includes('--source'), '--models-only requires --source')
assert(preview !== args.includes('--source'), 'Choose --source or --preview')
const outputIndex = args.indexOf('--output')
if (outputIndex >= 0) assert(args[outputIndex + 1] && !args[outputIndex + 1].startsWith('--'), '--output requires a directory')
for (let i = 0; i < args.length; i++) {
  if (['--source', '--preview', '--models-only'].includes(args[i])) continue
  if (args[i] === '--output') { i++; continue }
  throw new Error(`Unknown argument: ${args[i]}`)
}
assert.equal(process.platform, 'darwin')
const outputRoot = join(repository, '.local/state/screenshot-experience/native-selection')
mkdirSync(outputRoot, { recursive: true })
const output = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : mkdtempSync(join(outputRoot, 'run-'))
mkdirSync(output, { recursive: true })
const cache = join(repository, '.local/state/screenshot-experience/native-module-cache')
mkdirSync(cache, { recursive: true })
const core = ['NativeCaptureGeometry.swift', 'NativeSelectionState.swift', 'UnixSocketPathSafety.swift', 'NativeSelectionCaptureLease.swift', 'NativeImageLimits.swift'].map(name => join(macos, 'Sources/AgentMuxNativeMacOSCore', name))
const picker = ['NativeScreenSelection.swift', 'NativeSelectionRequest.swift', 'NativeSelectionPixels.swift'].map(name => join(macos, 'Sources/AgentMuxNativeMacOS', name))
const hostSource = join(macos, 'Verification/SelectionPreview.swift')
const checksSource = join(macos, 'Verification/SelectionStateChecks.swift')
const leaseChecksSource = join(macos, 'Verification/SelectionLeaseChecks.swift')
const consumerChecksSource = join(macos, 'Verification/SelectionCaptureConsumerChecks.swift')
const pixelsChecksSource = join(macos, 'Verification/SelectionPixelsChecks.swift')
const operationsSource = join(macos, 'Sources/AgentMuxNativeMacOS/NativeDesktopOperations.swift')
const sources = [...core, ...picker, operationsSource, hostSource, checksSource, leaseChecksSource, consumerChecksSource, pixelsChecksSource, fileURLToPath(import.meta.url)]
const hashes = Object.fromEntries(sources.map(path => [path.slice(repository.length + 1), createHash('sha256').update(readFileSync(path)).digest('hex')]))
const report = { schema: 'agentmux.native-selection-verification.v1', sourceHashes: hashes, featureAccepted: false,
  boundary: 'Real production NativeSelectionRequest/picker in a bare AppKit host; direct AppKit responder dispatch after exact own-view hit testing and real NSButton actions. WindowServer key/foreground and physical dispatch remain unknown. Not global shortcut, production signing, TCC continuity or installed-app proof.' }

function command(command, parameters, log) {
  const space = statfsSync(output)
  process.stderr.write(`Native selection compile: ${(Number(space.bavail) * Number(space.bsize) / 1024 / 1024).toFixed(0)} MiB available; shared native compiler cache.\n`)
  const result = spawnSync(command, parameters, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''))
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Compiler failed: ${log}\n${result.stderr ?? ''}`)
}
let compiledBaseline
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
  const changedCore = !change || core.includes(change.path)
  const reuse = binary => copyFileSync(join(compiledBaseline, binary), join(directory, binary))
  if (compiledBaseline && !changedCore) {
    for (const name of ['AgentMuxNativeMacOSCore.swiftmodule', 'libAgentMuxNativeMacOSCore.dylib'])
      symlinkSync(join(compiledBaseline, name), join(directory, name))
  } else command('swiftc', [...options, '-emit-module', '-emit-library', '-module-name', 'AgentMuxNativeMacOSCore', ...core.map(substitute),
    '-emit-module-path', join(directory, 'AgentMuxNativeMacOSCore.swiftmodule'), '-o', join(directory, 'libAgentMuxNativeMacOSCore.dylib')], join(directory, 'core-build.log'))
  const link = [...options, '-parse-as-library', '-I', directory, '-L', directory, '-lAgentMuxNativeMacOSCore', '-Xlinker', '-rpath', '-Xlinker', '@executable_path']
  if (compiledBaseline && !changedCore && !picker.includes(change?.path)) reuse('selection-preview')
  else command('swiftc', [...link, ...picker.map(substitute), hostSource, '-o', join(directory, 'selection-preview')], join(directory, 'picker-build.log'))
  if (compiledBaseline && !changedCore) { reuse('selection-state-checks'); reuse('selection-lease-checks') }
  else {
    command('swiftc', [...link, checksSource, '-o', join(directory, 'selection-state-checks')], join(directory, 'checks-build.log'))
    command('swiftc', [...link, leaseChecksSource, '-o', join(directory, 'selection-lease-checks')], join(directory, 'lease-checks-build.log'))
  }
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
  if (compiledBaseline && !changedCore && change?.path !== operationsSource) reuse('selection-consumer-checks')
  else command('swiftc', [...link, consumer, '-o', join(directory, 'selection-consumer-checks')], join(directory, 'consumer-checks-build.log'))
  if (compiledBaseline && !changedCore && change?.path !== picker[2]) reuse('selection-pixels-checks')
  else command('swiftc', [...link, substitute(picker[2]), pixelsChecksSource, '-o', join(directory, 'selection-pixels-checks')], join(directory, 'pixels-checks-build.log'))
  if (!change) compiledBaseline = directory
  return directory
}
function checks(directory) {
  const reports = ['selection-state-checks', 'selection-lease-checks', 'selection-consumer-checks', 'selection-pixels-checks'].map(name => {
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
    // A shared machine may be compiling other mutants; launch gets the same 15s as any request.
    for (let i = 0; i < 300; i++) { const value = this.events.find(event => event.event === 'ready'); if (value) return value; await delay(50) }
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
    const drag = (from, to, hold = false) => host.request('drag', { from, to, displayId: ready.displayId, ...(hold ? { hold } : {}) })
    const intersects = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    const within = (inner, outer) => inner.x >= outer.x - 0.01 && inner.y >= outer.y - 0.01
      && inner.x + inner.width <= outer.x + outer.width + 0.01 && inner.y + inner.height <= outer.y + outer.height + 0.01
    const markIds = ['rect', 'arrow', 'note', 'pixelate', 'text'].map(tool => 'native-selection-mark-' + tool)
    const images = []
    const image = async (name, { marks, ...viewport } = {}) => {
      if (!capture && !viewport.width) return
      await delay(60)
      const path = join(directory, name + '-layout.png')
      const value = await host.request('layout', { path, ...viewport })
      assert.equal(value.source, 'AppKit-view-layout-only')
      assert.equal(value.windowServerFrame, false)
      if (viewport.width) {
        const shown = value.buttons.map(button => button.identifier)
        verify(value.magnifier === null, 'A resting constrained selection yields the loupe to its toolbar')
        verify(value.toolbar && within(value.toolbar, { x: 0, y: 0, width: value.width, height: value.height }), 'The constrained toolbar stays inside its own viewport')
        verify(value.buttons.length > 0 && new Set(value.buttons.map(button => button.frame.y)).size === 1, 'Constrained screenshot actions stay in one horizontal row')
        verify(value.buttons.every(button => within(button.frame, value.toolbar)), 'Every visible constrained action lies inside the actual toolbar')
        verify(!intersects(value.toolbar, value.dimensions), 'The constrained size chip never covers the toolbar')
        if (marks === 'collapsed') verify(shown.includes('native-selection-marks') && !shown.some(id => markIds.includes(id)) && shown.includes('native-selection-edit'), 'A narrow viewport folds the quick marks into one Markup control')
        else verify(markIds.every(id => shown.includes(id)) && !shown.includes('native-selection-marks') && shown.length === 8, 'A wide enough viewport shows every quick mark inline with Expand, Cancel and Done')
      }

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
    verify(firstReleased.surfaces.every(surface => surface.frozenPixels), 'Every selectable display uses the original frozen pixel source')
    const hoverPoint = point(offset.x + screen.width * 0.75, offset.y + screen.height * 0.70)
    const hovered = await host.request('hover', { point: hoverPoint, displayId: ready.displayId })
    verify(hovered.sample && hovered.sample.x === Math.floor(hoverPoint.x) && hovered.sample.y === Math.floor(screen.height - hoverPoint.y), 'The real chooser reports the original pixel under its actual pointer')
    await delay(40)
    verify(host.completions.length === 0, 'Mouse release must wait for explicit confirmation')
    const resting = await host.request('inspect')
    const restingLocal = { ...rectangle }
    verify(resting.magnifier === null && resting.toolbar.width > 0, 'A resting selection shows its toolbar and yields the loupe')
    verify(Math.abs(resting.toolbar.x + resting.toolbar.width - (restingLocal.x + restingLocal.width)) < 0.5
      && Math.abs(resting.toolbar.y + resting.toolbar.height + 8 - restingLocal.y) < 0.5, 'The toolbar sits 8pt below the selection with right edges aligned')
    verify(Math.abs(resting.dimensions.x - restingLocal.x) < 0.5 && Math.abs(resting.dimensions.y - (restingLocal.y + restingLocal.height + 8)) < 0.5
      && resting.dimensions.height === 20, 'The size chip sits above the selection top-left')
    const editing = resting.controls.filter(button => button.visible)
    verify(markIds.every(id => editing.some(button => button.identifier === id && button.enabled && /\([A-Z]\)$/.test(button.toolTip)))
      && editing.some(button => button.identifier === 'native-selection-edit' && button.toolTip === 'Open full editor (E)')
      && editing.some(button => button.identifier === 'native-selection-cancel' && button.toolTip === 'Cancel (Esc)'), 'Opt-in shows every quick mark, Expand and Cancel as named icon controls')
    const heldCenter = point(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2)
    const held = await drag(heldCenter, point(heldCenter.x + 5, heldCenter.y + 3), true)
    const heldLocal = { ...rectangle, x: rectangle.x + 5, y: rectangle.y + 3 }
    verify(held.isInteracting && Object.keys(held.toolbar).length === 0 && held.surfaces.every(surface => !surface.toolbarVisible), 'The toolbar disappears while the selection is moving')
    verify(held.magnifier && !intersects(held.magnifier, heldLocal), 'The loupe returns during a gesture and avoids the moving selection')
    await image('moving')
    const releasedHeld = await host.request('release', { point: point(heldCenter.x, heldCenter.y) })
    verify(!releasedHeld.isInteracting && releasedHeld.toolbar.width > 0 && releasedHeld.magnifier === null, 'Releasing the gesture restores the toolbar and hides the loupe')
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
    await drag(point(toolbar.x + 2, toolbar.y + 2), point(toolbar.x + 28, toolbar.y + 5))
    await drag(point(toolbar.x + toolbar.width - 2, toolbar.y + toolbar.height - 2), point(toolbar.x + toolbar.width - 2, toolbar.y + toolbar.height - 1))
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
    // Editing widens the right-aligned toolbar across the size chip's
    // default corner, so the chip must actually route around the toolbar.
    await host.request('begin', { allowEditing: true })
    await drag(point(offset.x + 40, offset.y + 20), point(offset.x + Math.min(screen.width - 10, 350), offset.y + 150))
    const edge = await host.request('inspect')
    const dimensions = edge.dimensions, edgeToolbar = edge.toolbar
    verify(dimensions.width > 0 && dimensions.height > 0 && !intersects(dimensions, edgeToolbar), 'Real edge dimensions must remain visible without intersecting the actual toolbar')
    await image('edge')
    await host.request('key', { keyCode: 53 })
    verify((await host.completion(2)).state === 'cancelled', 'Escape must cancel an existing selection')
    await host.request('begin')
    const empty = await host.request('inspect')
    verify(empty.surfaces.every(surface => !surface.toolbarVisible) && empty.hint.width > 0 && empty.dimensions.width === undefined, 'An empty chooser shows only its hint, never an action toolbar or size chip')
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 280, offset.y + 340))
    await host.request('button', { identifier: 'native-selection-cancel' })
    verify((await host.completion(3)).state === 'cancelled', 'Real Cancel button must cancel an existing selection')
    await host.request('begin')
    await host.request('key', { keyCode: 36 })
    await host.request('click', { point: point(offset.x + 200, offset.y + 200), clickCount: 2 })
    await delay(40)
    verify(host.completions.length === 3, 'Empty selection cannot confirm by Return or double click')
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 280, offset.y + 340))
    const redrawn = { x: offset.x + screen.width * 0.6, y: offset.y + screen.height * 0.6, width: 100, height: 90 }
    await drag(point(redrawn.x, redrawn.y), point(redrawn.x + redrawn.width, redrawn.y + redrawn.height))
    const outsideRight = await host.request('click', { point: point(offset.x + 20, offset.y + 20), button: 'right' })
    verify(outsideRight.rectangle === null && outsideRight.completions === 3 && outsideRight.surfaces.every(surface => !surface.toolbarVisible), 'A right click outside the selection clears it without cancelling')
    await drag(point(redrawn.x, redrawn.y), point(redrawn.x + redrawn.width, redrawn.y + redrawn.height))
    const insideRight = await host.request('click', { point: point(redrawn.x + 30, redrawn.y + 30), button: 'right' })
    verify(insideRight.rectangle !== null && insideRight.completions === 3, 'A right click inside the selection keeps it')
    await host.request('click', { point: point(redrawn.x + redrawn.width / 2, redrawn.y + redrawn.height / 2), clickCount: 2 })
    // A surviving gesture mutant never completes; report that as the assertion.
    const redrawResult = await host.completion(4).catch(() => ({ state: 'missing', rect: {} }))
    verify(redrawResult.state === 'confirmed' && Math.abs(redrawResult.rect.width - redrawn.width) < 0.01 && Math.abs(redrawResult.rect.height - redrawn.height) < 0.01, 'Outside drag redraws and a double click inside confirms the new selection')
    verify(redrawResult.completionAction === undefined, 'Pure capture completion does not leak a host editing intent')
    await host.request('begin', { allowEditing: true })
    await host.request('key', { keyCode: 14 })
    await host.request('key', { keyCode: 15 })
    await delay(40)
    verify(host.completions.length === 4, 'Edit and quick-mark shortcuts cannot complete an empty selection')
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    const editableControls = (await host.request('inspect')).controls
    verify(editableControls.some(button => button.identifier === 'native-selection-edit' && button.enabled), 'Opt-in exposes a real enabled Edit button for the selected image')
    const sampled = await host.request('inspect')
    verify(sampled.copiedColors.length === 0, 'Hover and selection never write to the clipboard')
    await host.request('key', { keyCode: 8 })
    let copied
    for (let i = 0; i < 100; i++) { copied = await host.request('inspect'); if (copied.copiedColors.length > 0) break; await delay(10) }
    verify(copied.copiedColors.length === 1 && copied.copiedColors[0] === sampled.sample.hex, 'Explicit C copies exactly the original frozen pointer sample through the supplied owner')
    verify(copied.completions === 4 && copied.surfaces.length > 0, 'Color copying preserves the original active selection')
    await host.request('failColorCopy')
    await host.request('key', { keyCode: 8 })
    let failedColor
    for (let i = 0; i < 100; i++) { failedColor = await host.request('inspect'); if (failedColor.colorCopyFeedback.startsWith('Copy unconfirmed')) break; await delay(10) }
    verify(failedColor.colorCopyFeedback.startsWith('Copy unconfirmed') && failedColor.completions === 4 && failedColor.copiedColors.length === 1, 'A rejected color copy reports uncertainty while selection and cancellation remain available')
    await host.request('key', { keyCode: 8 })
    let retriedColor
    for (let i = 0; i < 100; i++) { retriedColor = await host.request('inspect'); if (retriedColor.copiedColors.length === 2) break; await delay(10) }
    verify(retriedColor.copiedColors.length === 2 && retriedColor.copiedColors[1] === sampled.sample.hex, 'Explicit retry of a failed color copy reaches the same original sample')
    const afterCopy = await host.request('hover', { point: point(offset.x + 240, offset.y + 260), displayId: ready.displayId })
    verify(afterCopy.magnifier === null, 'Moving the pointer retires the colour receipt and its loupe from a resting selection')
    await image('editable-selected')
    await image('narrow', { width: 280, height: 360, marks: 'collapsed' })
    await image('short', { width: 640, height: 240, marks: 'inline' })
    await host.request('button', { identifier: 'native-selection-edit' })
    const expanded = await host.completion(5)
    verify(expanded.completionAction === 'edit' && expanded.editTool === undefined, 'Real Expand button opens the full editor without a start tool')
    await host.request('begin', { allowEditing: true })
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    await host.request('key', { keyCode: 14 })
    const shortcutEdit = await host.completion(6)
    verify(shortcutEdit.completionAction === 'edit' && shortcutEdit.editTool === undefined, 'E shortcut passes the same full-editor intent')
    await host.request('begin', { allowEditing: true })
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    await host.request('key', { keyCode: 36 })
    const directReturn = await host.completion(7)
    verify(directReturn.completionAction === 'capture' && directReturn.editTool === undefined, 'Return keeps direct completion without a start tool for an opt-in request')
    await host.request('begin', { allowEditing: true })
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    await host.request('button', { identifier: 'native-selection-mark-arrow' })
    const arrowMark = await host.completion(8)
    verify(arrowMark.completionAction === 'edit' && arrowMark.editTool === 'arrow', 'The Arrow quick mark opens the editor with the arrow tool')
    await host.request('begin', { allowEditing: true })
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    await host.request('key', { keyCode: 15 })
    const rectMark = await host.completion(9)
    verify(rectMark.completionAction === 'edit' && rectMark.editTool === 'rect', 'R starts the editor with the rectangle tool')
    await host.request('begin')
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    const pureControls = (await host.request('inspect')).controls
    verify(!pureControls.some(button => button.identifier === 'native-selection-edit' || markIds.includes(button.identifier)), 'No opt-in means no edit or quick-mark control without a consumer')
    await host.request('key', { keyCode: 14 })
    await host.request('key', { keyCode: 15 })
    await delay(40)
    verify(host.completions.length === 9, 'No opt-in means E and R cannot open an editor or complete selection')
    await host.request('key', { keyCode: 53 })
    verify((await host.completion(10)).state === 'cancelled', 'Pure capture retains cancellation after unused edit shortcuts')
    let count = 10
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
      verify(empty.surfaces.filter(surface => surface.hintVisible).length === 1 && empty.surfaces.find(surface => surface.hintVisible).displayId === display.displayId
        && empty.surfaces.every(surface => !surface.toolbarVisible), 'An empty click on another display moves the original hint, without a toolbar, to that event display')
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
    // Inline editing keeps exactly the selected display frozen behind the editor.
    for (const display of ready.screens) {
      await host.request('begin', { allowEditing: true, inlineEditing: true })
      const frame = display.frame
      await globalDrag(display, point(frame.x + frame.width * 0.3, frame.y + frame.height * 0.3), point(frame.x + frame.width * 0.6, frame.y + frame.height * 0.6))
      await host.request('key', { keyCode: 14 })
      const inline = await host.completion(++count)
      const kept = inline.backdropWindows ?? []
      verify(inline.completionAction === 'edit' && typeof inline.backdrop === 'string' && inline.visiblePickerWindows === 0, 'An inline edit returns a backdrop id and no live chooser')
      verify(kept.length === 1 && kept[0].displayId === display.displayId && JSON.stringify(kept[0].frame) === JSON.stringify(display.frame), 'Only the selected display stays as the frozen backdrop')
      verify(kept[0] && kept[0].visibleControls === 0 && !kept[0].acceptsMouse && !kept[0].isKey, 'The backdrop shows no controls, ignores the mouse and gives up key focus')
      const released = await host.request('releaseBackdrop', { backdrop: inline.backdrop })
      verify(released.released === true && released.backdrops.length === 0 && released.backdropCount === 0, 'Releasing the backdrop closes its window')
      const again = await host.request('releaseBackdrop', { backdrop: inline.backdrop })
      verify(again.released === false, 'A released backdrop id is missing on the second release')
    }
    if (ready.screens.length > 1) {
      const [a, b] = ready.screens
      await host.request('begin', { allowEditing: true, inlineEditing: true })
      await globalDrag(a, point(a.frame.x + a.frame.width * 0.5, a.frame.y + a.frame.height * 0.5), point(b.frame.x + b.frame.width * 0.4, b.frame.y + b.frame.height * 0.4))
      await host.request('key', { keyCode: 14 })
      const spanning = await host.completion(++count)
      verify(spanning.completionAction === 'edit' && spanning.backdrop === undefined && (spanning.backdropWindows ?? []).length === 0, 'A selection across displays keeps no backdrop')
    }
    await host.request('begin', { allowEditing: true, inlineEditing: true })
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    await host.request('key', { keyCode: 36 })
    const inlineDirect = await host.completion(++count)
    verify(inlineDirect.completionAction === 'capture' && inlineDirect.backdrop === undefined && (await host.request('inspect')).backdropCount === 0, 'An inline request that captures directly keeps no backdrop')
    await host.request('begin', { allowEditing: true })
    await drag(point(offset.x + 80, offset.y + 180), point(offset.x + 400, offset.y + 370))
    await host.request('key', { keyCode: 14 })
    const plainEdit = await host.completion(++count)
    verify(plainEdit.completionAction === 'edit' && plainEdit.backdrop === undefined, 'An edit without inlineEditing keeps no backdrop')
    const seedQuartz = { x: screen.x + 120, y: 140, width: 260, height: 150 }
    await host.request('begin', { initialRect: seedQuartz })
    const seededView = await host.request('inspect')
    const seededLocal = { x: seedQuartz.x - begin.window.x, y: screen.y + screen.height - seedQuartz.y - seedQuartz.height - begin.window.y, width: seedQuartz.width, height: seedQuartz.height }
    verify(sameRect(seededView.rectangle, { ...seededLocal, x: seededLocal.x + begin.window.x, y: seededLocal.y + begin.window.y }) && seededView.canConfirm && seededView.toolbar.width > 0, 'A host initialRect seeds a resting, confirmable selection in AppKit points')
    await host.request('key', { keyCode: 36 })
    const seededResult = await host.completion(++count)
    verify(seededResult.state === 'confirmed' && sameRect(seededResult.rect, seedQuartz), 'Confirming a seeded selection returns the same Quartz rectangle')
    await host.request('begin')
    await host.request('click', { point: point(offset.x + 50, offset.y + 50), button: 'right' })
    const rightCancel = await host.completion(++count).catch(() => null)
    verify(rightCancel?.state === 'cancelled', 'A right click with no selection cancels the request')
    await host.request('begin')
    await host.request('displayChange')
    const configurationChange = await host.completion(++count)
    verify(configurationChange.state === 'failed' && configurationChange.code === 'display_configuration_changed', 'A display-change notification fails the original request explicitly')
    const loading = await host.request('begin', { allowEditing: true, holdPixels: true })
    verify(loading.surfaces.every(surface => !surface.frozenPixels), 'Pending pixel capture is explicit on every original display')
    const pending = await host.request('inspect')
    verify(pending.loadingPixels && pending.hint.width > 0
      && pending.controls.some(button => button.identifier === 'native-selection-confirm' && !button.enabled), 'Loading explains Esc cancellation and keeps capture disabled')
    await image('loading-cancellable')
    await host.request('key', { keyCode: 53 })
    const loadingCancel = await host.completion(++count).catch(() => null)
    verify(loadingCancel?.state === 'cancelled', 'Escape cancels without waiting for the native pixel producer')
    await host.request('releasePixels')
    await delay(40)
    verify((await host.request('inspect')).surfaces.length === 0 && host.completions.length === count, 'Late frozen pixels never reopen or complete the cancelled chooser again')
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

const state = core[1], view = picker[0]
const mutations = [
  { name: 'display-enumeration', path: view, before: 'for screen in screens {', after: 'for screen in screens.prefix(1) {' },
  { name: 'global-event-coordinates', path: view, before: 'event.window?.convertPoint(toScreen: event.locationInWindow) ?? event.locationInWindow', after: 'event.locationInWindow' },
  { name: 'shared-selection-owner', path: view, before: 'var selection: NativeSelectionState { coordinator.selection }',
    after: 'var selection: NativeSelectionState { NativeSelectionState(bounds: coordinator.selection.bounds) }' },
  { name: 'close-all-displays', path: view, before: 'for window in presentation.windows {', after: 'for window in presentation.windows.prefix(1) {' },
  { name: 'first-display-click', path: view, before: 'override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }', after: 'override func acceptsFirstMouse(for event: NSEvent?) -> Bool { false }' },
  { name: 'move', path: state, before: 'rectangle = translated(original, dx: location.x - anchor.x, dy: location.y - anchor.y)', after: 'rectangle = original' },
  { name: 'nudge', path: state, before: 'self.rectangle = translated(rectangle, dx: dx, dy: dy)', after: 'self.rectangle = rectangle' },
  { name: 'resize', path: state, before: 'right = min(bounds.maxX, max(location.x, left + minimumWidth))', after: 'right = original.maxX' },
  { name: 'panel-bounds', path: state, before: 'x: min(max(preferredOrigin.x, available.minX), available.maxX - width)', after: 'x: preferredOrigin.x' },
  { name: 'capture-lease', path: core[3], before: '        guard !occupied else { lock.unlock(); throw Failure.busy }', after: '        // Test mutant: concurrent ownership is admitted.' },
  { name: 'consumer-lease', path: operationsSource, before: 'return try NativeSelectionCaptureLease.shared.withCapture {', after: 'return try unleasedCapture {' },
  { name: 'release', path: view, before: 'func pointerUp(_ point: NSPoint) { pointerLocation = point; selection.pointerUp(point); refresh() }', after: 'func pointerUp(_ point: NSPoint) { pointerLocation = point; selection.pointerUp(point); refresh(); complete(action: .capture) }' },
  { name: 'escape', path: view, before: 'case 53: cancel()', after: 'case 53: confirm()' },
  { name: 'toolbar', path: view, before: 'confirmButton.action = #selector(confirm)', after: 'confirmButton.action = #selector(cancel)' },
  { name: 'edit-action', path: view, before: 'editButton.action = #selector(edit)', after: 'editButton.action = #selector(confirm)' },
  { name: 'edit-opt-in', path: view, before: 'guard allowEditing else { return }', after: '// Mutant: ignores the original host opt-in.' },
  { name: 'consumer-color-owner', path: operationsSource, before: 'clipboardWrite(["format": .string("text"), "data": .string(hex)])', after: 'clipboardWrite(["format": .string("png"), "data": .string(hex)])' },
  { name: 'compact-toolbar', path: view, before: 'let collapsed = allowEditing && measure(full) > available', after: 'let collapsed = false' },
  { name: 'toolbar-right-aligned', path: view, before: 'var origin = NSPoint(x: rect.maxX - size.width, y: rect.minY - 8 - size.height)', after: 'var origin = NSPoint(x: rect.midX - size.width / 2, y: rect.minY - 8 - size.height)' },
  { name: 'toolbar-while-interacting', path: view, before: 'let toolbarVisible = localRectangle != nil && !selection.isInteracting', after: 'let toolbarVisible = localRectangle != nil' },
  { name: 'loupe-avoids-selection', path: view, before: 'if let selected { occupied.append(selected) }', after: '_ = selected' },
  { name: 'color-copy-worker', path: view, before: 'colorCopyQueue.async { [weak self] in', after: 'DispatchQueue.main.async { [weak self] in' },
  { name: 'color-copy-receipt', path: view, before: 'failure == nil ? "Copied \\(hex)" : "Copy unconfirmed · press C to retry"', after: '"Copied \\(hex)"' },
  { name: 'color-copy-key', path: view, before: 'case 8 where event.modifierFlags.intersection([.command, .control, .option]).isEmpty: copyPointerColor()', after: 'case 8 where event.modifierFlags.intersection([.command, .control, .option]).isEmpty: break' },
  { name: 'mark-button-tool', path: view, before: 'complete(action: .edit, tool: Self.quickMarks[index].tool)', after: 'complete(action: .edit)' },
  { name: 'mark-key-tool', path: view, before: 'if confirmButton.isEnabled { complete(action: .edit, tool: mark.tool) }', after: 'if confirmButton.isEnabled { complete(action: .edit) }' },
  { name: 'mark-key-opt-in', path: view, before: 'if allowEditing, plain, let mark = Self.quickMarks.first', after: 'if plain, let mark = Self.quickMarks.first' },
  { name: 'capture-carries-tool', path: view, before: 'editTool: action == .edit ? tool : nil', after: 'editTool: tool ?? "rect"' },
  { name: 'consumer-capture-tool', path: operationsSource, before: 'if allowEditing, selection.completionAction == .edit, let tool = selection.editTool', after: 'if allowEditing, let tool = selection.editTool' },
  { name: 'double-click-confirm', path: view, before: 'coordinator.confirmFromGesture()', after: 'coordinator.pointerDown(point)' },
  { name: 'right-click-clears', path: view, before: '        selection.clear()\n        refresh()', after: '        refresh()' },
  { name: 'right-click-cancels-empty', path: view, before: 'guard let rect = selection.rectangle else { cancel(); return }', after: 'guard let rect = selection.rectangle else { return }' },
  { name: 'seed-flip', path: view, before: 'coordinator.seed(NativeCaptureGeometry.quartzRect(appKitRect: initialRect, primaryDisplayTop: primary.frame.maxY))', after: 'coordinator.seed(initialRect)' },
  { name: 'seed-clamps', path: state, before: 'let clipped = rect.standardized.intersection(bounds)', after: 'let clipped = rect.standardized' },
  { name: 'consumer-seed-forwarded', path: operationsSource, before: 'NativeSelectionRequest.run(allowEditing: allowEditing, initialRect: initialRect,', after: 'NativeSelectionRequest.run(allowEditing: allowEditing, initialRect: nil,' },
  { name: 'consumer-seed-on-display', path: operationsSource, before: 'guard activeDisplayBounds().contains(where: { $0.intersects(rect) }) else {', after: 'guard true else {' },
  { name: 'backdrop-kept', path: view, before: 'let display = holding.count == 1 ? holding[0] : nil', after: 'let display: NSRect? = nil' },
  { name: 'backdrop-spanning', path: view, before: 'let display = holding.count == 1 ? holding[0] : nil', after: 'let display = holding.first ?? (action == .edit && inlineEditing ? screenFrames.first : nil)' },
  { name: 'backdrop-closes-others', path: view, before: '            window.orderOut(nil)\n            window.close()\n        }\n        return kept', after: '        }\n        return kept' },
  { name: 'backdrop-passive', path: view, before: 'window.ignoresMouseEvents = true', after: 'window.ignoresMouseEvents = false' },
  { name: 'backdrop-quiet', path: view, before: 'for subview in subviews { subview.isHidden = true }', after: '_ = subviews' },
  { name: 'backdrop-release', path: view, before: 'guard let window = backdrops.removeValue(forKey: id) else { return false }\n        window.orderOut(nil)', after: 'guard let window = backdrops[id] else { return false }\n        window.orderOut(nil)' },
  { name: 'backdrop-direct-capture', path: view, before: 'let holding = action == .edit && inlineEditing ?', after: 'let holding = inlineEditing ?' },
  { name: 'consumer-backdrop-owner', path: operationsSource, before: 'NativeSelectionBackdrops.adopt(backdrop, owner: owner)', after: 'NativeSelectionBackdrops.adopt(backdrop, owner: nil)' },
  { name: 'consumer-inline-opt-in', path: operationsSource, before: '(inline.bool == true && params["allowEditing"]?.bool != true)', after: 'false' },
  { name: 'consumer-edit-intent', path: operationsSource, before: 'if allowEditing { result["completionAction"] = selection.completionAction.rawValue }', after: 'if allowEditing { result["completionAction"] = "capture" }' },
  { name: 'dimensions-toolbar', path: view, before: 'selection: rect, toolbar: toolbarFrame, screen: screen)', after: 'selection: rect, toolbar: .zero, screen: screen)' },
  { name: 'frozen-completion-source', path: operationsSource, before: 'do { return try selection.pixels.compose(selection.rectangle) }', after: 'do { return try captureRect(selection.rectangle, ownership: ownership) }' },
  { name: 'sample-vertical-source', path: picker[2], before: '(display.appKitFrame.maxY - point.y)', after: '(point.y - display.appKitFrame.minY)' },
  { name: 'composite-crop-origin', path: picker[2], before: '(frame.minX - rectangle.minX) * geometry.scale', after: 'frame.minX * geometry.scale' },
  { name: 'loading-cancel', path: view, before: '@objc fileprivate func cancel() { finish(.success(nil)) }', after: '@objc fileprivate func cancel() { if pixels != nil { finish(.success(nil)) } }' },
]

try {
  const baseline = build(output)
  report.stateChecks = checks(baseline)
  assert.equal(report.stateChecks.exitCode, 0)
  assert.equal(report.stateChecks.failures.length, 0)
  if (modelsOnly) {
    report.modelMutations = []
    const selected = mutations.filter(mutation => core.includes(mutation.path) || mutation.path === operationsSource || mutation.path === picker[2])
    assert(selected.length > 0, 'The production model mutation selection is nonempty')
    for (const mutation of selected) {
      const directory = build(join(output, 'model-mutant-' + mutation.name), mutation)
      const result = checks(directory)
      assert(result.tests > 0 && result.failures.length > 0 && result.exitCode !== 0, 'Surviving production model mutation: ' + mutation.name)
      report.modelMutations.push({ name: mutation.name, state: 'killed-by-source-assertion', tests: result.tests, failures: result.failures })
    }
    report.unverifiedMutations = mutations.filter(mutation => !selected.includes(mutation)).map(mutation => mutation.name)
    report.state = 'model-source-passed-ui-unverified'
    report.unverified = ['AppKit host launch and interactions', 'current candidate images and independent review', 'physical WindowServer/input, TCC and installed application']
  } else if (preview) {
    const child = spawn(join(baseline, 'selection-preview'), ['--interactive'], { stdio: 'inherit' })
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)) })
    assert.equal(result, 0)
    report.state = 'preview-closed'
  } else {
    report.appKit = await exercise(baseline, true)
    report.nativeFrames = 'not-verified'
    report.viewLayoutFrames = report.appKit.images.length > 0 && report.appKit.images.every(image => image.source === 'AppKit-view-layout-only') ? 'exported-awaiting-independent-review' : 'incomplete'
    report.unverified = ['WindowServer fullscreen/layering', 'system foreground/focus and physical event delivery', 'screen capture permissions and installed application', 'physical mixed-scale displays and final system PNG']
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
if (!process.exitCode) assert.deepEqual(Object.fromEntries(sources.map(path => [path.slice(repository.length + 1), createHash('sha256').update(readFileSync(path)).digest('hex')])), hashes, 'The candidate source changed during verification')
writeFileSync(join(output, 'receipt.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ state: report.state, receipt: join(output, 'receipt.json'),
  tests: report.stateChecks?.tests, mutations: report.mutations?.length ?? report.modelMutations?.length, images: report.appKit?.images?.map(image => image.path), error: report.error?.message }))
