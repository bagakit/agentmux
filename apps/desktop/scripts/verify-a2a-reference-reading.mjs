import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readingMutations } from './fixtures/a2a-reference-reading/mutations.mjs'
import { captureA2aReferenceReading } from './fixtures/a2a-reference-reading/capture.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

const root = resolve(import.meta.dirname, '../../..'), area = join(root, '.tmp/a2a-reference-reading')
const config = 'apps/desktop/scripts/fixtures/a2a-reference-reading/vitest.owning.config.mts'
const sources = [
  'apps/desktop/scripts/verify-a2a-reference-reading.mjs', config, 'apps/desktop/scripts/fixtures/a2a-reference-reading/mutations.mjs',
  'apps/desktop/scripts/fixtures/a2a-reference-reading/capture.mjs', 'apps/desktop/scripts/probe-process.mjs',
  'apps/desktop/scripts/candidate-package-resolve.mjs',
  'apps/desktop/test/a2a-message-data-bridge.test.tsx', 'apps/desktop/test/vitest.a2a-message-data.config.mts',
  'packages/core/src/agent-message-render.ts', 'packages/core/src/types.ts', 'packages/core/src/conversation-provenance.ts',
  'packages/core/src/conversation.ts', 'packages/core/src/session-inputs.ts', 'packages/core/src/session-history-content.ts',
  'packages/core/src/session-user-messages.ts', 'packages/conversation/src/conversation-stream.ts', 'packages/conversation/src/records.ts',
  'packages/core/src/amux-protocol-definition.ts',
  'packages/core/test/agent-message-reference-reading.test.ts', 'packages/core/test/agent-message-render.test.ts', 'packages/core/test/agent-message-leading-context.test.ts',
  ...['ConversationMessage', 'ConversationInputText', 'ConversationResourceText', 'CapturedConversationMessage', 'ConversationView', 'ConversationA2AReferences', 'ConversationA2AMetadata', 'ConversationNotificationDetails', 'ConversationMessageCard', 'ConversationToolPayload', 'ContentCopyButton', 'ConversationAmuxProtocol', 'ConversationProgressiveBody'].map(name => `packages/client-ui/src/components/${name}.tsx`),
  'packages/client-ui/src/platform.tsx', 'packages/client-ui/src/lib/use-content-copy-action.ts',
  'packages/client-ui/src/lib/conversation-speaker.ts',
  ...['conversation-message', 'conversation-a2a', 'conversation-protocol', 'conversation-input-details', 'conversation-tool-payload', 'markdown', 'input-history', 'composer', 'composer-editor'].map(name => `packages/client-ui/src/styles/${name}.css`),
  'apps/desktop/src/renderer/src/styles/mailbox-collaboration.css',
  'packages/client-ui/test/a2a-reference-reading.test.tsx', 'packages/client-ui/test/conversation-leading-context.test.tsx',
  'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx',
  'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/lib/clipboard-copy.ts',
  'apps/desktop/src/renderer/src/components/MailboxA2A.tsx', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
  'packages/client-ui/src/components/InputMailboxRecords.tsx',
  'apps/desktop/test/mailbox-a2a.test.tsx', 'apps/desktop/test/input-mailbox-body-boundary.test.tsx', 'apps/desktop/test/session-mailbox-author-boundary.test.tsx'
]
const currentTestInput = path => sources.includes(path) || path.startsWith('test/') || /\/(?:test|scripts\/fixtures|scripts\/lib)\//u.test(path)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const local = path => { assert.ok(!isAbsolute(path) && !path.split('/').includes('..')); return join(root, path) }
async function execute(executable, args, directory, name, environment = {}) {
  const result = await new Promise((yes, no) => {
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (exitCode, signal) => yes({ exitCode, signal, output }))
  })
  const log = join(directory, name + '.log'); await writeFile(log, result.output)
  assert.equal(result.signal, null)
  return { exitCode: result.exitCode, log: relative(root, log), argv: args }
}
async function tests(directory, name, mutation, subset) {
  const report = join(directory, name + '.json'), loaded = join(directory, name + '.loaded.jsonl')
  const processResult = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    ...(mutation || subset ? [mutation?.test ?? subset] : []), '--reporter=json', '--outputFile=' + report], directory, name,
  { AGENTMUX_A2A_REFERENCE_MUTATION: mutation?.label ?? '', AGENTMUX_A2A_REFERENCE_LOADED: loaded, AGENTMUX_A2A_REFERENCE_CACHE: join(directory, 'vite') })
  const result = { ...processResult, report: relative(root, report), loaded: relative(root, loaded) }
  await testFacts(result, mutation)
  return result
}
async function testFacts(run, mutation) {
  assert.ok(run.argv.includes(config))
  const report = await json(local(run.report)), cases = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(report.testResults.length > 0 && report.testResults.every(file => file.assertionResults.length > 0), 'Every owning test file collected real assertions')
  assert.ok(cases.length > 0); assert.equal(report.numTotalTests, cases.length)
  assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0)
  const inputs = (await readFile(local(run.loaded), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(inputs.length > 0 && inputs.every(input => !isAbsolute(input.path) && !input.path.startsWith('.worktrees/')))
  for (const input of inputs) {
    const path = local(input.path), edited = mutation?.path === input.path
    assert.match(input.sourceSHA256, /^[a-f0-9]{64}$/u); assert.match(input.compilerInputSHA256, /^[a-f0-9]{64}$/u)
    assert.ok(Number.isInteger(input.bytes) && input.bytes > 0, 'Actual compiler input bytes are recorded')
    // A loaded dependency is an original test condition, not a claim about the latest checkout.
    if (!currentTestInput(input.path)) {
      assert.equal(edited, false, 'Every mutation target must have an explicit owning source')
      assert.equal(input.compilerInputSHA256, input.sourceSHA256, 'Unmodified recorded dependency: ' + input.path)
      continue
    }
    const original = await readFile(path, 'utf8')
    assert.equal(input.sourceSHA256, sha(original), 'Actual test consumer source: ' + input.path)
    if (edited) assert.equal(original.split(mutation.before).length, 2, 'One exact behavior target')
    const compiled = edited ? original.replace(mutation.before, mutation.after) : original
    assert.equal(input.compilerInputSHA256, sha(compiled)); assert.equal(input.bytes, Buffer.byteLength(compiled))
  }
  const changed = inputs.filter(input => input.sourceSHA256 !== input.compilerInputSHA256)
  if (mutation) {
    assert.equal(run.exitCode, 1); assert.equal(report.success, false)
    assert.ok(cases.some(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError'))), 'A behavior assertion must reject the mutation')
    assert.equal(changed.length, 1); assert.equal(changed[0].path, mutation.path); assert.equal(changed[0].mutation, mutation.label)
    assert.ok(run.argv.includes(mutation.test))
  } else {
    assert.equal(run.exitCode, 0); assert.equal(report.success, true); assert.equal(report.numFailedTests, 0)
    assert.equal(report.numPassedTests, cases.length); assert.equal(changed.length, 0)
  }
  return { cases: cases.map(test => test.fullName).sort(), inputs }
}
function testInputConditions(facts, target) {
  const inputs = new Map()
  for (const input of facts.inputs) {
    const condition = input.path === target ? [input.path, input.sourceSHA256]
      : [input.path, input.sourceSHA256, input.compilerInputSHA256, input.bytes]
    if (inputs.has(input.path)) assert.deepEqual(inputs.get(input.path), condition, 'Original module conditions changed within one test run: ' + input.path)
    else inputs.set(input.path, condition)
  }
  return [...inputs.values()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
}
function assertTestPair(failed, restored, edit) {
  assert.deepEqual(failed.cases, restored.cases, 'Original RED/restore test cases are identical')
  assert.deepEqual(testInputConditions(failed, edit.path), testInputConditions(restored, edit.path),
    'Original RED/restore loading conditions differ outside the target compiler input: ' + edit.label)
}
function mergeSources(target, inputs) {
  for (const [path, digest] of Object.entries(inputs)) {
    local(path)
    if (!currentTestInput(path)) continue
    if (target[path]) assert.equal(target[path], digest, 'One candidate across all actual consumers: ' + path)
    target[path] = digest
  }
}
async function assertBaseline(run) {
  const report = await json(local(run.report))
  const expected = sources.filter(path => path.includes('/test/') && /\.test\.tsx?$/u.test(path))
    .filter(path => !path.endsWith('/a2a-message-data-bridge.test.tsx'))
  assert.ok(expected.length > 0)
  assert.deepEqual(report.testResults.map(file => relative(root, file.name)).sort(), expected.sort(), 'All named owning files must collect real assertions')
}
async function bridge(directory, name, mutation = '') {
  const evidence = join(directory, name)
  const result = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/test/vitest.a2a-message-data.config.mts'], directory, name,
    { AGENTMUX_MESSAGE_DATA_EVIDENCE: evidence, AGENTMUX_TEST_MESSAGE_DATA_MUTATION: mutation })
  const report = await json(join(evidence, 'results.json')), inputs = await json(join(evidence, 'mutation.json'))
  assert.ok(report.numTotalTests > 0); assert.equal(report.numPendingTests, 0)
  if (mutation) {
    assert.equal(result.exitCode, 1); assert.ok(report.numFailedTests > 0)
    assert.ok(report.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(text => text.includes('AssertionError'))))
    assert.equal(inputs.applied.length, 1)
  } else { assert.equal(result.exitCode, 0); assert.equal(report.numFailedTests, 0); assert.equal(inputs.applied.length, 0) }
  const fence = await json(join(evidence, 'note-link-execution.json'))
  assert.equal(fence.actualModuleLoaded, true)
  assert.deepEqual(fence.calls, { openDesktopNoteLink: 0, resolveDesktopNoteFileLink: 0, useDesktopNoteLinkOpener: 0 })
  return { ...result, sources: inputs.sources, artifacts: ['results.json', 'mutation.json', 'note-link-execution.json'].map(file => relative(root, join(evidence, file))) }
}
function commitOfSources(inputs) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  for (const [path, digest] of Object.entries(inputs)) {
    const bytes = execFileSync('git', ['show', commit + ':' + path], { cwd: root, maxBuffer: 32 * 1024 * 1024 })
    assert.equal(sha(bytes), digest, 'The accepted owning input is committed: ' + path)
  }
  return commit
}
async function prepare() {
  for (const edit of readingMutations) {
    assert.ok(edit.path.includes('/src/') && sources.includes(edit.path), 'Mutation targets one declared production owner: ' + edit.label)
    assert.equal((await readFile(local(edit.path), 'utf8')).split(edit.before).length, 2, 'One exact current mutation owner: ' + edit.label)
    await access(local(edit.test))
  }
  const directory = join(area, 'run-' + Date.now()); await mkdir(directory, { recursive: true })
  const receipt = { schema: 'agentmux.a2a-reference-reading.v1', boundary: 'Current A2A owners and test/harness inputs remain exact and join the committed product. Other actual loaded dependency hashes retain their original test conditions, without a current-main claim.', prepared: false, passed: false, sources: {}, artifacts: {}, mutations: [] }
  try {
    for (const path of sources) receipt.sources[path] = sha(await readFile(local(path)))
    receipt.baseline = await tests(directory, 'baseline')
    const baseline = await testFacts(receipt.baseline)
    await assertBaseline(receipt.baseline)
    mergeSources(receipt.sources, Object.fromEntries(baseline.inputs.map(input => [input.path, input.sourceSHA256])))
    for (const edit of readingMutations) {
      let mutant = await tests(directory, edit.label, edit)
      let restored = await tests(directory, edit.label + '-restored', undefined, edit.test)
      // A restored subset selects the same file, with no compiler mutation.
      let failed = await testFacts(mutant, edit), green = await testFacts(restored)
      try { assertTestPair(failed, green, edit) } catch (error) {
        (receipt.invalidatedTests ??= []).push({ label: edit.label + '-pair', reason: error.message, mutant, restored })
        console.log(edit.label + ': RED/restore conditions differ; rerunning this pair once')
        mutant = await tests(directory, edit.label + '-pair', edit)
        restored = await tests(directory, edit.label + '-pair-restored', undefined, edit.test)
        failed = await testFacts(mutant, edit); green = await testFacts(restored)
        assertTestPair(failed, green, edit)
      }
      mergeSources(receipt.sources, Object.fromEntries([...failed.inputs, ...green.inputs].map(input => [input.path, input.sourceSHA256])))
      receipt.mutations.push({ label: edit.label, mutant, restored })
      console.log(edit.label + ': behavior RED → original GREEN')
    }
    receipt.types = await execute('pnpm', ['--filter', '@agentmux/client-ui', 'typecheck'], directory, 'types')
    assert.equal(receipt.types.exitCode, 0, 'Current Core and shared UI types: ' + receipt.types.log)
    receipt.bridge = []
    for (const [name, mutation] of [['bridge-baseline', ''], ['bridge-wrong-host', 'originalResponseHost'], ['bridge-restored', '']]) {
      const proof = await bridge(directory, name, mutation)
      mergeSources(receipt.sources, proof.sources)
      receipt.bridge.push(proof)
    }
    const captureDirectory = process.env.AGENTMUX_A2A_REFERENCE_CAPTURE
      ? resolve(process.env.AGENTMUX_A2A_REFERENCE_CAPTURE) : join(directory, 'visual')
    const capture = process.env.AGENTMUX_A2A_REFERENCE_CAPTURE
      ? await json(join(captureDirectory, 'capture.json')) : await captureA2aReferenceReading({ root, evidence: captureDirectory })
    assert.equal(capture.completed, true); assert.equal(capture.privateRootRemoved, true)
    assert.deepEqual(capture.remainingPrivateProcesses, [])
    assert.deepEqual(capture.transforms ?? [], [], 'Accepted images use the unchanged product stylesheet')
    mergeSources(receipt.sources, Object.fromEntries(Object.entries(capture.inputs).map(([path, input]) => [path, input.sha256])))
    receipt.capture = { directory: relative(root, captureDirectory), sha256: sha(await readFile(join(captureDirectory, 'capture.json'))) }
    receipt.sourceCommit = commitOfSources(receipt.sources)
    receipt.reviewPath = relative(root, join(captureDirectory, 'review.json'))
    const runs = [receipt.baseline, ...receipt.mutations.flatMap(item => [item.mutant, item.restored])]
    for (const path of [...runs.flatMap(run => [run.log, run.report, run.loaded]), receipt.types.log, ...receipt.bridge.flatMap(run => [run.log, ...run.artifacts])]) receipt.artifacts[path] = sha(await readFile(local(path)))
    for (const [path, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(local(path))), digest, 'Source stayed fixed: ' + path)
    receipt.prepared = true
  } catch (error) { receipt.error = { message: error.message, stack: error.stack } }
  const path = join(directory, 'receipt.json'); await writeFile(path, JSON.stringify(receipt, null, 2) + '\n')
  assert.equal(receipt.prepared, true, receipt.error?.message)
  await writeFile(join(area, 'current.json'), JSON.stringify({ path: relative(root, path), sha256: sha(await readFile(path)) }) + '\n')
  console.log(JSON.stringify({ prepared: true, passed: false, receipt: relative(root, path), capture: receipt.capture, reviewPath: receipt.reviewPath,
    next: 'An independent Agent must actually open every product image and write the exact source-bound visual review before the bare gate can pass.' }))
}
async function verify() {
  const index = await json(join(area, 'current.json')), bytes = await readFile(local(index.path)); assert.equal(sha(bytes), index.sha256)
  const receipt = JSON.parse(bytes)
  assert.equal(receipt.schema, 'agentmux.a2a-reference-reading.v1'); assert.equal(receipt.prepared, true)
  for (const path of sources) assert.ok(receipt.sources[path], 'Required owning source: ' + path)
  for (const [path, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(local(path))), digest, 'Current candidate: ' + path)
  assert.ok(Object.keys(receipt.artifacts).length > 0)
  for (const [path, digest] of Object.entries(receipt.artifacts)) assert.equal(sha(await readFile(local(path))), digest, 'Bound proof bytes: ' + path)
  const baseline = await testFacts(receipt.baseline); await assertBaseline(receipt.baseline)
  assert.deepEqual(receipt.mutations.map(item => item.label), readingMutations.map(item => item.label))
  for (const [index, edit] of readingMutations.entries()) {
    const item = receipt.mutations[index], mutant = await testFacts(item.mutant, edit), restored = await testFacts(item.restored)
    assertTestPair(mutant, restored, edit)
  }
  assert.equal(receipt.types.exitCode, 0); assert.deepEqual(receipt.types.argv, ['--filter', '@agentmux/client-ui', 'typecheck'])
  assert.deepEqual(receipt.bridge.map(run => run.exitCode), [0, 1, 0])
  const captureBytes = await readFile(local(join(receipt.capture.directory, 'capture.json')))
  assert.equal(sha(captureBytes), receipt.capture.sha256)
  const capture = JSON.parse(captureBytes)
  assert.equal(capture.completed, true); assert.equal(capture.privateRootRemoved, true)
  assert.deepEqual(capture.remainingPrivateProcesses, [])
  assert.deepEqual(capture.transforms ?? [], [], 'Accepted images use the unchanged product stylesheet')
  assert.deepEqual(capture.frames.map(frame => frame.file).sort(), [
    ...['dark', 'light'].flatMap(theme => [960, 360].map(width => `reference-conversation-${theme}-${width}.png`)),
    'reference-user-messages.png', 'reference-inbox-original.png', 'reference-outbox.png'
  ].sort(), 'Every original Conversation and Mailbox face is represented')
  const review = await json(local(receipt.reviewPath))
  assert.equal(review.verdict, 'pass'); assert.equal(review.independent, true); assert.equal(review.openedAll, true)
  assert.ok(typeof review.reviewer === 'string' && review.reviewer.length > 0)
  assert.equal(review.captureSha256, receipt.capture.sha256)
  assert.deepEqual(review.frames.map(frame => [frame.path, frame.sha256]).sort(), capture.frames.map(frame => [frame.path, frame.sha256]).sort())
  for (const frame of review.frames) { assert.equal(frame.verdict, 'pass'); assert.equal(sha(await readFile(frame.path)), frame.sha256) }
  const changed = execFileSync('git', ['diff', receipt.sourceCommit, 'HEAD', '--name-only', '--', ...Object.keys(receipt.sources)], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(changed, '', 'The accepted owning sources stayed unchanged after their commit')
  console.log(JSON.stringify({ passed: true, sourceCommit: receipt.sourceCommit, tests: baseline.cases.length, mutants: receipt.mutations.length + 1, images: capture.frames.length,
    boundary: capture.boundary }))
}
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--prepare', 'Run bare to verify, or --prepare to run tests, mutations and the private product scene')
await mkdir(area, { recursive: true })
if (args.length) await prepare()
else await verify()
