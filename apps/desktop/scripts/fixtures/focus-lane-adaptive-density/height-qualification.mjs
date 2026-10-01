import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../../../..')
const fixture = 'apps/desktop/scripts/fixtures/focus-lane-adaptive-density/'
const product = ['GlobalFocusSurface', 'FocusProjectLanes', 'FocusLaneGroups', 'FocusContextRow'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`)
const allocator = 'apps/desktop/src/renderer/src/lib/focus-lane-layout.ts'
const files = [...product, allocator, 'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/test/focus-lane-height-balance.test.tsx', fixture + 'vitest.height.config.mts', fixture + 'tsconfig.height.json', fixture + 'height-qualification.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bindings = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))

export async function qualifyHeight(slice) {
  const out = join(root, '.tmp', ("focus-lane-height-" + (slice) + "-" + (globalThis.crypto.randomUUID()) + ""))
  await mkdir(out, { recursive: true })
  const before = await bindings()
  const receipt = { schema: 'agentmux.focus-lane-height-qualification.v1', passed: false, sourceBefore: before, tests: [], mutations: [], types: [], adjacent: [], callers: {}, boundary: 'Actual Global/Store/Row and integer allocation. No package, user App/Run or Core/PTY restart.' }
  const execute = async (label, params, env = {}) => {
    let result
    try { const output = await promisify(execFile)(process.execPath, params, { cwd: root, env: { ...process.env, ...env }, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); result = { code: 0, signal: null, output: output.stdout + output.stderr } }
    catch (error) { result = { code: error.code, signal: error.signal, output: (error.stdout ?? '') + (error.stderr ?? '') } }
    await writeFile(join(out, label + '.log'), result.output)
    return { code: result.code, signal: result.signal, log: label + '.log' }
  }
  try {
    if (slice === 'height-source') {
      const test = async (label, mutation) => {
        const report = join(out, label + '.json'), loaded = join(out, label + '.loaded.jsonl')
        const result = await execute(label, ['node_modules/vitest/vitest.mjs', 'run', '--config', fixture + 'vitest.height.config.mts', '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], { AGENTMUX_FOCUS_LANE_HEIGHT_LOADED_LOG: loaded, ...(mutation ? { AGENTMUX_FOCUS_LANE_HEIGHT_MUTATION: mutation } : {}) })
        const actual = JSON.parse(await readFile(report, 'utf8'))
        assert.equal(actual.numTotalTests, 7); assert.equal(actual.testResults.length, 1)
        const modules = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        assert.ok(modules.length > 0)
        for (const file of [...product, allocator]) {
          const found = modules.filter(module => relative(root, module.id.split('?')[0]) === file)
          assert.ok(found.length > 0, 'Actual consumed ' + file)
          for (const module of found) assert.equal(module.sourceSHA256, before[file])
        }
        if (mutation) {
          const changed = modules.filter(module => module.changed)
          assert.equal(changed.length, 1); assert.equal(changed[0].mutation, mutation); assert.notEqual(changed[0].sourceSHA256, changed[0].loadedSHA256)
          assert.ok(result.code > 0 && result.signal === null)
          assert.ok(actual.numFailedTests > 0)
          assert.ok(actual.testResults.flatMap(file => file.assertionResults).some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Loaded semantic AssertionRED, not preparation failure')
        } else {
          assert.equal(result.code, 0); assert.equal(actual.numFailedTests, 0); assert.equal(actual.numPassedTests, 7)
          assert.ok(modules.every(module => !module.changed))
        }
        return { ...result, collected: actual.numTotalTests, passed: actual.numPassedTests, failed: actual.numFailedTests, report: relative(out, report), loaded: relative(out, loaded), modules }
      }
      receipt.tests.push(await test('baseline'))
      for (const mutation of ['capped', 'unstable', 'wrong-target', 'covered']) receipt.mutations.push({ mutation, red: await test(mutation + '-red', mutation), green: await test(mutation + '-restored') })
      for (const [label, config] of [['production', 'apps/desktop/tsconfig.json'], ['height-owning', fixture + 'tsconfig.height.json']]) {
        const result = await execute(label + '-types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', config]); receipt.types.push({ label, ...result })
      }
      for (const [label, config, count] of [['original-adaptive', fixture + 'vitest.owning.config.mts', 9], ['original-recap', 'apps/desktop/scripts/fixtures/focus-context-recap-menu/vitest.owning.config.mts', 17]]) {
        const report = join(out, label + '.json'), result = await execute(label, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '--reporter=json', '--outputFile=' + report])
        const actual = JSON.parse(await readFile(report, 'utf8')); receipt.adjacent.push({ label, ...result, collected: actual.numTotalTests, passed: actual.numPassedTests, failed: actual.numFailedTests }); assert.equal(result.code, 0); assert.equal(actual.numTotalTests, count); assert.equal(actual.numFailedTests, 0)
      }
      const appFile = 'apps/desktop/src/renderer/src/App.tsx', global = await readFile(join(root, product[0]), 'utf8'), local = await readFile(join(root, product[2]), 'utf8')
      assert.match(await readFile(join(root, appFile), 'utf8'), /<GlobalFocusSurface\b/); receipt.callers.GlobalFocusSurface = [appFile]
      assert.match(global, /<FocusLaneGroups\b/); receipt.callers.FocusLaneGroups = [product[0]]
      assert.match(global, /<FocusProjectLanes\b[^>]*rowsRef=/); receipt.callers.mainLaneMeasurement = [product[0], product[1]]
      assert.match(local, /allocateFocusLaneColumns\(/); receipt.callers.allocateFocusLaneColumns = [product[2]]
    } else {
      assert.equal(slice, 'height-scene')
      const scenePath = process.env.AGENTMUX_FOCUS_LANE_HEIGHT_SCENE_RECEIPT
      assert.ok(scenePath, 'Exact height scene and independent image review required')
      const scene = JSON.parse(await readFile(scenePath, 'utf8')), sceneDir = resolve(scenePath, '..')
      const reviewPath = join(sceneDir, 'visual-review.json'), review = JSON.parse(await readFile(reviewPath, 'utf8'))
      assert.equal(scene.capturedPass, true); assert.equal(scene.heightScene, true); assert.equal(scene.actual.passed, true)
      assert.equal(review.verdict, 'pass'); assert.ok(review.reviewerAgentId); assert.equal(review.sceneReceiptSHA256, hash(await readFile(scenePath)))
      assert.deepEqual(scene.sourceAfter, scene.inputs)
      for (const [file, sha] of Object.entries(scene.inputs)) assert.equal(hash(await readFile(join(root, file))), sha, 'Exact current scene input ' + file)
      assert.ok(scene.frames.length > 0); assert.equal(review.viewedImages.length, scene.frames.length)
      for (const frame of scene.frames) { assert.equal(hash(await readFile(join(sceneDir, frame.file))), frame.sha256); assert.ok(review.viewedImages.some(image => image.path === frame.file && image.sha256 === frame.sha256 && image.viewed === true)) }
      assert.equal(scene.actual.geometryPass, true); assert.equal(scene.actual.loadedCSSRed.failure.name, 'AssertionError')
      assert.equal(scene.actual.restart.passed, true); assert.notEqual(scene.actual.restart.firstPID, scene.actual.restart.secondPID); assert.equal(scene.actual.restart.secondSeedCount, 0)
      assert.equal(scene.actual.restart.originalStoreRestore, true); assert.equal(scene.cleanup.removed, true); assert.deepEqual(scene.cleanup.remaining, [])
      assert.equal(scene.userAppRunRuntimeControlled, false)
      receipt.scene = { path: scenePath, sha256: hash(await readFile(scenePath)), independentReview: reviewPath, independentReviewSHA256: hash(await readFile(reviewPath)) }
    }
    receipt.sourceAfter = await bindings(); assert.deepEqual(receipt.sourceAfter, before)
    for (const check of receipt.types) assert.equal(check.code, 0, await readFile(join(out, check.log), 'utf8'))
    receipt.passed = true
  } catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally { await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, evidence: out, failure: receipt.failure?.message, wholeFocusDone: false })) }
}
