import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readingMutations } from './fixtures/a2a-reference-reading/mutations.mjs'
import { a2aProofSha as sha, runA2aReferenceReadingProductProof, verifyA2aReferenceReadingProductProof } from './lib/a2a-inbox-product-proof.mjs'

const root = resolve(import.meta.dirname, '../../..'), area = join(root, '.tmp/a2a-reference-reading')
const config = 'apps/desktop/scripts/fixtures/a2a-reference-reading/vitest.owning.config.mts'
const sources = [
  'apps/desktop/scripts/verify-a2a-reference-reading.mjs', config, 'apps/desktop/scripts/fixtures/a2a-reference-reading/mutations.mjs',
  'apps/desktop/scripts/fixtures/a2a-reference-reading/worker.mjs', 'apps/desktop/scripts/lib/a2a-inbox-product-proof.mjs',
  ...['runtime', 'native-agent'].map(name => `apps/desktop/scripts/fixtures/a2a-inbox-product/${name}.mjs`),
  'packages/core/src/agent-message-render.ts', 'packages/core/src/types.ts', 'packages/core/src/conversation-provenance.ts',
  'packages/core/test/agent-message-reference-reading.test.ts', 'packages/core/test/agent-message-render.test.ts', 'packages/core/test/agent-message-leading-context.test.ts',
  ...['ConversationMessage', 'ConversationInputText', 'ConversationResourceText', 'CapturedConversationMessage', 'ConversationView'].map(name => `packages/client-ui/src/components/${name}.tsx`),
  'packages/client-ui/src/lib/conversation-speaker.ts', 'packages/client-ui/src/styles/conversation-message.css',
  'packages/client-ui/test/a2a-reference-reading.test.tsx', 'packages/client-ui/test/conversation-leading-context.test.tsx',
  'apps/desktop/src/renderer/src/components/MailboxA2A.tsx', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
  'packages/client-ui/src/components/InputMailboxRecords.tsx',
  'apps/desktop/test/mailbox-a2a.test.tsx', 'apps/desktop/test/input-mailbox-body-boundary.test.tsx', 'apps/desktop/test/session-mailbox-author-boundary.test.tsx'
]
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
    const original = await readFile(local(input.path), 'utf8')
    assert.equal(input.sourceSHA256, sha(original), 'Actual test consumer source: ' + input.path)
    const edited = mutation?.path === input.path
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
function mergeSources(target, inputs) {
  for (const [path, digest] of Object.entries(inputs)) {
    local(path)
    if (target[path]) assert.equal(target[path], digest, 'One candidate across all actual consumers: ' + path)
    target[path] = digest
  }
}
async function prepare() {
  const directory = join(area, 'run-' + Date.now()); await mkdir(directory, { recursive: true })
  const receipt = { schema: 'agentmux.a2a-reference-reading.v1', prepared: false, passed: false, sources: {}, artifacts: {}, mutations: [] }
  try {
    for (const path of sources) receipt.sources[path] = sha(await readFile(local(path)))
    receipt.baseline = await tests(directory, 'baseline')
    const baseline = await testFacts(receipt.baseline)
    assert.ok(baseline.cases.length >= 100, 'Core, shared reading and Desktop adjacent consumers must all run')
    mergeSources(receipt.sources, Object.fromEntries(baseline.inputs.map(input => [input.path, input.sourceSHA256])))
    for (const edit of readingMutations) {
      const mutant = await tests(directory, edit.label, edit), restored = await tests(directory, edit.label + '-restored', undefined, edit.test)
      // A restored subset selects the same file, with no compiler mutation.
      const failed = await testFacts(mutant, edit), green = await testFacts(restored)
      assert.deepEqual(failed.cases, green.cases)
      mergeSources(receipt.sources, Object.fromEntries([...failed.inputs, ...green.inputs].map(input => [input.path, input.sourceSHA256])))
      receipt.mutations.push({ label: edit.label, mutant, restored })
      console.log(edit.label + ': behavior RED → original GREEN')
    }
    receipt.types = await execute('pnpm', ['--filter', '@agentmux/client-ui', 'typecheck'], directory, 'types')
    assert.equal(receipt.types.exitCode, 0, 'Current Core and shared UI types: ' + receipt.types.log)
    receipt.product = await runA2aReferenceReadingProductProof({ root, evidence: directory })
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
  assert.equal(receipt.schema, 'agentmux.a2a-reference-reading.v1'); assert.equal(receipt.prepared, true)
  for (const path of sources) assert.ok(receipt.sources[path], 'Required owning source: ' + path)
  for (const [path, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(local(path))), digest, 'Current candidate: ' + path)
  assert.ok(Object.keys(receipt.artifacts).length > 0)
  for (const [path, digest] of Object.entries(receipt.artifacts)) assert.equal(sha(await readFile(local(path))), digest, 'Bound proof bytes: ' + path)
  const baseline = await testFacts(receipt.baseline); assert.ok(baseline.cases.length >= 100)
  assert.deepEqual(receipt.mutations.map(item => item.label), readingMutations.map(item => item.label))
  for (const [index, edit] of readingMutations.entries()) {
    const item = receipt.mutations[index], mutant = await testFacts(item.mutant, edit), restored = await testFacts(item.restored)
    assert.deepEqual(mutant.cases, restored.cases)
  }
  assert.equal(receipt.types.exitCode, 0); assert.deepEqual(receipt.types.argv, ['--filter', '@agentmux/client-ui', 'typecheck'])
  const productBytes = await readFile(receipt.product.path); assert.equal(sha(productBytes), receipt.product.sha256)
  const product = JSON.parse(productBytes), result = await verifyA2aReferenceReadingProductProof(product, { root })
  console.log(JSON.stringify({ passed: true, tests: baseline.cases.length, mutants: receipt.mutations.length, ...result }))
}
const args = process.argv.slice(2); assert.ok(args.length === 0 || args.length === 1 && args[0] === '--prepare')
await mkdir(area, { recursive: true })
if (args.length) await prepare()
else await verify()
