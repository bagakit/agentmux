import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), output = resolve(root, `.tmp/focus-message-author-consumer-qualification-${Date.now()}`)
mkdirSync(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const paths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/src/renderer/src/lib/conversation-speaker.ts', 'apps/desktop/src/renderer/src/styles/activity-conversation.css', 'apps/desktop/src/renderer/src/styles/conversation-avatar.css', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/test/focus-message-author-consumer.test.tsx', 'apps/desktop/scripts/fixtures/focus-message-author-consumer/vitest.owning.config.mts']
const binding = () => Object.fromEntries(paths.map(file => [file, hash(readFileSync(resolve(root, file)))]))
const slice = process.argv[process.argv.indexOf('--slice') + 1]; assert.ok(['source', 'visual'].includes(slice))
const receipt = { schema: 'agentmux.focus-message-author-consumer-qualification.v1', passed: false, sourcePass: false, taskDone: false, slice, before: binding(), stages: [], boundary: 'Focus author consumption only. Genuine controlled manual Composer/Main/Core accepted receipt/FileStore/public projection and compiled UI; no physical human/CLI/Runtime, writer-wide qualification, full App restart or user installation.' }
function run(label, command, mutation) {
  const report = resolve(output, `${label}.json`), loaded = resolve(output, `${label}.loaded.jsonl`)
  const env = { ...process.env, AGENTMUX_FOCUS_AUTHOR_LOADED_SOURCE: loaded }
  delete env.AGENTMUX_FOCUS_AUTHOR_MUTATION
  if (mutation) env.AGENTMUX_FOCUS_AUTHOR_MUTATION = mutation
  if (label === 'baseline') env.AGENTMUX_FOCUS_AUTHOR_PRODUCER_OUTPUT = resolve(output, 'public-producer.json')
  const args = command ?? [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/focus-message-author-consumer/vitest.owning.config.mts', '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  writeFileSync(resolve(output, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  const stage = { label, command: args, exitCode: result.status, error: result.error?.message, mutation: mutation ?? null }; receipt.stages.push(stage)
  if (!command) {
    const tests = JSON.parse(readFileSync(report))
    const assertions = tests.testResults.flatMap(file => file.assertionResults), failed = assertions.filter(item => item.status === 'failed')
    assert.ok(assertions.length > 0, `${label} collected no actual assertions; original preparation output is retained`)
    const modules = readFileSync(loaded, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(modules.length > 0)
    const ownerPath = mutation === 'human-as-agent' ? paths[0] : paths[1]
    const owner = modules.find(item => item.path === ownerPath); assert.ok(owner); assert.equal(owner.originalSHA256, receipt.before[owner.path])
    Object.assign(stage, { tests: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests, reportSHA256: hash(readFileSync(report)), loadedSHA256: hash(readFileSync(loaded)), loadedOwner: owner })
    if (mutation) {
      assert.notEqual(result.status, 0); assert.ok(failed.length > 0)
      assert.ok(failed.every(item => item.failureMessages.some(message => message.includes('AssertionError'))), 'Loaded semantic mutations must fail actual assertions, not preparation/type/setup')
      assert.equal(owner.mutation, mutation); assert.notEqual(owner.sha256, owner.originalSHA256)
    } else { assert.equal(result.status, 0); assert.equal(tests.success, true); assert.equal(owner.sha256, owner.originalSHA256) }
  } else assert.equal(result.status, 0, `${label} failed; original output retained`)
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(`${label}: actual exit ${result.status}`); return stage
}
try {
  const providerFile = process.env.AGENTMUX_FOCUS_AUTHOR_PROVIDER_BINDING
  assert.ok(providerFile, 'A Root approved precise T041 Main/ABI/receipt binding is required; Source appearance is not approval')
  const providerBytes = readFileSync(resolve(root, providerFile)), provider = JSON.parse(providerBytes)
  assert.equal(provider.status, 'approved'); assert.ok(provider.mainCommit?.length === 40); assert.ok(provider.contract?.path && provider.contract.sha256); assert.ok(provider.receipt?.path && provider.receipt.sha256)
  assert.equal(hash(readFileSync(resolve(root, provider.contract.path))), provider.contract.sha256); assert.equal(hash(readFileSync(resolve(root, provider.receipt.path))), provider.receipt.sha256)
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', provider.mainCommit, 'HEAD'], { cwd: root }).status, 0)
  receipt.provider = { file: providerFile, sha256: hash(providerBytes), ...provider }
  if (slice === 'source') {
    const baseline = run('baseline')
    for (const mutation of ['unknown-as-human', 'human-as-agent', 'body-bypasses-speaker']) { assert.equal(run(mutation, undefined, mutation).tests, baseline.tests); assert.equal(run(`${mutation}-exact-restore`).tests, baseline.tests) }
    const producer = JSON.parse(readFileSync(resolve(output, 'public-producer.json')))
    assert.equal(producer.schema, 'agentmux.focus-author-public-producer.v1'); assert.equal(producer.messages.length, 5)
    assert.deepEqual(producer.messages.map(item => item.author.kind), ['unknown', 'unknown', 'human', 'agent', 'unknown']); assert.equal(new Set(producer.messages.map(item => item.id)).size, 5)
    receipt.producer = { file: relative(root, resolve(output, 'public-producer.json')), sha256: hash(readFileSync(resolve(output, 'public-producer.json'))) }
    for (const [name, config] of [
      ['T037', 'apps/desktop/scripts/fixtures/focus-message-sender-association/vitest.owning.config.mts'],
      ['native', 'apps/desktop/scripts/fixtures/focus-message-sender-association/vitest.native.config.mts'],
      ['readonly', 'apps/desktop/scripts/fixtures/focus-project-history/vitest.renderer-history.config.mts']
    ]) {
      const report = resolve(output, `adjacent-${name}.json`)
      run(`adjacent-${name}`, [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`])
      const actual = JSON.parse(readFileSync(report)); assert.ok(actual.numTotalTests > 0); assert.equal(actual.numPassedTests, actual.numTotalTests); assert.equal(actual.numFailedTests, 0)
      Object.assign(receipt.stages.at(-1), { tests: actual.numTotalTests, passed: actual.numPassedTests, failed: actual.numFailedTests, reportSHA256: hash(readFileSync(report)) })
    }
    run('production-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
    run('owning-types', [process.execPath, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/focus-message-author-consumer/tsconfig.owning.json'])
    const callers = { TimelineSpeaker: [paths[0], 'speakerOfUserMessage(message)'], PreviewSpeaker: [paths[1], 'speakerOfUserMessage(message)'], ReaderSpeaker: [paths[1], 'speakerOfUserMessage(item)'], PreviewResolver: [paths[1], 'describeSpeaker(speaker)'], ReaderResolver: [paths[1], 'describeSpeaker(itemSpeaker)'], TimelineResolver: [paths[0], 'createSpeakerResolver({ lookupAgent:'], TimelineAvatar: [paths[0], '<ConversationSpeakerAvatar '], PreviewAvatar: [paths[1], '<ConversationSpeakerAvatar '], Timeline: ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', '<RecentFocusTimeline '] }
    receipt.callers = Object.fromEntries(Object.entries(callers).map(([key, [file, needle]]) => { const source = readFileSync(resolve(root, file), 'utf8'), start = source.indexOf(needle); assert.ok(start >= 0); return [key, { file, line: source.slice(0, start).split('\n').length, needle }] }))
    receipt.sourcePass = true
  } else {
    const sceneFile = process.env.AGENTMUX_FOCUS_AUTHOR_SCENE_RECEIPT, reviewFile = process.env.AGENTMUX_FOCUS_AUTHOR_VISUAL_REVIEW
    assert.ok(sceneFile && reviewFile, 'Actual compiled scenes and independent Agent visual review required')
    const bytes = readFileSync(resolve(root, sceneFile)), reviewBytes = readFileSync(resolve(root, reviewFile)), scene = JSON.parse(bytes), review = JSON.parse(reviewBytes)
    assert.equal(scene.passed, true); assert.deepEqual(scene.actual.controls, ['focus-author-sender']); assert.equal(scene.cleanup.privateRootRemoved, true); assert.ok(scene.images.length >= 5)
    for (const file of paths.slice(0, 6)) assert.equal(scene.inputs[file], receipt.before[file])
    assert.equal(review.verdict, 'pass'); assert.ok(review.reviewerAgentId?.length > 0); assert.equal(review.sceneReceiptSHA256, hash(bytes))
    for (const image of scene.images) { const actualPath = resolve(dirname(resolve(root, sceneFile)), image.path); assert.equal(hash(readFileSync(actualPath)), image.sha256); assert.ok(review.viewedImages.some(item => (item.path === image.path || resolve(root, item.path) === actualPath) && item.sha256 === image.sha256 && item.observation?.trim().length > 0)) }
    receipt.scene = { file: sceneFile, sha256: hash(bytes), images: scene.images }; receipt.visualReview = { file: reviewFile, sha256: hash(reviewBytes), reviewerAgentId: review.reviewerAgentId }
  }
  receipt.after = binding(); assert.deepEqual(receipt.after, receipt.before); receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { writeFileSync(resolve(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, sourcePass: receipt.sourcePass, taskDone: receipt.taskDone, receipt: relative(root, resolve(output, 'receipt.json')) })) }
