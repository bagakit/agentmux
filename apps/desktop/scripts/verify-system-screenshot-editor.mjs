import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

assert.equal(process.argv.length, 2, 'This bounded verification has no optional skipped slices')
const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const source = 'apps/desktop/src/main/system-screenshot-editor.ts', surface = 'apps/desktop/src/main/capture-surface.ts', producer = 'apps/desktop/src/main/screen-capture.ts'
const view = 'apps/desktop/src/renderer/screenshot-editor/CaptureSurfaceView.tsx', editor = 'apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx'
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries(await Promise.all([source, surface, producer, view, editor].map(async file => [file, await readFile(file, 'utf8')])))
const owningTests = { [source]: 'apps/desktop/test/system-screenshot-editor.test.ts', [surface]: 'apps/desktop/test/capture-surface.test.ts',
  [producer]: 'apps/desktop/test/global-screenshot-integration.test.ts', [view]: 'apps/desktop/test/capture-surface-view.test.tsx', [editor]: 'apps/desktop/test/capture-surface-view.test.tsx' }
const mutations = [
  { id: 'switch-reply-unlocks-old-frame', source: view, from: 'if (requestedBackground.current !== next) setSwitching(false)', to: 'setSwitching(false)', expected: 'a switch reply does not unlock old-frame output while the announced background still decodes' },
  {"source": "apps/desktop/src/renderer/screenshot-editor/CaptureSurfaceView.tsx", "from": "      if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return", "to": "      if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing) return", "id": "background-renderer-1", "expected": "modified Tab and text-editing Tab keep their original focus navigation"},
  {"source": "apps/desktop/src/renderer/screenshot-editor/CaptureSurfaceView.tsx", "from": "      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])')) return", "to": "      void target", "id": "background-renderer-2", "expected": "modified Tab and text-editing Tab keep their original focus navigation"},
  {"source": "apps/desktop/src/renderer/screenshot-editor/CaptureSurfaceView.tsx", "from": "    pending.current = true; setSwitching(true)", "to": "    setSwitching(true)", "id": "background-renderer-3", "expected": "plain Tab predecodes one explicit target, ignores rapid repeats and follows the Main-announced background"},
  {"source": "apps/desktop/src/renderer/screenshot-editor/CaptureSurfaceView.tsx", "from": "      await api.switchBackground(input.requestId, next)", "to": "      await api.switchBackground(input.requestId, 'included')", "id": "background-renderer-4", "expected": "plain Tab predecodes one explicit target, ignores rapid repeats and follows the Main-announced background"},
  {"source": "apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx", "from": "sourcePixelsRef.current = null; litWindowRef.current = null; setHover(null)", "to": "sourcePixelsRef.current = null; setHover(null)", "id": "background-renderer-5", "expected": "switching sources drops the old window highlight and sampled RGB without another pointer move"},
  {"source": "apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx", "from": "sourcePixelsRef.current = null; litWindowRef.current = null; setHover(null)", "to": "sourcePixelsRef.current = null; litWindowRef.current = null", "id": "background-renderer-6", "expected": "switching sources drops the old window highlight and sampled RGB without another pointer move"},
  { id: 'background-selected-mode', source: surface, from: 'active.background = next', to: 'void next', expected: 'the selected display switches only to the named' },
  { id: 'background-no-recapture', source: surface, from: 'active.background = next', to: 'await this.ports.native().captureDisplays(); active.background = next', expected: 'the selected display switches only to the named' },
  { id: 'background-output-stays-bound', source: surface, from: "if (active.finishing) { send(overlay, { kind: 'notice', message: 'The current screenshot output", to: "if (false) { send(overlay, { kind: 'notice', message: 'The current screenshot output", expected: 'an in-flight primary output keeps its original background' },
  { id: 'background-missing-target-keeps-current', source: surface, from: "if (target.status === 'failed') { send(overlay, { kind: 'notice', message: target.issue }); return }", to: 'void 0', expected: 'a missing target background keeps the selected display finishable' },
  { id: 'surface-renderer-frozen-source', source: view, from: 'const frame = backgrounds[background]', to: 'const frame = backgrounds.included', expected: 'the excluded background supplies the frozen source' },
  { id: 'surface-renderer-output-background', source: view, from: 'api.savePng(input.requestId, background, image, selection)', to: "api.savePng(input.requestId, 'included', image, selection)", expected: 'the excluded background supplies the frozen source' },
  { id: 'surface-renderer-presented-loaded', source: editor, from: 'if (state.loaded && presentedSource.current !== image.dataUrl)', to: 'if (presentedSource.current !== image.dataUrl)', expected: 'reports the frame only after the shared editor loads and paints it' },
  // The per-overlay join independently rejects absent frames; this branch must report layout failure, never silent cancellation.
  {"id": "surface-display-set", "source": "apps/desktop/src/main/capture-surface.ts", "from": "    if (result.displays.length !== displays.length || active.overlays.length !== displays.length || new Set(result.displays.map(frame => frame.displayId)).size !== displays.length) layoutChanged()", "to": "    if (result.displays.length !== displays.length || active.overlays.length !== displays.length || new Set(result.displays.map(frame => frame.displayId)).size !== displays.length) { active.end({ state: 'cancelled' }); return }", "expected": "rejects a missing display"},
  { id: 'surface-current-scale', source: surface, from: ' || display.scaleFactor !== frame.scale', to: '', expected: 'rejects a scale display' },
  { id: 'surface-issue-cannot-retarget-owner', source: surface, from: 'if (active.owner !== null && active.owner !== frameInput.displayId)', to: 'if (false)', expected: 'a locked issue display cannot replace' },
  { id: 'surface-save-png-skips-selection', source: surface, from: "    const source = this.source(active, frameInput, params.selection)\n    if (action === 'save-png')", to: "    if (action === 'save-png') return await saveScreenshotPng(params.image!, overlay.window, { capturedAt: captured.capturedAt })\n    const source = this.source(active, frameInput, params.selection)\n    if (false)", expected: 'save-png rejects a missing or invalid selection before any output' },
  { id: 'surface-public-included-fallback', source: surface, from: 'active.session.allowBackgroundFallback === false && !usable(first)', to: 'false && !usable(first)', expected: 'a public selection whose excluded exposure is unavailable fails instead of offering included pixels' },
  { id: 'surface-public-background-switch', source: surface, from: 'active.session.allowBackgroundFallback === false && next !== active.background', to: 'false && next !== active.background', expected: 'a public selection refuses an included background switch' },
  { id: 'surface-included-host-geometry', source: surface, from: 'const firstPending = this.freeze(active, firstMode)', to: "const firstPending = this.freeze(active, 'excluded')", expected: 'keeps every host at its exact prior opacity' },
  { id: 'surface-excluded-exposure', source: surface, from: 'const needsSecond = active.visibleHosts > 0', to: 'const needsSecond = false', expected: 'keeps every host at its exact prior opacity' },
  { id: 'surface-default-background', source: surface, from: "background: session.background ?? 'included'", to: "background: session.background ?? 'excluded'", expected: 'captures every display once and opens one transparent overlay' },
  { id: 'surface-frame-bound-output', source: surface, from: 'if (params.background !== active.background) throw', to: 'if (false) throw', expected: 'the chosen initial background delivers its own pixels' },
  { id: 'surface-frame-timestamp', source: surface, from: 'const { image, capturedAt } = captured', to: 'const { image, capturedAt } = input.backgrounds.included', expected: 'the chosen initial background delivers its own pixels' },
  { id: 'surface-frame-engine', source: surface, from: 'source, captured.engine)', to: 'source, overlay.input.backgrounds.included.engine!)', expected: 'the chosen initial background delivers its own pixels' },
  { id: 'surface-healthy-alternate', source: surface, from: "if (first instanceof Error && second instanceof Error) throw first", to: "if (first instanceof Error || second instanceof Error) throw first", expected: 'a failed requested exposure preserves the original mode' },
  { id: 'exact-window', from: 'const request = this.requests.get(event.sender)', to: 'const request = this.requests.values().next().value', expected: 'rejects another window and an embedded frame' },
  { id: 'original-request', from: 'params?.requestId !== request.input.requestId', to: 'false', expected: 'refuses stale request identities' },
  { id: 'failed-delivery-retains-editor', from: "    } catch (error) {\n      return { status: 'failed', message: message(error) }", to: "    } catch (error) {\n      request.window.close(); return { status: 'failed', message: message(error) }", expected: 'keeps the original editor after a failed delivery' },
  // Retake: only for a region capture, the same editor back on cancel, closed once the new capture takes over, kept on failure.
  { id: 'retake-without-region', from: "      if (!request.retake) throw new Error('This image did not come from a region capture", to: "      if (false) throw new Error('This image did not come from a region capture", expected: 'a failed retake keeps it' },
  { id: 'retake-cancel-closes', from: "      if (state === 'cancelled') return { status: 'cancelled' } satisfies SystemScreenshotEditorRetake", to: "      if (state === 'cancelled') { request.window.close(); return { status: 'cancelled' } satisfies SystemScreenshotEditorRetake }", expected: 'Retake keeps the same editor on a cancelled capture' },
  { id: 'retake-completion-keeps', from: '      if (!request.window.isDestroyed()) request.window.close()\n      return { status: \'completed\' } satisfies SystemScreenshotEditorRetake', to: "      return { status: 'completed' } satisfies SystemScreenshotEditorRetake", expected: 'closes it once the new capture takes over' },
  { id: 'retake-expanded-keeps', from: "      if (state === 'cancelled') return", to: "      if (state !== 'completed') return", expected: 'a retake that moves into a new window editor closes this one' },
  { id: 'retake-failure-closes', from: "      catch (error) { return { status: 'failed', message: message(error) } satisfies SystemScreenshotEditorRetake }", to: "      catch (error) { request.window.close(); return { status: 'failed', message: message(error) } satisfies SystemScreenshotEditorRetake }", expected: 'a failed retake keeps it' },
  { id: 'retake-not-offered', from: "...(retake ? { retakable: true } : {})", to: '...{}', expected: 'Retake keeps the same editor on a cancelled capture' },
  // The retake's consumer: the same delivery and draft, the next editor, and focus back to the editor that asked.
  { id: 'retake-same-draft', source: producer, from: 'const attaching = attachToDraft && !originalDelivered', to: 'const attaching = attachToDraft && !originalDelivered && !retaking', expected: 'Retake from the window editor captures again for the same draft' },
  { id: 'retake-attaches-delivered-draft', source: producer, from: 'const attaching = attachToDraft && !originalDelivered', to: 'const attaching = attachToDraft', expected: 'a retake after the editor already copied keeps the same consumer' },
  { id: 'retake-editor-delivery-forgotten', source: producer, from: 'complete(final).then(() => { continuation = outcome.delivered() })', to: 'complete(final)', expected: 'Copy in the window editor supplies only the same capture Retake continuation' },
  { id: 'surface-editor-continuation-wrong', source: surface, from: 'continuation = this.continuation(frameInput, source.rect)', to: 'continuation = this.continuation(frameInput, { ...source.rect, x: source.rect.x + 1 })', expected: 'an expanded editor delivery returns a pure continuation' },
  { id: 'retake-focus-leaves-editor', source: producer, from: 'returnFocus: returnFocus && !retaking, complete, background,', to: 'returnFocus, complete, background,', expected: 'gives focus back to that editor' },
  { id: 'retake-editor-not-retakable', source: producer, from: '...(returnFocus ? { returnFocus } : {}), retake: () => surface(true) })', to: '...(returnFocus ? { returnFocus } : {}), ...(retaking ? {} : { retake: () => surface(true) }) })', expected: 'a retake that expands again replaces the old editor' },
  { id: 'retake-capture-ends-early', source: producer, from: '        for (let current = held.editor; current; current = held.editor === current ? null : held.editor) await current', to: '        if (held.editor) await held.editor', expected: 'a retake that expands again replaces the old editor' },
  { id: 'original-operation-receipt', from: 'if (existing) return await existing', to: 'if (false) return await existing', expected: 'returns the original completion receipt for duplicate operation IDs' },
  { id: 'late-delivery-isolation', from: 'request.settle()\n      return', to: 'for (const current of this.requests.values()) current.window.close()\n      request.settle()\n      return', expected: 'an earlier late result never closes the newer editor' },
  { id: 'validated-output-png', from: '    pngBytes(params.image!)\n    request.pending = true', to: '    void params.image\n    request.pending = true', expected: 'refuses stale request identities' },
  // The capture surface: one grab, one overlay per display, shown together, one selection owner, and its outputs.
  { id: 'surface-one-grab', source: surface, from: "const result = await this.ports.native().captureDisplays({ includeHostWindows: mode === 'included' })", to: "const result = await this.ports.native().captureDisplays({ includeHostWindows: mode === 'included' }).then(async value => { await this.ports.native().captureDisplays({ includeHostWindows: mode === 'included' }); return value })", expected: 'captures every display once and opens one transparent overlay' },
  { id: 'surface-transparent-overlay', source: surface, from: "transparent: true, backgroundColor: '#00000000'", to: "transparent: false, backgroundColor: '#00000000'", expected: 'captures every display once and opens one transparent overlay' },
  { id: 'surface-raised-after-paint', source: surface, from: "window.once('ready-to-show', () => raise(window, display.bounds))", to: 'void 0', expected: 'captures every display once and opens one transparent overlay' },
  { id: 'surface-show-together', source: surface, from: 'if (active.overlays.every(row => row.presented)) this.show(active)', to: 'this.show(active)', expected: 'shows every overlay together only after each one presented' },
  { id: 'surface-focus-under-pointer', source: surface, from: 'const target = active.overlays.find(overlay => overlay.display.id === pointer) ?? active.overlays[0]', to: 'const target = active.overlays[0]', expected: 'shows every overlay together only after each one presented' },
  { id: 'surface-present-fallback', source: surface, from: 'active.fallback = setTimeout(() => this.show(active), PRESENT_FALLBACK_MS)', to: 'void 0', expected: 'shows the overlays after the fallback' },
  { id: 'surface-locks-others', source: surface, from: "for (const other of active.overlays) if (other !== overlay) send(other, { kind: 'locked' })", to: 'void 0', expected: 'the first display to select owns the selection' },
  { id: 'surface-single-owner', source: surface, from: '(active.owner !== null && active.owner !== frameInput.displayId)) return false', to: 'false) return false', expected: 'the first display to select owns the selection' },
  { id: 'surface-global-selection', source: surface, from: 'x: frame.x + selection.x / scale', to: 'x: selection.x / scale', expected: 'keeps its negative global origin' },
  { id: 'surface-primary-closes', source: surface, from: "    active.end({ state: 'completed' })\n    return { status: 'completed' }", to: "    return { status: 'completed' }", expected: 'primary delivery runs the session delivery once' },
  { id: 'surface-failed-primary-keeps', source: surface, from: "catch (error) { return { status: 'failed', message: message(error) } satisfies SystemScreenshotEditorFinish }", to: "catch (error) { active.end({ state: 'cancelled' }); return { status: 'failed', message: message(error) } satisfies SystemScreenshotEditorFinish }", expected: 'a failed primary delivery keeps every overlay' },
  { id: 'surface-pin-at-selection', source: surface, from: '{ ...source.rect, width: params.image!.width / source.scale', to: '{ ...source.rect, x: 0, width: params.image!.width / source.scale', expected: 'a confirmed Pin opens on the selection' },
  { id: 'surface-pin-closes', source: surface, from: "if (pinned.recordedOperation?.state === 'completed') active.end({ state: 'completed' })", to: 'void pinned', expected: 'a confirmed Pin opens on the selection and closes the capture surface' },
  { id: 'surface-unconfirmed-pin-keeps', source: surface, from: "if (pinned.recordedOperation?.state === 'completed') active.end", to: 'active.end', expected: 'Save PNG and an unconfirmed Pin act on the selection and keep the overlays' },
  { id: 'surface-expand-carries-marks', source: surface, from: "active.end({ state: 'expanded', image: captured.image, source, handoff, delivered:", to: "active.end({ state: 'expanded', image: captured.image, source, handoff: { ...handoff, shapes: [] }, delivered:", expected: 'expand ends the surface with the full frozen frame' },
  { id: 'surface-issue-not-selectable', source: surface, from: "if (frameInput.backgrounds[active.background].status !== 'ready' || (", to: 'if ((', expected: 'a display without pixels shows its issue' },
  { id: 'surface-work-area-keeps', source: surface, from: "metrics.some(metric => metric !== 'workArea')", to: 'true', expected: 'a display layout change ends the capture, while a work area change keeps it' },
  { id: 'surface-crash-ends', source: surface, from: "window.webContents.once('render-process-gone',", to: "window.webContents.once('render-process-gone-unused',", expected: 'a crashed overlay renderer ends the capture' },
  { id: 'surface-content-protection', source: surface, from: 'window.setContentProtection(true)', to: 'void 0', expected: 'protects every overlay before its renderer loads' },
  { id: 'surface-timing-line', source: surface, from: "console.info('capture-surface timing '", to: "void ('capture-surface timing '", expected: 'logs one timing line from present()' },
  { id: 'surface-timing-presented', source: surface, from: 'overlay.presentedMs ??= since(active.startedAt)', to: 'void 0', expected: 'logs one timing line from present()' },
  { id: 'surface-return-focus', source: surface, from: '          if (session.returnFocus) this.ports.returnFocus()', to: '          if (session.returnFocus) void 0', expected: 'returns focus to the previous app once' },
  { id: 'surface-exact-sender', source: surface, from: 'event.senderFrame !== overlay.window.webContents.mainFrame', to: 'false', expected: 'refuses another window, an embedded frame and a stale request' },
  { id: 'surface-one-at-a-time', source: surface, from: "    if (this.active) return Promise.reject(new Error('A screen capture is already in progress.", to: "    if (false) return Promise.reject(new Error('A screen capture is already in progress.", expected: 'a second capture while one is open is refused' },
  { id: 'surface-public-captured', source: surface, from: "return outcome.state === 'completed' && result ? result : { state: 'cancelled' }", to: "return { state: 'cancelled' }", expected: 'the public selection returns the processed selection as captured' },
  // Empty selections have no implicit full-display output; only an explicit same-capture continuation restores a crop.
  { id: 'surface-empty-crop-full-display', source: view, from: 'const selection = edit.crop', to: 'const selection = edit.crop ?? { x: 0, y: 0, width: edit.displayWidth, height: edit.displayHeight }', expected: 'an empty selection produces no claim' },
  { id: 'surface-continuation-keys-under-pointer', source: surface, from: 'const keys = active.overlays.find(overlay => overlay.input?.initialCrop) ?? target', to: 'const keys = target', expected: 'an expanded editor delivery returns a pure continuation' },
  { id: 'surface-public-failed-code', source: surface, from: "code: typeof code === 'string' && code ? code : 'capture_failed'", to: "code: 'capture_failed'", expected: 'the public selection reports a failed native grab as failed with its code' }
]
await mkdir(resolve('.local/system-screenshot-editor'), { recursive: true })
const out = await mkdtemp(resolve('.local/system-screenshot-editor/run-'))
const inputs = [source, surface, 'apps/desktop/src/shared/capture-surface.ts', 'apps/desktop/test/capture-surface.test.ts', 'apps/desktop/test/capture-surface-view.test.tsx',
  'apps/desktop/src/preload/capture-surface.ts', view, 'apps/desktop/src/shared/system-screenshot-editor.ts', 'apps/desktop/src/preload/screenshot-editor.ts',
  'apps/desktop/src/renderer/screenshot-editor/entry.tsx', 'apps/desktop/src/renderer/screenshot-editor/SystemScreenshotEditorView.tsx',
  'apps/desktop/src/renderer/screenshot-editor/screenshot-editor.css', 'apps/desktop/src/renderer/src/components/image-annotation/compose.ts',
  editor, 'apps/desktop/src/renderer/src/components/image-annotation/image-annotation.css',
  'apps/desktop/src/renderer/src/components/image-annotation/AnnotationToolbar.tsx', 'apps/desktop/test/system-screenshot-editor.test.ts',
  ...['drawing-model.ts', 'drawing-renderer.ts', 'geometry.ts', 'selection-geometry.ts', 'view.ts', 'canvas-render.ts', 'AnnotationNotes.tsx', 'AnnotationOriginalMenu.tsx', 'types.ts']
    .map(name => 'apps/desktop/src/renderer/src/components/image-annotation/' + name),
  'apps/desktop/test/global-screenshot-integration.test.ts', 'apps/desktop/src/main/global-screenshot.ts',
  'apps/desktop/src/renderer/src/components/RovingToolbar.tsx', 'apps/desktop/src/main/theme-bootstrap.ts', 'packages/native-desktop/src/image.ts',
  'apps/desktop/test/browser-screenshot-compose.test.ts', 'apps/desktop/test/browser-screenshot-context.test.ts',
  'apps/desktop/test/system-screenshot-editor.config.mts', 'apps/desktop/scripts/fixtures/system-screenshot-editor/main.ts',
  'apps/desktop/scripts/fixtures/system-screenshot-editor/scenario.md', 'apps/desktop/scripts/fixtures/system-screenshot-editor/verify-native.mjs', 'apps/desktop/scripts/verify-system-screenshot-editor.mjs',
  'packages/client-ui/src/theme/runtime.ts', 'apps/desktop/electron.vite.config.ts',
  'apps/desktop/src/main/screen-capture.ts', 'apps/desktop/src/main/pasted-image-write.ts', 'apps/desktop/src/main/screenshot-original-files.ts', 'apps/desktop/src/main/screenshot-files.ts', 'apps/desktop/src/main/screenshot-pins.ts',
  'apps/desktop/src/renderer/screenshot-editor/use-system-screenshot-original.ts', 'apps/desktop/src/renderer/src/styles/context-menu.css',
  'apps/desktop/src/renderer/src/styles/chrome.css', 'apps/desktop/src/renderer/src/lib/use-screenshot-pin.ts', 'apps/desktop/src/renderer/src/styles/base.css']
const hashes = Object.fromEntries(await Promise.all(inputs.map(async file => [file, sha(await readFile(file))])))
const receipt = { schema: 'agentmux.system-screenshot-editor-proof.v1', passed: false, sharedTreeMutations: 0, inputs: hashes, runs: [], native: null }
async function command(label, program, args, env = {}, budgetMs = 45000) {
  const result = await new Promise((done, reject) => {
    const childEnv = { ...process.env, ...env }
    if (program === require('electron')) delete childEnv.ELECTRON_RUN_AS_NODE
    const child = spawn(program, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timeout = false, terminateTimer
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; if (label === 'native') process.stdout.write(bytes) })
    const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM'); terminateTimer = setTimeout(() => child.kill('SIGKILL'), 3000) }, budgetMs)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(terminateTimer); done({ code, signal, log, timeout }) })
  })
  await writeFile(join(out, label + '.log'), result.log)
  await writeFile(join(out, label + '.process.json'), JSON.stringify({ code: result.code, signal: result.signal, timeout: result.timeout }))
  assert.equal(result.timeout, false, label + ': timed-out infrastructure is not a behavior result')
  assert.equal(result.signal, null, label + ': process termination is not behavior proof')
  return result
}
async function test(label, mutation) {
  const loaded = join(out, label + '.loaded.ndjson'), json = join(out, label + '.tests.json')
  const owner = mutation?.source ?? source
  assert.ok(owningTests[owner], label + ': every mutation has an owning consumer')
  const selected = mutation ? [owningTests[owner]] : []
  const result = await command(label, process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', ...selected, '--config', 'apps/desktop/test/system-screenshot-editor.config.mts',
    '--reporter=json', '--outputFile=' + json], { AGENTMUX_SCREENSHOT_EDITOR_LOADED: loaded,
      AGENTMUX_SCREENSHOT_EDITOR_MUTATION: mutation ? JSON.stringify(mutation) : '' }, mutation ? 45000 : 120000)
  const report = JSON.parse(await readFile(json, 'utf8')), assertions = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length >= 7 && assertions.every(row => ['passed', 'failed'].includes(row.status)), label + ': nonempty executed original tests required')
  for (const file of report.testResults) assert.equal(file.message, '', label + ': collection failures do not prove a behavior mutation')
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  const consumed = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const mutated = consumed.filter(row => row.file === owner)
  assert.ok(mutated.length > 0 && consumed.every(row => row.original === sha(sources[row.file]) && (row.file === owner && mutation
    ? row.consumed === sha(sources[owner].replace(mutation.from, mutation.to)) && row.mutation === mutation.id : row.consumed === row.original && row.mutation === null)), label + ': actual production source must consume this exact candidate')
  if (mutation) {
    assert.notEqual(result.code, 0, 'Production mutation survived: ' + label)
    const owner = assertions.find(row => row.fullName.includes(mutation.expected))
    assert.equal(owner?.status, 'failed', label + ': owning behavioral consumer must fail')
    assert.match(owner.failureMessages.join('\n'), /AssertionError|promise resolved|promise rejected/)
  } else {
    assert.equal(result.code, 0, result.log)
    assert.ok(assertions.every(row => row.status === 'passed'))
    for (const file of Object.keys(sources)) assert.ok(consumed.some(row => row.file === file), label + ': every production owner must be loaded: ' + file)
  }
  receipt.runs.push({ label, code: result.code, assertions: assertions.length, loaded: consumed })
  process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
}
try {
  assert.ok(mutations.length > 0)
  for (const mutation of mutations) assert.equal(sources[mutation.source ?? source].split(mutation.from).length, 2, 'Unique production mutation: ' + mutation.id)
  await test('baseline')
  for (const mutation of mutations) await test(mutation.id, mutation)
  const phase = await command('native-stage', process.execPath, [resolve('apps/desktop/scripts/fixtures/system-screenshot-editor/verify-native.mjs'), out], {}, 240000)
  assert.equal(phase.code, 0, phase.log)
  const native = JSON.parse(await readFile(join(out, 'native-stage-receipt.json'), 'utf8'))
  assert.equal(native.passed, true)
  receipt.native = native.native
  receipt.nativeCaptureMutation = native.nativeCaptureMutation
  for (const [file, hash] of Object.entries(hashes)) assert.equal(sha(await readFile(file)), hash, 'Candidate changed during proof: ' + file)
  // Reuse already executed exact-source slice proofs; source drift makes them ineligible.
  async function consumeProof(directory, schema) {
    for (const name of (await readdir(directory)).sort().reverse()) {
      const file = join(directory, name, 'receipt.json')
      let proof
      try { proof = JSON.parse(await readFile(file, 'utf8')) } catch { continue }
      if (!proof.passed || proof.schema !== schema || !Object.keys(proof.inputs ?? {}).length) continue
      let matches = true
      for (const [input, digest] of Object.entries(proof.inputs)) {
        try { if (sha(await readFile(input)) !== digest) matches = false } catch { matches = false }
      }
      if (matches) return { file, inputs: proof.inputs, reused: true }
    }
    throw new Error('No passing exact-source proof in ' + directory + '; run its owning verifier before this gate.')
  }
  receipt.captureSurface = await consumeProof(resolve('.local/capture-surface'), 'agentmux.capture-surface-product-proof.v1')
  receipt.publicSelection = await consumeProof(resolve('.local/capture-public-selection'), 'agentmux.capture-public-selection-proof.v1')
  receipt.shortcuts = await consumeProof(resolve('.local/state/screenshot-experience/shortcut'), 'agentmux.screenshot-shortcut-proof.v1')
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, mutations: mutations.length, receipt: join(out, 'receipt.json'), screenshots: receipt.native.screenshots }) + '\n')
