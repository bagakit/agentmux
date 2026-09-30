import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.ok(args.length === 2 && args[0] === '--slice' && ['source', 'source-visual'].includes(args[1]), 'Use --slice source|source-visual')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const product = ['GlobalFocusSurface', 'FocusDisconnectedGroup', 'FocusDisconnectedProjects'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`)
const css = 'apps/desktop/src/renderer/src/styles/focus.css'
const fixture = 'apps/desktop/scripts/fixtures/focus-lane-adaptive-density/'
const files = [...product, css, 'apps/desktop/test/focus-lane-adaptive-density.test.tsx', fixture + 'vitest.owning.config.mts', fixture + 'vitest.mutation.config.mts', fixture + 'tsconfig.owning.json', fixture + 'entry.mjs', fixture + 'main.cjs', 'apps/desktop/scripts/capture-focus-lane-adaptive-density.mjs', 'apps/desktop/scripts/verify-focus-lane-adaptive-density.mjs', 'apps/desktop/test/focus-lane-information.test.tsx', 'apps/desktop/test/mote-icon-identity.test.tsx']
const bindings = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
const out = join(root, '.tmp', `focus-lane-adaptive-source-${Date.now()}`); await mkdir(out, { recursive: true })
const before = await bindings(), receipt = { schema: 'agentmux.focus-lane-adaptive-qualification.v1', passed: false, sourcePassed: false, sourceBefore: before, owning: null, mutations: [], adjacent: null, types: [], callers: {}, boundary: 'Actual mounted Global/Store/hierarchy/disconnected consumers and compiled browser geometry. PTY/unused Monaco painting isolated; no physical xterm, healthy Run/PID, Writer, ordinary restart, installation or full Focus qualification.' }
const execute = async (label, command, params, env = {}) => {
  let actual
  try { const output = await promisify(execFile)(command, params, { cwd: root, env: { ...process.env, ...env }, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }); actual = { code: 0, signal: null, output: output.stdout + output.stderr } }
  catch (error) { actual = { code: error.code, signal: error.signal, output: (error.stdout ?? '') + (error.stderr ?? '') } }
  await writeFile(join(out, label + '.log'), actual.output); return { code: actual.code, signal: actual.signal, log: label + '.log' }
}
try {
  const sourceInput = process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_SOURCE_RECEIPT
  if (sourceInput) {
    const prior = JSON.parse(await readFile(sourceInput, 'utf8')); assert.equal(prior.sourcePassed, true)
    assert.deepEqual(prior.sourceBefore, before); assert.deepEqual(prior.sourceAfter, before)
    assert.equal(prior.owning.collected, 9); assert.equal(prior.owning.failed, 0); assert.equal(prior.adjacent.collected, 37); assert.equal(prior.adjacent.failed, 0)
    assert.equal(prior.mutations.length, 4); assert.equal(prior.types.length, 2); for (const check of prior.types) assert.equal(check.code, 0)
    receipt.reusedSource = { path: sourceInput, sha256: hash(await readFile(sourceInput)) }
    for (const key of ['owning', 'mutations', 'adjacent', 'types', 'callers']) receipt[key] = prior[key]
  } else {
    const test = async (label, mutation) => {
      const report = join(out, label + '.json'), loaded = join(out, label + '.loaded.jsonl')
      const execution = await execute(label, process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', fixture + (mutation ? 'vitest.mutation.config.mts' : 'vitest.owning.config.mts'), '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], mutation ? { AGENTMUX_FOCUS_LANE_ADAPTIVE_MUTATION: mutation, AGENTMUX_FOCUS_LANE_ADAPTIVE_LOADED_LOG: loaded } : { AGENTMUX_FOCUS_LANE_ADAPTIVE_SOURCE_LOG: loaded })
      const actual = JSON.parse(await readFile(report, 'utf8')); assert.equal(actual.numTotalTests, 9); assert.equal(actual.testResults.length, 1); assert.equal(actual.testResults[0].assertionResults.length, 9)
      const modules = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.ok(modules.length > 0, 'Actual loaded product modules')
      if (mutation) {
        assert.equal(modules.length, 1); const file = relative(root, modules[0].id.split('?')[0]); assert.equal(modules[0].sourceSHA256, before[file]); assert.notEqual(modules[0].loadedSHA256, modules[0].sourceSHA256)
        assert.ok(execution.code > 0 && execution.signal === null); assert.ok(actual.numFailedTests > 0)
        assert.ok(actual.testResults.flatMap(file => file.assertionResults).some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Loaded semantic AssertionRED, not preparation failure')
      } else {
        assert.equal(execution.code, 0); assert.equal(actual.numFailedTestSuites, 0); assert.equal(actual.numFailedTests, 0); assert.equal(actual.numPassedTests, 9)
        for (const file of product) { const found = modules.filter(module => relative(root, module.id.split('?')[0]) === file); assert.ok(found.length > 0, 'Actual consumed ' + file); for (const module of found) assert.equal(module.sourceSHA256, before[file]) }
      }
      return { ...execution, collected: actual.numTotalTests, passed: actual.numPassedTests, failed: actual.numFailedTests, report: relative(out, report), loaded: relative(out, loaded), modules }
    }
    receipt.owning = await test('baseline')
    for (const mutation of ['local-rows', 'wrong-lane', 'empty-summary', 'healthy-lost']) receipt.mutations.push({ mutation, red: await test(mutation + '-red', mutation), green: await test(mutation + '-restored') })
    const report = join(out, 'adjacent.json'); receipt.adjacent = await execute('adjacent', process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/focus-lane-disconnected/vitest.adjacent.config.mts', '--maxWorkers=1', '--reporter=json', '--outputFile=' + report])
    const adjacent = JSON.parse(await readFile(report, 'utf8')); receipt.adjacent = { ...receipt.adjacent, collected: adjacent.numTotalTests, passed: adjacent.numPassedTests, failed: adjacent.numFailedTests }
    assert.equal(adjacent.numTotalTests, 37); assert.equal(receipt.adjacent.code, 0); assert.equal(adjacent.numFailedTests, 0)
    for (const [label, config] of [['production', 'apps/desktop/tsconfig.json'], ['owning', fixture + 'tsconfig.owning.json']]) { const check = await execute(label + '-types', join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', config]); receipt.types.push({ label, ...check }); assert.equal(check.code, 0, await readFile(join(out, check.log), 'utf8')) }
    const appFile = 'apps/desktop/src/renderer/src/App.tsx', app = await readFile(join(root, appFile), 'utf8'); assert.match(app, /<GlobalFocusSurface\b/); receipt.callers.GlobalFocusSurface = [appFile]
    const global = await readFile(join(root, product[0]), 'utf8'); for (const symbol of ['FocusDisconnectedGroup', 'FocusDisconnectedProjects']) { assert.match(global, new RegExp('<' + symbol + '\\b')); receipt.callers[symbol] = [product[0]] }
    const group = await readFile(join(root, product[1]), 'utf8'); assert.match(group, /<WindowOverlayPortal\b/); receipt.callers.WindowOverlayPortal = [product[1]]
    const entry = await readFile(join(root, fixture + 'entry.mjs'), 'utf8'); assert.match(entry, /styles\/index\.css/); const index = await readFile(join(root, 'apps/desktop/src/renderer/src/styles/index.css'), 'utf8'); assert.match(index, /focus\.css/); receipt.callers.laneCSS = ['apps/desktop/src/renderer/src/styles/index.css', fixture + 'entry.mjs']
  }
  receipt.sourceAfter = await bindings(); assert.deepEqual(receipt.sourceAfter, before); receipt.sourcePassed = true
  if (args[1] === 'source-visual') {
    const scenePath = process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_SCENE_RECEIPT, redPath = process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_CSS_RED_RECEIPT
    assert.ok(scenePath && redPath, 'Exact compiled scene, independent visual review and loaded CSS AssertionRED required')
    const sceneDir = resolve(scenePath, '..'), scene = JSON.parse(await readFile(scenePath, 'utf8')), reviewPath = join(sceneDir, 'visual-review.json'), review = JSON.parse(await readFile(reviewPath, 'utf8')), red = JSON.parse(await readFile(redPath, 'utf8'))
    assert.equal(scene.capturedPass, true); assert.equal(scene.actual.passed, true); assert.deepEqual(scene.inputs, scene.sourceAfter); assert.ok(scene.frames.length >= 9)
    for (const [file, sha] of Object.entries(scene.inputs)) assert.equal(hash(await readFile(join(root, file))), sha, 'Exact current scene input ' + file)
    assert.equal(review.verdict, 'pass'); assert.ok(review.reviewerAgentId); assert.equal(review.sceneReceiptSHA256, hash(await readFile(scenePath))); assert.equal(review.viewedImages.length, scene.frames.length)
    for (const frame of scene.frames) { assert.equal(hash(await readFile(join(sceneDir, frame.file))), frame.sha256); assert.ok(review.viewedImages.some(image => image.path === frame.file && image.sha256 === frame.sha256 && image.viewed === true)) }
    assert.equal(red.capturedPass, false); assert.equal(red.actual.failure.name, 'AssertionError')
    const broken = red.actual.currentGeometry; assert.equal(broken.states.length, 5); assert.deepEqual(broken.states.map(state => state.state), ['attention', 'working', 'results', 'idle', 'disconnected'])
    assert.ok(broken.states.every(state => state.rect.width > 0 && state.rect.height > 0), 'Nonempty actual loaded CSS geometry')
    assert.ok(broken.states.some(state => state.empty && state.state !== 'disconnected' && state.rect.width > 24.5), 'Loaded old layout grows an empty rail beyond its bounded width')
    assert.ok(new Set(broken.states.map(state => state.rect.top)).size > 1, 'The loaded old 800px rule also makes five distinct vertical positions')
    const loadedCSS = red.transformations.filter(change => change.mutation === 'old-800-columns'); assert.equal(loadedCSS.length, 1); assert.equal(loadedCSS[0].sourceSHA256, scene.inputs[css]); assert.notEqual(loadedCSS[0].sourceSHA256, loadedCSS[0].loadedSHA256)
    for (const actual of [scene, red]) { assert.equal(actual.cleanup.removed, true); assert.deepEqual(actual.cleanup.remaining, []); assert.equal(actual.userAppRunRuntimeControlled, false) }
    receipt.scene = { path: scenePath, sha256: hash(await readFile(scenePath)), independentReview: reviewPath, independentReviewSHA256: hash(await readFile(reviewPath)), cssRed: redPath, cssRedSHA256: hash(await readFile(redPath)) }
  }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, sourcePassed: receipt.sourcePassed, evidence: out, failure: receipt.failure?.message, wholeFocusDone: false })) }
