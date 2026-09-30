import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(root, `.tmp/focus-conversation-metadata-qualification-${Date.now()}`)
mkdirSync(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourcePaths = [
  'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx',
  'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx',
  'apps/desktop/src/renderer/src/components/ConversationMessage.tsx',
  'apps/desktop/src/renderer/src/components/ConversationMessageAvatar.tsx',
  'apps/desktop/src/renderer/src/components/ConversationInputDetails.tsx',
  'apps/desktop/src/renderer/src/lib/conversation-speaker.ts',
  'apps/desktop/src/renderer/src/lib/conversation-sender-details.ts',
  'apps/desktop/src/renderer/src/lib/session-user-messages.ts',
  'apps/desktop/src/renderer/src/styles/focus.css',
  'apps/desktop/test/focus-conversation-metadata-consumer.test.tsx',
  'apps/desktop/scripts/fixtures/focus-conversation-metadata-consumer/vitest.owning.config.mts'
]
const binding = () => Object.fromEntries(sourcePaths.map(file => [file, hash(readFileSync(resolve(root, file)))]))
const slice = process.argv[process.argv.indexOf('--slice') + 1]
assert.ok(['source', 'visual'].includes(slice))
const receipt = { schema: 'agentmux.focus-conversation-metadata-consumer-qualification.v1', passed: false,
  taskDone: false, slice, before: binding(), stages: [],
  boundary: 'Focus consumption only. Sealed genuine public producer records are not new writer/reader qualification. No shared Core/Hook or common Conversation edits, full App build, packaging, user controls or whole Focus acceptance.' }
const save = () => writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
function run(label, command, mutation) {
  const report = resolve(output, `${label}.json`), loaded = resolve(output, `${label}.loaded.jsonl`)
  const env = { ...process.env, AGENTMUX_FOCUS_METADATA_LOADED_SOURCE: loaded }
  delete env.AGENTMUX_FOCUS_METADATA_MUTATION
  if (mutation) env.AGENTMUX_FOCUS_METADATA_MUTATION = mutation
  const args = command ?? [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config',
    'apps/desktop/scripts/fixtures/focus-conversation-metadata-consumer/vitest.owning.config.mts',
    '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  const stage = { label, command: args, exitCode: result.status, error: result.error?.message, mutation: mutation ?? null }
  receipt.stages.push(stage); save()
  if (command) { assert.equal(result.status, 0, `${label} failed; original output is retained`); return stage }
  const tests = JSON.parse(readFileSync(report)), assertions = tests.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length > 0, 'Literal owning collected no actual assertions')
  const failed = assertions.filter(item => item.status === 'failed')
  const modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(modules.length > 0, 'No actual production modules loaded')
  const ownerPath = mutation === 'drop-controlled-props' ? sourcePaths[1] : sourcePaths[0]
  const owner = modules.find(item => item.path === ownerPath)
  assert.ok(owner); assert.equal(owner.originalSHA256, receipt.before[owner.path])
  Object.assign(stage, { tests: assertions.length, passed: tests.numPassedTests, failed: tests.numFailedTests,
    reportSHA256: hash(readFileSync(report)), loadedSHA256: hash(readFileSync(loaded)), loadedCount: modules.length, owner })
  if (mutation) {
    assert.notEqual(result.status, 0); assert.ok(failed.length > 0)
    assert.ok(failed.every(item => item.failureMessages.some(message => message.includes('AssertionError'))),
      'Only loaded semantic AssertionRED qualifies; preparation errors are preserved separately')
    assert.equal(owner.mutation, mutation); assert.notEqual(owner.sha256, owner.originalSHA256)
  } else {
    assert.equal(result.status, 0); assert.equal(tests.success, true)
    assert.equal(owner.sha256, owner.originalSHA256)
  }
  save(); console.log(`${label}: actual ${stage.passed} GREEN/${stage.failed} RED`)
  return stage
}
try {
  const producerPath = 'docs/reviews/evidence/focus-conversation-metadata-consumer-2026-10-04/public-producer.json'
  const producerBytes = readFileSync(resolve(root, producerPath)), producer = JSON.parse(producerBytes)
  assert.equal(hash(producerBytes), 'eb3f0a68f5068ed2bb66dc11f2b6f744d7527cdaacecdc5c257e5482716d88ab')
  assert.equal(producer.schema, 'agentmux.focus-author-public-producer.v1')
  assert.deepEqual(producer.messages.map(message => message.author.kind), ['unknown', 'unknown', 'human', 'agent', 'unknown'])
  assert.equal(new Set(producer.messages.map(message => message.id)).size, 5)
  receipt.producer = { file: producerPath, sha256: hash(producerBytes), boundary: producer.boundary }
  if (slice === 'source') {
    const baseline = run('baseline')
    for (const mutation of ['drop-controlled-props', 'borrow-recipient-project', 'eager-goals']) {
      assert.equal(run(mutation, undefined, mutation).tests, baseline.tests)
      assert.equal(run(`${mutation}-exact-restore`).tests, baseline.tests)
    }
    for (const [label, config] of [
      ['sender', 'apps/desktop/scripts/fixtures/focus-message-sender-association/vitest.owning.config.mts'],
      ['adjacent', 'apps/desktop/scripts/fixtures/focus-message-sender-association/vitest.adjacent.config.mts']
    ]) {
      const report = resolve(output, `${label}-tests.json`)
      run(label, [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`])
      const tests = JSON.parse(readFileSync(report)); assert.ok(tests.numTotalTests > 0)
      assert.equal(tests.numPassedTests, tests.numTotalTests); assert.equal(tests.numFailedTests, 0)
      Object.assign(receipt.stages.at(-1), { tests: tests.numTotalTests, passed: tests.numPassedTests,
        reportSHA256: hash(readFileSync(report)) })
    }
    run('production-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
    run('owning-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p',
      'apps/desktop/scripts/fixtures/focus-conversation-metadata-consumer/tsconfig.owning.json'])
    const callers = {
      Metadata: [sourcePaths[0], 'currentConversationSpeakerMetadata(id,'],
      ExplicitDetails: [sourcePaths[0], 'return currentConversationSenderDetails(id,'],
      CommonProps: [sourcePaths[1], 'describeSpeaker={describeSpeaker} inputSource={message.source} conversationSessionId={message.agentSessionId}'],
      Preview: [sourcePaths[0], '<FocusMessagePreview describeSpeaker={describePreviewSpeaker}'],
      Timeline: ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', '<RecentFocusTimeline ']
    }
    receipt.callers = Object.fromEntries(Object.entries(callers).map(([symbol, [file, needle]]) => {
      const source = readFileSync(resolve(root, file), 'utf8'), start = source.indexOf(needle)
      assert.ok(start >= 0, `${symbol} has no product caller outside its defining file`)
      return [symbol, { file, line: source.slice(0, start).split('\n').length, needle }]
    }))
  } else {
    const sceneFile = process.env.AGENTMUX_FOCUS_METADATA_SCENE_RECEIPT
    const reviewFile = process.env.AGENTMUX_FOCUS_METADATA_VISUAL_REVIEW
    assert.ok(sceneFile && reviewFile, 'Actual compiled scenes and independent Agent visual review required')
    const bytes = readFileSync(resolve(root, sceneFile)), scene = JSON.parse(bytes)
    const reviewBytes = readFileSync(resolve(root, reviewFile)), review = JSON.parse(reviewBytes)
    assert.equal(scene.passed, true); assert.ok(scene.images.length >= 4)
    for (const file of sourcePaths.slice(0, 9)) assert.equal(scene.inputs[file], receipt.before[file])
    assert.equal(scene.cleanup.privateRootRemoved, true)
    const css = scene.actualLoadedModules.filter(item => item.path === sourcePaths[8])
    assert.equal(css.length, 1); assert.ok(css[0].nodes > 0)
    assert.equal(css[0].originalSHA256, receipt.before[sourcePaths[8]])
    assert.equal(css[0].sha256, css[0].originalSHA256)
    assert.equal(scene.actual.loadedCSS.rules.length, 1); assert.ok(scene.actual.loadedCSS.stylesheets.length > 0)
    for (const stylesheet of scene.actual.loadedCSS.stylesheets)
      assert.equal(stylesheet.compiledSHA256, scene.compiled[stylesheet.compiledPath])
    assert.equal(scene.actual.headerCover.counterfactual.failure.name, 'AssertionError')
    assert.equal(scene.actual.headerCover.restored.validationStyles, 0)
    assert.equal(scene.actual.headerCover.restored.covered, true)
    assert.ok(scene.actual.frames.length > 0)
    for (const frame of scene.actual.frames) assert.equal(frame.validationStyles, 0)
    assert.equal(review.verdict, 'pass'); assert.ok(review.reviewerAgentId?.length > 0)
    assert.equal(review.sceneReceiptSHA256, hash(bytes))
    for (const image of scene.images) {
      const actualPath = resolve(dirname(resolve(root, sceneFile)), image.path)
      assert.equal(hash(readFileSync(actualPath)), image.sha256)
      assert.ok(review.viewedImages.some(item => (item.path === image.path || resolve(root, item.path) === actualPath)
        && item.sha256 === image.sha256 && item.observation?.trim().length > 0))
    }
    receipt.scene = { file: sceneFile, sha256: hash(bytes), images: scene.images }
    receipt.visualReview = { file: reviewFile, sha256: hash(reviewBytes), reviewerAgentId: review.reviewerAgentId }
  }
  receipt.after = binding(); assert.deepEqual(receipt.after, receipt.before); receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
} finally {
  save(); console.log(JSON.stringify({ passed: receipt.passed, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) }))
}
