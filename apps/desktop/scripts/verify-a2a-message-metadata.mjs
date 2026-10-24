import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { messageMetadataMutations } from './fixtures/a2a-message-metadata/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), area = resolve(root, '.local/a2a-message-metadata'), exec = promisify(execFile)
const config = 'apps/desktop/test/vitest.a2a-message-metadata.config.mts', hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n')
const args = process.argv.slice(2)
assert.ok(args.length === 1 && ['--behavior', '--prepare', '--acceptance'].includes(args[0]), 'Use --behavior, --prepare or --acceptance')
await mkdir(area, { recursive: true })
if (args[0] === '--acceptance') {
  const pointer = await json(resolve(area, 'isolated-current.json')).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (pointer) {
    const candidateRoot = await realpath(pointer.candidateRoot)
    assert.notEqual(candidateRoot, await realpath(root), 'The isolated candidate must be a separate worktree')
    assert.match(pointer.tree, /^[a-f0-9]{40}$/u); assert.match(pointer.commit, /^[a-f0-9]{40}$/u)
    const git = async (cwd, args) => (await exec('git', args, { cwd })).stdout.trim()
    assert.equal(await git(root, ['write-tree']), pointer.tree, 'The whole root index must still be the verified candidate')
    assert.equal(await git(candidateRoot, ['rev-parse', 'HEAD']), pointer.commit, 'Original isolated candidate commit')
    assert.equal(await git(candidateRoot, ['rev-parse', 'HEAD^{tree}']), pointer.tree, 'Original isolated candidate tree')
    await git(candidateRoot, ['diff', '--quiet', pointer.commit, '--'])
    await git(candidateRoot, ['diff', '--cached', '--quiet', pointer.commit, '--'])
    const script = 'apps/desktop/scripts/verify-a2a-message-metadata.mjs'
    assert.equal(hash(await readFile(resolve(root, script))), hash(await readFile(resolve(candidateRoot, script))), 'The root and candidate use the same acceptance gate')
    await readFile(resolve(candidateRoot, '.local/a2a-message-metadata/isolated-current.json')).then(() => {
      assert.fail('The isolated candidate must not delegate acceptance again')
    }, error => { if (error.code !== 'ENOENT') throw error })
    const result = await exec(process.execPath, [resolve(candidateRoot, script), '--acceptance'], { cwd: candidateRoot, timeout: 60000, maxBuffer: 1024 * 1024 })
    await git(candidateRoot, ['diff', '--quiet', pointer.commit, '--'])
    await git(candidateRoot, ['diff', '--cached', '--quiet', pointer.commit, '--'])
    assert.equal(await git(root, ['write-tree']), pointer.tree, 'The root index stayed on the verified candidate')
    console.log(result.stdout.trim()); process.exit(0)
  }
}
async function currentSources(sources) {
  assert.ok(Object.keys(sources).length > 0, 'The actual consumed source set must be nonempty')
  for (const [file, digest] of Object.entries(sources)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Current consumed source: ' + file)
}
if (args[0] === '--behavior') {
  const output = await mkdtemp(resolve(area, 'behavior-')), sources = {}, runs = [], artifacts = {}
  async function tests(label, edit, bridge = edit?.tests?.includes('apps/desktop/test/a2a-message-data-bridge.test.tsx') ?? false) {
    const report = resolve(output, label + '.json'), loaded = resolve(output, label + '-inputs.jsonl'), log = resolve(output, label + '.log')
    let exitCode = 0, text
    try { const result = await exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile=' + report, ...(edit?.tests ?? [])],
      { cwd: root, env: { ...process.env, AGENTMUX_MESSAGE_METADATA_BRIDGE: bridge ? '1' : '', AGENTMUX_MESSAGE_METADATA_MUTATION: edit?.name ?? '', AGENTMUX_MESSAGE_METADATA_LOADED: loaded,
        ...(edit ? {} : { AGENTMUX_MESSAGE_METADATA_SCENE: resolve(output, 'scene.json') }) }, timeout: 90000, maxBuffer: 8 * 1024 * 1024 }); text = result.stdout + result.stderr }
    catch (error) { assert.equal(error.killed, false, 'Interrupted run cannot prove behavior'); exitCode = error.code; text = (error.stdout ?? '') + (error.stderr ?? '') }
    await writeFile(log, text)
    const result = await json(report), inputs = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(result.numTotalTests >= 1); assert.equal(result.numPendingTests, 0); assert.equal(result.numTodoTests, 0)
    assert.ok(result.testResults.length === (edit?.tests?.length ?? (bridge ? 1 : 4)) && inputs.length > 0, 'Owner and actual consumer suites must execute')
    if (!edit && !bridge) assert.ok(inputs.some(input => input.consumer === 'source-cli' && input.path === 'packages/core/src/agentmux-cli-commands.ts'), 'The actual source CLI must consume this candidate')
    const changed = new Set()
    for (const input of inputs) {
      assert.equal(input.original, hash(await readFile(resolve(root, input.path))), 'Actual consumed source: ' + input.path)
      if (sources[input.path]) assert.equal(sources[input.path], input.original, 'One candidate through behavior proof')
      sources[input.path] = input.original
      if (input.compiled !== input.input) changed.add(input.path)
    }
    if (edit) {
      assert.equal(exitCode, 1); assert.ok(result.numFailedTests > 0)
      assert.ok(result.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))), 'Mutation must be caught by an actual assertion')
      assert.deepEqual([...changed], [edit.path])
    } else { assert.equal(exitCode, 0, text); assert.equal(result.numFailedTests, 0); assert.equal(changed.size, 0) }
    for (const file of [report, loaded, log]) artifacts[relative(root, file)] = hash(await readFile(file))
    runs.push({ label, mutation: edit?.name ?? null, exitCode, tests: result.numTotalTests, failures: result.numFailedTests })
    console.log(label + ': ' + (edit ? 'behavior RED' : 'GREEN'))
  }
  assert.ok(messageMetadataMutations.length > 0, 'The actual behavioral mutation set must be nonempty')
  await tests('baseline')
  await tests('bridge-baseline', undefined, true)
  for (const edit of messageMetadataMutations) await tests(edit.name, edit)
  await tests('restored')
  await tests('bridge-restored', undefined, true)
  for (const file of ['packages/core/src/agent-global-message-queue.ts', 'packages/core/src/client.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ConversationA2AMetadata.tsx', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
    'packages/client-ui/src/components/ConversationA2AReferences.tsx', 'packages/client-ui/src/components/ConversationNotificationDetails.tsx',
    'apps/desktop/src/renderer/src/components/ActivityView.tsx', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx',
    'apps/mobile/src/conversation/MobileConversationSurface.tsx']) assert.ok(sources[file], 'Nonempty actual production owner/consumer set: ' + file)
  for (const file of [config, 'apps/desktop/scripts/verify-a2a-message-metadata.mjs', 'apps/desktop/scripts/fixtures/a2a-message-metadata/mutations.mjs', 'apps/desktop/scripts/fixtures/a2a-message-metadata/source-loader.mjs']) sources[file] = hash(await readFile(resolve(root, file)))
  artifacts[relative(root, resolve(output, 'scene.json'))] = hash(await readFile(resolve(output, 'scene.json')))
  const receipt = relative(root, resolve(output, 'receipt.json'))
  await writeJson(resolve(root, receipt), { passed: true, sources, artifacts, runs, scene: relative(root, resolve(output, 'scene.json')) })
  await writeJson(resolve(area, 'behavior-current.json'), { receipt }); console.log(JSON.stringify({ passed: true, receipt, mutations: messageMetadataMutations.length }))
  process.exit(0)
}
const index = await json(resolve(area, 'behavior-current.json')), behavior = await json(resolve(root, index.receipt))
assert.equal(behavior.passed, true); await currentSources(behavior.sources)
for (const [file, digest] of Object.entries(behavior.artifacts)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Bound behavior evidence: ' + file)
if (args[0] === '--prepare') {
  const output = await mkdtemp(resolve(area, 'visual-'))
  const { capturePrimaryReading } = await import('./fixtures/a2a-primary-reading/capture.mjs')
  const capture = await capturePrimaryReading({ root, evidence: output, scene: resolve(root, behavior.scene), metadata: true })
  const sources = { ...behavior.sources }
  for (const [file, digest] of Object.entries(capture.inputs)) { if (sources[file]) assert.equal(sources[file], digest, 'One joined behavior/Renderer candidate'); sources[file] = digest }
  const captureFile = relative(root, resolve(output, 'capture.json')), captureSha256 = hash(await readFile(resolve(root, captureFile)))
  const receipt = relative(root, resolve(output, 'receipt.json'))
  await writeJson(resolve(root, receipt), { prepared: true, sources, behaviorReceipt: index.receipt, behaviorSha256: hash(await readFile(resolve(root, index.receipt))),
    captureFile, captureSha256, captureDirectory: relative(root, output), sourceIdentity: capture.sourceIdentity })
  await writeJson(resolve(area, 'current.json'), { receipt })
  await writeFile(resolve(output, 'review.md'), ['# A2A 时间与模式独立看图评审', '',
    '请实际打开全部 PNG，判断三个真实消费者中的正文主次、发送/确认/模式、历史缺时间、未确认与已确认区分、首层准确身份、窄宽换行、对齐、留白与 Info 详情。',
    '数据来自生产 journal 和 Core public Reader，图像证明私有 Renderer 产品组合；实际 source CLI/RPC 由行为证据单独证明。两者不证明已安装 App、真实模型或 Session 生命周期。', '',
    ...capture.render.frames.map(frame => `- [${frame.file}](${frame.file}) · SHA256 ${frame.sha256}`), '',
    '评审保存到 .local/a2a-message-metadata/visual-review.json，字段为 decision、reviewer（独立 Agent 身份）、sourceIdentity、captureSha256、reviewedFrames（file 和 sha256）、findings。',
    `sourceIdentity: ${capture.sourceIdentity}`, `captureSha256: ${captureSha256}`, ''].join('\n'))
  console.log(JSON.stringify({ prepared: true, receipt, review: relative(root, resolve(output, 'review.md')), frames: capture.render.frames.length }))
  process.exit(0)
}
const current = await json(resolve(area, 'current.json')), receipt = await json(resolve(root, current.receipt))
assert.equal(receipt.prepared, true); await currentSources(receipt.sources)
assert.equal(receipt.behaviorReceipt, index.receipt); assert.equal(hash(await readFile(resolve(root, index.receipt))), receipt.behaviorSha256)
assert.equal(hash(await readFile(resolve(root, receipt.captureFile))), receipt.captureSha256)
const capture = await json(resolve(root, receipt.captureFile)), review = await json(resolve(area, 'visual-review.json'))
assert.equal(capture.completed, true); assert.equal(capture.privateRootRemoved, true); assert.deepEqual(capture.remainingPrivateProcesses, []); assert.deepEqual(capture.drift, [])
assert.equal(review.decision, 'approved'); assert.ok(typeof review.reviewer === 'string' && review.reviewer.length > 0, 'Actual independent Agent reviewer is required')
assert.equal(review.sourceIdentity, capture.sourceIdentity); assert.equal(review.captureSha256, receipt.captureSha256)
assert.ok(capture.render.frames.length === 15); assert.deepEqual(review.reviewedFrames, capture.render.frames.map(({ file, sha256 }) => ({ file, sha256 })))
for (const frame of capture.render.frames) assert.equal(hash(await readFile(resolve(root, receipt.captureDirectory, frame.file))), frame.sha256, 'Actually reviewed frame: ' + frame.file)
console.log(JSON.stringify({ passed: true, receipt: current.receipt, mutations: messageMetadataMutations.length, images: review.reviewedFrames.length, reviewer: review.reviewer }))
