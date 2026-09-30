import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

/** The two outcomes share one Timeline owner and one lightweight visual receipt. */
export function qualifyFocusReading(kind) {
  const root = resolve(import.meta.dirname, '../../..')
  const output = resolve(root, `.tmp/focus-timeline-${kind}-qualification-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const hash = value => createHash('sha256').update(value).digest('hex')
  const product = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx']
  const config = `apps/desktop/scripts/fixtures/focus-project-history/vitest.${kind}.config.mts`
  const paths = [...product, `apps/desktop/test/focus-timeline-${kind}.test.tsx`, 'apps/desktop/test/fixtures/focus-history-public.tsx', config]
  const binding = () => Object.fromEntries(paths.map(file => [file, hash(readFileSync(resolve(root, file)))]))
  const prefix = kind === 'read-coverage' ? 'AGENTMUX_FOCUS_READ_COVERAGE' : 'AGENTMUX_FOCUS_FACT_LEGEND'
  const mutations = kind === 'read-coverage'
    ? { 'clear-other-sources': 'keeps both genuine', 'partition-budget': 'bounds native raw|caps captured|enforces aggregate', 'late-scope': 'retains valid accepted A', 'pinned-recipient-hidden': 'bounds native raw' }
    : { 'legend-disconnected': 'retains coverage distinctions', 'alive-as-work': 'shows four distinct meanings', 'coverage-removed': 'retains coverage distinctions' }
  const receipt = { schema: `agentmux.focus-timeline-${kind}-qualification.v1`, passed: false, sourcePass: false, taskDone: false, before: binding(), stages: [], boundary: 'Genuine private FileStore/public Reader/registered IPC/preload/Store/mounted Timeline, plus separately qualified lightweight compiled presentation. Current semantic/geometry fixture observations do not qualify physical healthy Runs, Writer, ordinary App restart or installation.' }
  const save = () => writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  function run(label, command, mutation, selection) {
    const report = resolve(output, `${label}.json`), loaded = resolve(output, `${label}.loaded.ndjson`)
    const env = { ...process.env, [`${prefix}_LOADED_SOURCE`]: loaded }
    delete env[`${prefix}_MUTATION`]; delete env.AGENTMUX_RETIRED_FOCUS_MUTATION
    if (mutation) env[`${prefix}_MUTATION`] = mutation
    const args = command ?? [process.execPath, '--max-old-space-size=768', 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', ...(selection ? ['-t', selection] : []), '--reporter=json', `--outputFile=${report}`]
    const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
    const stage = { label, command: args, exitCode: result.status, mutation: mutation ?? null, error: result.error?.message }
    receipt.stages.push(stage); save()
    if (!command) {
      const tests = JSON.parse(readFileSync(report)), assertions = tests.testResults.flatMap(file => file.assertionResults)
      const actual = assertions.filter(item => item.status !== 'pending' && item.status !== 'skipped')
      const failures = assertions.filter(item => item.status === 'failed')
      const modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert.ok(actual.length > 0); assert.ok(modules.length > 0)
      const ownerPath = mutation === 'pinned-recipient-hidden' ? product[3] : product[0]
      const owner = modules.find(item => item.path === ownerPath); assert.ok(owner)
      assert.equal(owner.originalSHA256, receipt.before[ownerPath])
      Object.assign(stage, { actualTests: actual.length, totalTests: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests, reportSHA256: hash(readFileSync(report)), loadedSHA256: hash(readFileSync(loaded)), owner })
      if (mutation) {
        assert.notEqual(result.status, 0); assert.ok(failures.length > 0)
        assert.ok(failures.every(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Loaded semantic RED cannot be replaced by setup/collect/timeout')
        assert.equal(owner.mutation, mutation); assert.notEqual(owner.sha256, owner.originalSHA256)
      } else { assert.equal(result.status, 0); assert.equal(tests.success, true); assert.equal(owner.sha256, owner.originalSHA256) }
    } else assert.equal(result.status, 0, `${label} actual failure; original output retained`)
    save(); console.log(`${kind}/${label}: actual exit ${result.status}`)
  }
  try {
    run('baseline')
    for (const [mutation, selection] of Object.entries(mutations)) {
      run(mutation, undefined, mutation, selection)
      run(`${mutation}-exact-restore`, undefined, undefined, selection)
    }
    run('production-types', [process.execPath, '--max-old-space-size=768', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
    run('owning-types', [process.execPath, '--max-old-space-size=768', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', `apps/desktop/scripts/fixtures/focus-project-history/tsconfig.${kind}.json`])
    const callers = { RecentFocusTimeline: ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', '<RecentFocusTimeline '], groupFocusTimeline: [product[0], 'groupFocusTimeline(contexts,'], historyPage: [product[0], 'api.sessions.historyPage(control,'] }
    receipt.callers = Object.fromEntries(Object.entries(callers).map(([symbol, [file, needle]]) => {
      const source = readFileSync(resolve(root, file), 'utf8'), index = source.indexOf(needle)
      assert.ok(index >= 0, `${symbol}: nonempty product caller outside its definition file`)
      return [symbol, { file, line: source.slice(0, index).split('\n').length, needle }]
    }))
    receipt.after = binding(); assert.deepEqual(receipt.after, receipt.before); receipt.sourcePass = true; save()
    if (!process.argv.includes('--source-only')) {
      const sceneFile = resolve(root, process.env.AGENTMUX_FOCUS_READ_COVERAGE_SCENE_RECEIPT ?? '.tmp/focus-timeline-read-coverage-scene-recipient-proof-final/receipt.json')
      const reviewFile = resolve(root, process.env.AGENTMUX_FOCUS_READ_COVERAGE_VISUAL_REVIEW ?? resolve(dirname(sceneFile), 'visual-review.json'))
      const sceneBytes = readFileSync(sceneFile), reviewBytes = readFileSync(reviewFile)
      const scene = JSON.parse(sceneBytes), review = JSON.parse(reviewBytes)
      assert.equal(scene.schema, 'agentmux.focus-timeline-read-coverage-scene.v1'); assert.equal(scene.passed, true)
      for (const file of product) assert.equal(scene.inputs[file], receipt.before[file])
      assert.deepEqual(scene.actual.controls, []); assert.equal(scene.cleanup.privateRootRemoved, true)
      assert.ok(scene.images.length >= 2); assert.ok(scene.images.some(image => image.width === 320)); assert.ok(scene.images.some(image => image.width >= 1100))
      assert.equal(review.verdict, 'pass'); assert.ok(review.reviewerAgentId?.trim().length > 0); assert.equal(review.sceneReceiptSHA256, hash(sceneBytes))
      for (const image of scene.images) {
        assert.equal(hash(readFileSync(resolve(dirname(sceneFile), image.path))), image.sha256)
        assert.ok(review.viewedImages.some(item => item.path === image.path && item.sha256 === image.sha256 && item.observation?.trim().length > 0))
      }
      receipt.scene = { file: relative(root, sceneFile), sha256: hash(sceneBytes), images: scene.images, compiled: scene.compiled }
      receipt.visualReview = { file: relative(root, reviewFile), sha256: hash(reviewBytes), reviewerAgentId: review.reviewerAgentId }
      receipt.taskDone = true
    }
    receipt.passed = true
  } catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally { save(); console.log(JSON.stringify({ sourcePass: receipt.sourcePass, passed: receipt.passed, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) })) }
}
