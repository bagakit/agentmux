import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readingMutations } from './fixtures/a2a-reference-reading/mutations.mjs'
import { a2aProofSha as sha, runA2aReferenceReadingProductProof, verifyA2aReferenceReadingProductProof } from './lib/a2a-inbox-product-proof.mjs'

const root = resolve(import.meta.dirname, '../../..'), area = join(root, '.tmp/a2a-reference-reading')
const config = 'apps/desktop/scripts/fixtures/a2a-reference-reading/vitest.owning.config.mts'
const sources = [
  'apps/desktop/scripts/verify-a2a-reference-reading.mjs', config, 'apps/desktop/scripts/fixtures/a2a-reference-reading/mutations.mjs',
  'apps/desktop/scripts/fixtures/a2a-reference-reading/worker.mjs', 'apps/desktop/scripts/lib/a2a-inbox-product-proof.mjs',
  'apps/desktop/scripts/lib/a2a-prepared-artifact.mjs',
  'apps/desktop/scripts/probe-process.mjs',
  ...['runtime', 'native-agent'].map(name => `apps/desktop/scripts/fixtures/a2a-inbox-product/${name}.mjs`),
  'packages/core/src/agent-message-render.ts', 'packages/core/src/types.ts', 'packages/core/src/conversation-provenance.ts',
  'packages/core/src/conversation.ts', 'packages/core/src/session-inputs.ts', 'packages/core/src/session-history-content.ts',
  'packages/core/src/session-user-messages.ts', 'packages/core/src/conversation-stream.ts', 'packages/core/src/conversation-author.ts',
  'packages/core/src/amux-protocol-definition.ts',
  'packages/core/test/agent-message-reference-reading.test.ts', 'packages/core/test/agent-message-render.test.ts', 'packages/core/test/agent-message-leading-context.test.ts',
  ...['ConversationMessage', 'ConversationInputText', 'ConversationResourceText', 'CapturedConversationMessage', 'ConversationView', 'ConversationA2AReferences', 'ConversationA2AMetadata', 'ConversationNotificationDetails', 'ConversationMessageCard', 'ConversationToolPayload', 'ContentCopyButton', 'ConversationAmuxProtocol', 'ConversationProgressiveBody'].map(name => `packages/client-ui/src/components/${name}.tsx`),
  'packages/client-ui/src/platform.tsx', 'packages/client-ui/src/lib/use-content-copy-action.ts',
  'packages/client-ui/src/lib/conversation-speaker.ts', 'packages/client-ui/src/styles/conversation-message.css',
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
function owningProductionInputs(facts) {
  const inputs = Object.fromEntries(facts.inputs.filter(input => sources.includes(input.path) && input.path.includes('/src/')).map(input => [input.path, input.sourceSHA256]))
  assert.ok(Object.keys(inputs).length > 0)
  for (const path of new Set(readingMutations.map(edit => edit.path))) assert.ok(inputs[path], 'Actual tests must consume their production mutation owner: ' + path)
  return inputs
}
async function reusableTest(run, mutation, label, receipt) {
  if (!run) return null
  try { await testFacts(run, mutation); return run }
  catch (error) {
    (receipt.invalidatedTests ??= []).push({ label, reason: error.message })
    console.log(label + ': original test conditions changed; running this subset anew')
    return null
  }
}
async function prepare(preparation, reusePath) {
  for (const edit of readingMutations) {
    assert.ok(edit.path.includes('/src/') && sources.includes(edit.path), 'Mutation targets one declared production owner: ' + edit.label)
    assert.equal((await readFile(local(edit.path), 'utf8')).split(edit.before).length, 2, 'One exact current mutation owner: ' + edit.label)
    await access(local(edit.test))
  }
  const reused = reusePath ? await json(reusePath) : undefined
  if (reused) {
    assert.equal(reused.schema, 'agentmux.a2a-reference-reading.v1')
    assert.deepEqual(reused.mutations.map(item => item.label), readingMutations.map(item => item.label), 'Explicit test reuse requires the complete original mutation collection')
  }
  const directory = join(area, 'run-' + Date.now()); await mkdir(directory, { recursive: true })
  const receipt = { schema: 'agentmux.a2a-reference-reading.v1', boundary: 'Current A2A owners and test/harness inputs remain exact; production owners join the fixed product. Other actual loaded dependency hashes retain their original test conditions, without a current-main claim.', prepared: false, passed: false, sources: {}, artifacts: {}, mutations: [] }
  try {
    for (const path of sources) receipt.sources[path] = sha(await readFile(local(path)))
    if (reused) receipt.reusedTests = { path: reusePath, sha256: sha(await readFile(reusePath)), boundary: 'Only original runs with current owning inputs and recorded unmodified dependency conditions revalidated; changed owning subsets, product execution and types run anew.' }
    receipt.baseline = (reused && await reusableTest(reused.baseline, undefined, 'baseline', receipt)) || await tests(directory, 'baseline')
    const baseline = await testFacts(receipt.baseline)
    assert.ok(baseline.cases.length >= 100, 'Core, shared reading and Desktop adjacent consumers must all run')
    mergeSources(receipt.sources, Object.fromEntries(baseline.inputs.map(input => [input.path, input.sourceSHA256])))
    for (const [index, edit] of readingMutations.entries()) {
      const prior = reused?.mutations[index]
      let mutant = (prior && await reusableTest(prior.mutant, edit, edit.label, receipt)) || await tests(directory, edit.label, edit)
      let restored = (prior && await reusableTest(prior.restored, undefined, edit.label + '-restored', receipt)) || await tests(directory, edit.label + '-restored', undefined, edit.test)
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
      console.log(edit.label + ': behavior RED → original GREEN' + (prior && mutant === prior.mutant && restored === prior.restored ? '; original runs reused after current-input validation' : ''))
    }
    receipt.types = await execute('pnpm', ['--filter', '@agentmux/client-ui', 'typecheck'], directory, 'types')
    assert.equal(receipt.types.exitCode, 0, 'Current Core and shared UI types: ' + receipt.types.log)
    receipt.product = await runA2aReferenceReadingProductProof({ root, evidence: directory, preparation, testInputs: owningProductionInputs(baseline) })
    const runs = [receipt.baseline, ...receipt.mutations.flatMap(item => [item.mutant, item.restored])]
    for (const path of [...runs.flatMap(run => [run.log, run.report, run.loaded]), receipt.types.log]) receipt.artifacts[path] = sha(await readFile(local(path)))
    for (const [path, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(local(path))), digest, 'Source stayed fixed: ' + path)
    receipt.prepared = true
  } catch (error) { receipt.error = { message: error.message, stack: error.stack } }
  const path = join(directory, 'receipt.json'); await writeFile(path, JSON.stringify(receipt, null, 2) + '\n')
  assert.equal(receipt.prepared, true, receipt.error?.message)
  await writeFile(join(area, 'current.json'), JSON.stringify({ path: relative(root, path), sha256: sha(await readFile(path)) }) + '\n')
  console.log(JSON.stringify({ prepared: true, passed: false, receipt: relative(root, path), product: receipt.product,
    next: 'An independent Agent must actually open every product image and write the exact source-bound visual review before the bare gate can pass.' }))
}
async function verify() {
  const index = await json(join(area, 'current.json')), bytes = await readFile(local(index.path)); assert.equal(sha(bytes), index.sha256)
  const receipt = JSON.parse(bytes)
  if (receipt.reusedTests) assert.equal(sha(await readFile(receipt.reusedTests.path)), receipt.reusedTests.sha256, 'Original explicit test reuse receipt')
  assert.equal(receipt.schema, 'agentmux.a2a-reference-reading.v1'); assert.equal(receipt.prepared, true)
  for (const path of sources) assert.ok(receipt.sources[path], 'Required owning source: ' + path)
  for (const [path, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(local(path))), digest, 'Current candidate: ' + path)
  assert.ok(Object.keys(receipt.artifacts).length > 0)
  for (const [path, digest] of Object.entries(receipt.artifacts)) assert.equal(sha(await readFile(local(path))), digest, 'Bound proof bytes: ' + path)
  const baseline = await testFacts(receipt.baseline); assert.ok(baseline.cases.length >= 100)
  assert.deepEqual(receipt.mutations.map(item => item.label), readingMutations.map(item => item.label))
  for (const [index, edit] of readingMutations.entries()) {
    const item = receipt.mutations[index], mutant = await testFacts(item.mutant, edit), restored = await testFacts(item.restored)
    assertTestPair(mutant, restored, edit)
  }
  assert.equal(receipt.types.exitCode, 0); assert.deepEqual(receipt.types.argv, ['--filter', '@agentmux/client-ui', 'typecheck'])
  const productBytes = await readFile(receipt.product.path); assert.equal(sha(productBytes), receipt.product.sha256)
  const product = JSON.parse(productBytes), result = await verifyA2aReferenceReadingProductProof(product, { root, testInputs: owningProductionInputs(baseline) })
  console.log(JSON.stringify({ passed: true, tests: baseline.cases.length, mutants: receipt.mutations.length, ...result }))
}
const args = process.argv.slice(2)
const preparedIndex = args.indexOf('--prepared-artifact')
const input = preparedIndex < 0 ? undefined : args[preparedIndex + 1]
if (preparedIndex >= 0) assert.ok(input && !input.startsWith('--'), '--prepared-artifact requires one input record')
const preparation = input ? { kind: 'prepared-artifact', input: resolve(input) } : { kind: 'source-build' }
const reuseIndex = args.indexOf('--reuse-tests'), reuse = reuseIndex < 0 ? undefined : args[reuseIndex + 1]
if (reuseIndex >= 0) assert.ok(reuse && !reuse.startsWith('--'), '--reuse-tests requires one original receipt')
const action = args.includes('--isolation-only') ? 'isolation' : args.includes('--prepare') ? 'prepare' : 'verify'
const recognized = new Set(['--prepare', '--isolation-only', '--prepared-artifact', '--reuse-tests'])
for (const [index, value] of args.entries()) if (!(preparedIndex >= 0 && index === preparedIndex + 1 || reuseIndex >= 0 && index === reuseIndex + 1)) assert.ok(recognized.has(value), 'Unknown reference proof argument: ' + value)
assert.ok(!args.includes('--prepare') || !args.includes('--isolation-only'), 'Choose one preparation stage')
assert.ok(!reuse || action === 'prepare', 'Recorded tests belong to an explicit preparation stage')
assert.ok(!input || action !== 'verify', 'Prepared input belongs to an explicit preparation stage')
await mkdir(area, { recursive: true })
if (action === 'isolation') {
  assert.equal(preparation.kind, 'prepared-artifact', 'Isolation smoke consumes one explicitly prepared product')
  const directory = join(area, 'isolation-' + (await import('node:crypto')).randomUUID()); await mkdir(directory)
  const result = await runA2aReferenceReadingProductProof({ root, evidence: directory, preparation, isolationOnly: true })
  console.log(JSON.stringify({ isolated: true, passed: false, ...result, next: 'Actual seven-scene execution and independent image review remain required.' }))
} else if (action === 'prepare') await prepare(preparation, reuse ? resolve(reuse) : undefined)
else { assert.equal(args.length, 0); await verify() }
