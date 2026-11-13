import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

assert.equal(process.argv.length, 2, 'This bounded verification has no optional skipped slices')
const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const source = 'apps/desktop/src/main/system-screenshot-editor.ts', surface = 'apps/desktop/src/main/capture-surface.ts', producer = 'apps/desktop/src/main/screen-capture.ts'
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = { [source]: await readFile(source, 'utf8'), [surface]: await readFile(surface, 'utf8'), [producer]: await readFile(producer, 'utf8') }
const mutations = [
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
  { id: 'retake-editor-delivery-forgotten', source: producer, from: 'complete(final).then(() => outcome.delivered())', to: 'complete(final)', expected: 'the selection the window editor delivers is where the next capture opens' },
  { id: 'surface-editor-delivery-forgotten', source: surface, from: 'delivered: () => { this.recall = remembered } })', to: 'delivered: () => {} })', expected: 'a window editor delivery is the selection the next capture opens on' },
  { id: 'retake-focus-leaves-editor', source: producer, from: 'returnFocus: returnFocus && !retaking, complete })', to: 'returnFocus, complete })', expected: 'gives focus back to that editor' },
  { id: 'retake-editor-not-retakable', source: producer, from: '...(returnFocus ? { returnFocus } : {}), retake: () => surface(true) })', to: '...(returnFocus ? { returnFocus } : {}), ...(retaking ? {} : { retake: () => surface(true) }) })', expected: 'a retake that expands again replaces the old editor' },
  { id: 'retake-capture-ends-early', source: producer, from: '        for (let current = held.editor; current; current = held.editor === current ? null : held.editor) await current', to: '        if (held.editor) await held.editor', expected: 'a retake that expands again replaces the old editor' },
  { id: 'original-operation-receipt', from: 'if (existing) return await existing', to: 'if (false) return await existing', expected: 'returns the original completion receipt for duplicate operation IDs' },
  { id: 'late-delivery-isolation', from: 'request.settle()\n      return', to: 'for (const current of this.requests.values()) current.window.close()\n      request.settle()\n      return', expected: 'an earlier late result never closes the newer editor' },
  { id: 'validated-output-png', from: '    pngBytes(params.image!)\n    request.pending = true', to: '    void params.image\n    request.pending = true', expected: 'refuses stale request identities' },
  // The capture surface: one grab, one overlay per display, shown together, one selection owner, and its outputs.
  { id: 'surface-one-grab', source: surface, from: 'const frames = await this.ports.native().captureDisplays()', to: 'await this.ports.native().captureDisplays(); const frames = await this.ports.native().captureDisplays()', expected: 'captures every display once and opens one transparent overlay' },
  { id: 'surface-transparent-overlay', source: surface, from: "transparent: true, backgroundColor: '#00000000'", to: "transparent: false, backgroundColor: '#00000000'", expected: 'captures every display once and opens one transparent overlay' },
  { id: 'surface-raised-after-paint', source: surface, from: "window.once('ready-to-show', () => raise(window, frame.frame))", to: 'void 0', expected: 'captures every display once and opens one transparent overlay' },
  { id: 'surface-show-together', source: surface, from: 'if (active.overlays.every(row => row.presented)) this.show(active)', to: 'this.show(active)', expected: 'shows every overlay together only after each one presented' },
  { id: 'surface-focus-under-pointer', source: surface, from: 'const target = active.overlays.find(overlay => overlay.input.displayId === pointer) ?? active.overlays[0]', to: 'const target = active.overlays[0]', expected: 'shows every overlay together only after each one presented' },
  { id: 'surface-present-fallback', source: surface, from: 'active.fallback = setTimeout(() => this.show(active), PRESENT_FALLBACK_MS)', to: 'void 0', expected: 'shows the overlays after the fallback' },
  { id: 'surface-locks-others', source: surface, from: "for (const other of active.overlays) if (other !== overlay) send(other, { kind: 'locked' })", to: 'void 0', expected: 'the first display to select owns the selection' },
  { id: 'surface-single-owner', source: surface, from: '(active.owner !== null && active.owner !== overlay.input.displayId)) return false', to: 'false) return false', expected: 'the first display to select owns the selection' },
  { id: 'surface-global-selection', source: surface, from: 'x: frame.x + selection.x / scale', to: 'x: selection.x / scale', expected: 'keeps its negative global origin' },
  { id: 'surface-primary-closes', source: surface, from: "    active.end({ state: 'completed' })\n    return { status: 'completed' }", to: "    return { status: 'completed' }", expected: 'primary delivery runs the session delivery once' },
  { id: 'surface-failed-primary-keeps', source: surface, from: "catch (error) { return { status: 'failed', message: message(error) } satisfies SystemScreenshotEditorFinish }", to: "catch (error) { active.end({ state: 'cancelled' }); return { status: 'failed', message: message(error) } satisfies SystemScreenshotEditorFinish }", expected: 'a failed primary delivery keeps every overlay' },
  { id: 'surface-pin-at-selection', source: surface, from: '{ ...source.rect, width: params.image!.width / source.scale', to: '{ ...source.rect, x: 0, width: params.image!.width / source.scale', expected: 'a confirmed Pin opens on the selection' },
  { id: 'surface-pin-closes', source: surface, from: "if (pinned.recordedOperation?.state === 'completed') active.end({ state: 'completed' })", to: 'void pinned', expected: 'a confirmed Pin opens on the selection and closes the capture surface' },
  { id: 'surface-unconfirmed-pin-keeps', source: surface, from: "if (pinned.recordedOperation?.state === 'completed') active.end", to: 'active.end', expected: 'Save PNG and an unconfirmed Pin act on the selection and keep the overlays' },
  { id: 'surface-expand-carries-marks', source: surface, from: "active.end({ state: 'expanded', image: overlay.input.image!, source, handoff, delivered:", to: "active.end({ state: 'expanded', image: overlay.input.image!, source, handoff: { ...handoff, shapes: [] }, delivered:", expected: 'expand ends the surface with the full frozen frame' },
  { id: 'surface-issue-not-selectable', source: surface, from: 'if (overlay.input.image === undefined || (', to: 'if ((', expected: 'a display without pixels shows its issue' },
  { id: 'surface-work-area-keeps', source: surface, from: "metrics.some(metric => metric !== 'workArea')", to: 'true', expected: 'a display layout change ends the capture, while a work area change keeps it' },
  { id: 'surface-crash-ends', source: surface, from: "window.webContents.once('render-process-gone',", to: "window.webContents.once('render-process-gone-unused',", expected: 'a crashed overlay renderer ends the capture' },
  { id: 'surface-fades-workbench', source: surface, from: 'for (const { window } of active.faded) window.setOpacity(0)', to: 'void 0', expected: 'fades visible AgentMux windows out of the grab' },
  { id: 'surface-restores-own-opacity', source: surface, from: 'window.setOpacity(opacity)', to: 'window.setOpacity(1)', expected: 'fades visible AgentMux windows out of the grab' },
  { id: 'surface-skips-transparent', source: surface, from: '.filter(({ opacity }) => opacity > 0)', to: '', expected: 'fades visible AgentMux windows out of the grab' },
  { id: 'surface-fade-settles', source: surface, from: 'await new Promise(resolve => setTimeout(resolve, STEP_OUT_SETTLE_MS))', to: 'void 0', expected: 'fades visible AgentMux windows out of the grab' },
  { id: 'surface-return-focus', source: surface, from: '          if (session.returnFocus) this.ports.returnFocus()', to: '          if (session.returnFocus) void 0', expected: 'returns focus to the previous app once' },
  { id: 'surface-exact-sender', source: surface, from: 'event.senderFrame !== overlay.window.webContents.mainFrame', to: 'false', expected: 'refuses another window, an embedded frame and a stale request' },
  { id: 'surface-one-at-a-time', source: surface, from: "    if (this.active) return Promise.reject(new Error('A screen capture is already in progress.", to: "    if (false) return Promise.reject(new Error('A screen capture is already in progress.", expected: 'a second capture while one is open is refused' },
  { id: 'surface-public-captured', source: surface, from: "return outcome.state === 'completed' && result ? result : { state: 'cancelled' }", to: "return { state: 'cancelled' }", expected: 'the public selection returns the processed selection as captured' },
  // The last delivered selection: remembered on a completed primary delivery only, offered only on its unchanged display.
  { id: 'surface-recall-on-delivery', source: surface, from: '    this.recall = this.remember(overlay, source.rect)', to: '    void this.remember(overlay, source.rect)', expected: 'the next capture opens on the last delivered selection' },
  { id: 'surface-recall-display-origin', source: surface, from: 'x: Math.round((last.rect.x - frame.x) * scale)', to: 'x: Math.round(last.rect.x * scale)', expected: 'the next capture opens on the last delivered selection' },
  { id: 'surface-recall-ignores-id', source: surface, from: 'last.displayId !== displayId || ', to: '', expected: 'no remembered selection: the display id changed' },
  { id: 'surface-recall-ignores-scale', source: surface, from: 'last.scale !== scale || ', to: '', expected: 'no remembered selection: the display scale changed' },
  { id: 'surface-recall-ignores-frame', source: surface, from: ' || !sameRect(last.frame, frame)) return undefined', to: ') return undefined', expected: 'no remembered selection: the display moved' },
  { id: 'surface-recall-ignores-size', source: surface, from: 'a.width === b.width && ', to: '', expected: 'no remembered selection: the display resized' },
  { id: 'surface-recall-keys-under-pointer', source: surface, from: 'const keys = active.overlays.find(overlay => overlay.input.initialCrop) ?? target', to: 'const keys = target', expected: 'the display that carries the remembered selection takes the keys' },
  { id: 'surface-public-failed-code', source: surface, from: "code: typeof code === 'string' && code ? code : 'capture_failed'", to: "code: 'capture_failed'", expected: 'the public selection reports a failed native grab as failed with its code' }
]
await mkdir(resolve('.local/system-screenshot-editor'), { recursive: true })
const out = await mkdtemp(resolve('.local/system-screenshot-editor/run-'))
const inputs = [source, surface, 'apps/desktop/src/shared/capture-surface.ts', 'apps/desktop/test/capture-surface.test.ts',
  'apps/desktop/src/preload/capture-surface.ts', 'apps/desktop/src/renderer/screenshot-editor/CaptureSurfaceView.tsx', 'apps/desktop/src/shared/system-screenshot-editor.ts', 'apps/desktop/src/preload/screenshot-editor.ts',
  'apps/desktop/src/renderer/screenshot-editor/entry.tsx', 'apps/desktop/src/renderer/screenshot-editor/SystemScreenshotEditorView.tsx',
  'apps/desktop/src/renderer/screenshot-editor/screenshot-editor.css', 'apps/desktop/src/renderer/src/components/image-annotation/compose.ts',
  'apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx', 'apps/desktop/src/renderer/src/components/image-annotation/image-annotation.css',
  'apps/desktop/src/renderer/src/components/image-annotation/AnnotationToolbar.tsx', 'apps/desktop/test/system-screenshot-editor.test.ts',
  ...['drawing-model.ts', 'drawing-renderer.ts', 'geometry.ts', 'selection-geometry.ts', 'view.ts', 'canvas-render.ts', 'AnnotationNotes.tsx', 'AnnotationOriginalMenu.tsx', 'types.ts']
    .map(name => 'apps/desktop/src/renderer/src/components/image-annotation/' + name),
  'apps/desktop/test/global-screenshot-integration.test.ts', 'apps/desktop/src/main/global-screenshot.ts',
  'apps/desktop/src/renderer/src/components/RovingToolbar.tsx', 'apps/desktop/src/main/theme-bootstrap.ts', 'packages/native-desktop/src/image.ts',
  'apps/desktop/test/browser-screenshot-compose.test.ts', 'apps/desktop/test/browser-screenshot-context.test.ts',
  'apps/desktop/test/system-screenshot-editor.config.mts', 'apps/desktop/scripts/fixtures/system-screenshot-editor/main.ts',
  'apps/desktop/scripts/fixtures/system-screenshot-editor/scenario.md', 'apps/desktop/scripts/verify-system-screenshot-editor.mjs',
  'packages/client-ui/src/theme/runtime.ts', 'apps/desktop/electron.vite.config.ts',
  'apps/desktop/src/main/screen-capture.ts', 'apps/desktop/src/main/pasted-image-write.ts', 'apps/desktop/src/main/screenshot-original-files.ts', 'apps/desktop/src/main/screenshot-files.ts', 'apps/desktop/src/main/screenshot-pins.ts',
  'apps/desktop/src/renderer/screenshot-editor/use-system-screenshot-original.ts', 'apps/desktop/src/renderer/src/styles/context-menu.css',
  'apps/desktop/src/renderer/src/styles/chrome.css', 'apps/desktop/src/renderer/src/lib/use-screenshot-pin.ts', 'apps/desktop/src/renderer/src/styles/base.css']
const hashes = Object.fromEntries(await Promise.all(inputs.map(async file => [file, sha(await readFile(file))])))
const receipt = { schema: 'agentmux.system-screenshot-editor-proof.v1', passed: false, sharedTreeMutations: 0, inputs: hashes, runs: [], native: null }
async function command(label, program, args, env = {}) {
  const result = await new Promise((done, reject) => {
    const childEnv = { ...process.env, ...env }
    if (program === require('electron')) delete childEnv.ELECTRON_RUN_AS_NODE
    const child = spawn(program, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timeout = false, terminateTimer
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; if (label === 'native') process.stdout.write(bytes) })
    const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM'); terminateTimer = setTimeout(() => child.kill('SIGKILL'), 3000) }, 45000)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(terminateTimer); done({ code, signal, log, timeout }) })
  })
  await writeFile(join(out, label + '.log'), result.log)
  assert.equal(result.timeout, false, label + ': timed-out infrastructure is not a behavior result')
  assert.equal(result.signal, null, label + ': process termination is not behavior proof')
  return result
}
async function test(label, mutation) {
  const loaded = join(out, label + '.loaded.ndjson'), json = join(out, label + '.tests.json')
  const result = await command(label, process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/system-screenshot-editor.config.mts',
    '--reporter=json', '--outputFile=' + json], { AGENTMUX_SCREENSHOT_EDITOR_LOADED: loaded,
      AGENTMUX_SCREENSHOT_EDITOR_MUTATION: mutation ? JSON.stringify(mutation) : '' })
  const report = JSON.parse(await readFile(json, 'utf8')), assertions = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length >= 7 && assertions.every(row => ['passed', 'failed'].includes(row.status)), label + ': nonempty executed original tests required')
  for (const file of report.testResults) assert.equal(file.message, '', label + ': collection failures do not prove a behavior mutation')
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  const consumed = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const owner = mutation?.source ?? source, mutated = consumed.filter(row => row.file === owner)
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
  }
  receipt.runs.push({ label, code: result.code, assertions: assertions.length, loaded: consumed })
  process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
}
const work = await mkdtemp(join(tmpdir(), 'agentmux-screenshot-editor-'))
try {
  assert.ok(mutations.length > 0)
  for (const mutation of mutations) assert.equal(sources[mutation.source ?? source].split(mutation.from).length, 2, 'Unique production mutation: ' + mutation.id)
  await test('baseline')
  for (const mutation of mutations) await test(mutation.id, mutation)
  const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor')
  for (const dir of [mainRoot, preloadRoot, rendererRoot]) await mkdir(dir, { recursive: true })
  await mkdir(join(mainRoot, 'user-data'))
  await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
    '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
  const mainOptions = { entryPoints: ['apps/desktop/scripts/fixtures/system-screenshot-editor/main.ts'], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
    external: ['electron', '@agentmux/core', '@agentmux/core/*', '@agentmux/host/*'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" }, alias, logLevel: 'silent' }
  await build(mainOptions)
  await build({ entryPoints: ['apps/desktop/src/preload/screenshot-editor.ts'], outfile: join(preloadRoot, 'screenshot-editor.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/entry.tsx'], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias,
    conditions: ['browser'], logLevel: 'silent' })
  const html = await readFile('apps/desktop/src/renderer/screenshot-editor/index.html', 'utf8')
  await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  const pinRoot = join(appRoot, 'out/renderer/screenshot-pin')
  await mkdir(pinRoot, { recursive: true })
  await build({ entryPoints: ['apps/desktop/src/preload/screenshot-pin.ts'], outfile: join(preloadRoot, 'screenshot-pin.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-pin/entry.tsx'], outfile: join(pinRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias, conditions: ['browser'], logLevel: 'silent' })
  await writeFile(join(pinRoot, 'index.html'), (await readFile('apps/desktop/src/renderer/screenshot-pin/index.html', 'utf8')).replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  const native = await command('native', require('electron'), [appRoot], { AGENTMUX_SCREENSHOT_EDITOR_OUT: out, AGENTMUX_SCREENSHOT_FILE_HELPER: resolve('apps/desktop/resources/bin/agentmux-workspace-move'), ELECTRON_RENDERER_URL: '' })
  receipt.native = JSON.parse(await readFile(join(out, 'native.json'), 'utf8'))
  assert.equal(native.code, 0, JSON.stringify(receipt.native.failure) + native.log)
  assert.equal(receipt.native.passed, true)
  assert.equal(receipt.native.cases.length, 5)
  assert.equal(receipt.native.screenshots.length, 10)
  const producerSource = producer, producerText = sources[producer]
  assert.equal(producerText.split('originalDelivered = true').length, 2, 'Mutate the exact original delivery completion once')
  const replayed = producerText.replace('originalDelivered = true', 'originalDelivered = false'), mutantOut = join(out, 'draft-redelivery')
  await mkdir(mutantOut)
  let producerConsumed = false
  await build({ ...mainOptions, plugins: [{ name: 'exact-original-draft-redelivery-counterexample', setup(builder) {
    builder.onLoad({ filter: /\/src\/main\/screen-capture\.ts$/ }, args => {
      assert.equal(args.path, resolve(producerSource)); producerConsumed = true
      return { contents: replayed, loader: 'ts', resolveDir: dirname(args.path) }
    })
  } }] })
  assert.equal(producerConsumed, true, 'The actual capture-to-editor producer must consume its mutant')
  const negative = await command('draft-redelivery', require('electron'), [appRoot], { AGENTMUX_SCREENSHOT_EDITOR_OUT: mutantOut,
    AGENTMUX_SCREENSHOT_FILE_HELPER: resolve('apps/desktop/resources/bin/agentmux-workspace-move'), ELECTRON_RENDERER_URL: '' })
  const counterexample = JSON.parse(await readFile(join(mutantOut, 'native.json'), 'utf8'))
  assert.equal(negative.code, 1); assert.equal(counterexample.passed, false); assert.ok(counterexample.cases.length > 0)
  assert.match(counterexample.failure?.message ?? '', /later clipboard image creates no second draft file/)
  receipt.nativeCaptureMutation = { source: producerSource, original: sha(producerText), consumed: sha(replayed),
    result: 'owning-AssertionRED', failure: counterexample.failure.message, receipt: join(mutantOut, 'native.json') }
  for (const [file, hash] of Object.entries(hashes)) assert.equal(sha(await readFile(file)), hash, 'Candidate changed during proof: ' + file)
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await rm(work, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, mutations: mutations.length, receipt: join(out, 'receipt.json'), screenshots: receipt.native.screenshots }) + '\n')
