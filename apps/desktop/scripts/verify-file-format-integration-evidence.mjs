import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Receipts supplement actual source mutations; they never replace a missing product consumer. */
export async function verifyIntegrationEvidence() {
  const root = resolve(import.meta.dirname, '../../..')
  const evidence = resolve(process.env.AGENTMUX_EDITOR_FORMAT_EVIDENCE)
  const json = async file => JSON.parse(await readFile(join(evidence, file), 'utf8'))
  const sources = async bindings => {
    assert.ok(Object.keys(bindings ?? {}).length > 0, 'Nonempty exact source bindings')
    for (const [file, digest] of Object.entries(bindings)) assert.equal(
      createHash('sha256').update(await readFile(join(root, file))).digest('hex'), digest, 'Current evidence source: ' + file)
  }
  const run = async args => {
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
    })
    assert.equal(result.code, 0, result.output); assert.equal(result.signal, null)
  }
  await run(['apps/desktop/scripts/verify-control-listener-lifecycle.mjs', '--check'])
  // Recheck each task's current definitions, transformed source SHA and raw RED/GREEN logs.
  for (let index = 1; index <= 16; index++) await run([
    'apps/desktop/scripts/verify-file-format-capabilities.mjs', '--task', `T-${String(index).padStart(3, '0')}`
  ])
  const cli = await json('compiled-file-format-discovery-receipt.json')
  assert.equal(cli.passed, true); assert.equal(cli.privateCleanup, true)
  await sources(cli.sourceBefore); await sources(cli.sourceAfter)
  assert.equal(cli.tests.exitCode, 0); assert.ok(cli.tests.count >= 6)
  assert.equal(createHash('sha256').update(await readFile(join(evidence, cli.log))).digest('hex'), cli.logSha256)
  assert.deepEqual(cli.cases.map(item => item.method).sort(), ['file.build', 'file.build.cancel', 'file.build.inspect', 'file.format'])
  for (const item of cli.cases) {
    assert.equal(item.help.code, 0); assert.equal(item.request.method, item.method)
    assert.equal(item.request.params.regionId, 'original-file')
    assert.equal(item.route.signal, null)
    assert.equal(JSON.parse(item.route.stderr).error.code, 'FILE_ROUTE_PROBE')
  }
  const svgDirectory = 'notebook-svg-native-mutation/'
  const svg = await json(svgDirectory + 'receipt.json')
  assert.equal(svg.schema, 'agentmux.notebook-svg-native-mutation.v1'); assert.equal(svg.passed, true)
  assert.equal(svg.sharedTreeMutations, 0); await sources(svg.sourceBefore); await sources(svg.sourceAfter)
  assert.deepEqual(svg.cases.map(item => item.name), ['baseline-green', 'red', 'restore-green'])
  const markupFile = 'apps/desktop/src/renderer/src/components/file-preview/StaticMarkupPreview.tsx'
  assert.equal(svg.mutation.file, markupFile)
  const markup = await readFile(join(root, markupFile), 'utf8')
  assert.equal(markup.split(svg.mutation.before).length - 1, 1)
  for (const item of svg.cases) {
    const mutated = item.name === 'red'
    assert.equal(item.mutated, mutated)
    for (const name of ['receipt', 'native', 'log', 'processLog']) assert.equal(
      createHash('sha256').update(await readFile(join(evidence, svgDirectory, item.raw[name]))).digest('hex'), item.raw[name + 'Sha256'])
    const captured = await json(svgDirectory + item.raw.receipt), native = await json(svgDirectory + item.raw.native)
    await sources(captured.identity.sources); await sources(captured.loadedSources)
    assert.deepEqual(item.nativeOutcome, captured.captureOutcome)
    assert.equal(item.nativeOutcome.exitCode, mutated ? 1 : 0)
    assert.equal(item.nativeOutcome.timedOut, false); assert.equal(item.nativeOutcome.interruption, null)
    assert.deepEqual(captured.cleanup.remaining, []); assert.deepEqual(item.cleanup, { remaining: [], temporaryRemoved: true })
    const loadedSha = createHash('sha256').update(mutated ? markup.replace(svg.mutation.before, svg.mutation.after) : markup).digest('hex')
    assert.equal(item.loaded.file, markupFile); assert.equal(item.loaded.sha256, loadedSha)
    assert.deepEqual(item.loaded, captured.staticMarkupLoaded)
    assert.equal(createHash('sha256').update(await readFile(join(evidence, svgDirectory, item.name, 'loaded-static-markup.ts'))).digest('hex'), loadedSha)
    assert.doesNotMatch(await readFile(join(evidence, svgDirectory, item.raw.processLog), 'utf8'), /FATAL|SIGTRAP/)
    if (mutated) {
      assert.equal(native.passed, false); assert.equal(native.failure.name, 'AssertionError')
      assert.match(native.failure.stack, /staticFrames/); assert.match(native.failure.message, /420|100/)
    } else {
      assert.equal(native.passed, true); assert.equal(captured.diagnosticPassed, true)
      assert.ok(native.staticOutputs.some(fact => fact.svg?.rect.width === '360' && fact.svg?.text.y === '54'))
      assert.ok(native.notebookPaint.length >= 2); assert.deepEqual(native.network, []); assert.deepEqual(native.writes, [])
    }
  }
  await run(['apps/desktop/scripts/verify-file-format-native.mjs', '--check', '--output=' + join(evidence, 'file-format-native')])
  const native = await json('file-format-native/capture-receipt.json')
  await sources(native.loadedSources)
  const visual = await json('file-format-native/visual-review.json')
  for (const frame of native.frames) {
    const review = visual.screenshots.find(item => item.file === frame.file)
    assert.equal(review?.opened, true, 'Actual independent image review: ' + frame.file)
    assert.equal(review?.approved, true); assert.ok(review.reviewer?.length > 0)
  }
  const bundle = await json('production-bundle.json')
  assert.equal(bundle.passed, true); assert.equal(bundle.cleanup.buildDirectoryRemoved, true)
  assert.deepEqual(bundle.startup.eagerFormatEngines, []); assert.ok(bundle.startup.moduleCount > 0)
  for (const target of ['main', 'preload', 'renderer']) assert.ok(Object.keys(bundle.targets[target]?.artifacts ?? {}).length > 0)
  await sources(bundle.sources)
  const structured = await json('structured-worker-chromium.json')
  assert.equal(structured.passed, true); await sources(structured.sources)
  assert.deepEqual(structured.outcome, { exitCode: 0, timedOut: false, interruption: null })
  assert.deepEqual(structured.cleanup.remaining, []); assert.equal(structured.native.hidden.hiddenStarts, 0)
  assert.ok(structured.native.samples.length >= 3)
  for (const sample of structured.native.samples) assert.ok(sample.workers.every(worker => worker.terminated))
  for (const file of ['markdown-worker-chromium.json', 'markdown-worker-library-chromium.json']) {
    const markdown = await json(file)
    assert.equal(markdown.passed, true); await sources(markdown.sources); assert.deepEqual(markdown.cleanup.remaining, [])
    assert.deepEqual(markdown.outcome, { exitCode: 0, timedOut: false, interruption: null })
    assert.equal(markdown.native.dense.rendered, 100); assert.ok(markdown.native.dense.peak <= 2)
    assert.equal(markdown.native.dense.activeWorkers, 0); assert.equal(markdown.native.denseHidden.activeWorkers, 0)
    assert.equal(markdown.native.denseHidden.rendered, 0)
  }
  const bindings = await json('native-diagram-concurrency/bindings.json')
  assert.equal(bindings.passed, true); await sources(bindings.sourceBefore); await sources(bindings.sourceAfter)
  assert.equal(bindings.privateProfileRemoved, true)
  for (const [file, digest] of Object.entries(bindings.probeSources)) assert.equal(
    createHash('sha256').update(await readFile(join(evidence, 'native-diagram-concurrency', file))).digest('hex'), digest)
  for (const [file, digest] of [['observed.json', bindings.observedSha256], ['external-rss.json', bindings.externalRssSha256]]) assert.equal(
    createHash('sha256').update(await readFile(join(evidence, 'native-diagram-concurrency', file))).digest('hex'), digest)
  const diagrams = await json('native-diagram-concurrency/observed.json')
  assert.equal(diagrams.passed, true); assert.equal(diagrams.remainingWindows, 0)
  const queue = diagrams.reports.find(item => item.name === 'eight-product-queue')
  assert.equal(queue.results.length, 8); assert.ok(queue.peakWindows <= 2 && queue.peakProcesses <= 2)
  assert.ok(queue.results.every(result => !result.error && result.svgBytes > 0))
  assert.deepEqual([...queue.retiredPids].sort(), [...queue.seenPids].sort())
  for (const name of ['eight-cancel-active', 'eight-cancel-before-load']) {
    const cancellation = diagrams.reports.find(item => item.name === name)
    assert.equal(cancellation.results.length, 8)
    assert.ok(cancellation.results.every(result => /cancelled/.test(result.error) && result.svgBytes === 0))
    assert.equal(cancellation.afterCancel.diagramWindows, 0); assert.equal(cancellation.afterCancel.diagramProcesses, 0)
    assert.equal(cancellation.final.diagramWindows, 0); assert.equal(cancellation.final.diagramProcesses, 0)
    assert.deepEqual([...cancellation.retiredPids].sort(), [...cancellation.seenPids].sort())
  }
  await sources(await json("rich-preview-fit-fonts-fixture/source-snapshot.json"))
  const rich = (await readFile(join(evidence, "rich-preview-fit-fonts-fixture/actual-product-plugin-production-dev-after.json"), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line)).at(-1)
  assert.equal(rich.passed, true)
  for (const name of ['scene', 'sceneDev']) {
    const scene = rich[name]
    assert.equal(scene.fonts.faces.length, 234); assert.ok(scene.fonts.faces.every(face => face.status === 'loaded'))
    assert.deepEqual(scene.fonts.blocked, []); assert.ok(scene.fonts.requests.length >= 234)
    assert.ok(scene.fonts.requests.every(url => {
      const parsed = new URL(url)
      return parsed.protocol === 'file:' || (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')
    }), 'All observed Excalidraw fonts are local')
    assert.equal(scene.remainingCanvases, 0)
    assert.ok(scene.cancellation.maxGap < 100 && scene.cancellation.elapsedMs < 1_000)
    assert.deepEqual(scene.resourceCalls, ['data.csv', 'red.png'])
  }
  console.log(JSON.stringify({ passed: true, exactTaskProofs: 17, nativeFrames: native.frames.length,
    compiledPublicCli: true, independentVisualReview: true, productionBundle: true,
    boundedWorkersAndNativeRenderers: true, localDiagramFonts: true, nativeNotebookSvgMutation: true }))
}
