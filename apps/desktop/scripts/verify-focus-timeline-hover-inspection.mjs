import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), output = resolve(root, `.tmp/focus-timeline-hover-qualification-${Date.now()}`)
mkdirSync(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const owner = 'apps/desktop/src/renderer/src/components/'
const paths = [`${owner}RecentFocusTimeline.tsx`, `${owner}FocusMessagePreview.tsx`, `${owner}AgentAvatar.tsx`, 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/test/focus-timeline-hover-inspection.test.tsx', 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/vitest.owning.config.mts', 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/public-producer.json', 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/producer-reference.json', `${owner}ConversationMessage.tsx`, 'apps/desktop/src/renderer/src/lib/conversation-speaker.ts']
const binding = () => Object.fromEntries(paths.map(file => [file, hash(readFileSync(resolve(root, file)))]))
const slice = process.argv[process.argv.indexOf('--slice') + 1]; assert.ok(['source', 'visual'].includes(slice))
const receipt = { schema: 'agentmux.focus-timeline-hover-qualification.v1', passed: false, sourcePass: false, taskDone: false, slice, before: binding(), stages: [], boundary: 'Focus hover/pinned presentation. Consumes the sealed genuine manual IPC/Core/FileStore/public-projector inputs. No new writer, Runtime, whole App, restart, installation or healthy-user Run qualification.' }
function run(label, command, mutation) {
  const report = resolve(output, `${label}.json`), loaded = resolve(output, `${label}.loaded.jsonl`)
  const env = { ...process.env, AGENTMUX_FOCUS_HOVER_LOADED_SOURCE: loaded }; delete env.AGENTMUX_FOCUS_HOVER_MUTATION
  if (mutation) env.AGENTMUX_FOCUS_HOVER_MUTATION = mutation
  const args = command ?? [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/vitest.owning.config.mts', '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  const stage = { label, command: args, exitCode: result.status, error: result.error?.message, mutation: mutation ?? null }; receipt.stages.push(stage)
  if (!command) {
    const tests = JSON.parse(readFileSync(report)), assertions = tests.testResults.flatMap(file => file.assertionResults), failed = assertions.filter(item => item.status === 'failed')
    assert.ok(assertions.length > 0, `${label} has no collected assertions; preparation failures are not semantic RED`)
    const modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); assert.ok(modules.length > 0)
    const sourceOwner = modules.find(item => item.path === paths[mutation === 'quick-renders-full-body' ? 1 : 0]); assert.ok(sourceOwner); assert.equal(sourceOwner.originalSHA256, receipt.before[sourceOwner.path])
    Object.assign(stage, { tests: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests, reportSHA256: hash(readFileSync(report)), loadedSHA256: hash(readFileSync(loaded)), loadedOwner: sourceOwner })
    if (mutation) {
      assert.notEqual(result.status, 0); assert.ok(failed.length > 0)
      assert.ok(failed.every(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Only actually loaded product assertion failures qualify')
      assert.equal(sourceOwner.mutation, mutation); assert.notEqual(sourceOwner.sha256, sourceOwner.originalSHA256)
    } else { assert.equal(result.status, 0); assert.equal(tests.success, true); assert.equal(sourceOwner.sha256, sourceOwner.originalSHA256) }
  } else assert.equal(result.status, 0, `${label} failed; exact original output preserved`)
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(`${label}: actual exit ${result.status}`)
  return stage
}
try {
  const producer = JSON.parse(readFileSync(resolve(root, paths[6]))), reference = JSON.parse(readFileSync(resolve(root, paths[7])))
  assert.equal(producer.schema, 'agentmux.focus-author-public-producer.v1'); assert.equal(reference.sourceSHA256, receipt.before[paths[6]])
  assert.equal(producer.captured.items[0].authorHuman, true)
  assert.deepEqual(producer.messages.map(item => item.author.kind), ['unknown', 'unknown', 'human', 'agent', 'unknown']); assert.equal(new Set(producer.messages.map(item => item.id)).size, 5)
  receipt.publicProducer = { path: paths[6], sha256: receipt.before[paths[6]], reference, boundary: producer.boundary }
  if (slice === 'source') {
    const baseline = run('baseline')
    for (const mutation of ['cancelled-intent-reopens', 'history-uses-current-project', 'quick-renders-full-body']) {
      assert.equal(run(mutation, undefined, mutation).tests, baseline.tests)
      assert.equal(run(`${mutation}-exact-restore`).tests, baseline.tests)
    }
    for (const [name, config] of [
      ['T037', 'apps/desktop/scripts/fixtures/focus-message-sender-association/vitest.owning.config.mts'],
      ['authors', 'apps/desktop/scripts/fixtures/focus-message-author-consumer/vitest.owning.config.mts'],
      ['readonly', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.renderer-history.config.mts'],
      ['avatar', 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/vitest.avatar-adjacent.config.mts']
    ]) {
      const report = resolve(output, `adjacent-${name}.json`)
      run(`adjacent-${name}`, [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`])
      const actual = JSON.parse(readFileSync(report)); assert.ok(actual.numTotalTests > 0); assert.equal(actual.numPassedTests, actual.numTotalTests); assert.equal(actual.numFailedTests, 0)
      Object.assign(receipt.stages.at(-1), { tests: actual.numTotalTests, reportSHA256: hash(readFileSync(report)) })
    }
    run('production-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
    run('owning-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/tsconfig.owning.json'])
    const calls = { sharedAvatarDisclosure: [paths[0], 'size={14} disclosure={disclosure}'], previewIntent: [paths[0], 'onPreview={inspectMessage}'], preview: [paths[0], '<FocusMessagePreview '], commonBody: [paths[1], '<ConversationMessage '], parentTimeline: [`${owner}GlobalFocusSurface.tsx`, '<RecentFocusTimeline '] }
    receipt.callers = Object.fromEntries(Object.entries(calls).map(([key, [file, needle]]) => {
      const source = readFileSync(resolve(root, file), 'utf8'), at = source.indexOf(needle); assert.ok(at >= 0, `${key} product caller is empty`)
      return [key, { file, line: source.slice(0, at).split('\n').length, needle }]
    }))
    receipt.sourcePass = true
  } else {
    const sceneFile = process.env.AGENTMUX_FOCUS_HOVER_SCENE_RECEIPT, reviewFile = process.env.AGENTMUX_FOCUS_HOVER_VISUAL_REVIEW
    assert.ok(sceneFile && reviewFile, 'Actual current compiled scenes and independent Agent visual review are required')
    const bytes = readFileSync(resolve(root, sceneFile)), reviewBytes = readFileSync(resolve(root, reviewFile)), scene = JSON.parse(bytes), review = JSON.parse(reviewBytes)
    assert.equal(scene.passed, true); assert.equal(scene.cleanup.privateRootRemoved, true); assert.ok(scene.images.length >= 6)
    for (const file of paths.slice(0, 4)) assert.equal(scene.inputs[file], receipt.before[file])
    assert.equal(scene.publicProducer.sha256, receipt.before[paths[6]])
    assert.equal(review.verdict, 'pass'); assert.ok(review.reviewerAgentId?.length > 0); assert.equal(review.sceneReceiptSHA256, hash(bytes))
    for (const image of scene.images) {
      const actualPath = resolve(dirname(resolve(root, sceneFile)), image.path); assert.equal(hash(readFileSync(actualPath)), image.sha256)
      assert.ok(review.viewedImages.some(item => (item.path === image.path || resolve(root, item.path) === actualPath) && item.sha256 === image.sha256 && item.observation?.trim().length > 0))
    }
    receipt.scene = { file: sceneFile, sha256: hash(bytes), images: scene.images }; receipt.visualReview = { file: reviewFile, sha256: hash(reviewBytes), reviewerAgentId: review.reviewerAgentId }
  }
  receipt.after = binding(); assert.deepEqual(receipt.after, receipt.before); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, sourcePass: receipt.sourcePass, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) })) }
